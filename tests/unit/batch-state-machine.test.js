/**
 * BR-B1 — central state machines (施工 MD §6.1/§6.2 + §14.1):
 *   - every LEGAL edge of the identity + batch transition tables works
 *   - every ILLEGAL edge is rejected (409) AND leaves a rejected state_event
 *   - compare-and-set: a concurrently-changed row is never silently overwritten
 *   - MD §3.3 completion rules (stop_batch vs continue_and_report)
 *   - MD §14.1: the same identity never holds two active runs
 *   - identity create: registry types, credential-shaped metadata refused,
 *     duplicate data_path refused (MD §9.1/§4.1)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBatchService,
  IDENTITY_STATUS,
  IDENTITY_TRANSITIONS,
  BATCH_STATUS,
  BATCH_TRANSITIONS,
  BatchError,
  IDENTITY_TYPE_REGISTRY,
} from '@water-army/shared';
import { makeBatchFakeDb } from '../helpers/batch-fakes.js';

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const uuid = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

function makeCtx({ identities = [], batches = [], taskRuns = [] } = {}) {
  const db = makeBatchFakeDb({ identities, batches, taskRuns, clock: () => new Date('2026-10-21T04:00:00Z') });
  const svc = createBatchService({ db, log: SILENT, now: () => new Date('2026-10-21T04:00:00Z') });
  return { db, svc };
}

function seedIdentity(n, status = 'READY') {
  return {
    id: uuid(n),
    externalRef: `qa-${n}`,
    displayName: `identity ${n}`,
    identityType: 'qa_device',
    status,
    dataPath: `/data/water_army/identities/${uuid(n)}/data`,
    metadataJson: {},
  };
}

// ------------------------------------------------------------------ legal edges
test('identity FSM: every legal edge in the transition table succeeds', async () => {
  const { db, svc } = makeCtx();
  const seen = new Set();
  for (const [from, targets] of Object.entries(IDENTITY_TRANSITIONS)) {
    for (const to of targets) {
      const id = uuid(9);
      const row = seedIdentity(9, from);
      db.__state.identities.set(id, { ...row });
      const updated = await svc.transitionIdentity(id, to, { reason: 'walk', actor: 'tester' });
      assert.equal(updated.status, to, `${from} → ${to}`);
      seen.add(`${from}->${to}`);
    }
  }
  const expected = Object.entries(IDENTITY_TRANSITIONS).flatMap(([f, ts]) => ts.map((t) => `${f}->${t}`));
  assert.deepEqual([...seen].sort(), expected.sort());

  // every successful edge wrote exactly one state_event with from→to
  const events = await db.stateEvent.findMany({ where: { entityType: 'identity', entityId: uuid(9) } });
  assert.equal(events.length, expected.length);
  for (const e of events) {
    assert.ok(e.fromState !== null, `birth events carry fromState null only for create`);
    assert.ok(IDENTITY_STATUS.includes(e.toState));
  }
});

test('batch FSM: every legal edge in the transition table succeeds; started/finished timestamps maintained', async () => {
  const { db, svc } = makeCtx();
  for (const [from, targets] of Object.entries(BATCH_TRANSITIONS)) {
    for (const to of targets) {
      const id = uuid(3);
      const row = {
        id,
        name: `b #1 (${from})`,
        cycleId: `cycle-${from}-${to}`,
        batchNo: 1,
        status: from,
        batchSize: 1,
        maxActiveContainers: 1,
        failurePolicy: 'stop_batch',
        configJson: {},
        startedAt: from === 'RUNNING' || from === 'PAUSED' ? new Date('2026-10-21T03:00:00Z') : null,
      };
      db.__state.batches.set(id, { ...row });
      const updated = await svc.transitionBatch(id, to, { reason: 'walk' });
      assert.equal(updated.status, to, `batch ${from} → ${to}`);
      const live = await db.batch.findUnique({ where: { id } });
      if (to === 'RUNNING') assert.ok(live.startedAt instanceof Date, 'startedAt set on →RUNNING');
      if (['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED'].includes(to)) {
        assert.ok(live.finishedAt instanceof Date, `finishedAt set on terminal ${to}`);
      }
    }
  }
});

// ------------------------------------------------------------------ illegal edges
test('illegal identity transitions are rejected with 409 AND a rejected event is written', async () => {
  const { db, svc } = makeCtx();
  const id = uuid(1);
  db.__state.identities.set(id, seedIdentity(1, 'COMPLETED'));

  for (const attempt of ['RUNNING', 'RESERVED', 'DISABLED', 'SKIPPED']) {
    await assert.rejects(
      () => svc.transitionIdentity(id, attempt, { reason: 'try', actor: 'u1' }),
      (err) => err instanceof BatchError && err.apiCode === 'ILLEGAL_IDENTITY_TRANSITION' && err.statusCode === 409,
    );
  }
  const events = await db.stateEvent.findMany({ where: { entityType: 'identity', entityId: id } });
  assert.equal(events.length, 4, 'one rejected event per attempt');
  for (const e of events) {
    assert.equal(e.toState, 'COMPLETED', 'rejected events keep the LIVE state as toState');
    assert.equal(e.detailsJson.rejected, true);
    assert.ok(e.detailsJson.attemptedTo, 'attempted target recorded');
  }
  // state itself is untouched
  const live = await db.identity.findUnique({ where: { id } });
  assert.equal(live.status, 'COMPLETED');
});

test('illegal batch transitions rejected (PLANNED cannot skip to COMPLETED; terminals are closed)', async () => {
  const { db, svc } = makeCtx();
  const id = uuid(2);
  db.__state.batches.set(id, {
    id, name: 'b', cycleId: 'c', batchNo: 1, status: 'PLANNED',
    batchSize: 1, maxActiveContainers: 1, failurePolicy: 'stop_batch', configJson: {},
  });
  await assert.rejects(
    () => svc.transitionBatch(id, 'COMPLETED'),
    (err) => err.apiCode === 'ILLEGAL_BATCH_TRANSITION' && err.statusCode === 409,
  );
  db.__state.batches.get(id).status = 'COMPLETED';
  await assert.rejects(
    () => svc.transitionBatch(id, 'RUNNING'),
    (err) => err.apiCode === 'ILLEGAL_BATCH_TRANSITION',
  );
  // unknown state name → 400 (not a transition error)
  await assert.rejects(
    () => svc.transitionIdentity(id, 'EXPLODED', {}),
    (err) => err.apiCode === 'UNKNOWN_STATE',
  );
});

test('compare-and-set: a concurrently changed row is never silently overwritten', async () => {
  const { db, svc } = makeCtx();
  const id = uuid(4);
  db.__state.identities.set(id, seedIdentity(4, 'READY'));

  // Simulate the race: between our read and our CAS, another writer moves
  // READY → RESERVED (e.g. a second scheduler process).
  const p1 = svc.transitionIdentity(id, 'RESERVED', { reason: 'writer A' });
  const p2 = svc.transitionIdentity(id, 'CANCELLED', { reason: 'writer B' });
  const results = await Promise.allSettled([p1, p2]);
  const wins = results.filter((r) => r.status === 'fulfilled');
  const losses = results.filter((r) => r.status === 'rejected');
  assert.equal(wins.length, 1, 'exactly one writer wins the CAS');
  assert.equal(losses.length, 1);
  assert.match(losses[0].reason.message, /changed concurrently/);
  assert.equal(losses[0].reason.apiCode, 'ILLEGAL_IDENTITY_TRANSITION');
  // no event for the loser's SUCCESS path; final state = winner's target
  const live = await db.identity.findUnique({ where: { id } });
  assert.ok(['RESERVED', 'CANCELLED'].includes(live.status));
});

test('missing identity / batch → 404 codes', async () => {
  const { svc } = makeCtx();
  await assert.rejects(() => svc.transitionIdentity('00000000-0000-4000-8000-000000000099', 'RESERVED'), (e) => e.apiCode === 'IDENTITY_NOT_FOUND' && e.statusCode === 404);
  await assert.rejects(() => svc.transitionBatch('00000000-0000-4000-8000-000000000099', 'RUNNING'), (e) => e.apiCode === 'BATCH_NOT_FOUND' && e.statusCode === 404);
});

// ------------------------------------------------------------------ completion
function seedCycle({ ctx, failurePolicy = 'continue_and_report', statuses = [] } = {}) {
  const { db } = ctx;
  const cycleId = '00000000-0000-4000-8000-00000000c001';
  const batchId = uuid(50);
  db.__state.batches.set(batchId, {
    id: batchId, name: 'cycle #1', cycleId, batchNo: 1, status: 'RUNNING',
    batchSize: statuses.length, maxActiveContainers: 50, failurePolicy, configJson: {},
    idempotencyKey: null, createdBy: null, createdAt: new Date(),
    startedAt: new Date('2026-10-21T03:00:00Z'), finishedAt: null,
  });
  statuses.forEach((status, i) => {
    const identity = seedIdentity(100 + i, status);
    db.__state.identities.set(identity.id, identity);
    db.__state.batchIdentities.push({
      batchId, identityId: identity.id, position: i + 1,
      status: status === 'FAILED_FINAL' ? 'FAILED_FINAL' : status === 'SKIPPED' ? 'SKIPPED' : 'ACTIVE',
      createdAt: new Date(),
    });
  });
  return { cycleId, batchId, identities: statuses.map((_, i) => uuid(100 + i)) };
}

test('MD §3.3: batch stays incomplete while any identity is non-terminal', async () => {
  const ctx = makeCtx();
  const { batchId } = seedCycle({ ctx, statuses: ['COMPLETED', 'COMPLETED', 'RUNNING'] });
  const res = await ctx.svc.evaluateBatchCompletion(batchId);
  assert.deepEqual(res, { complete: false, status: 'RUNNING', pending: 1, failedFinal: 0, skipped: 0 });
  const live = await ctx.db.batch.findUnique({ where: { id: batchId } });
  assert.equal(live.status, 'RUNNING', 'no transition while pending');
});

test('MD §3.3: all terminal, no failures → COMPLETED (skipped counts as terminal)', async () => {
  const ctx = makeCtx();
  const { batchId } = seedCycle({ ctx, statuses: ['COMPLETED', 'SKIPPED', 'COMPLETED'] });
  const res = await ctx.svc.evaluateBatchCompletion(batchId);
  assert.deepEqual(res, { complete: true, status: 'COMPLETED', failedFinal: 0, skipped: 1, pending: 0 });
  const live = await ctx.db.batch.findUnique({ where: { id: batchId } });
  assert.ok(live.finishedAt instanceof Date);
});

test('MD §3.3: FAILED_FINAL + stop_batch → PAUSED (human judgement), not completed', async () => {
  const ctx = makeCtx();
  const { batchId } = seedCycle({ ctx, failurePolicy: 'stop_batch', statuses: ['COMPLETED', 'FAILED_FINAL'] });
  const res = await ctx.svc.evaluateBatchCompletion(batchId, { actor: 'scheduler' });
  assert.equal(res.complete, false);
  assert.equal(res.status, 'PAUSED');
  assert.equal(res.paused, true);
  const live = await ctx.db.batch.findUnique({ where: { id: batchId } });
  assert.equal(live.status, 'PAUSED');
  assert.equal(live.finishedAt, null, 'paused is NOT a terminal — no finishedAt');
});

test('MD §3.3: FAILED_FINAL + continue_and_report → COMPLETED_WITH_ERRORS (never plain COMPLETED)', async () => {
  const ctx = makeCtx();
  const { batchId } = seedCycle({ ctx, failurePolicy: 'continue_and_report', statuses: ['COMPLETED', 'FAILED_FINAL', 'SKIPPED'] });
  const res = await ctx.svc.evaluateBatchCompletion(batchId);
  assert.equal(res.complete, true);
  assert.equal(res.status, 'COMPLETED_WITH_ERRORS');
  assert.equal(res.failedFinal, 1);
});

test('completion is idempotent: re-evaluating a terminal batch is a no-op', async () => {
  const ctx = makeCtx();
  const { batchId } = seedCycle({ ctx, statuses: ['COMPLETED'] });
  await ctx.svc.evaluateBatchCompletion(batchId);
  const again = await ctx.svc.evaluateBatchCompletion(batchId);
  assert.equal(again.complete, true);
  const events = await ctx.db.stateEvent.findMany({ where: { entityType: 'batch', entityId: batchId } });
  assert.equal(events.length, 1, 'exactly one completion event (RUNNING→COMPLETED)');
});

test('PLANNED batch is never auto-completed (it was never started)', async () => {
  const ctx = makeCtx();
  const { batchId } = seedCycle({ ctx, statuses: ['COMPLETED'] });
  ctx.db.__state.batches.get(batchId).status = 'PLANNED';
  const res = await ctx.svc.evaluateBatchCompletion(batchId);
  assert.equal(res.complete, false);
  assert.equal(res.status, 'PLANNED');
});

// ------------------------------------------------------------------ reservation
test('MD §14.1: reserveIdentityForRun — READY + no active run → RESERVED (with event + runId detail)', async () => {
  const ctx = makeCtx();
  const id = uuid(11);
  dbSet(ctx, id);
  const runId = uuid(12);
  const res = await ctx.svc.reserveIdentityForRun({ identityId: id, runId, actor: 'scheduler' });
  assert.equal(res.status, 'RESERVED');
  const events = await ctx.db.stateEvent.findMany({ where: { entityType: 'identity', entityId: id } });
  assert.equal(events[0].detailsJson.runId, runId);
});

function dbSet(ctx, id, status = 'READY') {
  ctx.db.__state.identities.set(id, seedIdentity(Number(id.slice(-2)) || 11, status));
}

test('MD §14.1: the same identity never holds two active runs — second reservation 409 ACTIVE_RUN_EXISTS + rejected event', async () => {
  const ctx = makeCtx({ taskRuns: [{ id: uuid(21), identityId: uuid(13), status: 'running' }] });
  const id = uuid(13);
  dbSet(ctx, id);
  await assert.rejects(
    () => ctx.svc.reserveIdentityForRun({ identityId: id, runId: uuid(22), actor: 'scheduler' }),
    (e) => e.apiCode === 'ACTIVE_RUN_EXISTS' && e.statusCode === 409,
  );
  const live = await ctx.db.identity.findUnique({ where: { id } });
  assert.equal(live.status, 'READY', 'identity untouched by the failed reservation');
  const events = await ctx.db.stateEvent.findMany({ where: { entityType: 'identity', entityId: id } });
  assert.equal(events.length, 1);
  assert.equal(events[0].detailsJson.rejected, true);
  assert.equal(events[0].detailsJson.activeRunId, uuid(21));
});

test('reservation requires READY (a DISABLED identity 409s IDENTITY_NOT_READY)', async () => {
  const ctx = makeCtx();
  const id = uuid(14);
  dbSet(ctx, id, 'DISABLED');
  await assert.rejects(
    () => ctx.svc.reserveIdentityForRun({ identityId: id, runId: uuid(23) }),
    (e) => e.apiCode === 'IDENTITY_NOT_READY',
  );
});

test('queued sibling run also blocks reservation (identity exclusivity is stricter than the engine concurrency gate)', async () => {
  const ctx = makeCtx({ taskRuns: [{ id: uuid(24), identityId: uuid(15), status: 'queued' }] });
  const id = uuid(15);
  dbSet(ctx, id);
  await assert.rejects(() => ctx.svc.reserveIdentityForRun({ identityId: id, runId: uuid(25) }), (e) => e.apiCode === 'ACTIVE_RUN_EXISTS');
});

// ------------------------------------------------------------------ identity create
test('createIdentity: registry type enforced; default dataPath derived from uuid', async () => {
  const { db, svc } = makeCtx();
  const { identity } = await svc.createIdentity(
    { displayName: 'qa device 1', identityType: 'qa_device', externalRef: 'qa-001' },
    { id: 'user-1', username: 'admin' },
  );
  assert.equal(identity.status, 'READY');
  assert.equal(identity.dataPath, `/data/water_army/identities/${identity.id}/data`);
  assert.equal(identity.externalRef, 'qa-001');
  const events = await db.stateEvent.findMany({ where: { entityType: 'identity', entityId: identity.id } });
  assert.equal(events.length, 1);
  assert.equal(events[0].fromState, null, 'birth event');
  assert.equal(events[0].toState, 'READY');
});

test('createIdentity: unknown identityType refused (MD §9.1 registry)', async () => {
  const { svc } = makeCtx();
  await assert.rejects(
    () => svc.createIdentity({ displayName: 'x', identityType: 'production_customer' }),
    (e) => e.apiCode === 'VALIDATION_ERROR' && /registry/.test(e.message),
  );
  for (const t of IDENTITY_TYPE_REGISTRY) {
    await assert.doesNotReject(() => createBatchService({ db: makeBatchFakeDb(), log: SILENT }).createIdentity({ displayName: `ok ${t}`, identityType: t }));
  }
});

test('createIdentity: credential-shaped metadata keys are refused at the boundary (MD §9.1)', async () => {
  const { svc } = makeCtx();
  for (const key of ['password', 'access_token', 'sessionCookie', 'api_key', 'proxySecret']) {
    await assert.rejects(
      () => svc.createIdentity({ displayName: 'x', identityType: 'qa_device', metadata: { [key]: 'hunter2' } }),
      (e) => e.apiCode === 'VALIDATION_ERROR' && /credential-shaped/.test(e.message),
      `key '${key}' must be refused`,
    );
  }
  // benign metadata passes and is stored
  const { identity } = await svc.createIdentity({ displayName: 'x', identityType: 'qa_device', metadata: { deviceClass: 'mid-range', build: '15.0.0' } });
  assert.deepEqual(identity.metadataJson, { deviceClass: 'mid-range', build: '15.0.0' });
});

test('createIdentity: duplicate data_path refused (MD §4.1 — no two identities share a writable path)', async () => {
  const { db, svc } = makeCtx();
  const shared = '/data/water_army/identities/deadbeef-0000-4000-8000-000000000001/data';
  await svc.createIdentity({ displayName: 'first', identityType: 'qa_device', dataPath: shared });
  await assert.rejects(
    () => svc.createIdentity({ displayName: 'second', identityType: 'qa_device', dataPath: shared }),
    (e) => e.apiCode === 'IDENTITY_CONFLICT' && e.statusCode === 409,
  );
  // duplicate externalRef also refused
  const a = await svc.createIdentity({ displayName: 'a', identityType: 'qa_device', externalRef: 'dup-1' });
  await assert.rejects(
    () => svc.createIdentity({ displayName: 'b', identityType: 'qa_device', externalRef: 'dup-1' }),
    (e) => e.apiCode === 'IDENTITY_CONFLICT',
  );
  void a;
});

test('createIdentity: caller-supplied dataPath must stay inside the canonical root', async () => {
  const { svc } = makeCtx();
  await assert.rejects(
    () => svc.createIdentity({ displayName: 'evil', identityType: 'qa_device', dataPath: '/data/water_army/identities/../../etc/passwd' }),
    (e) => e.apiCode === 'INVALID_DATA_PATH',
  );
  await assert.rejects(
    () => svc.createIdentity({ displayName: 'side', identityType: 'qa_device', dataPath: '/data/water_army/other/x' }),
    (e) => e.apiCode === 'INVALID_DATA_PATH',
  );
});
