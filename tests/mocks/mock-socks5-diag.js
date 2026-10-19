/**
 * mock-socks5.js — hermetic SOCKS5 sink for Redroid matrix Stage B tests.
 *
 * WHAT IT IS
 *   A minimal, dependency-free SOCKS5 server that stands in for the real
 *   residential proxy. It LOGS every session to a JSONL file (the evidence
 *   for the workorder) and:
 *     - TCP CONNECT  -> relays bidirectionally to a local HTTP sink
 *                       (default 127.0.0.1:20090) so end-to-end HTTP works.
 *     - UDP ASSOCIATE -> intercepts DNS queries: the configured canary
 *                       domain answers with a fixed A record, everything
 *                       else gets NXDOMAIN. Non-DNS UDP is logged, no reply
 *                       (a real proxy would forward it; the test point is
 *                       PATH evidence, not payload success).
 *
 * WHY A CANARY DOMAIN UNDER .example (RFC 2606 reserved)
 *   No real resolver can answer `*.canary.example` (NXDOMAIN in the real
 *   world). If a device's DNS reaches the mock, the ONLY possible source is
 *   the proxy path — this is what makes "DNS 經 proxy" provable.
 *
 * Usage:
 *   node tests/mocks/mock-socks5.js \
 *     --port 20082 \
 *     --log /tmp/redroid-b/mock1.jsonl \
 *     [--relay 127.0.0.1:20090] \
 *     [--canary canary.example] \
 *     [--answer 93.184.216.34]
 *
 * Exit: SIGTERM/SIGINT -> flush + exit 0.
 */

import net from 'node:net';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
  const args = {
    port: null,
    log: null,
    relay: '127.0.0.1:20090',
    canary: 'canary.example',
    answer: '93.184.216.34',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port') args.port = Number(next());
    else if (a === '--log') args.log = next();
    else if (a === '--relay') args.relay = next();
    else if (a === '--canary') args.canary = next();
    else if (a === '--answer') args.answer = next();
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!args.port || !args.log) throw new Error('--port and --log are required');
  return args;
}

const CFG = parseArgs(process.argv);
const LOG = CFG.log;
fs.mkdirSync(path.dirname(LOG), { recursive: true });

const ts = () => new Date().toISOString();
function log(obj) {
  try { fs.appendFileSync(LOG, JSON.stringify({ ts: ts(), ...obj }) + '\n'); }
  catch (err) { process.stderr.write(`mock-socks5: log write failed: ${err.message}\n`); }
}
process.on('uncaughtException', (err) => { log({ t: 'fatal', err: String(err && err.stack || err) }); process.exit(1); });
process.on('unhandledRejection', (err) => { log({ t: 'fatal-rejection', err: String(err && err.stack || err) }); });

// ------------------------------------------------- minimal DNS parsing
function parseDnsName(buf, offset) {
  // Returns { name, offset } — handles simple names (no compression needed
  // for queries).
  const labels = [];
  let o = offset;
  while (o < buf.length) {
    const len = buf[o];
    if (len === 0) { o += 1; break; }
    if (len & 0xc0) throw new Error('compressed pointer in query — unsupported');
    o += 1;
    labels.push(buf.toString('ascii', o, o + len));
    o += len;
  }
  return { name: labels.join('.') || null, offset: o };
}

function encodeDnsName(name) {
  const parts = String(name).split('.');
  const nameBuf = Buffer.alloc(1 + parts.reduce((n, p) => n + 1 + p.length, 0));
  let o = 0;
  for (const p of parts) {
    nameBuf[o++] = p.length;
    Buffer.from(p, 'ascii').copy(nameBuf, o);
    o += p.length;
  }
  nameBuf[o] = 0;
  return nameBuf;
}

function dnsHeader(id, flags) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header[2] = flags; // QR=1, AA=1, RD=1, RA=1
  return header;
}

function dnsQuestion(name, questionType) {
  return Buffer.concat([
    encodeDnsName(name),
    Buffer.from([(questionType >> 8) & 0xff, questionType & 0xff, 0x00, 0x01]), // QTYPE=A QCLASS=IN
  ]);
}

function buildDnsAnswer(query, { id, name, questionType, answerIp }) {
  const header = dnsHeader(id, 0x81);
  header.writeUInt16BE(1, 6); // QDCOUNT
  header.writeUInt16BE(1, 8); // ANCOUNT
  const answer = Buffer.alloc(12 + 4);
  answer.writeUInt16BE(0xc00c, 0); // name pointer to question
  answer.writeUInt16BE(1, 4); // TYPE=A
  answer.writeUInt16BE(1, 6); // CLASS=IN
  answer.writeUInt16BE(60, 8); // TTL
  answer.writeUInt16BE(4, 10); // RDLENGTH
  Buffer.from(answerIp.split('.').map(Number)).copy(answer, 12);
  return Buffer.concat([header, dnsQuestion(name, questionType), answer]);
}

function buildDnsNxDomain(query, { id, name, questionType }) {
  const header = dnsHeader(id, 0x81);
  header.writeUInt16BE(1, 6);
  header.writeUInt16BE(0, 8);
  return Buffer.concat([header, dnsQuestion(name, questionType)]);
}

// ------------------------------------------------------------- UDP side
// One bound UDP socket; per source-port bookkeeping (SOCKS5 associate is
// per client source port).
const udpMain = dgram.createSocket('udp4');
const udpSeen = new Set(); // "ip:port" that sent an ASSOCIATE

function tryHandleDns(payload, remote) {
  if (payload.length < 12) return false;
  try {
    const id = payload.readUInt16BE(0);
    const { name, offset } = parseDnsName(payload, 12);
    if (!name) return false;
    const questionType = payload.readUInt16BE(offset);
    const isCanary = name === CFG.canary || name.endsWith(`.${CFG.canary}`);
    log({ t: 'dns', name, qtype: questionType, canary: isCanary, from: remote });
    const reply = isCanary
      ? buildDnsAnswer(payload, { id, name, questionType, answerIp: CFG.answer })
      : buildDnsNxDomain(payload, { id, name, questionType });
    udpMain.send(reply, remote.split(':')[1], remote.split(':')[0]);
    return true;
  } catch (err) {
    log({ t: 'dns-error', err: String(err && err.message || err) });
    return false;
  }
}

udpMain.on('message', (msg, rinfo) => {
  const remote = `${rinfo.address}:${rinfo.port}`;
  if (msg[0] !== 0x05) { log({ t: 'udp-reject', why: 'bad-version', from: remote }); return; }
  if (!udpSeen.has(remote)) {
    // ASSOCIATE request: 05 03 00 ATYP bnd-addr bnd-port
    if (msg[1] !== 0x03) { log({ t: 'udp-reject', why: `cmd-${msg[1]}-not-associate`, from: remote }); return; }
    log({ t: 'udp-associate', from: remote });
    udpSeen.add(remote);
    return;
  }
  // Flow datagram: 05 00 ATYP dest-addr dest-port payload
  // (NOTE: no RSV byte in the UDP flow header — unlike TCP CONNECT which has
  //  VER CMD RSV ATYP. ATYP is byte 2 here.)
  let o = 2;
  const atyp = msg[o++];
  let dest;
  if (atyp === 0x01) { dest = `${msg[o]}.${msg[o + 1]}.${msg[o + 2]}.${msg[o + 3]}`; o += 4; }
  else if (atyp === 0x03) { const len = msg[o++]; dest = msg.toString('ascii', o, o + len); o += len; }
  else if (atyp === 0x04) { o += 16; dest = 'ipv6'; }
  else { log({ t: 'udp-reject', why: `bad-atyp-${atyp}`, from: remote }); return; }
  const dport = msg.readUInt16BE(o);
  o += 2;
  const payload = msg.subarray(o);
  log({ t: 'udp-flow', dest: `${dest}:${dport}`, bytes: payload.length, from: remote, raw: msg.length <= 64 ? msg.toString('hex') : undefined });
  if (dport === 53 && tryHandleDns(payload, remote)) return;
  // Non-DNS UDP: no reply. A real proxy would forward; the test point is
  // that the packet took the proxy path (logged above), not that it got an answer.
});
udpMain.on('error', (err) => log({ t: 'udp-error', err: err.message }));

// ------------------------------------------------------------- TCP side
const tcpServer = net.createServer((client) => {
  const from = `${client.remoteAddress}:${client.remotePort}`;
  let state = 'greeting';
  let handshakeBuf = Buffer.alloc(0);
  let relaying = false;

  const onData = (chunk) => {
    handshakeBuf = Buffer.concat([handshakeBuf, chunk]);
    if (state === 'greeting') {
      // Greeting: VER(1) NMETHODS(1) METHODS(nmethods). Consume exactly
      // that; everything after belongs to the CONNECT request.
      if (handshakeBuf.length < 2) return;
      if (handshakeBuf[0] !== 0x05) { log({ t: 'tcp-reject', why: 'bad-version', from }); client.destroy(); return; }
      const nmethods = handshakeBuf[1];
      if (handshakeBuf.length < 2 + nmethods) return;
      client.write(Buffer.from([0x05, 0x00])); // no auth
      state = 'request';
      handshakeBuf = handshakeBuf.subarray(2 + nmethods);
    }
    if (state !== 'request' || relaying) return;
    // VER CMD RSV ATYP ... — need at least 4 bytes before we know ATYP length.
    while (handshakeBuf.length >= 4) {
      const ver = handshakeBuf[0];
      const cmd = handshakeBuf[1];
      const atyp = handshakeBuf[3];
      let addrLen;
      let addr;
      if (atyp === 0x01) {
        if (handshakeBuf.length < 10) return;
        addr = `${handshakeBuf[4]}.${handshakeBuf[5]}.${handshakeBuf[6]}.${handshakeBuf[7]}`;
        addrLen = 10;
      } else if (atyp === 0x03) {
        if (handshakeBuf.length < 5 + handshakeBuf[4] + 2) return;
        addr = handshakeBuf.toString('ascii', 5, 5 + handshakeBuf[4]);
        addrLen = 5 + handshakeBuf[4] + 2;
      } else if (atyp === 0x04) {
        if (handshakeBuf.length < 22) return;
        const b = handshakeBuf;
        addr = [4, 6, 8, 10, 12, 14, 16, 18].map((i) => b.slice(i, i + 2).toString('hex')).join(':');
        addrLen = 22;
      } else {
        log({ t: 'tcp-reject', why: `bad-atyp-${atyp}`, from });
        client.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0]));
        client.destroy();
        return;
      }
      if (ver !== 0x05) { log({ t: 'tcp-reject', why: `bad-ver-${ver}`, from, raw: handshakeBuf.length <= 64 ? handshakeBuf.toString('hex') : undefined }); client.destroy(); return; }
      if (cmd !== 0x01) { log({ t: 'tcp-reject', why: `cmd-${cmd}`, from, raw: handshakeBuf.length <= 64 ? handshakeBuf.toString('hex') : undefined }); client.destroy(); return; }
      const port = handshakeBuf.readUInt16BE(addrLen - 2);
      const rest = Buffer.from(handshakeBuf.subarray(addrLen));
      relaying = true;
      log({ t: 'tcp-connect', dest: `${addr}:${port}`, from, restLen: rest.length });
      const [relayHost, relayPort] = CFG.relay.split(':');
      const upstream = net.connect(Number(relayPort), relayHost);
      const relayed = { bytesIn: rest.length, bytesOut: 0 };
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0]));
      upstream.on('connect', () => {
        log({ t: 'diag-upstream-connect', dest: `${addr}:${port}` });
        if (rest.length) { log({ t: 'diag-write-up', len: rest.length, origin: 'rest', head: rest.subarray(0, 48).toString('hex') }); upstream.write(rest); }
      });
      upstream.on('data', (d) => { relayed.bytesOut += d.length; log({ t: 'diag-write-cl', len: d.length, head: d.subarray(0, 48).toString('hex') }); client.write(d); });
      client.removeAllListeners('data');
      client.on('data', (d) => {
        relayed.bytesIn += d.length;
        log({ t: 'diag-read-cl', len: d.length, total: relayed.bytesIn, head: d.subarray(0, 48).toString('hex') });
        log({ t: 'diag-write-up', len: d.length, origin: 'data', head: d.subarray(0, 48).toString('hex') });
        upstream.write(d);
      });
      let closed = false;
      const done = (why) => {
        if (closed) return;
        closed = true;
        log({ t: 'tcp-close', dest: `${addr}:${port}`, from, ...relayed, why });
        client.destroy();
        upstream.destroy();
      };
      client.on('error', (err) => log({ t: 'tcp-error', from, err: err.message }));
      upstream.on('error', (err) => log({ t: 'relay-error', dest: `${addr}:${port}`, err: err.message }));
      client.on('close', () => done('client-close'));
      upstream.on('close', () => done('upstream-close'));
      return;
    }
  };

  client.on('data', onData);
  client.on('error', (err) => log({ t: 'tcp-error', from, err: err.message }));
});

tcpServer.listen(CFG.port, '0.0.0.0', () => {
  log({ t: 'mock-start', port: CFG.port, relay: CFG.relay, canary: CFG.canary, answer: CFG.answer });
  process.stderr.write(`mock-socks5 listening on :${CFG.port} log=${LOG}\n`);
});
udpMain.bind(CFG.port, '0.0.0.0', () => log({ t: 'mock-udp-bound', port: CFG.port }));

const shutdown = (sig) => { log({ t: 'mock-stop', sig }); process.exit(0); };
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
