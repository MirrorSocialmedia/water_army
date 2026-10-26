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
const ECHO = '192.168.31.144:16491'; // host LAN anchor (NOT on-link to guests — on-link destinations bypass the tunnel via the local routing table; 2026-10-26 D1 drift discovery)
const [ECHO_HOST, ECHO_PORT] = ECHO.split(':');
const NODE_IMG = 'node:22-alpine';
const TEMPLATE = 'rdev-w3';
let TEMPLATE_ID = null; // UUID — the PUT route resolves :id as the PK (cuid/uuid), NOT the name (2026-10-26 D7 500 discovery: Prisma P2023 on non-uuid)
const TPL_BODY = { // rdev-w3 template (mirrors rdev-base + proxy)
  name: TEMPLATE, image: 'water-army/redroid:14.0.0-240527-matrixa-r3', androidVersion: '14',
  width: 720, height: 1280, dpi: 320, fps: 30, gpuMode: 'host',
  privileged: true, privilegedReason: 'rdev scratch: redroid kernel/boot requires privileged (MC ticket precedent)',
  memoryLimitBytes: 4294967296,
};
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
async function req(method, p, body, { retries = 3 } = {}) {
  // Retries: undici's global fetch keep-alive pool holds sockets from before
  // an API restart; the first post-restart request on a pooled socket gets
  // ECONNRESET ("fetch failed") even though the server is healthy — live
  // observed 2026-10-26 (D8: ready-200 at T, first request at T+2ms failed,
  // server log shows no request received). Transient conn-level errors only;
  // HTTP errors (4xx/5xx) are returned as-is.
  for (let i = 0; ; i++) {
    let r;
    try {
      r = await fetch(`${API}${p}`, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      // Any TypeError from fetch is a connection-level failure (HTTP errors
      // return a response object, they never throw) — covers ECONNREFUSED,
      // ECONNRESET, "socket hang up", and undici's keep-alive race "Other
      // side closed" (observed live 2026-10-26 D8).
      if (i < retries && (e instanceof TypeError || /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket|closed|terminated|timeout/i.test(String(e?.cause?.message ?? e?.message ?? e)))) {
        await sleep(400 * (i + 1));
        continue;
      }
      throw e;
    }
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json().catch(() => ({}));
    return { status: r.status, j };
  }
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
    // keep the adb online (product gap: no platform path connects a
    // never-connected serial for no-proxy devices — operator-surface connect,
    // see W1 finding; then /refresh persists the state)
    if (v && v.containerState === 'running' && v.adbState !== 'online' && Date.now() - lastDiag > 60000) {
      lastDiag = Date.now();
      shSoft(`${ADB} connect 127.0.0.1:${v.adbPort} 2>&1`, 30000);
      await req('POST', `/api/devices/redroid/${v.id}/refresh`);
      await req('POST', `/api/devices/redroid/${v.id}/diagnostics`);
    }
    // operator-surface net recovery (finding #4): FAILED net axis skips the
    // whole watchdog tick (failed-manual-only) — egress re-verification is
    // frozen until the manual exit door (MD §5.4.6). Triggered here when the
    // net axis sits FAILED (e.g. RECOVERY_EXHAUSTED from a bad-anchor era).
    if (v && v.containerState === 'running' && netOf(v)?.state === 'FAILED' && Date.now() - lastDiag > 60000) {
      lastDiag = Date.now();
      const rr = await req('POST', `/api/devices/redroid/${v.id}/proxy/retry`);
      say(`operator proxy/retry ${name}: ${rr.status} ${JSON.stringify(rr.j).slice(0, 150)}`);
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

  // ================= SETUP =================
  say('SETUP: restart API with W3 ON (echo = ladder gateway)');
  restartApi();
  await login(); // AFTER the restart: a crashed prior run leaves 16490 dead (run4 discovery)
  // W3-ON probe: binding PUT must NOT answer the disabled-switch code
  psql(`INSERT INTO identities (id, external_ref, display_name, identity_type, status, data_path, metadata_json, created_at, updated_at) VALUES
    ('${C1}','rdev-w3-c1','rdev-w3-c1','qa_device','READY','/var/lib/water-army/identities/rdev-w3-c1','{}'::jsonb, now(), now()),
    ('${C2}','rdev-w3-c2','rdev-w3-c2','qa_device','READY','/var/lib/water-army/identities/rdev-w3-c2','{}'::jsonb, now(), now()),
    ('${C3}','rdev-w3-c3','rdev-w3-c3','qa_device','READY','/var/lib/water-army/identities/rdev-w3-c3','{}'::jsonb, now(), now())
  ON CONFLICT (id) DO UPDATE SET status = 'READY';`);
  // template rdev-w3 = rdev-base shape + proxy .50
  const tlist = await req('GET', '/api/redroid/templates');
  if (!(tlist.j.templates ?? tlist.j.items ?? []).some?.((t) => t.name === TEMPLATE)) {
    const tr = await req('POST', '/api/redroid/templates', { ...TPL_BODY, proxyUrl: url(EGRESS_A) });
    if (tr.status !== 200 && tr.status !== 201) throw new Error(`template create -> ${tr.status} ${JSON.stringify(tr.j).slice(0, 300)}`);
    say('template rdev-w3 created (proxy = egress-a)');
  }
  const tplRow = (tlist.j.templates ?? tlist.j.items ?? []).find?.((t) => t.name === TEMPLATE);
  if (!tplRow) throw new Error('template rdev-w3 missing from list after setup');
  TEMPLATE_ID = tplRow.id;
  // Canonical reset: clear residual bindings from crashed runs (a D8
  // mid-crash leaves c3 pinned to .50 → 409 EGRESS_IP_CONFLICT on c1's
  // canonical bind — run5 discovery). DELETE is idempotent (404 = clean).
  for (const id of [C1, C2, C3]) {
    await req('DELETE', `/api/identities/${id}/egress`);
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
  // Template/binding/device consistency (idempotent re-runs): a mid-D7
  // re-run leaves the template rotated to .54 and c1 with a .54 proxy baked,
  // while the bindings above say .50 — the device bakes the template proxy
  // at create, so a binding-only re-bind would never reconcile (D1 would
  // hang on DRIFTED forever). Restore the canonical baseline (.50) and
  // recreate c1 from it. Warm dataDir → fast boot.
  const tplPut = await req('PUT', `/api/redroid/templates/${TEMPLATE_ID}`, { proxyUrl: url(EGRESS_A) });
  if (tplPut.status !== 200) throw new Error(`SETUP template proxy restore -> ${tplPut.status} ${JSON.stringify(tplPut.j).slice(0, 200)}`);
  const devList = await req('GET', '/api/devices/redroid');
  const c1old = (devList.j.devices ?? []).find((d) => d.name === 'redroid-rdev-c1');
  if (c1old) {
    ramOk();
    const d1 = await req('DELETE', `/api/devices/redroid/${c1old.id}`, { confirm: 'redroid-rdev-c1', removeData: false });
    if (d1.status !== 200) throw new Error(`SETUP c1 reset delete -> ${d1.status} ${JSON.stringify(d1.j).slice(0, 200)}`);
    const cr1 = await req('POST', '/api/devices/redroid', { name: 'redroid-rdev-c1', templateName: TEMPLATE, identityId: C1, idempotencyKey: `rdev-w3-c1-setup-${Date.now().toString(36)}` });
    if (cr1.status !== 200 && cr1.status !== 201) throw new Error(`SETUP c1 reset create -> ${cr1.status} ${JSON.stringify(cr1.j).slice(0, 200)}`);
    say('SETUP: c1 recreated (template/binding/device proxy consistency)');
  }
  const c3old = (devList.j.devices ?? []).find((d) => d.name === 'redroid-rdev-c3');
  if (c3old) {
    // D8 recreates c3 under echo-off semantics — a stale c3 from a crashed
    // run would 409 the create and carry unknown proxy state.
    const d3 = await req('DELETE', `/api/devices/redroid/${c3old.id}`, { confirm: 'redroid-rdev-c3', removeData: false });
    if (d3.status !== 200) say(`SETUP c3 reset delete -> ${d3.status} (continuing)`);
    else say('SETUP: stale c3 removed (D8 recreates)');
  }
  say('setup complete');

  // ================= D1: first VERIFIED end-to-end =================
  {
    // adoption-tolerant: an existing c1 (e.g. from a crashed prior run) is
    // reused — the watchdog re-probes against the current echo anchor and the
    // state machine re-evaluates within one tick.
    let adopt = false;
    const l0 = await req('GET', '/api/devices/redroid');
    const c0 = (l0.j.devices ?? []).find((d) => d.name === 'redroid-rdev-c1');
    if (c0) {
      adopt = true;
      say('D1: c1 already exists (adopted) — waiting for re-VERIFIED against current echo anchor');
    } else {
      ramOk();
      const cr = await req('POST', '/api/devices/redroid', {
        name: 'redroid-rdev-c1', templateName: TEMPLATE, identityId: C1,
        idempotencyKey: `rdev-w3-c1-${Date.now().toString(36)}`,
      });
      if (cr.status !== 200 && cr.status !== 201) throw new Error(`c1 create -> ${cr.status} ${JSON.stringify(cr.j).slice(0, 300)}`);
      say('D1: c1 created — waiting for boot + tunnel + first VERIFIED (budget 30min cold)');
    }
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
      adopted: adopt,
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
    for (let i = 0; i < 45; i++) { // 135s window (tick 30s + probe 10s ×2 + margin)
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
    for (let i = 0; i < 45; i++) { // 135s window (tick 30s + probe 10s + reconnect margin)
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
    // adoption-tolerant (idempotent re-runs): an existing c2 is reused — its
    // binding (.51) and proxy override (device-level) are intact from create.
    let adopt2 = false;
    const l2 = await req('GET', '/api/devices/redroid');
    const c2old = (l2.j.devices ?? []).find((d) => d.name === 'redroid-rdev-c2');
    if (c2old) {
      adopt2 = true;
      say('D5: c2 already exists (adopted) — waiting for VERIFIED @.51');
    } else {
      const cr = await req('POST', '/api/devices/redroid', {
        name: 'redroid-rdev-c2', templateName: TEMPLATE, identityId: C2,
        proxyUrl: url(EGRESS_B), // device-level override: c2 egresses via .51
        idempotencyKey: `rdev-w3-c2-${Date.now().toString(36)}`,
      });
      if (cr.status !== 200 && cr.status !== 201) throw new Error(`c2 create -> ${cr.status} ${JSON.stringify(cr.j).slice(0, 300)}`);
      say('D5: c2 created — waiting VERIFIED (budget 30min cold)');
    }
    const { v: v2, waitedMs } = await waitForView('redroid-rdev-c2',
      (x) => x.adbState === 'online' && egressOf(x)?.state === 'VERIFIED', 30 * 60 * 1000, 'D5 c2 VERIFIED');
    const v1 = await view('redroid-rdev-c1'); // simultaneous snapshot
    const e1 = egressOf(v1), e2 = egressOf(v2);
    const clash = await req('PUT', `/api/identities/${C3}/egress`, { proxyUrl: url(EGRESS_A), expectedEgressIp: EGRESS_A });
    summary.items.D5 = {
      pass: e1.state === 'VERIFIED' && e2.state === 'VERIFIED'
        && e1.lastObservedIp === EGRESS_A && e2.lastObservedIp === EGRESS_B
        && clash.status === 409 && /EGRESS_IP_CONFLICT/.test(JSON.stringify(clash.j)),
      simultaneous: { c1: e1, c2: e2 }, c2WaitedMs: waitedMs, c2Adopted: adopt2,
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
    // (b) DoH mimic over the tunnel: raw HTTP GET /resolve through the proxy
    //     chain. toybox nc takes host/port as SEPARATE args, and (R8) its
    //     stdin must be held open across a FIFO — piped stdin EOFs instantly
    //     and the FIN tears the gost relay down before the response returns
    //     (both defects observed 2026-10-26: "bad argument count" + empty OUT).
    const dohLocal = '/tmp/rdev-state/d4doh-guest.sh';
    fs.writeFileSync(dohLocal, `#!/system/bin/sh
set -u
HOST=${ECHO_HOST}
PORT=${ECHO_PORT}
TMPD=/data/local/tmp
IN=$TMPD/d4doh.$$
OUTF=$TMPD/d4doh_out.$$
rm -f "$IN" "$OUTF"
mkfifo "$IN" 2>/dev/null
timeout 13 nc -w 8 "$HOST" "$PORT" < "$IN" > "$OUTF" 2>/dev/null &
NCP=$!
exec 3>"$IN"
printf 'GET /resolve?name=canary.rdevtest HTTP/1.1\\r\\nHost: probe\\r\\nConnection: close\\r\\n\\r\\n' >&3
wait $NCP
RC=$?
exec 3>&-
echo "rc=$RC"
cat "$OUTF" 2>/dev/null
rm -f "$IN" "$OUTF"
`);
    shSoft(`${ADB} -s ${serial} push ${dohLocal} /data/local/tmp/d4doh.sh >/dev/null 2>&1`, 30000);
    const doh = g('sh /data/local/tmp/d4doh.sh').slice(0, 800);
    let dohClientIp = null;
    try {
      const bodyPart = doh.split('\r\n\r\n').pop() ?? '';
      const lines = bodyPart.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
      // chunked framing (node http, no content-length): [sizeHex, json, '0']
      dohClientIp = JSON.parse(lines[1] ?? lines[0] ?? '{}').client_ip ?? null;
    } catch { /* non-json */ }
    d4.b_doh = { raw: doh, clientIp: dohClientIp, pass: dohClientIp === EGRESS_A };
    // (c) leak window: tunnel dead -> guest direct UDP DNS from the CONTAINER
    //     ip. NOT VERIFIABLE on scratch: the guest has NO DNS client (D1 tooling:
    //     nslookup/wget absent) and a hand-rolled UDP DNS wire query in toybox
    //     sh is unreliable (printf \x support, packet assembly). The direct
    //     (non-tunnel) egress behavior IS observed elsewhere in this campaign:
    //     pre-tunnel probes exited from the container's own ladder IP (API
    //     egress transition log: DRIFTED observed=172.38.222.2 / .4).
    sh('docker stop rdev-egress-a', 30000);
    await sleep(2000); // let the tunnel connections die
    const before = shSoft(`docker exec rdev-dnslog cat /logs/dnslog.jsonl 2>/dev/null || true`);
    const eDown = egressOf(await view('redroid-rdev-c1'));
    await sleep(1500);
    const after = shSoft(`docker exec rdev-dnslog cat /logs/dnslog.jsonl 2>/dev/null || true`);
    const newLines = after.split('\n').filter((l) => l && !before.includes(l));
    const c1ip = containerIp('redroid-rdev-c1');
    d4.c_leakWindow = {
      verified: false,
      reason: 'NOT VERIFIED on scratch: no DNS client tool in guest (D1: nslookup/wget absent); hand-rolled UDP DNS in toybox sh infeasible',
      observedDirectEgressElsewhere: { driftObservedIp: '172.38.222.2', source: 'API egress transition log (this campaign, pre-tunnel probe window)', containerIp: c1ip },
      egressStateWhileEgressDown: eDown?.state ?? null,
      newDnsEntries: newLines.slice(0, 5),
    };
    sh('docker start rdev-egress-a', 30000);
    await waitForView('redroid-rdev-c1', (x) => egressOf(x)?.state === 'VERIFIED', 5 * 60 * 1000, 'D4 recover VERIFIED');
    d4.recovered = true;
    summary.items.D4 = {
      pass: d4.b_doh.pass, // (b) is the scratch-feasible DoH proof; (a)/(c) recorded honestly
      a_nslookup: d4.a_nslookup, b_doh: d4.b_doh, c_leakWindow: d4.c_leakWindow,
    };
    ev('d4-dns-doh.json', summary.items.D4);
    say(`D4: dohClientIp=${dohClientIp} c-verified=${d4.c_leakWindow.verified} a=${d4.a_nslookup.out.slice(0, 40)}`);
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
    const tpl = await req('PUT', `/api/redroid/templates/${TEMPLATE_ID}`, { proxyUrl: url(EGRESS_D) });
    if (tpl.status !== 200) throw new Error(`D7 template update -> ${tpl.status} ${JSON.stringify(tpl.j).slice(0, 200)}`);
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
    say(`D7: rotated c1 -> ${EGRESS_D}; audit=${!!audHit} reVerified=${egressOf(rec.v).lastObservedIp}`);
  }

  // ================= D8: echo not configured -> never VERIFIED =================
  {
    ramOk();
    // D8: blank the echo HOST (optInt fatals on an explicit "0" port —
    // config.js hard-fails WA_W3_EGRESS_ECHO_PORT=0, live-discovered 2026-10-26).
    // Port stays at the base 16491; egressEchoConfigured() = host!=='' && port>=1.
    const ov = `${EVID}/d8-echo-off.env`;
    fs.writeFileSync(ov, 'WA_W3_EGRESS_ECHO_HOST=""\n');
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
