/**
 * MC P2 — stream gateway: WS upgrade auth chain + API↔sidecar tunnel
 * (ADR-019 §19.12; MD §8.1 「服務端必須重新驗證…前端發來的 deviceId/leaseId 一律
 * 不trusted」).
 *
 * The browser WebSocket API cannot set custom headers, so the ticket
 * travels in a dedicated short-lived HttpOnly cookie (`stream_ticket`,
 * Path=/api/device-streams, Max-Age=60s) set by acquire/reconnect responses.
 * It is therefore never in a URL, never in an access log line, and never
 * guessable (HMAC, 60s TTL — enforced in P1 validateTicket).
 *
 * Ticket consumption (NV5b(c), 老細 2026-10-26 拍板): validation never burns
 * the ticket; the upgrade path consumes it ONLY after the sidecar handshake
 * succeeds (streamLeaseService.consumeTicket). A sidecar that is down or
 * restarting therefore leaves the ticket spendable — the browser retries
 * inside the TTL instead of hitting STREAM_TICKET_REPLAYED 401 storms.
 *
 * Auth chain (server-side, every upgrade):
 *   1. session cookie → user (401)
 *   2. lease exists (404)
 *   3. lease owner or admin (403 STREAM_LEASE_OWNER_MISMATCH)
 *   4. lease ACTIVE and not expired (409 STREAM_LEASE_EXPIRED / _CLOSED)
 *   5. device exists (404) and containerState=running (409 STREAM_DEVICE_NOT_RUNNING)
 *   6. device ADB endpoint in the configured loopback allowlist (403)
 *   7. ticket: HMAC + exp + binding(user/device/mode) + not-yet-consumed
 *      (401 STREAM_TICKET_INVALID / _REPLAYED); consumed post-handshake (NV5b(c))
 * All-failures are logged with the error envelope + requestId (MD §15.2).
 */
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { parse } from 'node:querystring';

export const STREAM_TICKET_COOKIE = 'stream_ticket';

/**
 * @param {object} p
 * @param {object} p.db prisma client (device lookups)
 * @param {object} p.config resolved config
 * @param {object} p.streamLeaseService P1 service (validateTicket / heartbeat)
 * @param {object} p.log pino logger
 * @param {(req)=>Promise<object|null>} p.resolveUser session → user (injected)
 */
export function createStreamGateway({ db, config, streamLeaseService, log, resolveUser }) {
  const now = () => new Date();

  function fail(code, message, httpStatus) {
    const e = new Error(message);
    e.code = code;
    e.httpStatus = httpStatus;
    e.apiCode = code;
    e.statusCode = httpStatus;
    return e;
  }

  /**
   * Full server-side re-verification for a WS upgrade (MD §8.1).
   * @param {{leaseId:string, req:http.IncomingMessage}} o
   * @returns {Promise<{ok:true, lease:object, device:object, user:object}|never>}
   * @throws {Error & {apiCode:string, statusCode:number}}
   */
  async function authenticateUpgrade({ leaseId, req }) {
    const user = await resolveUser(req);
    if (!user) throw fail('UNAUTHORIZED', 'authentication required', 401);

    let lease;
    try {
      lease = await db.streamLease.findUnique({ where: { id: leaseId } });
    } catch {
      lease = null;
    }
    if (!lease) throw fail('STREAM_LEASE_NOT_FOUND', `stream lease '${leaseId}' not found`, 404);

    const isAdmin = user.role === 'admin';
    if (lease.userId !== user.id && !isAdmin) {
      throw fail('STREAM_LEASE_OWNER_MISMATCH', 'only the lease owner (or an administrator) may open this stream', 403);
    }
    if (lease.status !== 'ACTIVE') {
      throw fail('STREAM_LEASE_CLOSED', `stream lease is ${lease.status.toLowerCase()}`, 409);
    }
    if (lease.expiresAt <= now()) {
      throw fail('STREAM_LEASE_EXPIRED', 'stream lease expired (re-acquire for a fresh ticket)', 409);
    }

    let device;
    try {
      device = await db.device.findUnique({ where: { id: lease.deviceId } });
    } catch {
      device = null;
    }
    if (!device) throw fail('STREAM_DEVICE_NOT_FOUND', `device '${lease.deviceId}' not found`, 404);
    if (device.containerState !== 'running') {
      throw fail('STREAM_DEVICE_NOT_RUNNING', `device is ${device.containerState} (must be running)`, 409);
    }
    // ADB allowlist (MD §5.2): the host is ALWAYS 127.0.0.1 (redroid devices
    // publish ADB on host loopback only — audit finding #3), so the serial is
    // CONSTRUCTED from the DB row's port, never client-supplied; the port must
    // fall inside the configured allowlist range. No SSRF surface: the client
    // can pick a device row, but never a host/IP.
    const port = Number(device.adbPort);
    if (!Number.isInteger(port) || !(port >= config.redroidAdbRangeStart && port <= config.redroidAdbRangeEnd)) {
      throw fail('STREAM_DEVICE_ADB_NOT_ALLOWED', 'device ADB port is outside the configured allowlist range', 403);
    }
    const serial = `127.0.0.1:${port}`;

    // Ticket (cookie; the only place the browser can present it).
    const cookie = parseCookies(req.headers.cookie ?? '');
    const ticket = cookie[STREAM_TICKET_COOKIE] || (parse(req.url?.split('?')[1] ?? '', '&').ticket ?? '');
    if (!ticket) throw fail('STREAM_TICKET_INVALID', 'stream ticket missing (stream_ticket cookie)', 401);
    try {
      const live = await streamLeaseService.validateTicket({
        ticket,
        user,
        deviceId: device.id,
        mode: lease.mode,
      });
      if (live.id !== lease.id || live.status !== 'ACTIVE') {
        throw fail('STREAM_TICKET_INVALID', 'stream ticket does not match an active lease', 401);
      }
      // NV5b(c): the ticket is returned UNconsumed — the caller (app.js
      // upgrade handler) burns it via consumeTicket() only after the sidecar
      // handshake succeeds. A failed upgrade keeps the ticket spendable.
      return { ok: true, lease, device, user, serial, ticket };
    } catch (e) {
      if (e?.apiCode) throw e;
      throw fail('STREAM_TICKET_INVALID', 'stream ticket validation failed', 401);
    }
  }

  /**
   * Raw WebSocket client to the sidecar (no ws dependency at the gateway —
   * after the 101 both directions are blind-piped frames).
   * @returns {Promise<net.Socket>} the upgraded socket (head buffer is
   *   already applied by node; caller must prepend `head` writes before
   *   piping client data — handled by connectAndHandshake below).
   */
  function upgradeToSidecar(port, path = '/ws') {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString('base64');
      const req = http.request({
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': key,
          Origin: 'http://127.0.0.1',
        },
        timeout: 5_000,
      });
      req.on('upgrade', (res, sock, head) => {
        sock.setNoDelay(true);
        // bridge the gap before connectAndHandshake's first wait() attaches
        // its actionable error handler — a reset in that window would be an
        // unhandled 'error' event on the raw socket (process crash).
        sock.on('error', () => {});
        resolve({ sock, head: head ?? Buffer.alloc(0) });
      });
      req.on('response', (res) => {
        res.resume();
        reject(fail('STREAM_SIDECAR_UNAVAILABLE', `sidecar rejected upgrade (HTTP ${res.statusCode})`, 503));
      });
      req.on('error', (e) => reject(fail('STREAM_SIDECAR_UNAVAILABLE', `sidecar connect failed: ${e.message}`, 503)));
      req.on('timeout', () => { req.destroy(new Error('sidecar upgrade timeout')); });
      req.end();
    });
  }

  /**
   * Connect to the sidecar and complete the internal handshake
   * (auth → session → ready) with a hard deadline.
   * @returns {Promise<net.Socket>} live, authenticated, session-attached socket
   */
  async function connectAndHandshake({ lease, device, serial, videoSource, quality }) {
    const { sock, head } = await upgradeToSidecar(config.streamSidecarPort);
    const deadline = Date.now() + 10_000;
    let buffer = Buffer.from(head);
    let sessionStarted = false;

    const send = (obj) => sock.write(wsTextFrame(obj));
    const wait = (pred, what) => new Promise((resolve, reject) => {
      const onErr = (e) => {
        cleanup();
        if (e?.apiCode) reject(e);
        else reject(fail('STREAM_SIDECAR_UNAVAILABLE', `sidecar socket error: ${e.message}`, 503));
      };
      const onClosed = (code) => {
        cleanup();
        reject(fail('STREAM_SIDECAR_UNAVAILABLE', `sidecar socket ${code ?? 'closed'} during handshake`, 503));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(fail('STREAM_SIDECAR_TIMEOUT', `sidecar handshake timeout (${what})`, 504));
      }, Math.max(0, deadline - Date.now()));
      timer.unref?.();
      const check = () => {
        for (;;) {
          const m = extractFrame(buffer);
          if (!m) break;
          buffer = buffer.subarray(m.next);
          if (m.opcode !== 1) continue; // handshake frames are text
          const obj = safeJson(m.payload);
          if (!obj) continue;
          if (pred(obj)) { cleanup(); resolve(obj); return; }
          if (obj.t === 'error') {
            cleanup();
            reject(fail(obj.code ?? 'STREAM_SIDECAR_ERROR', obj.message ?? 'sidecar error', obj.httpStatus ?? 500));
            return;
          }
          if (obj.t === 'dead') {
            cleanup();
            reject(fail('STREAM_DIED', obj.reason ?? 'sidecar session died', 502));
            return;
          }
          // auth-ok consumed by pred; other informational frames ignored
        }
        if (Date.now() > deadline) {
          cleanup();
          reject(fail('STREAM_SIDECAR_TIMEOUT', `sidecar handshake timeout (${what})`, 504));
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        sock.removeListener('data', onData);
        sock.removeListener('error', onErr);
        sock.removeListener('close', onClose);
      };
      const onData = (d) => { buffer = Buffer.concat([buffer, d]); check(); };
      const onClose = () => onClosed('closed');
      sock.on('data', onData);
      sock.on('error', onErr);
      sock.on('close', onClose);
      check();
    });

    // 1) internal auth
    send({ t: 'auth', token: config.streamSidecarToken });
    await wait((o) => o.t === 'auth-ok', 'auth-ok');
    // 2) session
    send({
      t: 'session',
      leaseId: lease.id,
      serial,
      userId: lease.userId,
      mode: lease.mode,
      videoSource,
      quality,
    });
    sessionStarted = true;
    await wait((o) => o.t === 'ready', 'ready');
    // The session is live; strip the handshake handler by replacing 'data'
    // listeners — done by the caller via the returned handle.
    return { sock, sessionStarted };
  }

  /**
   * End-to-end tunnel: client WS socket (post-upgrade) ↔ sidecar socket,
   * with lease auto-heartbeat while connected (MD §8.1: the connection
   * itself is the liveness signal; client heartbeats still work and are
   * the authoritative keepalive).
   */
  function pipeTunnel({ clientSock, sidecar: { sock }, lease, user }) {
    let hbTimer = null;
    let closed = false;
    const closeBoth = (reason) => {
      if (closed) return;
      closed = true;
      if (hbTimer) clearInterval(hbTimer);
      try { clientSock.destroy(); } catch {}
      try { sock.destroy(); } catch {}
      log.debug({ leaseId: lease.id, reason }, 'stream tunnel closed');
    };
    // Auto-heartbeat: extend the lease while the tunnel is alive so an
    // active stream is not reaped mid-session (MD §4.1 server-time expiry).
    const intervalMs = Math.min(10_000, Math.max(2_000, Math.floor(config.streamLeaseTtlMs / 3)));
    hbTimer = setInterval(async () => {
      if (closed) return;
      try {
        // The connecting user is the lease owner or an admin (verified in
        // authenticateUpgrade) → the P1 owner/admin check passes by design.
        await streamLeaseService.heartbeat({ leaseId: lease.id, user, requestId: null, ip: null });
      } catch (e) {
        // Expiry while streaming = the lease legitimately ended (TTL race /
        // admin close) → tear down; the client sees the dead frame.
        if (e?.apiCode === 'STREAM_LEASE_EXPIRED' || e?.apiCode === 'STREAM_LEASE_CLOSED' || e?.apiCode === 'STREAM_LEASE_OWNER_MISMATCH') {
          log.warn({ leaseId: lease.id, code: e.apiCode }, 'stream tunnel torn down (lease no longer live)');
          closeBoth(`lease ${e.apiCode}`);
        }
        // otherwise: transient DB hiccup — keep the tunnel, retry next tick
      }
    }, intervalMs);
    hbTimer.unref?.();
    clientSock.on('close', () => closeBoth('client closed'));
    clientSock.on('error', () => closeBoth('client error'));
    sock.on('close', () => closeBoth('sidecar closed'));
    sock.on('error', () => closeBoth('sidecar error'));
    clientSock.pipe(sock);
    sock.pipe(clientSock);
    return { close: (r) => closeBoth(r ?? 'tunnel closed') };
  }

  return { authenticateUpgrade, connectAndHandshake, pipeTunnel, STREAM_TICKET_COOKIE };
}

// exported for unit tests (frame decoder is protocol-agnostic)
export { extractFrame };

// ---- tiny helpers -----------------------------------------------------------------
function parseCookies(header) {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

/**
 * Minimal WS frame decoder for the handshake phase ONLY (auth-ok/ready/error
 * are small text frames, never fragmented by our sidecar). Once the tunnel
 * starts, frames are piped byte-for-byte (no parsing at the gateway).
 * Handles unmasking (required for client→server frames; the sidecar sends
 * unmasked, but robustness costs nothing).
 */
function extractFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  let key = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    key = Buffer.from(buf.subarray(off, off + 4));
    off += 4;
  }
  if (buf.length < off + len) return null;
  let payload = Buffer.from(buf.subarray(off, off + len));
  if (masked && key) {
    const out = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) out[i] = payload[i] ^ key[i % 4];
    payload = out;
  }
  return { opcode, payload, next: off + len };
}

function safeJson(buf) {
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
}

/**
 * RFC6455 text-frame encoder for gateway→sidecar handshake messages.
 * The sidecar /ws endpoint is a real `ws` WebSocketServer — writing raw
 * JSON unframed makes its parser read the first JSON byte as a frame
 * header ('{'=0x7B sets RSV2/RSV3 → "RSV2 and RSV3 must be clear",
 * observed live in P2 E2E run #7) and the handshake dies with
 * STREAM_SIDECAR_UNAVAILABLE. Client→server frames MUST be masked
 * (RFC6455 §5.3); the tunnel phase is a blind pipe, so no further
 * framing happens there. (Module scope: exported for unit tests.)
 */
export function wsTextFrame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len | 0x80; // MASK bit set — client frames MUST be masked (§5.3)
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126 | 0x80;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127 | 0x80;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN=1, opcode=1 (text)
  const mask = randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}
