/**
 * Phase 6 — adversarial cross + security regression (real-device surfaces).
 *
 *  1. RBAC on the REAL device routes (viewer/operator/admin × redroid +
 *     app-ops + egress + audit), read-only probes only (no device side
 *     effects: the negative set is asserted, positive-create is NOT tested).
 *  2. Cross-identity residue: per-device dataDir isolation via package
 *     visibility (w1-installed package must not exist on w2).
 *  3. Log-leak canary: session/encryption/worker/stream secrets from the
 *     scratch env + egress credentials must appear in ZERO log surfaces;
 *     JWTs (eyJ…) must not be logged at all.
 *  4. Sensitive scan: repo (tracked files) must not carry real secrets
 *     (scratch fixture passwords are documented-known, asserted separately).
 *
 * Evidence: logs/realdevice-master/final/security-*.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const API = process.env.RD_API ?? 'http://127.0.0.1:16490';
const ADB = process.env.RD_ADB ?? `${process.env.HOME}/.local/share/platform-tools/adb`;
const EVID = '/home/kenneth/.openclaw/workspace/water_army/logs/realdevice-master/final';
const REPO = '/home/kenneth/.openclaw/workspace/water_army';
const W3EVID = '/home/kenneth/.openclaw/workspace/water_army/logs/realdevice-master/w3';
const SECRETS_FILE = '/tmp/rdev-state/env.sh';
const CANARY_FILE = '/tmp/rdev-state/w3-canary.txt';

fs.mkdirSync(EVID, { recursive: true });
const say = (m) => console.log(`[sec ${new Date().toISOString()}] ${m}`);
const ev = (name, obj) => { const p = `${EVID}/${name}`; fs.writeFileSync(p, JSON.stringify(obj, null, 2)); say(`evidence -> ${p}`); };
const sh = (cmd, timeout = 60000) => execSync(cmd, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
const shSoft = (cmd, timeout = 60000) => { try { return sh(cmd, timeout); } catch (e) { return `[rc=${e.status}] ${String(e.stdout || '').trim()}`; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Jar {
  constructor() { this.cookie = ''; }
  async req(method, p, body) {
    const r = await fetch(`${API}${p}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const j = await r.json().catch(() => ({}));
    return { status: r.status, j };
  }
  async login(u, pw) { const r = await this.req('POST', '/api/auth/login', { username: u, password: pw }); if (r.status !== 200) throw new Error(`login ${u} -> ${r.status}`); return r.j.user ?? r.j; }
}

async function main() {
  const out = { at: new Date().toISOString(), rbac: {}, crossIdentity: null, logLeak: null, sensitiveScan: null };

  // ---------- 1. RBAC on real-device routes ----------
  const admin = new Jar(); const op = new Jar(); const view = new Jar();
  await admin.login('rdev-admin', 'rdev-e2e-admin-pw');
  await op.login('rdev-op1', 'rdev-e2e-op-pw');
  await view.login('rdev-view1', 'rdev-e2e-view-pw');
  say('3 roles logged in');

  const list = await admin.req('GET', '/api/devices/redroid');
  const devices = list.j.devices ?? [];
  const dev = devices.find((d) => d.name?.startsWith('redroid-rdev')) ?? devices[0] ?? null;
  const C1 = 'c9f1c001-0000-4000-8000-0000000000c1';
  // any identity for the binding GET (viewer-readable)
  const anyIdent = devices.find((d) => d.identityId)?.identityId ?? C1;
  // egress switch state varies by phase (W3 ON vs OFF after W2 A9):
  // viewer must never see MORE than admin — expect admin's status verbatim.
  const adminBind = await admin.req('GET', `/api/identities/${anyIdent}/egress`);
  const bindExpect = adminBind.status; // 200 when W3 ON; disabled-code when OFF
  say(`egress switch probe: admin GET binding -> ${adminBind.status} (viewer expected to match or be denied)`);

  const cases = [
    // [label, jar, method, path, expect]
    ['viewer GET device list', view, 'GET', '/api/devices/redroid', 200],
    ['viewer POST device create (NEG)', view, 'POST', '/api/devices/redroid', 403],
    ['viewer DELETE device (NEG)', view, 'DELETE', dev ? `/api/devices/redroid/${dev.id}` : '/api/devices/redroid/x', 403],
    ['viewer GET binding', view, 'GET', `/api/identities/${anyIdent}/egress`, bindExpect],
    ['viewer PUT binding (NEG)', view, 'PUT', `/api/identities/${anyIdent}/egress`, 403],
    ['viewer GET audit (NEG)', view, 'GET', '/api/audit-events', 403],
    ['viewer GET interventions', view, 'GET', '/api/manual-interventions', 200],
    ['operator DELETE device (NEG admin-only)', op, 'DELETE', dev ? `/api/devices/redroid/${dev.id}` : '/api/devices/redroid/x', 403],
    ['operator PUT binding (NEG admin-only)', op, 'PUT', `/api/identities/${anyIdent}/egress`, 403],
    ['operator GET audit (NEG admin-only)', op, 'GET', '/api/audit-events', 403],
    ['operator GET device list', op, 'GET', '/api/devices/redroid', 200],
  ];
  if (dev) {
    cases.push(['viewer GET apps list', view, 'GET', `/api/devices/redroid/${dev.id}/apps`, 200]);
    // app install NEG by role (viewer) — must be 403 BEFORE reaching body validation
    cases.push(['viewer POST app install (NEG role)', view, 'POST', `/api/devices/redroid/${dev.id}/apps`, 403]);
    cases.push(['viewer POST ui tap (NEG role)', view, 'POST', `/api/devices/redroid/${dev.id}/ui/tap`, 403]);
  }
  for (const [label, jar, method, p, expect] of cases) {
    const body = method === 'PUT' ? { proxyUrl: 'socks5://u:p@127.0.0.1:1080', expectedEgressIp: '203.0.113.9' }
      : method === 'POST' && p.endsWith('/apps') ? { fileName: 'zzz.apk' }
      : method === 'POST' && p.endsWith('/ui/tap') ? { x: 1, y: 1 }
      : method === 'POST' ? { name: 'rbac-neg-device', templateName: 'rdev-base' }
      : method === 'DELETE' ? { confirm: 'rbac-neg', removeData: false } : undefined;
    const r = await jar.req(method, p, body).catch((e) => ({ status: 0, j: { err: String(e) } }));
    const pass = r.status === expect;
    (out.rbac[label] = out.rbac[label] ?? []).push({ expect, got: r.status, pass });
    say(`RBAC ${label}: expect=${expect} got=${r.status} ${pass ? 'OK' : 'FAIL'}`);
  }
  // admin sanity: admin audit read works (positive control)
  const aPos = await admin.req('GET', '/api/audit-events?pageSize=1');
  out.rbac['admin GET audit (POSITIVE CONTROL)'] = [{ expect: 200, got: aPos.status, pass: aPos.status === 200 }];

  // ---------- 2. cross-identity residue (dataDir isolation via visibility) ----------
  const w1 = devices.find((d) => d.name === 'redroid-rdev-w1');
  const w2 = devices.find((d) => d.name === 'redroid-rdev-w2');
  if (w1 && w2 && w1.adbState === 'online' && w2.adbState === 'online') {
    const s1 = `127.0.0.1:${w1.adbPort}`; const s2 = `127.0.0.1:${w2.adbPort}`;
    const pkgs1 = shSoft(`${ADB} -s ${s1} shell pm list packages -3 2>/dev/null`).split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean);
    const pkgs2 = shSoft(`${ADB} -s ${s2} shell pm list packages -3 2>/dev/null`).split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean);
    const shared = pkgs1.filter((p) => pkgs2.includes(p));
    const dd1 = w1.dataDir ?? `/var/lib/water-army/redroid-rdev/${w1.name}`;
    const dd2 = w2.dataDir ?? `/var/lib/water-army/redroid-rdev/${w2.name}`;
    const ddExist = [dd1, dd2].map((p) => ({ p, exists: fs.existsSync(p) }));
    out.crossIdentity = {
      pass: shared.length === 0,
      w1ThirdParty: pkgs1, w2ThirdParty: pkgs2, shared,
      dataDirs: { w1: dd1, w2: dd2, distinct: dd1 !== dd2, existence: ddExist },
      note: 'third-party package visibility is the observable proxy for dataDir isolation (no shared /data volume across rdev devices); dataDir paths from view or the documented convention',
    };
    ev('cross-identity-residue.json', out.crossIdentity);
    say(`crossIdentity: shared=${shared.length} pass=${out.crossIdentity.pass}`);
  } else {
    out.crossIdentity = { pass: null, note: 'W2 devices not both online at Phase-6 time — covered by W2 E-phase evidence instead' };
    say('crossIdentity: skipped (w1/w2 not both online)');
  }

  // ---------- 3. log-leak canary ----------
  {
    const secrets = {};
    const envText = shSoft(`cat ${SECRETS_FILE} 2>/dev/null`);
    for (const key of ['MC_SESSION_SECRET', 'MC_APP_ENCRYPTION_KEY', 'MC_WORKER_API_TOKEN', 'MC_STREAM_TICKET_SECRET', 'MC_STREAM_SIDECAR_TOKEN']) {
      const m = envText.match(new RegExp(`^export ${key}=(\\S+)$`, 'm'));
      if (m) secrets[key] = m[1];
    }
    const canText = shSoft(`cat ${CANARY_FILE} 2>/dev/null`);
    const eu = canText.match(/^EGRESS_USER=(\S+)$/m)?.[1];
    const ep = canText.match(/^EGRESS_PASS=(\S+)$/m)?.[1];
    if (eu) secrets.EGRESS_USER = eu;
    if (ep) secrets.EGRESS_PASS = ep;

    const surfaces = {
      'scratch-api.log (cap 30MB)': shSoft(`tail -c 30000000 ${REPO}/logs/realdevice-master/scratch-api.log 2>/dev/null`),
      'echo.log (cap 1MB)': shSoft(`tail -c 1000000 ${REPO}/logs/realdevice-master/echo.log 2>/dev/null`),
      'evidence/w1 (all json)': shSoft(`cat ${REPO}/logs/realdevice-master/w1/*.json 2>/dev/null | head -c 5000000`),
      'evidence/w3 (all json)': shSoft(`cat ${W3EVID}/*.json 2>/dev/null | head -c 5000000`),
      'progress file': shSoft(`cat /home/kenneth/.openclaw/workspace/logs/waterarmy-realdevice-progress.md 2>/dev/null`),
    };
    for (const c of ['rdev-egress-a', 'rdev-egress-b', 'rdev-egress-c', 'rdev-egress-d', 'rdev-dnslog']) {
      if (shSoft(`docker inspect ${c} --format '{{.State.Status}}'`).trim() === 'running') {
        surfaces[`docker logs ${c}`] = shSoft(`docker logs --tail 3000 ${c} 2>&1`);
      }
    }
    // guest logcat of every online rdev device
    for (const d of devices.filter((x) => x.name?.startsWith('redroid-rdev') && x.adbState === 'online')) {
      surfaces[`guest logcat ${d.name}`] = shSoft(`${ADB} -s 127.0.0.1:${d.adbPort} shell logcat -d 2>&1 | tail -c 2000000`, 120000);
    }
    const results = [];
    for (const [name, text] of Object.entries(surfaces)) {
      const hits = {};
      for (const [k, v] of Object.entries(secrets)) hits[k] = text.split(v).length - 1;
      hits['JWT(eyJ)'] = (text.match(/eyJ[A-Za-z0-9_-]{10,}/g) ?? []).length;
      results.push({ surface: name, len: text.length, hits });
    }
    const clean = results.every((r) => Object.values(r.hits).every((h) => h === 0));
    out.logLeak = { pass: clean, secretKeysScanned: Object.keys(secrets), results };
    ev('log-leak-canary.json', out.logLeak);
    say(`logLeak: clean=${clean} surfaces=${results.length}`);
  }

  // ---------- 4. sensitive scan (repo tracked files) ----------
  {
    const canText = shSoft(`cat ${CANARY_FILE} 2>/dev/null`);
    const eu = canText.match(/^EGRESS_USER=(\S+)$/m)?.[1];
    const ep = canText.match(/^EGRESS_PASS=(\S+)$/m)?.[1];
    const needles = {
      'egress-canary-user': eu, 'egress-canary-pass': ep,
      'real-db-password': null, // scratch uses postgres/postgres — fixture, not real
    };
    const gitGrep = (n) => shSoft(`git -C ${REPO} grep -n --no-color -F ${JSON.stringify(n)} -- . 2>/dev/null | head -20`).trim();
    const gitGrepBlame = (n) => shSoft(`git -C ${REPO} log --all --oneline -S ${JSON.stringify(n)} 2>/dev/null | head -10`).trim();
    const results = {};
    for (const [k, n] of Object.entries(needles)) {
      if (!n) { results[k] = { skipped: true, reason: 'fixture by design (scratch)' }; continue; }
      const inTree = gitGrep(n);
      const inHistory = gitGrepBlame(n);
      results[k] = { inTrackedTree: inTree ? inTree.split('\n') : [], inHistory: inHistory ? inHistory.split('\n') : [], clean: !inTree && !inHistory };
    }
    // documented-known: scratch fixture passwords in seed scripts (NOT real credentials)
    const fixturePwd = shSoft(`git -C ${REPO} grep -n --no-color -F 'rdev-e2e-admin-pw' -- . 2>/dev/null | head -10`).trim();
    out.sensitiveScan = { pass: Object.values(results).every((r) => r.skipped || r.clean), results, fixturePasswordOccurrences: fixturePwd ? fixturePwd.split('\n').length : 0, fixtureNote: 'scratch fixture passwords (rdev-*) live in seed scripts BY DESIGN — they are not production credentials; recorded, not "leaks"' };
    ev('sensitive-scan.json', out.sensitiveScan);
    say(`sensitiveScan: pass=${out.sensitiveScan.pass}`);
  }

  ev('security-summary.json', out);
  const failCount = Object.values(out.rbac).flat().filter((r) => !r.pass).length;
  say(`PHASE6 DONE — rbacFails=${failCount} cross=${out.crossIdentity?.pass ?? 'skipped'} logLeak=${out.logLeak.pass} sensitive=${out.sensitiveScan.pass}`);
  process.exit(0);
}

main().catch((e) => {
  say(`FATAL: ${e?.stack ?? e}`);
  ev('security-fatal.json', { at: new Date().toISOString(), error: String(e?.message ?? e) });
  process.exit(1);
});
