/**
 * BR-B1 — LeaseService unit tests (施工 MD §9.6 + §14.1 lease 競爭):
 *   - fresh acquire / HELD / idempotent re-acquire (RENEWED)
 *   - expired takeover is a single CAS — winner vs loser
 *   - renew: owner-only, live-only (expired ≠ renewable)
 *   - release: owner-only + idempotent
 *   - reconciliation scan + callback error containment
 *   - slot pool (MD §3.1 global concurrency)
 *   - validation + the P2002 race-retry path
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createLeaseService, BatchError } from '@water-army/shared';
import { makeBatchFakeDb } from '../helpers/batch-fakes.js';

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const T0 = Date.parse('2026-10-21T04:00:00Z');

function makeCtx({ leases = [], ttlMs = 5 * 60_000 } = {}) {
  let t = T0;
  const clock = { now: () => new Date(t), advance: (ms) => { t += ms; } };
  const db = makeBatchFakeDb({ leases, clock: clock.now });
  const svc = createLeaseService({ db, now: clock.now, ttlMs });
  return { db, svc, clock };
}

const OWNER_A = '11111111-2222-4333-8444-555555555555';
const OWNER_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('fresh acquire → ACQUIRED; a different owner → HELD (lease object surfaces the holder)', async () => {
  const { svc } = makeCtx();
  const a = await svc.acquire({ resourceType: 'container_slot', resourceKey: 'slot-0', ownerRunId: OWNER_A });
  assert.equal(a.acquired, true);
  assert.equal(a.reason, 'ACQUIRED');
  assert.ok(a.lease.leaseExpiresAt.getTime() > T0);

  const b = await svc.acquire({ resourceType: 'container_slot', resourceKey: 'slot-0', ownerRunId: OWNER_B });
  assert.equal(b.acquired, false);
  assert.equal(b.reason, 'HELD');
  assert.equal(b.lease.ownerRunId, OWNER_A, 'caller sees WHO holds it');
});

test('same owner re-acquires a LIVE lease → RENEWED (idempotent, no second row)', async () => {
  const { db, svc } = makeCtx();
  await svc.acquire({ resourceType: 'identity', resourceKey: 'dev-1', ownerRunId: OWNER_A });
  const again = await svc.acquire({ resourceType: 'identity', resourceKey: 'dev-1', ownerRunId: OWNER_A });
  assert.equal(again.acquired, true);
  assert.equal(again.reason, 'RENEWED');
  assert.equal(db.__state.leases.size, 1, 'still exactly one lease row');
});

test('expired lease → EXPIRED_TAKEOVER: owner + expiry atomically replaced', async () => {
  const { db, svc, clock } = makeCtx();
  await svc.acquire({ resourceType: 'container_slot', resourceKey: 'slot-0', ownerRunId: OWNER_A, ttlMs: 60_000 });
  clock.advance(61_000); // past expiry
  const res = await svc.acquire({ resourceType: 'container_slot', resourceKey: 'slot-0', ownerRunId: OWNER_B, ttlMs: 120_000 });
  assert.equal(res.acquired, true);
  assert.equal(res.reason, 'EXPIRED_TAKEOVER');
  const row = await db.resourceLease.findUnique({ where: { resourceType_resourceKey: { resourceType: 'container_slot', resourceKey: 'slot-0' } } });
  assert.equal(row.ownerRunId, OWNER_B);
  assert.equal(row.leaseExpiresAt.getTime(), T0 + 61_000 + 120_000, 'expiry recomputed from the takeover moment');
});

test('MD §14.1 lease 競爭: two takeovers of the same expired lease — exactly one wins; the loser gets RACE_LOST/HELD, never a double grant', async () => {
  const { db, svc, clock } = makeCtx();
  await svc.acquire({ resourceType: 'host_port', resourceKey: '9001', ownerRunId: OWNER_A, ttlMs: 60_000 });
  clock.advance(61_000);

  // Deterministic "both read the expired row, both fire the CAS" — the fake
  // runs them sequentially, which is the SAME statement-level race Postgres
  // sees: only the first UPDATE can match lease_expires_at <= now.
  const [r1, r2] = await Promise.all([
    svc.acquire({ resourceType: 'host_port', resourceKey: '9001', ownerRunId: OWNER_B, ttlMs: 120_000 }),
    svc.acquire({ resourceType: 'host_port', resourceKey: '9001', ownerRunId: 'cccccccc-dddd-4eee-8fff-000000000000', ttlMs: 120_000 }),
  ]);
  const winners = [r1, r2].filter((r) => r.acquired);
  const losers = [r1, r2].filter((r) => !r.acquired);
  assert.equal(winners.length, 1, 'exactly one takeover wins');
  assert.equal(losers.length, 1);
  assert.ok(['RACE_LOST', 'HELD'].includes(losers[0].reason));
  assert.equal(winners[0].reason, 'EXPIRED_TAKEOVER');
  const rows = await db.resourceLease.findMany({ where: { resourceType: 'host_port' } });
  assert.equal(rows.length, 1, 'one row, no duplicate lease');
});

test('RACE_LOST branch: the CAS matches 0 rows (a faster writer already took it)', async () => {
  // Force the losing side: the underlying updateMany matches nothing while
  // the row exists (a faster process moved the expiry between read and CAS).
  const base = makeCtx();
  const realUpdateMany = base.db.resourceLease.updateMany.bind(base.db.resourceLease);
  base.db.resourceLease.updateMany = async ({ where, data }) =>
    where.leaseExpiresAt?.lte !== undefined
      ? { count: 0 } // we lose the CAS
      : realUpdateMany({ where, data });
  const svc = createLeaseService({ db: base.db, now: base.clock.now, ttlMs: 60_000 });
  await base.svc.acquire({ resourceType: 'x', resourceKey: 'k', ownerRunId: OWNER_A, ttlMs: 60_000 });
  base.clock.advance(61_000);
  const res = await svc.acquire({ resourceType: 'x', resourceKey: 'k', ownerRunId: OWNER_B });
  assert.equal(res.acquired, false);
  assert.equal(res.reason, 'RACE_LOST');
});

test('P2002 on create (concurrent insert beat us) → re-read + honest verdict, no crash, no duplicate', async () => {
  const base = makeCtx();
  const realCreate = base.db.resourceLease.create.bind(base.db.resourceLease);
  let first = true;
  base.db.resourceLease.create = async ({ data }) => {
    if (first) {
      first = false;
      // Simulate the concurrent winner committing just before our INSERT.
      await realCreate({ data: { ...data, ownerRunId: OWNER_B } });
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }
    return realCreate({ data });
  };
  const svc = createLeaseService({ db: base.db, now: base.clock.now, ttlMs: 60_000 });
  const res = await svc.acquire({ resourceType: 'p', resourceKey: 'k', ownerRunId: OWNER_A });
  assert.equal(res.acquired, false);
  assert.equal(res.reason, 'HELD', 're-read shows the other owner holds it');
  assert.equal(res.lease.ownerRunId, OWNER_B);
  assert.equal(base.db.__state.leases.size, 1);
});

test('renew: owner + live → extended; non-owner → NOT_OWNER; expired → EXPIRED (NEVER blindly renewed)', async () => {
  const { db, svc, clock } = makeCtx();
  await svc.acquire({ resourceType: 'identity', resourceKey: 'dev-9', ownerRunId: OWNER_A, ttlMs: 60_000 });

  clock.advance(10_000);
  const ok = await svc.renew({ resourceType: 'identity', resourceKey: 'dev-9', ownerRunId: OWNER_A, ttlMs: 60_000 });
  assert.equal(ok.renewed, true);
  assert.equal(ok.lease.leaseExpiresAt.getTime(), T0 + 10_000 + 60_000);

  const foreign = await svc.renew({ resourceType: 'identity', resourceKey: 'dev-9', ownerRunId: OWNER_B });
  assert.equal(foreign.renewed, false);
  assert.equal(foreign.reason, 'NOT_OWNER');

  // Let it expire, then the owner comes back: renew must REFUSE — the MD
  // §6.2 rule (expired lease → reconciliation decides, never blind re-run).
  clock.advance(120_000);
  const stale = await svc.renew({ resourceType: 'identity', resourceKey: 'dev-9', ownerRunId: OWNER_A });
  assert.equal(stale.renewed, false);
  assert.equal(stale.reason, 'EXPIRED');
  const row = await db.resourceLease.findUnique({ where: { resourceType_resourceKey: { resourceType: 'identity', resourceKey: 'dev-9' } } });
  assert.equal(row.ownerRunId, OWNER_A, 'refused renew did not touch ownership');
});

test('renew: GONE when the lease was released; non-uuid owner → INVALID_LEASE', async () => {
  const { svc } = makeCtx();
  await svc.acquire({ resourceType: 'identity', resourceKey: 'dev-10', ownerRunId: OWNER_A });
  await svc.release({ resourceType: 'identity', resourceKey: 'dev-10', ownerRunId: OWNER_A });
  const gone = await svc.renew({ resourceType: 'identity', resourceKey: 'dev-10', ownerRunId: OWNER_A });
  assert.equal(gone.renewed, false);
  assert.equal(gone.reason, 'GONE');
  await assert.rejects(
    () => svc.renew({ resourceType: 'identity', resourceKey: 'dev-10', ownerRunId: 'not-a-uuid' }),
    (e) => e instanceof BatchError && e.apiCode === 'INVALID_LEASE',
  );
});

test('release: owner-only — a foreign release NEVER frees the holder; owner release is idempotent', async () => {
  const { db, svc } = makeCtx();
  await svc.acquire({ resourceType: 'container_slot', resourceKey: 'slot-3', ownerRunId: OWNER_A });
  const foreign = await svc.release({ resourceType: 'container_slot', resourceKey: 'slot-3', ownerRunId: OWNER_B });
  assert.equal(foreign.released, false);
  assert.ok(await db.resourceLease.findUnique({ where: { resourceType_resourceKey: { resourceType: 'container_slot', resourceKey: 'slot-3' } } }), 'still held');

  const mine = await svc.release({ resourceType: 'container_slot', resourceKey: 'slot-3', ownerRunId: OWNER_A });
  assert.equal(mine.released, true);
  const again = await svc.release({ resourceType: 'container_slot', resourceKey: 'slot-3', ownerRunId: OWNER_A });
  assert.equal(again.released, false, 'idempotent finally-block contract');
  assert.equal(again.count, 0);
});

test('listExpired: only expired rows, ascending by expiry (the reconciliation input)', async () => {
  const { svc, clock } = makeCtx();
  await svc.acquire({ resourceType: 's', resourceKey: 'a', ttlMs: 10_000 }); // expires T0+10k
  clock.advance(5_000); // T0+5k
  await svc.acquire({ resourceType: 's', resourceKey: 'b', ttlMs: 10_000 }); // expires T0+15k
  clock.advance(5_000); // T0+10k
  await svc.acquire({ resourceType: 's', resourceKey: 'c', ttlMs: 10_000 }); // expires T0+20k
  clock.advance(9_000); // T0+19k → a, b expired; c still 1s live (boundary-safe)
  const expired = await svc.listExpired();
  assert.deepEqual(expired.map((l) => l.resourceKey), ['a', 'b'], 'ascending, c not yet expired');
});

test('reconcile: onExpired called per expired lease; callback errors are contained, not thrown', async () => {
  const { svc, clock } = makeCtx();
  await svc.acquire({ resourceType: 's', resourceKey: 'a', ttlMs: 10_000 });
  await svc.acquire({ resourceType: 's', resourceKey: 'b', ttlMs: 10_000 });
  await svc.acquire({ resourceType: 's', resourceKey: 'live', ttlMs: 60_000 });
  clock.advance(11_000);
  const seen = [];
  const res = await svc.reconcile({
    onExpired: async (lease) => {
      seen.push(lease.resourceKey);
      if (lease.resourceKey === 'b') throw new Error('boom');
    },
  });
  assert.deepEqual(seen.sort(), ['a', 'b']);
  assert.equal(res.scanned, 2);
  assert.equal(res.handled, 1);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].resourceKey, 'b');
  assert.match(res.errors[0].error, /boom/);
});

test('reconcile without a callback → INVALID_LEASE (the policy is the CALLER’s)', async () => {
  const { svc } = makeCtx();
  await assert.rejects(() => svc.reconcile({}), (e) => e.apiCode === 'INVALID_LEASE');
});

test('activeCount: live leases of a type only (the MD §3.1 capacity read)', async () => {
  const { svc, clock } = makeCtx();
  await svc.acquire({ resourceType: 'container_slot', resourceKey: 'slot-0', ownerRunId: OWNER_A, ttlMs: 10_000 });
  await svc.acquire({ resourceType: 'container_slot', resourceKey: 'slot-1', ownerRunId: OWNER_B, ttlMs: 60_000 });
  await svc.acquire({ resourceType: 'identity', resourceKey: 'dev-1', ownerRunId: OWNER_A, ttlMs: 60_000 });
  assert.equal(await svc.activeCount({ resourceType: 'container_slot' }), 2);
  clock.advance(11_000);
  assert.equal(await svc.activeCount({ resourceType: 'container_slot' }), 1, 'the expired slot dropped out');
});

test('acquireSlot: fills sequentially to capacity; full pool → NO_SLOT; expiry frees a slot', async () => {
  const { svc, clock } = makeCtx();
  const a1 = await svc.acquireSlot({ totalSlots: 2, ownerRunId: OWNER_A });
  const a2 = await svc.acquireSlot({ totalSlots: 2, ownerRunId: OWNER_B });
  assert.equal(a1.acquired, true);
  assert.equal(a2.acquired, true);
  assert.deepEqual([a1.slot, a2.slot].sort(), [0, 1]);
  const a3 = await svc.acquireSlot({ totalSlots: 2, ownerRunId: 'cccccccc-dddd-4eee-8fff-000000000000' });
  assert.equal(a3.acquired, false);
  assert.equal(a3.reason, 'NO_SLOT', 'both slots held');
  clock.advance(6 * 60_000 + 1_000); // default ttl (5m) expired
  const reuse = await svc.acquireSlot({ totalSlots: 2, ownerRunId: OWNER_B });
  assert.equal(reuse.acquired, true, 'expired slots are reusable');
});

test('validation: bad resourceType/resourceKey/owner shapes → INVALID_LEASE (400)', async () => {
  const { svc } = makeCtx();
  await assert.rejects(() => svc.acquire({ resourceType: '', resourceKey: 'k' }), (e) => e.apiCode === 'INVALID_LEASE');
  await assert.rejects(() => svc.acquire({ resourceType: 'x'.repeat(65), resourceKey: 'k' }), (e) => e.apiCode === 'INVALID_LEASE');
  await assert.rejects(() => svc.acquire({ resourceType: 'x', resourceKey: '' }), (e) => e.apiCode === 'INVALID_LEASE');
  await assert.rejects(() => svc.acquire({ resourceType: 'x', resourceKey: 'k', ownerRunId: 'nope' }), (e) => e.apiCode === 'INVALID_LEASE');
  await assert.rejects(() => svc.acquireSlot({ totalSlots: 0 }), (e) => e.apiCode === 'INVALID_LEASE');
  await assert.rejects(() => svc.acquireSlot({ totalSlots: 1.5 }), (e) => e.apiCode === 'INVALID_LEASE');
});

test('missing db delegate → TypeError at construction (fail fast, not at first call)', () => {
  assert.throws(() => createLeaseService({ db: {} }), TypeError);
  assert.throws(() => createLeaseService({}), TypeError);
});
