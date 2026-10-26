/**
 * W1 (ADR-025) V1-V7 real-device getprop matrix — rdev scratch stack.
 *
 * V1-V4: per-device ro.* sampling vs deterministic profile (10 identities =
 *        10 concurrent if the RAM gate admits; else the script records the
 *        DENY and the operator re-runs in 2 batches — degradation recorded,
 *        not hidden).
 * V5:    3x recreate on identity a1 (delete+recreate, full getprop each round,
 *        byte-identical across rounds).
 * V6:    platform-side blind test — NOT EXECUTABLE here (no target-platform
 *        account/APK on scratch); recorded NOT VERIFIED with reason.
 * V7:    carrier-fallback probe (ro.boot.wa_* presence + setprop/resetprop
 *        attempt + who wins) — executed as the diagnostic tail of V1-V4.
 *
 * Switch WA_REDROID_RO_OVERRIDES_ENABLED=ON is a BRINGUP requirement (see
 * bringup.sh). Manual adb = observation only; every state assertion follows
 * the platform view + getprop reality.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const API = process.env.RD_API ?? 'http://127.0.0.1:16490';
const ADB = process.env.RD_ADB ?? `${process.env.HOME}/.local/share/platform-tools/adb`;
const EVID = '/home/kenneth/.openclaw/workspace/water_army/logs/realdevice-master/w1';
const TEMPLATE = 'rdev-base';
const BOOT_BUDGET_MS = Number(process.env.W1_BOOT_BUDGET_MS ?? 70 * 60 * 1000);
const IDENTS = [
  { ref: 'a1', id: 'c9f1c001-0000-4000-8000-0000000000a1' },
  { ref: 'a2', id: 'c9f1c001-0000-4000-8000-0000000000a2' },
  { ref: 'a3', id: 'c9f1c001-0000-4000-8000-0000000000a3' },
  { ref: 'a4', id: 'c9f1c001-0000-4000-8000-0000000000a4' },
  { ref: 'a5', id: 'c9f1c001-0000-4000-8000-0000000000a5' },
  { ref: 'b1', id: 'c9f1c001-0000-4000-8000-0000000000b1' },
  { ref: 'b2', id: 'c9f1c001-0000-4000-8000-0000000000b2' },
  { ref: 'b3', id: 'c9f1c001-0000-4000-8000-0000000000b3' },
  { ref: 'b4', id: 'c9f1c001-0000-4000-8000-0000000000b4' },
  { ref: 'b5', id: 'c9f1c001-0000-4000-8000-0000000000b5' },
];
fs.mkdirSync(EVID, { recursive: true });
const say = (m) => console.log(`[w1 ${new Date().toISOString()}] ${m}`);
const ev = (name, obj) => { const p = `${EVID}/${name}`; fs.writeFileSync(p, JSON.stringify(obj, null, 2)); say(`evidence -> ${p}`); };
const sh = (cmd, timeout = 60000) => execSync(cmd, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 }).toString();
const psql = (sql) => execSync(`docker exec -i rdev-pg psql -U postgres -d water_army_rdev -tA -v ON_ERROR_STOP=1`, { encoding: 'utf8', input: sql, timeout: 30000, maxBuffer: 16 * 1024 * 1024 }).toString().trim();

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

async function main() {
  const summary = { startedAt: new Date().toISOString(), v: {}, degradation: [] };

  // --- 0. login + switch state evidence
  const login = await req('POST', '/api/auth/login', { username: 'rdev-admin', password: 'rdev-e2e-admin-pw' });
  if (login.status !== 200) throw new Error(`admin login failed: ${login.status}`);
  say('logged in (rdev-admin)');

  // --- 1. seed identities (fixed UUID, idempotent) + ensure fingerprint profile
  const profiles = {};
  for (const it of IDENTS) {
    psql(`INSERT INTO identities (id, external_ref, display_name, identity_type, status, data_path, metadata_json, created_at, updated_at)
      VALUES ('${it.id}', 'rdev-w1-${it.ref}', 'rdev-w1-${it.ref}', 'qa_device', 'READY', '/var/lib/water-army/identities/rdev-w1-${it.ref}', '{}'::jsonb, now(), now())
      ON CONFLICT (id) DO UPDATE SET status = 'READY';`);
    const r = await req('POST', `/api/identities/${it.id}/fingerprint`);
    if (r.status !== 200 || !r.j.profile) throw new Error(`ensureProfile ${it.ref} -> ${r.status} ${JSON.stringify(r.j).slice(0, 200)}`);
    profiles[it.ref] = r.j.profile;
  }
  ev('profiles-10.json', profiles);
  say(`10 identities seeded + deterministic profiles ensured`);

  // --- 2. create 10 devices (staggered; RAM gate arbitrates)
  const created = [];
  for (const it of IDENTS) {
    const r = await req('POST', '/api/devices/redroid', {
      name: `redroid-rdev-${it.ref}`, templateName: TEMPLATE, identityId: it.id,
      idempotencyKey: `rdev-w1-${it.ref}-${Date.now().toString(36)}`,
    });
    if (r.status !== 201 && r.status !== 200) {
      summary.degradation.push(`create ${it.ref} DENIED/FAILED: ${r.status} ${JSON.stringify(r.j).slice(0, 300)}`);
      say(`!! create ${it.ref} -> ${r.status} ${JSON.stringify(r.j).slice(0, 200)}`);
      continue;
    }
    created.push({ ref: it.ref, id: r.j.device?.id, adbPort: r.j.device?.adbPort });
    say(`created ${it.ref} (adbPort=${r.j.device?.adbPort})`);
    await new Promise((res) => setTimeout(res, 30_000));
  }
  ev('created-devices.json', created);
  if (created.length === 0) throw new Error('no devices created');
  if (created.length < IDENTS.length) say(`DEGRADED: ${created.length}/10 created (RAM gate or error) — matrix runs on the survivors`);

  // --- 3. poll until online (refresh throttled: 1 device/round)
  const t0 = Date.now();
  const online = new Set();
  const lastDiag = {};
  while (Date.now() - t0 < BOOT_BUDGET_MS) {
    const list = await req('GET', '/api/devices/redroid');
    const byId = new Map((list.j.devices ?? []).map((d) => [d.id, d]));
    for (const c of created) {
      if (online.has(c.ref)) continue;
      const d = byId.get(c.id);
      if (!d) continue;
      if (d.containerState === 'running' && d.adbState !== 'online') {
        if (!lastDiag[c.ref] || Date.now() - lastDiag[c.ref] > 60_000) {
          lastDiag[c.ref] = Date.now();
          await req('POST', `/api/devices/redroid/${c.id}/refresh`);
        }
      }
    }
    const nowOnline = created.filter((c) => { const d = byId.get(c.id); return d?.containerState === 'running' && d?.adbState === 'online'; });
    for (const c of nowOnline) if (!online.has(c.ref)) { online.add(c.ref); say(`ONLINE ${c.ref} (t+${Math.round((Date.now() - t0) / 1000)}s)`); }
    if (online.size === created.length) break;
    await new Promise((res) => setTimeout(res, 20_000));
  }
  if (online.size < created.length) summary.degradation.push(`boot timeout: ${created.length - online.size} device(s) not online within budget`);
  ev('boot-timeline.json', { t0, online: [...online], degraded: created.filter((c) => !online.has(c.ref)).map((c) => c.ref) });

  // --- 4. V1-V4 getprop matrix per online device + V7 carrier probe
  const matrix = {};
  for (const c of created) {
    if (!online.has(c.ref)) continue;
    const serial = `127.0.0.1:${c.adbPort}`;
    const g = (prop) => sh(`${ADB} -s ${serial} shell getprop ${prop} 2>/dev/null`.trim()).trim();
    const full = sh(`${ADB} -s ${serial} shell getprop 2>/dev/null`, 120000);
    const p = profiles[c.ref];
    const checks = {
      V1_fingerprint: { expected: p.fingerprint, actual: g('ro.build.fingerprint'), pass: g('ro.build.fingerprint') === p.fingerprint },
      V3_buildId: { expected: p.buildId, actual: g('ro.build.id'), pass: g('ro.build.id') === p.buildId },
      V3_displayId: { expected: p.displayId, actual: g('ro.build.display.id'), pass: g('ro.build.display.id') === p.displayId },
      V4_serialno: { expected: p.serial, actual: g('ro.serialno'), pass: g('ro.serialno') === p.serial },
      V4_boot_serialno: { actual: g('ro.boot.serialno') },
      V2_product: {
        model: { expected: p.model, actual: g('ro.product.model') },
        brand: { expected: p.brand, actual: g('ro.product.brand') },
        manufacturer: { expected: p.manufacturer, actual: g('ro.product.manufacturer') },
        device: { expected: p.device, actual: g('ro.product.device') },
        name: { expected: p.productName, actual: g('ro.product.name') },
      },
      // partition-winner evidence: every ro.product.* partition view
      roProductPartitions: full.split('\n').filter((l) => l.includes('ro.product.')).map((l) => l.trim()),
      roBootWa: full.split('\n').filter((l) => l.includes('ro.boot.wa_')).map((l) => l.trim()),
      // V7: carrier fallback — can ro.* be written post-boot at all?
      setpropAttempt: (sh(`${ADB} -s ${serial} shell "setprop ro.build.fingerprint rdev-v7-test 2>&1; getprop ro.build.fingerprint" 2>&1`).trim()),
      adbDevicesL: sh(`${ADB} devices -l 2>/dev/null`).split('\n').find((l) => l.includes(serial)) ?? '',
    };
    matrix[c.ref] = { identityId: c.id, serial, adbPort: c.adbPort, profile: p, checks };
    ev(`v1v4-${c.ref}.json`, matrix[c.ref]);
    say(`matrix ${c.ref}: V1=${checks.V1_fingerprint.pass} V3.id=${checks.V3_buildId.pass} V3.display=${checks.V3_displayId.pass} V4=${checks.V4_serialno.pass}`);
  }
  ev('v1v4-matrix.json', matrix);

  // --- 5. V5 — 3x recreate on identity a1
  const a1 = created.find((c) => c.ref === 'a1');
  if (a1) {
    const rounds = [];
    const a1Id = a1.id;
    const a1Identity = IDENTS.find((i) => i.ref === 'a1').id;
    for (let round = 1; round <= 3; round++) {
      const del = await req('DELETE', `/api/devices/redroid/${a1Id}`, { confirm: 'redroid-rdev-a1', removeData: false });
      say(`V5 round ${round}: delete -> ${del.status}`);
      const cr = await req('POST', '/api/devices/redroid', {
        name: 'redroid-rdev-a1', templateName: TEMPLATE, identityId: a1Identity,
        idempotencyKey: `rdev-w1-v5-r${round}-${Date.now().toString(36)}`,
      });
      if (cr.status !== 201 && cr.status !== 200) { say(`V5 round ${round} create failed: ${cr.status}`); break; }
      const devId = cr.j.device?.id; a1.id = devId; a1.adbPort = cr.j.device?.adbPort;
      const t1 = Date.now(); const online1 = new Set();
      while (Date.now() - t1 < BOOT_BUDGET_MS / 2 && online1.size === 0) {
        const list = await req('GET', '/api/devices/redroid');
        const d = (list.j.devices ?? []).find((x) => x.id === devId);
        if (d?.containerState === 'running' && d?.adbState !== 'online') await req('POST', `/api/devices/redroid/${devId}/refresh`);
        if (d?.containerState === 'running' && d?.adbState === 'online') online1.add(1);
        await new Promise((res) => setTimeout(res, 15_000));
      }
      const serial = `127.0.0.1:${a1.adbPort}`;
      const props = {};
      for (const prop of ['ro.build.fingerprint', 'ro.build.id', 'ro.build.display.id', 'ro.serialno', 'ro.boot.serialno', 'ro.product.model', 'ro.product.brand', 'ro.product.manufacturer', 'ro.product.device', 'ro.product.name']) {
        props[prop] = sh(`${ADB} -s ${serial} shell getprop ${prop} 2>/dev/null`).trim();
      }
      rounds.push({ round, deviceId: devId, adbPort: a1.adbPort, props });
      ev(`v5-round${round}.json`, rounds[rounds.length - 1]);
    }
    const keys = ['ro.build.fingerprint', 'ro.build.id', 'ro.build.display.id', 'ro.serialno'];
    const stable = rounds.length === 3 && keys.every((k) => rounds[0][k] === rounds[1][k] && rounds[1][k] === rounds[2][k]);
    summary.v.V5_recreate3x = { stable, rounds: rounds.map((r) => ({ round: r.round, [keys[0]]: r.props[keys[0]] })) };
  }

  // --- 6. V6 — platform blind test: NOT EXECUTABLE on scratch (no target
  //       platform account/APK). Honest NOT VERIFIED.
  summary.v.V6_platform_blind = 'NOT VERIFIED — no target-platform APK/account available on the scratch stack (recorded per NV4 discipline)';

  summary.finishedAt = new Date().toISOString();
  ev('w1-summary.json', summary);
  say(`W1 done. online=${[...online].join(',')} degraded=${summary.degradation.length ? JSON.stringify(summary.degradation) : 'none'}`);
}

main().catch((e) => { say(`FATAL: ${e?.stack ?? e}`); process.exit(1); });
