/**
 * BR-B1 — cycle idempotency (施工 MD §10/§12.3 + §14.1 冪等):
 *   - a redelivered idempotencyKey replays the ORIGINAL cycle (same cycle id,
 *     same batch ids) — no second cycle, no double binding, no new events
 *   - a DIFFERENT key creates a fresh, independent cycle
 *   - missing/invalid idempotencyKey → 400 (never a silent non-idempotent run)
 *   - the strict write path refuses unknown identities (preview may not)
 *   - createCycle is transactional: a mid-cycle failure leaves NO partial
 *     batches (fake $transaction rolls back the in-memory writes)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createBatchService, BatchError } from '@water-army/shared';
import { makeBatchFakeDb } from '../helpers/batch-fakes.js';

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const NOW = () => new Date('2026-10-21T04:00:00Z');

function makeCtx() {
  const db = makeBatchFakeDb({ clock: NOW });
  const svc = createBatchService({ db, log: SILENT, now: NOW });
  return { db, svc };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function seedN(ctx, n, prefix = 'ident') {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const { identity } = await ctx.svc.createIdentity({ displayName: `${prefix}-${i}`, identityType: 'qa_device' });
    ids.push(identity.id);
  }
  return ids;
}

const cycleInput = (ids, over = {}) => ({
  name: 'BR smoke cycle',
  idempotencyKey: 'br-smoke-cycle-0001',
  batchSize: 50,
  maxActiveContainers: 50,
  failurePolicy: 'continue_and_report',
  identities: ids.map((id) => ({ id })),
  ...over,
});

test('12 identities / 50 → one batch; a redelivered key replays the ORIGINAL cycle (MD §12.3)', async () => {
  const ctx = makeCtx();
  const ids = await seedN(ctx, 12);
  const first = await ctx.svc.createCycle(cycleInput(ids), { id: 'u1', username: 'admin' });
  assert.equal(first.replay, false);
  assert.equal(first.batches.length, 1);
  const firstBatchId = first.batches[0].id;
  const eventsAfterCreate = (await ctx.db.stateEvent.findMany({})).length;

  // The redelivery (duplicate POST, retry, double-click):
  const replay = await ctx.svc.createCycle(cycleInput(ids), { id: 'u1', username: 'admin' });
  assert.equal(replay.replay, true);
  assert.equal(replay.cycleId, first.cycleId, 'same cycle');
  assert.equal(replay.batches.length, 1);
  assert.equal(replay.batches[0].id, firstBatchId, 'same batch row — no second copy');

  // NOTHING new was written:
  assert.equal(ctx.db.__state.batches.size, 1, 'no second batch');
  assert.equal(ctx.db.__state.batchIdentities.length, 12, 'no double binding');
  assert.equal((await ctx.db.stateEvent.findMany({})).length, eventsAfterCreate, 'no new state events on replay');
});

test('replay is LIVE: it reports the CURRENT status of the original batches', async () => {
  const ctx = makeCtx();
  const ids = await seedN(ctx, 5);
  const first = await ctx.svc.createCycle(cycleInput(ids));
  await ctx.svc.transitionBatch(first.batches[0].id, 'RUNNING');
  const replay = await ctx.svc.createCycle(cycleInput(ids));
  assert.equal(replay.replay, true);
  assert.equal(replay.batches[0].status, 'RUNNING', 'replay reflects live state, not a snapshot');
});

test('a DIFFERENT idempotency key creates a fresh independent cycle (both coexist)', async () => {
  const ctx = makeCtx();
  const ids = await seedN(ctx, 6);
  const a = await ctx.svc.createCycle(cycleInput(ids, { idempotencyKey: 'br-key-A-0001' }));
  const b = await ctx.svc.createCycle(cycleInput(ids, { idempotencyKey: 'br-key-B-0002' }));
  assert.notEqual(a.cycleId, b.cycleId);
  assert.notEqual(a.batches[0].id, b.batches[0].id, 'independent batch rows');
  assert.equal(ctx.db.__state.batches.size, 2);
  // same identities may belong to two cycles over TIME (different positions fine)
  assert.equal(ctx.db.__state.batchIdentities.length, 12);
});

test('missing / invalid idempotencyKey → 400 VALIDATION_ERROR (no silent non-idempotent create)', async () => {
  const ctx = makeCtx();
  const ids = await seedN(ctx, 2);
  await assert.rejects(
    () => ctx.svc.createCycle(cycleInput(ids, { idempotencyKey: undefined })),
    (e) => e instanceof BatchError && e.apiCode === 'VALIDATION_ERROR' && /idempotencyKey/.test(e.message),
  );
  await assert.rejects(
    () => ctx.svc.createCycle(cycleInput(ids, { idempotencyKey: 'short' })),
    (e) => e.apiCode === 'VALIDATION_ERROR',
  );
  await assert.rejects(
    () => ctx.svc.createCycle(cycleInput(ids, { idempotencyKey: 'bad key with spaces!!' })),
    (e) => e.apiCode === 'VALIDATION_ERROR',
  );
  assert.equal(ctx.db.__state.batches.size, 0, 'nothing persisted on invalid input');
});

test('invalid capacity input is refused BEFORE any write (MD §3.1)', async () => {
  const ctx = makeCtx();
  const ids = await seedN(ctx, 2);
  await assert.rejects(
    () => ctx.svc.createCycle(cycleInput(ids, { maxActiveContainers: 0 })),
    (e) => e.apiCode === 'VALIDATION_ERROR' && /maxActiveContainers/.test(e.message),
  );
  assert.equal(ctx.db.__state.batches.size, 0);
});

test('strict write path: an unknown identity in the plan → 400, nothing persisted (preview would tolerate it)', async () => {
  const ctx = makeCtx();
  const ids = await seedN(ctx, 3);
  const ghost = '99999999-8888-4777-8666-555544443333';
  const eventsBefore = (await ctx.db.stateEvent.findMany({})).length;
  await assert.rejects(
    () => ctx.svc.createCycle(cycleInput([...ids, ghost])),
    (e) => e.apiCode === 'VALIDATION_ERROR' && /Unknown identities/.test(e.message) && ghost.slice(0, 8) !== undefined,
  );
  assert.equal(ctx.db.__state.batches.size, 0, 'no partial batches');
  assert.equal((await ctx.db.stateEvent.findMany({})).length, eventsBefore, 'no partial events');
});

test('disabled identity → SKIPPED membership is persisted with its skip reason (position gapless, others bound)', async () => {
  const ctx = makeCtx();
  const ids = await seedN(ctx, 3);
  // disable the middle identity before planning
  await ctx.svc.transitionIdentity(ids[1], 'DISABLED', { reason: 'burned' });
  // B2 passes the DB-read status with each identity (the planner is pure):
  const res = await ctx.svc.createCycle(cycleInput(ids, {
    identities: ids.map((id, i) => ({ id, status: i === 1 ? 'DISABLED' : 'READY' })),
  }));
  assert.equal(res.replay, false);
  const memberships = await ctx.db.batchIdentity.findMany({ where: { batchId: res.batches[0].id } });
  assert.equal(memberships.length, 3);
  const byPos = new Map(memberships.map((m) => [m.position, m]));
  assert.equal(byPos.get(1).status, 'PENDING');
  assert.equal(byPos.get(2).status, 'SKIPPED');
  assert.match(byPos.get(2).skipReason, /disabled/i);
  assert.equal(byPos.get(3).status, 'PENDING');
  assert.equal(byPos.get(2).identityId, ids[1], 'skipped identity keeps its slot');
});

test('large plan: 120 identities / 50 → 3 batches, memberships = 120, positions gapless per batch', async () => {
  const ctx = makeCtx();
  const ids = await seedN(ctx, 120);
  const res = await ctx.svc.createCycle(cycleInput(ids));
  assert.equal(res.batches.length, 3);
  assert.deepEqual(res.batches.map((b) => b.batchNo), [1, 2, 3]);
  assert.equal(ctx.db.__state.batchIdentities.length, 120);
  for (const [i, b] of res.batches.entries()) {
    const ms = await ctx.db.batchIdentity.findMany({ where: { batchId: b.id } });
    const want = i === 2 ? 20 : 50;
    assert.equal(ms.length, want);
    assert.deepEqual(ms.map((m) => m.position), Array.from({ length: want }, (_, k) => k + 1));
    assert.equal(ms[0].identityId, ids[i * 50], 'input order = binding order');
  }
  // the idempotency key lives exactly on batch_no = 1
  const keyed = [...ctx.db.__state.batches.values()].filter((b) => b.idempotencyKey != null);
  assert.equal(keyed.length, 1);
  assert.equal(keyed[0].batchNo, 1);
});

test('mid-cycle failure → nothing persisted (the transaction contract, MD §10)', async () => {
  const ctx = makeCtx();
  const ids = await seedN(ctx, 4);
  const realCreate = ctx.db.batchIdentity.create.bind(ctx.db.batchIdentity);
  let calls = 0;
  ctx.db.batchIdentity.create = async (args) => {
    calls += 1;
    if (calls === 3) throw new Error('simulated connection drop');
    return realCreate(args);
  };
  await assert.rejects(() => ctx.svc.createCycle(cycleInput(ids)), /simulated connection drop/);
  // Hermetic rollback: the fake $transaction snapshots its maps, so a
  // throw must leave the pre-transaction state (batches + memberships gone).
  assert.equal(ctx.db.__state.batches.size, 0, 'no partial batches after rollback');
  assert.equal(ctx.db.__state.batchIdentities.length, 0, 'no partial memberships after rollback');
});

test('the idempotency key format allows the B2-generated shapes (uuid + hyphen/underscore tokens)', async () => {
  const ctx = makeCtx();
  const ids = await seedN(ctx, 2);
  for (const key of ['cycle-2026-10-21-ab12cd', 'AB_C-12345678', 'deadbeefcafe1234']) {
    const res = await ctx.svc.createCycle(cycleInput(ids, { idempotencyKey: key }));
    assert.equal(res.replay, false, key);
  }
  assert.equal(ctx.db.__state.batches.size, 3);
});
