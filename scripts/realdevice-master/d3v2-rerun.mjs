#!/usr/bin/env node
/**
 * D3/D6 v2 re-run (2026-10-26 real-device campaign) — clean intervention
 * detection + dynamic container targeting.
 *
 * Why v2: the matrix's first D3/D6 pass detected interventions by "any open
 * egress intervention" — which picked up the STALE DRIFTED episode from the
 * bad-anchor era (createdAt 16:55, observed 172.38.222.2). The state-machine
 * evidence (UNREACHABLE/DRIFTED detection + auto-recovery) from that pass is
 * valid; only the intervention-timing claim needed a clean measurement.
 *
 * Why dynamic targeting: after D7 the c1 device is rotated off .50 (egress-a)
 * onto .54 (egress-d) — a hardcoded "stop egress-a" no longer touches c1's
 * live egress (live-discovered 2026-10-26: first v2 attempt no-op'd).
 *
 * v2 semantics (episode-delta based, no stale pickup):
 *   t0-1s: snapshot every intervention row for the device (id -> {version,
 *           signalCount, status, category, createdAt}).
 *   trigger the fault (D3: stop c1's current relay / D6: recreate it via .53)
 *   poll: an intervention "FIRED NOW" iff
 *           a NEW row with createdAt >= t0-1500ms, OR
 *           an existing row with signalCount increased AND its evidence
 *           matches the fault fingerprint (D3: UNREACHABLE / D6: .53).
 *   recover, record. Leave human-owned doors OPEN (no auto-resolve).
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const API = 'http://127.0.0.1:16490';
const EVID = '/home/kenneth/.openclaw/workspace/water_army/logs/realdevice-master/w3';
const DEV = 'redroid-rdev-c1';
const HARNESS = '/home/kenneth/.openclaw/workspace/water_army/scripts/realdevice-master';
const NODE_IMG = 'node:22-alpine';

const IP_TO_CONTAINER = {
  '172.38.222.50': 'rdev-egress-a',
  '172.38.222.51': 'rdev-egress-b',
  '172.38.222.53': 'rdev-egress-c',
  '172.38.222.54': 'rdev-egress-d',
};
const CONTAINER_IP = {
  'rdev-egress-a': '172.38.222.50',
  'rdev-egress-b': '172.38.222.51',
  'rdev-egress-c': '172.38.222.53',
  'rdev-egress-d': '172.38.222.54',
};
const DRAFT_RELY_VIA = '172.38.222.53:9999'; // egress-c dialer

const sh = (cmd, t = 30000) => execSync('bash -c ' + JSON.stringify(cmd), { encoding: 'utf8', timeout: t }).toString();
const shSoft = (cmd, t = 30000) => { try { return sh(cmd, t); } catch { return ''; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ck = '';
async function req(method, path, body) {
  const r = await fetch(API + path, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(ck ? { cookie: ck } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
  let j = null; try { j = await r.json(); } catch { /* noop */ }
  return { status: r.status, j };
}
const view = async (name) => (await req('GET', '/api/devices/redroid')).j?.devices?.find((d) => d.name === name) ?? null;
const egressOf = (v) => v?.proxy?.network?.egress ?? null;

async function interventions() {
  const d = await view(DEV);
  const r = await req('GET', `/api/manual-interventions?deviceId=${d.id}&pageSize=100`);
  return (r.j.interventions ?? r.j.items ?? r.j ?? []);
}

async function snap() {
  const rows = await interventions();
  const m = new Map();
  for (const it of rows) m.set(it.id, { version: it.version, signalCount: it.signalCount, status: it.status, createdAt: it.createdAt, category: it.category, evidence: it.evidence });
  return m;
}

function restartEgress(container, via) {
  const U = shSoft("grep '^EGRESS_USER=' /tmp/rdev-state/w3-canary.txt | cut -d= -f2").trim();
  const P = shSoft("grep '^EGRESS_PASS=' /tmp/rdev-state/w3-canary.txt | cut -d= -f2").trim();
  const ip = CONTAINER_IP[container];
  shSoft(`docker rm -f ${container}`, 30000);
  const viaArg = via ? ` -e DIAL_VIA=${via}` : '';
  sh(`docker run -d --name ${container} --network br-rdev-ladder --ip ${ip} --restart unless-stopped \
    -e PORT=1080 -e EGRESS_USER='${U}' -e EGRESS_PASS='${P}'${viaArg} \
    -v ${HARNESS}:/scripts:ro ${NODE_IMG} node /scripts/egress-socks5.mjs`, 30000);
  return new Promise((r) => setTimeout(r, 2500));
}

async function watchForFault({ wantState, faultFingerprint, budgetMs = 180000, pollMs = 3000 }) {
  const t0 = Date.now();
  const before = await snap();
  await sleep(1000);
  let stateAt = null, fired = null;
  while (Date.now() - t0 < budgetMs) {
    const v = await view(DEV);
    const e = egressOf(v);
    if (!stateAt && e.state === wantState) stateAt = { atMs: Date.now() - t0, egress: e };
    if (stateAt && fired) break;
    if (stateAt && !fired) {
      const now = await snap();
      for (const [id, it] of now) {
        if (!before.has(id) && new Date(it.createdAt).getTime() >= t0 - 1500) {
          fired = { kind: 'new-episode', atMs: Date.now() - t0, intervention: it };
        }
      }
      if (!fired) for (const [id, old] of before) {
        const it = now.get(id);
        if (!it) continue;
        if ((it.signalCount ?? 0) > (old.signalCount ?? 0) && faultFingerprint(it.evidence)) {
          fired = { kind: 'episode-signal', atMs: Date.now() - t0, delta: { versionDelta: (it.version ?? 0) - (old.version ?? 0), signalDelta: (it.signalCount ?? 0) - (old.signalCount ?? 0) }, intervention: it };
        }
      }
    }
    await sleep(pollMs);
  }
  return { stateAt, fired };
}

async function waitForVerified(budgetMs = 300000) {
  const t1 = Date.now();
  while (Date.now() - t1 < budgetMs) {
    const v = await view(DEV);
    if (egressOf(v)?.state === 'VERIFIED') return { waitedMs: Date.now() - t1, egress: egressOf(v) };
    await sleep(3000);
  }
  return null;
}

const MODE = process.argv[2]; // 'd3' | 'd6'
const out = { mode: MODE, startedAt: new Date().toISOString() };

{ const lr = await req('POST', '/api/auth/login', { username: 'rdev-admin', password: 'rdev-e2e-admin-pw' });
  if (lr.status !== 200) throw new Error(`login ${lr.status}`); }

// which relay does c1 actually use right now?
const v0 = await view(DEV);
const liveIp = egressOf(v0)?.lastObservedIp;
if (!liveIp || !IP_TO_CONTAINER[liveIp]) throw new Error(`cannot map c1 live egress ip ${liveIp} to a container`);
const liveContainer = IP_TO_CONTAINER[liveIp];
out.target = { liveIp, liveContainer };
console.log(`target: c1 egresses via ${liveIp} (${liveContainer})`);

if (MODE === 'd3') {
  sh(`docker stop ${liveContainer}`, 30000);
  await sleep(1500);
  const { stateAt, fired } = await watchForFault({
    wantState: 'UNREACHABLE',
    faultFingerprint: (ev) => /unreach|probe|timeout|ECONNREFUSED|connect/i.test(JSON.stringify(ev)) || ev?.egressState === 'UNREACHABLE',
  });
  sh(`docker start ${liveContainer}`, 30000);
  await sleep(1500);
  const rec = await waitForVerified();
  out.d3 = {
    pass: !!stateAt && !!rec?.egress?.lastMatchAt,
    stateAt, interventionFired: fired, recovery: rec,
    note: 'v2: dynamic relay target (c1 post-D7 = egress-d .54); intervention detected by episode delta (new row createdAt>=t0 OR signalCount increase with UNREACHABLE fingerprint) — no stale pickup',
  };
} else if (MODE === 'd6') {
  await restartEgress(liveContainer, DRAFT_RELY_VIA);
  const { stateAt, fired } = await watchForFault({
    wantState: 'DRIFTED',
    faultFingerprint: (ev) => String(ev?.observedIp ?? '') === '172.38.222.53',
  });
  await restartEgress(liveContainer, '');
  const rec = await waitForVerified();
  const intsAfter = await interventions();
  const openDrift = intsAfter.filter((x) => /drift/i.test(JSON.stringify(x)) && /open|pending/i.test(String(x.status ?? '')));
  out.d6 = {
    pass: !!stateAt && stateAt.egress.lastObservedIp === '172.38.222.53' && !!rec,
    stateAt, interventionFired: fired, recovery: rec,
    driftInterventionStillOpenAfterRecovery: openDrift.length > 0,
    openDriftInterventions: openDrift.map((x) => ({ id: x.id, status: x.status, version: x.version, signalCount: x.signalCount, createdAt: x.createdAt })),
    note: 'v2: dynamic relay target; drift intervention detected by episode delta with observedIp==172.38.222.53 fingerprint (the stale .2/.53-prior episodes do NOT match on createdAt)',
  };
} else {
  console.error('usage: d3v2-rerun.mjs d3|d6');
  process.exit(2);
}

out.finishedAt = new Date().toISOString();
fs.mkdirSync(EVID, { recursive: true });
fs.writeFileSync(`${EVID}/${MODE}-v2.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out[MODE], pass: out[MODE].pass }, null, 1));
