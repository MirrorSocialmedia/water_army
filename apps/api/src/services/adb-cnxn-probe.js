/**
 * ADB CNXN health probe (F-RDFA-2 fix — the REAL device-reachable probe).
 *
 * What it does: TCP-connects to the DEVICE CONTAINER's bridge IP (L2 on the
 * water-army-devices network) and performs a genuine ADB connection
 * handshake — the client A_CNXN packet, then judges adbd's reply:
 *
 *   healthy  = a reply A_CNXN with a VALID magic (command ^ 0xffffffff)
 *              and a recognizable banner type (device:: / recovery:: / ...).
 *              That is the app-layer proof the Android side is up AND
 *              speaking ADB (MD §8.2 — never just docker state, never just
 *              a TCP connect: a raw connect would pass for any open port).
 *
 *   unhealthy (explicit, actionable details):
 *     - connect refused/unreachable   → adbd not listening (booting or dead)
 *     - no reply within timeoutMs     → adbd not answering the handshake
 *     - connection closed short       → adbd accepted then dropped (dying)
 *     - A_AUTH reply                  → adbd alive but requires authentication
 *                                        (fleet baseline is no-auth — misconfigured)
 *     - A_STLS reply                  → adbd alive but TLS-first (unexpected)
 *     - bad magic / non-ADB reply     → not an ADB endpoint at that target
 *
 * The OLD probe (bare '000chost:version', no handshake, at 127.0.0.1 from
 * inside the api container's netns) was structurally unreachable to real
 * devices — two independent failures, both documented in
 * docs/audits/realdevice-final/p2/ (EXP A/B: zero adbd bytes to a bare
 * command; EXP C: ECONNREFUSED to the host-published port from the api
 * netns). Both are fixed: handshake + L2 bridge-IP target.
 *
 * Timing model (deliberate): ONE hard overall budget (`timeoutMs`, default
 * 3s) set with a plain setTimeout at creation — connect + handshake + full
 * reply must complete within it. The socket inactivity timer is NOT relied
 * on: empirically (S2, 2026-10-29) it does not fire after data has flowed
 * and the peer sends FIN, which would hang the probe forever. Reply
 * reassembly uses s.on('data') (never once) — a CNXN reply may arrive in
 * arbitrary TCP segments.
 *
 * This module is the DEFAULT probe; the hermetic suites inject their own via
 * the app.js `batchLifecycleHealthProbe` seam (unchanged).
 */
import net from 'node:net';

import {
  A_CNXN,
  A_AUTH,
  A_STLS,
  ADB_PROBE_HOST_BANNER,
  buildAdbCnxnPacket,
  parseAdbPacket,
  parseAdbBanner,
} from '@water-army/shared';

/** Cap on reply bytes we will ever buffer (a CNXN banner is <1 KB). */
const MAX_REPLY_BYTES = 65_536;

const hex = (n) => `0x${n.toString(16)}`;

/**
 * Probe one device container endpoint with a real ADB CNXN handshake.
 * @param {string} host the device container's bridge IP (L2 peer on the
 *   device network — NOT 127.0.0.1: the api container's loopback has no
 *   view of host-published ports).
 * @param {number} port the container-side ADB port (default 5555).
 * @param {number} timeoutMs overall socket budget (connect + full reply).
 * @returns {Promise<{healthy:boolean, detail:string|null, version:string|null}>}
 *   Same shape the lifecycle service has always consumed.
 */
export async function adbCnxnProbe(host, port, timeoutMs = 3_000) {
  const ms = Math.max(1, Number(timeoutMs) || 3_000);
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let settled = false;

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(budget);
      s.destroy();
      if (err) resolve({ healthy: false, detail: String(err.message ?? err).slice(0, 200), version: null });
      else resolve(val);
    };

    // hard overall budget — not reset by activity (see timing model above)
    const budget = setTimeout(() => finish(new Error(`no ADB reply within ${ms}ms (adbd not answering)`)), ms);

    const judge = (p) => {
      // p is a complete parseAdbPacket result (state 'ok', payload present).
      if (p.command === A_CNXN) {
        if (!p.magicValid) {
          finish(null, { healthy: false, detail: `adb CNXN reply with invalid magic (${hex(p.magic)} for ${hex(p.command)}) — not an ADB endpoint`, version: null });
          return;
        }
        const banner = parseAdbBanner(p.banner);
        if (banner.type === 'unknown') {
          finish(null, { healthy: false, detail: `adb CNXN reply with unrecognized banner type ('${String(p.banner ?? '').slice(0, 40)}')`, version: null });
          return;
        }
        // version: a compact identity string for logs/metrics (arg0 = the
        // protocol version the peer advertised in its reply).
        finish(null, { healthy: true, detail: null, version: `adb-${banner.type}@${hex(p.arg0)}` });
        return;
      }
      if (p.command === A_AUTH) {
        finish(null, { healthy: false, detail: 'adbd answered A_AUTH — authentication required (fleet baseline is no-auth; device key state misconfigured)', version: null });
        return;
      }
      if (p.command === A_STLS) {
        finish(null, { healthy: false, detail: 'adbd answered A_STLS — TLS handshake requested (unexpected for this fleet)', version: null });
        return;
      }
      finish(null, { healthy: false, detail: `not an ADB endpoint (first reply ${p.commandAscii ?? hex(p.command)}, magicValid=${p.magicValid})`, version: null });
    };

    s.once('error', (e) => finish(new Error(`adb-tcp ${e.code ? `${e.code} ` : ''}${String(host)}:${port}`.trim())));
    s.once('connect', () => {
      s.write(buildAdbCnxnPacket(ADB_PROBE_HOST_BANNER).raw);
    });
    s.on('data', (chunk) => {
      if (settled) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_REPLY_BYTES) {
        finish(null, { healthy: false, detail: 'probe: oversized reply, not an ADB endpoint', version: null });
        return;
      }
      const p = parseAdbPacket(buf);
      if (p.state === 'short') return; // keep reading (partial header)
      if (p.payload === null) return; // complete header, payload still arriving
      judge(p);
    });
    s.once('end', () => {
      // peer closed without a complete CNXN reply — adbd accepted the
      // connection then dropped it (dying/restarting). Report it now;
      // do not wait out the whole budget for a connection that is gone.
      if (settled) return;
      const p = parseAdbPacket(buf);
      if (p.state === 'ok' && p.payload) judge(p); // complete frame just in case
      else finish(new Error(`adbd closed the connection without a complete CNXN reply (${buf.length} bytes received)`));
    });
  });
}
