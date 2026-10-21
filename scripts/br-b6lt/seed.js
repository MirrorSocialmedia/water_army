/**
 * BR-B6 ladder load-test seed — 50 identities (brb6lt-01..brb6lt-50) + admin.
 * Deterministic ids, idempotent (upsert by externalRef/dataPath).
 *
 * The ladder reuses the identity POOL across stages (stage N uses the first N
 * identities; an identity's first stage is its cold boot, later stages are
 * warm stop->start rotations on the RETAINED data volume — see
 * vram-monitoring-plan.md §4). Data volumes are NEVER deleted mid-ladder
 * (MD item 3 / R5 recreate-stall avoidance).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import argon2 from '@node-rs/argon2';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL missing (run setup.sh first)');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
await db.$connect();

const prefix = process.env.BRB6LT_PREFIX ?? 'brb6lt';
const N = 50;
const uuidFor = (tag) => {
  const hex = (n, w = 8) => (n % 2 ** (w * 4)).toString(16).padStart(w, '0');
  let h = 0x811c9dc5;
  for (const ch of tag) { h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0; }
  return `${hex(h, 8)}-${hex(h + 1, 4)}-4${hex(h + 2, 3)}-8${hex(h + 3, 3)}-${hex(h + 4, 12)}`;
};

const { argon2id, hash } = argon2;
const password = process.env.BRB6LT_PASSWORD ?? `brb6lt-${Date.now().toString(36)}`;
const passwordHash = await hash(password, { type: argon2id });
const admin = await db.user.upsert({
  where: { username: 'brb6ltadmin' },
  update: { passwordHash, role: 'admin', isActive: true },
  create: { username: 'brb6ltadmin', passwordHash, role: 'admin' },
});

const root = process.env.BRB6LT_DATA_ROOT ?? '.dev/br-b6lt/data';
const identities = [];
for (let i = 1; i <= N; i += 1) {
  const ref = `${prefix}-${String(i).padStart(2, '0')}`;
  const id = uuidFor(`brb6lt-${ref}`);
  const dataPath = path.resolve(root, ref);
  mkdirSync(dataPath, { recursive: true });
  await db.identity.upsert({
    where: { externalRef: ref },
    update: {
      id,
      displayName: `BR-B6LT ${ref}`,
      status: 'READY',
      dataPath,
      identityType: 'qa_device',
    },
    create: {
      id,
      externalRef: ref,
      displayName: `BR-B6LT ${ref}`,
      status: 'READY',
      dataPath,
      identityType: 'qa_device',
    },
  });
  identities.push({ ref, id });
}

const out = {
  admin: { id: admin.id, username: admin.username, password },
  ladder: identities,
};
writeFileSync('.dev/br-b6lt/identities.json', JSON.stringify(out, null, 2));
console.log(`[br-b6lt-seed] ${identities.length} identities upserted (${prefix}-01..${String(N).padStart(2, '0')})`);
console.log('[br-b6lt-seed] admin=brb6ltadmin pw written to .dev/br-b6lt/identities.json');
await db.$disconnect();
