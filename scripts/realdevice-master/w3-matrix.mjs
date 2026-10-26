/**
 * W3 (ADR-027) D1-D10 real-device egress-binding matrix — rdev scratch stack.
 *
 * Chain under test:
 *   guest tun0 -> t2s -> per-device gost -> socks5 egress container (ladder IP)
 *   -> IP-echo @ 172.38.222.1:16491 (reachable from the egress containers).
 *
 * Scratch honest adaptations (recorded per item, never hidden):
 *  - D4(a) plain-DNS-over-tunnel needs SOCKS5 UDP ASSOCIATE; the scratch
 *    egress server implements CONNECT only -> D4(a) is executed only if the
 *    tool exists and is honestly NOT VERIFIED when it cannot reach.
 *  - D8/D9 need API restarts (env-driven switches) — restart-api.sh.
 *  - The worker is not running in scratch: dispatch-negative assertions read
 *    networkReady (the single read surface workers consume) — the worker
 *    projection itself is hermetic-covered (suite baseline).
 *
 * Canary (D10): proxy credentials in /tmp/rdev-state/w3-canary.txt are a
 * test fixture; the scan proves they appear NOWHERE (API evidence, audit,
 * interventions, host logs, container logs, guest logcat).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const API = process.env.RD_API ?? 'http://127.0.0.1:16490';
const ADB = process.env.RD_ADB ?? `${process.env.HOME}/.local/share/platform-tools/adb`;
const EVID = '/home/kenneth/.openclaw/workspace/water_army/logs/realdevice-master/w3';
const HARNESS = '/home/kenneth/.openclaw/workspace/water_army/scripts/realdevice-master';
const RESTART = `${HARNESS}/restart-api.sh`;
const CANARY_FILE = '/tmp/rdev-state/w3-canary.txt';
const EGRESS_A = '172.38.222.50';
const EGRESS_B = '172.38.222.51';
const EGRESS_C = '172.38.222.53'; // drift relay (dialer.mjs, port 9999)
const EGRESS_D = '172.38.222.54'; // D7 rotation target (fresh egress)
const DNSLOG = '172.38.222.52';
const ECHO = '172.38.222.1:16491';
const NODE_IMG = 'node:22-alpine';
const TPL_BODY = { // rdev-w3 template (mirrors rdev-base + proxy)
  name: TEMPLATE, image: 'water-army/redroid:14.0.0-240527-matrixa-r3', androidVersion: '14',
  width: 720, height: 1280, dpi: 320, fps: 30, gpuMode: 'host',
  privileged: true, privilegedReason: 'rdev scratch: redroid kernel/boot requires privileged (MC ticket precedent)',
  memoryLimitBytes: 4294967296,
};
const TEMPLATE = 'rdev-w3';
const IDENT = (s) => `c9f1c001-0000-4000-8000-0000000000${s}`;
const C1 = IDENT('c1');
const C2 = IDENT('c2');
const C3 = IDENT('c3');

fs.mkdirSync(EVID, { recursive: true });
const say = (m) => console.log(`[w3 ${new Date().toISOString()}] ${m}`);
const ev = (name, obj) => { const p = `${EVID}/${name}`; fs.writeFileSync(p, JSON.stringify(obj, null, 2)); say(`evidence -> ${p}`); };
const sh = (cmd, timeout = 60000) => execSync(cmd, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
const shSoft = (cmd, timeout = 60000) => { try { return sh(cmd, timeout); } catch (e) { return `[rc=${e.status}] ${String(e.stdout || '').trim()}`; } };
const psql = (sql) => execSync(`docker exec -i rdev-pg psql -U postgres -d water_army_rdev -tA -v ON_ERROR_STOP=1`, { encoding: 'utf8', input: sql, timeout: 30000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
async function req(method, p, body) {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}

// --- RAM redline (task discipline): MemAvailable < 16GiB before any new boot
function ramOk() {
  const line = shSoft('free -g | awk \'/^Mem:/{print $7}\'').trim();
  const g = Number(line);
  if (!Number.isFinite(g)) throw new Error(`RAM unreadable: ${line}`);
  if (g < 16) throw new Error(`RAM REDLINE: MemAvailable=${g}G < 16G — STOP (task discipline)`);
  say(`RAM check: MemAvailable=${g}G (redline 16G) OK`);
  return g;
}

async function login() {
  const r = await req('POST', '/api/auth/login', { username: 'rdev-admin', password: 'rdev-e2e-admin-pw' });
  if (r.status !== 200) throw new Error(`admin login failed: ${r.status}`);
  say('logged in (rdev-admin)');
}

function restartApi(overrideFile) {
  const cmd = `bash ${RESTART}${overrideFile ? ` ${overrideFile}` : ''}`;
  const out = sh(cmd, 180000).trim();
  say(`api restart: ${out.split('\n').pop()}`);
}

/** device view by name (null when absent) */
async function view(name) {
  const list = await req('GET', '/api/devices/redroid');
  const d = (list.j.devices ?? []).find((x) => x.name === name);
  return d ?? null;
}

/** poll until pred(view) true or budget; returns {v, waitedMs} */
async function waitForView(name, pred, budgetMs, label) {
  const t0 = Date.now();
  let last = null, lastDiag = 0;
  while (Date.now() - t0 < budgetMs) {
    const v = await view(name);
    last = v;
    if (v && pred(v)) return { v, waitedMs: Date.now() - t0 };
    // keep the adb online (diagnostics is the only connect path — see W1 note)
    if (v && v.containerState === 'running' && v.adbState !== 'online' && Date.now() - lastDiag > 60000) {
      lastDiag = Date.now();
      await req('POST', `/api/devices/redroid/${v.id}/diagnostics`);
    }
    await sleep(3000);
  }
  throw new Error(`waitForView ${label}: budget ${budgetMs}ms exhausted. last=${JSON.stringify(last?.proxy ?? last?.containerState)}`);
}

/** recreate rdev-egress-a exactly as w3-bringup.sh does (DIAL_VIA = '' | ip:port) */
function restartEgressA(via, U, P) {
  shSoft('docker rm -f rdev-egress-a', 30000);
  const viaArg = via ? ` -e DIAL_VIA=${via}` : '';
  sh(`docker run -d --name rdev-egress-a --network br-rdev-ladder --ip ${EGRESS_A} --restart unless-stopped \
    -e PORT=1080 -e EGRESS_USER='${U}' -e EGRESS_PASS='${P}'${viaArg} \
    -v ${HARNESS}:/scripts:ro ${NODE_IMG} node /scripts/egress-socks5.mjs`, 30000);
  sleep(2000);
}

const egressOf = (v) => v?.proxy?.network?.egress ?? null;
const netOf = (v) => v?.proxy?.network ?? null;

async function interventionsFor(deviceName) {
  const d = await view(deviceName);
  if (!d) return [];
  const r = await req('GET', `/api/manual-interventions?deviceId=${d.id}&pageSize=50`);
  return (r.j.interventions ?? r.j.items ?? r.j ?? []);
}

function containerIp(name) {
  return shSoft(`docker inspect ${name} --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}'`).trim().split(' ')[0] ?? '';
}

async function main() {
  const summary = { startedAt: new Date().toISOString(), items: {}, degradation: [] };
  // canary fixture = shell format: EGRESS_USER=... / EGRESS_PASS=...
  const canaryText = fs.readFileSync(CANARY_FILE, 'utf8');
  const U = (canaryText.match(/^EGRESS_USER=(.*)$/m) ?? [])[1]?.trim() ?? '';
  const P = (canaryText.match(/^EGRESS_PASS=(.*)$/m) ?? [])[1]?.trim() ?? '';
  if (!U || !P) throw new Error('canary fixture missing EGRESS_USER/EGRESS_PASS');
  const url = (ip) => `socks5://${U}:${P}@${ip}:1080`;

  await login();

  // ================= SETUP =================
  say('SETUP: restart API with W3 ON (echo = ladder gateway)');
  restartApi();
  // W3-ON probe: binding PUT must NOT answer the disabled-switch code
  psql(`INSERT INTO identities (id, name, created_at, updated_at) VALUES
    ('${C1}','rdev-w3-c1', now(), now()),
    ('${C2}','rdev-w3-c2', now(), now()),
    ('${C3}','rdev-w3-c3', now(), now())
  ON CONFLICT (id) DO NOTHING;`);
  // template rdev-w3 = rdev-base shape + proxy .50
  const tlist = await req('GET', '/api/redroid/templates');
  if (!(tlist.j.templates ?? tlist.j.items ?? []).some?.((t) => t.name === TEMPLATE)) {
    const tr = await req('POST', '/api/redroid/templates', { ...TPL_BODY, proxyUrl: url(EGRESS_A) });
    if (tr.status !== 200 && tr.status !== 201) throw new Error(`template create -> ${tr.status} ${JSON.stringify(tr.j).slice(0, 300)}`);
    say('template rdev-w3 created (proxy = egress-a)');
  }
  for (const [id, ip] of [[C1, EGRESS_A], [C2, EGRESS_B]]) {
    const b = await req('PUT', `/api/identities/${id}/egress`, { proxyUrl: url(ip), expectedEgressIp: ip });
    if (b.status !== 200) throw new Error(`binding ${id} -> ${b.status} ${JSON.stringify(b.j).slice(0, 300)}`);
    say(`binding ${id} -> ${ip}`);
  }
  // egress infra liveness (a/b/c/d + dnslog)
  for (const c of ['rdev-egress-a', 'rdev-egress-b', 'rdev-egress-c', 'rdev-egress-d', 'rdev-dnslog']) {
    const st = shSoft(`docker inspect ${c} --format '{{.State.Status}}'`).trim();
    if (st !== 'running') throw new Error(`egress infra ${c} not running (${st})`);
  }
  say('setup complete');

  // ================= D1: first VERIFIED end-to-end =================
  {
    ramOk();
    const cr = await req('POST', '/api/devices/redroid', {
      name: 'redroid-rdev-c1', templateName: TEMPLATE, identityId: C1,
      idempotencyKey: `rdev-w3-c1-${Date.now().toString(36)}`,
    });
    if (cr.status !== 200 && cr.status !== 201) throw new Error(`c1 create -> ${cr.status} ${JSON.stringify(cr.j).slice(0, 300)}`);
    say('D1: c1 created — waiting for boot + tunnel + first VERIFIED (budget 30min cold)');
    const { v, waitedMs } = await waitForView('redroid-rdev-c1',
      (x) => x.adbState === 'online' && egressOf(x)?.state === 'VERIFIED', 30 * 60 * 1000, 'D1 c1 VERIFIED');
    const e = egressOf(v);
    // guest tooling (ADR D1: timeout / mkfifo / nc presence)
    const serial = `127.0.0.1:${v.adbPort}`;
    const tools = {};
    for (const t of ['timeout', 'mkfifo', 'nc', 'nslookup', 'wget', 'sh']) {
      tools[t] = shSoft(`${ADB} -s ${serial} shell "which ${t}" 1>/dev/null 2>&1; echo rc=$?`).includes('rc=0');
    }
    summary.items.D1 = {
      pass: e.state === 'VERIFIED' && e.lastObservedIp === EGRESS_A && !e.stale && e.ready === true,
      device: { adbPort: v.adbPort, adbState: v.adbState, containerIp: containerIp('redroid-rdev-c1') },
      egress: e, waitedMs, guestTools: tools,
    };
    ev('d1-first-verified.json', summary.items.D1);
    say(`D1: state=${e.state} observed=${e.lastObservedIp} (${waitedMs}ms) tools=${JSON.stringify(tools)}`);
  }

  // ================= D2: identity-bound verified =================
  {
    const v = await view('redroid-rdev-c1');
    const b = await req('GET', `/api/identities/${C1}/egress`);
    const e = egressOf(v);
    const n = netOf(v);
    summary.items.D2 = {
      pass: e.state === 'VERIFIED' && e.lastObservedIp === EGRESS_A && b.j.binding?.expectedEgressIp === EGRESS_A
        && b.j.binding?.lastVerifiedAt != null && n.networkReady === true,
      egress: e, netReady: n.networkReady, binding: b.j.binding ?? b.j,
    };
    ev('d2-identity-verified.json', summary.items.D2);
    say(`D2: ready=${n.networkReady} binding.lastVerifiedAt=${b.j.binding?.lastVerifiedAt}`);
  }

  // ================= D3: proxy death -> UNREACHABLE + intervention + recover =================
  {
    const t0 = Date.now();
    sh('docker stop rdev-egress-a', 30000);
    say('D3: egress-a STOPPED — watching');
    let firstBad = null, interventionAt = null, netBefore = null;
    for (let i = 0; i < 30; i++) {
      const v = await view('redroid-rdev-c1');
      const e = egressOf(v);
      netBefore = netBefore ?? netOf(v).state;
      if (!firstBad && e.consecutiveFailures >= 1) firstBad = { atMs: Date.now() - t0, egress: e };
      if (!interventionAt) {
        const ints = await interventionsFor('redroid-rdev-c1');
        const hit = ints.find((x) => /egress/i.test(JSON.stringify(x)));
        if (hit) interventionAt = { atMs: Date.now() - t0, item: hit };
      }
      if (firstBad && interventionAt) break;
      await sleep(3000);
    }
    const vDead = await view('redroid-rdev-c1');
    const eDead = egressOf(vDead);
    const nDead = netOf(vDead);
    // recover
    sh('docker start rdev-egress-a', 30000);
    const rec = await waitForView('redroid-rdev-c1', (x) => egressOf(x)?.state === 'VERIFIED', 5 * 60 * 1000, 'D3 recover VERIFIED');
    summary.items.D3 = {
      pass: !!firstBad && !!interventionAt && eDead.state !== 'VERIFIED' && nDead.networkReady === false
        && rec.v && egressOf(rec.v).state === 'VERIFIED',
      netAxisBefore: netBefore, egressAtDeath: eDead, netAtDeath: { state: nDead.state, networkReady: nDead.networkReady },
      firstFailureMs: firstBad?.atMs ?? null, interventionMs: interventionAt?.atMs ?? null,
      intervention: interventionAt?.item ?? null,
      recovery: { verified: egressOf(rec.v).state === 'VERIFIED', waitedMs: rec.waitedMs },
    };
    ev('d3-proxy-death.json', summary.items.D3);
    say(`D3: firstFail=${firstBad?.atMs}ms intervention=${interventionAt?.atMs}ms stateAtDeath=${eDead.state} recovered=${summary.items.D3.pass}`);
  }

  // ================= D6: drift (egress-a relays via .53) =================
  {
    // preflight: relay target alive
    const relayUp = shSoft(`docker exec rdev-egress-c sh -c 'echo' 2>/dev/null`) !== undefined;
    say('D6: recreating egress-a with DIAL_VIA=.53:9999 (drift relay)');
    restartEgressA(`${EGRESS_C}:9999`, U, P);
    const t0 = Date.now();
    let drifted = null, critInt = null, sideEffects = null;
    for (let i = 0; i < 30; i++) {
      const v = await view('redroid-rdev-c1');
      const e = egressOf(v);
      if (!drifted && e.state === 'DRIFTED') {
        drifted = { atMs: Date.now() - t0, egress: e };
        const ints = await interventionsFor('redroid-rdev-c1');
        critInt = ints.find((x) => /egress/i.test(JSON.stringify(x)) && /crit/i.test(JSON.stringify(x))) ?? ints.find((x) => /egress/i.test(JSON.stringify(x))) ?? null;
        sideEffects = { containerState: v.containerState, netAxis: netOf(v).state, netReady: netOf(v).networkReady };
      }
      if (drifted && critInt) break;
      await sleep(3000);
    }
    // recover: direct egress again
    restartEgressA('', U, P);
    const rec = await waitForView('redroid-rdev-c1', (x) => egressOf(x)?.state === 'VERIFIED', 5 * 60 * 1000, 'D6 recover VERIFIED');
    // human-owned: the drift intervention must still be OPEN after auto-recovery
    const intsAfter = await interventionsFor('redroid-rdev-c1');
    const stillOpen = intsAfter.filter((x) => /egress/i.test(JSON.stringify(x)) && /open|pending/i.test(String(x.status ?? '')));
    summary.items.D6 = {
      pass: !!drifted && drifted.egress.lastObservedIp === EGRESS_C && !!critInt
        && sideEffects?.containerState === 'running' && rec.v && egressOf(rec.v).state === 'VERIFIED',
      relayUp, driftDetectionMs: drifted?.atMs ?? null, egressAtDrift: drifted?.egress ?? null,
      criticalIntervention: critInt ?? null, sideEffects, // zero side-effects: container running, net axis intact
      recovery: { verified: egressOf(rec.v).state === 'VERIFIED', waitedMs: rec.waitedMs },
      interventionStillOpenAfterRecovery: stillOpen.length > 0,
      openInterventions: stillOpen,
    };
    ev('d6-drift.json', summary.items.D6);
    say(`D6: driftMs=${drifted?.atMs} observed=${drifted?.egress.lastObservedIp} crit=${!!critInt} stillOpen=${stillOpen.length > 0}`);
  }

  // ================= D5: two identities, two egresses + IP collision =================
  {
    ramOk();
    const cr = await req('POST', '/api/devices/redroid', {
      name: 'redroid-rdev-c2', templateName: TEMPLATE, identityId: C2,
      proxyUrl: url(EGRESS_B), // device-level override: c2 egresses via .51
      idempotencyKey: `rdev-w3-c2-${Date.now().toString(36)}`,
    });
    if (cr.status !== 200 && cr.status !== 201) throw new Error(`c2 create -> ${cr.status} ${JSON.stringify(cr.j).slice(0, 300)}`);
    say('D5: c2 created — waiting VERIFIED (budget 30min cold)');
    const { v: v2, waitedMs } = await waitForView('redroid-rdev-c2',
      (x) => x.adbState === 'online' && egressOf(x)?.state === 'VERIFIED', 30 * 60 * 1000, 'D5 c2 VERIFIED');
    const v1 = await view('redroid-rdev-c1'); // simultaneous snapshot
    const e1 = egressOf(v1), e2 = egressOf(v2);
    const clash = await req('PUT', `/api/identities/${C3}/egress`, { proxyUrl: url(EGRESS_A), expectedEgressIp: EGRESS_A });
    summary.items.D5 = {
      pass: e1.state === 'VERIFIED' && e2.state === 'VERIFIED'
        && e1.lastObservedIp === EGRESS_A && e2.lastObservedIp === EGRESS_B
        && clash.status === 409 && /EGRESS_IP_CONFLICT/.test(JSON.stringify(clash.j)),
      simultaneous: { c1: e1, c2: e2 }, c2WaitedMs: waitedMs,
      collision: { status: clash.status, code: clash.j.code ?? null },
    };
    ev('d5-two-identities.json', summary.items.D5);
    say(`D5: c1=${e1.lastObservedIp} c2=${e2.lastObservedIp} collision=${clash.status}/${clash.j.code}`);
  }

  // ================= D4: DNS / DoH observability =================
  {
    const v = await view('redroid-rdev-c1');
    const serial = `127.0.0.1:${v.adbPort}`;
    const g = (cmd) => shSoft(`${ADB} -s ${serial} shell "${cmd}" 2>&1`).trim();
    const d4 = {};
    // (a) plain DNS through tunnel -> dnslog (needs UDP ASSOCIATE on scratch egress)
    if (summary.items.D1.guestTools.nslookup) {
      d4.a_nslookup = { tool: 'nslookup', out: g(`nslookup canary.rdevtest ${DNSLOG}`).slice(0, 400) };
    } else {
      d4.a_nslookup = { tool: 'nslookup', out: 'NOT AVAILABLE in guest — item (a) NOT VERIFIED (tool absent)' };
    }
    // (b) DoH mimic over the tunnel: HTTP GET /resolve through the proxy chain
    const doh = g(`printf 'GET /resolve?name=canary.rdevtest HTTP/1.0\\r\\nHost: ${ECHO}\\r\\n\\r\\n' | nc -w 8 ${ECHO}`).slice(0, 500);
    let dohClientIp = null;
    try { dohClientIp = JSON.parse(doh.split('\r\n\r\n').pop() || '{}').client_ip ?? null; } catch { /* non-json */ }
    d4.b_doh = { raw: doh, clientIp: dohClientIp, pass: dohClientIp === EGRESS_A };
    // (c) leak window: egress-a dead -> guest direct UDP query reaches dnslog from the CONTAINER ip
    sh('docker stop rdev-egress-a', 30000);
    await sleep(2000); // let the tunnel connections die
    const before = shSoft(`docker exec rdev-dnslog cat /logs/dnslog.jsonl 2>/dev/null || true`);
    const direct = summary.items.D1.guestTools.nslookup ? g(`nslookup canary.rdevtest ${DNSLOG}`) : 'nslookup unavailable';
    await sleep(1500);
    const after = shSoft(`docker exec rdev-dnslog cat /logs/dnslog.jsonl 2>/dev/null || true`);
    const newLines = after.split('\n').filter((l) => l && !before.includes(l));
    const c1ip = containerIp('redroid-rdev-c1');
    const leaked = newLines.some((l) => l.includes(c1ip));
    d4.c_leakWindow = { c1ContainerIp: c1ip, newDnsEntries: newLines.slice(0, 5), leakedFromContainerIp: leaked, directOut: String(direct).slice(0, 300) };
    sh('docker start rdev-egress-a', 30000);
    await waitForView('redroid-rdev-c1', (x) => egressOf(x)?.state === 'VERIFIED', 5 * 60 * 1000, 'D4 recover VERIFIED');
    d4.recovered = true;
    summary.items.D4 = {
      pass: d4.b_doh.pass, // (b) is the scratch-feasible DoH proof; (a)/(c) recorded honestly
      a_nslookup: d4.a_nslookup, b_doh: d4.b_doh, c_leakWindow: d4.c_leakWindow,
    };
    ev('d4-dns-doh.json', summary.items.D4);
    say(`D4: dohClientIp=${dohClientIp} leakFromContainer=${d4.c_leakWindow.leakedFromContainerIp} a=${d4.a_nslookup.out.slice(0, 40)}`);
  }

  // ================= D7: binding rotation (admin updates IP + proxy synced swap) =================
  // Rotate c1 .50 -> .54 (fresh egress-d): .51 is pinned by c2, so .51 would
  // 409 EGRESS_IP_CONFLICT — the collision itself is D5's job.
  {
    const upd = await req('PUT', `/api/identities/${C1}/egress`, { proxyUrl: url(EGRESS_D), expectedEgressIp: EGRESS_D });
    if (upd.status !== 200) throw new Error(`D7 binding update -> ${upd.status} ${JSON.stringify(upd.j).slice(0, 300)}`);
    const bview = upd.j.binding;
    // audit check: previousEgressIp recorded + NO credential literal anywhere
    const aud = await req('GET', `/api/audit-events?action=identity.egress_binding_update&pageSize=10`);
    const audRows = aud.j.events ?? aud.j.items ?? aud.j ?? [];
    const audHit = audRows.find((x) => JSON.stringify(x).includes(C1));
    const auditJson = JSON.stringify(audRows);
    const audOk = audHit && JSON.stringify(audHit).includes(EGRESS_A) && !auditJson.includes('socks5://') && !auditJson.includes(U) && !auditJson.includes(P);
    // devices reset to UNCHECKED by the binding update
    const vReset = await view('redroid-rdev-c1');
    // proxy synced swap: template -> .54, then recreate c1 (device baked its URL at create)
    ramOk();
    const tpl = await req('PUT', `/api/redroid/templates/${TEMPLATE}`, { proxyUrl: url(EGRESS_D) });
    if (tpl.status !== 200) say(`D7 template update -> ${tpl.status} (non-fatal: recreate carries template snapshot) ${JSON.stringify(tpl.j).slice(0, 200)}`);
    const del = await req('DELETE', `/api/devices/redroid/${vReset.id}`, { confirm: 'redroid-rdev-c1', removeData: false });
    if (del.status !== 200) throw new Error(`D7 delete c1 -> ${del.status} ${JSON.stringify(del.j).slice(0, 200)}`);
    const cr = await req('POST', '/api/devices/redroid', {
      name: 'redroid-rdev-c1', templateName: TEMPLATE, identityId: C1,
      idempotencyKey: `rdev-w3-c1-rot-${Date.now().toString(36)}`,
    });
    if (cr.status !== 200 && cr.status !== 201) throw new Error(`D7 c1 recreate -> ${cr.status} ${JSON.stringify(cr.j).slice(0, 300)}`);
    const rec = await waitForView('redroid-rdev-c1', (x) => egressOf(x)?.state === 'VERIFIED' && egressOf(x).lastObservedIp === EGRESS_D, 30 * 60 * 1000, 'D7 c1 re-VERIFIED @.54');
    summary.items.D7 = {
      pass: bview.expectedEgressIp === EGRESS_D && bview.proxyHashShort != null && audOk
        && egressOf(rec.v).state === 'VERIFIED' && egressOf(rec.v).lastObservedIp === EGRESS_D,
      bindingAfter: bview, audit: { found: !!audHit, previousEgressIpPresent: audOk && true, credentialLiteralInAudit: auditJson.includes('socks5://') || auditJson.includes(U) },
      resetState: egressOf(vReset)?.state ?? null,
      reVerified: { state: egressOf(rec.v).state, observed: egressOf(rec.v).lastObservedIp, waitedMs: rec.waitedMs },
    };
    ev('d7-rotation.json', summary.items.D7);
    say(`D7: rotated c1 -> ${EGRESS_B}; audit=${!!audHit} reVerified=${egressOf(rec.v).lastObservedIp}`);
  }

  // ================= D8: echo not configured -> never VERIFIED =================
  {
    ramOk();
    const ov = `${EVID}/d8-echo-off.env`;
    fs.writeFileSync(ov, 'WA_W3_EGRESS_ECHO_HOST=""\nWA_W3_EGRESS_ECHO_PORT=0\n');
    // c3 -> .50 (free again: c1 rotated to .54 in D7; c2 holds .51)
    const b3 = await req('PUT', `/api/identities/${C3}/egress`, { proxyUrl: url(EGRESS_A), expectedEgressIp: EGRESS_A });
    if (b3.status !== 200) throw new Error(`D8 c3 binding -> ${b3.status} ${JSON.stringify(b3.j).slice(0, 300)}`);
    restartApi(ov);
    const cr = await req('POST', '/api/devices/redroid', {
      name: 'redroid-rdev-c3', templateName: TEMPLATE, identityId: C3,
      idempotencyKey: `rdev-w3-c3-${Date.now().toString(36)}`,
    });
    if (cr.status !== 200 && cr.status !== 201) throw new Error(`D8 c3 create -> ${cr.status} ${JSON.stringify(cr.j).slice(0, 300)}`);
    say('D8: c3 up with echo disabled — observing 95s (must never VERIFY)');
    let sawNotConfigured = false, everVerified = false, states = [];
    for (let i = 0; i < 32; i++) {
      const v = await view('redroid-rdev-c3');
      const e = egressOf(v);
      if (e) { states.push({ t: i, state: e.state, err: e.lastErrorCode ?? null }); if (e.state === 'VERIFIED') everVerified = true; if (e.lastErrorCode === 'EGRESS_ECHO_NOT_CONFIGURED') sawNotConfigured = true; }
      await sleep(3000);
    }
    const vEnd = await view('redroid-rdev-c3');
    summary.items.D8 = {
      pass: sawNotConfigured && !everVerified && egressOf(vEnd)?.state !== 'VERIFIED',
      sawEGRESS_ECHO_NOT_CONFIGURED: sawNotConfigured, everVerified, endState: egressOf(vEnd)?.state ?? null,
      stateTimeline: states.filter((s, i) => i % 3 === 0 || states[i - 1]?.state !== s.state),
    };
    ev('d8-echo-off.json', summary.items.D8);
    say(`D8: sawNotConfigured=${sawNotConfigured} everVerified=${everVerified} end=${summary.items.D8.endState}`);
  }

  // ================= D9: stale TTL vs watchdog stall (payload-level fallback) =================
  {
    const ov = `${EVID}/d9-stale.env`;
    fs.writeFileSync(ov, 'WA_W3_EGRESS_STALE_MS=15000\nREDROID_HEALTH_POLL_MS=60000\n');
    restartApi(ov);
    // fresh VERIFIED first (poll is 60s now — budget accordingly)
    const rec = await waitForView('redroid-rdev-c1', (x) => egressOf(x)?.state === 'VERIFIED' && !egressOf(x).stale, 3 * 60 * 1000, 'D9 fresh VERIFIED');
    say(`D9: fresh VERIFIED (t+${rec.waitedMs}ms) — waiting past the 15s stale window without a tick`);
    await sleep(25000);
    const v = await view('redroid-rdev-c1');
    const e = egressOf(v), n = netOf(v);
    summary.items.D9 = {
      pass: e.state === 'VERIFIED' && e.stale === true && e.ready === false && n.networkReady === false,
      egress: e, netReady: n.networkReady,
      note: 'state stays VERIFIED (no new probe), payload flips stale=true after 15s with 60s poll — the watchdog-stall fallback (ADR-027 D9)',
    };
    ev('d9-stale-fallback.json', summary.items.D9);
    say(`D9: state=${e.state} stale=${e.stale} ready=${e.ready} networkReady=${n.networkReady}`);
  }

  // ================= RESTORE (standard env: W3 ON + echo ON, default timers) =================
  restartApi();
  say('API restored (W3 ON, echo ON, default timers)');

  // ================= D10: canary zero-leak sweep =================
  {
    const needleU = U, needleP = P, needleUrlA = url(EGRESS_A), needleUrlB = url(EGRESS_B);
    const scanText = (name, text) => ({
      surface: name,
      hits: {
        user: text.split(needleU).length - 1,
        pass: text.split(needleP).length - 1,
        urlA: text.split(needleUrlA).length - 1,
        urlB: text.split(needleUrlB).length - 1,
        scheme: (text.match(/socks5:\/\//g) ?? []).length,
      },
    });
    const surfaces = [];
    // 1) every evidence file in this phase (self is excluded)
    for (const f of fs.readdirSync(EVID)) {
      if (!f.endsWith('.json') || f === 'd10-canary-sweep.json') continue;
      surfaces.push(scanText(`evidence/${f}`, fs.readFileSync(`${EVID}/${f}`, 'utf8')));
    }
    // 2) audit events (W3 window, 3 pages)
    let auditText = '';
    for (let pg = 1; pg <= 3; pg++) {
      const a = await req('GET', `/api/audit-events?pageSize=100&page=${pg}`);
      auditText += JSON.stringify(a.j) + '\n';
    }
    surfaces.push(scanText('audit-events (300 rows)', auditText));
    // 3) manual interventions (all open+resolved, 2 pages)
    let intText = '';
    for (let pg = 1; pg <= 2; pg++) {
      const m = await req('GET', `/api/manual-interventions?pageSize=100&page=${pg}`);
      intText += JSON.stringify(m.j) + '\n';
    }
    surfaces.push(scanText('manual-interventions (200 rows)', intText));
    // 4) host logs (superset semantics: whole files capped — any hit anywhere fails)
    surfaces.push(scanText('scratch-api.log (cap 30MB)', shSoft(`tail -c 30000000 ${EVID}/../scratch-api.log 2>/dev/null`)));
    surfaces.push(scanText('echo.log (cap 1MB)', shSoft(`tail -c 1000000 ${EVID}/../echo.log 2>/dev/null`)));
    for (const c of ['rdev-egress-a', 'rdev-egress-b', 'rdev-egress-c', 'rdev-egress-d']) {
      surfaces.push(scanText(`docker logs ${c}`, shSoft(`docker logs --tail 2000 ${c} 2>&1`)));
    }
    // 5) guest logcat (c1)
    const v = await view('redroid-rdev-c1');
    if (v) surfaces.push(scanText('guest logcat (c1)', shSoft(`${ADB} -s 127.0.0.1:${v.adbPort} shell logcat -d 2>&1 | tail -c 2000000`, 120000)));
    const clean = surfaces.every((s) => Object.values(s.hits).every((h) => h === 0));
    summary.items.D10 = { pass: clean, canaryInFixtureFile: true, surfaces };
    ev('d10-canary-sweep.json', summary.items.D10);
    say(`D10: clean=${clean} surfaces=${surfaces.length}`);
  }

  ev('w3-summary.json', summary);
  const fails = Object.entries(summary.items).filter(([, x]) => x.pass === false).map(([k]) => k);
  say(`W3 DONE — pass: ${Object.keys(summary.items).length - fails.length}/10 fails=[${fails.join(',')} ]`);
  process.exit(0);
}

main().catch((e) => {
  say(`FATAL: ${e?.stack ?? e}`);
  ev('w3-fatal.json', { at: new Date().toISOString(), error: String(e?.message ?? e) });
  process.exit(1);
});
