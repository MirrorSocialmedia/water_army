/**
 * BR-B2 gen2 — unit tests for the gen1 queue helpers (施工 MD §7.1/§6.3):
 *   - enqueueBatchRun: fresh enqueue / getJob pre-check reuse /
 *     JobExistsError race reuse / foreign error propagation / backstop timeout
 *   - removeWaitingBatchRun: waiting removed / active refused / missing no-op
 *   - enqueueAnyRun: batch-aware router (batchId → batch-run job, else the
 *     original task-run path byte-for-byte)
 *
 * Hermetic: makeFakeQueue (it throws a NAMED JobExistsError on custom job id
 * collision, exactly like real BullMQ — the double idempotency the design
 * relies on).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  enqueueBatchRun,
  removeWaitingBatchRun,
  enqueueAnyRun,
} from '@water-army/shared';
import { batchJobId, BATCH_RUN_JOB_NAME, taskJobId, TASK_JOB_NAME } from '@water-army/shared';
import { makeFakeQueue } from '../helpers/fakes.js';

const RUN = '11111111-1111-4111-8111-111111111111';
const RUN2 = '22222222-2222-4222-8222-222222222222';

// ---------------------------------------------------------------- enqueue
test('enqueueBatchRun: fresh job → batch-run name, secret-free payload, deterministic id', async () => {
  const queue = makeFakeQueue();
  const res = await enqueueBatchRun(queue, { runId: RUN, attempt: 1, timeoutMs: 60_000, maxAttempts: 2 });
  assert.equal(res.queued, true);
  assert.equal(res.reused, false);
  assert.equal(res.jobId, batchJobId(RUN, 1));

  const job = queue.jobs.get(batchJobId(RUN, 1));
  assert.ok(job, 'job registered under batch-<runId>-<attempt>');
  assert.equal(job.name, BATCH_RUN_JOB_NAME);
  assert.deepEqual(job.data, { runId: RUN, attempt: 1 }, 'payload is secret-free {runId, attempt}');
  // backstop = timeout×attempts + 30s×attempts + 300s
  assert.equal(job.opts.timeout, 60_000 * 2 + 30_000 * 2 + 300_000);
  assert.equal(job.opts.attempts, 1, 'no BullMQ-level auto-retry (DB is the retry owner)');
});

test('enqueueBatchRun: existing job (getJob pre-check) → reused, no second job', async () => {
  const queue = makeFakeQueue();
  await enqueueBatchRun(queue, { runId: RUN, attempt: 3 });
  const res = await enqueueBatchRun(queue, { runId: RUN, attempt: 3 });
  assert.equal(res.reused, true);
  assert.equal(res.queued, false);
  assert.equal(res.jobId, batchJobId(RUN, 3));
  const sameAttempt = [...queue.jobs.values()].filter((j) => j.data?.attempt === 3);
  assert.equal(sameAttempt.length, 1, 'a redelivered start never double-dispatches');
});

test('enqueueBatchRun: getJob pre-check misses but add collides (JobExistsError) → reused, no throw', async () => {
  // Models the cross-process race: our getJob saw nothing, the peer inserted
  // between the check and the add. Real BullMQ AND the fake both throw a
  // named JobExistsError on the collision.
  const queue = makeFakeQueue();
  await enqueueBatchRun(queue, { runId: RUN2, attempt: 1 }); // the peer's job
  let sees = 1;
  const racingQueue = {
    ...queue,
    getJob: async (id) => (sees-- > 0 ? null : queue.getJob(id)), // blind on the pre-check only
    add: (name, data, opts) => queue.add(name, data, opts),
    close: queue.close,
    on: queue.on,
  };
  const res = await enqueueBatchRun(racingQueue, { runId: RUN2, attempt: 1 });
  assert.equal(res.reused, true);
  assert.equal(res.queued, false);
  assert.equal(res.jobId, batchJobId(RUN2, 1));
  const jobs = [...queue.jobs.values()].filter((j) => j.data?.runId === RUN2);
  assert.equal(jobs.length, 1, 'exactly one job survives the race');
});

test('enqueueBatchRun: JobExistsError with only a message (no name) is still treated as reuse', async () => {
  const queue = makeFakeQueue();
  let blind = 1;
  const racingQueue = {
    ...queue,
    getJob: async (id) => (blind-- > 0 ? null : queue.getJob(id)),
    add: async (name, data, opts) => {
      const err = new Error(`Job with id '${opts.jobId}' already exists`);
      throw err; // message-only shape
    },
    close: queue.close,
    on: queue.on,
  };
  const res = await enqueueBatchRun(racingQueue, { runId: RUN, attempt: 1 });
  assert.equal(res.reused, true);
});

test('enqueueBatchRun: a foreign add error propagates (honest failure, not a reuse)', async () => {
  const queue = makeFakeQueue();
  const brokenQueue = {
    ...queue,
    getJob: async () => null,
    add: async () => {
      const err = new Error('connect ECONNREFUSED (redis down)');
      err.code = 'ECONNREFUSED';
      throw err;
    },
    close: queue.close,
    on: queue.on,
  };
  await assert.rejects(() => enqueueBatchRun(brokenQueue, { runId: RUN, attempt: 1 }), /ECONNREFUSED/);
});

// ---------------------------------------------------------------- remove
test('removeWaitingBatchRun: removes a waiting job', async () => {
  const queue = makeFakeQueue();
  await enqueueBatchRun(queue, { runId: RUN, attempt: 2 });
  assert.equal(await removeWaitingBatchRun(queue, RUN, 2), true);
  assert.equal(queue.jobs.has(batchJobId(RUN, 2)), false);
  assert.ok(queue.removed.includes(batchJobId(RUN, 2)));
});

test('removeWaitingBatchRun: an active job is NOT removed (the DB cancel poll is the real stop)', async () => {
  const queue = makeFakeQueue();
  await enqueueBatchRun(queue, { runId: RUN, attempt: 1 });
  queue.__markActive(batchJobId(RUN, 1));
  assert.equal(await removeWaitingBatchRun(queue, RUN, 1), false);
  assert.equal(queue.jobs.has(batchJobId(RUN, 1)), true, 'active job left in place');
});

test('removeWaitingBatchRun: missing job → false (no throw)', async () => {
  const queue = makeFakeQueue();
  assert.equal(await removeWaitingBatchRun(queue, RUN, 9), false);
});

// ---------------------------------------------------------------- router
test('enqueueAnyRun: a run WITH batchId routes to the batch-run job (and uses the row maxAttempts)', async () => {
  const queue = makeFakeQueue();
  const row = { id: RUN, batchId: 'b-batch-1', identityId: 'i-1', maxAttempts: 4 };
  const res = await enqueueAnyRun(queue, { db: null, runId: RUN, attempt: 2, run: row });
  assert.equal(res.queued, true);
  assert.equal(res.jobId, batchJobId(RUN, 2));
  const job = queue.jobs.get(res.jobId);
  assert.equal(job.name, BATCH_RUN_JOB_NAME);
  assert.equal(job.opts.timeout, 900_000 * 4 + 30_000 * 4 + 300_000, 'row maxAttempts=4 drives the backstop');
});

test('enqueueAnyRun: a run WITHOUT batchId keeps the original task-run path', async () => {
  const queue = makeFakeQueue();
  const row = { id: RUN, batchId: null, maxAttempts: 3 };
  const res = await enqueueAnyRun(queue, { db: null, runId: RUN, attempt: 1, timeoutMs: 120_000, run: row });
  assert.equal(res.queued, true);
  assert.equal(res.jobId, taskJobId(RUN, 1), 'jobId is the task-run shape <runId>-<attempt> (a string)');
  const job = queue.jobs.get(taskJobId(RUN, 1));
  assert.equal(job.name, TASK_JOB_NAME);
  assert.equal(job.opts.timeout, 120_000 + 30_000);
});

test('enqueueAnyRun: reads the run row from db when `run` is not passed', async () => {
  const queue = makeFakeQueue();
  const db = {
    taskRun: {
      findUnique: async ({ where }) =>
        where.id === RUN ? { id: RUN, batchId: 'b-batch-9', maxAttempts: 5 } : null,
    },
  };
  const res = await enqueueAnyRun(queue, { db, runId: RUN, attempt: 1 });
  assert.equal(res.jobId, batchJobId(RUN, 1), 'db-discovered batchId routes to the batch job');
  assert.equal(queue.jobs.get(res.jobId).opts.timeout, 900_000 * 5 + 30_000 * 5 + 300_000);
});

test('enqueueAnyRun: no run + no db → original task path (defensive, never crashes)', async () => {
  const queue = makeFakeQueue();
  const res = await enqueueAnyRun(queue, { db: null, runId: RUN, attempt: 1, timeoutMs: 10_000 });
  assert.equal(res.jobId, taskJobId(RUN, 1));
  assert.equal(queue.jobs.get(taskJobId(RUN, 1)).name, TASK_JOB_NAME);
});
