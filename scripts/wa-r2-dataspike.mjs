/**
 * wa-r2-dataspike.mjs — R2 (Phase 2) layered TCP data-plane spike driver.
 *
 * Runs the MD §4.3 8-layer test sequence against ONE real redroid device
 * (R1 image, tun2socks v2.7.0) with self-owned endpoints only (host egress
 * is blocked — every test target is local to 127.0.0.1 / 172.17.0.1):
 *
 *   L1 baseline direct   : host→echo, device→echo (no tunnel)
 *   L2 tun interface     : ip link/addr/route/rule + /proc/net/dev
 *   L3 tunnel process    : ps/--version/--help/log + binary check script
 *   L4 socks5 transport  : CONNECT + peer response (via canary IP)
 *   L5 bidir payload     : nonce + byte count + sha256, both directions
 *   L6 lifecycle         : sequential / parallel / half-close / clean close
 *                          / timeout / RST / proxy-reject / recovery
 *   L7 large payload     : 1KB → 64KB → 1MB (+ TUN counter deltas)
 *   L8 regression        : DNS canary + TCP + payload + close +
 *                          kill/re-provision error recovery
 *   RD redirect pilot    : in-container iptables REDIRECT + tproxy-mini
 *                          (reviewer Option B minimal verification)
 *
 * Every test verdict: PASS / FAIL / BLOCKED / SKIPPED. Evidence (raw
 * outputs) → --evidence dir (default /tmp/r2-net/evidence).
 *
 * The tunnel is provisioned with the PRODUCTION script bodies imported from
 * redroid-service.js (buildT2sStageScript/buildTunnelSetupScript/
 * buildT2sRunScript) — same bytes the API would run, executed over adb.
 *
 * Usage:
 *   node scripts/wa-r2-dataspike.mjs --phase l1
 *   node scripts/wa-r2-dataspike.mjs --phase tunnel-setup --gost-port 20082
 *   node scripts/wa-r2-dataspike.mjs --phase l45
 *   ... l2 l3 l45 l6 l7 l8 redirect teardown
 *   --adb 127.0.0.1:16002  --evidence /tmp/r2-net/evidence
 *
 * Device-side layout (all under /data/local/tmp): probe, tproxy-mini,
 * r2-pay*.bin, r2-out*.bin, .r2-cmd.sh — cleaned on teardown.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { buildEchoBody } from '../tests/mocks/echo-body.js';
import {
  buildTunnelSetupScript,
  buildTunnelTeardownScript,
  buildT2sStageScript,
  buildT2sRunScript,
  buildT2sCheckScript,
} from '../apps/api/src/services/redroid-service.js';

// ----------------------------------------------------------------- config
const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const CFG = {
  phase: get('--phase', 'l1'),
  adb: get('--adb', '127.0.0.1:16002'),
  adbBin: get('--adb-bin', '/home/kenneth/.openclaw/workspace/tools/platform-tools/adb'),
  container: get('--container', 'redroid-matrix-r2-spike'),
  evidence: get('--evidence', '/tmp/r2-net/evidence'),
  net: '/tmp/r2-net',
  gostPort: Number(get('--gost-port', '20082')),
  direct: '172.17.0.1',            // host bridge IP (device→host direct path)
  canaryIp: '93.184.216.34',        // canary A record (only the mock answers it)
  echoPort: 20271,
  ports: { main: 20082, reject: 20083, hang: 20084, rst: 20085 },
  hostEchoPort: 20271,
  redirect: { listen: 20280, fakePub: '198.51.100.1' }, // TEST-NET-2
};
fs.mkdirSync(CFG.evidence, { recursive: true });
fs.mkdirSync(CFG.net, { recursive: true });
const ADB = CFG.adbBin;
const results = [];

// ----------------------------------------------------------------- helpers
function sha256hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
async function adb(args) {
  return new Promise((resolve) => {
    const p = spawn(ADB, ['-s', CFG.adb, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (rc) => resolve({ rc: rc ?? -1, out: out.replace(/\r/g, ''), err: err.replace(/\r/g, '') }));
    p.on('error', (e) => resolve({ rc: -1, out: '', err: String(e) }));
  });
}
/**
 * Run a blob as a ROOT script inside the container via `docker exec sh -c '<blob>'`
 * — the PRODUCTION geometry (redroid-service execInContainer = dockerode exec,
 * default user root). The blob is passed through a host file + $(cat) so no
 * host-shell re-expansion of the script text can happen. (adb shell runs as
 * uid 2000 — NO CAP_NET_ADMIN — so TUNSETIFF EPERMs; root-only scripts MUST
 * go through this path.)
 */
async function devExec(blob, tag = 'exec') {
  const local = `${CFG.net}/.r2x-${tag}.sh`;
  fs.writeFileSync(local, blob);
  const hostCmd = `sg docker -c 'docker exec ${CFG.container} sh -c "$(cat ${local})"'`;
  return new Promise((resolve) => {
    const p = spawn('bash', ['-c', hostCmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (rc) => resolve({ rc: rc ?? -1, out: out.replace(/\r/g, ''), err: err.replace(/\r/g, '') }));
    p.on('error', (e) => resolve({ rc: -1, out: '', err: String(e) }));
  });
}
/** Run a blob as a device-side shell script (push file, run, capture). */
async function devBlob(blob, tag = 'cmd') {
  const local = `${CFG.net}/.r2-${tag}.sh`;
  fs.writeFileSync(local, blob);
  await adb(['push', local, '/data/local/tmp/.r2-cmd.sh']);
  const r = await adb(['shell', 'sh /data/local/tmp/.r2-cmd.sh']);
  return r;
}
/** adb push + chmod 0755 + verify size. */
async function pushTool(local, remote) {
  const sz = fs.statSync(local).size;
  const r = await adb(['push', local, remote]);
  const v = await adb(['shell', `stat -c %s ${remote} 2>/dev/null`]);
  return { rc: r.rc, ok: String(v.out.trim()) === String(sz), out: r.out };
}
async function pullFile(remote, local) {
  const r = await adb(['pull', remote, local]);
  return { rc: r.rc, ok: r.rc === 0, out: r.out };
}
function ev(name, content) {
  const p = path.join(CFG.evidence, `${name}.txt`);
  fs.writeFileSync(p, content);
  return p;
}
function result(layer, id, name, verdict, detail, evidence) {
  results.push({ layer, id, name, verdict, detail, evidence });
  console.log(`[${verdict}] ${layer}/${id} ${name} — ${detail}`);
}
function finish() {
  const by = (v) => results.filter((r) => r.verdict === v).length;
  console.log(`\n== SUMMARY ${by('PASS')} PASS / ${by('FAIL')} FAIL / ${by('BLOCKED')} BLOCKED / ${by('SKIPPED')} SKIPPED ==`);
  fs.writeFileSync(path.join(CFG.evidence, 'results.json'), JSON.stringify(results, null, 2));
}

// ------------------------------------------------- request / response math
/** Build a full HTTP request buffer (headers + body) for a raw-TCP probe. */
function httpReq({ method = 'GET', url = '/echo', nonce, body, host = CFG.canaryIp }) {
  const head = [
    `${method} ${url} HTTP/1.1`,
    `Host: ${host}`,
    `X-Nonce: ${nonce}`,
    'Content-Type: application/octet-stream',
    `Content-Length: ${body.length}`,
    'Connection: close',
    '', '',
  ].join('\r\n');
  return { req: Buffer.concat([Buffer.from(head, 'ascii'), body]), body, nonce };
}
/**
 * Verify a captured raw-TCP response for an HTTP echo request.
 * Returns { ok, detail, bodyOk, echoLine }. Node adds a non-deterministic
 * Date header — tolerated by stripping it; everything else must match.
 */
function verifyEchoResponse(captured, { nonce, method, url, body }) {
  const text = Buffer.isBuffer(captured) ? captured.toString('binary') : String(captured);
  const i = text.indexOf('\r\n\r\n');
  if (i < 0) return { ok: false, detail: 'no header/body separator' };
  const head = text.slice(0, i);
  let status = null, clen = null;
  for (const line of head.split('\r\n')) {
    if (/^HTTP\/1\.1 \d{3}/.test(line)) status = line;
    if (/^content-length:/i.test(line)) clen = Number(line.split(':')[1].trim());
  }
  const bodyGot = text.slice(i + 4);
  const bodyExp = buildEchoBody({ nonce, method, url, bytes: body.length, sha256: sha256hex(body) });
  const bodyOk = bodyGot === bodyExp;
  const noDate = head.split('\r\n').filter((l) => !/^date:/i.test(l)).join('\r\n');
  const expHead = ['HTTP/1.1 200 OK', 'Content-Type: text/plain', `Content-Length: ${Buffer.byteLength(bodyExp)}`, 'Connection: close'].join('\r\n');
  const headOk = noDate === expHead;
  const clenOk = clen === null || clen === Buffer.byteLength(bodyExp);
  return {
    ok: status === 'HTTP/1.1 200 OK' && bodyOk && headOk && clenOk,
    bodyOk, headOk, clenOk, status,
    detail: `status=${status} headOk=${headOk} bodyOk=${bodyOk} clenOk=${clenOk} recvBytes=${captured.length} expectedBody=${Buffer.byteLength(bodyExp)}`,
  };
}
/** Payload buffer: pseudo-random bytes (deterministic per nonce). */
function makePayload(n, nonce) {
  const seed = crypto.createHash('sha256').update(nonce).digest();
  const buf = Buffer.alloc(n);
  let off = 0;
  while (off < n) {
    const b = crypto.createHash('sha256').update(Buffer.concat([seed, Buffer.from(String(off))])).digest();
    const take = Math.min(b.length, n - off);
    b.copy(buf, off, 0, take);
    off += take;
  }
  return buf;
}

// ------------------------------------------------------- probe over adb
/**
 * Run the static probe on-device.
 * Returns { rc, status (parsed line), sent, recv, outBuf (response bytes), raw }
 */
async function devProbe({ ip, port, payload, mode = 'full', readTimeout = 30, settle = 0, tag }) {
  const payLocal = `${CFG.net}/pay-${tag}.bin`;
  fs.writeFileSync(payLocal, payload);
  const pr = await pushTool(payLocal, '/data/local/tmp/r2-pay.bin');
  if (!pr.ok) return { rc: -1, status: 'push-fail', detail: pr.out, outBuf: null };
  const cmd = `/data/local/tmp/probe ${ip} ${port} /data/local/tmp/r2-pay.bin /data/local/tmp/r2-out.bin ${mode} ${readTimeout} ${settle}`;
  const r = await adb(['shell', cmd]);
  const line = r.out.trim().split('\n').find((l) => l.startsWith('RC=')) || r.out.trim();
  const st = Object.fromEntries(line.split(/\s+/).map((kv) => kv.split('=')));
  let outBuf = null;
  if (st.RECV !== undefined && Number(st.RECV) > 0 || st.RECV === '0') {
    const pl = await pullFile('/data/local/tmp/r2-out.bin', `${CFG.net}/out-${tag}.bin`);
    outBuf = pl.ok ? fs.readFileSync(`${CFG.net}/out-${tag}.bin`) : null;
  }
  return { rc: r.rc, status: st.RC || 'unknown', sent: Number(st.SENT ?? 0), recv: Number(st.RECV ?? 0), tConn: st.T_CONN_MS, tTotal: st.T_TOTAL_MS, line, raw: r.out, outBuf };
}

// ------------------------------------------------- tunnel (production bytes)
async function provisionTunnel(gostPort, tag = `prov-${gostPort}`) {
  const check = await devExec(buildT2sCheckScript(), `chk-${tag}`);
  const checkOut = check.out;
  const stageBlob = buildT2sStageScript(buildTunnelSetupScript({ gostPort }));
  const st = await devExec(stageBlob, `stage-${tag}`);
  const runBlob = buildT2sRunScript();
  const rn = await devExec(runBlob, `run-${tag}`);
  const ps = await devExec('ps -ef | grep [t]un2socks', `ps-${tag}`);
  return {
    checkOut,
    staged: st.out.includes('T2S_STAGED'),
    stagedRc: st.rc,
    runRc: rn.rc,
    runOut: rn.out,
    ps: ps.out,
    ok: st.out.includes('T2S_STAGED') && rn.rc === 0 && !rn.out.includes('TUN2SOCKS_NOT_RUNNING'),
  };
}
async function teardownTunnel() {
  const stageBlob = buildT2sStageScript(buildTunnelTeardownScript());
  const st = await devExec(stageBlob, 'teardown-stage');
  const rn = await devExec(buildT2sRunScript(), 'teardown-run');
  return { ok: rn.out.includes('TUNNEL_TEARDOWN_DONE'), out: st.out + '\n' + rn.out };
}
async function tunStats() {
  const r = await adb(['shell', 'cat /proc/net/dev 2>/dev/null | grep -E "tun0"' ]);
  const line = r.out.trim();
  if (!line) return null;
  const [ifc, rxBytes, rxCmd, ...rest] = line.replace(/^tun0:\s*/, '').trim().split(/\s+/);
  const f = (ifc + ' ' + rxBytes + ' ' + rxCmd + ' ' + rest.join(' ')).split(/\s+/);
  // /proc/net/dev: iface: rx_bytes rx_packets rx_errs rx_drop ... tx_bytes tx_packets ...
  const parts = line.replace(/^tun0:\s*/, '').trim().split(/\s+/);
  return { rxBytes: Number(parts[0]), rxPkts: Number(parts[1]), txBytes: Number(parts[8]), txPkts: Number(parts[9]) };
}

// ============================================================ phases
async function phaseL1() {
  // L1a: host → echo (endpoint sanity, no device)
  {
    const nonce = `r2-l1a-${Date.now() % 100000}`;
    const body = makePayload(1024, nonce);
    const r = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: CFG.hostEchoPort, path: '/echo', method: 'POST', headers: { 'X-Nonce': nonce, 'Content-Length': body.length } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, head: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', (e) => resolve({ err: String(e) }));
      req.end(body);
    });
    if (r.err || r.status !== 200) {
      result('L1', 'L1a', 'host→echo direct', 'FAIL', r.err || `status=${r.status}`);
      return;
    }
    const exp = buildEchoBody({ nonce, method: 'POST', url: '/echo', bytes: body.length, sha256: sha256hex(body) });
    const ok = r.body.toString() === exp;
    ev('l1a-host-direct', `nonce=${nonce}\nbodyBytes=${body.length}\nsha=${sha256hex(body)}\nresponse=${r.body}\nexpected=${exp}\nmatch=${ok}`);
    result('L1', 'L1a', 'host→echo direct', ok ? 'PASS' : 'FAIL', `1KB POST, sha+body exact match=${ok}`, 'l1a-host-direct');
  }
  // L1b: device → host echo, DIRECT bridge path (no tunnel yet)
  {
    const nonce = `r2-l1b-${Date.now() % 100000}`;
    const body = makePayload(512, nonce);
    const { req } = httpReq({ nonce, body, url: '/echo', host: CFG.direct });
    const p = await devProbe({ ip: CFG.direct, port: CFG.echoPort, payload: req, tag: 'l1b' });
    const v = p.outBuf ? verifyEchoResponse(p.outBuf, { nonce, method: 'GET', url: '/echo', body }) : { ok: false, detail: `probe=${p.status} no-capture` };
    ev('l1b-device-direct', `nonce=${nonce}\nprobe: ${p.line}\ncapture(${p.outBuf?.length ?? 0}B):\n${p.outBuf?.toString('binary') ?? '(none)'}\nverify: ${v.detail}`);
    result('L1', 'L1b', 'device→echo direct (no tunnel)', p.status === 'ok' && v.ok ? 'PASS' : 'FAIL', `probe=${p.status} ${v.detail}`, 'l1b-device-direct');
  }
}

async function phaseTunnelSetup() {
  const r = await provisionTunnel(CFG.gostPort);
  const wait = async (ms) => new Promise((x) => setTimeout(x, ms));
  await wait(1500);
  const ps = await adb(['shell', 'ps -ef | grep [t]un2socks']);
  const st = { ...r, ps: ps.out };
  ev(`tunnel-setup-${CFG.gostPort}`, JSON.stringify(st, null, 2));
  result('L0', 'TUNSET', `provision tunnel → ${CFG.gostPort}`, r.ok ? 'PASS' : 'FAIL',
    `check=[${r.checkOut.split('\n').filter((l) => l.startsWith('BINARY_STATE')).join(' ')}] staged=${r.staged} runRc=${r.runRc} ps=${ps.out.trim().slice(0, 120)}`);
}

async function phaseL2() {
  const blob = [
    'echo "== ip link show tun0 =="; ip link show tun0 2>&1',
    'echo "== ip addr show tun0 =="; ip addr show tun0 2>&1',
    'echo "== ip route show table 100 =="; ip route show table 100 2>&1',
    'echo "== ip rule show =="; ip rule show 2>&1 | head -8',
    'echo "== ip route get 8.8.8.8 =="; ip route get 8.8.8.8 2>&1',
    'echo "== ip route get 172.17.0.1 =="; ip route get 172.17.0.1 2>&1',
    'echo "== /proc/net/dev tun0 =="; grep tun0 /proc/net/dev',
    'echo "== MTU =="; cat /sys/class/net/tun0/mtu 2>&1',
  ].join('\n');
  const r = await devExec(blob, 'l2');
  ev('l2-tun-interface', r.out);
  const o = r.out;
  const checks = {
    'tun0 exists+UP': /tun0.*UP/.test(o),
    'addr 10.8.0.1': /10\.8\.0\.1/.test(o),
    'table100 default via 10.8.0.2 onlink': /default via 10\.8\.0\.2 dev tun0( onlink)?/.test(o),
    'gateway exception 172.17.0.1': /172\.17\.0\.1 dev eth0/.test(o),
    'rule 5000': /5000:\s*from all lookup 100/.test(o),
    'route get via tun0': /via 10\.8\.0\.2 dev tun0/.test(o),
  };
  const ok = Object.values(checks).every(Boolean);
  result('L2', 'L2', 'TUN interface state', ok ? 'PASS' : 'FAIL', JSON.stringify(checks), 'l2-tun-interface');
}

async function phaseL3() {
  const blob = [
    'echo "== ps -ef tun2socks =="; ps -ef | grep [t]un2socks',
    'echo "== --version =="; /data/local/tmp/tun2socks --version 2>&1',
    'echo "== --help (proxy flags) =="; /data/local/tmp/tun2socks --help 2>&1 | head -30',
    'echo "== tun2socks.log head =="; head -25 /data/local/tmp/tun2socks.log 2>&1',
    'echo "== tun2socks.log tail =="; tail -12 /data/local/tmp/tun2socks.log 2>&1',
  ].join('\n');
  const r = await devExec(blob, 'l3');
  ev('l3-tunnel-process', r.out);
  const o = r.out;
  const pidLines = o.split('\n').filter((l) => /tun2socks --device/.test(l));
  const ok = pidLines.length === 1 && /tun2socks-2\.7\.0/.test(o);
  result('L3', 'L3', 'tunnel process (cmd/version/log)', ok ? 'PASS' : 'FAIL',
    `procs=${pidLines.length} version=${(o.match(/tun2socks-[0-9.]+/) || ['?'])[0]} pidLine=${pidLines[0]?.trim().slice(0, 140)}`, 'l3-tunnel-process');
}

// L4/L5 — through the tunnel, canary IP (routes via tun0 by construction)
async function devHttpViaTunnel({ tag, nonce, body, settle = 0, mode = 'full', readTimeout = 30 }) {
  const { req } = httpReq({ nonce, body, url: `/r2-${tag}` });
  const before = await tunStats();
  const p = await devProbe({ ip: CFG.canaryIp, port: CFG.echoPort, payload: req, mode, settle, readTimeout, tag });
  const after = await tunStats();
  const v = p.outBuf ? verifyEchoResponse(p.outBuf, { nonce, method: 'GET', url: `/r2-${tag}`, body }) : { ok: false, detail: `probe=${p.status} no-capture` };
  const logLine = fs.readFileSync(`${CFG.net}/echo.jsonl`, 'utf8').split('\n').filter((l) => l).pop() ?? '';
  let serverOk = null, serverBytes = null, serverSha = null;
  try {
    const e = JSON.parse(logLine);
    if (e.t === 'http-echo' && e.nonce === nonce) {
      serverOk = e.bytes === body.length && e.sha256 === sha256hex(body);
      serverBytes = e.bytes; serverSha = e.sha256;
    }
  } catch { /* not the expected line */ }
  return { tag, p, v, before, after, serverOk, serverBytes, serverSha, logLine };
}

async function phaseL45() {
  // L4: SOCKS5 transport — CONNECT completes + peer responds
  {
    const nonce = `r2-l4-${Date.now() % 100000}`;
    const body = makePayload(1024, nonce);
    const r = await devHttpViaTunnel({ tag: 'l4', nonce, body });
    const sockLines = fs.readFileSync(`${CFG.net}/socks5.jsonl`, 'utf8').split('\n').filter((l) => l && /93\.184\.216\.34:20271/.test(l));
    const connectOk = sockLines.some((l) => l.includes('"tcp-connect"'));
    const relayBytesIn = sockLines.filter((l) => l.includes('"tcp-close"')).map((l) => JSON.parse(l).bytesIn);
    ev('l4-socks5-transport', `nonce=${nonce}\nprobe: ${r.p.line}\nsocks5-lines:\n${sockLines.join('\n')}\necho-log: ${r.logLine}\nverify: ${r.v.detail}`);
    const ok = connectOk && r.p.status === 'ok' && r.v.ok && r.serverOk === true;
    result('L4', 'L4', 'SOCKS5 CONNECT + peer response', ok ? 'PASS' : 'FAIL',
      `connectLogged=${connectOk} relayBytesIn=${JSON.stringify(relayBytesIn)} probe=${r.p.status} ${r.v.detail} serverMatch=${r.serverOk}`, 'l4-socks5-transport');
  }
  // L5a: 1KB settle=0 (fast path, like nc/httpget)
  {
    const nonce = `r2-l5a-${Date.now() % 100000}`;
    const body = makePayload(1024, nonce);
    const r = await devHttpViaTunnel({ tag: 'l5a', nonce, body, settle: 0 });
    ev('l5a-1kb-settle0', `nonce=${nonce}\nprobe: ${r.p.line}\nverify: ${r.v.detail}\necho-log: ${r.logLine}\ntun: ${JSON.stringify(r.before)} → ${JSON.stringify(r.after)}`);
    result('L5', 'L5a', 'bidir payload 1KB settle=0', r.p.status === 'ok' && r.v.ok && r.serverOk === true ? 'PASS' : 'FAIL', `probe=${r.p.status} ${r.v.detail} serverMatch=${r.serverOk}`, 'l5a-1kb-settle0');
  }
  // L5b: 1KB settle=1000 (handshake-stabilize hypothesis)
  {
    const nonce = `r2-l5b-${Date.now() % 100000}`;
    const body = makePayload(1024, nonce);
    const r = await devHttpViaTunnel({ tag: 'l5b', nonce, body, settle: 1000 });
    ev('l5b-1kb-settle1000', `nonce=${nonce}\nprobe: ${r.p.line}\nverify: ${r.v.detail}\necho-log: ${r.logLine}\ntun: ${JSON.stringify(r.before)} → ${JSON.stringify(r.after)}`);
    result('L5', 'L5b', 'bidir payload 1KB settle=1000ms', r.p.status === 'ok' && r.v.ok && r.serverOk === true ? 'PASS' : 'FAIL', `probe=${r.p.status} ${r.v.detail} serverMatch=${r.serverOk}`, 'l5b-1kb-settle1000');
  }
  // L5c: 8KB settle=0
  {
    const nonce = `r2-l5c-${Date.now() % 100000}`;
    const body = makePayload(8192, nonce);
    const r = await devHttpViaTunnel({ tag: 'l5c', nonce, body, settle: 0 });
    ev('l5c-8kb-settle0', `nonce=${nonce}\nprobe: ${r.p.line}\nverify: ${r.v.detail}\necho-log: ${r.logLine}\ntun: ${JSON.stringify(r.before)} → ${JSON.stringify(r.after)}`);
    result('L5', 'L5c', 'bidir payload 8KB settle=0', r.p.status === 'ok' && r.v.ok && r.serverOk === true ? 'PASS' : 'FAIL', `probe=${r.p.status} ${r.v.detail} serverMatch=${r.serverOk}`, 'l5c-8kb-settle0');
  }
}

async function phaseL6() {
  const wait = (ms) => new Promise((x) => setTimeout(x, ms));
  // L6a: 3 sequential
  {
    const nonces = ['r2-l6a-1', 'r2-l6a-2', 'r2-l6a-3'].map((s) => `${s}-${Date.now() % 100000}`);
    const outs = [];
    let allOk = true;
    for (let i = 0; i < 3; i += 1) {
      const body = makePayload(512, nonces[i]);
      const r = await devHttpViaTunnel({ tag: `l6a${i}`, nonce: nonces[i], body });
      const ok = r.p.status === 'ok' && r.v.ok && r.serverOk === true;
      allOk = allOk && ok;
      outs.push(`#${i + 1} ${r.p.line} | ${r.v.detail} | server=${r.serverOk}`);
      await wait(300);
    }
    ev('l6a-sequential3', outs.join('\n'));
    result('L6', 'L6a', '3 sequential connections', allOk ? 'PASS' : 'FAIL', outs.join(' || ').slice(0, 200), 'l6a-sequential3');
  }
  // L6b: 3 parallel
  {
    const nonces = ['r2-l6b-1', 'r2-l6b-2', 'r2-l6b-3'].map((s) => `${s}-${Date.now() % 100000}`);
    const bodies = nonces.map((n) => makePayload(512, n));
    for (let i = 0; i < 3; i += 1) {
      const { req } = httpReq({ nonce: nonces[i], body: bodies[i], url: `/r2-l6b${i}` });
      fs.writeFileSync(`${CFG.net}/pay-l6b${i}.bin`, req);
      await pushTool(`${CFG.net}/pay-l6b${i}.bin`, `/data/local/tmp/r2-pay${i}.bin`);
    }
    const cmd = `sh -c '(/data/local/tmp/probe ${CFG.canaryIp} ${CFG.echoPort} /data/local/tmp/r2-pay0.bin /data/local/tmp/r2-out0.bin full 30 0 > /data/local/tmp/r2-st0.txt 2>&1 & /data/local/tmp/probe ${CFG.canaryIp} ${CFG.echoPort} /data/local/tmp/r2-pay1.bin /data/local/tmp/r2-out1.bin full 30 0 > /data/local/tmp/r2-st1.txt 2>&1 & /data/local/tmp/probe ${CFG.canaryIp} ${CFG.echoPort} /data/local/tmp/r2-pay2.bin /data/local/tmp/r2-out2.bin full 30 0 > /data/local/tmp/r2-st2.txt 2>&1 & wait)'`;
    const rr = await adb(['shell', cmd]);
    const outs = [];
    let allOk = true;
    for (let i = 0; i < 3; i += 1) {
      const st = (await adb(['shell', `cat /data/local/tmp/r2-st${i}.txt`])).out.trim();
      const pl = await pullFile(`/data/local/tmp/r2-out${i}.bin`, `${CFG.net}/out-l6b${i}.bin`);
      const outBuf = pl.ok ? fs.readFileSync(`${CFG.net}/out-l6b${i}.bin`) : null;
      const v = outBuf ? verifyEchoResponse(outBuf, { nonce: nonces[i], method: 'GET', url: `/r2-l6b${i}`, body: bodies[i] }) : { ok: false, detail: 'no-capture' };
      const ok = st.startsWith('RC=ok') && v.ok;
      allOk = allOk && ok;
      outs.push(`#${i + 1} ${st} | ${v.detail}`);
    }
    ev('l6b-parallel3', `shellrc=${rr.rc}\n` + outs.join('\n'));
    result('L6', 'L6b', '3 parallel connections', allOk ? 'PASS' : 'FAIL', outs.join(' || ').slice(0, 200), 'l6b-parallel3');
  }
  // L6c: half-close (8KB, SHUT_WR after send)
  {
    const nonce = `r2-l6c-${Date.now() % 100000}`;
    const body = makePayload(8192, nonce);
    const { req } = httpReq({ nonce, body, url: '/r2-l6c' });
    const p = await devProbe({ ip: CFG.canaryIp, port: CFG.echoPort, payload: req, mode: 'halfclose', tag: 'l6c' });
    const v = p.outBuf ? verifyEchoResponse(p.outBuf, { nonce, method: 'GET', url: '/r2-l6c', body }) : { ok: false, detail: `probe=${p.status}` };
    const logLine = fs.readFileSync(`${CFG.net}/echo.jsonl`, 'utf8').split('\n').filter((l) => l).pop() ?? '';
    ev('l6c-halfclose', `nonce=${nonce}\nprobe: ${p.line}\nverify: ${v.detail}\necho-log: ${logLine}`);
    result('L6', 'L6c', 'half-close (SHUT_WR) 8KB', p.status === 'ok' && v.ok ? 'PASS' : 'FAIL', `probe=${p.status} ${v.detail}`, 'l6c-halfclose');
  }
  // L6d: clean close — same shape as L4 but assert orderly termination on the
  // mock side too (tcp-close logged, no error entries for this flow).
  {
    const nonce = `r2-l6d-${Date.now() % 100000}`;
    const body = makePayload(256, nonce);
    const beforeCount = fs.readFileSync(`${CFG.net}/socks5.jsonl`, 'utf8').split('\n').filter((l) => l).length;
    const r = await devHttpViaTunnel({ tag: 'l6d', nonce, body });
    // mock lines carry dest/from, not the nonce → assert on the lines APPENDED
    // by this single-flow window (canary:echoPort only).
    const sockAll = fs.readFileSync(`${CFG.net}/socks5.jsonl`, 'utf8').split('\n').filter((l) => l);
    const added = sockAll.slice(beforeCount).filter((l) => l.includes(`93.184.216.34:${CFG.echoPort}`));
    const closeLine = added.filter((l) => l.includes('"tcp-close"'));
    const errLine = added.filter((l) => l.includes('"tcp-error"') || l.includes('"relay-error"'));
    ev('l6d-clean-close', `nonce=${nonce}\nprobe: ${r.p.line}\nverify: ${r.v.detail}\nsocks5-close: ${closeLine.join('\n')}\nsocks5-errors: ${errLine.join('\n') || '(none)'}`);
    result('L6', 'L6d', 'clean close (FIN both sides)', r.p.status === 'ok' && r.v.ok && closeLine.length > 0 ? 'PASS' : 'FAIL',
      `probe=${r.p.status} closeLogged=${closeLine.length > 0} errors=${errLine.length}`, 'l6d-clean-close');
  }
  // L6e: timeout — tunnel re-pointed at hang proxy (one variable: endpoint)
  {
    const p1 = await provisionTunnel(CFG.ports.hang, 'l6e-hang');
    if (!p1.ok) {
      result('L6', 'L6e', 'timeout (hang endpoint)', 'BLOCKED', `re-provision→${CFG.ports.hang} failed: ${p1.runOut.slice(-150)}`);
    } else {
      const nonce = `r2-l6e-${Date.now() % 100000}`;
      const body = makePayload(256, nonce);
      const { req } = httpReq({ nonce, body, url: '/r2-l6e' });
      const p = await devProbe({ ip: CFG.canaryIp, port: CFG.echoPort, payload: req, readTimeout: 8, tag: 'l6e' });
      const hangLog = fs.readFileSync(`${CFG.net}/echo-hang.jsonl`, 'utf8').split('\n').filter((l) => l && l.includes(nonce)).pop() ?? '';
      const hangSaw = JSON.parse(hangLog || '{}');
      ev('l6e-timeout', `nonce=${nonce}\nprobe: ${p.line}\necho-hang-log: ${hangLog}\nre-provision: ${p1.runOut.slice(-200)}`);
      const ok = p.status === 'read-timeout' && p.recv === 0 && hangSaw.bytes === body.length && hangSaw.sha256 === sha256hex(body);
      result('L6', 'L6e', 'timeout (server never responds)', ok ? 'PASS' : 'FAIL',
        `probe=${p.status} recv=${p.recv} hangServerSawRequest=${hangSaw.bytes === body.length}${hangSaw.bytes === body.length ? ' (fwd-dir through proxy verified)' : ' (fwd-dir NOT visible to server)'}`, 'l6e-timeout');
    }
  }
  // L6f: RST — tunnel re-pointed at rst proxy
  {
    const p1 = await provisionTunnel(CFG.ports.rst, 'l6f-rst');
    if (!p1.ok) {
      result('L6', 'L6f', 'RST (server reset)', 'BLOCKED', `re-provision→${CFG.ports.rst} failed`);
    } else {
      const nonce = `r2-l6f-${Date.now() % 100000}`;
      const body = makePayload(256, nonce);
      const { req } = httpReq({ nonce, body, url: '/r2-l6f' });
      const p = await devProbe({ ip: CFG.canaryIp, port: CFG.echoPort, payload: req, readTimeout: 8, tag: 'l6f' });
      const rstLog = fs.readFileSync(`${CFG.net}/echo-rst.jsonl`, 'utf8').split('\n').filter((l) => l && l.includes('rst-armed')).pop() ?? '';
      ev('l6f-rst', `nonce=${nonce}\nprobe: ${p.line}\necho-rst-log: ${rstLog}`);
      const sawData = rstLog.includes('MOCK-ECHO') || rstLog.includes('X-Nonce') || /rst-armed/.test(rstLog);
      const ok = (p.status === 'read-error' || p.status === 'conn-fail' || p.status === 'send-fail') && sawData;
      result('L6', 'L6f', 'RST (server reset conn)', ok ? 'PASS' : 'FAIL', `probe=${p.status} detail=${p.line.split(' ').find((x) => x.startsWith('DETAIL=')) || '-'} rstServerSawData=${sawData}`, 'l6f-rst');
    }
  }
  // L6g: proxy reject — tunnel re-pointed at reject proxy
  {
    const p1 = await provisionTunnel(CFG.ports.reject, 'l6g-rej');
    if (!p1.ok) {
      result('L6', 'L6g', 'proxy rejects CONNECT', 'BLOCKED', `re-provision→${CFG.ports.reject} failed`);
    } else {
      const nonce = `r2-l6g-${Date.now() % 100000}`;
      const body = makePayload(256, nonce);
      const { req } = httpReq({ nonce, body, url: '/r2-l6g' });
      const p = await devProbe({ ip: CFG.canaryIp, port: CFG.echoPort, payload: req, readTimeout: 8, tag: 'l6g' });
      const rejLog = fs.readFileSync(`${CFG.net}/socks5-reject.jsonl`, 'utf8').split('\n').filter((l) => l && l.includes('tcp-reject-connect')).pop() ?? '';
      ev('l6g-proxy-reject', `nonce=${nonce}\nprobe: ${p.line}\nreject-log: ${rejLog}`);
      const ok = (p.status === 'conn-fail' || p.status === 'send-fail' || p.status === 'read-error') && rejLog.includes('tcp-reject-connect');
      result('L6', 'L6g', 'proxy rejects CONNECT (rep=5)', ok ? 'PASS' : 'FAIL', `probe=${p.status} rejectLogged=${rejLog.length > 0}`, 'l6g-proxy-reject');
    }
  }
  // L6h: recovery — re-provision main + payload passes again
  {
    const p1 = await provisionTunnel(CFG.gostPort, 'l6h-recover');
    const nonce = `r2-l6h-${Date.now() % 100000}`;
    const body = makePayload(512, nonce);
    const r = p1.ok ? await devHttpViaTunnel({ tag: 'l6h', nonce, body }) : null;
    ev('l6h-recovery', `re-provision: ${p1.runOut.slice(-200)}\nprobe: ${r?.p.line}\nverify: ${r?.v.detail}\nserver=${r?.serverOk}`);
    const ok = p1.ok && r && r.p.status === 'ok' && r.v.ok && r.serverOk === true;
    result('L6', 'L6h', 'recovery after reject (re-provision)', ok ? 'PASS' : 'FAIL', `prov=${p1.ok} probe=${r?.p.status} verify=${r?.v.ok} server=${r?.serverOk}`, 'l6h-recovery');
  }
}

async function phaseL7() {
  for (const size of [1024, 65536, 1048576]) {
    const nonce = `r2-l7-${size}-${Date.now() % 100000}`;
    const body = makePayload(size, nonce);
    const r = await devHttpViaTunnel({ tag: `l7-${size}`, nonce, body, readTimeout: 60 });
    const d = r.after && r.before ? { dRxBytes: r.after.rxBytes - r.before.rxBytes, dTxBytes: r.after.txBytes - r.before.txBytes, dRxPkts: r.after.rxPkts - r.before.rxPkts, dTxPkts: r.after.txPkts - r.before.txPkts } : null;
    ev(`l7-${size}`, `nonce=${nonce}\nprobe: ${r.p.line}\nverify: ${r.v.detail}\necho-log: ${r.logLine}\ntunDelta: ${JSON.stringify(d)}`);
    result('L7', `L7-${size / 1024}KB`, `large payload ${size}B`, r.p.status === 'ok' && r.v.ok && r.serverOk === true ? 'PASS' : 'FAIL', `probe=${r.p.status} recv=${r.recv}B ${r.v.detail} serverMatch=${r.serverOk} tunDelta=${JSON.stringify(d)}`, `l7-${size}`);
  }
}

async function phaseL8() {
  const wait = (ms) => new Promise((x) => setTimeout(x, ms));
  // 8.1 DNS canary through the tunnel (raw UDP, device-side)
  {
    const q = [0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x06, ...Buffer.from('canary'), 0x07, ...Buffer.from('example'), 0x00, 0x00, 0x01, 0x00, 0x01];
    const hexEsc = q.map((b) => `\\x${b.toString(16).padStart(2, '0')}`).join('');
    const blob = [
      `printf '${hexEsc}' | nc -u -w 5 8.8.8.8 53 2>/dev/null | od -An -tx1 | tr -d '\\n'`,
      '',
    ].join('\n');
    const r = await devBlob(blob, 'l8-dns');
    const hex = r.out.trim();
    const socksDns = fs.readFileSync(`${CFG.net}/socks5.jsonl`, 'utf8').split('\n').filter((l) => l && l.includes('"dns"') && l.includes('canary')).length;
    const noError = /8180/.test(hex.replace(/\s/g, ''));
    const answerA = /5db8d822/.test(hex.replace(/\s/g, ''));
    ev('l8-dns-canary', `device-raw-udp-response-hex: ${hex}\nmock-dns-canary-lines: ${socksDns}\nflags-NOERROR(8180)=${noError} answerA(93.184.216.34)=${answerA}`);
    result('L8', 'L8a', 'DNS canary via tunnel (raw UDP)', noError && answerA && socksDns > 0 ? 'PASS' : 'FAIL', `hex=${hex.slice(0, 80)}… NOERROR=${noError} A=${answerA} mockDns=${socksDns}`, 'l8-dns-canary');
  }
  // 8.2 TCP + bidir payload + clean close (one more full pass)
  {
    const nonce = `r2-l8b-${Date.now() % 100000}`;
    const body = makePayload(2048, nonce);
    const r = await devHttpViaTunnel({ tag: 'l8b', nonce, body });
    ev('l8b-tcp-payload', `nonce=${nonce}\nprobe: ${r.p.line}\nverify: ${r.v.detail}\nserver=${r.serverOk}`);
    result('L8', 'L8b', 'TCP connect + bidir payload + close', r.p.status === 'ok' && r.v.ok && r.serverOk === true ? 'PASS' : 'FAIL', `probe=${r.p.status} ${r.v.detail} server=${r.serverOk}`, 'l8b-tcp-payload');
  }
  // 8.3 error recovery: kill t2s → fail-open route evidence → re-provision → payload
  {
    const killBlob = 'pkill -f "[t]un2socks"; sleep 1; ip route get 8.8.8.8 2>&1; ip rule show 2>&1 | head -6';
    const k = await devExec(killBlob, 'l8-kill');
    await wait(1500);
    const p1 = await provisionTunnel(CFG.gostPort, 'l8-recover');
    await wait(1500);
    const nonce = `r2-l8c-${Date.now() % 100000}`;
    const body = makePayload(512, nonce);
    const r = await devHttpViaTunnel({ tag: 'l8c', nonce, body });
    const routeAfterKill = k.out.split('\n')[0];
    ev('l8c-error-recovery', `kill+route-get: ${k.out}\nre-provision: ${p1.ok} ${p1.runOut.slice(-150)}\npost-recover probe: ${r?.p.line}\nverify: ${r?.v.detail} server=${r?.serverOk}`);
    const failOpenSeen = /via 172\.17\.0\.1 dev eth0/.test(routeAfterKill) || /172\.17\.0\.1 dev eth0/.test(routeAfterKill);
    const ok = failOpenSeen && p1.ok && r?.p.status === 'ok' && r.v.ok && r.serverOk === true;
    result('L8', 'L8c', 'kill→fail-open→re-provision→payload', ok ? 'PASS' : 'FAIL',
      `postKillRoute=[${routeAfterKill}] failOpen=${failOpenSeen} reprovision=${p1.ok} payload=${r?.v.ok}`, 'l8c-error-recovery');
  }
}

async function phaseRedirect() {
  // Precondition: tunnel must be DOWN (one variable: NAT, no TUN).
  const t = await teardownTunnel();
  const tunGone = await devExec('ip link show tun0 2>&1 | head -2', 'rd-tun');
  // RD-a: read-only baseline
  const base = await devExec('echo "== iptables -V =="; iptables -V 2>&1; echo "== nat baseline =="; iptables -t nat -L -n -v 2>&1 | head -15', 'rd-a');
  ev('rd-a-baseline', `tunnel-teardown: ${t.ok}\ntun0-after: ${tunGone.out}\n${base.out}`);
  result('RD', 'RDa', 'REDIRECT baseline (read-only)', t.ok && !/state: UP|state: LOWER_UP/.test(tunGone.out) ? 'PASS' : 'FAIL', `teardown=${t.ok} tun0=[${tunGone.out.trim().slice(0, 60)}] iptables=[${(base.out.match(/iptables[^\\n]*/) || ['?'])[0]}]`, 'rd-a-baseline');
  // RD-b: tproxy-mini 20280 → host echo; REDIRECT --dport 20271 → 20280
  const tp = await pushTool(`${path.dirname(new URL(import.meta.url).pathname)}/../tests/tools/tproxy-mini`, '/data/local/tmp/tproxy-mini');
  if (!tp.ok) { result('RD', 'RDb', 'REDIRECT→tproxy→echo', 'BLOCKED', `tproxy push failed: ${tp.out}`); return; }
  await adb(['shell', `nohup /data/local/tmp/tproxy-mini ${CFG.redirect.listen} ${CFG.direct} ${CFG.echoPort} > /data/local/tmp/tproxy.log 2>&1 &`]);
  await new Promise((x) => setTimeout(x, 800));
  const addRule = await devExec(`iptables -t nat -A OUTPUT -p tcp --dport ${CFG.echoPort} -j REDIRECT --to-ports ${CFG.redirect.listen} 2>&1 && echo RULE_ADDED`, 'rd-add');
  if (!addRule.out.includes('RULE_ADDED')) {
    const noIptables = /not found|No such file|not recognized/i.test(addRule.out + addRule.err);
    result('RD', 'RDc', 'REDIRECT rule applied', noIptables ? 'BLOCKED' : 'FAIL', `iptables missing=${noIptables} out=${(addRule.out || addRule.err).slice(0, 160)}`);
    return;
  }
  const nonce = `r2-rd-${Date.now() % 100000}`;
  const body = makePayload(8192, nonce);
  const { req } = httpReq({ nonce, body, url: '/r2-rd', host: CFG.redirect.fakePub });
  const p = await devProbe({ ip: CFG.redirect.fakePub, port: CFG.echoPort, payload: req, tag: 'rd' });
  const v = p.outBuf ? verifyEchoResponse(p.outBuf, { nonce, method: 'GET', url: '/r2-rd', body }) : { ok: false, detail: `probe=${p.status}` };
  const tproxyLog = (await adb(['shell', 'cat /data/local/tmp/tproxy.log 2>&1'])).out;
  const logLine = fs.readFileSync(`${CFG.net}/echo.jsonl`, 'utf8').split('\n').filter((l) => l).pop() ?? '';
  ev('rd-b-chain', `nonce=${nonce}\nprobe: ${p.line}\nverify: ${v.detail}\ntproxy-mini: ${tproxyLog}\necho-log: ${logLine}`);
  result('RD', 'RDc', 'REDIRECT→forwarder→echo bidir payload', p.status === 'ok' && v.ok ? 'PASS' : 'FAIL',
    `probe=${p.status} ${v.detail} tproxy=[${tproxyLog.trim().split('\n').pop()}]`, 'rd-b-chain');
  // RD-d: persistence (60s netd-peaceful window) + second payload
  await new Promise((x) => setTimeout(x, 60000));
  const ruleStill = await devExec(`iptables -t nat -L OUTPUT -n 2>&1 | grep -c "redirect.*${CFG.redirect.listen}"`, 'rd-persist');
  const nonce2 = `${nonce}-2`;
  const body2 = makePayload(4096, nonce2);
  const { req: req2 } = httpReq({ nonce: nonce2, body: body2, url: '/r2-rd2', host: CFG.redirect.fakePub });
  const p2 = await devProbe({ ip: CFG.redirect.fakePub, port: CFG.echoPort, payload: req2, tag: 'rd2' });
  const v2 = p2.outBuf ? verifyEchoResponse(p2.outBuf, { nonce: nonce2, method: 'GET', url: '/r2-rd2', body: body2 }) : { ok: false, detail: `probe=${p2.status}` };
  ev('rd-d-persistence', `after-60s rule-count=${ruleStill.out.trim()}\nprobe2: ${p2.line}\nverify2: ${v2.detail}`);
  result('RD', 'RDd', 'rule persistence 60s + 2nd payload', ruleStill.out.trim() === '1' && p2.status === 'ok' && v2.ok ? 'PASS' : 'FAIL',
    `ruleStill=${ruleStill.out.trim()} probe2=${p2.status} ${v2.detail}`, 'rd-d-persistence');
  // RD-e: cleanup — delete rule, verify gone, kill forwarder, confirm carrier gone
  const del = await devExec(`iptables -t nat -D OUTPUT -p tcp --dport ${CFG.echoPort} -j REDIRECT --to-ports ${CFG.redirect.listen} 2>&1 && echo RULE_DELETED; iptables -t nat -L OUTPUT -n 2>&1 | grep -c "redirect.*${CFG.redirect.listen}"`, 'rd-del');
  const p3 = await devProbe({ ip: CFG.redirect.fakePub, port: CFG.echoPort, payload: req2, readTimeout: 6, tag: 'rd3' });
  await devExec('pkill -f "[t]proxy-mini"; rm -f /data/local/tmp/tproxy.log', 'rd-kill');
  ev('rd-e-cleanup', `del: ${del.out}\npost-del probe (198.51.100.1 unresolvable/dropped = expected fail): ${p3.line}`);
  result('RD', 'RDe', 'cleanup + carrier-gone confirm', del.out.includes('RULE_DELETED') && p3.status !== 'ok' ? 'PASS' : 'FAIL',
    `delOk=${del.out.includes('RULE_DELETED')} countAfter=[${del.out.trim().split('\n').pop()}] postDelProbe=${p3.status}`, 'rd-e-cleanup');
}

async function phaseTeardown() {
  const t = await teardownTunnel();
  const clean = await devBlob('rm -f /data/local/tmp/r2-*.bin /data/local/tmp/r2-*.txt /data/local/tmp/.r2-cmd.sh /data/local/tmp/tproxy-mini /data/local/tmp/probe /data/local/tmp/tun2socks /data/local/tmp/tun2socks.log 2>&1; echo CLEANED', 'teardown-clean');
  const psLeft = await devExec('ps -ef | grep [t]un2socks', 'teardown-ps');
  result('END', 'TEARDOWN', 'tunnel teardown + device clean', t.ok && psLeft.out.trim() === '' ? 'PASS' : 'FAIL', `teardown=${t.ok} psLeft=[${psLeft.out.trim()}] clean=[${clean.out.trim()}]`);
  const pids = ['pid-echo', 'pid-socks5', 'pid-socks5-rej', 'pid-echo-hang', 'pid-socks5-hang', 'pid-echo-rst', 'pid-socks5-rst'];
  for (const f of pids) {
    try { process.kill(Number(fs.readFileSync(path.join(CFG.net, f), 'utf8').trim()), 'SIGTERM'); } catch { /* already gone */ }
  }
  console.log('mocks: SIGTERM sent (see /tmp/r2-net/pid-*)');
}

const PHASES = {
  l1: phaseL1, 'tunnel-setup': phaseTunnelSetup, l2: phaseL2, l3: phaseL3,
  l45: phaseL45, l6: phaseL6, l7: phaseL7, l8: phaseL8, redirect: phaseRedirect, teardown: phaseTeardown,
};
const fn = PHASES[CFG.phase];
if (!fn) { console.error(`unknown phase: ${CFG.phase} (want: ${Object.keys(PHASES).join('|')})`); process.exit(2); }
await fn().catch((e) => { console.error('PHASE CRASH:', e); result(CFG.phase, 'CRASH', 'phase crashed', 'FAIL', String(e.stack || e)); });
finish();
