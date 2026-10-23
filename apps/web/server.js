/**
 * web container runtime: static file server + /api reverse proxy (zero deps).
 *
 * The API is same-origin (施工 MD §15): browsers only ever see
 * http://127.0.0.1:3012; /api/* is proxied to the api service.
 * Binds all interfaces INSIDE the container only — the compose port publish
 * is restricted to 127.0.0.1 on the host.
 */
import http from 'node:http';
import net from 'node:net';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');
const PORT = Number(process.env.WEB_PORT ?? 3012);
const HOST = process.env.WEB_HOST ?? '0.0.0.0'; // container-internal; host binds 127.0.0.1
const UPSTREAM = process.env.API_UPSTREAM ?? 'http://api:3000';
const upstreamUrl = new URL(UPSTREAM);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host',
]);

function sendStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  let filePath = path.normalize(path.join(DIST, urlPath));
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }));
    return;
  }
  // SPA fallback: non-file paths serve index.html
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, 'index.html');
  }
  const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  createReadStream(filePath).pipe(res);
}

function proxyApi(req, res) {
  // Forward client headers minus hop-by-hop, then OVERWRITE the forwarding
  // headers with the real socket peer. Overwriting (not appending) is what
  // stops a client from spoofing its source IP: whatever X-Forwarded-For /
  // X-Real-IP / Forwarded the client sent is discarded, and the api — which
  // trusts this single hop — keys login rate limiting on the true client IP.
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([k]) => {
      const key = k.toLowerCase();
      return !HOP_BY_HOP.has(key) && key !== 'x-forwarded-for' && key !== 'x-real-ip' && key !== 'forwarded';
    }),
  );
  const clientIp = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (clientIp) {
    headers['x-forwarded-for'] = clientIp;
    headers['x-real-ip'] = clientIp;
  }
  const upstreamReq = http.request(
    {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port,
      method: req.method,
      path: req.url,
      headers,
    },
    (upstreamRes) => {
      const headers = Object.fromEntries(
        Object.entries(upstreamRes.headers).filter(([k]) => !HOP_BY_HOP.has(k.toLowerCase())),
      );
      res.writeHead(upstreamRes.statusCode ?? 502, headers);
      upstreamRes.pipe(res);
    },
  );
  upstreamReq.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'INTERNAL', message: `api upstream unreachable: ${err.code ?? err.message}` } }));
  });
  req.pipe(upstreamReq);
}

const server = http.createServer((req, res) => {
  const urlPath = new URL(req.url, 'http://localhost').pathname;
  if (urlPath.startsWith('/api/')) {
    proxyApi(req, res);
  } else {
    sendStatic(req, res);
  }
});

// --- P2: WebSocket upgrade passthrough for the console stream endpoint --------
// The zero-dep proxy has no WS support by default (audit finding #1). The ONLY
// upgrade we tunnel is the authenticated console stream WS (MD §8.1);
// everything else is refused. After the upstream answers 101 we blind-pipe the
// two TCP sockets — the web layer never parses or logs stream bytes.
const WS_STREAM_PATH = /^\/api\/device-streams\/[^/]+\/ws$/;

function tunnelUpgrade(req, socket, head) {
  const isStreamWs = WS_STREAM_PATH.test(new URL(req.url, 'http://localhost').pathname);
  if (!isStreamWs) {
    socket.write('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const upstream = new URL(UPSTREAM);
  const upstreamHost = upstream.hostname || '127.0.0.1';
  const upstreamPort = Number(upstream.port || 3000);

  // Rebuild the request head for the upstream, preserving the upgrade + WS
  // handshake headers (host rewritten to the upstream; cookie/origin forwarded
  // so the API's own server-side auth chain — the authoritative check — runs).
  const lines = [`${req.method} ${req.url} HTTP/1.1`, `host: ${upstreamHost}:${upstreamPort}`];
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'host') continue;
    lines.push(`${k}: ${v}`);
  }
  const headBuf = Buffer.from(lines.join('\r\n') + '\r\n\r\n');

  const upstreamSock = net.connect(upstreamPort, upstreamHost);
  let settled = false;
  const killBoth = (why) => {
    if (settled) return;
    settled = true;
    try { upstreamSock.destroy(); } catch {}
    try { socket.destroy(); } catch {}
    if (why) console.warn(`ws tunnel torn down: ${why}`);
  };
  upstreamSock.on('connect', () => {
    upstreamSock.write(headBuf);
    // Initial bytes already buffered by node for the upgrade (may include the
    // first WS frames the browser sent eagerly) — go straight after the head.
    if (head && head.length) upstreamSock.write(head);
  });
  upstreamSock.on('data', (d) => { if (!socket.destroyed) socket.write(d); });
  upstreamSock.on('error', (e) => killBoth(e.message));
  upstreamSock.on('close', () => { if (!socket.destroyed) socket.end(); settled = true; });
  socket.on('data', (d) => { if (!upstreamSock.destroyed) upstreamSock.write(d); });
  socket.on('error', (e) => killBoth(e.message));
  socket.on('close', () => { if (!upstreamSock.destroyed) upstreamSock.end(); settled = true; });
}
server.on('upgrade', tunnelUpgrade);

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`web listening on ${HOST}:${PORT} (api upstream: ${UPSTREAM})`);
});
