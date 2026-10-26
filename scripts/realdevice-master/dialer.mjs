/**
 * Scratch W3 drift dialer (egress-c, 172.38.222.53).
 * Relay endpoint: FIRST line "IP PORT\n", then raw bytes are piped through.
 * Every outbound dial originates from THIS container's ladder IP → the
 * observable "exit IP" for drift simulation (D6).
 *
 * Critical: after the first line, data must NOT be re-parsed as lines —
 * the relayed stream (HTTP etc.) contains newlines and would be misread
 * (discovered live: a second "line" 'GET /ip...' → sock.end() killed the
 * relay mid-flight).
 * Log: /var/log/dialer.jsonl (zero credentials).
 */
import net from 'node:net';
import fs from 'node:fs';
const LOG = '/var/log/dialer.jsonl';
const log = (o) => { try { fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n'); } catch {} };

net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  let armed = true;
  const onLine = (d) => {
    if (!armed) return; // never reached (listener removed), defensive
    buf = Buffer.concat([buf, d]);
    const i = buf.indexOf(0x0a);
    if (i < 0) return;
    const line = buf.subarray(0, i).toString('utf8').trim();
    buf = buf.subarray(i + 1); // leftover bytes in the SAME event = relay payload
    armed = false;
    sock.pause(); // buffer the rest safely until the target is up
    const [host, portS] = line.split(' ');
    const port = Number(portS);
    if (!host || !port) { log({ badline: true, line: line.slice(0, 40) }); sock.end(); return; }
    log({ dst: `${host}:${port}` });
    const out = net.connect(port, host);
    out.once('connect', () => {
      if (buf.length) { out.write(buf); buf = Buffer.alloc(0); }
      out.pipe(sock);
      sock.resume();
      sock.pipe(out);
    });
    out.once('error', (e) => { log({ err: String(e.message).slice(0, 100) }); sock.end(); });
  };
  sock.on('data', onLine);
  sock.once('error', () => {});
  sock.once('close', () => {});
}).listen(9999, '0.0.0.0', () => console.log('[rdev-dialer] relay :9999'));
