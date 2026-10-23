/**
 * P2 T20 — raw WS upgrade with NO session cookie must be rejected BEFORE the
 * 101 (MD §15.2 未登入時直接 401). Goes through the WEB proxy (16492) so the
 * full production path (web tunnel → api upgrade handler) is exercised.
 */
import http from 'node:http';

const [web, leaseId = '00000000-0000-4000-8000-000000000000'] = process.argv.slice(2);
const u = new URL(web);

const req = http.request({
  host: u.hostname,
  port: u.port,
  path: `/api/device-streams/${leaseId}/ws`,
  method: 'GET',
  headers: {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    Origin: u.origin,
  },
  timeout: 8000,
});
req.on('upgrade', () => {
  console.log('FAIL_GOT_101 (upgrade should have been rejected)');
  req.destroy();
  process.exit(1);
});
req.on('response', (res) => {
  let body = '';
  res.on('data', (d) => { body += d; });
  res.on('end', () => {
    const ok = res.statusCode === 401 && body.includes('UNAUTHORIZED');
    console.log(`status=${res.statusCode} body=${body.slice(0, 200)}`);
    console.log(ok ? 'GOT_401' : 'UNEXPECTED_REJECT');
    process.exit(ok ? 0 : 1);
  });
});
req.on('error', (e) => { console.log(`ERROR ${e.message}`); process.exit(1); });
req.on('timeout', () => { console.log('TIMEOUT'); req.destroy(); process.exit(1); });
req.end();
