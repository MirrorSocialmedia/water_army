/**
 * mock-sink.js — tiny HTTP "internet" stand-in for Stage B tests.
 *
 * The mock SOCKS5 server relays accepted CONNECTs here. Every response
 * carries the X-Mock-Sink header so a device can prove end-to-end delivery
 * (request went through the proxy and came back).
 *
 * Usage: node tests/mocks/mock-sink.js --port 20090
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  let port = 20090;
  let log = null;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--port') port = Number(argv[++i]);
    else if (argv[i] === '--log') log = argv[++i];
  }
  return { port, log };
}

const { port, log: LOG } = parseArgs(process.argv);
if (LOG) fs.mkdirSync(path.dirname(LOG), { recursive: true });

const server = http.createServer((req, res) => {
  const body = `mock-sink ok: ${req.method} ${req.url}`;
  res.writeHead(200, {
    'Content-Type': 'text/plain',
    'X-Mock-Sink': '1',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
  if (LOG) {
    fs.appendFileSync(LOG, JSON.stringify({
      ts: new Date().toISOString(),
      t: 'http',
      method: req.method,
      url: req.url,
      host: req.headers.host || null,
      from: `${req.socket.remoteAddress}:${req.socket.remotePort}`,
    }) + '\n');
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stderr.write(`mock-sink listening on 127.0.0.1:${port}\n`);
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
