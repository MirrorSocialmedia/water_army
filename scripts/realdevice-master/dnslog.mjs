/**
 * Scratch W3 DNS observation point (egress-dnslog, 172.38.222.52:53/udp).
 * Logs every query: {ts, src, name, qtype}. src = the ladder IP the query
 * arrived from (egress-a/b IP when DNS rides the tunnel = D4(a) evidence).
 * Query dump: GET :8080/queries (most recent 2000).
 */
import dgram from 'node:dgram';
import http from 'node:http';
import fs from 'node:fs';
const LOG = '/var/log/dnslog.jsonl';
const recent = [];
const log = (o) => { recent.push(o); if (recent.length > 2000) recent.shift(); try { fs.appendFileSync(LOG, JSON.stringify(o) + '\n'); } catch {} };

function parseName(buf, off) {
  const parts = [];
  let p = off;
  while (p < buf.length) {
    const len = buf[p];
    if (len === 0) return parts.join('.');
    if (len & 0xc0) return parts.join('.') || '<compressed>';
    parts.push(buf.subarray(p + 1, p + 1 + len).toString('utf8'));
    p += 1 + len;
  }
  return parts.join('.');
}

const s = dgram.createSocket('udp4');
s.on('message', (msg, rinfo) => {
  if (msg.length < 12) return;
  const qd = (msg[4] << 8) | msg[5];
  let off = 12;
  for (let i = 0; i < qd; i++) {
    if (off >= msg.length) break;
    const name = parseName(msg, off);
    let p = off;
    while (p < msg.length && msg[p] !== 0 && !(msg[p] & 0xc0)) p += 1 + msg[p];
    off = p + (msg[p] & 0xc0 ? 2 : 1 + msg[p]); // past name
    const qtype = off + 1 < msg.length ? (msg[off] << 8) | msg[off + 1] : 0;
    off += 4; // qtype + qclass
    log({ ts: new Date().toISOString(), src: rinfo.address, name, qtype });
  }
});
s.on('error', (e) => console.log('dnslog err', e.message));
s.bind(53, '0.0.0.0');
http.createServer((req, res) => {
  if (req.url === '/queries') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(recent.slice(-2000))); }
  else { res.writeHead(200); res.end('ok\n'); }
}).listen(8080, '0.0.0.0');
console.log('[rdev-dnslog] :53/udp + :8080/queries');
