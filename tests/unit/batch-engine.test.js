/**
 * BR-B2 gen2 — batch run ENGINE unit tests (MD §14.1: concurrency, cancel,
 * timeout, retry, lease loss; MD §6.2/§7 worker-side execution).
 *
 * Hermetic: fake db + real B1 services + real adapter registry (noop) +
 * injectable network gate. The "worker" is simulated by calling
 * handleBatchJob(job) directly with fake-queue job objects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBatchScheduler,
  createBatchService,
  createLeaseService,
  createTaskRunService,
  enqueueAnyRun,
  BATCH_RUN_JOB_NAME,
  batchJobId,
} from '@water-army/shared';
import { makeBatchFakeDb } from '../helpers/batch-fakes.js';
import { makeFakeQueue } from '../helpers/fakes.js';
import { createBatchEngine, makeInspectEffects } from '../../apps/worker/src/batch-engine.js';
import { createAdapterRegistry, AdapterError } from '../../apps/worker/src/adapter-registry.js';

// ------------------------------------------------------------------ harness
function makeEngineWorld({ adapterEnv = { NOOP_DURATION_MS: '50' }, networkGate = null, engineConfig = {}, schedulerConfig = {} } = {}) {
  let t = new Date('2026-10-21T00:00:00Z').getTime();
  const now = () => new Date(t);
  const db = makeBatchFakeDb({ clock: now });
  const logs = [];
  const log = {
    error: (o, m) => logs.push({ level: 'error', o, m }),
    warn: (o, m) => logs.push({ level: 'warn', o, m }),
    info: (o, m) => logs.push({ level: 'info', o, m }),
  };
  const queue = makeFakeQueue();
  const taskSvc = createTaskRunService({
    db, log,
    config: { taskDefaultTimeoutMs: 60_000, taskDefaultAttempts: 3 },
    enqueue: ({ runId, attempt }) => enqueueAnyRun(queue, { db, runId, attempt, timeoutMs: 60_000 }),
  });
  const batchSvc = createBatchService({ db, log, now });
  const leaseSvc = createLeaseService({ db, now });
  const adapterRegistry = createAdapterRegistry({ env: adapterEnv, log });
  const scheduler = createBatchScheduler({
    db, batchSvc, leaseSvc, taskSvc, queue, log, now,
    inspectEffects: makeInspectEffects(adapterRegistry),
    config: { slotTtlMs: 60_000, ...schedulerConfig },
  });
  const engine = createBatchEngine({
    db, taskSvc, batchSvc, leaseSvc, scheduler, adapterRegistry, networkGate, log, now,
    config: {
      batchHeartbeatMs: 1000,
      batchCancelPollMs: 250,
      batchSlotWaitMs: 1000,
      batchSlotTtlMs: 60_000,
      batchMaxSlotDefers: 3,
      batchDefaultTimeoutMs: 60_000,
      ...engineConfig,
    },
  });
  return { now, setClock: (ms) => { t += ms; }, db, logs, log, queue, taskSvc, batchSvc, leaseSvc, adapterRegistry, scheduler, engine };
}

let idSeq = 0;
async function seedBatchRun(w, { identities = 1, maxActiveContainers = 1, adapter = 'noop', maxAttempts = 3, config = {} } = {}) {
  const ids = [];
  for (let i = 0; i < identities; i += 1) {
    idSeq += 1;
    ids.push(await w.db.identity.create({ data: { email: `u${idSeq}@e.com`, username: `u${idSeq}`, status: 'READY' } }));
  }
  const res = await w.batchSvc.createCycle(
    {
      name: `eng-${idSeq}`,
      idempotencyKey: `eng-${Math.random().toString(36).slice(2, 10)}`,
      identities: ids.map((i) => ({ id: i.id })),
      batchSize: identities,
      maxActiveContainers,
      failurePolicy: 'continue_and_report',
      config: { adapter, timeoutSeconds: 60, maxAttempts, interBatchCooldownSeconds: 0, ...config },
    },
    { id: 'tester' },
  );
  const batch = (await w.db.batch.findMany({ where: { cycleId: res.cycleId } }))[0];
  await w.scheduler.startBatch({ batchId: batch.id });
  const runs = (await w.db.taskRun.findMany({ where: { batchId: batch.id } })).sort((a, b) => a.createdAt - b.createdAt);
  return { batch, identities: ids, runs };
}

function jobFor(run, w, extra = {}) {
  return {
    id: `job-${run.id}-${run.attempt}`,
    name: BATCH_RUN_JOB_NAME,
    data: { runId: run.id, attempt: run.attempt, timeoutMs: 60_000, maxAttempts: run.maxAttempts, ...extra },
    state: 'active',
    async moveToDelayed(ms) { this.state = 'delayed'; this.delayedMs = ms; },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until a predicate on the DB (bounded) — deterministic test sync. */
async function waitFor(pred, { label = 'condition', timeoutMs = 4_000 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${label}`);
    await sleep(20);
  }
}

// ------------------------------------------------------------------ tests

test('engine: successful noop run — run succeeded, identity COMPLETED, slot released, heartbeat written', async () => {
  const w = makeEngineWorld();
  const { batch, identities, runs } = await seedBatchRun(w, { identities: 1, adapter: 'noop' });
  const run = runs[0];
  const outcome = await w.engine.handleBatchJob(jobFor(run, w));

  assert.equal(outcome.outcome, 'succeeded');
  const after = await w.taskSvc.loadRun(run.id);
  assert.equal(after.status, 'succeeded');
  assert.ok(after.finishedAt instanceof Date);
  assert.ok(after.heartbeatAt instanceof Date, 'heartbeat loop wrote heartbeatAt');
  assert.equal((await w.db.identity.findUnique({ where: { id: identities[0].id } })).status, 'COMPLETED');
  const member = await w.db.batchIdentity.findFirst({ where: { batchId: batch.id, identityId: identities[0].id } });
  assert.equal(member.status, 'COMPLETED');
  // Slot released.
  const leases = await w.db.resourceLease.findMany({ where: { resourceType: 'container_slot' } });
  assert.equal(leases.filter((l) => l.ownerRunId === run.id).length, 0);
  // The batch completed (single identity terminal).
  await w.scheduler.tick();
  assert.equal((await w.db.batch.findUnique({ where: { id: batch.id } })).status, 'COMPLETED');
});

test('engine: GLOBAL slot cap — second run defers (job delayed, run queued, NO lease) until the slot frees', async () => {
  const w = makeEngineWorld({ adapterEnv: { NOOP_DURATION_MS: '250' }, engineConfig: { batchMaxSlotDefers: 3 } });
  const { runs } = await seedBatchRun(w, { identities: 2, maxActiveContainers: 1 });
  const [runA, runB] = runs;

  const jobA = jobFor(runA, w);
  const jobB = jobFor(runB, w);
  const pa = w.engine.handleBatchJob(jobA); // will hold the slot ~250ms
  await waitFor(async () => (await w.taskSvc.loadRun(runA.id)).status === 'running', { label: 'A running' });
  // Slot pool of 1: B cannot acquire.
  const pb = w.engine.handleBatchJob(jobB);
  const ob = await pb;
  assert.equal(ob.outcome, 'slot-deferred');
  assert.equal(jobB.state, 'delayed', 'job B moved to delayed (re-delivered later)');
  assert.equal(jobB.delayedMs, 1000);
  assert.equal((await w.taskSvc.loadRun(runB.id)).status, 'queued', 'run B untouched (still queued)');
  assert.equal((await w.db.resourceLease.findMany({ where: { resourceType: 'container_slot' } })).filter((l) => l.ownerRunId === runB.id).length, 0, 'B holds no lease while waiting');

  const oa = await pa;
  assert.equal(oa.outcome, 'succeeded');

  // Slot freed → B's (re-delivered) job now proceeds.
  const jobB2 = jobFor(runB, w);
  const ob2 = await w.engine.handleBatchJob(jobB2);
  assert.equal(ob2.outcome, 'succeeded');
  assert.equal((await w.taskSvc.loadRun(runB.id)).status, 'succeeded');
});

test('engine: claim CAS — duplicate delivery, exactly one winner (no double execution)', async () => {
  // Two slots so both duplicate jobs pass the global gate and race on the
  // claim CAS itself (one winner, one claim-lost — never double execution).
  const w = makeEngineWorld({ adapterEnv: { NOOP_DURATION_MS: '80' } });
  const { runs } = await seedBatchRun(w, { identities: 1, maxActiveContainers: 2 });
  const run = runs[0];
  const [r1, r2] = await Promise.all([
    w.engine.handleBatchJob(jobFor(run, w)),
    w.engine.handleBatchJob(jobFor(run, w)),
  ]);
  const outcomes = [r1.outcome, r2.outcome].sort();
  assert.deepEqual(outcomes, ['claim-lost', 'succeeded']);
  const after = await w.taskSvc.loadRun(run.id);
  assert.equal(after.status, 'succeeded');
  assert.equal(after.attempt, 1);
  // Exactly one ATTEMPT_STARTED event (one real execution).
  const events = await w.db.taskRunEvent.findMany({ where: { taskRunId: run.id } });
  assert.equal(events.filter((e) => e.eventType === 'attempt_started').length, 1);
});

test('engine: cancel during run (pause stopExisting path) — honest cancelled + identity CANCELLED + slot freed', async () => {
  const w = makeEngineWorld({ adapterEnv: { NOOP_DURATION_MS: '400' } });
  const { batch, identities, runs } = await seedBatchRun(w, { identities: 1 });
  const run = runs[0];
  const p = w.engine.handleBatchJob(jobFor(run, w));
  await waitFor(async () => (await w.taskSvc.loadRun(run.id)).status === 'running', { label: 'running' });
  await w.taskSvc.requestCancel(run.id, { actorUserId: 'op', reason: 'batch paused (stopExisting)' });
  const out = await p;
  assert.equal(out.outcome, 'cancelled');
  const after = await w.taskSvc.loadRun(run.id);
  assert.equal(after.status, 'cancelled');
  // Identity: RUNNING → CANCELLING → CANCELLED (the §6.1 two-phase stop).
  assert.equal((await w.db.identity.findUnique({ where: { id: identities[0].id } })).status, 'CANCELLED');
  const ev = await w.db.stateEvent.findMany({ where: { entityType: 'identity', entityId: identities[0].id } });
  const path = ev.map((e) => e.toState);
  assert.ok(path.includes('CANCELLING'), `identity went through CANCELLING (path: ${path.join('→')})`);
  const leases = await w.db.resourceLease.findMany({ where: { resourceType: 'container_slot' } });
  assert.equal(leases.filter((l) => l.ownerRunId === run.id).length, 0, 'slot freed on cancel');
  void batch;
});

test('engine: hard timeout — timed_out + identity FAILED_FINAL + slot freed', async () => {
  const w = makeEngineWorld({ adapterEnv: { NOOP_DURATION_MS: '5000' } });
  const { identities, runs } = await seedBatchRun(w, { identities: 1 });
  const run = runs[0];
  const out = await w.engine.handleBatchJob(jobFor(run, w, { timeoutMs: 120 }));
  assert.equal(out.outcome, 'timed_out');
  const after = await w.taskSvc.loadRun(run.id);
  assert.equal(after.status, 'timed_out');
  assert.equal(after.errorCode, 'RUN_TIMEOUT');
  assert.equal((await w.db.identity.findUnique({ where: { id: identities[0].id } })).status, 'FAILED_FINAL');
  const leases = await w.db.resourceLease.findMany({ where: { resourceType: 'container_slot' } });
  assert.equal(leases.filter((l) => l.ownerRunId === run.id).length, 0);
});

test('engine: retryable adapter failure — auto-retry to the cap, then FAILED_FINAL (honest attempts in the event stream)', async () => {
  const w = makeEngineWorld({ adapterEnv: { NOOP_DURATION_MS: '50', NOOP_OUTCOME: 'fail_retryable' } });
  const { identities, runs } = await seedBatchRun(w, { identities: 1, maxAttempts: 2 });
  const run = runs[0];

  // Attempt 1 → failed (retryable) → RETRY_WAIT → auto-retry enqueues attempt 2.
  const o1 = await w.engine.handleBatchJob(jobFor(run, w));
  assert.equal(o1.outcome, 'auto-retry');
  let after = await w.taskSvc.loadRun(run.id);
  assert.equal(after.status, 'queued');
  assert.equal(after.attempt, 2);
  assert.equal((await w.db.identity.findUnique({ where: { id: identities[0].id } })).status, 'RETRY_WAIT');
  const job2 = await w.queue.getJob(batchJobId(run.id, 2));
  assert.ok(job2, 'attempt-2 job in the queue (deterministic id)');

  // Attempt 2 → failed (retryable but at cap) → FAILED_FINAL, no more retries.
  const o2 = await w.engine.handleBatchJob(jobFor({ ...run, attempt: 2 }, w));
  assert.equal(o2.outcome, 'failed-final');
  after = await w.taskSvc.loadRun(run.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.attempt, 2);
  assert.equal(after.errorCode, 'ADAPTER_FAILED_RETRYABLE');
  assert.equal((await w.db.identity.findUnique({ where: { id: identities[0].id } })).status, 'FAILED_FINAL');
  // Two FAILED events (one per attempt) — the history is honest.
  const events = await w.db.taskRunEvent.findMany({ where: { taskRunId: run.id } });
  assert.equal(events.filter((e) => e.eventType === 'failed').length, 2);
  assert.equal(events.filter((e) => e.eventType === 'attempt_started').length, 2);
});

test('engine: 429 RATE_LIMITED adapter failure — transient (park RETRY_WAIT, never FAILED_FINAL on first hit) — B6 gen2 E2E finding', async () => {
  const w = makeEngineWorld({ adapterEnv: { NOOP_DURATION_MS: '50', NOOP_OUTCOME: 'fail_429' } });
  const { identities, runs } = await seedBatchRun(w, { identities: 1, maxAttempts: 3 });
  const run = runs[0];

  // Attempt 1 → 429 → the budget window resets with time: the engine must
  // park the identity in RETRY_WAIT (next tick re-dispatches), not drop it.
  const o1 = await w.engine.handleBatchJob(jobFor(run, w));
  assert.equal(o1.outcome, 'auto-retry', '429 is transient — auto-retry, not failed-final');
  let after = await w.taskSvc.loadRun(run.id);
  assert.equal(after.status, 'queued', 'run row reused, back to queued for the next attempt');
  assert.equal(after.attempt, 2);
  assert.equal((await w.db.identity.findUnique({ where: { id: identities[0].id } })).status, 'RETRY_WAIT');

  // Attempt 2 → 429 again → still parked (attempts remain).
  const o2 = await w.engine.handleBatchJob(jobFor({ ...run, attempt: 2 }, w));
  assert.equal(o2.outcome, 'auto-retry');
  assert.equal((await w.db.identity.findUnique({ where: { id: identities[0].id } })).status, 'RETRY_WAIT');

  // Attempt 3 → at cap → FAILED_FINAL (honest: we did wait it out).
  const o3 = await w.engine.handleBatchJob(jobFor({ ...run, attempt: 3 }, w));
  assert.equal(o3.outcome, 'failed-final');
  after = await w.taskSvc.loadRun(run.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.errorCode, 'RATE_LIMITED');
  assert.equal((await w.db.identity.findUnique({ where: { id: identities[0].id } })).status, 'FAILED_FINAL');
});

test('engine: non-retryable adapter failure — immediate FAILED_FINAL (no auto-retry)', async () => {
  const w = makeEngineWorld({ adapterEnv: { NOOP_DURATION_MS: '50', NOOP_OUTCOME: 'fail' } });
  const { identities, runs } = await seedBatchRun(w, { identities: 1, maxAttempts: 3 });
  const run = runs[0];
  const o = await w.engine.handleBatchJob(jobFor(run, w));
  assert.equal(o.outcome, 'failed-final');
  const after = await w.taskSvc.loadRun(run.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.attempt, 1);
  assert.equal(after.errorCode, 'ADAPTER_FAILED');
  assert.equal((await w.db.identity.findUnique({ where: { id: identities[0].id } })).status, 'FAILED_FINAL');
});

test('engine: slot lease lost mid-run (heartbeat renew fails) — SLOT_LEASE_LOST, NO auto re-run', async () => {
  const w = makeEngineWorld({ adapterEnv: { NOOP_DURATION_MS: '2000' }, engineConfig: { batchHeartbeatMs: 1000 } });
  const { identities, runs } = await seedBatchRun(w, { identities: 1 });
  const run = runs[0];
  const p = w.engine.handleBatchJob(jobFor(run, w));
  await waitFor(async () => (await w.taskSvc.loadRun(run.id)).status === 'running', { label: 'running' });
  // Simulate the reconciler taking the slot (our lease row is gone).
  await w.db.resourceLease.deleteMany({ where: { resourceType: 'container_slot', ownerRunId: run.id } });
  const out = await p;
  assert.equal(out.outcome, 'slot-lost');
  const after = await w.taskSvc.loadRun(run.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.errorCode, 'SLOT_LEASE_LOST');
  assert.equal(after.attempt, 1, 'the same attempt is NOT re-run (a human decides)');
  assert.equal((await w.db.identity.findUnique({ where: { id: identities[0].id } })).status, 'FAILED_FINAL');
});

test('engine: batch gate — a non-RUNNING batch stops its queued run (honest cancel)', async () => {
  const w = makeEngineWorld();
  const { batch, identities, runs } = await seedBatchRun(w, { identities: 1 });
  const run = runs[0];
  // Park the batch behind the engine (cancel flow without the scheduler's
  // queued-stop shortcut — exercises the engine's own gate).
  await w.batchSvc.transitionBatch(batch.id, 'CANCELLING', { reason: 'test', actor: 'tester' });
  const out = await w.engine.handleBatchJob(jobFor(run, w));
  assert.equal(out.outcome, 'batch-not-running');
  assert.equal(out.batchStatus, 'CANCELLING');
  assert.equal((await w.taskSvc.loadRun(run.id)).status, 'cancelled');
  assert.equal((await w.db.identity.findUnique({ where: { id: identities[0].id } })).status, 'CANCELLED');
});

test('engine: identity guard — a non-RESERVED identity stops the run (never force a divergent identity)', async () => {
  const w = makeEngineWorld();
  const { identities, runs } = await seedBatchRun(w, { identities: 1 });
  const run = runs[0];
  await w.batchSvc.transitionIdentity(identities[0].id, 'CANCELLED', { reason: 'operator disabled', actor: 'op' });
  const out = await w.engine.handleBatchJob(jobFor(run, w));
  assert.equal(out.outcome, 'identity-not-ready');
  assert.equal(out.identityStatus, 'CANCELLED');
  assert.equal((await w.taskSvc.loadRun(run.id)).status, 'cancelled');
  // Identity NOT force-moved (already CANCELLED — sync diverges, logs, stops).
  assert.equal((await w.db.identity.findUnique({ where: { id: identities[0].id } })).status, 'CANCELLED');
});

test('engine: §6.2 red line — redelivery racing RECOVERING isolation cancels the run but NEVER auto-releases the quarantine', async () => {
  // E2E run-3 race window: worker SIGKILL → reconcile isolates the identity
  // (RECOVERING) → the stalled-job redelivery lands before/after the honest
  // run cancel. Either way the redelivered job must stop the run (no RUNNING
  // zombie) WITHOUT clobbering RECOVERING → CANCELLED — the clobber armed
  // the pause-stop re-arm and silently re-ran the isolated work to COMPLETED
  // (3 of 4 orphans in run-3).
  const w = makeEngineWorld();
  const { batch, identities, runs } = await seedBatchRun(w, { identities: 1 });
  const run = runs[0];
  // The run is in flight (claimed): run running + identity RUNNING.
  const claimRes = await w.taskSvc.startAttempt(run.id, run.attempt);
  assert.equal(claimRes.status, 'started');
  await w.batchSvc.transitionIdentity(identities[0].id, 'RUNNING', { reason: 'engine claim (mimic)', actor: 'worker:test' });
  // Reconcile has isolated, run cancel not yet applied = the race window.
  await w.batchSvc.transitionIdentity(identities[0].id, 'RECOVERING', { reason: 'reconcile isolation (mimic)', actor: 'scheduler:reconciler' });

  const out = await w.engine.handleBatchJob(jobFor(run, w));
  assert.equal(out.outcome, 'identity-not-ready');
  assert.equal(out.identityStatus, 'RECOVERING');
  assert.equal((await w.taskSvc.loadRun(run.id)).status, 'cancelled', 'orphaned run honestly stopped');
  assert.equal((await w.db.identity.findUnique({ where: { id: identities[0].id } })).status, 'RECOVERING', 'quarantine NOT clobbered to CANCELLED');
  const m = await w.db.batchIdentity.findFirst({ where: { batchId: batch.id, identityId: identities[0].id } });
  assert.equal(m.status, 'CANCELLED', 'membership mirrored so the batch can converge');
  // And a scheduler tick must not re-arm / re-dispatch the quarantined identity.
  await w.scheduler.tick();
  assert.equal((await w.db.taskRun.findMany({ where: { batchId: batch.id } })).length, 1, 'no second run (auto re-arm blocked while quarantined)');
  assert.equal((await w.db.identity.findUnique({ where: { id: identities[0].id } })).status, 'RECOVERING', 'tick does not release the quarantine');
});

test('engine: stale guards — terminal run / superseded attempt are no-ops', async () => {
  const w = makeEngineWorld();
  const { runs } = await seedBatchRun(w, { identities: 1 });
  const run = runs[0];
  // Legal path to a terminal queued run: cancel → cancelled.
  await w.taskSvc.requestCancel(run.id, { actorUserId: 'op', reason: 'test' });
  await w.taskSvc.markCancelled(run.id, { reason: 'test' });
  assert.equal((await w.engine.handleBatchJob(jobFor(run, w))).outcome, 'stale-terminal');
  // Superseded attempt (attempt 2 job for a run at attempt 1).
  const w2 = makeEngineWorld();
  const { runs: r2 } = await seedBatchRun(w2, { identities: 1 });
  assert.equal((await w2.engine.handleBatchJob(jobFor(r2[0], w2, { attempt: 99 }))).outcome, 'stale-attempt');
  // Gone run.
  assert.equal((await w2.engine.handleBatchJob({ id: 'x', name: BATCH_RUN_JOB_NAME, data: { runId: '00000000-0000-4000-8000-000000000000', attempt: 1 } })).outcome, 'gone');
});

test('engine: network gate deny (B4 fail-closed) — failed with the gate code, identity FAILED_FINAL', async () => {
  const w = makeEngineWorld({
    networkGate: async () => ({ allowed: false, code: 'NETWORK_TARGET_DENIED', reason: 'target not allowlisted' }),
  });
  const { identities, runs } = await seedBatchRun(w, { identities: 1 });
  const run = runs[0];
  const out = await w.engine.handleBatchJob(jobFor(run, w));
  assert.equal(out.outcome, 'network-denied');
  assert.equal(out.code, 'NETWORK_TARGET_DENIED');
  const after = await w.taskSvc.loadRun(run.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.errorCode, 'NETWORK_TARGET_DENIED');
  assert.equal((await w.db.identity.findUnique({ where: { id: identities[0].id } })).status, 'FAILED_FINAL');
  // The gate runs AFTER the claim (design order: slot → claim → gate), so the
  // claim's attempt_started exists — but NO adapter work happened after the
  // denial (no result, no second attempt).
  const events = await w.db.taskRunEvent.findMany({ where: { taskRunId: run.id } });
  assert.equal(events.filter((e) => e.eventType === 'attempt_started').length, 1);
  assert.equal(events.filter((e) => e.eventType === 'succeeded').length, 0);
  const afterFull = await w.taskSvc.loadRun(run.id);
  assert.equal(afterFull.resultText, null);
  assert.equal(afterFull.attempt, 1);
});

test('engine: adapter fail-closed — missing adapter → ADAPTER_NOT_CONFIGURED; unknown → ADAPTER_NOT_ALLOWED', async () => {
  // Missing (configJson.adapter = null).
  const w1 = makeEngineWorld();
  const { runs: r1 } = await seedBatchRun(w1, { identities: 1, adapter: null });
  const o1 = await w1.engine.handleBatchJob(jobFor(r1[0], w1));
  assert.equal(o1.outcome, 'failed-final');
  assert.equal((await w1.taskSvc.loadRun(r1[0].id)).errorCode, 'ADAPTER_NOT_CONFIGURED');

  // Unknown adapter name (not on the allowlist).
  const w2 = makeEngineWorld();
  const { runs: r2 } = await seedBatchRun(w2, { identities: 1, adapter: 'evil' });
  const o2 = await w2.engine.handleBatchJob(jobFor(r2[0], w2));
  assert.equal(o2.outcome, 'failed-final');
  assert.equal((await w2.taskSvc.loadRun(r2[0].id)).errorCode, 'ADAPTER_NOT_ALLOWED');
  // Registry surface is honest.
  assert.equal(w2.adapterRegistry.isAllowed('noop'), true);
  assert.equal(w2.adapterRegistry.isAllowed('evil'), false);
  await assert.rejects(
    () => w2.adapterRegistry.run('evil', {}),
    (e) => e instanceof AdapterError && e.apiCode === 'ADAPTER_NOT_ALLOWED',
  );
});

test('engine: LIVE adapter spec object {type:"noop"} executes (regression — API stores the full spec object in inputJson.adapter; the registry is keyed by the type string)', async () => {
  const w = makeEngineWorld();
  // Exact live shape: createCycle → createAndDispatch stores configJson.adapter
  // verbatim (an object), unlike the string seam used by other tests.
  const { batch, identities, runs } = await seedBatchRun(w, { identities: 1, adapter: { type: 'noop' } });
  const run = runs[0];
  assert.deepEqual(run.inputJson.adapter, { type: 'noop' }, 'harness preserved the live object shape');
  const outcome = await w.engine.handleBatchJob(jobFor(run, w));
  assert.equal(outcome.outcome, 'succeeded');
  const after = await w.taskSvc.loadRun(run.id);
  assert.equal(after.status, 'succeeded');
  assert.equal(after.errorCode, null);
  assert.equal((await w.db.identity.findUnique({ where: { id: identities[0].id } })).status, 'COMPLETED');
  await w.scheduler.tick();
  assert.equal((await w.db.batch.findUnique({ where: { id: batch.id } })).status, 'COMPLETED');
});

test('inspect seam: object spec → sideEffects=false (noop); malformed non-empty spec → sideEffects=true (fail-closed, MD §6.2)', async () => {
  const w = makeEngineWorld();
  const inspect = makeInspectEffects(w.adapterRegistry);
  // Live spec object (the shape the scheduler sees from the DB).
  const ok = await inspect({ inputJson: { adapter: { type: 'noop', durationMs: 50 } } });
  assert.equal(ok.sideEffects, false, 'noop spec object must report no side effects (auto re-run path)');
  // Non-empty but unrecognizable spec — must NOT be treated as "nothing ran".
  const bad = await inspect({ inputJson: { adapter: { type: 42 } } });
  assert.equal(bad.sideEffects, true, 'malformed spec must stay conservative (isolate, no auto re-run)');
  const arr = await inspect({ inputJson: { adapter: ['noop'] } });
  assert.equal(arr.sideEffects, true);
  // Genuinely unconfigured (null) keeps the legacy semantic: nothing ran.
  const none = await inspect({ inputJson: {} });
  assert.equal(none.sideEffects, false);
});

test('engine: executor-lost retry — RETRY_WAIT identity is re-reserved before claim (REGRESSION: G8 live smoke, kill -9 → retry succeeded but identity stuck in RETRY_WAIT, batch never completed)', async () => {
  const w = makeEngineWorld();
  const { batch, identities, runs } = await seedBatchRun(w, { identities: 1, maxAttempts: 3 });
  const run = runs[0];
  const identity = identities[0];

  // Simulate an executor that died mid-run: run row 'running', identity
  // RUNNING, and a lease already expired — exactly what reconcile sees.
  await w.db.taskRun.update({ where: { id: run.id }, data: { status: 'running', startedAt: new Date('2026-10-21T00:00:05Z') } });
  await w.db.identity.update({ where: { id: identity.id }, data: { status: 'RUNNING' } });
  const { acquired, lease } = await w.leaseSvc.acquireSlot({ totalSlots: 2, ownerRunId: run.id, ttlMs: 60_000 });
  assert.equal(acquired, true);
  w.setClock(61_000); // lease now expired

  // Reconciliation: side-effect-free (noop) → honest terminal + RETRY_WAIT +
  // auto-retry (attempt 2 re-queued).
  const res = await w.scheduler.reconcileExpiredLeases();
  assert.equal(res.retried, 1);
  assert.equal(res.errors.length, 0);
  let after = await w.taskSvc.loadRun(run.id);
  assert.equal(after.status, 'queued');
  assert.equal(after.attempt, 2);
  assert.equal((await w.db.identity.findUnique({ where: { id: identity.id } })).status, 'RETRY_WAIT');
  const job = w.queue.jobs.get(batchJobId(run.id, 2));
  assert.ok(job, 'attempt-2 job re-dispatched to the queue');

  // The surviving executor consumes the retry. Before the fix, the claim
  // threw ILLEGAL_IDENTITY_TRANSITION (RETRY_WAIT→RUNNING is not a legal
  // edge), the divergence catch let the run proceed on a stale identity,
  // the success sync no-opped (fires only from RUNNING), and the batch
  // never completed. Now: RETRY_WAIT→RESERVED→RUNNING→COMPLETED.
  const outcome = await w.engine.handleBatchJob(job);
  assert.equal(outcome.outcome, 'succeeded');
  after = await w.taskSvc.loadRun(run.id);
  assert.equal(after.status, 'succeeded');
  assert.equal(after.attempt, 2);
  assert.equal((await w.db.identity.findUnique({ where: { id: identity.id } })).status, 'COMPLETED');

  // The re-reservation is visible in the honest event stream (2 hops).
  const idEvents = await w.db.stateEvent.findMany({ where: { entityType: 'identity', entityId: identity.id }, orderBy: { createdAt: 'asc' } });
  const hops = idEvents.map((e) => e.toState);
  assert.ok(hops.includes('RESERVED'), `re-reserve hop recorded (hops: ${hops.join('→')})`);
  assert.ok(hops.includes('COMPLETED'));

  // And the batch actually completes (the whole point).
  await w.scheduler.tick();
  assert.equal((await w.db.batch.findUnique({ where: { id: batch.id } })).status, 'COMPLETED');
});
