/**
 * Unit tests — stream gateway WS upgrade auth chain (MD §8.1 server-side
 * re-verification). Hermetic fakes for db / streamLeaseService / sessions.
 *
 * The chain (every upgrade, in order):
 *   session → user(401) → lease(404) → owner(403) → ACTIVE(409 closed) →
 *   expiry(409) → device(404/409 not running) → ADB allowlist(403) →
 *   ticket HMAC+exp+binding+single-use(401 invalid/replayed).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamGateway } from '../../apps/api/src/services/stream-gateway.js';

const NOW = new Date();
const LATER = new Date(NOW.getTime() + 3600_000);
const PAST = new Date(NOW.getTime() - 3600_000);

function makeGateway({ user = null, lease = null, device = null, ticketResult = 'ok' } = {}) {
  const db = {
    streamLease: {
      findUnique: async ({ where }) => (where.id === lease?.id ? lease : null),
    },
    device: {
      findUnique: async ({ where }) => (where.id === device?.id ? device : null),
    },
  };
  const config = {
    redroidAdbRangeStart: 16500,
    redroidAdbRangeEnd: 16549,
    streamLeaseTtlMs: 30_000,
    streamSidecarPort: 16550,
    streamSidecarToken: 'a'.repeat(64),
    streamVideoSource: 'auto',
    streamQuality: 'medium',
    cookieSecure: false,
  };
  let ticketCalls = 0;
  let lastTicketOpts = null;
  const streamLeaseService = {
    validateTicket: async (opts) => {
      ticketCalls += 1;
      lastTicketOpts = opts;
      if (ticketResult === 'invalid') {
        const e = new Error('stream ticket signature invalid');
        e.apiCode = 'STREAM_TICKET_INVALID';
        e.statusCode = 401;
        throw e;
      }
      if (ticketResult === 'replayed') {
        const e = new Error('stream ticket already used (single-use, MD §11.8)');
        e.apiCode = 'STREAM_TICKET_REPLAYED';
        e.statusCode = 401;
        throw e;
      }
      return lease; // live lease row
    },
    heartbeat: async () => ({ ok: true }),
  };
  const gw = createStreamGateway({
    db,
    config,
    streamLeaseService,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    resolveUser: async () => user,
  });
  return { gw, get ticketCalls() { return ticketCalls; }, get lastTicketOpts() { return lastTicketOpts; } };
}

const REQ = (cookies = '') => ({ headers: { cookie: cookies, origin: 'http://127.0.0.1:16490' }, url: '/api/device-streams/le-123/ws' });
const USER = { id: 'user-1', role: 'admin' };
const LEASE = {
  id: 'le-123', deviceId: 'dev-1', userId: 'user-1', mode: 'controller',
  status: 'ACTIVE', version: 1, expiresAt: LATER, slotIndex: 0,
};
const DEVICE = { id: 'dev-1', name: 'd1', adbPort: 16500, containerState: 'running' };
const TCK = 'stream_ticket=abc.def';

test('chain: no session → 401 UNAUTHORIZED (never touches db/ticket)', async () => {
  const { gw, } = makeGateway({ user: null, lease: LEASE, device: DEVICE });
  await assert.rejects(
    () => gw.authenticateUpgrade({ leaseId: 'le-123', req: REQ() }),
    (e) => e.apiCode === 'UNAUTHORIZED' && e.statusCode === 401,
  );
});

test('chain: lease missing → 404 STREAM_LEASE_NOT_FOUND', async () => {
  const { gw } = makeGateway({ user: USER, lease: null, device: DEVICE });
  await assert.rejects(
    () => gw.authenticateUpgrade({ leaseId: 'le-nope', req: REQ(TCK) }),
    (e) => e.apiCode === 'STREAM_LEASE_NOT_FOUND' && e.statusCode === 404,
  );
});

test('chain: non-owner non-admin → 403 STREAM_LEASE_OWNER_MISMATCH', async () => {
  const other = { id: 'user-2', role: 'viewer' };
  const { gw } = makeGateway({ user: other, lease: LEASE, device: DEVICE });
  await assert.rejects(
    () => gw.authenticateUpgrade({ leaseId: 'le-123', req: REQ(TCK) }),
    (e) => e.apiCode === 'STREAM_LEASE_OWNER_MISMATCH' && e.statusCode === 403,
  );
});

test('chain: owner (non-admin) passes the ownership gate', async () => {
  const owner = { id: 'user-1', role: 'viewer' };
  const { gw, lastTicketOpts } = makeGateway({ user: owner, lease: LEASE, device: DEVICE });
  const v = await gw.authenticateUpgrade({ leaseId: 'le-123', req: REQ(TCK) });
  assert.equal(v.ok, true);
  assert.equal(v.serial, '127.0.0.1:16500');
  // NV5b(c): the verdict carries the ticket UNCONSUMED (the upgrade handler
  // burns it via consumeTicket only after a successful sidecar handshake),
  // and validation must NOT be called in one-shot consume mode.
  assert.equal(v.ticket, 'abc.def');
  assert.notEqual(lastTicketOpts?.consume, true, 'upgrade validation must not burn the ticket (NV5b(c))');
});

test('chain: CLOSED lease → 409 STREAM_LEASE_CLOSED', async () => {
  const { gw } = makeGateway({ user: USER, lease: { ...LEASE, status: 'CLOSED' }, device: DEVICE });
  await assert.rejects(
    () => gw.authenticateUpgrade({ leaseId: 'le-123', req: REQ(TCK) }),
    (e) => e.apiCode === 'STREAM_LEASE_CLOSED' && e.statusCode === 409,
  );
});

test('chain: expired lease → 409 STREAM_LEASE_EXPIRED (server time)', async () => {
  const { gw } = makeGateway({ user: USER, lease: { ...LEASE, expiresAt: PAST }, device: DEVICE });
  await assert.rejects(
    () => gw.authenticateUpgrade({ leaseId: 'le-123', req: REQ(TCK) }),
    (e) => e.apiCode === 'STREAM_LEASE_EXPIRED' && e.statusCode === 409,
  );
});

test('chain: device missing → 404 STREAM_DEVICE_NOT_FOUND', async () => {
  const { gw } = makeGateway({ user: USER, lease: LEASE, device: null });
  await assert.rejects(
    () => gw.authenticateUpgrade({ leaseId: 'le-123', req: REQ(TCK) }),
    (e) => e.apiCode === 'STREAM_DEVICE_NOT_FOUND' && e.statusCode === 404,
  );
});

test('chain: device not running → 409 STREAM_DEVICE_NOT_RUNNING', async () => {
  const { gw } = makeGateway({ user: USER, lease: LEASE, device: { ...DEVICE, containerState: 'stopped' } });
  await assert.rejects(
    () => gw.authenticateUpgrade({ leaseId: 'le-123', req: REQ(TCK) }),
    (e) => e.apiCode === 'STREAM_DEVICE_NOT_RUNNING' && e.statusCode === 409,
  );
});

test('chain: ADB port outside allowlist → 403 STREAM_DEVICE_ADB_NOT_ALLOWED', async () => {
  const { gw } = makeGateway({ user: USER, lease: LEASE, device: { ...DEVICE, adbPort: 15000 } });
  await assert.rejects(
    () => gw.authenticateUpgrade({ leaseId: 'le-123', req: REQ(TCK) }),
    (e) => e.apiCode === 'STREAM_DEVICE_ADB_NOT_ALLOWED' && e.statusCode === 403,
  );
});

test('chain: serial is ALWAYS loopback-constructed (no adbHost column — host is not client/row-supplied)', async () => {
  // The Device row carries only adbPort; the gateway must construct
  // 127.0.0.1:<port> itself. A row with a foreign host field cannot redirect
  // the sidecar anywhere else (MD §5.2 — SSRF-free by construction).
  const { gw } = makeGateway({ user: USER, lease: LEASE, device: { ...DEVICE, adbHost: '10.1.2.3' } });
  const verdict = await gw.authenticateUpgrade({ leaseId: 'le-123', req: REQ(TCK) });
  assert.equal(verdict.serial, '127.0.0.1:16500');
});

test('chain: missing ticket → 401 STREAM_TICKET_INVALID', async () => {
  const { gw, ticketCalls } = makeGateway({ user: USER, lease: LEASE, device: DEVICE });
  await assert.rejects(
    () => gw.authenticateUpgrade({ leaseId: 'le-123', req: REQ('') }),
    (e) => e.apiCode === 'STREAM_TICKET_INVALID' && e.statusCode === 401,
  );
  assert.equal(ticketCalls, 0); // rejected before the ticket store is touched
});

test('chain: replayed ticket → 401 STREAM_TICKET_REPLAYED (single-use, MD §11.8)', async () => {
  const { gw } = makeGateway({ user: USER, lease: LEASE, device: DEVICE, ticketResult: 'replayed' });
  await assert.rejects(
    () => gw.authenticateUpgrade({ leaseId: 'le-123', req: REQ(TCK) }),
    (e) => e.apiCode === 'STREAM_TICKET_REPLAYED' && e.statusCode === 401,
  );
});

test('chain: full pass → verdict with lease + device + serial (owner & admin)', async () => {
  const { gw } = makeGateway({ user: USER, lease: LEASE, device: DEVICE });
  const v = await gw.authenticateUpgrade({ leaseId: 'le-123', req: REQ(TCK) });
  assert.deepEqual(
    { ok: v.ok, lease: v.lease.id, device: v.device.id, user: v.user.id, serial: v.serial },
    { ok: true, lease: 'le-123', device: 'dev-1', user: 'user-1', serial: '127.0.0.1:16500' },
  );
});

// ---- WS frame decoder (handshake phase) ------------------------------------------
test('extractFrame: fixed/16-bit/64-bit lengths + masking round-trip', async () => {
  const { extractFrame } = await import('../../apps/api/src/services/stream-gateway.js');
  // fixed length, unmasked text frame "hi"
  const f1 = Buffer.from([0x81, 0x02, 0x68, 0x69]);
  let m = extractFrame(f1);
  assert.equal(m.opcode, 1);
  assert.equal(m.payload.toString(), 'hi');
  assert.equal(m.next, 4);
  // 16-bit length (300 bytes)
  const f2 = Buffer.concat([Buffer.from([0x81, 0x7e]), Buffer.from([0x01, 0x2c]), Buffer.alloc(300, 7)]);
  m = extractFrame(f2);
  assert.equal(m.payload.length, 300);
  // masked (client→server style): 4-byte key XOR
  const plain = Buffer.from('abcd');
  const key = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const masked = Buffer.from(plain.map((b, i) => b ^ key[i % 4]));
  const f3 = Buffer.concat([Buffer.from([0x81, 0x84]), key, masked]);
  m = extractFrame(f3);
  assert.equal(m.payload.toString(), 'abcd');
  // truncated mid-mask-key (only 2 of 4 key bytes) → null (not partial garbage)
  assert.equal(extractFrame(Buffer.from([0x81, 0x80, 0x01, 0x02])), null);
  // masked empty-payload frame IS complete (4-byte key, 0 payload)
  const mEmpty = extractFrame(Buffer.from([0x81, 0x80, 0x01, 0x02, 0x03, 0x04]));
  assert.equal(mEmpty.payload.length, 0);
  assert.equal(mEmpty.next, 6);
});

// ---- wsTextFrame: gateway→sidecar handshake encoding (P2 E2E run #7 fix) --------
// The sidecar /ws is a real `ws` WebSocketServer. The old handshake wrote raw
// JSON (no frame header) → the sidecar parsed the first JSON byte as a frame
// header (RSV2/RSV3 set) → "sidecar ws error" → STREAM_SIDECAR_UNAVAILABLE
// loop. Handshake messages must be proper masked text frames.
test('wsTextFrame: round-trips through extractFrame in all 3 length classes', async () => {
  const { wsTextFrame, extractFrame } = await import('../../apps/api/src/services/stream-gateway.js');
  for (const obj of [{ t: 'auth', token: 'x' }, { t: 'session', pad: 'y'.repeat(200) }, { t: 'big', pad: 'z'.repeat(70_000) }]) {
    const frame = wsTextFrame(obj);
    const m = extractFrame(frame);
    assert.ok(m, `frame should be complete (${obj.pad?.length ?? 0}b payload)`);
    assert.equal(m.opcode, 1, 'opcode must be text');
    assert.deepEqual(JSON.parse(m.payload.toString('utf8')), obj, 'payload round-trip');
    assert.equal(m.next, frame.length, 'frame consumes exactly');
    // mask bit must be SET (client→server, RFC6455 §5.3)
    assert.equal(frame[1] & 0x80, 0x80, 'mask bit set');
  }
});

test('wsTextFrame: header bytes per length class (2/4/10 byte headers)', async () => {
  const { wsTextFrame } = await import('../../apps/api/src/services/stream-gateway.js');
  const small = wsTextFrame({ a: 1 }); // {"a":1} = 7-byte payload
  assert.equal(small[0], 0x81);
  assert.equal(small[1] & 0x7f, 7);
  const med = wsTextFrame({ pad: 'q'.repeat(300) }); // 300+10 JSON overhead = 310 → 126 marker
  assert.equal(med[1] & 0x7f, 126);
  assert.equal(med.readUInt16BE(2), 310);
  const big = wsTextFrame({ pad: 'w'.repeat(70_000) }); // 70000+10 = 70010 → 127 marker + 8-byte len
  assert.equal(big[1] & 0x7f, 127);
  assert.equal(big.readBigUInt64BE(2), BigInt(70_010));
});
