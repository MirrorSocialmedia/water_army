/**
 * rdev scratch-only E2E user seeding (P1/P2 precedent: fixed UUID + argon2 +
 * ON CONFLICT idempotent; scratch throwaway accounts, deleted at teardown —
 * NEVER a real account).
 *
 * Seeds: rdev-admin (admin) / rdev-op1 (operator) / rdev-view1 (viewer).
 * Passwords are fixed scratch fixtures (same class as MC's 'e2e-p1-pw'); not
 * credentials of any real system; the DB dies with the scratch PG.
 *
 * Run: node seed-users.mjs            (seed + verify logins)
 *      node seed-users.mjs --teardown (delete the scratch users)
 */
import { execSync } from 'node:child_process';
import argon2 from '@node-rs/argon2';

const API = process.env.RD_API ?? 'http://127.0.0.1:16490';
const USERS = [
  { id: 'b9f1c001-0000-4000-8000-000000000001', username: 'rdev-admin', password: 'rdev-e2e-admin-pw', role: 'admin' },
  { id: 'b9f1c001-0000-4000-8000-000000000002', username: 'rdev-op1', password: 'rdev-e2e-op-pw', role: 'operator' },
  { id: 'b9f1c001-0000-4000-8000-000000000003', username: 'rdev-view1', password: 'rdev-e2e-view-pw', role: 'viewer' },
];

const psql = (sql) => execSync(`docker exec -i rdev-pg psql -U postgres -d water_army_rdev -tA -v ON_ERROR_STOP=1`, { encoding: 'utf8', input: sql }).toString().trim();

const log = (m) => console.log(`[rdev-seed ${new Date().toISOString()}] ${m}`);

async function verify(username, password) {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const j = await r.json().catch(() => ({}));
  const me = await fetch(`${API}/api/auth/me`, { headers: { cookie: r.headers.get('set-cookie')?.split(';')[0] ?? '' } }).then((x) => x.json().catch(() => ({})));
  return r.status === 200 && me.user?.username === username && me.user?.role === USERS.find((u) => u.username === username)?.role;
}

async function main() {
  if (process.argv.includes('--teardown')) {
    for (const u of USERS) {
      const n = psql(`DELETE FROM users WHERE username='${u.username}' RETURNING id;`);
      log(`teardown: ${u.username} deleted=${n ? 1 : 0}`);
    }
    return;
  }
  for (const u of USERS) {
    const hash = await argon2.hash(u.password);
    psql(`INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
      VALUES ('${u.id}', '${u.username}', '${hash}', '${u.role}', true, now(), now())
      ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, password_hash = EXCLUDED.password_hash, is_active = true;`);
    const ok = await verify(u.username, u.password);
    if (!ok) { log(`FATAL: ${u.username} login verification failed`); process.exit(1); }
    log(`seeded+verified ${u.username} (${u.role})`);
  }
}

main().catch((e) => { log(`FATAL: ${e?.message ?? e}`); process.exit(1); });
