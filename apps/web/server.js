/**
 * web container runtime: static file server + /api reverse proxy (zero deps).
 *
 * The API is same-origin (施工 MD §15): browsers only ever see
 * http://127.0.0.1:3012; /api/* is proxied to the api service.
 * Binds all interfaces INSIDE the container only — the compose port publish
 * is restricted to 127.0.0.1 on the host.
 */
import http from 'node:http';
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

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`web listening on ${HOST}:${PORT} (api upstream: ${UPSTREAM})`);
});
