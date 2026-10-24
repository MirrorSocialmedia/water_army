/**
 * P5 hardening — stream-sidecar inbound hardening (MD §11.9 DoS surface):
 *
 *  1. maxPayload: the API tunnel is a blind byte pipe, so the sidecar's WS
 *     layer is the only inbound size boundary. `ws`'s DEFAULT maxPayload is
 *     100MB — a hostile browser client could push a 100MB frame per stream
 *     into the sidecar (memory spike × 5 streams). P5 caps it at 64 KiB
 *     (inbound frames are small JSON: auth/session/input/close/ping).
 *     A frame over the cap → protocol close 1009 (message too big); the
 *     server must stay healthy with zero sessions.
 *
 *  2. control-input rate limit: the gateway cannot count frames (blind
 *     pipe), so the sidecar enforces a per-session token bucket (30/sec
 *     sustained, 30 burst) on input frames. A stuck/spamming controller
 *     client cannot hammer the device + ADB.
 *
 * Like stream-sidecar-server.test.js: child process on an approved-window
 * scratch port; NO real device — the adb binary is a DUMMY SCRIPT that
 * sleeps, which parks session.start() in the 'starting' phase (state
 * STARTING) so input frames are ACCEPTED into the protocol path and
 * rejected by session.input with STREAM_NOT_LIVE — exactly the surface
 * the rate bucket guards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const SIDECAR = fileURLToPath(new URL('../../apps/stream-sidecar/src/server.js', import.meta.url));
const PORT = 16499; // scratch approved window (16400-16499); tests only
const TOKEN = 'p5test-token-' + 'c'.repeat(50);
const LEASE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

/** adb that sleeps — parks the session in STARTING for the input tests. */
function makeSlowAdb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-slow-adb-'));
  const p = path.join(dir, 'adb');
  fs.writeFileSync(p, '#!/bin/sh\nsleep 25\n');
  fs.chmodSync(p, 0o755);
  return { p, dir };
}

function startSidecar(env = {}) {
  const slow = makeSlowAdb();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SIDECAR], {
      env: {
        ...process.env,
        SIDECAR_PORT: String(PORT),
        STREAM_SIDECAR_TOKEN: TOKEN,
        SCRCPY_JAR_SHA256: 'c'.repeat(64),
        SCRCPY_JAR: '/nonexistent.jar',
        REDROID_ADB_BINARY: slow.p,
        SIDECAR_ADB_RANGE_START: '16500',
        SIDECAR_ADB_RANGE_END: '16549',
        SIDECAR_FWD_RANGE_START: '16480',
        SIDECAR_FWD_RANGE_END: '16489',
        SIDECAR_MAX_SESSIONS: '5',
        LOG_LEVEL: 'silent',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    const deadline = Date.now() + 8000;
    (async () => {
      for (;;) {
        try {
          const r = await httpJson('/health');
          if (r.status === 200) {
            return resolve({
              child,
              kill: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } fs.rmSync(slow.dir, { recursive: true, force: true }); },
            });
          }
        } catch { /* not up yet */ }
        if (Date.now() > deadline) {
          child.kill('SIGKILL');
          fs.rmSync(slow.dir, { recursive: true, force: true });
          return reject(new Error(`sidecar did not become healthy:\n${out}`));
        }
        await new Promise((res) => setTimeout(res, 200));
      }
    })();
  });
}

function httpJson(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    });
    req.on('error', () => resolve({ status: 0, body: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null }); });
  });
}

test('oversized inbound frame (> 64 KiB cap) → close 1009, server stays healthy, zero sessions', async () => {
  const sidecar = await startSidecar();
  try {
    const closeCode = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      const timer = setTimeout(() => { try { ws.terminate(); } catch { /* */ } reject(new Error('timeout waiting for 1009')); }, 8000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ t: 'auth', token: TOKEN }));
      });
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t === 'auth-ok') {
          // 100 KiB text frame — over the 64 KiB cap (P5 hardening).
          ws.send('x'.repeat(100_000));
        }
      });
      ws.on('close', (code) => { clearTimeout(timer); resolve(code); });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    assert.equal(closeCode, 1009, 'ws protocol close 1009 = message too big');
    const h = await httpJson('/health');
    assert.equal(h.status, 200, 'server healthy after oversized frame');
    assert.equal(h.body.sessions, 0, 'no session leak from the rejected connection');
  } finally {
    sidecar.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test('input flood (35 taps back-to-back) → bucket allows ~30, rejects the rest with STREAM_INPUT_RATE_LIMITED', async () => {
  const sidecar = await startSidecar();
  try {
    const rejected = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      const frames = [];
      const timer = setTimeout(() => { try { ws.terminate(); } catch { /* */ } reject(new Error(`timeout; got ${frames.length}/35 rejections`)); }, 30_000);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'auth', token: TOKEN })));
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t === 'auth-ok') {
          // valid session frame → phase 'starting' (the slow adb parks
          // session.start() in STARTING — input reaches the protocol path)
          ws.send(JSON.stringify({
            t: 'session', leaseId: LEASE, serial: '127.0.0.1:16500',
            userId: 'u-p5', mode: 'controller', videoSource: 'screencap', quality: 'low',
          }));
          // flush 35 taps as fast as possible
          for (let i = 0; i < 35; i += 1) {
            ws.send(JSON.stringify({ t: 'input', kind: 'tap', x0: 0.5, y0: 0.5 }));
          }
          return;
        }
        if (m.t === 'input-rejected') {
          frames.push(m.code);
          if (frames.length === 35) { clearTimeout(timer); try { ws.close(); } catch { /* */ } resolve(frames); }
        }
      });
      ws.on('close', () => { /* settled via frames or timer */ });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    const rateLimited = rejected.filter((c) => c === 'STREAM_INPUT_RATE_LIMITED').length;
    const notLive = rejected.filter((c) => c === 'STREAM_NOT_LIVE').length;
    assert.equal(rejected.length, 35, 'every input gets an explicit rejection (no silent drops)');
    assert.ok(rateLimited >= 3 && rateLimited <= 8, `~5 of 35 must be rate limited (got ${rateLimited})`);
    assert.ok(notLive >= 27 && notLive <= 32, `bucket must pass ~30 through (got ${notLive})`);
  } finally {
    sidecar.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});
