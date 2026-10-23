/**
 * StreamSession — one live stream for one lease (ADR-019 §19.11/§19.12).
 *
 * Lifecycle: STARTING → CONNECTING → LIVE → (DEGRADED → LIVE-screencap) → DEAD
 *
 * Design notes (all proven in the P0 PoC, evidence in
 * /home/kenneth/.openclaw/workspace/logs/mobileconsole-poc/):
 *  - scid is int32 (<= 0x7FFFFFFF) or the server never opens its sockets.
 *  - JVM cold-start race → connectWithRetry with a dummy-byte probe
 *    (upstream scrcpy server.c does connect + read-1-byte; we use a 30s
 *    deadline / 250ms interval superset).
 *  - `cleanup=false` (ADR-020): with 5 concurrent sessions a `cleanup=true`
 *    normal exit would delete the SHARED jar out from under another session's
 *    startup (ClassNotFoundException race). We re-push + sha256-verify on
 *    every session start, so the jar staying on-device is safe + idempotent.
 *  - VIDEO_SOURCE=auto (default): try scrcpy H.264 first; if the device
 *    produces ZERO video frames for 10s after LIVE (the gralloc-mapper
 *    failure signature on the pinned redroid image — ADR-019 §19.9), fall
 *    back to screencap-PNG and report DEGRADED. H.264 end-to-end on this
 *    image is NOT VERIFIED by design.
 *
 * Input policy (MD §3.3/§15.2): a viewer-mode session NEVER injects input
 * (read-only enforced here, at the protocol boundary, not just the UI).
 * Control-channel logging is redaction-safe: event type + byte length only
 * (never text content, never clipboard).
 */
import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  VIDEO, PNGF, QUALITY_PRESETS, DEFAULT_QUALITY,
  ctrlKeycode, ctrlText, ctrlTouch, ctrlScroll, ctrlBackOrScreenOn,
  TOUCH, KEY, KEYCODES,
} from './protocol.js';

const SCRCPY_VERSION = '5.0.1';

function adbExec(adb, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile(adb, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: String(out ?? ''), err: String(errOut ?? '') });
    });
  });
}

/**
 * Persistent-data socket reader (PoC BufferedSocket, verbatim behaviour):
 * one permanent 'data' listener + central buffer, so chunks arriving in the
 * gap between awaited reads are never lost (flowing-mode trap).
 */
class BufferedSocket {
  constructor(sock, initial = null) {
    this.s = sock;
    this.buf = initial ? Buffer.from(initial) : Buffer.alloc(0);
    this.waiter = null;
    this.err = null;
    this.discard = false;
    sock.on('data', (d) => {
      if (this.discard) return;
      this.buf = Buffer.concat([this.buf, d]);
      this._wake();
    });
    sock.on('error', (e) => { this.err = this.err ?? e; this._wake(); });
    sock.on('close', () => this._wake());
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

/**
 * @param {object} p
 * @param {string} p.leaseId
 * @param {string} p.serial        adb -s serial (127.0.0.1:port)
 * @param {string} p.mode          'viewer' | 'controller'
 * @param {string} p.videoSource   'auto' | 'scrcpy' | 'screencap'
 * @param {string} p.quality       preset name (validated by resolveQuality upstream)
 * @param {object} p.ports         { video, control } host loopback ports (released on kill)
 * @param {string} p.adb           adb binary path
 * @param {string} p.jar           local scrcpy-server jar path
 * @param {string} p.jarSha256     pinned sha256 of the jar
 * @param {string} p.jarRemote     device path for the jar
 * @param {(text:string)=>void} p.sendText      frame → gateway (browser)
 * @param {(buf:Buffer)=>void} p.sendBinary     frame → gateway (browser)
 * @param {import('pino').Logger} p.log
 * @param {number} p.zeroFrameMs   auto-degrade window (default 10_000)
 * @param {(reason:string)=>void} p.onDead
 */
export class StreamSession {
  constructor(p) {
    Object.assign(this, p);
    this.state = 'STARTING';
    this.deadReason = null;
    this.width = null;
    this.height = null;
    this.deviceName = null;
    this.frames = 0;
    this.keyframes = 0;
    this.bytes = 0;
    this.lastFrameAt = null;
    this.videoSourceActive = null; // 'scrcpy' | 'screencap'
    this.degraded = false;
    this.serverProc = null;
    this.controlSocket = null;
    this.videoSocket = null;
    this.watchdog = null;
    this._killCount = 0;
    this._modeSeq = 0; // generation counter: stale async events from a replaced mode must not kill the new one
    this._modeFrames = 0; // per-mode frame count (zero-frame detection is per mode, not per session)
  }

  _evt(obj) {
    this.log.info({ leaseId: this.leaseId, ...obj }, 'stream-session');
  }

  // ---- lifecycle ----------------------------------------------------------------
  async start() {
    // 1) device online?
    const st = await adbExec(this.adb, ['-s', this.serial, 'get-state']);
    if (st.code !== 0 || st.out.trim() !== 'device') {
      throw Object.assign(new Error(`adb device not online: ${st.out || st.err}`), { code: 'ADB_OFFLINE' });
    }
    // 2) push pinned jar + verify sha256 (idempotent; cleanup=true pitfall)
    const localSha = createHash('sha256').update(readFileSync(this.jar)).digest('hex');
    if (localSha !== this.jarSha256) throw new Error(`local scrcpy jar sha256 mismatch (${localSha})`);
    const push = await adbExec(this.adb, ['-s', this.serial, 'push', this.jar, this.jarRemote], { timeoutMs: 60_000 });
    if (push.code !== 0) throw new Error(`jar push failed: ${push.err}`.slice(0, 200));
    const sum = await adbExec(this.adb, ['-s', this.serial, 'exec-out', 'sha256sum', this.jarRemote], { timeoutMs: 15_000 });
    const remoteSha = sum.out.split(/\s+/)[0];
    if (remoteSha !== this.jarSha256) throw new Error(`remote scrcpy jar sha256 mismatch (${remoteSha})`);
    this._evt({ event: 'jar_verified' });
    await this._run(this.videoSource === 'auto' ? 'scrcpy' : this.videoSource);
  }

  /** Run one video-source mode; for 'auto' a failing scrcpy run → screencap. */
  async _run(mode) {
    // A fresh mode = a fresh lifecycle: the kill() re-entrancy guard is
    // per-run (ADR-020 req 6 — after a degrade, a LATER failure in the
    // screencap path must still be able to kill the session).
    this._killCount = 0;
    const isAuto = this.videoSource === 'auto' && mode === 'scrcpy';
    // Generation bump: any handler/scheduler still pending from a previous
    // mode (e.g. the dying scrcpy video socket's close event landing AFTER
    // we already degraded to screencap) must become a no-op. Zero-frame
    // timing restarts per mode (a stale anchor would kill a fresh, healthy
    // screencap tier on its first tick).
    const seq = (this._modeSeq += 1);
    this._modeFrames = 0;
    this.liveSince = Date.now();
    const scid = (Math.floor(Math.random() * 0x7fffffff)).toString(16).padStart(8, '0');
    const q = QUALITY_PRESETS[this.quality] ?? QUALITY_PRESETS[DEFAULT_QUALITY];
    const videoOpts = mode === 'scrcpy'
      ? `video=true video_bit_rate=${q.videoBitRate} max_size=${q.maxSize} max_fps=${q.maxFps} audio=false`
      : 'video=false audio=false';
    const launchCmd =
      `CLASSPATH=${this.jarRemote} app_process / com.genymobile.scrcpy.Server ${SCRCPY_VERSION} ` +
      `scid=${scid} log_level=INFO ${videoOpts} control=true tunnel_forward=true cleanup=false 2>&1`;

    this.serverProc = spawn(this.adb, ['-s', this.serial, 'shell', launchCmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.serverProc.stdout.on('data', () => {});
    this.serverProc.stderr.on('data', () => {});
    this.serverProc.on('error', (e) => this._evt({ event: 'server_spawn_error', e: String(e) }));
    this.serverProc.on('close', (code) => {
      this._evt({ event: 'server_exited', code });
      if (this.state !== 'DEAD') this.kill(`scrcpy server process exited (code=${code})`);
    });
    this._evt({ event: 'server_launched', mode, scid, quality: this.quality });

    // forwards (host loopback only)
    const fV = mode === 'scrcpy'
      ? await adbExec(this.adb, ['-s', this.serial, 'forward', `tcp:${this.ports.video}`, `localabstract:scrcpy_${scid}`])
      : { code: 0, err: 'n/a (screencap mode)' };
    const fC = await adbExec(this.adb, ['-s', this.serial, 'forward', `tcp:${this.ports.control}`, `localabstract:scrcpy_${scid}`]);
    if (fV.code !== 0 || fC.code !== 0) {
      this._cleanupForwards();
      throw new Error(`adb forward failed: ${fV.err || fC.err}`.slice(0, 200));
    }

    this.state = 'CONNECTING';
    this.sendText(JSON.stringify({ t: 'state', state: 'CONNECTING', source: mode }));

    const videoFail = (e) => {
      if (seq !== this._modeSeq) return; // stale event from a replaced mode
      // ADR-020 req 6 (degrade path, must be implemented): in auto mode ANY
      // scrcpy-side video failure — zero frames, encoder crash mid-stream,
      // socket death — cleans up the failed stream and falls back to
      // screencap, with the reason surfaced to the UI. (scrcpy-only / manual
      // modes have no lower tier → the session dies.)
      if (isAuto && this.state !== 'DEAD' && !this.degraded) {
        this._evt({ event: 'auto_degrade_trigger', frames: this.frames, e: String(e).slice(0, 200) });
        this._teardownMode();
        this.degraded = true;
        this.sendText(JSON.stringify({ t: 'degraded', source: 'screencap', reason: String(e).slice(0, 200) }));
        this._run('screencap').catch((e2) => this.kill(String(e2)));
        return;
      }
      this.kill(String(e));
    };

    if (mode === 'scrcpy') {
      // accept order: video FIRST, then control (single attempt — see PoC notes)
      const { sock: videoSock, first } = await this._connect('video', this.ports.video, { expectFirstByte: true });
      this.videoSocket = videoSock;
      this.videoLoop(videoSock, first).catch(videoFail);
      videoSock.once('error', videoFail);
      videoSock.once('close', () => { if (this.state === 'LIVE') videoFail(new Error('video socket closed')); });
      try {
        const { sock } = await this._connect('control', this.ports.control, { expectFirstByte: false, maxAttempts: 1 });
        this._attachControl(sock);
      } catch (e) {
        videoFail(e);
        return;
      }
    } else {
      // screencap: control is the first (only) socket → dummy byte + 64B meta
      const { sock, first } = await this._connect('control', this.ports.control, { expectFirstByte: true });
      const r = new BufferedSocket(sock, first);
      await r.next(1); // dummy byte
      const nameBytes = await r.next(64);
      this.deviceName = nameBytes.toString('utf8').replace(/\0+$/, '');
      r.discard = true;
      this._attachControl(sock);
      this.state = 'LIVE';
      this.videoSourceActive = 'screencap';
      this._evt({ event: 'LIVE', source: 'screencap', deviceName: this.deviceName });
      this.sendText(JSON.stringify({ t: 'state', state: 'LIVE', source: 'screencap', deviceName: this.deviceName }));
      this._screencapLoop().catch((e) => videoFail(e));
      this._startWatchdog();
    }
  }

  _attachControl(sock) {
    this.controlSocket = sock;
    sock.on('data', () => {}); // device→client messages: drain (no clipboard in MVP)
    sock.on('error', (e) => this._evt({ event: 'control_error', e: String(e) }));
    sock.on('close', () => { if (this.state === 'LIVE') this.kill('control socket closed'); });
  }

  // ---- video: scrcpy H.264 elementary stream ------------------------------------
  async videoLoop(videoSock, firstChunk) {
    const r = new BufferedSocket(videoSock, firstChunk);
    const dummy = await r.next(1);
    this._evt({ event: 'video_dummy', byte: dummy[0] });
    const nameBytes = await r.next(64);
    this.deviceName = nameBytes.toString('utf8').replace(/\0+$/, '');
    const codecId = (await r.next(4)).readUInt32BE(0);
    this.codec = VIDEO.CODEC_NAMES[codecId] ?? `0x${codecId.toString(16)}`;
    const sessionFlags = (await r.next(4)).readUInt32BE(0);
    this.width = (await r.next(4)).readUInt32BE(0);
    this.height = (await r.next(4)).readUInt32BE(0);
    this._evt({ event: 'meta', deviceName: this.deviceName, codec: this.codec, width: this.width, height: this.height, sessionFlags });
    this.state = 'LIVE';
    this.videoSourceActive = 'scrcpy';
    this._evt({ event: 'LIVE', source: 'scrcpy' });
    this.sendText(JSON.stringify({
      t: 'state', state: 'LIVE', source: 'scrcpy', codec: this.codec,
      width: this.width, height: this.height, deviceName: this.deviceName, degraded: this.degraded,
    }));
    this._startWatchdog();

    while (this.state === 'LIVE') {
      const header = await r.next(12);
      if (header[0] & 0x80) {
        const w = header.readUInt32BE(4);
        const h = header.readUInt32BE(8);
        if (!w || !h) throw new Error('bad session meta');
        this.width = w; this.height = h;
        this.sendText(JSON.stringify({ t: 'session', width: w, height: h }));
        continue;
      }
      const ptsAndFlags = header.readBigUInt64BE(0);
      const isKey = (ptsAndFlags & VIDEO.PACKET_FLAG_KEY_FRAME) !== 0n;
      const size = header.readUInt32BE(8);
      if (size > VIDEO.MAX_FRAME_SIZE) throw new Error(`bad frame size ${size}`);
      const payload = await r.next(size);
      this.frames++;
      this._modeFrames++;
      this.bytes += 12 + size;
      this.lastFrameAt = Date.now();
      if (isKey) this.keyframes++;
      this.sendBinary(Buffer.concat([header, payload]));
    }
  }

  // ---- video: screencap PNG polling (degraded mode) ------------------------------
  async _screencapLoop() {
    let seq = 0;
    while (this.state === 'LIVE' && this.videoSourceActive === 'screencap') {
      const res = await adbExec(this.adb, ['-s', this.serial, 'exec-out', 'screencap', '-p'], { timeoutMs: 20_000 });
      if (this.state !== 'LIVE') break;
      if (res.code !== 0 || res.out.length < 24) {
        this._evt({ event: 'screencap_fail', code: res.code, err: res.err.slice(0, 200) });
        await sleep(250);
        continue;
      }
      const dv = new DataView(res.out.buffer, res.out.byteOffset, res.out.byteLength);
      const w = dv.getUint32(16);
      const h = dv.getUint32(20);
      if (!w || !h) { await sleep(250); continue; }
      const first = this.width === null;
      this.width = w; this.height = h;
      this.frames++;
      this._modeFrames++;
      this.bytes += res.out.length;
      this.lastFrameAt = Date.now();
      if (first) {
        this.sendText(JSON.stringify({
          t: 'state', state: 'LIVE', source: 'screencap', codec: 'screencap-png',
          width: w, height: h, deviceName: this.deviceName, degraded: this.degraded,
        }));
      }
      const head = Buffer.alloc(16);
      head.writeUInt32BE(PNGF.MAGIC, 0);
      head.writeUInt32BE(w, 4);
      head.writeUInt32BE(h, 8);
      head.writeUInt32BE(++seq >>> 0, 12);
      this.sendBinary(Buffer.concat([head, res.out]));
    }
  }

  // ---- watchdog -------------------------------------------------------------------
  _startWatchdog() {
    if (this.watchdog) return;
    const ZERO_MS = Number(this.zeroFrameMs ?? 10_000);
    const STALL_MS = 15_000;
    this.watchdog = setInterval(() => {
      if (this.state !== 'LIVE') return;
      const age = this.lastFrameAt ? Date.now() - this.lastFrameAt : null;
      // auto mode, scrcpy active, zero frames since LIVE → the image-level
      // gralloc failure signature → degrade to screencap.
      if (this.videoSourceActive === 'scrcpy' && this._modeFrames === 0 && Date.now() - (this.liveSince ?? Date.now()) > ZERO_MS) {
        this._evt({ event: 'zero_frame_degrade' });
        this._teardownMode();
        this.degraded = true;
        this.sendText(JSON.stringify({ t: 'degraded', source: 'screencap', reason: 'no H.264 frames in 10s (device media HAL limitation)' }));
        this._run('screencap').catch((e) => this.kill(String(e)));
        return;
      }
      if (age !== null && age > STALL_MS) {
        // ADR-020 req 6: a stall AFTER frames were flowing is still a
        // degradable failure in auto mode (encoder died mid-stream); in
        // fixed modes there is no lower tier → kill.
        if (this.videoSource === 'auto' && this.videoSourceActive === 'scrcpy' && !this.degraded) {
          this._evt({ event: 'stall_degrade', ageMs: age });
          this._teardownMode();
          this.degraded = true;
          this.sendText(JSON.stringify({ t: 'degraded', source: 'screencap', reason: `no H.264 frame for ${Math.round(age / 1000)}s (encoder/stream stall)` }));
          this._run('screencap').catch((e) => this.kill(String(e)));
          return;
        }
        this.kill(`no video frame for ${Math.round(age / 1000)}s`);
        return;
      }
      // ADR-020 req 6 (screencap tier): if the bottom tier itself never
      // produced a frame (device capture dead), the session must not sit
      // LIVE forever — kill with a diagnosable reason.
      if (this.videoSourceActive === 'screencap' && this._modeFrames === 0 && Date.now() - (this.liveSince ?? Date.now()) > ZERO_MS) {
        this.kill(`screencap produced no frame in ${Math.round(ZERO_MS / 1000)}s (device capture unavailable)`);
      }
    }, 2_500);
    this.watchdog.unref?.();
    this.liveSince = this.liveSince ?? Date.now();
  }

  // ---- input (MD §3.3) -------------------------------------------------------------
  /**
   * @param {object} m gateway-parsed input frame:
   *   {kind:'tap'|'swipe', x0,y0,x1?,y1?} (normalized 0..1) |
   *   {kind:'key', name:string} | {kind:'text', text:string} |
   *   {kind:'scroll', x,y, dx,dy}
   * Viewer-mode sessions reject ALL input (read-only, protocol-level).
   * @returns {{ok:boolean, code?:string, message?:string}}
   */
  input(m) {
    if (this.state !== 'LIVE') return { ok: false, code: 'STREAM_NOT_LIVE', message: `session state ${this.state}` };
    if (this.mode !== 'controller') {
      this._evt({ event: 'input_rejected_readonly', kind: m?.kind });
      return { ok: false, code: 'STREAM_READ_ONLY', message: 'session is read-only (viewer lease)' };
    }
    if (!this.width || !this.height) return { ok: false, code: 'STREAM_NOT_LIVE', message: 'display size unknown yet' };
    const W = this.width;
    const H = this.height;
    const px = (v) => Math.max(0, Math.min(1, Number(v) || 0));
    try {
      switch (m?.kind) {
        case 'tap': {
          const x = Math.round(px(m.x0) * W);
          const y = Math.round(px(m.y0) * H);
          if (!this._send(ctrlTouch(TOUCH.DOWN, 1, x, y, W, H))) return { ok: false, code: 'STREAM_CONTROL_DOWN' };
          if (!this._send(ctrlTouch(TOUCH.UP, 1, x, y, W, H))) return { ok: false, code: 'STREAM_CONTROL_DOWN' };
          return { ok: true };
        }
        case 'swipe': {
          const x0 = Math.round(px(m.x0) * W);
          const y0 = Math.round(px(m.y0) * H);
          const x1 = Math.round(px(m.x1) * W);
          const y1 = Math.round(px(m.y1) * H);
          const steps = 8;
          if (!this._send(ctrlTouch(TOUCH.DOWN, 1, x0, y0, W, H))) return { ok: false, code: 'STREAM_CONTROL_DOWN' };
          for (let i = 1; i <= steps; i += 1) {
            const ix = Math.round(x0 + ((x1 - x0) * i) / steps);
            const iy = Math.round(y0 + ((y1 - y0) * i) / steps);
            if (!this._send(ctrlTouch(TOUCH.MOVE, 1, ix, iy, W, H))) return { ok: false, code: 'STREAM_CONTROL_DOWN' };
          }
          if (!this._send(ctrlTouch(TOUCH.UP, 1, x1, y1, W, H))) return { ok: false, code: 'STREAM_CONTROL_DOWN' };
          return { ok: true };
        }
        case 'key': {
          const kc = KEYCODES[String(m.name).toUpperCase()];
          if (kc === undefined) return { ok: false, code: 'STREAM_INPUT_UNKNOWN_KEY', message: `unknown key '${m.name}'` };
          if (!this._send(ctrlKeycode(KEY.DOWN, kc)) || !this._send(ctrlKeycode(KEY.UP, kc))) {
            return { ok: false, code: 'STREAM_CONTROL_DOWN' };
          }
          return { ok: true };
        }
        case 'text': {
          // REDACTION: the frame is forwarded byte-for-byte to the device
          // protocol; it is NEVER logged (only kind + length, below).
          const text = String(m.text ?? '');
          if (!text) return { ok: false, code: 'STREAM_INPUT_EMPTY_TEXT' };
          if (!this._send(ctrlText(text))) return { ok: false, code: 'STREAM_CONTROL_DOWN' };
          this._evt({ event: 'input_text', bytes: Buffer.byteLength(text) });
          return { ok: true };
        }
        case 'scroll': {
          const x = Math.round(px(m.x) * W);
          const y = Math.round(px(m.y) * H);
          if (!this._send(ctrlScroll(x, y, W, H, Number(m.dx) || 0, Number(m.dy) || 0))) {
            return { ok: false, code: 'STREAM_CONTROL_DOWN' };
          }
          return { ok: true };
        }
        case 'back':
          return this._send(ctrlBackOrScreenOn(0)) ? { ok: true } : { ok: false, code: 'STREAM_CONTROL_DOWN' };
        case 'screen_on':
          return this._send(ctrlBackOrScreenOn(1)) ? { ok: true } : { ok: false, code: 'STREAM_CONTROL_DOWN' };
        default:
          return { ok: false, code: 'STREAM_INPUT_UNKNOWN', message: `unknown input kind '${m?.kind}'` };
      }
    } catch (e) {
      this._evt({ event: 'input_error', kind: m?.kind, e: String(e).slice(0, 160) });
      return { ok: false, code: 'STREAM_INPUT_ERROR', message: String(e).slice(0, 160) };
    }
  }

  _send(buf) {
    if (!this.controlSocket || this.controlSocket.destroyed) return false;
    // redaction-safe log: command type byte + length only
    this._evt({ event: 'control', cmd: buf[0], bytes: buf.length });
    return this.controlSocket.write(buf);
  }

  // ---- teardown --------------------------------------------------------------------
  _teardownMode() {
    // stop the current scrcpy server + sockets + forwards (keep WS + session object)
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    if (this.videoSocket) { try { this.videoSocket.destroy(); } catch {} this.videoSocket = null; }
    if (this.controlSocket) { try { this.controlSocket.destroy(); } catch {} this.controlSocket = null; }
    this._cleanupForwards();
    if (this.serverProc) { try { this.serverProc.kill('SIGKILL'); } catch {} this.serverProc = null; }
  }

  _cleanupForwards() {
    const { video, control } = this.ports;
    const done = Promise.allSettled([
      adbExec(this.adb, ['-s', this.serial, 'forward', '--remove', `tcp:${video}`]),
      adbExec(this.adb, ['-s', this.serial, 'forward', '--remove', `tcp:${control}`]),
    ]);
    done.catch(() => {});
    return done;
  }

  kill(reason) {
    if (this.state === 'DEAD') return;
    this._killCount += 1;
    if (this._killCount > 1) return; // re-entrancy guard (watchdog + socket close)
    this.state = 'DEAD';
    this.deadReason = reason;
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    this._evt({ event: 'DEAD', reason: String(reason).slice(0, 200) });
    this._cleanupForwards();
    if (this.videoSocket) { try { this.videoSocket.destroy(); } catch {} this.videoSocket = null; }
    if (this.controlSocket) { try { this.controlSocket.destroy(); } catch {} this.controlSocket = null; }
    if (this.serverProc) { try { this.serverProc.kill('SIGKILL'); } catch {} this.serverProc = null; }
    try {
      this.sendText(JSON.stringify({ t: 'dead', reason: String(reason).slice(0, 200) }));
    } catch {}
    this.onDead?.(reason);
  }

  // ---- connect with retry (JVM cold-start race; ADR-019 §19.8) ----------------------
  async _connect(label, port, { expectFirstByte = false, deadlineMs = 30_000, intervalMs = 250, maxAttempts = Infinity } = {}) {
    const deadline = Date.now() + deadlineMs;
    let attempt = 0;
    let lastReason = null;
    for (;;) {
      attempt += 1;
      const sock = new net.Socket();
      sock.setNoDelay(true);
      const { ok, reason, first } = await new Promise((resolve) => {
        let settled = false;
        const finish = (o) => { if (!settled) { settled = true; resolve(o); } };
        sock.once('connect', () => {
          if (!expectFirstByte) { finish({ ok: true }); return; }
          const to = setTimeout(() => finish({ ok: false, reason: 'no-dummy-byte(2s)' }), 2_000);
          sock.once('data', (d) => { clearTimeout(to); finish({ ok: true, first: d }); });
        });
        sock.once('close', () => finish({ ok: false, reason: 'closed-before-ready' }));
        sock.once('error', (e) => finish({ ok: false, reason: `error:${e.message}` }));
        sock.connect(port, '127.0.0.1');
      });
      if (ok) {
        this._evt({ event: `${label}_connected`, attempt });
        return { sock, first: first ?? null };
      }
      lastReason = reason;
      try { sock.destroy(); } catch {}
      this._evt({ event: `${label}_retry`, attempt, reason });
      if (attempt >= maxAttempts || Date.now() + intervalMs > deadline) break;
      await sleep(intervalMs);
    }
    throw new Error(`${label} connect failed after ${attempt} attempts (last=${lastReason})`);
  }

  get summary() {
    return {
      leaseId: this.leaseId, state: this.state, mode: this.mode,
      source: this.videoSourceActive, degraded: this.degraded,
      deviceName: this.deviceName, width: this.width, height: this.height,
      frames: this.frames, keyframes: this.keyframes, bytes: this.bytes,
      lastFrameAt: this.lastFrameAt, deadReason: this.deadReason,
    };
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
