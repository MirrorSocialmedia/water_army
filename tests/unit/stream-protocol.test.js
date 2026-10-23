/**
 * Unit tests — stream-sidecar protocol encoders (scrcpy v5.0.1 byte layouts).
 *
 * Layouts are pinned against the v5.0.1 ControlMessageReader.java field order
 * (verified in the P0 PoC against a live redroid device — ADR-019 §19.8/§19.10).
 * A byte drift here = silent garbage on the wire, so we assert full hex strings.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CTRL, TOUCH, KEY, KEYCODES,
  ctrlKeycode, ctrlText, ctrlTouch, ctrlScroll, ctrlBackOrScreenOn,
  pngfFrame, pngfHead, resolveQuality, QUALITY_PRESETS, PNGF,
} from '../../apps/stream-sidecar/src/protocol.js';

const hex = (b) => b.toString('hex');

test('ctrlKeycode: 14B, id=0, BE fields, clamps/validates', () => {
  // action=DOWN(0), code=KEYCODE_BACK(4), repeat=0, meta=0
  assert.equal(hex(ctrlKeycode(KEY.DOWN, KEYCODES.BACK)),
    '00' + '00' + '00000004' + '00000000' + '00000000');
  // action=UP, code=HOME(3), repeat=2, meta=0x0100 (META_SHIFT)
  assert.equal(hex(ctrlKeycode(KEY.UP, KEYCODES.HOME, 0x0100, 2)),
    '00' + '01' + '00000003' + '00000002' + '00000100');
  assert.throws(() => ctrlKeycode(0, -1), TypeError);
  assert.throws(() => ctrlKeycode(0, 0x1000000), TypeError);
});

test('ctrlText: id=1, action=0, NUL-terminated utf8', () => {
  assert.equal(hex(ctrlText('A')), '01' + '00' + '41' + '00');
  assert.equal(hex(ctrlText('héllo')), '0100' + Buffer.from('héllo', 'utf8').toString('hex') + '00');
  assert.throws(() => ctrlText(''), TypeError);
  assert.throws(() => ctrlText('x'.repeat(4097)), TypeError);
});

test('ctrlTouch: 30B, clamps to screen, pressure scaled /32768', () => {
  // action=DOWN, pointerId=1, (100,200) on 720x1280, pressure=1.0
  assert.equal(hex(ctrlTouch(TOUCH.DOWN, 1, 100, 200, 720, 1280, 1.0)),
    '02' + '00' + '0000000000000001' + '00000064' + '000000c8' + '02d0' + '0500' + '8000' + '00000000' + '00000000');
  // clamping: x=9999 → 720 ; y=-5 → 0
  const t = ctrlTouch(TOUCH.MOVE, 0, 9999, -5, 720, 1280);
  assert.equal(t.readUInt32BE(10), 720);
  assert.equal(t.readUInt32BE(14), 0);
  // pressure 0.5 → 16384
  const p = ctrlTouch(TOUCH.DOWN, 0, 0, 0, 720, 1280, 0.5);
  assert.equal(p.readUInt16BE(22), 16384);
  assert.throws(() => ctrlTouch(0, 0, 0.5, 0, 720, 1280), TypeError);
  assert.throws(() => ctrlTouch(0, 0, 0, 0, 0, 1280), TypeError);
});

test('ctrlScroll: 21B, scaled ±1 floats into int16', () => {
  // 0.5 → +16384 (0x4000); -1 clamps to -32768 = int16 0x8000 (two's complement)
  const s = ctrlScroll(10, 20, 720, 1280, 0.5, -1);
  assert.equal(hex(s),
    '03' + '0000000a' + '00000014' + '02d0' + '0500' + '4000' + '8000' + '00000000');
  assert.equal(s[0], CTRL.INJECT_SCROLL_EVENT);
});

test('ctrlBackOrScreenOn: 2B, id=4', () => {
  assert.equal(hex(ctrlBackOrScreenOn(0)), '0400');
  assert.equal(hex(ctrlBackOrScreenOn(1)), '0401');
});

test('KEYCODES: the labelled console bar set', () => {
  assert.deepEqual(
    { BACK: KEYCODES.BACK, HOME: KEYCODES.HOME, RECENTS: KEYCODES.RECENTS, ENTER: KEYCODES.ENTER, ESCAPE: KEYCODES.ESCAPE },
    { BACK: 4, HOME: 3, RECENTS: 187, ENTER: 66, ESCAPE: 111 });
});

test('pngfFrame/pngfHead: 16B header round-trip', () => {
  const png = Buffer.alloc(24); // realistic minimum (sig + IHDR start)
  png.write('FAKEPNG-SIG-24-BYTES-OK!', 0, 'utf8');
  const frame = pngfFrame(png, 720, 1280, 7);
  assert.equal(frame.length, 16 + png.length);
  const head = pngfHead(frame);
  assert.equal(head.width, 720);
  assert.equal(head.height, 1280);
  assert.equal(head.seq, 7);
  assert.equal(head.payloadLen, png.length);
  assert.equal(frame.subarray(16).equals(png), true);
  assert.equal(pngfHead(Buffer.alloc(10)), null);
  assert.equal(pngfHead(Buffer.from([0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null);
  assert.throws(() => pngfFrame(Buffer.alloc(10), 1, 1, 1), TypeError);
});

test('resolveQuality: known presets + fail-safe fallback (never unbounded)', () => {
  assert.equal(resolveQuality('low').name, 'low');
  const { name: _n, ...lowRest } = resolveQuality('low');
  assert.deepEqual(lowRest, QUALITY_PRESETS.low);
  assert.equal(resolveQuality('MEDIUM').name, 'medium');
  assert.equal(resolveQuality('garbage').name, 'medium');
  assert.equal(resolveQuality(undefined).name, 'medium');
  assert.equal(resolveQuality('high').videoBitRate, 4_000_000);
});

test('PNGF magic constant', () => {
  assert.equal(PNGF.MAGIC.toString(16), '504e4746'); // 'PNGF'
});
