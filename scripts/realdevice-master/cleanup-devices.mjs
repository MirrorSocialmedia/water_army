/**
 * Mid-phase device cleanup — DELETE every redroid-rdev-* device via the API
 * (removeData:false: dataDirs collected by final teardown; per-phase RAM
 * release is the point). Idempotent; records each delete code.
 *
 * Usage: node cleanup-devices.mjs [--keep <prefix...>]
 *   --keep redroid-rdev-c1  => keep that device, delete the rest.
 */
import { execSync } from 'node:child_process';

const API = process.env.RD_API ?? 'http://127.0.0.1:16490';
const EVID = '/home/kenneth/.openclaw/workspace/water_army/logs/realdevice-master';
const fs = await import('node:fs');

const keep = new Set();
const args = process.argv.slice(2);
const ki = args.indexOf('--keep');
if (ki !== -1) for (const k of args.slice(ki + 1)) keep.add(k);

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

const login = await req('POST', '/api/auth/login', { username: 'rdev-admin', password: 'rdev-e2e-admin-pw' });
if (login.status !== 200) throw new Error(`login ${login.status}`);

const list = await req('GET', '/api/devices/redroid');
const targets = (list.j.devices ?? []).filter((d) => d.name?.startsWith('redroid-rdev') && !keep.has(d.name));
const results = [];
for (const d of targets) {
  const r = await req('DELETE', `/api/devices/redroid/${d.id}`, { confirm: d.name, removeData: false });
  results.push({ name: d.name, status: r.status, code: r.j.code ?? null });
  console.log(`deleted ${d.name}: ${r.status}${r.j.code ? ` (${r.j.code})` : ''}`);
}
fs.mkdirSync(`${EVID}/cleanup`, { recursive: true });
const out = { at: new Date().toISOString(), kept: [...keep], results };
fs.writeFileSync(`${EVID}/cleanup/cleanup-${Date.now().toString(36)}.json`, JSON.stringify(out, null, 2));
console.log(`cleanup done: ${results.length} deleted, ${keep.size} kept`);
// RAM after
const free = execSync('free -g | awk \'/^Mem:/{print $7}\'', { encoding: 'utf8' }).trim();
console.log(`MemAvailable now: ${free}G`);
