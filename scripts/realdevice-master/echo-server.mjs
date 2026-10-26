/**
 * W3 IP-echo endpoint (scratch) — ADR-027 §27.2 probe contract:
 *   GET /ip?nonce=<n>  ->  200, body: `client_ip=<source IP> nonce=<n>`
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
  if (req.method === 'GET' && u.pathname === '/healthz') { res.writeHead(200); res.end('ok\n'); return; }
  res.writeHead(404); res.end('not found\n');
});
server.listen(PORT, HOST, () => console.log(`[rdev-echo] listening ${HOST}:${PORT}`));
