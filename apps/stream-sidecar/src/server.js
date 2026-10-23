/**
 * stream-sidecar server entry (ADR-019 §19.12).
 *
 * Long-lived process, one per API. Hosts per-lease StreamSessions.
 *   - WS  127.0.0.1:SIDECAR_WS_PORT  — the API connects ONE socket per stream
 *   - HTTP 127.0.0.1:SIDECAR_HTTP_PORT — /health, /sessions (ops only)
 *
 * Wire protocol (API ↔ sidecar), text JSON unless noted:
 *   API→SC first frame MUST be:  {"t":"auth","token":"<STREAM_SIDECAR_TOKEN>"}
 *   API→SC: {"t":"session","leaseId","serial","userId","mode","videoSource","quality"}
 *   SC→API: {"t":"ready","leaseId"}                    (after auth+session ok)
 *   SC→API: {"t":"error","code","message"}             (fatal for this socket)
 *   SC→API: {"t":"dead","reason"} / {"t":"degraded",...} / {"t":"state",...} /
 *           {"t":"session",width,height}               (pass-through from session)
 *   SC→API: BINARY — video frames (scrcpy raw 12B-header packets OR PNGF)
 *   API→SC: {"t":"input","kind":...}                   (validated by session.input)
 *   API→SC: {"t":"close"}                              (teardown this session)
 *
 * Security:
 *  - binds 127.0.0.1 only; no published ports (MD §5.2)
 *  - internal token (STREAM_SIDECAR_TOKEN, >=32 hex) checked timing-safe
 *  - 'serial' is NOT client-supplied: the API (which queried the DB device
 *    row) provides it; the sidecar additionally validates the shape
 *    127.0.0.1:<port in SIDECAR_ADB_RANGE> (allowlist, MD §5.2)
 *  - no docker socket, no arbitrary exec, no shell endpoints (MD §5.2)
 *  - logs: redaction-safe (kind + byte length; never text content)
 */
import http from 'node:http';
import process from 'node:process';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import pino from 'pino';
import { StreamSession } from './session.js';
import { resolveQuality } from './protocol.js';

const PORT = Number(process.env.SIDECAR_PORT ?? 16550);
const TOKEN = process.env.STREAM_SIDECAR_TOKEN ?? '';
const ADB = process.env.REDROID_ADB_BINARY ?? process.env.ADB_BINARY ?? 'adb';
const JAR = process.env.SCRCPY_JAR ?? '/tmp/scrcpy-server-v5.0.1';
const JAR_SHA256 = process.env.SCRCPY_JAR_SHA256 ?? '';
const JAR_REMOTE = process.env.SCRCPY_JAR_REMOTE ?? '/data/local/tmp/scrcpy-server.jar';
const ADB_RANGE_START = Number(process.env.SIDECAR_ADB_RANGE_START ?? 16500);
const ADB_RANGE_END = Number(process.env.SIDECAR_ADB_RANGE_END ?? 16549);
const FWD_RANGE_START = Number(process.env.SIDECAR_FWD_RANGE_START ?? 16520);
const FWD_RANGE_END = Number(process.env.SIDECAR_FWD_RANGE_END ?? 16549);
const MAX_SESSIONS = Number(process.env.SIDECAR_MAX_SESSIONS ?? 5);
const ZERO_FRAME_MS = Number(process.env.SIDECAR_ZERO_FRAME_MS ?? 10_000);

if (TOKEN.length < 32) {
  console.error('stream-sidecar: STREAM_SIDECAR_TOKEN must be >= 32 hex chars; refusing to start (fail-closed)');
  process.exit(2);
}
if (!JAR_SHA256 || !/^[0-9a-f]{64}$/.test(JAR_SHA256)) {
  console.error('stream-sidecar: SCRCPY_JAR_SHA256 missing/invalid; refusing to start (fail-closed)');
  process.exit(2);
}

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: ['req.headers.authorization', '*.token'], censor: '[redacted]' },
});

// ---- host-loopback port pool for adb forwards (video+control pairs) ---------------
const usedPorts = new Set();
function allocPorts() {
  for (let base = FWD_RANGE_START; base + 1 <= FWD_RANGE_END; base += 2) {
    if (!usedPorts.has(base) && !usedPorts.has(base + 1)) {
      usedPorts.add(base); usedPorts.add(base + 1);
      return { video: base, control: base + 1 };
    }
  }
  return null;
}
function freePorts(p) { usedPorts.delete(p.video); usedPorts.delete(p.control); }

// ---- session registry --------------------------------------------------------------
/** @type {Map<string, {ws:import('ws').WebSocket, session:StreamSession, ports:{video:number,control:number}}>} */
const sessions = new Map();

function isAllowedSerial(serial) {
  const m = /^127\.0\.0\.1:(\d+)$/.exec(String(serial ?? ''));
  if (!m) return false;
  const p = Number(m[1]);
  return Number.isInteger(p) && p >= ADB_RANGE_START && p <= ADB_RANGE_END;
}

function checkToken(t) {
  if (typeof t !== 'string' || t.length === 0) return false;
  const a = Buffer.from(t);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  const conn = { phase: 'await-auth', leaseId: null, timer: null };
  const fail = (code, message, httpStatus) => {
    try { ws.send(JSON.stringify({ t: 'error', code, message, httpStatus })); } catch {}
    ws.close(1008, code);
    log.warn({ code, ip: req.socket.remoteAddress }, 'sidecar reject');
  };
  conn.timer = setTimeout(() => { try { ws.close(1008, 'AUTH_TIMEOUT'); } catch {} }, 5_000);
  conn.timer.unref?.();

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (conn.phase === 'await-auth') {
      if (m?.t !== 'auth' || !checkToken(m.token)) {
        clearTimeout(conn.timer);
        conn.phase = 'dead';
        return fail('SIDECAR_AUTH_FAILED', 'invalid sidecar token', 401);
      }
      clearTimeout(conn.timer);
      conn.phase = 'await-session';
      ws.send(JSON.stringify({ t: 'auth-ok' }));
      return;
    }
    if (conn.phase === 'await-session') {
      clearTimeout(conn.timer);
      if (m?.t !== 'session') return fail('SIDECAR_BAD_FIRST_FRAME', 'expected session frame', 400);
      const { leaseId, serial, userId, mode, videoSource, quality } = m;
      if (typeof leaseId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leaseId)) {
        return fail('SIDECAR_BAD_LEASE_ID', 'invalid leaseId', 400);
      }
      if (sessions.has(leaseId)) return fail('SIDECAR_SESSION_EXISTS', 'lease already streaming', 409);
      if (sessions.size >= MAX_SESSIONS) return fail('SIDECAR_CAPACITY', `sidecar session limit ${MAX_SESSIONS}`, 503);
      if (!isAllowedSerial(serial)) {
        return fail('SIDECAR_SERIAL_NOT_ALLOWED', 'serial not in loopback allowlist range', 403);
      }
      if (mode !== 'viewer' && mode !== 'controller') return fail('SIDECAR_BAD_MODE', 'mode must be viewer|controller', 400);
      const q = resolveQuality(quality);
      const ports = allocPorts();
      if (!ports) return fail('SIDECAR_PORTS_EXHAUSTED', 'no free forward port pair', 503);
      conn.phase = 'starting';
      conn.leaseId = leaseId;
      log.info({ leaseId, mode, videoSource, quality: q.name, ports }, 'sidecar session starting');
      const session = new StreamSession({
        leaseId,
        serial,
        userId,
        mode,
        videoSource: ['auto', 'scrcpy', 'screencap'].includes(videoSource) ? videoSource : 'auto',
        quality: q.name,
        ports,
        adb: ADB,
        jar: JAR,
        jarSha256: JAR_SHA256,
        jarRemote: JAR_REMOTE,
        zeroFrameMs: ZERO_FRAME_MS,
        fwdRange: [FWD_RANGE_START, FWD_RANGE_END],
        log: log.child({ leaseId }),
        sendText: (t) => { if (ws.readyState === 1) ws.send(t); },
        sendBinary: (b) => { if (ws.readyState === 1) ws.send(b); },
        onDead: (reason) => {
          const rec = sessions.get(leaseId);
          if (rec) { sessions.delete(leaseId); freePorts(rec.ports); }
          log.warn({ leaseId, reason: String(reason).slice(0, 200) }, 'sidecar session dead');
          try { ws.send(JSON.stringify({ t: 'dead', reason: String(reason).slice(0, 200) })); } catch {}
          ws.close(1011, 'STREAM_DIED');
        },
      });
      sessions.set(leaseId, { ws, session, ports });
      session.start()
        .then(() => {
          if (conn.phase === 'starting') {
            conn.phase = 'live';
            ws.send(JSON.stringify({ t: 'ready', leaseId }));
            log.info({ leaseId }, 'sidecar session ready');
          }
        })
        .catch((e) => {
          const rec = sessions.get(leaseId);
          if (rec) { sessions.delete(leaseId); freePorts(rec.ports); }
          session.kill(String(e).slice(0, 200));
          fail('SIDECAR_START_FAILED', String(e).slice(0, 200), e?.code === 'ADB_OFFLINE' ? 503 : 500);
        });
      return;
    }
    if (conn.phase === 'live' || conn.phase === 'starting') {
      const rec = sessions.get(conn.leaseId);
      if (!rec) return;
      if (m?.t === 'input') {
        const res = rec.session.input(m);
        if (!res.ok) {
          log.warn({ leaseId: conn.leaseId, code: res.code, kind: m?.kind }, 'sidecar input rejected');
          try { ws.send(JSON.stringify({ t: 'input-rejected', code: res.code, message: res.message })); } catch {}
        }
      } else if (m?.t === 'close') {
        log.info({ leaseId: conn.leaseId }, 'sidecar close requested');
        rec.session.kill('client close');
        sessions.delete(conn.leaseId);
        freePorts(rec.ports);
        try { ws.close(1000, 'CLOSED'); } catch {}
        conn.phase = 'dead';
      } else if (m?.t === 'ping') {
        try { ws.send(JSON.stringify({ t: 'pong' })); } catch {}
      }
      return;
    }
  });
  ws.on('close', () => {
    // API socket gone (crash/restart/network) → the stream dies with it
    // (MD §10: sidecar restart ⇒ kill residual processes).
    if (conn.leaseId && sessions.has(conn.leaseId)) {
      const rec = sessions.get(conn.leaseId);
      rec.session.kill('gateway connection lost');
      sessions.delete(conn.leaseId);
      freePorts(rec.ports);
      log.warn({ leaseId: conn.leaseId }, 'sidecar session torn down (gateway gone)');
    }
  });
  ws.on('error', (e) => log.warn({ leaseId: conn.leaseId, e: String(e) }, 'sidecar ws error'));
});

const httpServer = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json', 'x-frame-options': 'DENY' });
    res.end(JSON.stringify(obj));
  };
  if (req.url === '/health') return send(200, { ok: true, sessions: sessions.size, pid: process.pid });
  if (req.url === '/sessions') {
    return send(200, {
      maxSessions: MAX_SESSIONS,
      sessions: [...sessions.values()].map((r) => r.session.summary),
    });
  }
  send(404, { error: { code: 'NOT_FOUND', message: 'not found', requestId: null } });
});

httpServer.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '', 'http://x').pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

httpServer.listen(PORT, '127.0.0.1', () => {
  // WS rides the same 127.0.0.1 listener (noServer + handleUpgrade):
  // /health + /sessions over HTTP, /ws over WebSocket upgrade.
  log.info({ port: PORT, fwdRange: [FWD_RANGE_START, FWD_RANGE_END], maxSessions: MAX_SESSIONS }, 'stream-sidecar listening');
});

const shutdown = (sig) => {
  log.info({ sig }, 'stream-sidecar shutting down');
  for (const [id, rec] of sessions) {
    try { rec.session.kill('sidecar shutdown'); } catch {}
    try { rec.ws.close(1001, 'shutdown'); } catch {}
  }
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log.error({ e: String(e) }, 'unhandledRejection'));
