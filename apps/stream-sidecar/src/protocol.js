/**
 * scrcpy v5.0.1 control-protocol encoders + console frame constants.
 *
 * Wire layout verified against the pinned scrcpy-server v5.0.1 sources
 * (ControlMessageReader.java — /tmp/scrcpy-src at PoC time; ADR-019 §19.8)
 * and PROVEN on a real redroid device in the P0 PoC (touch opened the
 * notification shade; Home key hit KeyguardService — see
 * /home/kenneth/.openclaw/workspace/logs/mobileconsole-poc/sidecar-events.jsonl).
 *
 * This module is pure (no I/O) so the byte layouts are unit-testable
 * without a device.
 */

// ---- primitive BE writers -------------------------------------------------------
const b1 = (v) => Buffer.from([v & 0xff]);
const b2 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff, 0); return b; };
const b4 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0, 0); return b; };
const b8 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v), 0); return b; };

// ---- control message types (scrcpy v5.0.1 ControlMessage.ID) ---------------------
export const CTRL = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4,
  // (COPY 5 / CUT 6 / PASTE 7 / ROTATE 8 / CAMERA 9 / LAUNCH_APP 10+ — not
  //  exposed by the console; clipboard/rotate stay out of the MVP on purpose.)
};

// Touch action (scrcpy MotionEvent)
export const TOUCH = { DOWN: 0, UP: 1, MOVE: 2, CANCEL: 3 };
// Key action (KeyEvent)
export const KEY = { DOWN: 0, UP: 1 };

// Common Android keycodes (frameworks/base KeyEvent.java — the labelled bar set)
export const KEYCODES = {
  BACK: 4,
  HOME: 3,
  RECENTS: 187,
  ENTER: 66,
  ESCAPE: 111,
  DEL: 67,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
};

/**
 * INJECT_KEYCODE (id=0): action 1B, code 4B, repeat 4B, metaState 4B → 13B
 */
export function ctrlKeycode(action, keycode, metaState = 0, repeat = 0) {
  if (!Number.isInteger(keycode) || keycode < 0 || keycode > 0xffffff) {
    throw new TypeError(`keycode out of range: ${keycode}`);
  }
  return Buffer.concat([b1(CTRL.INJECT_KEYCODE), b1(action & 0xff), b4(keycode), b4(repeat & 0xffffffff), b4(metaState & 0xffffffff)]);
}

/** INJECT_TEXT (id=1): action 1B + NUL-terminated utf8 text */
export function ctrlText(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 4096) {
    throw new TypeError('INJECT_TEXT payload must be a string of 1..4096 chars');
  }
  return Buffer.concat([b1(CTRL.INJECT_TEXT), b1(0), Buffer.from(text, 'utf8'), b1(0)]);
}

/**
 * INJECT_TOUCH_EVENT (id=2): action 1B, pointerId 8B, x 4B, y 4B,
 * screenW 2B, screenH 2B, pressure 2B (float16-ish: int/32768), axisX 4B, axisY 4B → 30B
 */
export function ctrlTouch(action, pointerId, x, y, screenW, screenH, pressure = 1.0) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(screenW) || !Number.isInteger(screenH)) {
    throw new TypeError('touch coords must be integers');
  }
  if (screenW <= 0 || screenH <= 0) throw new TypeError('screen dims must be > 0');
  const px = Math.max(0, Math.min(screenW, x));
  const py = Math.max(0, Math.min(screenH, y));
  const p = Math.max(0, Math.min(1, Number(pressure) || 0));
  return Buffer.concat([
    b1(CTRL.INJECT_TOUCH_EVENT),
    b1(action & 0xff),
    b8(pointerId),
    b4(px), b4(py),
    b2(screenW), b2(screenH),
    b2(Math.round(p * 32768)),
    b4(0), b4(0),
  ]);
}

/**
 * INJECT_SCROLL_EVENT (id=3): x 4B, y 4B, screenW 2B, screenH 2B,
 * hScroll 2B (scaled float ±1), vScroll 2B, axisX 4B → 21B
 */
export function ctrlScroll(x, y, screenW, screenH, hScroll, vScroll) {
  const i16 = (f) => Math.max(-32768, Math.min(32767, Math.round((Number(f) || 0) * 32768)));
  return Buffer.concat([
    b1(CTRL.INJECT_SCROLL_EVENT),
    b4(Math.max(0, Math.min(screenW, x | 0))),
    b4(Math.max(0, Math.min(screenH, y | 0))),
    b2(screenW), b2(screenH),
    b2(i16(hScroll) & 0xffff), b2(i16(vScroll) & 0xffff),
    b4(0),
  ]);
}

/** BACK_OR_SCREEN_ON (id=4): action 1B (0=back, 1=screen-on) */
export function ctrlBackOrScreenOn(action) {
  return Buffer.concat([b1(CTRL.BACK_OR_SCREEN_ON), b1(action & 0xff)]);
}

// ---- video wire facts (scrcpy v5.0.1, Streamer.java) -----------------------------
export const VIDEO = {
  DUMMY_BYTE_LEN: 1,
  DEVICE_META_LEN: 64, // device name (utf8, NUL-padded)
  CODEC_ID_LEN: 4,
  SESSION_META_LEN: 12, // flags 4B + width 4B + height 4B
  FRAME_HEADER_LEN: 12, // ptsAndFlags 8B + size 4B
  PACKET_FLAG_CONFIG: 1n << 62n,
  PACKET_FLAG_KEY_FRAME: 1n << 61n,
  MAX_FRAME_SIZE: 32 * 1024 * 1024,
  CODEC_NAMES: { 0: 'h264', 1: 'hevc', 2: 'av1' },
};

// ---- degraded (screencap) video framing ------------------------------------------
// PNGF = 'PNGF' u32 | width u32 | height u32 | seq u32 | raw PNG bytes.
// Same framing the PoC console page decoded (browser-evidence.json decoded=8).
export const PNGF = {
  MAGIC: 0x504e4746,
  HEADER_LEN: 16,
};

export function pngfFrame(png, width, height, seq) {
  if (!Buffer.isBuffer(png) || png.length < 24) throw new TypeError('pngfFrame: invalid PNG payload');
  const head = Buffer.alloc(PNGF.HEADER_LEN);
  head.writeUInt32BE(PNGF.MAGIC, 0);
  head.writeUInt32BE(width >>> 0, 4);
  head.writeUInt32BE(height >>> 0, 8);
  head.writeUInt32BE(seq >>> 0, 12);
  return Buffer.concat([head, png]);
}

/** Parse a PNGF frame head from a buffer (returns null if short/no-magic). */
export function pngfHead(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < PNGF.HEADER_LEN) return null;
  if (buf.readUInt32BE(0) !== PNGF.MAGIC) return null;
  return {
    magic: PNGF.MAGIC,
    width: buf.readUInt32BE(4),
    height: buf.readUInt32BE(8),
    seq: buf.readUInt32BE(12),
    payloadLen: buf.length - PNGF.HEADER_LEN,
  };
}

/**
 * Quality presets (MD §4.2: low/medium/high, default medium — the PoC-verified
 * setting on this image). Applied to scrcpy-server launch options only.
 */
export const QUALITY_PRESETS = {
  low: { maxSize: 480, maxFps: 10, videoBitRate: 1_000_000 },
  medium: { maxSize: 720, maxFps: 15, videoBitRate: 2_000_000 },
  high: { maxSize: 1080, maxFps: 30, videoBitRate: 4_000_000 },
};
export const DEFAULT_QUALITY = 'medium';

/**
 * Parse + clamp a quality preset name. Unknown names fall back to the default
 * (fail-safe, never an unbounded setting).
 * @returns {{name:string, maxSize:number, maxFps:number, videoBitRate:number}}
 */
export function resolveQuality(name) {
  const n = String(name ?? '').toLowerCase();
  // NOTE: `??` fallback does NOT work here — `{ name, ...undefined }` is still an
  // object (truthy), so unknown names would silently pass through with no preset.
  if (QUALITY_PRESETS[n]) return { name: n, ...QUALITY_PRESETS[n] };
  return { name: DEFAULT_QUALITY, ...QUALITY_PRESETS[DEFAULT_QUALITY] };
}
