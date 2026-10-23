#!/usr/bin/env node
/**
 * Mobile Console PoC — thin scrcpy-v5.0.1 streaming sidecar (MD §14 Phase 0)
 *
 * WHAT THIS IS
 *   A disposable PoC of the product `apps/stream` sidecar concept (ADR-019):
 *     adb (pinned binary) -> push pinned scrcpy-server jar (sha256 verified)
 *     -> launch fixed app_process template (scid server-generated)
 *     -> adb forward tcp:<p> localabstract:scrcpy_<scid>
 *     -> speak the scrcpy v5.0.1 wire protocol (video + control)
 *     -> relay video to a local browser page (WS, 127.0.0.1 only) + accept
 *        touch/key control JSON.
 *
 * POC-ONLY RELAXATIONS (documented, NOT product behavior):
 *   - no auth/ticket/lease (single local operator; product = ADR-019 MC-3)
 *   - no docker socket, no shell, no file mgmt, no APK (by construction)
 *   - adb ops are a FIXED list built from server-side constants only:
 *     get-state / push (single pinned jar) / forward / forward --remove /
 *     exec-out sha256sum (fixed file) / shell <FIXED app_process template>
 *     — no user-supplied value ever reaches an adb argument.
 *
 * Evidence written to $EVID (JSON stats + server log + screenshots by driver).
 */
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// PoC borrows a locally-present ws (openclaw dep, v8.20.0). The PRODUCT sidecar
// (apps/stream) pins its own ws@8.22.0 per ADR-019.
const WebSocket = require('/usr/lib/node_modules/openclaw/node_modules/ws');

// ---- pinned constants (ADR-019) -------------------------------------------
const SCRCPY_VERSION = '5.0.1';
const JAR_REMOTE = '/data/local/tmp/scrcpy-server.jar';
const CODEC_NAMES = { 0x68323634: 'h264', 0x68323635: 'h265', 0x00617631: 'av1', 0x00767038: 'vp8', 0x00767039: 'vp9' };

// ---- env -------------------------------------------------------------------
const ADB = process.env.ADB ?? `${process.env.HOME}/.local/share/platform-tools/adb`;
const SERIAL = process.env.SERIAL; // e.g. 127.0.0.1:16500
const JAR = process.env.JAR;
const JAR_SHA256 = process.env.JAR_SHA256;
const FWD_VIDEO = Number(process.env.FWD_VIDEO ?? 16546);
const FWD_CONTROL = Number(process.env.FWD_CONTROL ?? 16547);
const PORT = Number(process.env.PORT ?? 16545);
const EVID = process.env.EVID ?? '/tmp/mobileconsole-poc-evid';
const VIDEO_BIT_RATE = Number(process.env.VIDEO_BIT_RATE ?? 2_000_000);
const MAX_SIZE = Number(process.env.MAX_SIZE ?? 720);
const MAX_FPS = Number(process.env.MAX_FPS ?? 15);
const VIDEO_SOURCE = (process.env.VIDEO_SOURCE ?? 'scrcpy').toLowerCase(); // scrcpy | screencap (degraded)
if (!['scrcpy', 'screencap'].includes(VIDEO_SOURCE)) {
  console.error('bad VIDEO_SOURCE (expected scrcpy|screencap)');
  process.exit(2);
}

if (!SERIAL || !JAR) {
  console.error('usage: ADB=... SERIAL=127.0.0.1:16500 JAR=/path/scrcpy-server JAR_SHA256=... node poc-sidecar.mjs');
  process.exit(2);
}
mkdirSync(EVID, { recursive: true });
const ev = (obj) => appendFileSync(path.join(EVID, 'sidecar-events.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');

// ---- adb helper (fixed ops only; arg arrays, no shell strings at adb level) ----
function adb(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(ADB, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.trim(), err: err.trim() }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
  });
}
// Binary-safe adb (screencap PNG relay must not pass stdout through string codec)
function adbBuf(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(ADB, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const outChunks = [], errChunks = [];
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => outChunks.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: Buffer.concat(outChunks), err: Buffer.concat(errChunks).toString().trim() }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: Buffer.alloc(0), err: String(e) }); });
  });
}

// ---- stream state -----------------------------------------------------------
const state = {
  phase: 'SETUP', // SETUP | CONNECTING | LIVE | DEAD
  deviceName: null, codecId: null, codec: null, width: null, height: null,
  frames: 0, keyframes: 0, configPackets: 0, bytes: 0,
  windowStart: Date.now(), windowBytes: 0, windowFrames: 0,
  lastFrameAt: null, lastKeyframeAt: null, keyframeIntervalsMs: [],
  serverAlive: false, startedAt: new Date().toISOString(), deadReason: null,
};
const clients = new Set();

function publishState() {
  const now = Date.now();
  const span = Math.max(1, now - state.windowStart);
  const stats = {
    phase: state.phase,
    deviceName: state.deviceName, codec: state.codec, width: state.width, height: state.height,
    frames: state.frames, keyframes: state.keyframes, configPackets: state.configPackets,
    fps: +(state.windowFrames * 1000 / span).toFixed(1),
    mbps: +((state.windowBytes * 8) / span / 1000).toFixed(2),
    lastFrameAgeMs: state.lastFrameAt ? now - state.lastFrameAt : null,
    lastKeyframeIntervalMs: state.keyframeIntervalsMs.at(-1) ?? null,
    serverAlive: state.serverAlive,
    deadReason: state.deadReason,
    clients: clients.size,
    startedAt: state.startedAt,
  };
  for (const c of clients) {
    if (c.readyState === 1) c.send(JSON.stringify({ kind: 'state', ...stats }));
  }
  return stats;
}

function kill(reason) {
  if (state.phase === 'DEAD') return;
  state.phase = 'DEAD';
  state.deadReason = reason;
  ev({ event: 'DEAD', reason });
  for (const c of clients) {
    try { c.send(JSON.stringify({ kind: 'dead', reason })); c.close(1011, reason); } catch {}
  }
  setTimeout(() => process.exit(3), 500);
}

// ---- socket reader (persistent 'data' listener; no gap => no lost chunks) -------
// NOTE: a naive reader that only attaches 'data' listeners while waiting loses
// chunks that arrive in the gap between waits (socket stays in flowing mode).
// BufferedSocket keeps one permanent listener and a central buffer instead.
class BufferedSocket {
  constructor(sock, initial = null) {
    this.s = sock;
    this.buf = initial ? Buffer.from(initial) : Buffer.alloc(0);
    this.waiter = null;
    this.err = null;
    this.discard = false; // true = drop inbound data (drain mode after handshake)
    sock.on('data', (d) => {
      if (this.discard) return;
      this.buf = Buffer.concat([this.buf, d]);
      this._wake();
    });
    sock.on('error', (e) => { this.err = this.err ?? e; this._wake(); });
    sock.on('close', () => { this._wake(); });
  }
  _wake() {
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(); }
  }
  async next(n) {
    for (;;) {
      if (this.buf.length >= n) {
        const out = this.buf.subarray(0, n);
        this.buf = this.buf.subarray(n);
        return Buffer.from(out);
      }
      if (this.err) throw this.err;
      if (this.s.closed) throw new Error('socket closed');
      await new Promise((res) => { this.waiter = res; });
    }
  }
}

// ---- control message encoders (scrcpy v5.0.1 ControlMessageReader parity) ----
const b1 = (v) => Buffer.from([v & 0xff]);
const b2 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff, 0); return b; };
const b4 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0, 0); return b; };
const b8 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v), 0); return b; };

function ctrlTouch(action, pointerId, x, y, screenW, screenH, pressure = 1.0) {
  return Buffer.concat([
    b1(2), b1(action), b8(pointerId), b4(Math.round(x)), b4(Math.round(y)),
    b2(screenW), b2(screenH), b2(Math.round(pressure * 32768)), b4(0), b4(0),
  ]);
}
function ctrlKeycode(action, keycode, metaState = 0, repeat = 0) {
  return Buffer.concat([b1(0), b1(action), b4(keycode), b4(repeat), b4(metaState)]);
}
function ctrlScroll(x, y, screenW, screenH, hScroll, vScroll) {
  const i16 = (f) => Math.max(-32768, Math.min(32767, Math.round(f * 32768)));
  return Buffer.concat([b1(3), b4(Math.round(x)), b4(Math.round(y)), b2(screenW), b2(screenH), b2(i16(hScroll) & 0xffff), b2(i16(vScroll) & 0xffff), b4(0)]);
}
function ctrlBackOrScreenOn(action) { return Buffer.concat([b1(4), b1(action)]); }

let controlSocket = null;
function sendControl(msg) {
  if (!controlSocket || controlSocket.destroyed) return false;
  controlSocket.write(msg);
  ev({ event: 'control', msg: msg[0], bytes: msg.length }); // type byte only — never text content
  return true;
}

// ---- video protocol client (v5.0.1: dummy, 64B name, 4B codecId, 12B session, frames) ----
async function videoLoop(videoSock, firstChunk = null) {
  const r = new BufferedSocket(videoSock, firstChunk);
  const dummy = await r.next(1); // sendDummyByte (default true)
  ev({ event: 'video_dummy', byte: dummy[0] });
  const nameBytes = await r.next(64);
  state.deviceName = nameBytes.toString('utf8').replace(/\0+$/, '');
  const codecId = (await r.next(4)).readUInt32BE(0);
  state.codecId = codecId;
  state.codec = CODEC_NAMES[codecId] ?? `0x${codecId.toString(16)}`;
  const sessionFlags = (await r.next(4)).readUInt32BE(0);
  state.width = (await r.next(4)).readUInt32BE(0);
  state.height = (await r.next(4)).readUInt32BE(0);
  ev({ event: 'meta', deviceName: state.deviceName, codec: state.codec, width: state.width, height: state.height, sessionFlags });
  // session meta may repeat (display resize) — but first meta before frames; if the next
  // 12B is actually a frame header with a sane size, it will parse below.
  state.phase = 'LIVE';
  ev({ event: 'LIVE' });

  while (state.phase === 'LIVE') {
    const header = await r.next(12);
    if (header[0] & 0x80) {
      // mid-stream session packet (display resize): [0x80..R][width 4B][height 4B]
      const w = header.readUInt32BE(4);
      const h = header.readUInt32BE(8);
      if (!w || !h) throw new Error('bad session meta');
      state.width = w;
      state.height = h;
      ev({ event: 'session_meta', width: w, height: h });
      for (const c of clients) {
        if (c.readyState === 1) c.send(JSON.stringify({ kind: 'session', width: w, height: h }));
      }
      continue;
    }
    const ptsAndFlags = header.readBigUInt64BE(0);
    const isConfig = (ptsAndFlags & (1n << 62n)) !== 0n; // SC_PACKET_FLAG_CONFIG
    const isKey = (ptsAndFlags & (1n << 61n)) !== 0n; // SC_PACKET_FLAG_KEY_FRAME
    const size = header.readUInt32BE(8);
    if (size > 32 * 1024 * 1024) throw new Error(`bad frame size ${size}`);
    const payload = await r.next(size);
    if (isConfig) state.configPackets++;
    state.frames++;
    state.bytes += 12 + size;
    state.windowBytes += 12 + size;
    state.windowFrames++;
    state.lastFrameAt = Date.now();
    if (isKey) {
      state.keyframes++;
      const now = Date.now();
      if (state.lastKeyframeAt) state.keyframeIntervalsMs.push(now - state.lastKeyframeAt);
      state.keyframeIntervalsMs = state.keyframeIntervalsMs.slice(-20);
      state.lastKeyframeAt = now;
    }
    for (const c of clients) {
      if (c.readyState === 1) c.send(Buffer.concat([header, payload]));
    }
  }
}

// ---- screencap fallback video source (degraded mode) --------------------------
// Root cause on this redroid image (evidence: $EVID/gralloc-root-cause.md):
// the media HAL process (media.codec hw/android.hardware.media.omx@1.0-service)
// can only reach gralloc mapper 2.x (vendor ships only
// android.hardware.graphics.mapper@2.0-impl-2.1.so); mapper 3.x/4.x are NOT
// supported, so every MediaCodec surface-encoder (scrcpy, screenrecord) fails
// buffer allocation and produces ZERO frames. screencap bypasses MediaCodec
// entirely (SurfaceFlinger direct capture -> PNG, ~270ms/frame). Trade-off:
// ~2-3fps, no low-latency claim. Product decision item (ADR-019 §19.9).
const PNGF_MAGIC = 0x504e4746; // 'PNGF' — PoC binary frame tag for the console page
let scrSeq = 0;
async function screencapLoop() {
  state.codec = 'screencap-png';
  while (state.phase !== 'LIVE') {
    if (state.phase === 'DEAD') return;
    await new Promise((r) => setTimeout(r, 100)); // wait for control handshake
  }
  while (state.phase === 'LIVE') {
    const r = await adbBuf(['-s', SERIAL, 'exec-out', 'screencap', '-p'], { timeoutMs: 20_000 });
    if (state.phase !== 'LIVE') break;
    if (r.code !== 0 || r.out.length < 24) {
      ev({ event: 'screencap_fail', code: r.code, err: String(r.err).slice(0, 200) });
      continue;
    }
    const dv = new DataView(r.out.buffer, r.out.byteOffset, r.out.byteLength);
    const w = dv.getUint32(16), h = dv.getUint32(20); // PNG IHDR width/height
    if (!w || !h) { ev({ event: 'screencap_bad_png', len: r.out.length }); continue; }
    const first = state.width === null;
    state.width = w;
    state.height = h;
    state.frames++;
    state.bytes += r.out.length;
    state.windowBytes += r.out.length;
    state.windowFrames++;
    state.lastFrameAt = Date.now();
    if (first) {
      ev({ event: 'meta', deviceName: state.deviceName, codec: state.codec, width: w, height: h, source: 'screencap' });
      for (const c of clients) {
        if (c.readyState === 1) c.send(JSON.stringify({ kind: 'meta', deviceName: state.deviceName, codec: state.codec, width: w, height: h, version: SCRCPY_VERSION, mode: VIDEO_SOURCE }));
      }
    }
    const head = Buffer.alloc(16);
    head.writeUInt32BE(PNGF_MAGIC, 0);
    head.writeUInt32BE(w, 4);
    head.writeUInt32BE(h, 8);
    head.writeUInt32BE(++scrSeq, 12);
    const frame = Buffer.concat([head, r.out]);
    for (const c of clients) {
      if (c.readyState === 1) {
        c.send(frame);
        if (scrSeq <= 3 || scrSeq % 20 === 0) ev({ event: 'ws_send_pngf', seq: scrSeq, len: frame.length, buffered: c.bufferedAmount });
      }
    }
  }
}

// ---- connect with retry (JVM cold-start race; ADR-019 §19.8) -------------------
// `adb forward` succeeds as soon as the host listener is registered, but the
// scrcpy-server JVM takes SECONDS to create localabstract:scrcpy_<scid>. Until then
// TCP connects through the forward are accepted by adb and closed immediately
// (observed: connect->close in ~3ms). Upstream scrcpy client (server.c v5.0.1)
// handles this by connect + read-1-byte (the dummy byte the server writes after
// accept()); we do the same, with a 30s deadline / 250ms interval (superset of
// upstream 100 attempts x 100ms). Failed attempts are safe to retry: if the
// abstract socket does not exist yet, the device-side adbd refuses the
// connection and nothing is queued in the server's accept backlog.
async function connectWithRetry(label, port, { expectFirstByte = false, deadlineMs = 30_000, intervalMs = 250, maxAttempts = Infinity } = {}) {
  const deadline = Date.now() + deadlineMs;
  let attempt = 0;
  let lastReason = null;
  for (;;) {
    attempt++;
    const sock = new net.Socket();
    sock.setNoDelay(true);
    const { ok, reason, first } = await new Promise((resolve) => {
      let settled = false;
      const finish = (o) => { if (!settled) { settled = true; resolve(o); } };
      const onConnect = () => {
        if (!expectFirstByte) { finish({ ok: true }); return; }
        // Server writes the dummy byte (0) immediately after accept().
        // If the abstract socket was not ready, adb closes the conn instead.
        const to = setTimeout(() => finish({ ok: false, reason: 'no-dummy-byte(2s)' }), 2000);
        sock.once('data', (d) => { clearTimeout(to); finish({ ok: true, first: d }); });
      };
      const onClose = () => finish({ ok: false, reason: 'closed-before-ready' });
      const onError = (e) => finish({ ok: false, reason: 'error:' + e.message });
      sock.once('connect', onConnect);
      sock.once('close', onClose);
      sock.once('error', onError);
      sock.connect(port, '127.0.0.1');
    });
    if (ok) {
      ev({ event: `${label}_connected`, attempt, expectFirstByte });
      return { sock, first: first ?? null };
    }
    lastReason = reason;
    try { sock.destroy(); } catch {}
    ev({ event: `${label}_retry`, attempt, reason });
    if (attempt >= maxAttempts || Date.now() + intervalMs > deadline) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${label} connect failed after ${attempt} attempts / ${deadlineMs}ms (last=${lastReason})`);
}

// ---- main --------------------------------------------------------------------
async function main() {
  ev({ event: 'START', serial: SERIAL, jar: JAR, port: PORT, fwd: [FWD_VIDEO, FWD_CONTROL], videoSource: VIDEO_SOURCE });

  // 1) device must be online
  const st = await adb(['-s', SERIAL, 'get-state']);
  if (st.code !== 0 || st.out !== 'device') { ev({ event: 'FATAL', where: 'get-state', out: st.out, err: st.err }); process.exit(4); }
  ev({ event: 'adb_device_online' });

  // 2) push pinned jar + verify sha256 on device
  const localSha = createHash('sha256').update(readFileSync(JAR)).digest('hex');
  if (localSha !== JAR_SHA256) { ev({ event: 'FATAL', where: 'jar-local-sha256', localSha }); process.exit(5); }
  const push = await adb(['-s', SERIAL, 'push', JAR, JAR_REMOTE], { timeoutMs: 60_000 });
  if (push.code !== 0) { ev({ event: 'FATAL', where: 'jar-push', err: push.err }); process.exit(6); }
  const sum = await adb(['-s', SERIAL, 'exec-out', 'sha256sum', JAR_REMOTE], { timeoutMs: 15_000 });
  const remoteSha = sum.out.split(/\s+/)[0];
  if (remoteSha !== JAR_SHA256) { ev({ event: 'FATAL', where: 'jar-remote-sha256', remoteSha }); process.exit(7); }
  ev({ event: 'jar_verified', sha256: JAR_SHA256 });

  // 3) launch server (FIXED template; only server-generated scid + constants)
  // int32 range (server Options.parse uses Integer.parseInt radix 16 — must be <= 0x7FFFFFFF)
  const scid = (Math.floor(Math.random() * 0x7fffffff)).toString(16).padStart(8, '0');
  const videoOpts = VIDEO_SOURCE === 'scrcpy'
    ? `video=true video_bit_rate=${VIDEO_BIT_RATE} max_size=${MAX_SIZE} max_fps=${MAX_FPS} audio=false`
    : `video=false audio=false`;
  const launchCmd =
    `CLASSPATH=${JAR_REMOTE} app_process / com.genymobile.scrcpy.Server ${SCRCPY_VERSION} ` +
    `scid=${scid} log_level=INFO ${videoOpts} control=true tunnel_forward=true cleanup=true 2>&1`;
  const server = spawn(ADB, ['-s', SERIAL, 'shell', launchCmd], { stdio: ['ignore', 'pipe', 'pipe'] });
  state.serverAlive = true;
  const serverLog = path.join(EVID, 'scrcpy-server.log');
  const appendServerLog = (d) => appendFileSync(serverLog, d);
  server.stdout.on('data', appendServerLog);
  server.stderr.on('data', appendServerLog);
  server.on('close', (code) => {
    state.serverAlive = false;
    ev({ event: 'server_exited', code });
    if (state.phase !== 'DEAD') kill(`scrcpy server process exited (code=${code})`);
  });
  ev({ event: 'server_launched', scid });

  // 4) adb forward (host loopback) -> device abstract socket
  const fV = VIDEO_SOURCE === 'scrcpy'
    ? await adb(['-s', SERIAL, 'forward', `tcp:${FWD_VIDEO}`, `localabstract:scrcpy_${scid}`])
    : { code: 0, err: 'n/a (screencap mode: no video socket)' };
  const fC = await adb(['-s', SERIAL, 'forward', `tcp:${FWD_CONTROL}`, `localabstract:scrcpy_${scid}`]);
  if (fV.code !== 0 || fC.code !== 0) { ev({ event: 'FATAL', where: 'forward', fV: fV.err, fC: fC.err }); process.exit(8); }
  ev({ event: 'forwards_up', video: FWD_VIDEO, control: FWD_CONTROL, videoSource: VIDEO_SOURCE });

  // 5) connect — branch by video source:
  //    scrcpy:    video FIRST (server accept order video->control; control-first
  //               would be mis-accepted), retry + dummy-byte probe, then control
  //               single-attempt (server already passed accept for video; retry
  //               could double-queue a conn the server would mis-accept).
  //    screencap: control is the FIRST (and only) socket -> it receives the
  //               dummy byte AND the 64B device meta (Server.sendDeviceMeta
  //               writes to the first socket). Same JVM cold-start race -> retry.
  state.phase = 'CONNECTING';
  let videoTask;
  if (VIDEO_SOURCE === 'scrcpy') {
    let videoSock, videoFirst;
    try {
      ({ sock: videoSock, first: videoFirst } = await connectWithRetry('video', FWD_VIDEO, { expectFirstByte: true }));
    } catch (e) {
      ev({ event: 'FATAL', where: 'video_connect', e: String(e) });
      process.exit(11);
    }
    ev({ event: 'video_connected' });
    const controlConnect = (async () => {
      const { sock } = await connectWithRetry('control', FWD_CONTROL, { expectFirstByte: false, maxAttempts: 1 });
      controlSocket = sock;
      ev({ event: 'control_connected' });
      sock.on('data', (d) => { /* device->client messages: drain (no clipboard in MVP) */ });
      sock.on('error', (e) => ev({ event: 'control_error', e: String(e) }));
      sock.on('close', () => { if (state.phase === 'LIVE') kill('control socket closed'); });
    })().catch((e) => { ev({ event: 'FATAL', where: 'control_connect', e: String(e) }); process.exit(12); });
    const videoFail = (e) => { ev({ event: 'video_error', e: String(e) }); kill(String(e)); };
    videoSock.once('error', videoFail);
    videoSock.once('close', () => { if (state.phase !== 'DEAD') kill('video socket closed'); });
    videoTask = videoLoop(videoSock, videoFirst).catch((e) => {
      if (state.phase === 'LIVE' || state.phase === 'CONNECTING') videoFail(e);
    });
    await controlConnect;
  } else {
    const controlConnect = (async () => {
      const { sock, first } = await connectWithRetry('control', FWD_CONTROL, { expectFirstByte: true });
      controlSocket = sock;
      const r = new BufferedSocket(sock, first);
      await r.next(1); // dummy byte (first socket in this mode)
      const nameBytes = await r.next(64); // device meta
      state.deviceName = nameBytes.toString('utf8').replace(/\0+$/, '');
      ev({ event: 'control_connected', deviceName: state.deviceName, source: 'screencap' });
      r.discard = true; // remaining device->client messages: drain
      sock.on('error', (e) => ev({ event: 'control_error', e: String(e) }));
      sock.on('close', () => { if (state.phase === 'LIVE') kill('control socket closed'); });
      state.phase = 'LIVE';
      ev({ event: 'LIVE', source: 'screencap' });
    })().catch((e) => { ev({ event: 'FATAL', where: 'control_connect', e: String(e) }); process.exit(12); });
    const scrFail = (e) => { ev({ event: 'screencap_loop_error', e: String(e) }); kill(String(e)); };
    videoTask = screencapLoop().catch(scrFail);
    await controlConnect;
  }

  // 6) HTTP + WS (127.0.0.1 only)
  const pagePath = path.join(path.dirname(new URL(import.meta.url).pathname), 'poc-console.html');
  const wss = new WebSocket.Server({ noServer: true });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ev({ event: 'ws_client', clients: clients.size });
    ws.send(JSON.stringify({
      kind: 'meta', deviceName: state.deviceName, codec: state.codec,
      width: state.width, height: state.height, version: SCRCPY_VERSION, mode: VIDEO_SOURCE,
    }));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (!state.width || !state.height) return;
      const W = state.width, H = state.height;
      try {
        if (m.type === 'touch' && state.phase === 'LIVE') {
          const action = { down: 0, up: 1, move: 2 }[m.action];
          if (action === undefined) return;
          const x = Math.max(0, Math.min(W, Number(m.x) || 0));
          const y = Math.max(0, Math.min(H, Number(m.y) || 0));
          if (!sendControl(ctrlTouch(action, Number(m.pointerId) || 0, x, y, W, H))) return;
        } else if (m.type === 'key' && state.phase === 'LIVE') {
          const keycode = Number(m.keycode);
          const action = m.action === 'down' ? 0 : 1;
          if (!Number.isInteger(keycode) || keycode < 0) return;
          if (!sendControl(ctrlKeycode(action, keycode))) return;
        } else if (m.type === 'scroll' && state.phase === 'LIVE') {
          if (!sendControl(ctrlScroll(Number(m.x) || 0, Number(m.y) || 0, W, H, Number(m.h) || 0, Number(m.v) || 0))) return;
        }
      } catch (e) { ev({ event: 'control_reject', e: String(e) }); }
    });
    ws.on('close', (code, reason) => { clients.delete(ws); ev({ event: 'ws_close', code, reason: String(reason).slice(0, 120) }); });
    ws.on('error', (e) => { clients.delete(ws); ev({ event: 'ws_error', e: String(e) }); });
  });

  const http = createServer((req, res) => {
    if (req.url === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(publishState()));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(pagePath));
  });
  http.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  await new Promise((res) => http.listen(PORT, '127.0.0.1', res));
  ev({ event: 'http_listening', port: PORT });

  // 7) stats window + watchdog
  setInterval(() => { state.windowStart = Date.now(); state.windowBytes = 0; state.windowFrames = 0; publishState(); }, 5000).unref();
  setInterval(() => {
    if (state.phase === 'LIVE' && state.lastFrameAt && Date.now() - state.lastFrameAt > 15_000) {
      kill(`no video frame for 15s (lastFrameAgeMs=${Date.now() - state.lastFrameAt})`);
    }
  }, 5000).unref();

  const shutdown = async () => {
    ev({ event: 'SHUTDOWN' });
    try { await adb(['-s', SERIAL, 'forward', '--remove', `tcp:${FWD_VIDEO}`]); } catch {}
    try { await adb(['-s', SERIAL, 'forward', '--remove', `tcp:${FWD_CONTROL}`]); } catch {}
    try { server.kill('SIGKILL'); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await videoTask;
}

main().catch((e) => {
  try { ev({ event: 'CRASH', e: String(e?.stack ?? e) }); } catch {}
  process.exit(9);
});
