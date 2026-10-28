/**
 * ADB wire-protocol primitives (pure — no I/O; the probe lives in
 * apps/api/src/services/adb-cnxn-probe.js).
 *
 * F-RDFA-2 fix (WA-RDFA-FIX S2): the old default health probe sent a bare
 * length-prefixed '000chost:version' with NO connection handshake. Real adbd
 * (AOSP platform/packages/modules/adb) ignores anything before it receives a
 * valid A_CNXN packet — so the old probe could NEVER see a reply from a real
 * device (p2-55 EXP A/B: zero bytes back; p2-56: 16 polls, no answer).
 *
 * Wire format (verified against AOSP sources AND a real captured client
 * CNXN + a real Android-14 adbd reply, see docs/audits/rdfa-fix-report.md):
 *
 *   24-byte header = 6 x u32, written in the SENDER'S native byte order.
 *   Every machine in this fleet (x86_64 host, x86_64 redroid adbd) is
 *   little-endian, so we emit LE. (AOSP writes the raw C struct — there is
 *   no htons anywhere in the ADB header path.)
 *
 *     offset  0  command      A_CNXN = 0x4e584e43 → wire bytes 43 4e 58 4e
 *     offset  4  arg0         A_VERSION (0x01000001)
 *     offset  8  arg1         max payload size the sender will accept (1 MiB)
 *     offset 12  data_length  payload length in bytes
 *     offset 16  data_check   sum of payload bytes (u32); 0 when both peers
 *                             negotiate >= A_VERSION_SKIP_CHECKSUM — we always
 *                             compute the real sum: valid for old adbd,
 *                             ignored by new adbd (verified: live reply came
 *                             back with data_check = 0).
 *     offset 20  magic        command ^ 0xffffffff  (the strong identifier —
 *                             verified byte-for-byte on a real capture)
 *
 *   payload: the banner. Client sends "host::features=..."; adbd answers
 *   (no-auth, no-TLS — the fleet baseline) with its own A_CNXN whose banner
 *   is "device::ro.product.name=...;ro.product.model=...;ro.product.device=...;features=..."
 *   (AOSP adb.cpp get_connection_string()/parse_banner()). Auth-required adbd
 *   answers A_AUTH instead; TLS-enabled adbd answers A_STLS first.
 */

/** A_CNXN — connection handshake (wire bytes spell "CNXN"). */
export const A_CNXN = 0x4e584e43;
/** A_OPEN — open a local service socket. */
export const A_OPEN = 0x4e45504f;
/** A_OKAY — generic ack (e.g. to A_OPEN). */
export const A_OKAY = 0x59414b4f;
/** A_CLSE — close a local service socket. */
export const A_CLSE = 0x45534c43;
/** A_AUTH — authentication token / signature exchange. */
export const A_AUTH = 0x48545541;
/** A_STLS — start-TLS handshake request. */
export const A_STLS = 0x534c5453;

/** ADB protocol version sent by the client (A_VERSION in adb.h). */
export const A_VERSION = 0x01000001;
/** Floor a transport starts at before negotiation (A_VERSION_MIN). */
export const A_VERSION_MIN = 0x01000000;
/** From this version on, data_check may be 0 (A_VERSION_SKIP_CHECKSUM). */
export const A_VERSION_SKIP_CHECKSUM = 0x01000001;

/** Max payload the probe advertises (1 MiB — same as the real adb client). */
export const ADB_PROBE_MAXDATA = 0x00100000;

/** Header size: 6 x u32. */
export const ADB_HEADER_SIZE = 24;

/**
 * The banner the probe announces as a host client. Mirrors the real client
 * (adb.cpp get_connection_string: "host" + "::" + "features=..."). The
 * feature list is a conservative subset of the platform-tools set — adbd
 * intersects features, so a smaller list only disables conveniences, never
 * the handshake.
 */
export const ADB_PROBE_HOST_BANNER = 'host::features=shell_v2,cmd,stat_v2,ls_v2';

/**
 * Banner prefixes that identify a live, usable Android-side endpoint
 * (AOSP adb.cpp parse_banner: device / recovery / bootloader / sideload /
 * rescue set the transport's connection state to the matching type).
 */
export const ADB_BANNER_TYPES = Object.freeze(['device', 'recovery', 'bootloader', 'sideload', 'rescue']);

/** The command-magic relation AOSP uses (send_packet): magic = command ^ 0xffffffff. */
export function adbMagic(command) {
  return (command ^ 0xffffffff) >>> 0;
}

/** u32 byte-sum of a buffer (the legacy ADB payload checksum). */
export function adbPayloadChecksum(payload) {
  let sum = 0;
  for (let i = 0; i < payload.length; i += 1) sum = (sum + payload[i]) >>> 0;
  return sum;
}

/**
 * Build the client A_CNXN packet.
 * @param {string} banner e.g. ADB_PROBE_HOST_BANNER
 * @param {{version?:number, maxdata?:number}} [opts]
 * @returns {{header:Buffer, payload:Buffer, raw:Buffer}} header (24B),
 *   payload, and the full send buffer (header+payload concatenated).
 */
export function buildAdbCnxnPacket(banner, { version = A_VERSION, maxdata = ADB_PROBE_MAXDATA } = {}) {
  const payload = Buffer.from(String(banner ?? ''), 'utf8');
  const header = Buffer.alloc(ADB_HEADER_SIZE);
  header.writeUInt32LE(A_CNXN, 0);
  header.writeUInt32LE(version >>> 0, 4);
  header.writeUInt32LE(maxdata >>> 0, 8);
  header.writeUInt32LE(payload.length >>> 0, 12);
  header.writeUInt32LE(adbPayloadChecksum(payload), 16);
  header.writeUInt32LE(adbMagic(A_CNXN), 20);
  return { header, payload, raw: Buffer.concat([header, payload]) };
}

/**
 * Parse one ADB packet from a receive buffer.
 * @param {Buffer} buf
 * @returns {{state:'short'|'ok', command?:number, arg0?:number, arg1?:number,
 *   dataLength?:number, dataCheck?:number, magic?:number, magicValid?:boolean,
 *   payload?:Buffer, banner?:string, commandAscii?:string, reason?:string}}
 *   state 'short' = fewer than 24 bytes received yet (keep reading);
 *   'ok' = a complete header (+ payload when dataLength is already present).
 */
export function parseAdbPacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < ADB_HEADER_SIZE) {
    return { state: 'short', reason: `need ${ADB_HEADER_SIZE} header bytes, have ${buf?.length ?? 0}` };
  }
  const command = buf.readUInt32LE(0);
  const arg0 = buf.readUInt32LE(4);
  const arg1 = buf.readUInt32LE(8);
  const dataLength = buf.readUInt32LE(12);
  const dataCheck = buf.readUInt32LE(16);
  const magic = buf.readUInt32LE(20);
  if (dataLength > 65536) {
    return { state: 'ok', command, arg0, arg1, dataLength, dataCheck, magic, magicValid: false, commandAscii: buf.subarray(0, 4).toString('ascii'), payload: null, banner: null, reason: `implausible data_length ${dataLength} — not an ADB endpoint` };
  }
  const need = ADB_HEADER_SIZE + dataLength;
  const payload = buf.length >= need ? buf.subarray(ADB_HEADER_SIZE, need) : null;
  return {
    state: 'ok',
    command,
    arg0,
    arg1,
    dataLength,
    dataCheck,
    magic,
    magicValid: magic === adbMagic(command),
    commandAscii: buf.subarray(0, 4).toString('ascii'),
    payload,
    banner: payload ? payload.toString('utf8') : null,
    reason: payload ? null : `incomplete payload (${buf.length} < ${need})`,
  };
}

/**
 * Parse an ADB connection banner: "device::k=v;k=v;...".
 * @param {string} banner
 * @returns {{type:string, product:string|null, model:string|null, device:string|null, features:string[]}}
 *   type ∈ ADB_BANNER_TYPES ∪ {'unknown'} (never throws on garbage).
 */
export function parseAdbBanner(banner) {
  const out = { type: 'unknown', product: null, model: null, device: null, features: [] };
  const s = String(banner ?? '');
  const idx = s.indexOf('::');
  const head = idx >= 0 ? s.slice(0, idx) : s;
  if (!ADB_BANNER_TYPES.includes(head)) return out;
  out.type = head;
  if (idx < 0) return out;
  for (const prop of s.slice(idx + 2).split(';')) {
    if (!prop) continue;
    const eq = prop.indexOf('=');
    if (eq <= 0) continue;
    const key = prop.slice(0, eq);
    const value = prop.slice(eq + 1);
    if (key === 'ro.product.name') out.product = value;
    else if (key === 'ro.product.model') out.model = value;
    else if (key === 'ro.product.device') out.device = value;
    else if (key === 'features') out.features = value.split(',').filter(Boolean);
  }
  return out;
}
