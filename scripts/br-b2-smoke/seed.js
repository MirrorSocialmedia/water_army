/**
 * BR-B2 G8 smoke seed — admin user + 18 identities (deterministic ids).
 * 5 (A) + 5 (B pause/resume) + 5 (C 2-worker kill) + 3 (D 1-worker reconcile).
 * Idempotent: upserts by dataPath.
 */
import argon2 from '@node-rs/argon2';

const { PrismaClient } = await import('@prisma/client');
const { PrismaPg } = await import('@prisma/adapter-pg');
let url = process.env.DATABASE_URL;
if (!url) {
  // self-contained: read the generated smoke env (setup.sh writes it)
  const fs = await import('node:fs');
  url = fs.readFileSync('.dev/br-b2-smoke/api.env', 'utf8').split('\n').find((l) => l.startsWith('DATABASE_URL='))?.slice('DATABASE_URL='.length);
}
if (!url) throw new Error('DATABASE_URL missing');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
await db.$connect();
const { argon2id, hash } = argon2;

const password = `smoke-${Date.now().toString(36)}-pw123456`;
const passwordHash = await hash(password, { type: argon2id });

const user = await db.user.upsert({
  where: { username: 'smokeadmin' },
  update: { passwordHash, role: 'admin', isActive: true },
  create: { username: 'smokeadmin', passwordHash, role: 'admin' },
});

const groups = { A: 5, B: 5, C: 5, D: 3 };
const identities = [];
let n = 0;
for (const [g, count] of Object.entries(groups)) {
  for (let i = 0; i < count; i++) {
    n += 1;
    const ref = `b2smoke-${g}${String(i + 1).padStart(2, '0')}`;
    identities.push({
      externalRef: ref,
      displayName: `B2 smoke ${g}${i + 1}`,
      identityType: 'ACCOUNT',
      status: 'READY',
      dataPath: `b2smoke/${ref}`,
    });
  }
}

const out = {};
for (const spec of identities) {
  const row = await db.identity.upsert({
    where: { dataPath: spec.dataPath },
    update: { status: 'READY', displayName: spec.displayName, externalRef: spec.externalRef },
    create: spec,
  });
  const g = spec.externalRef.slice(8, 9);
  (out[g] ??= []).push(row.id);
}

import { writeFileSync } from 'node:fs';
writeFileSync(
  '.dev/br-b2-smoke/identities.json',
  JSON.stringify({ user: user.id, password, groups: out }, null, 2),
);
console.log(`seeded admin (${user.id}) + ${identities.length} identities → .dev/br-b2-smoke/identities.json`);
await db.$disconnect();
