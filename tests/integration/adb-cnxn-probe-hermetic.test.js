/**
 * Hermetic fake-ADB-server test group for the CNXN health probe (F-RDFA-2).
 *
 * The workorder discipline: MOCKS ARE NEVER PASS-CRITERIA FOR REAL DEVICES —
 * but the probe's NEGATIVE PATHS (timeout / refused / garbage / auth / stls)
 * are exactly what cannot be reproduced safely on a real fleet device, so a
 * fake adbd is the right tool for them. The happy path is separately proven
 * on a real redroid-rdfa-* device (see docs/audits/rdfa-fix-report.md, S2/S4
 * evidence). The fake below models REAL adbd behavior: it ignores everything
 * until a valid CNXN arrives (p2-55 EXP A/B: bare commands get zero bytes),
 * then replies exactly like AOSP adbd.cpp handle_new_connection():
 * no-auth → its own CNXN with a device:: banner; auth-required → A_AUTH;
 * TLS-first → A_STLS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { adbCnxnProbe } from '../../apps/api/src/services/adb-cnxn-probe.js';
import {
  A_CNXN,
  A_AUTH,
  A_STLS,
  A_VERSION,
  ADB_PROBE_MAXDATA,
  adbMagic,
  buildAdbCnxnPacket,
  parseAdbPacket,
} from '@water-army/shared';

const DEVICE_BANNER = 'device::ro.product.name=faux-device;ro.product.model=faux14;ro.product.device=faux;features=cmd,shell_v2,stat_v2';
const RECOVERY_BANNER = 'recovery::ro.product.name=faux-device;features=cmd';

/** Build a raw ADB packet (24B LE header + payload). */
function adbPacket(command, { arg0 = 0, arg1 = 0, payload = Buffer.alloc(0) } = {}) {
  let sum = 0;
  for (const b of payload) sum = (sum + b) >>> 0;
  const h = Buffer.alloc(24);
  h.writeUInt32LE(command, 0);
  h.writeUInt32LE(arg0, 4);
  h.writeUInt32LE(arg1, 8);
  h.writeUInt32LE(payload.length, 12);
  h.writeUInt32LE(sum, 16);
  h.writeUInt32LE(adbMagic(command), 20);
  return Buffer.concat([h, payload]);
}

/**
 * Fake adbd. reply: 'cnxn' (default, no-auth) | 'auth' | 'stls' | 'garbage'
 * | 'silent' | 'bad-banner'. verifyCnxn defaults true: the server records
 * whether the client's first packet was a VALID CNXN (real adbd ignores
 * anything else — recorded so tests can assert the probe actually did the
 * handshake, not just opened a socket).
 */
function makeFakeAdbd({ reply = 'cnxn', banner = DEVICE_BANNER, verifyCnxn = true, sawCnxn = () => {} } = {}) {
  const server = net.createServer((s) => {
    let buf = Buffer.alloc(0);
    s.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 24) return;
      const p = parseAdbPacket(buf);
      if (p.state !== 'ok' || p.command !== A_CNXN || !p.magicValid) return;
      sawCnxn(true);
      if (!verifyCnxn) return; // a hostile/buggy "adbd" that never answers
      if (reply === 'silent') return;
      if (reply === 'garbage') {
        s.end(Buffer.from([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        return;
      }
      if (reply === 'bad-banner') {
        s.end(adbPacket(A_CNXN, { arg0: A_VERSION, arg1: ADB_PROBE_MAXDATA, payload: Buffer.from('host::features=cmd', 'utf8') }));
        return;
      }
      if (reply === 'auth') {
        s.end(adbPacket(A_AUTH, { arg0: 1, payload: Buffer.alloc(16) }));
        return;
      }
      if (reply === 'stls') {
        s.end(adbPacket(A_STLS, { arg0: 0 }));
        return;
      }
      // default: no-auth CNXN reply with the given banner
      s.end(adbPacket(A_CNXN, { arg0: A_VERSION, arg1: ADB_PROBE_MAXDATA, payload: Buffer.from(banner, 'utf8') }));
    });
  });
  return server;
}

async function listen(server) {
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  return server.address().port;
}

// ---------------------------------------------------------------- healthy paths

test('fake adbd: no-auth CNXN reply → healthy, version carries type + protocol', async () => {
  let saw = false;
  const server = makeFakeAdbd({ sawCnxn: (v) => { saw = v; } });
  const port = await listen(server);
  const r = await adbCnxnProbe('127.0.0.1', port, 2_000);
  assert.equal(r.healthy, true, r.detail);
  assert.equal(r.detail, null);
  assert.equal(r.version, 'adb-device@0x1000001');
  assert.equal(saw, true, 'the probe must send a VALID CNXN (adbd ignores everything else)');
  await server.close();
});

test('fake adbd: recovery banner → healthy (booted-into-recovery is a live device)', async () => {
  const server = makeFakeAdbd({ banner: RECOVERY_BANNER });
  const port = await listen(server);
  const r = await adbCnxnProbe('127.0.0.1', port, 2_000);
  assert.equal(r.healthy, true, r.detail);
  assert.equal(r.version, 'adb-recovery@0x1000001');
  await server.close();
});

test('fake adbd: reply split across chunks → still healthy (reassembly)', async () => {
  const full = adbPacket(A_CNXN, { arg0: A_VERSION, arg1: ADB_PROBE_MAXDATA, payload: Buffer.from(DEVICE_BANNER, 'utf8') });
  const server = net.createServer((s) => {
    let buf = Buffer.alloc(0);
    let sent = 0;
    s.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 24) return;
      const p = parseAdbPacket(buf);
      if (p.state !== 'ok' || p.command !== A_CNXN || !p.magicValid) return;
      // drip the reply in three pieces (TCP says nothing about boundaries)
      s.write(full.subarray(0, 10));
      setTimeout(() => s.write(full.subarray(10, 24)), 5);
      setTimeout(() => s.end(full.subarray(24)), 10);
      void sent;
    });
  });
  const port = await listen(server);
  const r = await adbCnxnProbe('127.0.0.1', port, 2_000);
  assert.equal(r.healthy, true, r.detail);
  assert.equal(r.version, 'adb-device@0x1000001');
  await server.close();
});

// ---------------------------------------------------------------- negative paths

test('fake adbd: nothing listening → unhealthy ECONNREFUSED (booting/dead adbd)', async () => {
  const server = net.createServer(() => {});
  const port = await listen(server);
  await new Promise((res) => server.close(res)); // close → the port is refused
  const r = await adbCnxnProbe('127.0.0.1', port, 1_500);
  assert.equal(r.healthy, false);
  assert.match(r.detail, /ECONNREFUSED/);
  assert.equal(r.version, null);
});

test('fake adbd: silent (accepts, never answers) → unhealthy no-reply timeout', async () => {
  const server = makeFakeAdbd({ reply: 'silent' });
  const port = await listen(server);
  const t0 = Date.now();
  const r = await adbCnxnProbe('127.0.0.1', port, 400);
  const ms = Date.now() - t0;
  assert.equal(r.healthy, false);
  assert.match(r.detail, /no ADB reply within 400ms/);
  assert.ok(ms < 2_000, `the probe must honour its timeout budget (took ${ms}ms)`);
  await server.close();
});

test('fake adbd: garbage reply (bad magic) → unhealthy not-an-ADB-endpoint', async () => {
  const server = makeFakeAdbd({ reply: 'garbage' });
  const port = await listen(server);
  const r = await adbCnxnProbe('127.0.0.1', port, 1_500);
  assert.equal(r.healthy, false);
  assert.match(r.detail, /not an ADB endpoint/i);
  await server.close();
});

test('fake adbd: A_AUTH reply → unhealthy, actionable auth detail (device alive, misconfigured)', async () => {
  const server = makeFakeAdbd({ reply: 'auth' });
  const port = await listen(server);
  const r = await adbCnxnProbe('127.0.0.1', port, 1_500);
  assert.equal(r.healthy, false);
  assert.match(r.detail, /authentication required/);
  await server.close();
});

test('fake adbd: A_STLS reply → unhealthy, actionable TLS detail', async () => {
  const server = makeFakeAdbd({ reply: 'stls' });
  const port = await listen(server);
  const r = await adbCnxnProbe('127.0.0.1', port, 1_500);
  assert.equal(r.healthy, false);
  assert.match(r.detail, /TLS/);
  await server.close();
});

test('fake adbd: CNXN with unrecognized banner type → unhealthy (alive but wrong endpoint kind)', async () => {
  const server = makeFakeAdbd({ reply: 'bad-banner' });
  const port = await listen(server);
  const r = await adbCnxnProbe('127.0.0.1', port, 1_500);
  assert.equal(r.healthy, false);
  assert.match(r.detail, /unrecognized banner/);
  await server.close();
});

test('fake adbd: never answers even a valid CNXN (verifyCnxn off) → timeout, and the CNXN WAS sent', async () => {
  let saw = false;
  const server = makeFakeAdbd({ verifyCnxn: false, sawCnxn: (v) => { saw = v; } });
  const port = await listen(server);
  const r = await adbCnxnProbe('127.0.0.1', port, 400);
  assert.equal(r.healthy, false);
  assert.match(r.detail, /no ADB reply/);
  assert.equal(saw, true, 'handshake attempted (this is what the bare-command probe never did)');
  await server.close();
});

test('probe: hostile server streaming >64KB → unhealthy oversized, bounded memory', async () => {
  const server = net.createServer((s) => {
    let buf = Buffer.alloc(0);
    s.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 24) return;
      const p = parseAdbPacket(buf);
      if (p.state !== 'ok' || p.command !== A_CNXN || !p.magicValid) return;
      // claim 70_000 payload bytes, then stream garbage forever
      const h = Buffer.alloc(24);
      h.writeUInt32LE(A_CNXN, 0);
      h.writeUInt32LE(A_VERSION, 4);
      h.writeUInt32LE(ADB_PROBE_MAXDATA, 8);
      h.writeUInt32LE(70_000, 12);
      h.writeUInt32LE(0, 16);
      h.writeUInt32LE(adbMagic(A_CNXN), 20);
      s.write(h);
      const flood = Buffer.alloc(8_192, 0x41);
      const timer = setInterval(() => s.write(flood), 5);
      s.once('close', () => clearInterval(timer));
    });
  });
  const port = await listen(server);
  const r = await adbCnxnProbe('127.0.0.1', port, 2_000);
  assert.equal(r.healthy, false);
  assert.match(r.detail, /oversized|not an ADB endpoint/i);
  await new Promise((res) => server.close(res));
});
