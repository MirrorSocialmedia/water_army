/**
 * Redroid template seed (P5, 工單 commit 1) — 2 admin-curated templates:
 *
 *   1. `redroid-15-gpu-privileged`  — privileged + host GPU (the dedicated
 *      Redroid template where `privileged` is ALLOWED, MD §9.2/§13.4)
 *   2. `redroid-14-swiftshader`     — non-privileged, software rendering
 *      (validates the non-privileged path; real boot of a non-privileged
 *      Redroid needs /dev/binder binds — see ADR §14 真機未完成清單)
 *
 * Idempotent: upsert by name. Image tags are PINNED (MD §2.2 — no
 * latest/nightly). Images must be verified on a real host before production
 * use; this host cannot boot Redroid (no binder/ashmem) — stated, not hidden.
 *
 * CLI:  npm run db:seed:redroid   (reads DATABASE_URL)
 * Test: import { seedRedroidTemplates } from ...  with a fake/prisma db.
 */

/** The two seed rows (fixed ids → deterministic upserts). */
export const SEED_REDROID_TEMPLATES = Object.freeze([
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'redroid-15-gpu-privileged',
    image: 'redroid/redroid:15.0.0',
    androidVersion: '15',
    width: 1080,
    height: 1920,
    dpi: 440,
    fps: 30,
    gpuMode: 'host',
    privileged: true,
    privilegedReason:
      'Dedicated Redroid template — Android binder + GPU passthrough require privileged (MD §9.2 exception, §13.4). General app containers are never privileged.',
    isEnabled: true,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'redroid-14-swiftshader',
    image: 'redroid/redroid:14.0.0',
    androidVersion: '14',
    width: 720,
    height: 1280,
    dpi: 320,
    fps: 30,
    gpuMode: 'swiftshader_indirect',
    privileged: false,
    privilegedReason: null,
    isEnabled: true,
  },
]);

/**
 * Upsert the seed templates into any Prisma-shaped client (real or fake).
 * @param {object} db prisma client (needs redroidTemplate.findUnique/upsert)
 * @returns {Promise<{created:string[], updated:string[]}>}
 */
export async function seedRedroidTemplates(db) {
  const created = [];
  const updated = [];
  for (const t of SEED_REDROID_TEMPLATES) {
    const existing = await db.redroidTemplate.findUnique({ where: { name: t.name } });
    if (existing) {
      // Destructure `id` out: Prisma treats `id: undefined` as absent, but a
      // naive Object.assign (fake db) would overwrite the row id — stay clean.
      const { id: _seedId, ...updates } = t;
      void _seedId;
      await db.redroidTemplate.update({ where: { id: existing.id }, data: updates });
      updated.push(t.name);
    } else {
      await db.redroidTemplate.create({ data: t });
      created.push(t.name);
    }
  }
  return { created, updated };
}

// ---- CLI -----------------------------------------------------------------
// Direct invocation: `node prisma/seed-redroid-templates.js`
// (npm run db:seed:redroid). Imports are dynamic so `import` from tests never
// pulls the native client when a fake db is passed.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { PrismaClient } = await import('@prisma/client');
  const { PrismaPg } = await import('@prisma/adapter-pg');
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('seed: DATABASE_URL is not set');
    process.exit(1);
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const result = await seedRedroidTemplates(prisma);
    console.log(`seed: created=[${result.created.join(', ')}] updated=[${result.updated.join(', ')}]`);
  } finally {
    await prisma.$disconnect();
  }
}
