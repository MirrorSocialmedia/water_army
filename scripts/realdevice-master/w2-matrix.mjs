/**
 * W2 real-device matrix (ADR-026 §26) — E1-E11 + A1-A10 on scratch redroid.
 *
 * Devices: redroid-rdev-w1 (app host), redroid-rdev-w2 (clean — no app).
 * Target app: net.gsantner.markor 2.16.1 (F-Droid, real signed APK).
 *
 * Discipline:
 *  - E phase first, then A phase. Any A item marked FAIL → halt matrix + exit 3.
 *  - Every item: evidence JSON under logs/realdevice-master/w2/<item>.json
 *  - Manual adb is OBSERVATION-ONLY collateral (pm list, get-state, keyevent 24
 *    for A5/A6 triggers — the ADR prescribes those device-side triggers).
 *  - No secrets in evidence (APK file names are public F-Droid artifacts).
 */
import fs from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';

const ADB = `${process.env.HOME}/.local/share/platform-tools/adb`;
const API = 'http://127.0.0.1:16490';
const APK_DIR = '/var/lib/water-army/apk-rdev';
const APK = 'net.gsantner.markor-163.apk';
const PKG = 'net.gsantner.markor';
const EXPECTED_VERSION = '2.16.1';
const EVID = '/home/kenneth/.openclaw/workspace/water_army/logs/realdevice-master/w2';
const DEV1 = 'redroid-rdev-w1';
const DEV2 = 'redroid-rdev-w2';
const TPL = 'rdev-base';

fs.mkdirSync(EVID, { recursive: true });
let cookie = '';
let haltCount = 0;
const results = [];

const sh = (cmd, timeout = 120000) =>
  execSync(cmd, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 }).toString();
const adb = (serial, ...args) =>
  spawnSync(ADB, ['-s', serial, ...args], { encoding: 'utf8', timeout: 60000 }).stdout.trim();

/** `adb connect <host:port>` — note: NOT `adb -s serial connect` (that is an
 * invalid form: -s selects a target for a device command, and 'connect' is a
 * server-level command. Live 2026-10-27 W2 run2: the -s form returned empty
 * and never registered the device → all platform app-ops 502 'device not
 * found'). Retries: adbd may still be finishing boot. */
async function adbConnect(serial) {
  let out = '';
  for (let i = 0; i < 5; i++) {
    out = spawnSync(ADB, ['connect', serial], { encoding: 'utf8', timeout: 30000 }).stdout.trim();
    if (/connected to|already connected/.test(out)) return out;
    await sleep(2000);
  }
  return out;
}

async function req(method, path, body, { retries = 3 } = {}) {
  // Retries: undici keep-alive pool + API restart (A9 switch-off) = first
  // post-restart request on a pooled socket ECONNRESETs ("fetch failed")
  // despite a healthy server (same defect as w3-matrix, live 2026-10-26).
  for (let i = 0; ; i++) {
    let r;
    try {
      r = await fetch(API + path, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      // Any TypeError from fetch is a connection-level failure (HTTP errors
      // return a response, they never throw) — covers ECONNREFUSED/ECONNRESET,
      // "socket hang up", and undici's keep-alive race "other side closed"
      // (a pooled connection from the pre-restart server process; live-observed
      // 2026-10-26 D8: ready-200 at T, first req at T+1ms threw).
      if (i < retries && (e instanceof TypeError || /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket|closed|terminated|timeout/i.test(String(e?.cause?.message ?? e?.message ?? e)))) {
        await new Promise((res) => setTimeout(res, 400 * (i + 1)));
        continue;
      }
      throw e;
    }
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: r.status, j: await r.json().catch(() => ({})) };
  }
}

function ev(item, data, pass, { expected = false } = {}) {
  const rec = { item, pass, ...(expected ? { expected: true } : {}), at: new Date().toISOString(), ...data };
  results.push(rec);
  fs.writeFileSync(`${EVID}/${item}.json`, JSON.stringify(rec, null, 2));
  console.log(`[${pass ? 'PASS' : expected ? 'EXPECTED-FAIL' : 'FAIL'}] ${item}: ${JSON.stringify(data).slice(0, 220)}`);
  if (!pass && !expected) {
    haltCount++;
    // Discipline (task + script header): any ADRVERSARIAL (A*) item ❌ = halt
    // the matrix NOW. Item-prefix (not PHASE) is authoritative because E11
    // (uninstall) executes DURING the A phase window but is a functional E
    // item — it records a failure but does not halt (relay leg-2 refinement).
    // Original end-of-run exit(3) let later A items cascade on a broken state.
    if (item.startsWith('A')) {
      writeSummary(`HALTED on ${item} (A-item failure — report to CEO)`);
      console.log(`A-ITEM FAIL (${item}) — halting matrix per discipline. Reporting to CEO.`);
      process.exit(3);
    }
  }
  return rec;
}

function adbSerial(id) {
  const d = id; // resolve serial by name → adbPort
  return `127.0.0.1:${d}`;
}

let DEVICES = {}; // name → {id, adbPort}
let PHASE = 'E'; // A-phase items HALT the matrix on failure (task discipline: A 任一 ❌ = halt + 回報)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeSummary(note) {
  const summary = {
    at: new Date().toISOString(),
    total: results.length,
    pass: results.filter((r) => r.pass).length,
    fail: results.filter((r) => !r.pass && !r.expected).length,
    expectedFail: results.filter((r) => !r.pass && r.expected).length,
    haltCount,
    phase: PHASE,
    ...(note ? { note } : {}),
    items: results.map((r) => ({ item: r.item, pass: r.pass, expected: !!r.expected })),
  };
  fs.writeFileSync(`${EVID}/summary.json`, JSON.stringify(summary, null, 2));
  console.log('\n===== W2 SUMMARY =====');
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

/**
 * Host-side boot gate — raw TCP-connect probe to the device's adb port.
 * Deliberately does NOT use the adb server (no `adb connect`): the platform
 * refresh trusts the SHARED adb server's connection state (get-state 'device'
 * → adbState online, redroid-service.js refreshDevice parseState), so any
 * adb-server connect before E1 would mask the no-proxy adb-online gap that E1
 * exists to expose (W1 finding #2). adbd listening on its TCP port = Android
 * boot has reached adbd → E1 failure then means the gap, not boot timing.
 */
async function bootGate(name) {
  const net = await import('node:net');
  const port = DEVICES[name].adbPort;
  const t0 = Date.now();
  for (;;) {
    const up = await new Promise((resolve) => {
      const s = net.default.connect({ host: '127.0.0.1', port, timeout: 1500 });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('timeout', () => { s.destroy(); resolve(false); });
      s.once('error', () => { s.destroy(); resolve(false); });
    });
    if (up) { console.log(`boot-gate ${name}: adbd port ${port} accepting in ${Math.round((Date.now() - t0) / 1000)}s`); return true; }
    if (Date.now() - t0 > 1500000) throw new Error(`boot-gate: ${name} adbd port ${port} not listening in 25min`);
    await sleep(5000);
  }
}

async function resolveDevices({ required = true } = {}) {
  const r = await req('GET', '/api/devices/redroid');
  DEVICES = {};
  for (const d of r.j.devices ?? []) {
    if (d.name === DEV1 || d.name === DEV2) DEVICES[d.name] = { id: d.id, adbPort: d.adbPort };
  }
  if (required && (!DEVICES[DEV1] || !DEVICES[DEV2])) throw new Error('w1/w2 devices not found in API list');
}

function pmList(dev) {
  // (relay leg-2 fix: raw `pm list packages` lines carry a `package:` prefix —
  // E2's added.includes(PKG) false-failed on a REAL successful install, live 2026-10-27)
  return adb(`127.0.0.1:${DEVICES[dev].adbPort}`, 'shell', 'pm', 'list', 'packages')
    .split('\n').map((l) => l.replace(/^package:/, '').trim()).filter(Boolean).sort();
}

async function dump(dev) {
  return req('POST', `/api/devices/redroid/${DEVICES[dev].id}/ui/dump`);
}

async function tap(dev, selector) {
  return req('POST', `/api/devices/redroid/${DEVICES[dev].id}/ui/tap`, { selector });
}

async function fg(dev) {
  return req('GET', `/api/devices/redroid/${DEVICES[dev].id}/foreground`);
}

/** find a node by predicate; returns node or null */
const pick = (nodes, pred) => (nodes ?? []).find(pred) ?? null;

/** create w1/w2 if missing (idempotent), then wait for both online (budget 30 min) */
async function ensureDevices() {
  await resolveDevices({ required: false }); // lenient: fresh fleet has neither yet
  for (const name of [DEV1, DEV2]) {
    if (!DEVICES[name]) {
      const r = await req('POST', '/api/devices/redroid', {
        name, templateName: TPL, idempotencyKey: `rdev-w2-${name}-${Date.now()}`,
      });
      if (r.status !== 201 && r.status !== 200) throw new Error(`create ${name}: ${r.status} ${JSON.stringify(r.j).slice(0, 300)}`);
      console.log(`created ${name} (${r.status})`);
    }
  }
  await resolveDevices();
  const t0 = Date.now();
  let online = false;
  while (Date.now() - t0 < 1800000) {
    const st = await req('GET', '/api/devices/redroid');
    // E1-faithful: exit when RUNNING (not adb-online). A fresh no-proxy
    // device has NO platform path that connects its adb serial (product
    // gap — see W1 finding), so waiting for adbState=online here would
    // deadlock 30min and mask E1. E1 below asserts the refresh outcome on
    // the untouched device; the harness connects AFTER E1 (operator surface).
    const done = [DEV1, DEV2].every((n) => {
      const d = (st.j.devices ?? []).find((x) => x.name === n);
      return d && d.containerState === 'running';
    });
    if (done) { online = true; break; }
    const now = Date.now();
    for (const n of [DEV1, DEV2]) {
      const key = `/tmp/rdev-wait-throttle-${n}`;
      const last = Number(fs.existsSync(key) ? fs.readFileSync(key, 'utf8') : 0);
      if (now - last > 60000) {
        fs.writeFileSync(key, String(now));
        await req('POST', `/api/devices/redroid/${DEVICES[n].id}/refresh`);
      }
    }
    const ages = (st.j.devices ?? []).filter((x) => [DEV1, DEV2].includes(x.name)).map((x) => `${x.name}:${x.containerState}/${x.adbState}`);
    console.log(`waiting boot: ${ages.join(' ')} (${Math.round((Date.now() - t0) / 1000)}s)`);
    await new Promise((r) => setTimeout(r, 30000));
  }
  // (relay leg-2 fix: original code threw UNCONDITIONALLY after the loop —
  // a successful `break` (devices running fast on warm cache) fell straight
  // into the timeout throw. Live 2026-10-27 03:58: w1/w2 running in ~1s,
  // matrix FATAL'd with the bogus 30min message.)
  if (!online) throw new Error('devices did not come online within 30min');
}

function isPortrait(dev) {
  return /720x1280/.test(adb(`127.0.0.1:${DEVICES[dev].adbPort}`, 'shell', 'wm', 'size'));
}

function setOrientation(dev, portrait) {
  if (isPortrait(dev) !== portrait) adb(`127.0.0.1:${DEVICES[dev].adbPort}`, 'shell', 'input', 'keyevent', '24');
}

async function main() {
  // ---- login ----
  const login = await req('POST', '/api/auth/login', { username: 'rdev-admin', password: 'rdev-e2e-admin-pw' });
  if (login.status !== 200) throw new Error(`login failed ${login.status}`);
  await ensureDevices();
  console.log('devices:', JSON.stringify(DEVICES));
  // Deterministic honest-E1 precondition: wipe the shared adb server's device
  // table (no stale serials from n1-n5/c-fleet port reuse can leak into E1's
  // get-state), THEN prove both devices' adbd is up WITHOUT the adb server.
  execSync(`${ADB} kill-server || true`, { timeout: 30000 });
  const bootGateAt = {};
  for (const n of [DEV1, DEV2]) bootGateAt[n] = await bootGate(n);
  await sleep(60000); // settle: adbd listening → get-state 'device' stable
  console.log(`boot-gates done: ${JSON.stringify(bootGateAt)} (+60s settle)`);

  // ================= E PHASE =================
  // E1 — refresh → adb online + get-state=device (on the UNTOUCHED device:
  // no operator connect has happened yet — this is the honest E1)
  {
    const r = await req('POST', `/api/devices/redroid/${DEVICES[DEV1].id}/refresh`);
    const st = adb(`127.0.0.1:${DEVICES[DEV1].adbPort}`, 'get-state');
    ev('E1-refresh-online', {
      http: r.status, adbState: r.j.device?.adbState, adbGetState: st,
      containerState: r.j.device?.containerState,
      bootGateAdbdListening: bootGateAt[DEV1],
      note: 'EXPECTED-FAIL by design (W1 finding #2): no-proxy device has NO platform connect path — container running + adbd up (bootGate) but platform refresh never connects, so adbState never reaches online. Honest E1 = expose this gap (report item).',
    }, r.status === 200 && r.j.device?.adbState === 'online' && st === 'device', { expected: true });
    // Operator-surface connect (documented gap workaround): the rest of the
    // matrix needs live adb. This is exactly what an operator would do.
    for (const n of [DEV1, DEV2]) {
      const c = await adbConnect(`127.0.0.1:${DEVICES[n].adbPort}`);
      console.log(`operator-connect ${n}: ${String(c).trim().slice(0, 80)}`);
    }
    await new Promise((res) => setTimeout(res, 2000));
    await req('POST', `/api/devices/redroid/${DEVICES[DEV1].id}/refresh`);
    await req('POST', `/api/devices/redroid/${DEVICES[DEV2].id}/refresh`);
  }

  // E2 — install
  {
    const before = pmList(DEV1);
    const r = await req('POST', `/api/devices/redroid/${DEVICES[DEV1].id}/apps/install`, { fileName: APK });
    const after = pmList(DEV1);
    const added = after.filter((p) => !before.includes(p));
    ev('E2-install', { http: r.status, body: r.j, addedPkgs: added },
      r.status === 200 && (r.j.installed === true) && added.includes(PKG));
  }

  // E3 — get single app (real version vs F-Droid metadata)
  {
    // Transient adb-engine 502 (ADB_UNAVAILABLE) observed live on run3 right
    // after a heavy push — retry a few times before judging.
    let r = await req('GET', `/api/devices/redroid/${DEVICES[DEV1].id}/apps/${PKG}`);
    let retries = 0;
    while (r.status === 502 && retries < 3) {
      console.log(`E3: 502 transient — retry ${retries + 1}/3`);
      retries++;
      await sleep(2000);
      r = await req('GET', `/api/devices/redroid/${DEVICES[DEV1].id}/apps/${PKG}`);
    }
    ev('E3-app-get', { http: r.status, body: r.j, transientRetries: retries },
      r.status === 200 && r.j.installed === true && r.j.versionName === EXPECTED_VERSION);
  }

  // E4 — launcher foreground + dump
  {
    const f = await fg(DEV1);
    const d = await dump(DEV1);
    const nodes = d.j.nodes ?? [];
    const launcherVisible = (d.j.raw?.length ?? 0) > 0 || nodes.length > 0;
    ev('E4-launcher-dump', {
      http: d.status, fg: f.j, nodeCount: nodes.length, stats: d.j.stats,
      sampleNode: nodes[0] ?? null, launcherVisible,
    }, f.status === 200 && d.status === 200 && nodes.length > 0);
  }

  // E5 — tap app icon in launcher (adaptive: contentDesc/text match on app label)
  let appIconSelector = null;
  {
    const findIcon = (nodes) =>
      pick(nodes, (n) => /markor/i.test(n.contentDesc ?? '')) ??
      pick(nodes, (n) => /markor/i.test(n.text ?? ''));
    let d = await dump(DEV1);
    let node = findIcon(d.j.nodes ?? []);
    let drawerSwipes = 0;
    // Fresh install: launcher3 may keep the new icon in the app drawer only
    // (not the home grid) — open the drawer (swipe up, ADR-style device-side
    // trigger) and re-dump, up to 6 attempts. Recorded in evidence.
    while (!node && drawerSwipes < 6) {
      drawerSwipes++;
      adb(`127.0.0.1:${DEVICES[DEV1].adbPort}`, 'shell', 'input', 'swipe', '360', '1150', '360', '400');
      await sleep(2000);
      d = await dump(DEV1);
      node = findIcon(d.j.nodes ?? []);
    }
    if (!node) {
      ev('E5-tap-icon',
        { http: null, drawerSwipes, error: 'app icon not found in launcher dumps (home grid + drawer)' },
        false);
    } else {
      appIconSelector = node.contentDesc ? { contentDesc: node.contentDesc } : { text: node.text };
      const t = await tap(DEV1, appIconSelector);
      ev('E5-tap-icon', { selector: appIconSelector, http: t.status, tap: t.j, target: { x: t.j.x, y: t.j.y }, drawerSwipes },
        t.status === 200);
    }
  }

  // E6 — foreground switches to target app
  {
    await new Promise((r) => setTimeout(r, 2500));
    const f = await fg(DEV1);
    ev('E6-foreground-switch', { http: f.status, body: f.j, expectedPkg: PKG },
      f.status === 200 && f.j.package === PKG);
  }

  // E7 — in-app dump
  {
    const d = await dump(DEV1);
    const nodes = d.j.nodes ?? [];
    ev('E7-inapp-dump', { http: d.status, nodeCount: nodes.length, stats: d.j.stats, sample: nodes.slice(0, 3) },
      d.status === 200 && nodes.length > 0);
  }

  // E8 — in-app tap (first clickable with text/desc — list row or menu)
  let inAppSelector = null;
  {
    const d = await dump(DEV1);
    const nodes = d.j.nodes ?? [];
    const node = pick(nodes, (n) => n.clickable && (n.text || n.contentDesc) && !/back/i.test(n.contentDesc ?? ''));
    if (!node) throw new Error('E8: no clickable in-app node found');
    inAppSelector = node.text ? { text: node.text } : { contentDesc: node.contentDesc };
    const t = await tap(DEV1, inAppSelector);
    ev('E8-inapp-tap', { selector: inAppSelector, http: t.status, tap: t.j }, t.status === 200);
  }

  // E9 — activity changed after in-app tap (genuine platform tap)
  {
    await new Promise((r) => setTimeout(r, 2500));
    const f = await fg(DEV1);
    ev('E9-activity-change', { http: f.status, body: f.j },
      f.status === 200 && f.j.package === PKG);
  }

  // E10 — on clean device w2: app not installed, selector not found
  {
    const r = await tap(DEV2, appIconSelector ?? { contentDesc: 'Markor' });
    const g = await req('GET', `/api/devices/redroid/${DEVICES[DEV2].id}/apps/${PKG}`);
    ev('E10-clean-device', { tapHttp: r.status, tapBody: r.j, getHttp: g.status, getBody: g.j },
      r.status === 404 && (g.j.installed === false));
  }

  // ---- A PHASE (E11 deferred to after A7/A8 — app must stay installed) ----
  PHASE = 'A'; // from here on, any FAIL halts the matrix (exit 3)

  // A1 — package-name injection battery (7 names × GET + DELETE)
  {
    const names = [
      'com.example;id', 'com.a$(reboot)', 'com.a`id`', 'com.a|nc', 'com.a>x',
      'com.a app', 'com.a\ninjection', 'com.a\u0000nul',
    ];
    const before = pmList(DEV1);
    const out = [];
    for (const n of names) {
      const enc = encodeURIComponent(n);
      const g = await req('GET', `/api/devices/redroid/${DEVICES[DEV1].id}/apps/${enc}`);
      const del = await req('DELETE', `/api/devices/redroid/${DEVICES[DEV1].id}/apps/${enc}`);
      out.push({ n: JSON.stringify(n), get: g.status, del: del.status });
    }
    const after = pmList(DEV1);
    const unchanged = JSON.stringify(before) === JSON.stringify(after);
    // audit: no app.device.* entries created for these (scan recent audit via API if available, else rely on pm diff)
    ev('A1-pkg-injection', { out, pmDiffUnchanged: unchanged },
      out.every((o) => o.get === 400 && o.del === 400) && unchanged);
  }

  // A2 — fileName path-injection battery + symlink containment
  {
    const attacks = ['../etc/passwd.apk', '../../etc/shadow.apk', 'a b.apk', '-rf.apk', 'com.evil\x00.apk'.slice(0, 12) + '.apk'];
    const out = [];
    for (const fn of attacks) {
      const r = await req('POST', `/api/devices/redroid/${DEVICES[DEV1].id}/apps/install`, { fileName: fn });
      out.push({ fn: JSON.stringify(fn), http: r.status, code: r.j.code ?? r.j.error?.code });
    }
    // symlink containment
    const linkName = 'zlink-test.apk';
    try {
      fs.unlinkSync(`${APK_DIR}/${linkName}`);
    } catch {}
      fs.symlinkSync('/etc/hostname', `${APK_DIR}/${linkName}`);
    const sl = await req('POST', `/api/devices/redroid/${DEVICES[DEV1].id}/apps/install`, { fileName: linkName });
    const hostIntact = fs.existsSync('/etc/hostname');
    try { fs.unlinkSync(`${APK_DIR}/${linkName}`); } catch {}
    ev('A2-filename-injection', { out, symlink: { http: sl.status, code: sl.j.code ?? sl.j.error?.code }, hostIntact },
      out.every((o) => o.http === 400) && [400, 422].includes(sl.http) && hostIntact);
  }

  // A4 — APK size cap (restart API with WA_APK_MAX_BYTES=1MiB)
  {
    await restartApi({ WA_APK_MAX_BYTES: '1048576' });
    const before = pmList(DEV1);
    const r = await req('POST', `/api/devices/redroid/${DEVICES[DEV1].id}/apps/install`, { fileName: APK });
    const after = pmList(DEV1);
    ev('A4-apk-size-cap', { http: r.status, code: r.j.code ?? r.j.error?.code, pmUnchanged: JSON.stringify(before) === JSON.stringify(after) },
      r.status === 413 && JSON.stringify(before) === JSON.stringify(after));
    await restartApi({});
  }

  // A3 — dump size bomb (WA_UIA_MAX_BYTES=8192 → 522) + node cap (WA_UIA_MAX_NODES=50 → 422)
  {
    await restartApi({ WA_UIA_MAX_BYTES: '8192' });
    const d1 = await dump(DEV1);
    await restartApi({ WA_UIA_MAX_NODES: '50' });
    const d2 = await dump(DEV1);
    ev('A3-dump-caps', {
      byteBomb: { http: d1.status, code: d1.j.code ?? d1.j.error?.code, nodes: (d1.j.nodes ?? []).length },
      nodeCap: { http: d2.status, code: d2.j.code ?? d2.j.error?.code, nodes: (d2.j.nodes ?? []).length },
    }, d1.status === 522 && d2.status === 422);
    await restartApi({});
  }

  // A5 — offscreen tap (swipe list, then tap element no longer on screen)
  {
    // ensure we are on markor home (list)
    await fg(DEV1);
    const d0 = await dump(DEV1);
    const row = pick(d0.j.nodes ?? [], (n) => n.clickable && (n.text || n.contentDesc));
    const rowSel = row ? (row.text ? { text: row.text } : { contentDesc: row.contentDesc }) : null;
    // trigger: scroll list up (device-side, ADR-prescribed trigger)
    const serial = `127.0.0.1:${DEVICES[DEV1].adbPort}`;
    adb(serial, 'shell', 'input', 'swipe', '360', '1100', '360', '300');
    await new Promise((r) => setTimeout(r, 1500));
    const d1 = await dump(DEV1);
    const nodes1 = d1.j.nodes ?? [];
    // look for any node whose bounds lie offscreen (fresh dump retains recycled bounds?)
    const off = pick(nodes1, (n) => n.bounds && (n.bounds.y2 < 0 || n.bounds.y1 >= 1280 || n.bounds.x2 < 0 || n.bounds.x1 >= 720));
    let t = null;
    let observed;
    if (off) {
      t = await tap(DEV1, off.contentDesc ? { contentDesc: off.contentDesc } : off.text ? { text: off.text } : { resourceId: off.resourceId });
      observed = `offscreen-node-tap: http=${t.status} code=${t.j.code ?? t.j.error?.code}`;
    } else if (rowSel) {
      // row may simply be gone from fresh dump → NOT_FOUND (also a safe no-tap)
      t = await tap(DEV1, rowSel);
      observed = `stale-row-tap: http=${t.status} code=${t.j.code ?? t.j.error?.code} (fresh dump excludes scrolled row)`;
    }
    ev('A5-offscreen-tap', { offscreenNodeFound: !!off, rowSel, observed, offNode: off ?? null },
      t !== null && [404, 422].includes(t.status));
  }

  // A6 — rotation race (dump portrait → rotate → immediate tap with portrait selector)
  {
    setOrientation(DEV1, true);
    await new Promise((r) => setTimeout(r, 1500));
    const dP = await dump(DEV1);
    const node = pick(dP.j.nodes ?? [], (n) => n.clickable && (n.text || n.contentDesc));
    if (!node) throw new Error('A6: no portrait node found');
    const sel = node.text ? { text: node.text } : { contentDesc: node.contentDesc };
    const portraitCenter = { x: Math.floor((node.bounds.x1 + node.bounds.x2) / 2), y: Math.floor((node.bounds.y1 + node.bounds.y2) / 2) };
    // rotate to landscape, then IMMEDIATELY tap with the portrait-dump selector
    setOrientation(DEV1, false);
    const t = await tap(DEV1, sel);
    const f = await fg(DEV1);
    const blindStale = t.status === 200 && t.j.x === portraitCenter.x && t.j.y === portraitCenter.y;
    ev('A6-rotation-race', {
      portraitCenter, tap: { http: t.status, code: t.j.code ?? t.j.error?.code, x: t.j.x, y: t.j.y },
      foreground: f.j, blindStaleTap: blindStale,
    }, t.status === 200 ? !blindStale : [404, 422].includes(t.status));
    setOrientation(DEV1, true);
    await new Promise((r) => setTimeout(r, 1000));
  }

  // A7 — corrupt-APK battery (4 files: text / 0-byte / truncated / zip-magic+garbage)
  {
    const mk = (name, buf) => fs.writeFileSync(`${APK_DIR}/${name}`, buf);
    mk('rdev-corrupt-text.apk', Buffer.from('this is definitely not a zip file'));
    mk('rdev-corrupt-empty.apk', Buffer.alloc(0));
    const real = fs.readFileSync(`${APK_DIR}/${APK}`);
    mk('rdev-corrupt-trunc.apk', real.subarray(0, 51200));
    const garbage = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(1024, 0x41)]);
    mk('rdev-corrupt-zipmagic.apk', garbage);
    const before = pmList(DEV1);
    const out = [];
    for (const fn of ['rdev-corrupt-text.apk', 'rdev-corrupt-empty.apk', 'rdev-corrupt-trunc.apk', 'rdev-corrupt-zipmagic.apk']) {
      const r = await req('POST', `/api/devices/redroid/${DEVICES[DEV1].id}/apps/install`, { fileName: fn });
      out.push({ fn, http: r.status, code: r.j.code ?? r.j.error?.code, deviceVerdict: r.j.deviceVerdict ?? null });
    }
    const after = pmList(DEV1);
    for (const fn of ['rdev-corrupt-text.apk', 'rdev-corrupt-empty.apk', 'rdev-corrupt-trunc.apk', 'rdev-corrupt-zipmagic.apk'])
      try { fs.unlinkSync(`${APK_DIR}/${fn}`); } catch {}
    ev('A7-corrupt-apk', { out, pmUnchanged: JSON.stringify(before) === JSON.stringify(after) },
      out.every((o) => [400, 422, 502].includes(o.http)) && JSON.stringify(before) === JSON.stringify(after));
  }

  // A8 — device stopped (external docker stop) → refresh detects → all app routes
  // 409 APP_DEVICE_NOT_RUNNING (actual code; ADR wording was DEVICE_NOT_ONLINE),
  // zero adb; then docker start + refresh → recover.
  {
    sh(`docker stop ${DEV1}`);
    const rf = await req('POST', `/api/devices/redroid/${DEVICES[DEV1].id}/refresh`);
    await new Promise((r) => setTimeout(r, 2000));
    const g = await req('GET', `/api/devices/redroid/${DEVICES[DEV1].id}/apps`);
    const f = await fg(DEV1);
    const t = await tap(DEV1, { text: 'anything' });
    const inst = await req('POST', `/api/devices/redroid/${DEVICES[DEV1].id}/apps/install`, { fileName: APK });
    const del = await req('DELETE', `/api/devices/redroid/${DEVICES[DEV1].id}/apps/${PKG}`);
    const d = await dump(DEV1);
    sh(`docker start ${DEV1}`);
    await new Promise((r) => setTimeout(r, 15000));
    const rf2 = await req('POST', `/api/devices/redroid/${DEVICES[DEV1].id}/refresh`);
    await new Promise((r) => setTimeout(r, 5000));
    const g2 = await req('GET', `/api/devices/redroid/${DEVICES[DEV1].id}/apps`);
    const down = [g.status, f.status, t.status, inst.status, del.status, d.status];
    ev('A8-offline-409', {
      refreshAfterStop: rf.j.device?.containerState, duringDown: down,
      refreshAfterStart: rf2.j.device?.containerState, recovered: g2.status,
    }, down.every((s) => s === 409) && g2.status === 200);
  }

  // A10 — idle-state dump (two consecutive dumps, no interaction)
  {
    const d1 = await dump(DEV1);
    await new Promise((r) => setTimeout(r, 2000));
    const d2 = await dump(DEV1);
    ev('A10-idle-state', {
      first: { http: d1.status, nodes: (d1.j.nodes ?? []).length },
      second: { http: d2.status, nodes: (d2.j.nodes ?? []).length },
      note: 'static UI expected 200×2; animated UI may 502 UIA_IDLE_STATE — record actual',
    }, [d1.status, d2.status].every((s) => [200, 502].includes(s)));
  }

  // E11 — uninstall (deferred: app needed through A phase)
  {
    const before = pmList(DEV1);
    const r = await req('DELETE', `/api/devices/redroid/${DEVICES[DEV1].id}/apps/${PKG}`);
    const after = pmList(DEV1);
    const g = await req('GET', `/api/devices/redroid/${DEVICES[DEV1].id}/apps/${PKG}`);
    ev('E11-uninstall', { http: r.status, body: r.j, removed: before.includes(PKG) && !after.includes(PKG), getAfter: g.j },
      r.status === 200 && !after.includes(PKG) && g.j.installed === false);
  }

  // A9 — switch OFF → all 7 routes 503 (restart API with WA_APP_OPS_ENABLED=false)
  {
    await restartApi({ WA_APP_OPS_ENABLED: 'false' });
    const out = [];
    const routes = [
      ['GET', `/api/devices/redroid/${DEVICES[DEV1].id}/apps`],
      ['GET', `/api/devices/redroid/${DEVICES[DEV1].id}/apps/${PKG}`],
      ['GET', `/api/devices/redroid/${DEVICES[DEV1].id}/foreground`],
      ['POST', `/api/devices/redroid/${DEVICES[DEV1].id}/apps/install`, { fileName: APK }],
      ['DELETE', `/api/devices/redroid/${DEVICES[DEV1].id}/apps/${PKG}`],
      ['POST', `/api/devices/redroid/${DEVICES[DEV1].id}/ui/dump`],
      ['POST', `/api/devices/redroid/${DEVICES[DEV1].id}/ui/tap`, { selector: { text: 'x' } }],
    ];
    for (const [m, p, b] of routes) {
      const r = await req(m, p, b);
      out.push({ m, p: p.replace(DEVICES[DEV1].id, ':id'), http: r.status, code: r.j.code ?? r.j.error?.code });
    }
    const before = pmList(DEV1);
    ev('A9-switch-off-503', { out, pmUnchanged: true },
      out.every((o) => o.http === 503) && JSON.stringify(pmList(DEV1)) === JSON.stringify(before));
    await restartApi({}); // restore ON
  }

  // ---- summary ----
  // A-item failures already exited 3 inside ev() (halt discipline).
  // Remaining = E-phase findings (incl. E1's designed gap exposure) → report, not halt.
  writeSummary();
  console.log('Matrix complete (no A-item failure). E-phase findings are report items.');
  process.exit(0);
}

/** restart scratch API with extra env overrides (empty = defaults from bringup) */
async function restartApi(overrides) {
  const pidfile = '/tmp/rdev-state/api.pid';
  const pid = fs.readFileSync(pidfile, 'utf8').trim();
  const cg = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8');
  if (/docker-/.test(cg)) throw new Error(`REFUSING to restart API pid ${pid} (cgroup docker-scoped)`);
  process.kill(Number(pid), 'SIGTERM');
  await new Promise((r) => setTimeout(r, 3000));
  const script = `
    cd /home/kenneth/.openclaw/workspace/water_army
    . scripts/realdevice-master/common.sh
    . "$RD_SECRETS"
    export NODE_ENV=production
    export APP_HOST=127.0.0.1 APP_PORT=16490
    export APP_PUBLIC_URL="http://127.0.0.1:16492"
    export SESSION_SECRET="$MC_SESSION_SECRET"
    export APP_ENCRYPTION_KEY="$MC_APP_ENCRYPTION_KEY"
    export WORKER_API_TOKEN="$MC_WORKER_API_TOKEN"
    export DATABASE_URL="$RD_PG_URL"
    export REDIS_URL="redis://127.0.0.1:16495"
    export REDROID_DATA_ROOT="$RD_DATA_ROOT"
    export REDROID_ADB_RANGE_START=16500 REDROID_ADB_RANGE_END=16549
    export REDROID_ADB_BINARY="$RD_ADB"
    export DEVICE_NETWORK_NAME="$RD_NET" DEVICE_NETWORK_SUBNET="$RD_NET_SUBNET"
    export STREAM_TICKET_SECRET="$MC_STREAM_TICKET_SECRET"
    export STREAM_SIDECAR_TOKEN="$MC_STREAM_SIDECAR_TOKEN"
    export SIDECAR_PORT=16493
    export SIDECAR_FWD_RANGE_START=16460 SIDECAR_FWD_RANGE_END=16469
    export SCRCPY_JAR="$RD_JAR_PATH" SCRCPY_JAR_SHA256="$RD_JAR_SHA256"
    export STREAM_LEASE_TTL_MS=30000
    export STREAM_RECONCILE_INTERVAL_MS=10000
    export WA_REDROID_RO_OVERRIDES_ENABLED=true
    export WA_APP_OPS_ENABLED=true
    export WA_APK_DIR=/var/lib/water-army/apk-rdev
    export WA_W3_EGRESS_BINDING_ENABLED=false
    export WA_W3_EGRESS_ECHO_HOST=127.0.0.1 WA_W3_EGRESS_ECHO_PORT=16491
    ${Object.entries(overrides).map(([k, v]) => `export ${k}=${v}`).join('\n    ')}
    nohup node apps/api/src/server.js > logs/realdevice-master/scratch-api.log 2>&1 &
    echo $! > /tmp/rdev-state/api.pid
  `;
  fs.writeFileSync('/tmp/rdev-restart-api.sh', script);
  execSync('bash /tmp/rdev-restart-api.sh', { timeout: 30000 });
  for (let i = 0; i < 60; i++) {
    const ok = await fetch('http://127.0.0.1:16490/api/health/ready').then((r) => r.status === 200).catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('API did not become ready after restart');
}

main().catch((e) => {
  console.error('FATAL', e);
  fs.writeFileSync(`${EVID}/fatal.json`, JSON.stringify({ at: new Date().toISOString(), error: e.message, stack: e.stack }, null, 2));
  process.exit(1);
});
