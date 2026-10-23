/**
 * MC P1 — StreamLeaseService unit tests (Mobile Console MD §4.1/§8.1/§10/§11/§15):
 *   - RBAC per mode (viewer vs controller), device existence + runnability
 *   - 6-way concurrent slot race → exactly maxStreams win, fixed 409 code
 *   - two managers on the LAST slot → exactly one wins
 *   - per-device single active lease (partial-unique race: exactly one winner)
 *   - heartbeat: owner/admin only, server time, version CAS, expired ≠ renewable
 *   - close: idempotent, slot released exactly once, owner/admin only
 *   - expiry sweep: version-guarded reap (a renewed lease survives)
 *   - API-restart reconcile: ACTIVE → INTERRUPTED + slots released
 *   - ticket: HMAC binding (user/device/lease/mode), TTL, single-use replay
 *   - MAX_CONCURRENT_DEVICE_STREAMS: default 5 / cap 5 / invalid → fail-safe 5
 *
 * Determinism: injectable clock + a Prisma-shaped fake db. The fake enforces
 * the SAME statement-level guarantees as the real schema (partial unique
 * index, unique [resource_type, resource_key]) — a sequential fake sees the
 * same winner/loser split Postgres produces under a true concurrent race.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createLeaseService } from '@water-army/shared';
import { makeBatchFakeDb } from '../helpers/batch-fakes.js';
import { createStreamLeaseService } from '../../apps/api/src/services/stream-lease-service.js';

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const T0 = Date.parse('2026-10-23T03:00:00Z');
const SECRET = 'unit-test-stream-ticket-secret-32b!';

const USER_VIEWER = { id: '11111111-1111-4111-8111-111111111111', role: 'viewer' };
const USER_OP = { id: '22222222-2222-4222-8222-222222222222', role: 'operator' };
const USER_ADMIN = { id: '33333333-3333-4333-8333-333333333333', role: 'admin' };
const DEV = (n) => `d0000000-0000-4000-8000-00000000000${n}`;

function makeCtx({ devices = 6, maxStreamsRaw = '', ttlMs = 30_000, secret = SECRET } = {}) {
  let t = T0;
  const clock = { now: () => new Date(t), advance: (ms) => (t += ms) };

  // --- stream_leases fake (mirrors the partial unique index + version CAS) ---
  const rows = [];
  const matches = (row, where = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (v.in) return v.in.includes(row[k]);
        if (v.lt) return row[k] instanceof Date ? row[k].getTime() < v.lt.getTime() : row[k] < v.lt;
        if (v.gt) return row[k] instanceof Date ? row[k].getTime() > v.gt.getTime() : row[k] > v.gt;
        return false;
      }
      if (v instanceof Date) return row[k] instanceof Date ? row[k].getTime() === v.getTime() : row[k] === v;
      return row[k] === v;
    });
  const P2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
  const streamLease = {
    async create({ data }) {
      // partial unique index: one PENDING/ACTIVE row per device
      if (rows.some((r) => r.deviceId === data.deviceId && ['PENDING', 'ACTIVE'].includes(r.status))) throw P2002();
      const id = data.id ?? crypto.randomUUID();
      const row = {
        id,
        deviceId: data.deviceId,
        userId: data.userId,
        mode: data.mode,
        status: data.status ?? 'PENDING',
        version: data.version ?? 1,
        slotIndex: data.slotIndex ?? null,
        createdAt: clock.now(),
        lastHeartbeatAt: data.lastHeartbeatAt ?? clock.now(),
        expiresAt: data.expiresAt,
        closedAt: data.closedAt ?? null,
        closeReason: data.closeReason ?? null,
        correlationId: data.correlationId ?? null,
        updatedAt: clock.now(),
      };
      rows.push(row);
      return { ...row };
    },
    async findUnique({ where }) {
      const row = rows.find((r) => r.id === where.id);
      return row ? { ...row } : null;
    },
    async findFirst({ where }) {
      const row = rows.find((r) => matches(r, where));
      return row ? { ...row } : null;
    },
    async findMany({ where = {}, orderBy, take } = {}) {
      let out = rows.filter((r) => matches(r, where)).map((r) => ({ ...r }));
      if (orderBy?.createdAt) out.sort((a, b) => (orderBy.createdAt === 'desc' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt));
      if (take) out = out.slice(0, take);
      return out;
    },
    async updateMany({ where, data }) {
      let n = 0;
      for (const r of rows) {
        if (!matches(r, where)) continue;
        Object.assign(r, data, { updatedAt: clock.now() });
        n += 1;
      }
      return { count: n };
    },
    async deleteMany({ where }) {
      const keep = rows.filter((r) => !matches(r, where));
      rows.length = 0;
      rows.push(...keep);
      return { count: rows.length < keep.length ? keep.length : 0 };
    },
    async count({ where = {} }) {
      return rows.filter((r) => matches(r, where)).length;
    },
  };

  const base = makeBatchFakeDb({ clock: clock.now });
  const baseDevices = Array.from({ length: devices }, (_, i) => ({
    id: DEV(i),
    name: `redroid-p1dev${i}`,
    containerState: 'running',
  }));
  const db = { ...base, streamLease, device: { findUnique: async ({ where }) => baseDevices.find((d) => d.id === where.id) ?? null } };
  const svc = createStreamLeaseService({
    db,
    redis: makeRedisFake(),
    config: { maxConcurrentDeviceStreamsRaw: maxStreamsRaw, streamTicketSecret: secret, streamLeaseTtlMs: ttlMs, streamReconcileIntervalMs: 0 },
    log: SILENT,
    leaseService: createLeaseService({ db, now: clock.now }),
    now: clock.now,
  });
  return { db, svc, clock, rows, devices: baseDevices };
}

function makeRedisFake() {
  const store = new Map();
  return {
    async set(key, value, ...args) {
      // emulates SET key value EX <s> NX
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
  };
}

const errOf = (p) =>
  p.then(
    () => {
      throw new assert.AssertionError({ message: 'expected rejection' });
    },
    (e) => e,
  );

// --- acquire: validation + RBAC + device state --------------------------------

test('acquire validates mode; unknown mode → 400 STREAM_INVALID_MODE', async () => {
  const { svc } = makeCtx();
  const e = await errOf(svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'hacker' }));
  assert.equal(e.apiCode, 'STREAM_INVALID_MODE');
  assert.equal(e.statusCode, 400);
});

test('acquire fails closed when STREAM_TICKET_SECRET is unconfigured (503, MD §11)', async () => {
  const { svc } = makeCtx({ secret: '' });
  const e = await errOf(svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'viewer' }));
  assert.equal(e.apiCode, 'STREAM_TICKET_UNAVAILABLE');
  assert.equal(e.statusCode, 503);
});

test('acquire: device not found → 404; not running → 409 STREAM_DEVICE_NOT_RUNNING', async () => {
  const { svc, devices } = makeCtx();
  const missing = await errOf(svc.acquire({ deviceId: '99999999-9999-4999-8999-999999999999', user: USER_OP, mode: 'viewer' }));
  assert.equal(missing.apiCode, 'STREAM_DEVICE_NOT_FOUND');
  assert.equal(missing.statusCode, 404);
  devices[0].containerState = 'stopped';
  const stopped = await errOf(svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'viewer' }));
  assert.equal(stopped.apiCode, 'STREAM_DEVICE_NOT_RUNNING');
  assert.equal(stopped.statusCode, 409);
});

test('RBAC per mode: viewer role → viewer OK / controller DENIED (403); operator → both OK; admin → both OK', async () => {
  const { svc } = makeCtx();
  const denied = await errOf(svc.acquire({ deviceId: DEV(0), user: USER_VIEWER, mode: 'controller' }));
  assert.equal(denied.apiCode, 'STREAM_PERMISSION_DENIED');
  assert.equal(denied.statusCode, 403);
  const v = await svc.acquire({ deviceId: DEV(0), user: USER_VIEWER, mode: 'viewer' });
  assert.equal(v.lease.status, 'ACTIVE');
  await svc.close({ leaseId: v.lease.id, user: USER_VIEWER });
  const c = await svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'controller' });
  assert.equal(c.lease.mode, 'controller');
  await svc.close({ leaseId: c.lease.id, user: USER_OP });
  const a = await svc.acquire({ deviceId: DEV(0), user: USER_ADMIN, mode: 'controller' });
  assert.equal(a.lease.status, 'ACTIVE');
});

test('acquire returns lease + single-use ticket + ws path + usage; ticket never in lease summary', async () => {
  const { svc } = makeCtx();
  const out = await svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'viewer', requestId: 'req-1' });
  assert.equal(out.lease.status, 'ACTIVE');
  assert.equal(out.lease.slotIndex, 0, 'first slot claimed');
  assert.equal(out.streamWsPath, `/api/device-streams/${out.lease.id}/ws`);
  assert.match(out.ticket, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(out.usage, { active: 1, max: 5 });
  assert.equal(JSON.stringify(out.lease).includes(out.ticket), false, 'ticket never embedded in the lease summary');
  assert.equal(out.lease.correlationId, 'req-1');
});

// --- global slot races (MD §4.1: atomic, no count-then-insert) ----------------

test('MD §4.1 six concurrent acquires: exactly 5 win, the 6th gets fixed 409 STREAM_CAPACITY_REACHED (5/5)', async () => {
  const { svc, rows } = makeCtx({ devices: 6 });
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      svc.acquire({ deviceId: DEV(i), user: i % 2 ? USER_OP : USER_ADMIN, mode: 'viewer' }).then(
        (r) => ({ ok: true, r }),
        (e) => ({ ok: false, e }),
      ),
    ),
  );
  const winners = results.filter((x) => x.ok);
  const losers = results.filter((x) => !x.ok);
  assert.equal(winners.length, 5, 'exactly 5 winners');
  assert.equal(losers.length, 1);
  assert.equal(losers[0].e.apiCode, 'STREAM_CAPACITY_REACHED');
  assert.equal(losers[0].e.statusCode, 409, 'FIXED code (MD §4.1 409/429 擇一)');
  assert.match(losers[0].e.message, /5\/5/);
  assert.equal(rows.filter((r) => r.status === 'ACTIVE').length, 5);
  assert.equal(rows.filter((r) => r.status === 'PENDING').length, 0, 'loser PENDING row compensated');
  const slots = winners.map((w) => w.r.lease.slotIndex).sort();
  assert.deepEqual(slots, [0, 1, 2, 3, 4], 'all 5 distinct slots held');
});

test('two managers race the LAST slot: exactly one succeeds, the other 409', async () => {
  const { svc } = makeCtx({ devices: 3, maxStreamsRaw: '2' });
  await svc.acquire({ deviceId: DEV(0), user: USER_ADMIN, mode: 'controller' }); // slot 0
  const [r1, r2] = await Promise.all([
    svc.acquire({ deviceId: DEV(1), user: USER_ADMIN, mode: 'controller' }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e })),
    svc.acquire({ deviceId: DEV(2), user: USER_OP, mode: 'controller' }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e })),
  ]);
  const winners = [r1, r2].filter((x) => x.ok);
  const losers = [r1, r2].filter((x) => !x.ok);
  assert.equal(winners.length, 1, 'exactly one manager wins the last slot');
  assert.equal(losers.length, 1);
  assert.equal(losers[0].e.apiCode, 'STREAM_CAPACITY_REACHED');
  assert.equal(losers[0].e.statusCode, 409);
});

test('same-device concurrent double-acquire: partial unique index → exactly one winner, other 409 STREAM_DEVICE_HELD', async () => {
  const { svc } = makeCtx();
  const [r1, r2] = await Promise.all([
    svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'viewer' }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e })),
    svc.acquire({ deviceId: DEV(0), user: USER_ADMIN, mode: 'viewer' }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e })),
  ]);
  const winners = [r1, r2].filter((x) => x.ok);
  const losers = [r1, r2].filter((x) => !x.ok);
  assert.equal(winners.length, 1);
  assert.equal(losers[0].e.apiCode, 'STREAM_DEVICE_HELD');
  assert.equal(losers[0].e.statusCode, 409);
});

test('sequential second acquire on a held device → 409 STREAM_DEVICE_HELD (pre-check path)', async () => {
  const { svc } = makeCtx();
  await svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'viewer' });
  const e = await errOf(svc.acquire({ deviceId: DEV(0), user: USER_ADMIN, mode: 'viewer' }));
  assert.equal(e.apiCode, 'STREAM_DEVICE_HELD');
});

// --- heartbeat (MD §4.1 server time; §8.1 owner/admin) --------------------------

test('heartbeat: owner extends with SERVER time + version bump; non-owner → 403; admin may heartbeat a foreign lease', async () => {
  const { svc, clock, rows } = makeCtx();
  const { lease } = await svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'viewer' });
  const before = lease.expiresAt.getTime();
  clock.advance(10_000);
  const hb = await svc.heartbeat({ leaseId: lease.id, user: USER_OP });
  assert.equal(hb.lease.expiresAt.getTime(), T0 + 10_000 + 30_000, 'expiry = server-now + TTL (client time never decides)');
  assert.equal(hb.lease.lastHeartbeatAt.getTime(), T0 + 10_000);
  assert.equal(hb.lease.version, 3, 'version bumped (1→2 at activate, 2→3 at heartbeat)');
  assert.ok(hb.lease.expiresAt.getTime() > before);

  const denied = await errOf(svc.heartbeat({ leaseId: lease.id, user: USER_VIEWER }));
  assert.equal(denied.apiCode, 'STREAM_LEASE_OWNER_MISMATCH');
  assert.equal(denied.statusCode, 403);

  const adminHb = await svc.heartbeat({ leaseId: lease.id, user: USER_ADMIN });
  assert.equal(adminHb.lease.version, 4);
  assert.equal(rows[0].version, 4);
});

test('heartbeat on an EXPIRED lease → 409 STREAM_LEASE_EXPIRED (never silently renewed; MD §10 re-auth)', async () => {
  const { svc, clock } = makeCtx({ ttlMs: 5_000 });
  const { lease } = await svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'viewer' });
  clock.advance(6_000);
  const e = await errOf(svc.heartbeat({ leaseId: lease.id, user: USER_OP }));
  assert.equal(e.apiCode, 'STREAM_LEASE_EXPIRED');
  assert.equal(e.statusCode, 409);
});

test('heartbeat on a CLOSED lease → 409 STREAM_LEASE_CLOSED', async () => {
  const { svc } = makeCtx();
  const { lease } = await svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'viewer' });
  await svc.close({ leaseId: lease.id, user: USER_OP });
  const e = await errOf(svc.heartbeat({ leaseId: lease.id, user: USER_OP }));
  assert.equal(e.apiCode, 'STREAM_LEASE_CLOSED');
});

test('heartbeat unknown lease → 404 STREAM_LEASE_NOT_FOUND', async () => {
  const { svc } = makeCtx();
  const e = await errOf(svc.heartbeat({ leaseId: '99999999-9999-4999-8999-999999999999', user: USER_OP }));
  assert.equal(e.apiCode, 'STREAM_LEASE_NOT_FOUND');
  assert.equal(e.statusCode, 404);
});

// --- close (idempotent, MD §8.1/§15) --------------------------------------------

test('close: releases slot exactly once; second close is idempotent (same summary, no error)', async () => {
  const { svc, rows, db } = makeCtx();
  const { lease } = await svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'viewer' });
  const slotRow = await db.resourceLease.findUnique({ where: { resourceType_resourceKey: { resourceType: 'stream_slot', resourceKey: `slot-${lease.slotIndex}` } } });
  assert.ok(slotRow, 'slot lease held');
  const c1 = await svc.close({ leaseId: lease.id, user: USER_OP });
  assert.equal(c1.idempotent, false);
  assert.equal(c1.lease.status, 'CLOSED');
  assert.equal(c1.lease.closeReason, 'user_closed');
  assert.equal(c1.usage.active, 0);
  const slotAfter = await db.resourceLease.findUnique({ where: { resourceType_resourceKey: { resourceType: 'stream_slot', resourceKey: `slot-${lease.slotIndex}` } } });
  assert.equal(slotAfter, null, 'slot released');
  const c2 = await svc.close({ leaseId: lease.id, user: USER_OP });
  assert.equal(c2.idempotent, true, 'MD §15: 同一 lease 重複 close 為冪等');
  assert.equal(c2.lease.status, 'CLOSED');
  assert.equal(rows.length, 1, 'no duplicate rows');
});

test('close by non-owner non-admin → 403; admin may close a foreign lease', async () => {
  const { svc } = makeCtx();
  const { lease } = await svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'viewer' });
  const denied = await errOf(svc.close({ leaseId: lease.id, user: USER_VIEWER }));
  assert.equal(denied.apiCode, 'STREAM_LEASE_OWNER_MISMATCH');
  const byAdmin = await svc.close({ leaseId: lease.id, user: USER_ADMIN, reason: 'admin_revoked' });
  assert.equal(byAdmin.lease.status, 'CLOSED');
  assert.equal(byAdmin.lease.closeReason, 'admin_revoked');
});

test('after close, the same device can be acquired again (terminal rows do not block)', async () => {
  const { svc } = makeCtx();
  const first = await svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'viewer' });
  await svc.close({ leaseId: first.lease.id, user: USER_OP });
  const second = await svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'controller' });
  assert.equal(second.lease.status, 'ACTIVE');
});

// --- reconciliation (MD §10) ------------------------------------------------------

test('expiry sweep: expired ACTIVE → EXPIRED + slot released; a renewed (version-bumped) lease SURVIVES (MD §4.1 owner/version)', async () => {
  const { svc, clock, rows } = makeCtx({ ttlMs: 5_000, devices: 3 });
  const a = await svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'viewer' });
  const b = await svc.acquire({ deviceId: DEV(1), user: USER_OP, mode: 'viewer' });
  clock.advance(6_000); // both past TTL
  await svc.heartbeat({ leaseId: b.lease.id, user: USER_OP }).catch(() => {}); // b's client died → no renewal
  // Simulate a heartbeat winning the race on `a` between the sweep's read and CAS:
  // bump version + extend expiry (as a concurrent heartbeat would), then sweep.
  rows[0].version += 1;
  rows[0].expiresAt = new Date(clock.now().getTime() + 30_000);
  const reaped = await svc.reconcileExpired();
  assert.equal(reaped, 1, 'exactly the unrenewed lease reaped');
  const aRow = rows.find((r) => r.id === a.lease.id);
  const bRow = rows.find((r) => r.id === b.lease.id);
  assert.equal(aRow.status, 'ACTIVE', 'version-bumped lease was NOT clobbered');
  assert.equal(bRow.status, 'EXPIRED');
  assert.equal(bRow.closeReason, 'expired');
  assert.equal(bRow.slotIndex, null);
});

test('reconcileStartup (MD §10 API restart): every PENDING/ACTIVE → INTERRUPTED + slots freed; terminal rows untouched', async () => {
  const { svc, clock, rows, db } = makeCtx({ devices: 4 });
  const a = await svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'viewer' });
  await svc.acquire({ deviceId: DEV(1), user: USER_ADMIN, mode: 'controller' });
  await svc.close({ leaseId: a.lease.id, user: USER_OP });
  clock.advance(100_000);
  const n = await svc.reconcileStartup();
  assert.equal(n, 1, 'only the live lease interrupted (closed one untouched)');
  const live = rows.find((r) => r.id !== a.lease.id);
  assert.equal(live.status, 'INTERRUPTED');
  assert.equal(live.closeReason, 'api_restart');
  assert.equal(live.slotIndex, null);
  // no stream_slot lease may remain
  const slotRows = await db.resourceLease.findMany({ where: { resourceType: 'stream_slot' } });
  assert.equal(slotRows.length, 0, 'all slots released at restart reconcile');
  // a NEW acquire works after the restart-reconcile
  const fresh = await svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'viewer' });
  assert.equal(fresh.lease.status, 'ACTIVE');
});

// --- stream ticket (MD §11.8) -------------------------------------------------------

test('ticket: binds user+device+lease+mode — wrong user/device/mode → 401; valid → lease row', async () => {
  const { svc } = makeCtx();
  const { lease, ticket } = await svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'viewer' });
  const ok = await svc.validateTicket({ ticket, user: USER_OP, deviceId: DEV(0), mode: 'viewer' });
  assert.equal(ok.id, lease.id);
  const wrongUser = await errOf(svc.validateTicket({ ticket, user: USER_ADMIN, deviceId: DEV(0), mode: 'viewer' }));
  assert.equal(wrongUser.apiCode, 'STREAM_TICKET_INVALID');
  const wrongDev = await errOf(svc.validateTicket({ ticket, user: USER_OP, deviceId: DEV(1), mode: 'viewer' }));
  assert.equal(wrongDev.apiCode, 'STREAM_TICKET_INVALID');
  const wrongMode = await errOf(svc.validateTicket({ ticket, user: USER_OP, deviceId: DEV(0), mode: 'controller' }));
  assert.equal(wrongMode.apiCode, 'STREAM_TICKET_INVALID');
});

test('ticket: TTL — expired ticket rejected (server time)', async () => {
  const { svc, clock } = makeCtx();
  const { ticket } = await svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'viewer' });
  clock.advance(61_000); // past the 60s TTL
  const e = await errOf(svc.validateTicket({ ticket, user: USER_OP, deviceId: DEV(0), mode: 'viewer' }));
  assert.equal(e.apiCode, 'STREAM_TICKET_INVALID');
  assert.match(e.message, /expired/);
});

test('ticket: tampered signature / malformed → 401', async () => {
  const { svc } = makeCtx();
  const { ticket } = await svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'viewer' });
  const [b64] = ticket.split('.');
  const tampered = `${b64}.${'A'.repeat(43)}`;
  const e1 = await errOf(svc.validateTicket({ ticket: tampered, user: USER_OP, deviceId: DEV(0), mode: 'viewer' }));
  assert.equal(e1.apiCode, 'STREAM_TICKET_INVALID');
  const e2 = await errOf(svc.validateTicket({ ticket: 'garbage', user: USER_OP, deviceId: DEV(0), mode: 'viewer' }));
  assert.equal(e2.apiCode, 'STREAM_TICKET_INVALID');
});

test('ticket: SINGLE-USE — consume=true burns it; replay → 401 STREAM_TICKET_REPLAYED', async () => {
  const { svc } = makeCtx();
  const { ticket } = await svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'viewer' });
  await svc.validateTicket({ ticket, user: USER_OP, deviceId: DEV(0), mode: 'viewer', consume: true });
  const e = await errOf(svc.validateTicket({ ticket, user: USER_OP, deviceId: DEV(0), mode: 'viewer', consume: true }));
  assert.equal(e.apiCode, 'STREAM_TICKET_REPLAYED');
  assert.equal(e.statusCode, 401);
  // consume=false (WS pre-flight verification) does NOT burn the ticket
  const { lease: l2, ticket: t2 } = await svc.acquire({ deviceId: DEV(1), user: USER_OP, mode: 'viewer' });
  await svc.validateTicket({ ticket: t2, user: USER_OP, deviceId: DEV(1), mode: 'viewer' }); // no consume
  const again = await svc.validateTicket({ ticket: t2, user: USER_OP, deviceId: DEV(1), mode: 'viewer' }); // still spendable
  assert.equal(again.id, l2.id);
});

test('ticket for a CLOSED/EXPIRED lease is rejected (no stale control, MD §10)', async () => {
  const { svc } = makeCtx();
  const { lease, ticket } = await svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'viewer' });
  await svc.close({ leaseId: lease.id, user: USER_OP });
  const e = await errOf(svc.validateTicket({ ticket, user: USER_OP, deviceId: DEV(0), mode: 'viewer' }));
  assert.equal(e.apiCode, 'STREAM_TICKET_INVALID');
});

// --- list / usage -------------------------------------------------------------------

test('list: returns summaries + global usage; no ticket material anywhere', async () => {
  const { svc } = makeCtx();
  const { lease, ticket } = await svc.acquire({ deviceId: DEV(0), user: USER_OP, mode: 'viewer' });
  const out = await svc.list();
  assert.deepEqual(out.usage, { active: 1, max: 5 });
  assert.equal(out.leases.length, 1);
  assert.equal(out.leases[0].id, lease.id);
  assert.equal(JSON.stringify(out).includes(ticket), false, 'ticket never leaks into GET /device-streams');
});

// --- MAX_CONCURRENT_DEVICE_STREAMS (MD §4.1 config) ----------------------------------

test('MAX_CONCURRENT_DEVICE_STREAMS: absent → 5; "3" → 3 (and the 4th acquire 409s); invalid values → fail-safe 5', async () => {
  const { svc } = makeCtx({ devices: 6 });
  assert.equal(svc.maxStreams, 5);
  const ctx3 = makeCtx({ devices: 6, maxStreamsRaw: '3' });
  assert.equal(ctx3.svc.maxStreams, 3);
  for (let i = 0; i < 3; i += 1) await ctx3.svc.acquire({ deviceId: DEV(i), user: USER_OP, mode: 'viewer' });
  const e = await errOf(ctx3.svc.acquire({ deviceId: DEV(3), user: USER_OP, mode: 'viewer' }));
  assert.equal(e.apiCode, 'STREAM_CAPACITY_REACHED');
  assert.match(e.message, /3\/3/);

  assert.equal(makeCtx({ maxStreamsRaw: '0' }).svc.maxStreams, 5, '0 → fail-safe 5');
  assert.equal(makeCtx({ maxStreamsRaw: '99' }).svc.maxStreams, 5, '>5 → fail-safe 5 (cap, MD §4.1)');
  assert.equal(makeCtx({ maxStreamsRaw: 'abc' }).svc.maxStreams, 5, 'garbage → fail-safe 5');
  assert.equal(makeCtx({ maxStreamsRaw: '2.5' }).svc.maxStreams, 5, 'non-integer → fail-safe 5');
});
