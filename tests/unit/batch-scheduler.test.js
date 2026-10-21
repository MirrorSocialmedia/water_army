/**
 * BR-B2 gen2 — BatchScheduler unit tests (MD §14.2 多 scheduler replica + §6.2
 * lease reconciliation + §7 生命周期).
 *
 * Hermetic: makeBatchFakeDb + real B1 services (createBatchService /
 * createLeaseService / createTaskRunService) + makeFakeQueue. No network, no
 * timers (injectable clock).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBatchScheduler,
  readGlobalMaxActive,
  effectiveSlotCap,
  runIdempotencyKey,
  APP_SETTING_BATCH_GLOBAL_MAX_ACTIVE,
  BATCH_RUN_JOB_NAME,
} from '@water-army/shared';
import { createBatchService, createLeaseService } from '@water-army/shared';
import { createTaskRunService, enqueueAnyRun, batchJobId } from '@water-army/shared';
import { makeBatchFakeDb } from '../helpers/batch-fakes.js';
import { makeFakeQueue } from '../helpers/fakes.js';

const jobsOf = (q) => [...q.jobs.values()];

// ------------------------------------------------------------------ harness
function makeClock(start = '2026-10-21T00:00:00Z') {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance: (ms) => { t += ms; },
  };
}

function makeLogs() {
  const out = { error: [], warn: [], info: [] };
  return {
    out,
    log: {
      error: (o, m) => out.error.push({ o, m }),
      warn: (o, m) => out.warn.push({ o, m }),
      info: (o, m) => out.info.push({ o, m }),
    },
  };
}

/** One world: fake db + real B1 services + fake queue + the scheduler. */
function makeWorld({ inspectEffects, schedulerConfig } = {}) {
  const clock = makeClock();
  const db = makeBatchFakeDb({ clock: clock.now });
  const { out, log } = makeLogs();
  const queue = makeFakeQueue();
  const taskSvc = createTaskRunService({
    db,
    log,
    config: { taskDefaultTimeoutMs: 60_000, taskDefaultAttempts: 3 },
    enqueue: async ({ runId, attempt }) =>
      enqueueAnyRun(queue, { db, runId, attempt, timeoutMs: 60_000 }),
  });
  const batchSvc = createBatchService({ db, log, now: clock.now });
  const leaseSvc = createLeaseService({ db, now: clock.now });
  const scheduler = createBatchScheduler({
    db, batchSvc, leaseSvc, taskSvc, queue, log,
    now: clock.now,
    inspectEffects,
    config: schedulerConfig,
  });
  return { clock, db, out, log, queue, taskSvc, batchSvc, leaseSvc, scheduler };
}

let identitySeq = 0;
async function seedIdentity(db, { status = 'READY' } = {}) {
  identitySeq += 1;
  const n = identitySeq;
  return db.identity.create({
    data: { email: `user${n}@example.com`, username: `user${n}`, status },
  });
}

/** Create a cycle (batchSize splits identities into consecutive batches). */
async function seedCycle(world, { identities = 3, batchSize, maxActiveContainers = 2, failurePolicy = 'continue_and_report', config = {} } = {}) {
  const ids = [];
  for (let i = 0; i < identities; i += 1) ids.push(await seedIdentity(world.db));
  const res = await world.batchSvc.createCycle(
    {
      name: `cycle-${identitySeq}`,
      idempotencyKey: `cycle-${Math.random().toString(36).slice(2, 10)}`,
      identities: ids.map((i) => ({ id: i.id })),
      batchSize: batchSize ?? identities, // default: one batch
      maxActiveContainers,
      failurePolicy,
      config: { adapter: 'noop', timeoutSeconds: 30, maxAttempts: 3, interBatchCooldownSeconds: 0, ...config },
    },
    { id: 'tester' },
  );
  const batches = await world.db.batch.findMany({ where: { cycleId: res.cycleId }, orderBy: { batchNo: 'asc' } });
  return { cycleId: res.cycleId, identities: ids, batches, res };
}

async function runsOf(db, { batchId, identityId } = {}) {
  return db.taskRun.findMany({ where: { batchId, identityId } }).then((r) => r.sort((a, b) => a.id.localeCompare(b.id)));
}

async function claim(world, run) {
  const res = await world.taskSvc.startAttempt(run.id, run.attempt);
  assert.equal(res.status, 'started', `claim should start (got ${res.status}: ${res.reason})`);
  // The ENGINE transitions the identity on claim (RESERVED/RETRY_WAIT →
  // RUNNING) — mimic it so sync/reconcile paths see the real lifecycle.
  const id = await world.db.identity.findUnique({ where: { id: run.identityId } });
  if (id && (id.status === 'RESERVED' || id.status === 'RETRY_WAIT')) {
    await world.batchSvc.transitionIdentity(run.identityId, 'RUNNING', {
      reason: 'engine claim (test mimic)', actor: 'worker:test', correlationId: run.batchId ?? null,
    });
  }
  return res.run;
}

/** Finish a run exactly the way the engine does (terminal + identity sync). */
async function finish(world, runId, { status, errorCode = null, errorMessage = null, attempt } = {}) {
  const before = await world.taskSvc.loadRun(runId);
  await world.taskSvc.finishRun(runId, { status, errorCode, errorMessage, attempt: attempt ?? before.attempt });
  const after = await world.taskSvc.loadRun(runId);
  const sync = await world.scheduler.syncIdentityAfterRunTerminal(after, { actor: 'worker:test' });
  return { run: after, sync };
}

async function identityStatus(world, id) {
  return (await world.db.identity.findUnique({ where: { id } }))?.status;
}

// ------------------------------------------------------------------ tests

test('startBatch: dispatches one queued run per PENDING membership (MD §7.1 派發)', async () => {
  const w = makeWorld();
  const { batches, identities } = await seedCycle(w, { identities: 3 });
  const batch = batches[0];

  const res = await w.scheduler.startBatch({ batchId: batch.id, actor: 'tester' });

  assert.equal(res.started, true);
  assert.equal(res.dispatched, 3);
  const b = await w.db.batch.findUnique({ where: { id: batch.id } });
  assert.equal(b.status, 'RUNNING');
  assert.ok(b.startedAt instanceof Date);

  const runs = await w.db.taskRun.findMany({ where: { batchId: batch.id } });
  assert.equal(runs.length, 3);
  for (const r of runs) {
    assert.equal(r.status, 'queued');
    assert.equal(r.attempt, 1);
    assert.equal(r.maxAttempts, 3);
    assert.equal(r.idempotencyKey, runIdempotencyKey(batch.id, r.identityId, 1));
  }
  for (const id of identities) {
    assert.equal(await identityStatus(w, id.id), 'RESERVED');
  }
  const members = await w.db.batchIdentity.findMany({ where: { batchId: batch.id } });
  assert.ok(members.every((m) => m.status === 'ACTIVE'));
  // Queue: one batch-run job per run (deterministic id).
  const jobs = jobsOf(w.queue);
  assert.equal(jobs.length, 3);
  assert.ok(jobs.every((j) => j.name === BATCH_RUN_JOB_NAME));
});

test('MD §14.2: two scheduler replicas race — exactly one start, ZERO double dispatch', async () => {
  // One world, two scheduler instances (two replicas: same db + queue).
  const world = makeWorld();
  const { batches, identities } = await seedCycle(world, { identities: 4 });
  const batch = batches[0];
  const s2 = createBatchScheduler({
    db: world.db, batchSvc: createBatchService({ db: world.db, log: world.log, now: world.clock.now }),
    leaseSvc: world.leaseSvc, taskSvc: world.taskSvc, queue: world.queue, log: world.log, now: world.clock.now,
  });

  const results = await Promise.allSettled([
    world.scheduler.startBatch({ batchId: batch.id, actor: 'replica-a' }),
    s2.startBatch({ batchId: batch.id, actor: 'replica-b' }),
  ]);
  const started = results.filter((r) => r.status === 'fulfilled' && r.value.started === true).length;
  const raced = results.filter((r) => r.status === 'fulfilled' && r.value.started === false).length;
  const errored = results.filter((r) => r.status === 'rejected').length;
  assert.equal(started, 1, `exactly one start wins (started=${started} raced=${raced} errored=${errored})`);
  assert.equal(raced + errored, 1, 'the loser converges (idempotent no-op), never a double start');

  // Now BOTH replicas re-ensure dispatch (the boot-pass scenario).
  const [e1, e2] = await Promise.all([
    world.scheduler.ensureRuns(batch, { actor: 'replica-a' }),
    s2.ensureRuns(batch, { actor: 'replica-b' }),
  ]);
  // startBatch already dispatched the runs — a re-ensure must add NOTHING
  // new (the deterministic job id makes every second enqueue a 'reused').
  assert.equal(e1.dispatched + e2.dispatched, 0, 'zero NEW dispatches across replicas');
  assert.equal(e1.reused, 4, 'replica-a confirms all 4 existing jobs');
  assert.equal(e2.reused, 4, 'replica-b confirms the same 4 existing jobs');

  const runs = await w_runs(world, batch.id);
  assert.equal(runs.length, 4, 'exactly one run per identity');
  assert.ok(runs.every((r) => r.status === 'queued'));
  assert.equal(jobsOf(world.queue).length, 4, 'exactly one queue job per run');
  for (const id of identities) assert.equal(await identityStatus(world, id.id), 'RESERVED');

  // A full tick on BOTH replicas adds nothing.
  const t1 = await world.scheduler.tick();
  const t2 = await s2.tick();
  assert.equal((t1.recovered?.dispatched ?? 0) + (t2.recovered?.dispatched ?? 0), 0);
  assert.equal((await w_runs(world, batch.id)).length, 4);
  assert.equal(jobsOf(world.queue).length, 4);
});

async function w_runs(world, batchId) {
  return world.db.taskRun.findMany({ where: { batchId } });
}

test('startBatch: idempotent on RUNNING, refused on CANCELLED/PAUSED', async () => {
  const w = makeWorld();
  const { batches } = await seedCycle(w, { identities: 1 });
  const batch = batches[0];
  await w.scheduler.startBatch({ batchId: batch.id });
  const again = await w.scheduler.startBatch({ batchId: batch.id });
  assert.equal(again.started, false);
  assert.equal(again.reason, 'already-running');

  const w2 = makeWorld();
  const { batches: b2 } = await seedCycle(w2, { identities: 1 });
  const res = await w2.scheduler.cancelBatch({ batchId: b2[0].id });
  assert.equal(res.immediate, true);
  const r2 = await w2.scheduler.startBatch({ batchId: b2[0].id }).then(
    () => assert.fail('should throw'),
    (err) => err,
  );
  assert.equal(r2.apiCode, 'BATCH_NOT_STARTABLE');
});

test('pause (keep running): queued stops NOW, running finishes, no redispatch while PAUSED (MD §7.1)', async () => {
  const w = makeWorld();
  const { batches, identities } = await seedCycle(w, { identities: 3 });
  const batch = batches[0];
  await w.scheduler.startBatch({ batchId: batch.id });
  const runs = (await runsOf(w.db, { batchId: batch.id })).sort((a, b) => a.id.localeCompare(b.id));
  await claim(w, runs[0]); // run1 running; run2/run3 queued

  const res = await w.scheduler.pauseBatch({ batchId: batch.id, stopExisting: false, actor: 'op' });
  assert.equal(res.batch.status, 'PAUSED');
  assert.equal(res.cancelledQueued, 2);

  assert.equal((await w.taskSvc.loadRun(runs[0].id)).status, 'running'); // kept
  assert.equal((await w.taskSvc.loadRun(runs[1].id)).status, 'cancelled');
  assert.equal((await w.taskSvc.loadRun(runs[2].id)).status, 'cancelled');
  // Identity + membership synced for the two stopped runs.
  assert.equal(await identityStatus(w, runs[1].identityId), 'CANCELLED');
  assert.equal(await identityStatus(w, runs[2].identityId), 'CANCELLED');
  const m = await w.db.batchIdentity.findMany({ where: { batchId: batch.id } });
  const byId = new Map(m.map((x) => [x.identityId, x.status]));
  assert.equal(byId.get(runs[0].identityId), 'ACTIVE');
  assert.equal(byId.get(runs[1].identityId), 'CANCELLED');

  // The paused batch must not re-dispatch (tick).
  const t = await w.scheduler.tick();
  assert.equal(t.recovered?.dispatched ?? 0, 0);
  assert.equal((await runsOf(w.db, { batchId: batch.id })).length, 3, 'no new run while PAUSED');
  void identities;
});

test('pause stopExisting=true: running runs get cancel_requested (engine performs the real stop)', async () => {
  const w = makeWorld();
  const { batches } = await seedCycle(w, { identities: 2 });
  const batch = batches[0];
  await w.scheduler.startBatch({ batchId: batch.id });
  const runs = (await runsOf(w.db, { batchId: batch.id })).sort((a, b) => a.id.localeCompare(b.id));
  await claim(w, runs[0]);

  const res = await w.scheduler.pauseBatch({ batchId: batch.id, stopExisting: true, actor: 'op' });
  assert.equal(res.batch.status, 'PAUSED');
  assert.equal(res.requested, 1);
  assert.equal((await w.taskSvc.loadRun(runs[0].id)).status, 'cancel_requested');
  assert.equal((await w.taskSvc.loadRun(runs[1].id)).status, 'cancelled'); // queued stopped immediately
});

test('resume: re-arms pause-stop victims with a FRESH seq run (MD §7.1 pause→resume)', async () => {
  const w = makeWorld();
  const { batches } = await seedCycle(w, { identities: 2 });
  const batch = batches[0];
  await w.scheduler.startBatch({ batchId: batch.id });
  const runs = (await runsOf(w.db, { batchId: batch.id })).sort((a, b) => a.id.localeCompare(b.id));
  await w.scheduler.pauseBatch({ batchId: batch.id, stopExisting: false, actor: 'op' });
  // Both runs cancelled (none was running).
  const statuses = await Promise.all(runs.map((r) => w.taskSvc.loadRun(r.id).then((r) => r.status)));
  assert.ok(statuses.every((s) => s === 'cancelled'));

  const res = await w.scheduler.resumeBatch({ batchId: batch.id, actor: 'op' });
  assert.equal(res.batch.status, 'RUNNING');
  assert.equal(res.dispatched, 2);

  const all = await w.db.taskRun.findMany({ where: { batchId: batch.id } });
  assert.equal(all.length, 4, 'two cancelled + two fresh runs');
  const fresh = all.filter((r) => r.status === 'queued');
  assert.equal(fresh.length, 2);
  for (const f of fresh) {
    assert.equal(f.attempt, 1);
    assert.equal(f.idempotencyKey, runIdempotencyKey(batch.id, f.identityId, 2), 'fresh seq (no key reuse)');
  }
  for (const f of fresh) {
    assert.equal(await identityStatus(w, f.identityId), 'RESERVED');
  }
  assert.equal(jobsOf(w.queue).length, 2, 'only the fresh runs are queued');
});

test('cancel: PLANNED immediate; RUNNING → CANCELLING → finalizer → CANCELLED (202 語義)', async () => {
  // PLANNED → immediate
  const w = makeWorld();
  const { batches } = await seedCycle(w, { identities: 2 });
  const p = await w.scheduler.cancelBatch({ batchId: batches[0].id, actor: 'op' });
  assert.equal(p.immediate, true);
  const mb = await w.db.batchIdentity.findMany({ where: { batchId: batches[0].id } });
  assert.ok(mb.every((m) => m.status === 'CANCELLED'));

  // RUNNING → CANCELLING → tick finalizes once every run is terminal
  const w2 = makeWorld();
  const { batches: b2 } = await seedCycle(w2, { identities: 2 });
  const batch2 = b2[0];
  await w2.scheduler.startBatch({ batchId: batch2.id });
  const runs = (await runsOf(w2.db, { batchId: batch2.id })).sort((a, b) => a.id.localeCompare(b.id));
  await claim(w2, runs[0]);

  const c = await w2.scheduler.cancelBatch({ batchId: batch2.id, actor: 'op' });
  assert.equal(c.immediate, false);
  assert.equal((await w2.db.batch.findUnique({ where: { id: batch2.id } })).status, 'CANCELLING');
  assert.equal((await w2.taskSvc.loadRun(runs[0].id)).status, 'cancel_requested');
  assert.equal((await w2.taskSvc.loadRun(runs[1].id)).status, 'cancelled'); // queued stopped now

  // Engine has not confirmed the running one yet → no finalization.
  const t1 = await w2.scheduler.tick();
  assert.deepEqual(t1.finalizing, []);
  assert.equal((await w2.db.batch.findUnique({ where: { id: batch2.id } })).status, 'CANCELLING');

  // Engine confirms (cancel poll → markCancelled + sync).
  await w2.taskSvc.markCancelled(runs[0].id, { reason: 'cancelled_during_run' });
  await w2.scheduler.syncIdentityAfterRunTerminal(await w2.taskSvc.loadRun(runs[0].id), { actor: 'worker:test' });
  const t2 = await w2.scheduler.tick();
  assert.ok(t2.finalizing.includes(batch2.id), 'finalizer flipped CANCELLING → CANCELLED');
  const fin = await w2.db.batch.findUnique({ where: { id: batch2.id } });
  assert.equal(fin.status, 'CANCELLED');
  assert.ok(fin.finishedAt instanceof Date);
});

test('progressCycles: predecessor gate + cooldown (MD §3.2 嚴格 batch_no 順序)', async () => {
  const w = makeWorld();
  const { batches } = await seedCycle(w, { identities: 4, batchSize: 2, config: { interBatchCooldownSeconds: 3600 } });
  const [b1, b2] = batches;

  // Direct start of batch #2 is refused while #1 is not done.
  await assert.rejects(
    () => w.scheduler.startBatch({ batchId: b2.id }),
    (err) => err.apiCode === 'BATCH_ORDER_GATE',
  );

  // Tick starts #1 only.
  const t1 = await w.scheduler.tick();
  assert.deepEqual(t1.started, [b1.id]);
  assert.equal((await w.db.batch.findUnique({ where: { id: b2.id } })).status, 'PLANNED');

  // Finish batch #1 (both runs succeeded).
  const runs1 = (await runsOf(w.db, { batchId: b1.id })).sort((a, b) => a.id.localeCompare(b.id));
  for (const r of runs1) {
    await claim(w, r);
    await finish(w, r.id, { status: 'succeeded' });
  }
  await w.scheduler.tick(); // evaluate → COMPLETED (finishedAt set)
  const done1 = await w.db.batch.findUnique({ where: { id: b1.id } });
  assert.equal(done1.status, 'COMPLETED');

  // Cooldown not elapsed → #2 waits.
  const t2 = await w.scheduler.tick();
  assert.deepEqual(t2.started, []);
  assert.equal((await w.db.batch.findUnique({ where: { id: b2.id } })).status, 'PLANNED');

  // Cooldown elapsed → #2 starts on the next tick.
  w.clock.advance(3_601_000);
  const t3 = await w.scheduler.tick();
  assert.deepEqual(t3.started, [b2.id]);
  assert.equal((await w.db.batch.findUnique({ where: { id: b2.id } })).status, 'RUNNING');

  // COMPLETED_WITH_ERRORS predecessor also unblocks (completion policy satisfied).
  const w2 = makeWorld();
  const { batches: c } = await seedCycle(w2, { identities: 4, batchSize: 2, failurePolicy: 'continue_and_report' });
  const [cb1, cb2] = c;
  await w2.scheduler.tick(); // start cb1
  const cruns = (await runsOf(w2.db, { batchId: cb1.id })).sort((a, b) => a.id.localeCompare(b.id));
  await claim(w2, cruns[0]); await finish(w2, cruns[0].id, { status: 'succeeded' });
  await claim(w2, cruns[1]); await finish(w2, cruns[1].id, { status: 'failed', errorCode: 'TEST_FAIL' });
  await w2.scheduler.tick(); // evaluate → COMPLETED_WITH_ERRORS
  assert.equal((await w2.db.batch.findUnique({ where: { id: cb1.id } })).status, 'COMPLETED_WITH_ERRORS');
  const t = await w2.scheduler.tick();
  assert.deepEqual(t.started, [cb2.id]);
});

test('progressCycles: a CANCELLED predecessor STALLS the cycle (human judgement, never auto-skip)', async () => {
  const w = makeWorld();
  const { batches } = await seedCycle(w, { identities: 4, batchSize: 2 });
  const [b1, b2] = batches;
  await w.scheduler.cancelBatch({ batchId: b1.id }); // PLANNED → CANCELLED
  const t = await w.scheduler.tick();
  assert.deepEqual(t.started, []);
  assert.equal((await w.db.batch.findUnique({ where: { id: b2.id } })).status, 'PLANNED');
  assert.ok(w.out.warn.some((x) => String(x.m).includes('stalled')), 'stall is logged');
});

test('stop_batch policy: FAILED_FINAL parks the batch in PAUSED (B1 evaluate path via tick)', async () => {
  const w = makeWorld();
  const { batches } = await seedCycle(w, { identities: 2, failurePolicy: 'stop_batch' });
  const batch = batches[0];
  await w.scheduler.startBatch({ batchId: batch.id });
  const runs = (await runsOf(w.db, { batchId: batch.id })).sort((a, b) => a.id.localeCompare(b.id));
  await claim(w, runs[0]); await finish(w, runs[0].id, { status: 'failed', errorCode: 'TEST_FAIL' });
  await claim(w, runs[1]); await finish(w, runs[1].id, { status: 'failed', errorCode: 'TEST_FAIL' });
  const t = await w.scheduler.tick();
  const eval1 = t.completion.find((c) => c.batchId === batch.id);
  assert.equal(eval1.status, 'PAUSED');
  assert.equal((await w.db.batch.findUnique({ where: { id: batch.id } })).status, 'PAUSED');
});

// ------------------------------------------------- MD §6.2 lease reconciliation
async function seedLeasedRun(world, { maxAttempts = 3 } = {}) {
  const { batches, identities } = await seedCycle(world, { identities: 1, config: { maxAttempts } });
  const batch = batches[0];
  await world.scheduler.startBatch({ batchId: batch.id });
  const run = (await runsOf(world.db, { batchId: batch.id }))[0];
  await claim(world, run); // claim() mimics the engine (run running + identity RUNNING)
  const lease = await world.leaseSvc.acquireSlot({
    totalSlots: 2, ownerRunId: run.id, ttlMs: 60_000,
  });
  assert.equal(lease.acquired, true);
  return { batch, run, identity: identities[0], slotKey: lease.lease.resourceKey };
}

test('reconcile §6.2: executor lost, no side effects, attempts left → failed EXECUTOR_LOST + RETRY_WAIT + auto-retry', async () => {
  const w = makeWorld();
  const { run, identity, slotKey } = await seedLeasedRun(w, { maxAttempts: 3 });
  w.clock.advance(61_000); // lease expires

  const res = await w.scheduler.reconcileExpiredLeases();
  assert.equal(res.scanned, 1);
  assert.equal(res.retried, 1);
  assert.equal(res.errors.length, 0);

  const after = await w.taskSvc.loadRun(run.id);
  // Honest terminal for attempt 1 (event stream) — the ROW moves on to the
  // fresh attempt (requestRetry reuses the row): queued at attempt 2.
  assert.equal(after.status, 'queued');
  assert.equal(after.attempt, 2);
  const events = await w.db.taskRunEvent.findMany({ where: { taskRunId: run.id } });
  const failed = events.find((e) => e.eventType === 'failed');
  assert.ok(failed, 'attempt-1 FAILED event recorded');
  assert.equal(failed.payloadJson?.errorCode, 'EXECUTOR_LOST');
  assert.equal(await identityStatus(w, identity.id), 'RETRY_WAIT');
  // Fresh attempt auto-dispatched (batch-aware enqueue → batch job).
  const job = jobsOf(w.queue).find((j) => j.id === batchJobId(run.id, 2));
  assert.ok(job, 'attempt-2 batch job in the queue');
  // Slot released (re-acquirable: the freed slot key is taken by the next owner).
  const again = await w.leaseSvc.acquireSlot({ totalSlots: 2, ownerRunId: '11111111-1111-4111-8111-111111111111', ttlMs: 60_000 });
  assert.equal(again.acquired, true, 'slot pool accepts a new owner');
  assert.equal(again.lease.resourceKey, slotKey, 'the freed slot is re-acquirable');
});

test('reconcile §6.2: attempts exhausted → failed EXECUTOR_LOST + FAILED_FINAL, NO auto re-run', async () => {
  const w = makeWorld();
  const { run, identity } = await seedLeasedRun(w, { maxAttempts: 1 });
  w.clock.advance(61_000);
  const res = await w.scheduler.reconcileExpiredLeases();
  assert.equal(res.finalFailed, 1);
  assert.equal(res.retried, 0);
  const after = await w.taskSvc.loadRun(run.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.errorCode, 'EXECUTOR_LOST');
  assert.equal(await identityStatus(w, identity.id), 'FAILED_FINAL');
  assert.equal(jobsOf(w.queue).find((j) => j.id === batchJobId(run.id, 2)), undefined, 'no NEW attempt job');
});

test('reconcile §6.2: side effects → RECOVERING isolation, NO auto re-run (MD §6.2 紅線)', async () => {
  const w = makeWorld({ inspectEffects: async () => ({ sideEffects: true, detail: 'container still writing' }) });
  const { run, identity } = await seedLeasedRun(w, { maxAttempts: 5 });
  w.clock.advance(61_000);
  const res = await w.scheduler.reconcileExpiredLeases();
  assert.equal(res.isolated, 1);
  assert.equal(res.retried, 0);
  assert.equal(res.finalFailed, 0);

  const after = await w.taskSvc.loadRun(run.id);
  assert.equal(after.status, 'running', 'run left untouched (a human decides the stop)');
  assert.equal(await identityStatus(w, identity.id), 'RECOVERING');
  assert.equal(jobsOf(w.queue).length, 1, 'only the original (dead) job — no re-run');
  assert.ok(w.out.error.some((x) => String(x.m).includes('side effects')), 'CRITICAL log present');
});

test('reconcile §6.2: terminal run / missing run → release only; cancel_requested → honest cancel', async () => {
  // (a) run already terminal → release
  const wa = makeWorld();
  const { run: ra, slotKey: ka } = await seedLeasedRun(wa);
  await finish(wa, ra.id, { status: 'succeeded' });
  wa.clock.advance(61_000);
  let res = await wa.scheduler.reconcileExpiredLeases();
  assert.equal(res.released, 1);
  const leaseA = await wa.db.resourceLease.findUnique({ where: { resourceType: 'container_slot', resourceKey: ka } });
  assert.equal(leaseA, null); // release is an owner-only CAS DELETE (row gone)

  // (b) run row deleted (defensive) → deleteMany path
  const wb = makeWorld();
  const { run: rb, slotKey: kb } = await seedLeasedRun(wb);
  await wb.db.taskRun.delete({ where: { id: rb.id } });
  wb.clock.advance(61_000);
  res = await wb.scheduler.reconcileExpiredLeases();
  assert.equal(res.released, 1);
  assert.equal(res.errors.length, 0);
  const leaseB = await wb.db.resourceLease.findUnique({ where: { resourceType: 'container_slot', resourceKey: kb } });
  assert.equal(leaseB, null);

  // (c) cancel_requested + expired lease → markCancelled + identity sync + release
  const wc = makeWorld();
  const { run: rc, identity: ic, slotKey: kc } = await seedLeasedRun(wc);
  await wc.taskSvc.requestCancel(rc.id, { actorUserId: 'op' });
  wc.clock.advance(61_000);
  res = await wc.scheduler.reconcileExpiredLeases();
  assert.equal(res.cancelled, 1);
  assert.equal((await wc.taskSvc.loadRun(rc.id)).status, 'cancelled');
  assert.equal(await identityStatus(wc, ic.id), 'CANCELLED');
  const leaseC = await wc.db.resourceLease.findUnique({ where: { resourceType: 'container_slot', resourceKey: kc } });
  assert.equal(leaseC, null); // released (row deleted)
});

test('sweep: stale cancel_requested (> staleCancelMs, no live executor) → confirmed cancelled + synced', async () => {
  const w = makeWorld({ schedulerConfig: { staleCancelMs: 60_000 } });
  const { batches } = await seedCycle(w, { identities: 1 });
  const batch = batches[0];
  await w.scheduler.startBatch({ batchId: batch.id });
  const run = (await runsOf(w.db, { batchId: batch.id }))[0];
  await w.taskSvc.requestCancel(run.id, { actorUserId: 'op' });

  // Not stale yet → no sweep.
  w.clock.advance(30_000);
  assert.equal(await w.scheduler.sweepStaleCancelRequests(), 0);
  assert.equal((await w.taskSvc.loadRun(run.id)).status, 'cancel_requested');

  // Stale → confirmed.
  w.clock.advance(40_000);
  assert.equal(await w.scheduler.sweepStaleCancelRequests(), 1);
  assert.equal((await w.taskSvc.loadRun(run.id)).status, 'cancelled');
  assert.equal(await identityStatus(w, run.identityId), 'CANCELLED');
});

test('global cap: AppSetting read + effectiveSlotCap min(batch, global) (MD §3.1)', async () => {
  const w = makeWorld();
  assert.deepEqual(await readGlobalMaxActive(w.db), { cap: null });

  await w.db.appSetting.upsert({ where: { key: APP_SETTING_BATCH_GLOBAL_MAX_ACTIVE }, create: { key: APP_SETTING_BATCH_GLOBAL_MAX_ACTIVE, valueJson: { value: 3 } }, update: {} });
  assert.deepEqual(await readGlobalMaxActive(w.db), { cap: 3 });

  const batch = { maxActiveContainers: 5 };
  assert.equal(effectiveSlotCap(batch, null), 5); // no global cap
  assert.equal(effectiveSlotCap(batch, 3), 3); // global tighter
  assert.equal(effectiveSlotCap({ ...batch, maxActiveContainers: 2 }, 3), 2); // batch tighter
  assert.equal(effectiveSlotCap({ ...batch, maxActiveContainers: 0 }, 3), 1); // degenerate → 1

  await w.db.appSetting.upsert({ where: { key: APP_SETTING_BATCH_GLOBAL_MAX_ACTIVE }, create: { key: APP_SETTING_BATCH_GLOBAL_MAX_ACTIVE, valueJson: { value: 0 } }, update: { valueJson: { value: 0 } } });
  assert.deepEqual(await readGlobalMaxActive(w.db), { cap: null }, 'invalid value ignored');
});

test('tick: a failing pass is contained (other passes still run) — MD §12.3 錯誤誠實', async () => {
  const w = makeWorld();
  const { batches } = await seedCycle(w, { identities: 1 });
  await w.scheduler.startBatch({ batchId: batches[0].id });
  // Break ONE pass only (the reconciler's expired-lease scan).
  const realListExpired = w.leaseSvc.listExpired.bind(w.leaseSvc);
  w.leaseSvc.listExpired = async () => {
    throw new Error('boom (test)');
  };
  const t = await w.scheduler.tick();
  w.leaseSvc.listExpired = realListExpired;
  assert.equal(t.errors.length, 1);
  assert.equal(t.errors[0].pass, 'reconcileExpiredLeases');
  assert.equal(t.staleCancelled, 0, 'later passes still ran');
  assert.equal(jobsOf(w.queue).length, 1, 'world still consistent');
});
