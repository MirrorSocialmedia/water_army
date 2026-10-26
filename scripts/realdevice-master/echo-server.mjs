/**
 * W3 IP-echo endpoint (scratch) — ADR-027 §27.2 probe contract:
 *   GET /ip?nonce=<n>  ->  200, body: `client_ip=<source IP> nonce=<n>`
 *
 * Plus the R3 net-axis data-plane canary (buildT2sCanaryScript contract):
 *   POST /canary  (header X-Nonce: <n>, 512 random bytes body)
 *   ->  200, body: `nonce=<n> req_sha256=<sha256(body)>`
 * The sha round-trip of a fresh random body per run is the anti-replay /
 * anti-cache proof: only a live data plane through the tunnel can answer.
 * CANARY_HOST_RE constrains the canary host to plain hostname/IPv4, so
 * 192.168.31.144:16491 serves BOTH the egress probe (/ip) and the net canary
 * (/canary) — one scratch endpoint, both anchors.
 *
 * Scratch semantics: the probe reaches us THROUGH the per-identity egress
 * proxy chain (device tun0 -> t2s -> socks5 -> per-device gost -> egress proxy
 * container -> this host server), so req socket remote address = the egress
 * proxy's ladder IP = the identity's pinned egress IP (private analog of the
 * production public exit IP). nonce echo = anti-replay/anti-fake contract.
 *
 * Binds 0.0.0.0:16491 (scratch port, documented in common.sh). No auth on
 * purpose (scratch-only, loopback-reachable via tunnel only in the intended
 * flow; the server itself logs nothing that looks like a credential).
 */
import http from 'node:http';
import { createHash } from 'node:crypto';

const PORT = Number(process.env.RD_ECHO_PORT ?? 16491);
const HOST = process.env.RD_ECHO_HOST_BIND ?? '0.0.0.0';
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${HOST}`);
  if (req.method === 'GET' && u.pathname === '/ip') {
    const nonce = u.searchParams.get('nonce') ?? '';
    const ip = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown';
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`client_ip=${ip} nonce=${nonce}\n`);
    return;
  }
  if (req.method === 'GET' && u.pathname === '/resolve') {
    // DoH mimic (D4b, ADR-027): the guest issues an HTTP "DNS" query over the
    // tunnel; the response echoes which source IP it arrived from — proves
    // which egress the name-resolution traffic exits from.
    const name = u.searchParams.get('name') ?? '';
    const ip = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Status: 0, client_ip: ip, Question: [{ name: name || 'unknown' }] }));
    return;
  }
  if (req.method === 'POST' && u.pathname === '/canary') {
    // R3 data-plane canary: echo the nonce + sha256 of the request body.
    // The probe payload is 512 fresh random bytes per run (client-side
    // /dev/urandom) — a replayed/cached response cannot match the sha.
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const sha = createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
      const nonce = String(req.headers['x-nonce'] ?? '');
      res.writeHead(200, { 'content-type': 'text/plain', 'connection': 'close' });
      res.end(`nonce=${nonce} req_sha256=${sha}\n`);
    });
    req.on('error', () => { try { res.destroy(); } catch { /* noop */ } });
    return;
  }
  if (req.method === 'GET' && u.pathname === '/healthz') { res.writeHead(200); res.end('ok\n'); return; }
  res.writeHead(404); res.end('not found\n');
});
server.listen(PORT, HOST, () => console.log(`[rdev-echo] listening ${HOST}:${PORT}`));
