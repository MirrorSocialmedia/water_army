/**
 * mock-echo.js — bidirectional payload-verification HTTP endpoint (R2 / Phase 2).
 *
 * Unlike mock-sink.js (plain 200), this endpoint verifies PAYLOAD CONTENT in
 * both directions, per repair MD §4.3 test 5:
 *   - logs the EXACT byte count + sha256 of the received request body,
 *   - responds with a DETERMINISTIC text body derived from the request
 *     (nonce / method / url / req_bytes / req_sha256), so the host harness
 *     can predict the exact response bytes and the device capture must match
 *     them byte-for-byte (return direction), while the host compares the
 *     logged req_bytes/req_sha256 against what it sent (forward direction).
 *
 * Modes:
 *   (default)  full echo response, Connection: close
 *   --hang     accept + read + log the request, then NEVER respond
 *              (client read-timeout test; socket held open)
 *   --rst      on first request bytes: log + destroy the socket while data
 *              is pending (kernel sends RST — connection-reset test)
 *
 * Usage:
 *   node tests/mocks/mock-echo.js --port 20271 --log /tmp/r2-net/echo.jsonl \
 *        [--bind 0.0.0.0] [--hang] [--rst]
 *
 * Exit: SIGTERM/SIGINT -> exit 0.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildEchoBody } from './echo-body.js';

function parseArgs(argv) {
  const args = { port: null, log: null, bind: '0.0.0.0', hang: false, rst: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port') args.port = Number(next());
    else if (a === '--log') args.log = next();
    else if (a === '--bind') args.bind = next();
    else if (a === '--hang') args.hang = true;
    else if (a === '--rst') args.rst = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!args.port || !args.log) throw new Error('--port and --log are required');
  return args;
}

const CFG = parseArgs(process.argv);
const LOG = CFG.log;
fs.mkdirSync(path.dirname(LOG), { recursive: true });

let seq = 0;
const ts = () => new Date().toISOString();
function log(obj) {
  try { fs.appendFileSync(LOG, JSON.stringify({ ts: ts(), ...obj }) + '\n'); }
  catch (err) { process.stderr.write(`mock-echo: log write failed: ${err.message}\n`); }
}
process.on('uncaughtException', (err) => { log({ t: 'fatal', err: String(err && err.stack || err) }); process.exit(1); });

// --rst mode needs raw-socket control before the HTTP parser.
if (CFG.rst) {
  const net = (await import('node:net')).default;
  const server = net.createServer((socket) => {
    const from = `${socket.remoteAddress}:${socket.remotePort}`;
    socket.once('data', (chunk) => {
      const head = chunk.toString('latin1', 0, Math.min(64, chunk.length));
      log({ t: 'rst-armed', from, first: head.replace(/\r?\n/g, ' | ').slice(0, 96) });
      socket.destroy(); // unread data pending -> kernel RST
    });
    socket.on('error', () => {});
  });
  server.listen(CFG.port, CFG.bind, () => {
    log({ t: 'mock-start', port: CFG.port, mode: 'rst' });
    process.stderr.write(`mock-echo[rst] listening on ${CFG.bind}:${CFG.port}\n`);
  });
  const stop = (sig) => { log({ t: 'mock-stop', sig }); process.exit(0); };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
} else {
  const server = http.createServer((req, res) => {
    const from = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total <= 16 * 1024 * 1024) chunks.push(c);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const sha256 = crypto.createHash('sha256').update(body).digest('hex');
      const nonce = req.headers['x-nonce'] ?? null;
      const entry = {
        t: CFG.hang ? 'http-hang' : 'http-echo',
        seq: ++seq,
        method: req.method,
        url: req.url,
        host: req.headers.host || null,
        nonce,
        from,
        bytes: body.length,
        sha256,
      };
      log(entry);
      if (CFG.hang) return; // never respond (client read-timeout test)
      const payload = buildEchoBody({ nonce, method: req.method, url: req.url, bytes: body.length, sha256 });
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Length': Buffer.byteLength(payload),
        Connection: 'close',
      });
      res.end(payload);
    });
    req.on('error', (err) => log({ t: 'http-req-error', from, err: err.message }));
  });
  server.listen(CFG.port, CFG.bind, () => {
    log({ t: 'mock-start', port: CFG.port, mode: CFG.hang ? 'hang' : 'echo' });
    process.stderr.write(`mock-echo[${CFG.hang ? 'hang' : 'echo'}] listening on ${CFG.bind}:${CFG.port}\n`);
  });
  const stop = (sig) => { log({ t: 'mock-stop', sig }); process.exit(0); };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
