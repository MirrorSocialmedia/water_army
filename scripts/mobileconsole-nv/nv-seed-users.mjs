/**
 * NV (gen9) — scratch-only E2E user seeding (P1/P2 precedent: fixed UUID +
 * argon2 + ON CONFLICT idempotent; scratch throwaway accounts, deleted at
 * teardown — NEVER a real account).
 *
 * Seeds: mce2eop1 (operator) — used as the "manual handler" actor (NV3) and
 * the foreign-role probe (NV5 permissions). Password is a fixed scratch
 * fixture (same class as P1's 'e2e-p1-pw'); it is not a credential of any
 * real system and the DB dies with the scratch PG.
 *
 * Run: node nv-seed-users.mjs            (seed + verify login)
 *      node nv-seed-users.mjs --teardown (delete the scratch users)
 */
import { execSync } from 'node:child_process';
import argon2 from '@node-rs/argon2';

const API = process.env.MC_API ?? 'http://127.0.0.1:16490';
const USER = { id: 'nv900000-0000-4000-8000-000000000002', username: 'mce2eop1', password: 'nv-e2e-op-pw', role: 'operator' };

const psql = (sql) => execSync(`PGPASSWORD=postgres psql -h 127.0.0.1 -p 16494 -U postgres -d water_army_mc -tA -c ${JSON.stringify(sql)}`, { encoding: 'utf8' }).toString().trim();

const log = (m) => console.log(`[nv-seed ${new Date().toISOString()}] ${m}`);

async function main() {
  if (process.argv.includes('--teardown')) {
    const n = psql(`DELETE FROM users WHERE username='${USER.username}' RETURNING id;`);
    log(`teardown: deleted ${n ? n.split('\n').length : 0} scratch user(s)`);
    return;
  }
  const hash = await argon2.hash(USER.password);
  const n = psql(`INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
VALUES ('${USER.id}', '${USER.username}', '${hash}', '${USER.role}', true, now(), now())
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, password_hash = EXCLUDED.password_hash, is_active = true
RETURNING id;`);
  log(`seeded ${USER.username} (operator): ${n ? 'ok' : 'FAIL'}`);
  // verify: real login against the live API
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER.username, password: USER.password }),
  });
  const j = await r.json().catch(() => ({}));
  const me = await fetch(`${API}/api/auth/me`, { headers: { cookie: r.headers.get('set-cookie')?.split(';')[0] ?? '' } }).then((x) => x.json().catch(() => ({})));
  if (r.status !== 200 || me.user?.username !== USER.username || me.user?.role !== USER.role) {
    log(`FATAL: seed verification failed (login ${r.status}, me=${JSON.stringify(me.user ?? null).slice(0, 120)})`);
    process.exit(1);
  }
  log(`verified: login 200, role=${me.user.role}, id=${String(me.user.id).slice(0, 8)}…`);
}

main().catch((e) => { log(`FATAL: ${e?.message ?? e}`); process.exit(1); });
