/**
 * W1 V5 — 3x recreate stability on identity a1 (isolated from the main
 * matrix run: the matrix process carried the pre-fix wait loop).
 *
 * V5 (ADR-025): same identity, 3 consecutive delete+recreate cycles; the
 * full getprop set must be byte-identical across rounds (deterministic
 * profile -> deterministic carrier injection). dataDir persists (recreate
 * = container-level, warm boot — cold-boot variance is a boot-timing
 * concern, not a fingerprint-stability concern).
 *
 * Wait loop carries the OPERATOR-CONNECT fix (product finding #2: no
 * platform path connects a fresh serial for no-proxy devices).
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const API = process.env.RD_API ?? 'http://127.0.0.1:16490';
const ADB = process.env.RD_ADB ?? `${process.env.HOME}/.local/share/platform-tools/adb`;
const EVID = '/home/kenneth/.openclaw/workspace/water_army/logs/realdevice-master/w1';
const TEMPLATE = 'rdev-base';
const NAME = 'redroid-rdev-a1';
const A1 = 'c9f1c001-0000-4000-8000-0000000000a1';
const ROUNDS = 3;
const BUDGET_MS = 25 * 60 * 1000;

fs.mkdirSync(EVID, { recursive: true });
const say = (m) => console.log(`[w1v5 ${new Date().toISOString()}] ${m}`);
const ev = (name, obj) => { const p = `${EVID}/${name}`; fs.writeFileSync(p, JSON.stringify(obj, null, 2)); say(`evidence -> ${p}`); };
const sh = (cmd, timeout = 60000) => execSync(cmd, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
const shSoft = (cmd, timeout = 60000) => { try { return sh(cmd, timeout); } catch (e) { return `[rc=${e.status}] ${String(e.stdout || '').trim()}`; } };
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

async function main() {
  const login = await req('POST', '/api/auth/login', { username: 'rdev-admin', password: 'rdev-e2e-admin-pw' });
  if (login.status !== 200) throw new Error(`login ${login.status}`);

  // deterministic profile for a1 (canonical)
  const ens = await req('POST', `/api/identities/${A1}/fingerprint`);
  if (ens.status !== 200) throw new Error(`ensure a1 profile ${ens.status}`);
  const raw = ens.j.profile;
  const P = raw && raw.profile ? raw.profile : raw;

  // round 0: clean slate (delete whatever a1 currently is)
  {
    const list = await req('GET', '/api/devices/redroid');
    const ex = (list.j.devices ?? []).find((d) => d.name === NAME);
    if (ex) {
      const del = await req('DELETE', `/api/devices/redroid/${ex.id}`, { confirm: NAME, removeData: false });
      say(`round0: existing a1 deleted (${del.status}) — dataDir kept`);
    }
  }

  const CARRIERS = {
    'ro.boot.wa_ro_product_brand': 'brand',
    'ro.boot.wa_ro_product_manufacturer': 'manufacturer',
    'ro.boot.wa_ro_product_model': 'model',
    'ro.boot.wa_ro_product_device': 'device',
    'ro.boot.wa_ro_product_name': 'productName',
    'ro.boot.wa_ro_build_id': 'buildId',
    'ro.boot.wa_ro_build_display_id': 'displayId',
    'ro.boot.wa_ro_build_fingerprint': 'fingerprint',
    'ro.boot.wa_ro_serialno': 'serial',
  };
  const RO_KEYS = ['ro.build.id', 'ro.build.display.id', 'ro.build.fingerprint', 'ro.serialno', 'ro.product.model', 'ro.product.brand'];

  async function waitOnline(devId, label) {
    const t0 = Date.now();
    let lastAction = 0;
    while (Date.now() - t0 < BUDGET_MS) {
      const list = await req('GET', '/api/devices/redroid');
      const d = (list.j.devices ?? []).find((x) => x.id === devId);
      if (d && d.containerState === 'running' && d.adbState === 'online') return { d, waitedMs: Date.now() - t0 };
      if (d && d.containerState === 'running' && d.adbState !== 'online' && Date.now() - lastAction > 30000) {
        lastAction = Date.now();
        shSoft(`${ADB} connect 127.0.0.1:${d.adbPort} 2>&1`, 30000); // operator surface (finding #2)
        await req('POST', `/api/devices/redroid/${devId}/refresh`);   // persist path
      }
      await sleep(5000);
    }
    throw new Error(`${label}: not online within ${BUDGET_MS / 60000}min`);
  }

  const rounds = [];
  for (let r = 1; r <= ROUNDS; r++) {
    const cr = await req('POST', '/api/devices/redroid', {
      name: NAME, templateName: TEMPLATE, identityId: A1,
      idempotencyKey: `rdev-w1v5-r${r}-${Date.now().toString(36)}`,
    });
    if (cr.status !== 200 && cr.status !== 201) throw new Error(`round ${r} create -> ${cr.status} ${JSON.stringify(cr.j).slice(0, 300)}`);
    say(`round ${r}: created (id=${cr.j.device?.id} port=${cr.j.device?.adbPort}) — waiting online`);
    const { d, waitedMs } = await waitOnline(cr.j.device.id, `round ${r}`);
    const serial = `127.0.0.1:${d.adbPort}`;
    const g = (prop) => shSoft(`${ADB} -s ${serial} shell getprop ${prop} 2>/dev/null`).trim();
    const sample = { tOnlineMs: waitedMs, adbPort: d.adbPort, containerId: d.containerId, carrier: {}, ro: {} };
    for (const [prop, field] of Object.entries(CARRIERS)) {
      sample.carrier[prop] = { expected: P[field], actual: g(prop), pass: g(prop) === P[field] };
    }
    for (const k of RO_KEYS) sample.ro[k] = g(k);
    rounds.push({ round: r, device: { id: d.id, containerId: d.containerId, adbPort: d.adbPort }, sample });
    ev(`w1-v5-round${r}.json`, rounds[r - 1]);
    say(`round ${r}: online in ${waitedMs}ms, carrier pass=${sample.carrier[Object.keys(CARRIERS)[0]]?.pass}`);
    // recreate (except after the final round — device stays up for teardown to collect)
    if (r < ROUNDS) {
      const del = await req('DELETE', `/api/devices/redroid/${d.id}`, { confirm: NAME, removeData: false });
      say(`round ${r}: deleted (${del.status}) — next round`);
    }
  }

  // stability: byte-identical across rounds (carrier + ro.*)
  const keys = Object.keys(CARRIERS);
  const carrierStable = keys.every((k) => rounds[0].sample.carrier[k].actual === rounds[1].sample.carrier[k].actual
    && rounds[1].sample.carrier[k].actual === rounds[2].sample.carrier[k].actual);
  const carrierAllCorrect = rounds.every((r) => keys.every((k) => r.sample.carrier[k].pass === true));
  const roStable = RO_KEYS.every((k) => rounds[0].sample.ro[k] === rounds[1].sample.ro[k] && rounds[1].sample.ro[k] === rounds[2].sample.ro[k]);
  const summary = {
    v5: {
      pass: carrierStable && carrierAllCorrect && roStable,
      carrierByteIdenticalAcrossRounds: carrierStable,
      carrierMatchesProfileEveryRound: carrierAllCorrect,
      roValuesStable: roStable,
      onlineTimesMs: rounds.map((r) => r.sample.tOnlineMs),
      note: 'ro.* stability only proves constancy of the STOCK values (no mapping on stock image — probe finding); the fingerprint-stability claim rides on the carrier (ro.boot.wa_*) set',
    },
  };
  ev('w1-v5-summary.json', summary);
  say(`V5 DONE: pass=${summary.v5.pass} carrierStable=${carrierStable} carrierCorrect=${carrierAllCorrect} roStable=${roStable}`);
  process.exit(0);
}

main().catch((e) => {
  say(`FATAL: ${e?.stack ?? e}`);
  ev('w1-v5-fatal.json', { at: new Date().toISOString(), error: String(e?.message ?? e) });
  process.exit(1);
});
