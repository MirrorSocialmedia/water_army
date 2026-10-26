/**
 * NV5b bootstrap — create/adopt the 5 storm devices (redroid-rdev-n1..n5)
 * on template rdev-base (no identity: the storm tests stream lease/ticket
 * semantics, not fingerprints) and wait for adb online each.
 *
 * Idempotent: existing n-devices are adopted (delete+recreate only with
 * RECREATE=1). RAM redline checked before EACH create (task discipline).
 * Carries the operator-surface connect (product finding #2).
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const API = process.env.RD_API ?? 'http://127.0.0.1:16490';
const ADB = process.env.RD_ADB ?? `${process.env.HOME}/.local/share/platform-tools/adb`;
const TEMPLATE = 'rdev-base';
const DEVICES = ['redroid-rdev-n1', 'redroid-rdev-n2', 'redroid-rdev-n3', 'redroid-rdev-n4', 'redroid-rdev-n5'];
const RECREATE = process.env.RECREATE === '1';
const BUDGET_MS = 25 * 60 * 1000;

const say = (m) => console.log(`[nv5b-boot ${new Date().toISOString()}] ${m}`);
const shSoft = (cmd, timeout = 60000) => { try { return execSync(cmd, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).toString(); } catch (e) { return `[rc=${e.status}] ${String(e.stdout || '').trim()}`; } };
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

function ramOk() {
  const g = Number(shSoft('free -g | awk \'/^Mem:/{print $7}\'').trim());
  if (!Number.isFinite(g) || g < 16) throw new Error(`RAM REDLINE: MemAvailable=${g}G < 16G — STOP (task discipline)`);
  say(`RAM check: MemAvailable=${g}G OK`);
}

async function waitOnline(devId, port, name) {
  const t0 = Date.now();
  let lastAction = 0;
  while (Date.now() - t0 < BUDGET_MS) {
    const list = await req('GET', '/api/devices/redroid');
    const d = (list.j.devices ?? []).find((x) => x.id === devId);
    if (d && d.containerState === 'running' && d.adbState === 'online') return { d, waitedMs: Date.now() - t0 };
    if (d && d.containerState === 'running' && d.adbState !== 'online' && Date.now() - lastAction > 30000) {
      lastAction = Date.now();
      shSoft(`${ADB} connect 127.0.0.1:${d.adbPort} 2>&1`, 30000);
      await req('POST', `/api/devices/redroid/${devId}/refresh`);
    }
    await sleep(5000);
  }
  throw new Error(`${name}: not online within ${BUDGET_MS / 60000}min`);
}

const login = await req('POST', '/api/auth/login', { username: 'rdev-admin', password: 'rdev-e2e-admin-pw' });
if (login.status !== 200) throw new Error(`login ${login.status}`);

const list0 = await req('GET', '/api/devices/redroid');
const byName = new Map((list0.j.devices ?? []).map((d) => [d.name, d]));
const out = {};
for (const name of DEVICES) {
  let d = byName.get(name);
  if (RECREATE && d) {
    const del = await req('DELETE', `/api/devices/redroid/${d.id}`, { confirm: name, removeData: false });
    say(`${name}: deleted for RECREATE (${del.status})`);
    d = null;
  }
  if (d) { out[name] = { adopted: true, id: d.id, adbPort: d.adbPort, state: d.containerState, adb: d.adbState }; continue; }
  ramOk();
  const cr = await req('POST', '/api/devices/redroid', { name, templateName: TEMPLATE, idempotencyKey: `rdev-nv5b-${name}-${Date.now().toString(36)}` });
  if (cr.status !== 200 && cr.status !== 201) throw new Error(`${name} create -> ${cr.status} ${JSON.stringify(cr.j).slice(0, 300)}`);
  say(`${name}: created (id=${cr.j.device?.id} port=${cr.j.device?.adbPort}) — waiting online`);
  const { d: on, waitedMs } = await waitOnline(cr.j.device.id, cr.j.device.adbPort, name);
  out[name] = { adopted: false, id: on.id, adbPort: on.adbPort, onlineMs: waitedMs };
  say(`${name}: online in ${waitedMs}ms`);
  await sleep(15000); // stagger (RAM gate + boot load)
}
const fsOut = '/home/kenneth/.openclaw/workspace/water_army/logs/realdevice-master/nv5b/bootstrap.json';
fs.mkdirSync(fsOut.replace(/\/[^/]*$/, ''), { recursive: true });
fs.writeFileSync(fsOut, JSON.stringify({ at: new Date().toISOString(), devices: out }, null, 2));
say(`bootstrap done: ${JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.adopted ? 'adopted' : 'created'])))}`);
