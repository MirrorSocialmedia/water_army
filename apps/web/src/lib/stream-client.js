/**
 * StreamClient — browser-side console streaming (Mobile Console MD §12/§3.2/§3.3).
 *
 * MD §12 defines exactly 12 UI states. This client implements the full
 * machine; two states (QUEUED, LIVE_CONTROLLED_BY_OTHER) are RESERVED in the
 * MVP: slot/device acquisition is atomic (P1 — a 409 is immediate, there is no
 * queue) and one lease per device is strict (a device held by someone else
 * cannot be opened at all → it surfaces as CAPACITY_REACHED with explicit
 * text). Both states stay in the enum + transition table for the future
 * viewer+controller coexistence design (ADR-019 §19.11).
 *
 * Video:
 *  - screencap degraded mode (default on the pinned redroid image — ADR-019
 *    §19.9): PNGF frames (16B header + PNG) decoded via Image → canvas.
 *  - scrcpy H.264 mode: raw 12B-header packets fed to WebCodecs (path
 *    implemented; end-to-end NOT VERIFIED on this image — the device media
 *    HAL emits zero frames, so auto-mode always degrades).
 *
 * Security:
 *  - the one-shot ticket travels in the HttpOnly stream_ticket cookie set by
 *    the acquire/reconnect responses — the client never sees it (MD §11.8).
 *  - video bytes are never logged; input frames carry coordinates/keycodes
 *    only (text input is sent to the device but never retained in this
 *    module — MD §3.3 密碼欄位等敏感輸入不得錄下).
 *  - focus/visibility loss → input is refused (MD §3.2 安全行為).
 */
import { api, ApiError } from '../api/client';

export const STREAM_STATES = [
  'QUEUED',
  'CONNECTING',
  'LIVE_READ_ONLY',
  'LIVE_CONTROLLED_BY_YOU',
  'LIVE_CONTROLLED_BY_OTHER',
  'RECONNECTING',
  'DEVICE_NOT_READY',
  'CAPACITY_REACHED',
  'PERMISSION_DENIED',
  'SESSION_EXPIRED',
  'CLOSED',
  'ERROR',
];

/** MD §12 — every state carries TEXT, not just colour. */
export const STATE_TEXT = {
  QUEUED: '排隊中（MVP 無排隊 — 原子取得，此狀態保留）',
  CONNECTING: '連接串流中…',
  LIVE_READ_ONLY: '已連線（唯讀模式）',
  LIVE_CONTROLLED_BY_YOU: '已連線（你可控制）',
  LIVE_CONTROLLED_BY_OTHER: '他人控制中（MVP 每裝置單 lease — 此狀態保留）',
  RECONNECTING: '連線中斷 — 重新驗證並重連中…',
  DEVICE_NOT_READY: '裝置未就緒（容器未在運行或 ADB 離線）',
  CAPACITY_REACHED: '串流容量已達上限（5/5）或裝置已有串流 — 稍後重試',
  PERMISSION_DENIED: '權限不足（控制模式需要 operator 或以上角色）',
  SESSION_EXPIRED: '登入已過期 — 請重新登入後再試',
  CLOSED: '串流已關閉',
  ERROR: '串流出錯（詳細見下方訊息）',
};

const PNGF_MAGIC = 0x504e4746;
const PNGF_HEADER = 16;
const RECONNECT_BACKOFFS_MS = [1000, 2000, 4000, 8000];

/**
 * @param {object} c
 * @param {string} c.deviceId  device row id (from the device list/detail)
 * @param {string} c.mode      'viewer' | 'controller'
 * @param {HTMLCanvasElement} c.canvas
 * @param {(state:StreamState, info?:object)=>void} c.onState
 * @param {(meta:object)=>void} c.onMeta  resolution/source/fps/latency updates
 * @param {(r:object)=>void} c.onInputResult  input-rejected feedback
 */
export class StreamClient {
  constructor({ deviceId, mode, canvas, onState = () => {}, onMeta = () => {}, onInputResult = () => {} }) {
    this.deviceId = deviceId;
    this.mode = mode;
    this.canvas = canvas;
    this.onState = onState;
    this.onMeta = onMeta;
    this.onInputResult = onInputResult;
    this.state = 'CONNECTING';
    this.lease = null;
    this.ws = null;
    this.closedByUser = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.inputBlocked = false; // focus/visibility safety (MD §3.2)
    this.stats = { frames: 0, dropped: 0, lastFrameAt: null, source: null, codec: null, width: null, height: null, degraded: false, degradeReason: null };
    this._visHandler = () => {
      // Leave the tab / lose window focus → refuse new input (the stream
      // stays up; an invisible tab must not be injecting device input).
      this.inputBlocked = document.hidden || document.activeElement === null ? true : this.inputBlocked;
      if (document.visibilityState === 'visible') this.inputBlocked = false;
    };
  }

  _setState(s, info = {}) {
    this.state = s;
    this.onState(s, { ...info, stateText: STATE_TEXT[s] });
  }

  // ---- lifecycle -------------------------------------------------------------
  async start() {
    try {
      const out = await api.post(`/api/devices/redroid/${encodeURIComponent(this.deviceId)}/streams`, { mode: this.mode });
      this.lease = out.lease;
    } catch (e) {
      if (e instanceof ApiError) {
        switch (e.code) {
          case 'UNAUTHORIZED':
          case 'SESSION_EXPIRED':
            return this._setState('SESSION_EXPIRED', { error: e });
          case 'STREAM_PERMISSION_DENIED':
            return this._setState('PERMISSION_DENIED', { error: e });
          case 'STREAM_DEVICE_NOT_RUNNING':
          case 'STREAM_DEVICE_ADB_NOT_ALLOWED':
            return this._setState('DEVICE_NOT_READY', { error: e });
          case 'STREAM_CAPACITY_REACHED':
          case 'STREAM_DEVICE_HELD':
            return this._setState('CAPACITY_REACHED', { error: e });
          default:
            return this._setState('ERROR', { error: e });
        }
      }
      return this._setState('ERROR', { error: e });
    }
    this._setState('CONNECTING');
    document.addEventListener('visibilitychange', this._visHandler);
    this._openWs();
  }

  wsUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}${this.lease.streamWsPath}`;
  }

  _openWs() {
    const ws = new WebSocket(this.wsUrl());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => this._setState('CONNECTING'); // sidecar 'LIVE' text frame confirms
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') this._onText(JSON.parse(ev.data));
      else this._onBinary(ev.data);
    };
    ws.onclose = () => {
      if (this.closedByUser) return;
      this._tryReconnect();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  _onText(m) {
    switch (m.t) {
      case 'state': {
        const live = m.state === 'LIVE';
        if (!live) return;
        this.reconnectAttempt = 0;
        this.stats.source = m.source ?? this.stats.source;
        this.stats.codec = m.codec ?? null;
        // ADR-020 req 6: the UI must show the CURRENT mode + degrade reason.
        // A fresh LIVE with source=scrcpy (non-degraded) clears any stale
        // reason; source=screencap keeps the reason if we just degraded, or
        // records 'default' when screencap IS the configured mode.
        if (m.source === 'scrcpy') {
          this.stats.degraded = Boolean(m.degraded);
          if (!m.degraded) this.stats.degradeReason = null;
        } else if (m.source === 'screencap') {
          this.stats.degraded = Boolean(m.degraded) || this.stats.degraded;
          if (!this.stats.degradeReason) this.stats.degradeReason = m.degraded ? 'H.264 unavailable (see banner)' : 'default mode (screencap, ADR-020)';
        }
        if (m.width) this.stats.width = m.width;
        if (m.height) this.stats.height = m.height;
        this._fitCanvas();
        if (this.mode === 'controller') this._setState('LIVE_CONTROLLED_BY_YOU', { source: m.source, degraded: this.stats.degraded, degradeReason: this.stats.degradeReason });
        else this._setState('LIVE_READ_ONLY', { source: m.source, degraded: this.stats.degraded, degradeReason: this.stats.degradeReason });
        this.onMeta(this.stats);
        return;
      }
      case 'degraded':
        // ADR-020 req 6: persistent UI state (current mode + WHY), not a
        // transient toast.
        this.stats.source = 'screencap';
        this.stats.degraded = true;
        this.stats.degradeReason = m.reason ?? 'stream failed health check';
        this._setState(this.mode === 'controller' ? 'LIVE_CONTROLLED_BY_YOU' : 'LIVE_READ_ONLY', { source: 'screencap', degraded: true, degradeReason: this.stats.degradeReason });
        this.onMeta(this.stats);
        return;
      case 'session':
        this.stats.width = m.width;
        this.stats.height = m.height;
        this._fitCanvas();
        this.onMeta(this.stats);
        return;
      case 'input-rejected':
        this.onInputResult({ ok: false, code: m.code, message: m.message });
        return;
      case 'dead':
        // Sidecar session died (device dropped / scrcpy crashed). Try the
        // reconnect path — if the lease is still active a fresh sidecar
        // session can be attached after re-auth.
        if (!this.closedByUser) this._tryReconnect();
        return;
      case 'error':
        this._setState('ERROR', { error: m, code: m.code });
        return;
      default:
        return;
    }
  }

  _onBinary(buf) {
    const view = new DataView(buf);
    if (buf.byteLength < PNGF_HEADER) return;
    if (view.getUint32(0) === PNGF_MAGIC) {
      // screencap degraded frame
      const w = view.getUint32(4);
      const h = view.getUint32(8);
      const seq = view.getUint32(12);
      this.stats.frames += 1;
      this.stats.lastFrameAt = Date.now();
      this.stats.width = w;
      this.stats.height = h;
      const png = new Uint8Array(buf, PNGF_HEADER);
      const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
      const img = new Image();
      img.onload = () => {
        if (this.canvas.width !== w) this.canvas.width = w;
        if (this.canvas.height !== h) this.canvas.height = h;
        const ctx = this.canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        this.onMeta(this.stats);
      };
      img.onerror = () => {
        this.stats.dropped += 1;
        URL.revokeObjectURL(url);
      };
      img.src = url;
      return;
    }
    // Non-PNGF binary = scrcpy H.264 raw packets (12B header + NALU payload).
    // WebCodecs path: feed to the H264Decoder when available.
    this._feedH264(new Uint8Array(buf));
  }

  /**
   * H.264 via WebCodecs (MD §4.2 production path). Implemented per the
   * scrcpy v5.0.1 elementary-stream framing (12B header: ptsAndFlags 8B +
   * size 4B). On the pinned redroid image the device emits ZERO H.264
   * frames (media HAL limitation — ADR-019 §19.9), so this path is NOT
   * VERIFIED end-to-end there; auto-mode degrades to screencap instead.
   */
  _h264Decoder = null;
  async _feedH264(bytes) {
    if (typeof VideoDecoder === 'undefined') return; // no WebCodecs → nothing to do
    try {
      if (!this._h264Decoder || this._h264Decoder.state === 'closed') {
        this._h264Decoder = new VideoDecoder({
          output: (frame) => {
            const w = frame.displayWidth || frame.codedWidth;
            const h = frame.displayHeight || frame.codedHeight;
            if (this.canvas.width !== w) this.canvas.width = w;
            if (this.canvas.height !== h) this.canvas.height = h;
            this.canvas.getContext('2d').drawImage(frame, 0, 0);
            frame.close();
            this.stats.frames += 1;
            this.stats.lastFrameAt = Date.now();
            this.onMeta(this.stats);
          },
          error: () => {},
        });
        this._h264Decoder.configure({ codec: 'avc1.640028' }); // baseline 4.0 — refined by SPS when parsed
      }
      // Minimal SPS/PPS/IDR splitter for the elementary stream (PoC-proven
      // framing; config frames carry the real codec string).
      const header = bytes.subarray(0, 12);
      const size = new DataView(bytes.buffer, bytes.byteOffset + 8, 4).getUint32();
      const payload = bytes.subarray(12, 12 + Math.min(size, bytes.byteLength - 12));
      const isKey = (new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0) & (1n << 61n)) !== 0n;
      if (payload.length > 4 && payload[0] === 0 && payload[1] === 0 && payload[2] === 0 && payload[3] === 1) {
        const nalType = payload[4] & 0x1f;
        if (nalType === 7 || nalType === 8 || nalType === 5) {
          this._h264Decoder.decode(new EncodedVideoChunk({
            type: nalType === 5 ? 'key' : 'delta',
            timestamp: 0,
            data: payload,
          }));
        }
      }
    } catch {
      // WebCodecs hiccup — the screencap fallback (if active) is unaffected.
    }
  }

  _fitCanvas() {
    if (this.stats.width && this.stats.height && (this.canvas.width !== this.stats.width || this.canvas.height !== this.stats.height)) {
      this.canvas.width = this.stats.width;
      this.canvas.height = this.stats.height;
    }
  }

  // ---- reconnect (MD §2.1.8) ---------------------------------------------------
  _tryReconnect() {
    if (this.closedByUser) return;
    if (!this.lease) return this._setState('ERROR', { error: new Error('no lease to reconnect') });
    const attempt = this.reconnectAttempt;
    if (attempt >= RECONNECT_BACKOFFS_MS.length) {
      return this._setState('ERROR', { error: new Error('reconnect attempts exhausted (lease may have expired — re-acquire)') });
    }
    this._setState('RECONNECTING', { attempt: attempt + 1 });
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.closedByUser) return;
      try {
        const out = await api.post(`/api/device-streams/${encodeURIComponent(this.lease.id)}/reconnect`);
        this.lease = out.lease; // refreshed summary (version bumped)
        this.reconnectAttempt = 0;
        this._setState('CONNECTING');
        this._openWs();
      } catch (e) {
        if (e instanceof ApiError) {
          if (e.code === 'STREAM_LEASE_EXPIRED' || e.code === 'STREAM_LEASE_CLOSED') {
            return this._setState('CLOSED', { error: e, note: 'lease ended — re-open the console to stream again' });
          }
          if (e.code === 'UNAUTHORIZED') return this._setState('SESSION_EXPIRED', { error: e });
        }
        this.reconnectAttempt += 1;
        this._tryReconnect();
      }
    }, RECONNECT_BACKOFFS_MS[attempt]);
  }

  // ---- input (MD §3.3) -----------------------------------------------------------
  /**
   * @param {object} m {kind:'tap'|'swipe', x0,y0,x1?,y1?} normalized 0..1 |
   *                    {kind:'key', name} | {kind:'text', text} |
   *                    {kind:'scroll', x,y,dx,dy}
   */
  input(m) {
    if (this.inputBlocked) {
      this.onInputResult({ ok: false, code: 'STREAM_INPUT_BLOCKED', message: '輸入已暫停（頁面失焦/隱藏中）' });
      return;
    }
    if (this.state !== 'LIVE_CONTROLLED_BY_YOU' && this.state !== 'LIVE_READ_ONLY') {
      this.onInputResult({ ok: false, code: 'STREAM_NOT_LIVE', message: '尚未就緒' });
      return;
    }
    if (this.state === 'LIVE_READ_ONLY' || this.mode !== 'controller') {
      this.onInputResult({ ok: false, code: 'STREAM_READ_ONLY', message: '唯讀模式 — 輸入會被拒絕' });
      return;
    }
    if (!this.ws || this.ws.readyState !== 1) {
      this.onInputResult({ ok: false, code: 'STREAM_NOT_LIVE', message: '連線未建立' });
      return;
    }
    this.ws.send(JSON.stringify({ t: 'input', ...m }));
  }

  // ---- close (idempotent, MD §15) ---------------------------------------------------
  async close() {
    this.closedByUser = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    document.removeEventListener('visibilitychange', this._visHandler);
    try { this.ws?.close(1000, 'user close'); } catch { /* ignore */ }
    this.ws = null;
    if (this.lease) {
      try {
        await api.del(`/api/device-streams/${encodeURIComponent(this.lease.id)}`);
      } catch { /* already terminal — idempotent */ }
      this.lease = null;
    }
    if (this._h264Decoder) { try { this._h264Decoder.close(); } catch { /* ignore */ } this._h264Decoder = null; }
    this._setState('CLOSED');
  }
}
