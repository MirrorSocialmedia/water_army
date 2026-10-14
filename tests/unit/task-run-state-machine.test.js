/**
 * TaskRunService state machine (施工 MD §11.3) — full legal/illegal
 * transition matrix + terminal invariants + cancel/retry idempotency.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createTaskRunService,
  TaskRunError,
  backoffDelay,
} from '../../packages/shared/src/task-run-service.js';
import {
  TASK_RUN_STATUS,
  TASK_RUN_TERMINAL,
  TASK_RUN_TRANSITIONS,
} from '../../packages/shared/src/task-constants.js';
import { makeFakeDb, makeFakeQueue, testConfig } from '../helpers/fakes.js';

const USER = { id: 'u1', username: 'admin' };

function makeService() {
  const db = makeFakeDb();
  const queue = makeFakeQueue();
  const svc = createTaskRunService({
    db,
    config: testConfig,
    log: { error() {}, warn() {}, info() {} },
    enqueue: (jobData) => queue.add('task-run', jobData, { jobId: `${jobData.runId}:${jobData.attempt}` }),
  });
  return { svc, db, queue };
}

// ---------------------------------------------------------------- transitions

test('transition matrix: every legal transition is accepted, every other pair rejected', () => {
  const { svc } = makeService();
  for (const from of TASK_RUN_STATUS) {
    for (const to of TASK_RUN_STATUS) {
      const expected = (TASK_RUN_TRANSITIONS[from] ?? []).includes(to);
      assert.equal(
        svc.canTransition(from, to),
        expected,
        `canTransition(${from} → ${to}) should be ${expected}`,
      );
      if (!expected && from !== to) {
        assert.throws(
          () => svc.assertTransition(from, to, 'runX'),
          (e) => e instanceof TaskRunError && e.apiCode === 'ILLEGAL_STATE_TRANSITION' && e.statusCode === 409,
          `assertTransition(${from} → ${to}) should throw`,
        );
      }
    }
  }
});

test('terminal invariants: no outgoing transitions except manual retry (→ queued) from failed/cancelled/timed_out', () => {
  const { svc } = makeService();
  for (const t of TASK_RUN_TERMINAL) {
    const outgoing = TASK_RUN_TRANSITIONS[t];
    if (t === 'succeeded' || t === 'skipped') {
      assert.deepEqual(outgoing, [], `${t} must have no outgoing transitions`);
    } else {
      assert.deepEqual(outgoing, ['queued'], `${t} must only allow manual retry (→ queued)`);
    }
  }
  // cancelled is only reachable via cancel_requested
  for (const from of TASK_RUN_STATUS) {
    if (from === 'cancelled') continue;
    if (from === 'cancel_requested') continue;
    assert.equal(TASK_RUN_TRANSITIONS[from]?.includes('cancelled'), false, `${from} → cancelled must not exist`);
  }
});

// ------------------------------------------------------------------- lifecycle

async function createRun(svc, overrides = {}) {
  return svc.createRun({ prompt: 'hello', provider: 'mock', ...overrides }, USER);
}

test('create: persists queued run + event + enqueues {runId, attempt} ONLY (no prompt/secret in queue)', async () => {
  const { svc, db, queue } = makeService();
  const { run, replay } = await createRun(svc, { timeoutMs: 5000, maxAttempts: 2, tools: ['system.get_health'] });
  assert.equal(replay, false);
  assert.equal(run.status, 'queued');
  assert.equal(run.attempt, 1);
  assert.ok(run.queuedAt instanceof Date);

  // queue payload is deliberately minimal (MD §11.2.4: no prompt, no secrets)
  assert.equal(queue.enqueued.length, 1);
  assert.deepEqual(queue.enqueued[0].data, { runId: run.id, attempt: 1 });

  // DB row holds the input (source of truth)
  const row = await db.taskRun.findUnique({ where: { id: run.id } });
  assert.equal(row.inputJson.prompt, 'hello');
  assert.equal(row.inputJson.provider, 'mock');

  // queued event recorded
  const events = await db.taskRunEvent.findMany({ where: { taskRunId: run.id } });
  assert.equal(events[0].eventType, 'queued');
});

test('create: idempotencyKey replay returns original run without a second job', async () => {
  const { svc, queue } = makeService();
  const a = await createRun(svc, { idempotencyKey: 'idem-key-12345' });
  const b = await createRun(svc, { idempotencyKey: 'idem-key-12345' });
  assert.equal(a.run.id, b.run.id);
  assert.equal(b.replay, true);
  assert.equal(queue.enqueued.length, 1);
});

test('create: validation failures (prompt/timeout cap/attempts cap/mode/idempotency pattern)', async () => {
  const { svc } = makeService();
  const cases = [
    [{ prompt: '' }, 'prompt is required'],
    [{ prompt: 'x'.repeat(20_001) }, 'prompt too long'],
    [{ prompt: 'ok', timeoutMs: 999 }, 'timeoutMs must be an integer >= 1000'],
    [{ prompt: 'ok', timeoutMs: 900_001 }, 'exceeds system cap'],
    [{ prompt: 'ok', maxAttempts: 6 }, 'exceeds system cap'],
    [{ prompt: 'ok', maxAttempts: 0 }, 'maxAttempts must be an integer >= 1'],
    [{ prompt: 'ok', mode: 'yolo' }, "mode must be"],
    [{ prompt: 'ok', idempotencyKey: 'short' }, 'idempotencyKey must match'],
    [{ prompt: 'ok', tools: ['nope.tool', 42] }, 'tools must be an array of tool names'],
  ];
  for (const [input, frag] of cases) {
    await assert.rejects(
      () => createRun(svc, input),
      (e) => e instanceof TaskRunError && e.apiCode === 'VALIDATION_ERROR' && e.message.includes(frag),
      `expected failure for ${JSON.stringify(input)}`,
    );
  }
});

test('create: enqueue failure → run marked failed ENQUEUE_FAILED (no phantom queued run)', async () => {
  const db = makeFakeDb();
  const svc = createTaskRunService({
    db,
    config: testConfig,
    log: { error() {} },
    enqueue: async () => { throw new Error('ECONNREFUSED'); },
  });
  await assert.rejects(
    () => svc.createRun({ prompt: 'x' }, USER),
    (e) => e.apiCode === 'ENQUEUE_FAILED' && e.statusCode === 503,
  );
  const runs = await db.taskRun.findMany({});
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'failed');
  assert.equal(runs[0].errorCode, 'ENQUEUE_FAILED');
  assert.ok(runs[0].finishedAt, 'failed run gets finishedAt');
});

test('startAttempt: guards stale jobs (terminal run / superseded attempt) and pre-start cancel', async () => {
  const { svc, db } = makeService();

  // stale: superseded attempt
  const { run } = await createRun(svc);
  let r = await svc.startAttempt(run.id, 1);
  assert.equal(r.status, 'started');
  assert.equal((await db.taskRun.findUnique({ where: { id: run.id } })).status, 'running');
  await svc.finishRun(run.id, { status: 'succeeded', resultText: 'done', attempt: 1 });

  r = await svc.startAttempt(run.id, 1);
  assert.equal(r.status, 'stale');
  assert.match(r.reason, /already succeeded/);

  // superseded attempt number
  const { run: run2 } = await createRun(svc);
  const r2 = await svc.startAttempt(run2.id, 2);
  assert.equal(r2.status, 'stale');
  assert.match(r2.reason, /superseded/);

  // cancel before start → cancelled, never executed
  const { run: run3 } = await createRun(svc);
  await svc.requestCancel(run3.id, { actorUserId: 'u1' });
  const r3 = await svc.startAttempt(run3.id, 1);
  assert.equal(r3.status, 'cancelled');
  const row3 = await db.taskRun.findUnique({ where: { id: run3.id } });
  assert.equal(row3.status, 'cancelled');
  assert.ok(row3.finishedAt);
});

test('cancel: idempotent from terminal states; request sets cancel_requested only (worker writes cancelled)', async () => {
  const { svc, db } = makeService();
  const { run } = await createRun(svc);
  await svc.startAttempt(run.id, 1);
  const c1 = await svc.requestCancel(run.id, { actorUserId: 'u1', reason: 'user stopped' });
  assert.equal(c1.requested, true);
  assert.equal(c1.run.status, 'cancel_requested');
  const row = await db.taskRun.findUnique({ where: { id: run.id } });
  assert.equal(row.status, 'cancel_requested'); // NOT cancelled yet — real stop is worker's job
  assert.equal(row.finishedAt, null);

  await svc.markCancelled(run.id, { reason: 'user stopped', attempt: 1 });
  const c2 = await svc.requestCancel(run.id, {});
  assert.equal(c2.idempotent, true); // terminal → no-op
  assert.equal(c2.run.status, 'cancelled');
  const row2 = await db.taskRun.findUnique({ where: { id: run.id } });
  assert.ok(row2.finishedAt && row2.durationMs >= 0);
});

test('retry: only from terminal failure states; new attempt, old output preserved in events', async () => {
  const { svc, db } = makeService();
  const { run } = await createRun(svc);
  await svc.startAttempt(run.id, 1);
  await svc.finishRun(run.id, { status: 'failed', errorCode: 'PROVIDER_AUTH', errorMessage: '401 bad key', attempt: 1 });

  // not retryable from running/succeeded
  const { run: runOk } = await createRun(svc);
  await assert.rejects(
    () => svc.requestRetry(runOk.id, { actorUserId: 'u1' }),
    (e) => e.apiCode === 'RETRY_NOT_ALLOWED' && e.statusCode === 409,
  );

  const r = await svc.requestRetry(run.id, { actorUserId: 'u1', note: 'key fixed' });
  assert.equal(r.attempt, 2);
  const row = await db.taskRun.findUnique({ where: { id: run.id } });
  assert.equal(row.status, 'queued');
  assert.equal(row.attempt, 2);
  assert.equal(row.resultText, null); // latest-attempt fields cleared…
  assert.equal(row.finishedAt, null);
  // …but the previous attempt's output/error is preserved in the event stream
  const events = await db.taskRunEvent.findMany({ where: { taskRunId: run.id } });
  const retryEv = events.find((e) => e.eventType === 'retry_requested');
  assert.ok(retryEv, 'retry_requested event recorded');
  assert.equal(retryEv.payloadJson.previous.errorCode, 'PROVIDER_AUTH');
  assert.equal(retryEv.payloadJson.previous.outputChars, 0);

  // second retry after a new failure keeps incrementing (and new attempt works)
  await svc.startAttempt(run.id, 2);
  await svc.finishRun(run.id, { status: 'failed', errorCode: 'PROVIDER_TIMEOUT', errorMessage: 'slow', attempt: 2 });
  const r2 = await svc.requestRetry(run.id, {});
  assert.equal(r2.attempt, 3);
});

test('finishRun: only terminal statuses writable; finishedAt only on terminal; illegal from terminal', async () => {
  const { svc, db } = makeService();
  const { run } = await createRun(svc);
  await svc.startAttempt(run.id, 1);

  await assert.rejects(
    () => svc.finishRun(run.id, { status: 'running' }),
    (e) => e.apiCode === 'INVALID_TERMINAL',
  );
  await assert.rejects(
    () => svc.finishRun(run.id, { status: 'skipped' }),
    (e) => e.apiCode === 'INVALID_TERMINAL',
  );

  const f = await svc.finishRun(run.id, { status: 'timed_out', errorCode: 'PROVIDER_TIMEOUT', errorMessage: 'deadline', attempt: 1 });
  assert.equal(f.idempotent, false);
  const row = await db.taskRun.findUnique({ where: { id: run.id } });
  assert.equal(row.status, 'timed_out');
  assert.ok(row.finishedAt instanceof Date);
  assert.equal(row.resultText, null); // non-success keeps no result

  // already terminal → startAttempt is stale, finish is an idempotent no-op
  const stale = await svc.startAttempt(run.id, 1);
  assert.equal(stale.status, 'stale');
  const again = await svc.finishRun(run.id, { status: 'timed_out' });
  assert.equal(again.idempotent, true);
});

test('reconcileStaleRuns: queued→failed QUEUE_LOST, running→failed WORKER_RESTART, cancel_requested→cancelled, fresh runs untouched', async () => {
  const { svc, db } = makeService();
  const mk = async (status, ageMs) => {
    const { run } = await createRun(svc);
    if (status === 'running') await svc.startAttempt(run.id, 1);
    if (status === 'cancel_requested') await svc.requestCancel(run.id, {});
    if (status !== 'queued') {
      // age the row by moving updatedAt back
      const t = new Date(Date.now() - ageMs);
      await db.taskRun.update({ where: { id: run.id }, data: { updatedAt: t } });
    } else {
      const t = new Date(Date.now() - ageMs);
      await db.taskRun.update({ where: { id: run.id }, data: { updatedAt: t } });
    }
    return run;
  };
  const oldQueued = await mk('queued', 11 * 60_000);
  const oldRunning = await mk('running', 11 * 60_000);
  const oldCancel = await mk('cancel_requested', 11 * 60_000);
  const freshRunning = await mk('running', 10_000);

  const summary = await svc.reconcileStaleRuns({ staleMs: 10 * 60_000 });
  assert.equal(summary.cancelled, 1);
  assert.equal(summary.failed, 2);

  assert.equal((await db.taskRun.findUnique({ where: { id: oldQueued.id } })).errorCode, 'QUEUE_LOST');
  assert.equal((await db.taskRun.findUnique({ where: { id: oldRunning.id } })).errorCode, 'WORKER_RESTART');
  assert.equal((await db.taskRun.findUnique({ where: { id: oldCancel.id } })).status, 'cancelled');
  assert.equal((await db.taskRun.findUnique({ where: { id: freshRunning.id } })).status, 'running', 'fresh run untouched');
});

// -------------------------------------------------------------------- backoff

test('backoffDelay: exponential growth, cap, deterministic without jitter', () => {
  assert.equal(backoffDelay(1), 1_000);
  assert.equal(backoffDelay(2), 2_000);
  assert.equal(backoffDelay(3), 4_000);
  assert.equal(backoffDelay(4), 8_000);
  assert.equal(backoffDelay(10), 30_000, 'capped at RETRY_MAX_MS');
  assert.equal(backoffDelay(0), 1_000, 'attempt 0 clamps to base');
  assert.equal(backoffDelay(3, { baseMs: 500, maxMs: 1000 }), 1000, 'custom base/cap');
});

test('backoffDelay: jitter stays within [cap*(1-j), cap]', () => {
  // attempt 5 → 1000 * 2^4 = 16000 (below the 30000 cap)
  for (let i = 0; i < 200; i += 1) {
    const d = backoffDelay(5, { jitter: 0.25 }, Math.random);
    assert.ok(d >= 16_000 * 0.75 && d <= 16_000, `jittered delay ${d} out of band`);
  }
  const fixed = backoffDelay(5, { jitter: 1 }, () => 0);
  assert.equal(fixed, 0, 'rand()=0 → floor of low bound');
});
