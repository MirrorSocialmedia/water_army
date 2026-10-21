/**
 * BR-B6 E2E seed — 200 main identities (MD §14.3) + 10 overlap-cycle
 * identities + admin. Deterministic ids, idempotent (upsert by externalRef /
 * dataPath — a re-run of setup.sh never double-seeds).
 *
 *   - brb6-001..brb6-200 : the 200-identity cycle. 196 READY + 4 DISABLED
 *     (one per batch: 004/054/104/154) → creation must SKIP them with an
 *     explicit reason (MD §14.1 "disabled identity 的行為和報告正確"; the
 *     subtask's "disable/skipped 要有明確原因").
 *   - brb6-x01..brb6-x10 : the overlap cycle (proves the GLOBAL cap binds
 *     across simultaneously-running cycles).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import argon2 from '@node-rs/argon2';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL missing (run setup.sh first)');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
await db.$connect();

const uuidFor = (tag) => {
  // deterministic, well-formed v4-SHAPED uuid (the column is just a uuid).
  // plain-number math (w ≤ 12 → 2**48 < MAX_SAFE_INTEGER).
  const hex = (n, w = 8) => (n % 2 ** (w * 4)).toString(16).padStart(w, '0');
  let h = 0x811c9dc5;
  for (const ch of tag) { h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0; }
  return `${hex(h, 8)}-${hex(h + 1, 4)}-4${hex(h + 2, 3)}-8${hex(h + 3, 3)}-${hex(h + 4, 12)}`;
};

const DISABLED_SET = new Set(['brb6-004', 'brb6-054', 'brb6-104', 'brb6-154']);

const { argon2id, hash } = argon2;
const password = process.env.BRB6_E2E_PASSWORD ?? `brb6-e2e-${Date.now().toString(36)}`;
const passwordHash = await hash(password, { type: argon2id });

const admin = await db.user.upsert({
  where: { username: 'brb6admin' },
  update: { passwordHash, role: 'admin', isActive: true },
  create: { username: 'brb6admin', passwordHash, role: 'admin' },
});

const identities = [];
const refs = [];
for (let i = 1; i <= 200; i += 1) refs.push(`brb6-${String(i).padStart(3, '0')}`);
for (let i = 1; i <= 10; i += 1) refs.push(`brb6-x${String(i).padStart(2, '0')}`);

for (const ref of refs) {
  const id = uuidFor(`brb6-${ref}`);
  const disabled = DISABLED_SET.has(ref);
  // dataPath must be ABSOLUTE and inside the data root (validateIdentityDataPath
  // MD §4.1 — relative paths are rejected at start time).
  const dataPath = path.resolve(process.env.BRB6_DATA_ROOT ?? '.dev/br-b6-e2e/data', ref);
  await db.identity.upsert({
    where: { externalRef: ref },
    update: {
      id,
      displayName: disabled ? `BR-B6 ${ref} (DISABLED by design)` : `BR-B6 ${ref}`,
      status: disabled ? 'DISABLED' : 'READY',
      dataPath,
      identityType: 'qa_device',
    },
    create: {
      id,
      externalRef: ref,
      displayName: disabled ? `BR-B6 ${ref} (DISABLED by design)` : `BR-B6 ${ref}`,
      status: disabled ? 'DISABLED' : 'READY',
      dataPath,
      identityType: 'qa_device',
    },
  });
  identities.push({ ref, id, status: disabled ? 'DISABLED' : 'READY' });
}

// create the data dirs (the volume source must exist under the data root —
// the lifecycle validates the path before anything touches docker).
const { mkdirSync } = await import('node:fs');
const root = process.env.BRB6_DATA_ROOT ?? '.dev/br-b6-e2e/data';
for (const ref of refs) {
  mkdirSync(`${root}/${ref}`, { recursive: true });
}

const out = {
  admin: { id: admin.id, username: admin.username, password },
  main: identities.filter((i) => !i.ref.startsWith('brb6-x')),
  overlap: identities.filter((i) => i.ref.startsWith('brb6-x')),
  disabledRefs: [...DISABLED_SET],
};
const { writeFileSync } = await import('node:fs');
writeFileSync('.dev/br-b6-e2e/identities.json', JSON.stringify(out, null, 2));
console.log(`[br-b6-e2e-seed] ${identities.length} identities upserted (${out.main.length} main / ${out.overlap.length} overlap / ${out.disabledRefs.length} DISABLED)`);
console.log(`[br-b6-e2e-seed] admin=brb6admin pw written to .dev/br-b6-e2e/identities.json`);
await db.$disconnect();
