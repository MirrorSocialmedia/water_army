/**
 * Unit tests — stream-sidecar server (auth gate, serial allowlist, capacity,
 * unknown routes). The sidecar is launched as a child process on an
 * ephemeral-ish scratch port; NO device / adb is touched (session start is
 * never exercised here — that is the P2 E2E on the real redroid device).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const SIDECAR = fileURLToPath(new URL('../../apps/stream-sidecar/src/server.js', import.meta.url));
const PORT = 16497; // scratch approved window (16400-16499); tests only
const TOKEN = 'test-token-' + 'b'.repeat(50);

function startSidecar(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SIDECAR], {
      env: {
        ...process.env,
        SIDECAR_PORT: String(PORT),
        STREAM_SIDECAR_TOKEN: TOKEN,
        SCRCPY_JAR_SHA256: 'c'.repeat(64),
        SCRCPY_JAR: '/nonexistent.jar',
        REDROID_ADB_BINARY: '/nonexistent/adb',
        SIDECAR_ADB_RANGE_START: '16500',
        SIDECAR_ADB_RANGE_END: '16549',
        SIDECAR_FWD_RANGE_START: '16490',
        SIDECAR_FWD_RANGE_END: '16496',
        SIDECAR_MAX_SESSIONS: '2',
        LOG_LEVEL: 'silent',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    // readiness = /health answers
    const deadline = Date.now() + 8000;
    (async () => {
      for (;;) {
        try {
          const r = await httpJson('/health');
          if (r.status === 200) return resolve({ child, kill: () => child.kill('SIGTERM') });
        } catch {}
        if (Date.now() > deadline) {
          child.kill('SIGKILL');
          return reject(new Error(`sidecar did not become healthy:\n${out}`));
        }
        await new Promise((res) => setTimeout(res, 200));
      }
    })();
  });
}

function httpJson(path) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path, timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    });
    req.on('error', () => resolve({ status: 0, body: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null }); });
  });
}

/** Open a WS to the sidecar and collect frames until a predicate or timeout. */
function wsCollect(token = TOKEN, session = null, { timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const frames = [];
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`wsCollect timeout; frames=${JSON.stringify(frames)}`));
    }, timeoutMs);
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      frames.push(m);
      if (m.t === 'auth-ok' && session) {
        ws.send(JSON.stringify(session));
        return;
      }
      if (m.t === 'error' || m.t === 'ready' || m.t === 'dead' || m.t === 'auth-ok' && !session) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(frames);
      }
    });
    ws.on('open', () => {
      if (token !== undefined) ws.send(JSON.stringify({ t: 'auth', token }));
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

test('sidecar: /health ok + /sessions empty', async () => {
  const sidecar = await startSidecar();
  try {
    const h = await httpJson('/health');
    assert.equal(h.status, 200);
    assert.equal(h.body.ok, true);
    const s = await httpJson('/sessions');
    assert.equal(s.status, 200);
    assert.equal(s.body.sessions.length, 0);
    assert.equal(s.body.maxSessions, 2);
    const nf = await httpJson('/nope');
    assert.equal(nf.status, 404);
  } finally {
    sidecar.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test('sidecar: wrong/missing token → SIDECAR_AUTH_FAILED (1008)', async () => {
  const sidecar = await startSidecar();
  try {
    const frames = await wsCollect('wrong-token');
    assert.ok(frames.some((f) => f.t === 'error' && f.code === 'SIDECAR_AUTH_FAILED'));
  } finally {
    sidecar.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test('sidecar: valid auth but non-loopback serial → SIDECAR_SERIAL_NOT_ALLOWED', async () => {
  const sidecar = await startSidecar();
  try {
    const frames = await wsCollect(TOKEN, {
      t: 'session', leaseId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', serial: '10.9.8.7:16500',
      userId: 'u1', mode: 'viewer', videoSource: 'screencap', quality: 'low',
    });
    assert.ok(frames.some((f) => f.t === 'error' && f.code === 'SIDECAR_SERIAL_NOT_ALLOWED'));
  } finally {
    sidecar.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test('sidecar: serial outside the allowlist RANGE → SIDECAR_SERIAL_NOT_ALLOWED', async () => {
  const sidecar = await startSidecar();
  try {
    const frames = await wsCollect(TOKEN, {
      t: 'session', leaseId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', serial: '127.0.0.1:15000',
      userId: 'u1', mode: 'viewer', videoSource: 'screencap', quality: 'low',
    });
    assert.ok(frames.some((f) => f.t === 'error' && f.code === 'SIDECAR_SERIAL_NOT_ALLOWED'));
  } finally {
    sidecar.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test('sidecar: bad lease id shape → SIDECAR_BAD_LEASE_ID', async () => {
  const sidecar = await startSidecar();
  try {
    const frames = await wsCollect(TOKEN, {
      t: 'session', leaseId: 'UPPER_CASE_ID!!', serial: '127.0.0.1:16500',
      userId: 'u1', mode: 'viewer', videoSource: 'screencap', quality: 'low',
    });
    assert.ok(frames.some((f) => f.t === 'error' && f.code === 'SIDECAR_BAD_LEASE_ID'));
  } finally {
    sidecar.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test('sidecar: lease id must be UUID shape (stream_leases.id is @db.Uuid — cuid-style ids rejected)', async () => {
  const sidecar = await startSidecar();
  try {
    const frames = await wsCollect(TOKEN, {
      t: 'session', leaseId: 'a1234567890', serial: '127.0.0.1:16500',
      userId: 'u1', mode: 'viewer', videoSource: 'screencap', quality: 'low',
    });
    assert.ok(frames.some((f) => f.t === 'error' && f.code === 'SIDECAR_BAD_LEASE_ID'));
  } finally {
    sidecar.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test('sidecar: no token env → refuses to start (fail-closed, exit 2)', async () => {
  const child = spawn(process.execPath, [SIDECAR], {
    env: { ...process.env, SIDECAR_PORT: String(PORT + 1), STREAM_SIDECAR_TOKEN: '', SCRCPY_JAR_SHA256: 'c'.repeat(64) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const code = await new Promise((res) => {
    let out = '';
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (c) => res({ code: c, out }));
  });
  assert.equal(code.code, 2);
  assert.match(code.out, /STREAM_SIDECAR_TOKEN/);
});


// ---- adbExec binary preservation (P2 E2E run #8 fix) ---------------------------
// The old adbExec did `out: String(out ?? '')` — execFile hands back a Buffer
// for raw exec-out output, and String() utf8-decodes it. For `exec-out
// screencap -p` that is (1) a binary-corruption hazard and (2) a plain JS
// string with no .buffer — the screencap loop's
// `new DataView(res.out.buffer, res.out.byteOffset, res.out.byteLength)` threw
// "First argument to DataView constructor must be an ArrayBuffer" and every
// session died ~1s after ready (observed live in run #8: ready → dead loop,
// then reconnects hitting SIDECAR_SESSION_EXISTS).
test('adbExec preserves binary exec-out bytes (screencap PNG contract)', async () => {
  const fs = await import('node:fs');
  const { adbExec } = await import('../../apps/stream-sidecar/src/session.js');
  // fake adb = a Node script (sh printf cannot emit reliable binary — \xNN is
  // not interpreted by POSIX sh). Emits: PNG signature + IHDR width=720
  // (0x2D0) height=1280 (0x500) + high bytes 0xFF/0x80 that utf8 would mangle.
  const fakeAdb = '/tmp/mc-fake-adb-screencap.mjs';
  fs.writeFileSync(
    fakeAdb,
    [
      '#!/usr/bin/env node',
      'process.stdout.write(Buffer.from([',
      '0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,',
      '0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,',
      '0x00,0x00,0x02,0xd0,0x00,0x00,0x05,0x00,',
      '0xff,0x80,0x89,0x45,0x58,0x54,0x52,0x41]));',
    ].join('\n'),
  );
  fs.chmodSync(fakeAdb, 0o755);
  try {
    const res = await adbExec(fakeAdb, ['-s', '127.0.0.1:16500', 'exec-out', 'screencap', '-p']);
    assert.equal(res.code, 0);
    assert.ok(Buffer.isBuffer(res.out), 'out must be a Buffer');
    assert.equal(res.out.readUInt32BE(0), 0x89504e47, 'PNG magic preserved');
    assert.equal(res.out[24], 0xff, 'high byte (>0x7f) survives');
    assert.equal(res.out[25], 0x80, 'high byte (0x80) survives');
    // the exact DataView access pattern the screencap loop uses
    const dv = new DataView(res.out.buffer, res.out.byteOffset, res.out.byteLength);
    assert.equal(dv.getUint32(16), 720, 'width from IHDR');
    assert.equal(dv.getUint32(20), 1280, 'height from IHDR');
    assert.equal(typeof res.outText, 'string', 'text callers get a utf8 string');
  } finally {
    fs.rmSync(fakeAdb, { force: true });
  }
});
