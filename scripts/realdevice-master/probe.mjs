/** W1 single-device probe: identity seed + ensureProfile + create redroid-rdev-probe. */
import { execSync } from 'node:child_process';
const ADB = `${process.env.HOME}/.local/share/platform-tools/adb`;
const API = 'http://127.0.0.1:16490';
const sh = (c, t = 60000) => execSync(c, { encoding: 'utf8', timeout: t, maxBuffer: 16 * 1024 * 1024 }).toString();
const psql = (sql) => execSync(`docker exec -i rdev-pg psql -U postgres -d water_army_rdev -tA -v ON_ERROR_STOP=1`, { encoding: 'utf8', input: sql, timeout: 30000 }).toString().trim();
let cookie = '';
async function req(method, p, body) {
  const r = await fetch(API + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
const psql2 = psql;
async function main() {
  psql2(`INSERT INTO identities (id, external_ref, display_name, identity_type, status, data_path, metadata_json, created_at, updated_at)
    VALUES ('c9f1c001-0000-4000-8000-0000000000a1', 'rdev-w1-a1', 'rdev-w1-a1', 'qa_device', 'READY', '/var/lib/water-army/identities/rdev-w1-a1', '{}'::jsonb, now(), now())
    ON CONFLICT (id) DO UPDATE SET status = 'READY';`);
  const login = await req('POST', '/api/auth/login', { username: 'rdev-admin', password: 'rdev-e2e-admin-pw' });
  console.log('login', login.status);
  const fp = await req('POST', '/api/identities/c9f1c001-0000-4000-8000-0000000000a1/fingerprint');
  console.log('fingerprint', fp.status, JSON.stringify(fp.j.profile ?? fp.j).slice(0, 500));
  const cr = await req('POST', '/api/devices/redroid', { name: 'redroid-rdev-probe', templateName: 'rdev-base', identityId: 'c9f1c001-0000-4000-8000-0000000000a1', idempotencyKey: 'rdev-w1-probe-01' });
  console.log('create', cr.status, JSON.stringify(cr.j).slice(0, 600));
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
