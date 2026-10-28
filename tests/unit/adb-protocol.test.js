/**
 * ADB wire-protocol unit tests (F-RDFA-2 fix) — pure, no I/O.
 *
 * Two fixtures in here are REAL captured packets, not inventions:
 *
 *  1. CLIENT_CNXN — a genuine platform-tools `adb` client CNXN, captured
 *     byte-for-byte from the wire during the WA-REALDEVICE-FINAL P2
 *     experiments (docs/audits/realdevice-final/p2/). All three computed
 *     fields independently re-verify: data_length = 286 = banner length;
 *     data_check = 0x701d = byte-sum of the banner; magic = 0xb1a7b1bc =
 *     0x4e584e43 ^ 0xffffffff.
 *
 *  2. ADBD_REPLY — the genuine adbd reply to our probe CNXN, captured
 *     live from redroid-rdfa-s2 (Android 14 MTG image) during the S2
 *     empirical run (2026-10-29). data_check = 0 (modern adbd skips the
 *     checksum at >= A_VERSION_SKIP_CHECKSUM — the code must ACCEPT that).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  A_CNXN,
  A_AUTH,
  A_STLS,
  A_VERSION,
  A_VERSION_MIN,
  A_VERSION_SKIP_CHECKSUM,
  ADB_HEADER_SIZE,
  ADB_PROBE_MAXDATA,
  ADB_PROBE_HOST_BANNER,
  ADB_BANNER_TYPES,
  adbMagic,
  adbPayloadChecksum,
  buildAdbCnxnPacket,
  parseAdbPacket,
  parseAdbBanner,
} from '@water-army/shared';

const CLIENT_BANNER = 'host::features=shell_v2,cmd,stat_v2,ls_v2,fixed_push_mkdir,apex,abb,fixed_push_symlink_timestamp,abb_exec,remount_shell,track_app,sendrecv_v2,sendrecv_v2_brotli,sendrecv_v2_lz4,sendrecv_v2_zstd,sendrecv_v2_dry_run_send,devicetracker_proto_format,devraw,app_info,server_status,track_mdns';

const ADBD_BANNER = 'device::ro.product.name=redroid_x86_64;ro.product.model=redroid14_x86_64;ro.product.device=redroid_x86_64;features=shell_v2,cmd,stat_v2,ls_v2,fixed_push_mkdir,apex,abb,fixed_push_symlink_timestamp,abb_exec,remount_shell,track_app,sendrecv_v2,sendrecv_v2_brotli,sendrecv_v2_lz4,sendrecv_v2_zstd,sendrecv_v2_dry_run_send,openscreen_mdns,delayed_ack';

/** Rebuild a captured 24-byte header from its field values (little-endian,
 *  the on-wire order on x86/ARM — see adb-protocol.js header comment). */
function headerBuf({ command, arg0, arg1, dataLength, dataCheck, magic }) {
  const h = Buffer.alloc(24);
  h.writeUInt32LE(command, 0);
  h.writeUInt32LE(arg0, 4);
  h.writeUInt32LE(arg1, 8);
  h.writeUInt32LE(dataLength, 12);
  h.writeUInt32LE(dataCheck, 16);
  h.writeUInt32LE(magic, 20);
  return h;
}

// ---------------------------------------------------------------- constants

test('protocol constants match AOSP adb.h (byte-swapped wire form)', () => {
  assert.equal(A_CNXN, 0x4e584e43); // wire bytes spell "CNXN"
  assert.equal(A_AUTH, 0x48545541);
  assert.equal(A_STLS, 0x534c5453);
  assert.equal(A_VERSION, 0x01000001);
  assert.equal(A_VERSION_MIN, 0x01000000);
  assert.equal(A_VERSION_SKIP_CHECKSUM, 0x01000001);
  assert.equal(ADB_HEADER_SIZE, 24);
  assert.equal(ADB_PROBE_MAXDATA, 0x00100000); // 1 MiB, as the real client advertises
});

test('adbMagic: command ^ 0xffffffff (the AOSP send_packet relation)', () => {
  assert.equal(adbMagic(A_CNXN), (A_CNXN ^ 0xffffffff) >>> 0);
  assert.equal(adbMagic(0x4e584e43), 0xb1a7b1bc); // the captured magic value
  assert.equal(adbMagic(0), 0xffffffff);
  assert.equal(adbMagic(0xffffffff), 0);
});

test('adbPayloadChecksum: u32 byte-sum', () => {
  assert.equal(adbPayloadChecksum(Buffer.alloc(0)), 0);
  assert.equal(adbPayloadChecksum(Buffer.from([0xff, 0xff, 1])), 511); // 255+255+1
  assert.equal(adbPayloadChecksum(Buffer.from([0xff, 0xff, 0xff, 0xff, 1])), 1021); // 4x255+1 = 0x3fd
  assert.equal(adbPayloadChecksum(Buffer.from('abc', 'ascii')), 97 + 98 + 99);
});

// ---------------------------------------------------------------- build

test('buildAdbCnxnPacket: header fields + checksum + magic are all correct', () => {
  const { header, payload, raw } = buildAdbCnxnPacket('host::features=cmd');
  assert.equal(header.length, 24);
  assert.equal(header.readUInt32LE(0), A_CNXN);
  assert.equal(header.readUInt32LE(4), A_VERSION);
  assert.equal(header.readUInt32LE(8), ADB_PROBE_MAXDATA);
  assert.equal(header.readUInt32LE(12), payload.length);
  assert.equal(header.readUInt32LE(16), adbPayloadChecksum(payload));
  assert.equal(header.readUInt32LE(20), adbMagic(A_CNXN));
  assert.equal(raw.length, 24 + payload.length);
  assert.deepEqual(raw.subarray(0, 24), header);
  assert.deepEqual(raw.subarray(24), payload);
});

test('buildAdbCnxnPacket: the wire bytes of the command field spell CNXN', () => {
  const { raw } = buildAdbCnxnPacket('host::');
  assert.equal(raw.subarray(0, 4).toString('ascii'), 'CNXN');
});

test('buildAdbCnxnPacket: empty banner is legal (data_length 0)', () => {
  const { header, raw } = buildAdbCnxnPacket('');
  assert.equal(header.readUInt32LE(12), 0);
  assert.equal(header.readUInt32LE(16), 0);
  assert.equal(raw.length, 24);
});

test('the probe banner is a host banner with a non-empty feature list', () => {
  // client banners start with host::features=... (adb.cpp get_connection_string)
  assert.match(ADB_PROBE_HOST_BANNER, /^host::features=[a-z0-9_,]+$/);
  // 'host' is a CLIENT-side banner type — deliberately NOT in ADB_BANNER_TYPES
  // (which lists device-side connection states), so the parser reports
  // unknown for it: only device-side types count as healthy.
  const banner = parseAdbBanner(ADB_PROBE_HOST_BANNER);
  assert.equal(banner.type, 'unknown');
});

// ---------------------------------------------------------------- REAL captured client packet

test('REAL fixture: captured platform-tools client CNXN parses byte-exact', () => {
  const banner = Buffer.from(CLIENT_BANNER, 'utf8');
  assert.equal(banner.length, 286, 'fixture integrity: the captured banner is 286 bytes');
  const captured = headerBuf({
    command: 0x4e584e43,
    arg0: 0x01000001,
    arg1: 0x00100000,
    dataLength: 286,
    dataCheck: 0x701d, // the captured bytes 1d 70 00 00 read little-endian
    magic: 0xb1a7b1bc,
  });
  const p = parseAdbPacket(Buffer.concat([captured, banner]));
  assert.equal(p.state, 'ok');
  assert.equal(p.command, A_CNXN);
  assert.equal(p.commandAscii, 'CNXN');
  assert.equal(p.arg0, A_VERSION);
  assert.equal(p.arg1, 0x00100000);
  assert.equal(p.dataLength, 286);
  assert.equal(p.dataCheck, 0x701d);
  assert.equal(p.magicValid, true, 'captured magic must validate against command ^ 0xffffffff');
  assert.equal(p.banner, CLIENT_BANNER);
  // the captured checksum is the real byte-sum — our builder must reproduce it
  const built = buildAdbCnxnPacket(CLIENT_BANNER);
  assert.equal(built.header.readUInt32LE(16), 0x701d, 'our checksum reproduces the captured value');
});

// ---------------------------------------------------------------- REAL captured adbd reply

test('REAL fixture: captured redroid adbd CNXN reply parses (data_check 0 accepted)', () => {
  const banner = Buffer.from(ADBD_BANNER, 'utf8');
  assert.equal(banner.length, 346, 'fixture integrity: the captured reply banner is 346 bytes');
  const captured = headerBuf({
    command: 0x4e584e43,
    arg0: 0x01000001,
    arg1: 0x00100000,
    dataLength: 346,
    dataCheck: 0x0, // modern adbd: checksum skipped at >= A_VERSION_SKIP_CHECKSUM
    magic: 0xb1a7b1bc,
  });
  const p = parseAdbPacket(Buffer.concat([captured, banner]));
  assert.equal(p.state, 'ok');
  assert.equal(p.command, A_CNXN);
  assert.equal(p.magicValid, true);
  assert.equal(p.dataCheck, 0x0);
  const bannerInfo = parseAdbBanner(p.banner);
  assert.equal(bannerInfo.type, 'device');
  assert.equal(bannerInfo.product, 'redroid_x86_64');
  assert.equal(bannerInfo.model, 'redroid14_x86_64');
  assert.equal(bannerInfo.device, 'redroid_x86_64');
  assert.ok(bannerInfo.features.includes('delayed_ack'));
  assert.ok(bannerInfo.features.includes('shell_v2'));
});

// ---------------------------------------------------------------- parse (synthetic edges)

test('parseAdbPacket: short buffer → state short (keep reading)', () => {
  const { raw } = buildAdbCnxnPacket('host::features=cmd');
  for (let n = 0; n < 24; n += 1) {
    const p = parseAdbPacket(raw.subarray(0, n));
    assert.equal(p.state, 'short', `n=${n}`);
  }
});

test('parseAdbPacket: complete header, payload still arriving → ok but payload null', () => {
  const { raw } = buildAdbCnxnPacket('host::features=cmd');
  const p = parseAdbPacket(raw.subarray(0, 24));
  assert.equal(p.state, 'ok');
  assert.equal(p.command, A_CNXN);
  assert.equal(p.payload, null);
  assert.ok(p.reason.includes('incomplete payload'));
});

test('parseAdbPacket: corrupted magic → magicValid false (the not-an-ADB-endpoint signal)', () => {
  const { raw } = buildAdbCnxnPacket('host::');
  raw.writeUInt32LE(0xdeadbeef, 20); // smash the magic
  const p = parseAdbPacket(raw);
  assert.equal(p.magicValid, false);
});

test('parseAdbPacket: non-buffer input → state short, never throws', () => {
  assert.equal(parseAdbPacket(null).state, 'short');
  assert.equal(parseAdbPacket('nope').state, 'short');
});

test('parseAdbPacket: implausible data_length is flagged, never buffers gigabytes', () => {
  const h = headerBuf({ command: A_CNXN, arg0: A_VERSION, arg1: ADB_PROBE_MAXDATA, dataLength: 70_000, dataCheck: 0, magic: adbMagic(A_CNXN) });
  const p = parseAdbPacket(h);
  assert.equal(p.state, 'ok');
  assert.equal(p.payload, null);
  assert.equal(p.magicValid, false, 'implausible length must invalidate the packet');
  assert.ok(p.reason.includes('implausible'));
});

// ---------------------------------------------------------------- banner parsing

test('parseAdbBanner: every recognized type lands on its type', () => {
  for (const t of ['device', 'recovery', 'bootloader', 'sideload', 'rescue']) {
    const b = parseAdbBanner(`${t}::features=cmd`);
    assert.equal(b.type, t, t);
  }
});

test('parseAdbBanner: unknown / host / garbage → type unknown, never throws', () => {
  assert.equal(parseAdbBanner('host::features=cmd').type, 'unknown');
  assert.equal(parseAdbBanner('').type, 'unknown');
  assert.equal(parseAdbBanner(null).type, 'unknown');
  assert.equal(parseAdbBanner('no-double-colon-here').type, 'unknown');
  assert.equal(parseAdbBanner('wibble::x=1').type, 'unknown');
});

test('parseAdbBanner: props + features parse; malformed segments are skipped', () => {
  const b = parseAdbBanner('device::ro.product.name=n1;ro.product.model=m1;ro.product.device=d1;broken;features=a,,b;');
  assert.equal(b.product, 'n1');
  assert.equal(b.model, 'm1');
  assert.equal(b.device, 'd1');
  assert.deepEqual(b.features, ['a', 'b']);
});

test('parseAdbBanner: device with no payload section is still a device', () => {
  const b = parseAdbBanner('device');
  assert.equal(b.type, 'device');
  assert.equal(b.product, null);
});
