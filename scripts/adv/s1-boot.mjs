/**
 * WA-ADVERSARIAL-FINAL s1 — boot the 4+2 stealth fleet via PRODUCT API only.
 *
 *  - RAM discipline: BEFORE each create, read MemAvailable (MiB) and the
 *    product RAM-gate state (GET /api/system/ram-gate/state); refuse to create
 *    when the gate view denies or MemAvailable < hardFloor (4096) — never force.
 *  - One device at a time (boot ~115-125s per MTG measurement).
 *  - adb online wait follows nv5b-bootstrap semantics (connect + refresh poll).
 *  - Every raw create response lands in EVID dir (no inference, receipts only).
 *
 * Usage: node scripts/adv/s1-boot.mjs [--only a1,a2]
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const API = 'http://127.0.0.1:3012';
const ADB = `${process.env.HOME}/.local/share/platform-tools/adb`;
const TOKEN = fs.readFileSync('/tmp/adv-session-token', 'utf8').trim();
const TEMPLATE = 'adv-stealth';
const EVID = process.env.ADV_EVID ?? '/home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/s1-env';
const STATE = '/tmp/adv-s1-state.json';
const HARD_FLOOR_MIB = 4096;
const BOOT_BUDGET_MS = 20 * 60_000;
const RECREATE = process.env.RECREATE === '1';

// name → identity mapping is injected from DB by the caller via STATE file
// (bash psql seeds it before first run) OR passed via --ids JSON.
const DEVICES = [
  ['redroid-rdev-adv-a1', 'a1', { width: 1080, height: 2400, dpi: 400, fps: 60 }, 'socks5://172.38.223.1:18443'],
  ['redroid-rdev-adv-a2', 'a2', { width: 1080, height: 2340, dpi: 395, fps: 90 }, 'socks5://172.38.223.1:18443'],
  ['redroid-rdev-adv-a3', 'a3', { width: 1080, height: 2400, dpi: 420, fps: 120 }, 'socks5://172.38.223.1:18443'],
  ['redroid-rdev-adv-a4', 'a4', { width: 1080, height: 2400, dpi: 420, fps: 120 }, 'socks5://172.38.223.1:18443'],
  ['redroid-rdev-adv-b1', 'b1', { width: 1080, height: 2340, dpi: 395, fps: 90 }, 'socks5://172.38.223.1:18444'],
  ['redroid-rdev-adv-b2', 'b2', { width: 1080, height: 2400, dpi: 420, fps: 120 }, 'socks5://172.38.223.1:18444'],
];

const say = (m) => console.log(`[adv-boot ${new Date().toISOString()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = `session=${TOKEN}`;

async function req(method, p, body) {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}
const sh = (cmd, timeout = 60000) => execSync(cmd, { encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();

function memAvailableMiB() {
  const kb = Number(sh("awk '/MemAvailable/{print $2}' /proc/meminfo").trim());
  if (!Number.isFinite(kb) || kb <= 0) throw new Error(`cannot read MemAvailable (got ${kb})`);
  return Math.floor(kb / 1024);
}

async function ramGateView() {
  const { status, j } = await req('GET', '/api/system/ram-gate');
  if (status !== 200) throw new Error(`ram-gate state HTTP ${status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

async function waitOnline(dev, port) {
  const t0 = Date.now();
  let lastConnect = 0;
  while (Date.now() - t0 < BOOT_BUDGET_MS) {
    const { j } = await req('GET', '/api/devices/redroid');
    const d = (j.devices ?? []).find((x) => x.name === dev);
    if (!d) throw new Error(`${dev}: vanished from device list`);
    // product adbState probe is ADB_UNAVAILABLE in this stack (api container has
    // no /usr/bin/adb — KNOWN ENV DEFECT, all historical rows adb_state=unknown),
    // so host adb get-state is the authority here.
    if (d.containerState === 'running') {
      const ap = d.adbPort ?? port;
      try { sh(`${ADB} connect 127.0.0.1:${ap} 2>&1`, 30000); } catch { /* best effort */ }
      try {
        if (sh(`${ADB} -s 127.0.0.1:${ap} get-state 2>&1`, 15000).trim() === 'device') {
          return { ...d, adbState: 'online(host-adb)' };
        }
      } catch { /* not yet */ }
    }
    await sleep(5000);
  }
  throw new Error(`${dev}: not adb-online within ${BOOT_BUDGET_MS / 60000}min`);
}

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { devices: {} };
const idsFile = process.env.ADV_IDS; // {a1: uuid, ...}
if (!idsFile) throw new Error('ADV_IDS env required ({a1:uuid,...} json from DB)');
const IDS = JSON.parse(fs.readFileSync(idsFile, 'utf8'));
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').replace('--only=', '').split(',').filter(Boolean);

fs.mkdirSync(EVID, { recursive: true });

for (const [name, key, overrides, proxyUrl] of DEVICES) {
  if (only.length && !only.includes(key)) continue;
  if (state.devices[key]?.online && !RECREATE) { say(`${key}: already online (skip)`); continue; }
  const mem = memAvailableMiB();
  if (mem < HARD_FLOOR_MIB) { say(`RAM REDLINE: MemAvailable=${mem}MiB < ${HARD_FLOOR_MIB} — STOP before ${key}`); break; }
  const gate = await ramGateView();
  say(`${key}: MemAvailable=${mem}MiB gate=${JSON.stringify(gate.admit ?? gate).slice(0, 140)}`);
  // If a previous run already created the device (crash/loop restart), adopt it.
  const existingList = await req('GET', '/api/devices/redroid');
  const already = (existingList.j.devices ?? []).find((x) => x.name === name);
  const devId = already?.id ?? null;
  const body = { name, templateName: TEMPLATE, idempotencyKey: `adv-${key}-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 14)}`, identityId: IDS[key], overrides, proxyUrl };
  const t0 = Date.now();
  let status = 200; let j = { device: already };
  if (!already) {
    ({ status, j } = await req('POST', '/api/devices/redroid', body));
    fs.writeFileSync(`${EVID}/create-${key}.json`, JSON.stringify({ status, body, response: j }, null, 1));
    if (status !== 201 && status !== 200) { say(`${key}: create HTTP ${status} — ${JSON.stringify(j).slice(0, 300)}`); break; }
  } else {
    fs.writeFileSync(`${EVID}/create-${key}.json`, JSON.stringify({ status: 'adopted-existing', body, response: already }, null, 1));
    say(`${key}: adopting existing device ${devId}`);
  }
  const online = await waitOnline(name, j.device?.adbPort ?? already?.adbPort);
  state.devices[key] = { name, id: devId ?? j.device?.id, adbPort: online.adbPort, containerState: online.containerState, adbState: online.adbState, waitedSec: Math.round((Date.now() - t0) / 1000) };
  fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
  say(`${key}: ONLINE (adb ${online.adbPort}, ${state.devices[key].waitedSec}s)`);
}

fs.writeFileSync(`${EVID}/boot-summary.txt`, Object.entries(state.devices).map(([k, v]) => `${k}\t${v.name}\tid=${v.id}\tadb=127.0.0.1:${v.adbPort}\t${v.containerState}/${v.adbState}\tbootSec=${v.waitedSec}`).join('\n') + '\n');
say('done');
