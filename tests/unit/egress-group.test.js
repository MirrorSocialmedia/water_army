/**
 * WA-IPGROUP 鐵律 2 — egress-group serialisation + random stagger (錯峰).
 * Hermetic: fake db / fake queue / simulated engine (zero real devices,
 * zero external DB). Time assertions are exact — the stagger draw is
 * deterministic (deterministicJitterMs), so "no overlap" and "gap >= draw"
 * are checkable without wall-clock luck.
 *
 * Coverage map (work order §回歸矩陣):
 *  1. group derivation (label > identity_egress IP > singleton)
 *  2. stagger window AppSetting handling (default/override/swap/invalid)
 *  3. deterministic uniform draw (range, determinism, distribution)
 *  4. gate: busy / jitter_wait / free (incl. excludeRunId self-exclusion)
 *  5. scheduler matrix: N members one group → strict serial, zero overlap,
 *     gaps ≥ draw; cross-group + singleton unaffected (parallel)
 *  6. engine hard gate: HELD lease → group-deferred (holds NOTHING),
 *     bounded defers → honest BLOCKED_EGRESS_GROUP, success releases lease
 *  7. lease helpers + expired-lease reconciliation sweep
 *  8. egressGroupStatus observability (queue depth + next-eligible estimate)
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
  EGRESS_GROUP_LEASE_TYPE,
  APP_SETTING_EGRESS_GROUP_JITTER_MS,
  EGRESS_GROUP_JITTER_DEFAULTS,
  egressGroupLabelFromMetadata,
  egressGroupKeyFor,
  isSingletonGroupKey,
  readEgressGroupJitter,
  deterministicJitterMs,
  evaluateEgressGroupGate,
  acquireGroupLease,
  releaseGroupLease,
  renewGroupLease,
  egressGroupStatus,
} from '@water-army/shared';
import { makeBatchFakeDb } from '../helpers/batch-fakes.js';
import { makeFakeQueue } from '../helpers/fakes.js';
import { createBatchEngine, makeInspectEffects } from '../../apps/worker/src/batch-engine.js';
import { createAdapterRegistry } from '../../apps/worker/src/adapter-registry.js';

// ------------------------------------------------------------------ harness
// Anchor: the B1 services stamp real wall-clock (new Date()) onto run rows;
// the fake clock therefore starts at NOW so injected `now` and service
// stamps live on the same timeline (advances stay exact relative to both).
function makeClock(start = new Date()) {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance: (ms) => { t += ms; },
    // Re-anchor to real time when a test needs to absorb the lag between
    // the fake clock and the (real-stamped) service timestamps.
    sync: () => { t = Math.max(t, Date.now()); },
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

/** Fake db + real B1 services + fake queue + scheduler (+ engine on demand). */
function makeWorld({ schedulerConfig = {}, engineConfig = {} } = {}) {
  const clock = makeClock();
  const db = makeBatchFakeDb({ clock: clock.now });
  const { out, log } = makeLogs();
  const queue = makeFakeQueue();
  const taskSvc = createTaskRunService({
    db, log,
    config: { taskDefaultTimeoutMs: 60_000, taskDefaultAttempts: 3 },
    enqueue: async ({ runId, attempt }) => enqueueAnyRun(queue, { db, runId, attempt, timeoutMs: 60_000 }),
  });
  const batchSvc = createBatchService({ db, log, now: clock.now });
  const leaseSvc = createLeaseService({ db, now: clock.now });
  const adapterRegistry = createAdapterRegistry({ env: { NOOP_DURATION_MS: '20' }, log });
  const scheduler = createBatchScheduler({
    db, batchSvc, leaseSvc, taskSvc, queue, log, now: clock.now,
    inspectEffects: makeInspectEffects(adapterRegistry),
    config: { slotTtlMs: 60_000, ...schedulerConfig },
  });
  const engine = createBatchEngine({
    db, taskSvc, batchSvc, leaseSvc, scheduler, adapterRegistry, networkGate: null, log, now: clock.now,
    config: {
      batchHeartbeatMs: 1000, batchCancelPollMs: 250, batchSlotWaitMs: 1000, batchSlotTtlMs: 60_000,
      batchMaxSlotDefers: 3, batchDefaultTimeoutMs: 60_000, batchGroupWaitMs: 1000, batchMaxGroupDefers: 2,
      ...engineConfig,
    },
  });
  return { clock, db, out, log, queue, taskSvc, batchSvc, leaseSvc, scheduler, engine, adapterRegistry };
}

let seq = 0;
async function seedIdentity(db, { metadata = null, status = 'READY' } = {}) {
  seq += 1;
  return db.identity.create({
    data: {
      email: `eg${seq}@example.com`,
      username: `eg${seq}`,
      status,
      ...(metadata ? { metadataJson: metadata } : {}),
    },
  });
}

/** Cycle over identities; each entry: { label } sets metadataJson.egressGroup. */
async function seedGroupCycle(world, { identities, maxActiveContainers = 2 }) {
  const ids = [];
  for (const it of identities) ids.push(await seedIdentity(world.db, { metadata: it?.label ? { egressGroup: it.label } : null }));
  seq += 1;
  const res = await world.batchSvc.createCycle(
    {
      name: `eg-cycle-${seq}`,
      idempotencyKey: `eg-cycle-${Math.random().toString(36).slice(2, 10)}`,
      identities: ids.map((i) => ({ id: i.id })),
      batchSize: ids.length,
      maxActiveContainers,
      failurePolicy: 'continue_and_report',
      config: { adapter: { type: 'noop' }, timeoutSeconds: 30, maxAttempts: 3, interBatchCooldownSeconds: 0 },
    },
    { id: 'tester' },
  );
  const batches = await world.db.batch.findMany({ where: { cycleId: res.cycleId }, orderBy: { batchNo: 'asc' } });
  return { cycleId: res.cycleId, identities: ids, batches };
}

/** Set the stagger window (AppSetting) — degenerate {m,m} for exact tests. */
async function setJitter(db, minMs, maxMs) {
  await db.appSetting.upsert({
    where: { key: APP_SETTING_EGRESS_GROUP_JITTER_MS },
    create: { key: APP_SETTING_EGRESS_GROUP_JITTER_MS, valueJson: { value: { minMs, maxMs } }, updatedBy: 'test' },
    update: { valueJson: { value: { minMs, maxMs } } },
  });
}

async function claim(world, run) {
  const res = await world.taskSvc.startAttempt(run.id, run.attempt);
  assert.equal(res.status, 'started', `claim should start (got ${res.status}: ${res.reason})`);
  // The B1 services stamp real wall-clock; re-stamp with the TEST clock so
  // the overlap/gap assertions live entirely on the controlled timeline.
  await world.db.taskRun.update({ where: { id: run.id }, data: { startedAt: world.clock.now() } });
  const id = await world.db.identity.findUnique({ where: { id: run.identityId } });
  if (id && (id.status === 'RESERVED' || id.status === 'RETRY_WAIT')) {
    await world.batchSvc.transitionIdentity(run.identityId, 'RUNNING', { reason: 'engine claim (test mimic)', actor: 'worker:test', correlationId: run.batchId ?? null });
  }
  return res.run;
}
async function finish(world, runId, { status, errorCode = null, errorMessage = null, attempt }) {
  const before = await world.taskSvc.loadRun(runId);
  await world.taskSvc.finishRun(runId, { status, errorCode, errorMessage, attempt: attempt ?? before.attempt });
  const after = await world.taskSvc.loadRun(runId);
  // Re-stamp the terminal with the TEST clock (see claim): the stagger math
  // must be fully deterministic against the injected `now`.
  await world.db.taskRun.update({ where: { id: runId }, data: { finishedAt: world.clock.now() } });
  const stamped = await world.taskSvc.loadRun(runId);
  await world.scheduler.syncIdentityAfterRunTerminal(stamped, { actor: 'worker:test' });
  return stamped;
}
const runsOf = async (world, batchId) =>
  (await world.db.taskRun.findMany({ where: { batchId } })).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
const queuedOf = async (world, batchId) => (await runsOf(world, batchId)).filter((r) => r.status === 'queued');

const jobFor = (run, extra = {}) => ({
  id: `job-${run.id}-${run.attempt}`,
  name: BATCH_RUN_JOB_NAME,
  data: { runId: run.id, attempt: run.attempt, timeoutMs: 60_000, maxAttempts: run.maxAttempts, ...extra },
  state: 'active',
  async moveToDelayed(ms) { this.state = 'delayed'; this.delayedMs = ms; },
});

// ================================================================ 1. derivation
test('egress: label derivation — explicit wins, normalised, invalid ignored', () => {
  assert.equal(egressGroupLabelFromMetadata({ egressGroup: ' HK-Exit-1 ' }), 'grp:hk-exit-1');
  assert.equal(egressGroupLabelFromMetadata({ egressGroup: 'A.B_c-9' }), 'grp:a.b_c-9');
  assert.equal(egressGroupLabelFromMetadata({ egressGroup: 'bad label!' }), null);
  assert.equal(egressGroupLabelFromMetadata({ egressGroup: '' }), null);
  assert.equal(egressGroupLabelFromMetadata({ egressGroup: 42 }), null);
  assert.equal(egressGroupLabelFromMetadata(null), null);
});

test('egress: group key resolution — label > identity_egress IP > singleton', () => {
  assert.equal(egressGroupKeyFor({ id: 'i1', metadataJson: { egressGroup: 'gA' } }, { expectedEgressIp: '1.2.3.4' }), 'grp:ga');
  assert.equal(egressGroupKeyFor({ id: 'i1', metadataJson: {} }, { expectedEgressIp: '1.2.3.4' }), 'ip:1.2.3.4');
  assert.equal(egressGroupKeyFor({ id: 'i1', metadataJson: null }, null), 'identity:i1');
  assert.ok(isSingletonGroupKey('identity:i1'));
  assert.ok(!isSingletonGroupKey('ip:1.2.3.4'));
  assert.ok(!isSingletonGroupKey('grp:ga'));
});

// ================================================================ 2. stagger window
test('egress: jitter window — defaults, AppSetting override, min>max swap, invalid fails safe', async () => {
  const w = makeWorld();
  assert.deepEqual(await readEgressGroupJitter(w.db), { ...EGRESS_GROUP_JITTER_DEFAULTS, source: 'default' });
  await setJitter(w.db, 5_000, 9_000);
  assert.deepEqual(await readEgressGroupJitter(w.db), { minMs: 5_000, maxMs: 9_000, source: 'appsetting' });
  await setJitter(w.db, 9_000, 5_000); // admin typo: swapped honestly, still honoured
  assert.deepEqual(await readEgressGroupJitter(w.db), { minMs: 5_000, maxMs: 9_000, source: 'appsetting' });
  await setJitter(w.db, 1, 'x'); // invalid shape → defaults (never blocks dispatch)
  assert.equal((await readEgressGroupJitter(w.db)).source, 'default');
  await w.db.appSetting.update({ where: { key: APP_SETTING_EGRESS_GROUP_JITTER_MS }, data: { valueJson: { value: { minMs: 0, maxMs: 999_999_999_999 } } } });
  assert.equal((await readEgressGroupJitter(w.db)).source, 'default'); // out of bounds → defaults
});

// ================================================================ 3. draw
test('egress: deterministic uniform draw — range, determinism, spread', () => {
  const lo = 60_000; const hi = 300_000;
  const seen = new Set();
  for (let i = 0; i < 400; i += 1) {
    const v = deterministicJitterMs('grp:stat', `prev-run-${i}`, lo, hi);
    assert.ok(Number.isInteger(v) && v >= lo && v <= hi, `draw ${v} out of [${lo},${hi}]`);
    seen.add(v);
  }
  assert.ok(seen.size > 200, `expected spread across the window, saw ${seen.size} distinct draws`);
  // Determinism: same inputs → same draw (multi-replica stateless convergence).
  assert.equal(deterministicJitterMs('grp:stat', 'run-x', lo, hi), deterministicJitterMs('grp:stat', 'run-x', lo, hi));
  // Degenerate window (min==max) → exact value (used by the matrix tests).
  assert.equal(deterministicJitterMs('grp:stat', 'run-x', 7, 7), 7);
});

// ================================================================ 4. gate semantics
test('egress: gate — group_busy beats stagger; excludeRunId self-exclusion; jitter_wait carries estimate', async () => {
  const w = makeWorld();
  const a = await seedIdentity(w.db, { metadata: { egressGroup: 'g1' } });
  await seedIdentity(w.db, { metadata: { egressGroup: 'g1' } });
  await setJitter(w.db, 60_000, 60_000);

  const free = await evaluateEgressGroupGate({ db: w.db, groupKey: 'grp:g1', now: w.clock.now });
  assert.equal(free.allowed, true);
  assert.equal(free.reason, 'free');
  assert.equal(free.memberCount, 2, 'member scan finds both labelled identities');

  // A queued run of A blocks the group; that SAME run never blocks itself.
  const runA = await w.db.taskRun.create({ data: { identityId: a.id, status: 'queued', attempt: 0, queuedAt: w.clock.now() } });
  const busy = await evaluateEgressGroupGate({ db: w.db, groupKey: 'grp:g1', now: w.clock.now });
  assert.equal(busy.allowed, false);
  assert.equal(busy.reason, 'group_busy');
  assert.equal(busy.activeRunId, runA.id);
  const self = await evaluateEgressGroupGate({ db: w.db, groupKey: 'grp:g1', now: w.clock.now, excludeRunId: runA.id });
  assert.equal(self.allowed, true, 'own queued run must not block own claim');

  // Terminal → jitter_wait with the exact next-eligible estimate, then free.
  const finAt = w.clock.now().getTime();
  await w.db.taskRun.update({ where: { id: runA.id }, data: { status: 'succeeded', finishedAt: new Date(finAt) } });
  const gate = await evaluateEgressGroupGate({ db: w.db, groupKey: 'grp:g1', now: w.clock.now });
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, 'jitter_wait');
  assert.equal(deterministicJitterMs('grp:g1', runA.id, 60_000, 60_000), 60_000);
  assert.equal(new Date(gate.nextEligibleAt).getTime(), finAt + 60_000);
  w.clock.advance(60_000); // exactly at the deadline → eligible (>= boundary)
  assert.equal((await evaluateEgressGroupGate({ db: w.db, groupKey: 'grp:g1', now: w.clock.now })).allowed, true);
});

// ================================================================ 5. scheduler matrix
test('egress matrix: 4 members / 1 group → strict serial, ZERO overlap, gaps = draw (60s)', async () => {
  const w = makeWorld();
  await setJitter(w.db, 60_000, 60_000); // degenerate uniform → exact math
  const { batches, identities } = await seedGroupCycle(w, {
    identities: [{ label: 'g1' }, { label: 'g1' }, { label: 'g1' }, { label: 'g1' }],
    maxActiveContainers: 4, // slot pool is NOT the constraint — only the group gate serialises
  });
  const batch = batches[0];

  const res = await w.scheduler.startBatch({ batchId: batch.id, actor: 'tester' });
  assert.equal(res.dispatched, 1, 'exactly ONE group member dispatches on the first pass');
  assert.equal(res.groupDeferred.length, 3, 'the other three defer honestly (memberships stay PENDING)');
  assert.ok(res.groupDeferred.every((d) => d.groupKey === 'grp:g1' && d.reason === 'group_busy'));
  assert.equal((await queuedOf(w, batch.id)).length, 1, 'only the winner has a queued run');

  // Walk the serial schedule: claim → succeed → advance past the stagger →
  // tick dispatches exactly the next member. 4 runs, strict serial.
  const finishedRuns = [];
  for (let round = 1; round <= 4; round += 1) {
    const queued = await queuedOf(w, batch.id);
    assert.equal(queued.length, 1, `round ${round}: exactly one queued run (serial)`);
    const claimed = await claim(w, queued[0]);
    finishedRuns.push(await finish(w, claimed.id, { status: 'succeeded' }));
    await w.scheduler.tick(); // same instant: stagger NOT elapsed → nothing new
    assert.equal((await queuedOf(w, batch.id)).length, 0, `round ${round}: no dispatch inside the stagger window`);
    w.clock.advance(61_000); // past the draw (60s) with service-lag margin
    await w.scheduler.tick();
  }

  // ZERO-OVERLAP + gap matrix (模擬時間斷言): intervals strictly disjoint,
  // every gap ≥ the deterministic draw from the previous terminal.
  const spans = finishedRuns.map((r) => ({ start: new Date(r.startedAt).getTime(), end: new Date(r.finishedAt).getTime() })).sort((a, b) => a.start - b.start);
  assert.equal(spans.length, 4);
  for (let i = 1; i < spans.length; i += 1) {
    assert.ok(spans[i].start >= spans[i - 1].end, `overlap between run ${i - 1} and ${i}`);
    assert.ok(spans[i].start - spans[i - 1].end >= 60_000, `gap ${spans[i].start - spans[i - 1].end}ms below the 60s floor`);
  }
  const all = await runsOf(w, batch.id);
  assert.equal(all.length, 4);
  assert.ok(all.every((r) => r.status === 'succeeded'), 'whole group walks to success');
  const members = await w.db.batchIdentity.findMany({ where: { batchId: batch.id } });
  assert.ok(members.every((m) => m.status === 'COMPLETED'), 'memberships all terminal-COMPLETED');
  void identities;
});

test('egress matrix: cross-group + singleton run in PARALLEL (只限同組串行)', async () => {
  const w = makeWorld();
  await setJitter(w.db, 60_000, 60_000);
  const { batches } = await seedGroupCycle(w, {
    identities: [{ label: 'g1' }, { label: 'g1' }, { label: 'g2' }, { label: 'g2' }, {}],
    maxActiveContainers: 5,
  });
  const batch = batches[0];
  const res = await w.scheduler.startBatch({ batchId: batch.id, actor: 'tester' });
  // One per group (g1, g2) + the unlabelled singleton = 3 parallel dispatches;
  // only same-group members defer (2).
  assert.equal(res.dispatched, 3, 'two groups + singleton dispatch together');
  assert.equal(res.groupDeferred.length, 2, 'only same-group rivals defer');
  assert.ok(res.groupDeferred.every((d) => d.groupKey === 'grp:g1' || d.groupKey === 'grp:g2'));
  // A second group's terminal must NOT stagger the first group's next run.
  const queued = await queuedOf(w, batch.id);
  assert.equal(queued.length, 3);
  const g1run = queued.find((r) => true); // finish whichever one; the OTHER group's queued run must stay dispatchable
  await claim(w, g1run);
  await finish(w, g1run.id, { status: 'succeeded' });
  await w.scheduler.tick();
  const stillQueued = await queuedOf(w, batch.id);
  assert.equal(stillQueued.length, 2, 'other group + singleton unaffected by g1 terminal/stagger');
});

// ================================================================ 6. engine hard gate
test('egress engine: HELD group lease → group-deferred holding NOTHING; bounded defers → honest BLOCKED_EGRESS_GROUP; then success releases the lease', async () => {
  const w = makeWorld({ engineConfig: { batchGroupWaitMs: 1000, batchMaxGroupDefers: 2 } });
  await setJitter(w.db, 0, 0); // stagger off — this test is about the LEASE, not the window
  const { batches } = await seedGroupCycle(w, { identities: [{ label: 'g1' }], maxActiveContainers: 2 });
  const batch = batches[0];
  await w.scheduler.startBatch({ batchId: batch.id, actor: 'tester' });
  const run = (await queuedOf(w, batch.id))[0];
  assert.ok(run, 'run dispatched (soft gate saw no active run)');

  // A foreign delivery holds the group exclusion lease (phantom owner).
  const phantom = 'f1f1f1f1-1111-4111-8111-111111111111';
  const acq = await acquireGroupLease(w.leaseSvc, { groupKey: 'grp:g1', runId: phantom, ttlMs: 60_000 });
  assert.equal(acq.acquired, true);

  const job = jobFor(run);
  const d1 = await w.engine.handleBatchJob(job);
  assert.equal(d1.outcome, 'group-deferred');
  assert.equal(d1.reason, 'lease_held');
  assert.equal(job.state, 'delayed');
  assert.equal((await w.taskSvc.loadRun(run.id)).status, 'queued', 'run untouched while deferred');
  const held = await w.db.resourceLease.findMany({});
  assert.equal(held.filter((l) => l.ownerRunId === run.id).length, 0, 'a deferred delivery holds NOTHING (slot handed back too)');

  // Bounded defers then HONEST exhaustion (never an infinite spin).
  const d2 = await w.engine.handleBatchJob(job);
  assert.equal(d2.outcome, 'group-deferred');
  const d3 = await w.engine.handleBatchJob(job);
  assert.equal(d3.outcome, 'group-exhausted');
  const failed = await w.taskSvc.loadRun(run.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'BLOCKED_EGRESS_GROUP');

  // Foreign holder clears → manual retry path re-dispatches and SUCCEEDS,
  // and the terminal releases the group lease (count back to zero).
  await releaseGroupLease(w.leaseSvc, { groupKey: 'grp:g1', runId: phantom });
  w.clock.sync(); // absorb service-stamp lag against the {0,0} stagger
  await w.batchSvc.transitionIdentity(run.identityId, 'RESERVED', { reason: 'manual retry (test)', actor: 'tester' });
  await w.taskSvc.requestRetry(run.id, { actorUserId: 'tester' });
  const run2 = await w.taskSvc.loadRun(run.id);
  assert.equal(run2.status, 'queued');
  const ok = await w.engine.handleBatchJob(jobFor(run2, {}));
  assert.equal(ok.outcome, 'succeeded', `engine run should succeed on the free group (got ${JSON.stringify(ok)})`);
  const leftover = await w.db.resourceLease.findMany({});
  assert.equal(leftover.filter((l) => l.resourceType === EGRESS_GROUP_LEASE_TYPE).length, 0, 'group lease released on terminal');
});

// ================================================================ 7. lease helpers + sweep
test('egress lease: acquire/renew/release CAS semantics (same owner renews, foreign cannot touch)', async () => {
  const w = makeWorld();
  const runA = 'a1a1a1a1-2222-4222-8222-222222222222'; const runB = 'b2b2b2b2-3333-4333-8333-333333333333';
  const g = 'grp:lease-x';
  const a1 = await acquireGroupLease(w.leaseSvc, { groupKey: g, runId: runA, ttlMs: 60_000 });
  assert.equal(a1.acquired, true);
  const again = await acquireGroupLease(w.leaseSvc, { groupKey: g, runId: runA, ttlMs: 60_000 });
  assert.equal(again.acquired, true, 'same owner is idempotent (duplicate delivery)');
  const b1 = await acquireGroupLease(w.leaseSvc, { groupKey: g, runId: runB, ttlMs: 60_000 });
  assert.equal(b1.acquired, false, 'foreign owner cannot share the exit');
  assert.equal((await renewGroupLease(w.leaseSvc, { groupKey: g, runId: runB, ttlMs: 60_000 })).renewed, false);
  assert.equal((await renewGroupLease(w.leaseSvc, { groupKey: g, runId: runA, ttlMs: 60_000 })).renewed, true);
  assert.equal((await releaseGroupLease(w.leaseSvc, { groupKey: g, runId: runB })).released ?? false, false, 'foreign release must not free the lease');
  assert.equal((await releaseGroupLease(w.leaseSvc, { groupKey: g, runId: runA })).released, true);
  assert.equal((await acquireGroupLease(w.leaseSvc, { groupKey: g, runId: runB, ttlMs: 60_000 })).acquired, true, 'released → next owner in');
});

test('egress reconcile: expired group lease of a TERMINAL run is swept; a LIVE owner is renewed, never stolen', async () => {
  const w = makeWorld();
  await setJitter(w.db, 1, 1);
  const { batches } = await seedGroupCycle(w, { identities: [{ label: 'gsw' }], maxActiveContainers: 2 });
  await w.scheduler.startBatch({ batchId: batches[0].id, actor: 'tester' });
  const dead = (await queuedOf(w, batches[0].id))[0];
  await claim(w, dead);
  await finish(w, dead.id, { status: 'succeeded' });

  // Lease owned by that now-TERMINAL run, expired (crash-shaped residue).
  const l1 = await acquireGroupLease(w.leaseSvc, { groupKey: 'grp:gsw', runId: dead.id, ttlMs: 1_000 });
  assert.equal(l1.acquired, true);
  // Plus a live-owner lease (running run) that must be RENEWED not released.
  const b2 = await seedGroupCycle(w, { identities: [{ label: 'glive' }], maxActiveContainers: 2 });
  await w.scheduler.startBatch({ batchId: b2.batches[0].id, actor: 'tester' });
  const live = (await queuedOf(w, b2.batches[0].id))[0];
  await claim(w, live);
  await acquireGroupLease(w.leaseSvc, { groupKey: 'grp:glive', runId: live.id, ttlMs: 1_000 });

  w.clock.advance(2_000); // both expired
  const summary = await w.scheduler.reconcileExpiredLeases();
  assert.ok(summary.groupLeasesReleased >= 1, `terminal-owner group lease swept (summary: ${JSON.stringify(summary)})`);
  assert.ok(summary.groupLeasesRenewed >= 1, 'live-owner group lease renewed (no silent takeover)');
  const rows = await w.db.resourceLease.findMany({});
  assert.equal(rows.filter((l) => l.resourceType === EGRESS_GROUP_LEASE_TYPE && l.resourceKey === 'grp:gsw').length, 0);
  assert.equal(rows.filter((l) => l.resourceType === EGRESS_GROUP_LEASE_TYPE && l.resourceKey === 'grp:glive').length, 1);
});

// ================================================================ 8. observability
test('egress status: queue depth + next-eligible estimate per group (secret-free)', async () => {
  const w = makeWorld();
  await setJitter(w.db, 60_000, 60_000);
  const { batches } = await seedGroupCycle(w, {
    identities: [{ label: 'gobs' }, { label: 'gobs' }, { label: 'gobs' }],
    maxActiveContainers: 3,
  });
  await w.scheduler.startBatch({ batchId: batches[0].id, actor: 'tester' });
  const run = (await queuedOf(w, batches[0].id))[0];
  await claim(w, run); // the exit is now BUSY (running)
  let status = await egressGroupStatus(w.db, { now: w.clock.now });
  const g = status.find((s) => s.groupKey === 'grp:gobs');
  assert.ok(g, 'group present in status');
  assert.ok(g.activeRunId, 'active run surfaced');
  assert.equal(g.activeRunStatus, 'running');
  assert.equal(g.pendingMemberCount, 2, 'two members still waiting for the exit');
  assert.equal(g.memberIds.length, 3);
  assert.ok(!status.some((s) => s.groupKey.startsWith('identity:')), 'singletons are not status noise');

  const done = await finish(w, run.id, { status: 'succeeded' });
  status = await egressGroupStatus(w.db, { now: w.clock.now });
  const g2 = status.find((s) => s.groupKey === 'grp:gobs');
  assert.equal(g2.activeRunId, null);
  assert.equal(new Date(g2.nextEligibleAt).getTime(), new Date(done.finishedAt).getTime() + deterministicJitterMs('grp:gobs', done.id, 60_000, 60_000), 'next-eligible estimate = last terminal + draw');
  assert.deepEqual(g2.jitterWindowMs, { minMs: 60_000, maxMs: 60_000 });
  // Secret-free: JSON payload carries only keys/ids (labels/IPs/uuids).
  assert.ok(!JSON.stringify(status).includes('password'), 'status payload secret-free by construction');
});
