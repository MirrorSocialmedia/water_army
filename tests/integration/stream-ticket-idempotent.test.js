/**
 * NV5b(c) integration — full WS-upgrade ticket lifecycle against a FAKE
 * SIDECAR (老細 2026-10-26 拍板 選項 (c): 「成功 handshake 先消耗」).
 *
 * Reproduces the gen9 storm shape without devices:
 *   1. acquire → ticket
 *   2. upgrade #1: authenticateUpgrade passes, sidecar is DOWN (restart) →
 *      connectAndHandshake fails → the ticket MUST still be spendable
 *   3. upgrade #2 (the retry): sidecar recovered → handshake succeeds →
 *      consumeTicket burns the ticket
 *   4. replay (upgrade #3 with the same ticket) → 401 STREAM_TICKET_REPLAYED
 *
 * The fake sidecar speaks just enough of the internal WS protocol (auth-ok /
 * ready text frames, built with the gateway's own frame codec). No real
 * sidecar, no redroid, no network beyond 127.0.0.1 loopback.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

import { createLeaseService } from '@water-army/shared';
import { makeBatchFakeDb } from '../helpers/batch-fakes.js';
import { createStreamLeaseService } from '../../apps/api/src/services/stream-lease-service.js';
import { createStreamGateway, wsTextFrame, extractFrame } from '../../apps/api/src/services/stream-gateway.js';

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const SECRET = 'nv5b-integration-ticket-secret-32b';
const USER_OP = { id: '22222222-2222-4222-8222-222222222222', role: 'operator' };
const DEVICE = { id: 'd0000000-0000-4000-8000-000000000001', name: 'redroid-nv5b', adbPort: 16500, containerState: 'running' };

// --- minimal lease-row fake (create/findUnique/findMany/updateMany/count) -------
function makeLeaseFake() {
  const rows = [];
  return {
    rows,
    async create({ data }) {
      if (rows.some((r) => r.deviceId === data.deviceId && ['PENDING', 'ACTIVE'].includes(r.status))) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      const row = {
        id: data.id ?? crypto.randomUUID(),
        deviceId: data.deviceId,
        userId: data.userId,
        mode: data.mode,
        status: data.status ?? 'PENDING',
        version: data.version ?? 1,
        slotIndex: data.slotIndex ?? null,
        createdAt: new Date(),
        lastHeartbeatAt: data.lastHeartbeatAt ?? new Date(),
        expiresAt: data.expiresAt,
        closedAt: null,
        closeReason: null,
        correlationId: data.correlationId ?? null,
      };
      rows.push(row);
      return { ...row };
    },
    async findUnique({ where }) {
      const r = rows.find((x) => x.id === where.id);
      return r ? { ...r } : null;
    },
    async findFirst({ where = {} } = {}) {
      const r = rows.find((x) => matchWhere(x, where));
      return r ? { ...r } : null;
    },
    async findMany({ where = {} } = {}) {
      return rows.filter((r) => matchWhere(r, where)).map((r) => ({ ...r }));
    },
    async updateMany({ where, data }) {
      let n = 0;
      for (const r of rows) {
        if (!matchWhere(r, where)) continue;
        Object.assign(r, data);
        n += 1;
      }
      return { count: n };
    },
    async count({ where = {} } = {}) {
      return rows.filter((r) => matchWhere(r, where)).length;
    },
  };
}

function matchWhere(row, where = {}) {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if (v.in) return v.in.includes(row[k]);
      if (v.lt) return row[k] < v.lt;
      return false;
    }
    return row[k] === v;
  });
}

function makeRedisFake() {
  const store = new Map();
  return {
    async set(key, value, ...args) {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
  };
}

// --- fake sidecar: DOWN (rejects upgrade 503) or HEALTHY (auth-ok + ready) ------
function startFakeSidecar() {
  const state = { mode: 'down', conns: 0, sockets: new Set() };
  const server = http.createServer((req, res) => { res.writeHead(426); res.end(); });
  server.on('upgrade', (req, socket) => {
    state.conns += 1;
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
    if (state.mode === 'down') {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\n');
      socket.end();
      return;
    }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const m = extractFrame(buf);
        if (!m) break;
        buf = buf.subarray(m.next);
        let obj;
        try { obj = JSON.parse(m.payload.toString('utf8')); } catch { continue; }
        if (obj.t === 'auth') socket.write(wsTextFrame({ t: 'auth-ok' }));
        if (obj.t === 'session') socket.write(wsTextFrame({ t: 'ready', leaseId: obj.leaseId }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

/**
 * Hermetic teardown: an upgraded (101) server-side socket is NOT reliably
 * counted as closable by server.close() under node:test — the close callback
 * can hang with an empty event loop (test gets cancelledByParent). Destroy
 * every tracked connection first, then close without awaiting the callback.
 */
function closeSidecar({ server, state }) {
  for (const s of state.sockets) { try { s.destroy(); } catch { /* gone */ } }
  state.sockets.clear();
  try { server.close(); } catch { /* already */ }
}

function makeStack(sidecarPort) {
  const leaseFake = makeLeaseFake();
  const base = makeBatchFakeDb({ clock: () => new Date() });
  const db = { ...base, streamLease: leaseFake, device: { findUnique: async ({ where }) => (where.id === DEVICE.id ? DEVICE : null) } };
  const clockNow = () => new Date();
  const svc = createStreamLeaseService({
    db,
    redis: makeRedisFake(),
    config: { maxConcurrentDeviceStreamsRaw: '', streamTicketSecret: SECRET, streamLeaseTtlMs: 30_000, streamReconcileIntervalMs: 0 },
    log: SILENT,
    leaseService: createLeaseService({ db, now: clockNow }),
    now: clockNow,
  });
  const config = {
    redroidAdbRangeStart: 16500, redroidAdbRangeEnd: 16549,
    streamLeaseTtlMs: 30_000,
    streamSidecarPort: sidecarPort,
    streamSidecarToken: 'a'.repeat(64),
    streamVideoSource: 'auto', streamQuality: 'medium',
    cookieSecure: false,
  };
  const gw = createStreamGateway({ db, config, streamLeaseService: svc, log: SILENT, resolveUser: async () => USER_OP });
  return { svc, gw };
}

test('NV5b(c) integration: failed upgrade does NOT burn the ticket; success burns it; replay 401', async (t) => {
  const sidecar = await startFakeSidecar();
  t.after(() => closeSidecar(sidecar));
  const { svc, gw } = makeStack(sidecar.port);
  const req = { headers: { origin: 'http://127.0.0.1:16490' }, url: '/api/device-streams/x/ws' };

  const { lease, ticket } = await svc.acquire({ deviceId: DEVICE.id, user: USER_OP, mode: 'viewer' });
  req.headers.cookie = `stream_ticket=${ticket}`;

  // ── attempt 1: auth passes, sidecar DOWN → handshake fails, ticket survives
  const v1 = await gw.authenticateUpgrade({ leaseId: lease.id, req });
  assert.equal(v1.ok, true);
  await assert.rejects(
    () => gw.connectAndHandshake({ lease: v1.lease, device: v1.device, serial: v1.serial, videoSource: 'auto', quality: 'medium' }),
    (e) => e.apiCode === 'STREAM_SIDECAR_UNAVAILABLE',
    'downed sidecar rejects the upgrade',
  );
  // THE NV5b regression: under one-shot semantics this validation threw
  // STREAM_TICKET_REPLAYED (the failed attempt had already burned the ticket).
  const v2 = await gw.authenticateUpgrade({ leaseId: lease.id, req });
  assert.equal(v2.ok, true, 'ticket still spendable after the failed upgrade');

  // ── attempt 2: sidecar RECOVERED → handshake succeeds → consume (post-success)
  sidecar.state.mode = 'healthy';
  const handle = await gw.connectAndHandshake({ lease: v2.lease, device: v2.device, serial: v2.serial, videoSource: 'auto', quality: 'medium' });
  assert.equal(handle.sessionStarted, true);
  await svc.consumeTicket({ ticket });
  try { handle.sock.destroy(); } catch { /* ignore */ }

  // ── replay: the same ticket after a SUCCESSFUL handshake is dead (401)
  await assert.rejects(
    () => gw.authenticateUpgrade({ leaseId: lease.id, req }),
    (e) => e.apiCode === 'STREAM_TICKET_REPLAYED' && e.statusCode === 401,
    'post-success replay rejected',
  );

  // ── reconnect re-issue still works (fresh ticket for the still-ACTIVE lease)
  await new Promise((r) => setTimeout(r, 20)); // distinct ticket payload (exp)
  const fresh = await svc.reconnect({ leaseId: lease.id, user: USER_OP });
  req.headers.cookie = `stream_ticket=${fresh.ticket}`;
  const v3 = await gw.authenticateUpgrade({ leaseId: lease.id, req });
  assert.equal(v3.ok, true);
  const handle2 = await gw.connectAndHandshake({ lease: v3.lease, device: v3.device, serial: v3.serial, videoSource: 'auto', quality: 'medium' });
  await svc.consumeTicket({ ticket: fresh.ticket });
  try { handle2.sock.destroy(); } catch { /* ignore */ }
  assert.ok(sidecar.state.conns >= 3, 'fake sidecar actually saw the connection attempts');
});

test('NV5b(c) integration: concurrent duplicates — validation never burns; exactly one consume wins', async () => {
  const leaseFake = makeLeaseFake();
  const base = makeBatchFakeDb({ clock: () => new Date() });
  const db = { ...base, streamLease: leaseFake, device: { findUnique: async ({ where }) => (where.id === DEVICE.id ? DEVICE : null) } };
  const clockNow = () => new Date();
  const svc = createStreamLeaseService({
    db, redis: makeRedisFake(),
    config: { maxConcurrentDeviceStreamsRaw: '', streamTicketSecret: SECRET, streamLeaseTtlMs: 30_000, streamReconcileIntervalMs: 0 },
    log: SILENT, leaseService: createLeaseService({ db, now: clockNow }), now: clockNow,
  });
  const { ticket } = await svc.acquire({ deviceId: DEVICE.id, user: USER_OP, mode: 'viewer' });
  // Both race through validation (nobody burns it there)…
  await svc.validateTicket({ ticket, user: USER_OP, deviceId: DEVICE.id, mode: 'viewer' });
  await svc.validateTicket({ ticket, user: USER_OP, deviceId: DEVICE.id, mode: 'viewer' });
  // …both complete handshakes; consume decides the winner (loser tears down).
  await svc.consumeTicket({ ticket });
  await assert.rejects(
    () => svc.consumeTicket({ ticket }),
    (e) => e.apiCode === 'STREAM_TICKET_REPLAYED' && e.statusCode === 401,
  );
});
