/**
 * P5 commit 1 — seed contract tests (fake db).
 *
 * The seed is the source of the two admin-curated Redroid templates that the
 * mock-validated lifecycle (工單 硬驗收 2) runs against. Contract:
 *  - idempotent (upsert by name — re-run creates nothing, updates in place)
 *  - image pins are explicit (no latest/nightly — MD §2.2)
 *  - exactly one privileged template, and it carries the required reason
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeFakeDb } from '../helpers/fakes.js';
import { seedRedroidTemplates, SEED_REDROID_TEMPLATES } from '../../prisma/seed-redroid-templates.js';

const PATTERN_PINNED = /^[a-z0-9][a-z0-9._/-]*(:[a-z0-9][a-z0-9._-]*|@sha256:[a-f0-9]{64})$/;

test('seed creates the two curated templates (one privileged, one not)', async () => {
  const db = makeFakeDb();
  const result = await seedRedroidTemplates(db);
  assert.deepEqual(result.created, ['redroid-15-gpu-privileged', 'redroid-14-swiftshader']);
  assert.deepEqual(result.updated, []);

  const all = await db.redroidTemplate.findMany();
  assert.equal(all.length, 2);

  const priv = await db.redroidTemplate.findUnique({ where: { name: 'redroid-15-gpu-privileged' } });
  const soft = await db.redroidTemplate.findUnique({ where: { name: 'redroid-14-swiftshader' } });
  assert.equal(priv.privileged, true);
  assert.equal(soft.privileged, false);
  assert.match(priv.privilegedReason, /Redroid/); // the explicit label (MD §9.2)
  assert.equal(soft.privilegedReason, null);
});

test('seed is idempotent — second run updates in place, zero duplicates', async () => {
  const db = makeFakeDb();
  await seedRedroidTemplates(db);
  const idsAfterFirst = (await db.redroidTemplate.findMany()).map((t) => t.id).sort();

  // Drift the privileged flag, then re-seed — the seed must heal it.
  const priv = await db.redroidTemplate.findUnique({ where: { name: 'redroid-15-gpu-privileged' } });
  await db.redroidTemplate.update({ where: { id: priv.id }, data: { privileged: false, gpuMode: 'swiftshader_indirect' } });

  const result = await seedRedroidTemplates(db);
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.updated, ['redroid-15-gpu-privileged', 'redroid-14-swiftshader']);

  const all = await db.redroidTemplate.findMany();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((t) => t.id).sort(), idsAfterFirst); // same rows, not new ones
  const healed = await db.redroidTemplate.findUnique({ where: { name: 'redroid-15-gpu-privileged' } });
  assert.equal(healed.privileged, true);
  assert.equal(healed.gpuMode, 'host');
});

test('seed image pins are explicit — no latest/nightly (MD §2.2)', async () => {
  for (const t of SEED_REDROID_TEMPLATES) {
    assert.match(t.image, PATTERN_PINNED, `${t.name}: image must be pinned — got ${t.image}`);
    const tail = t.image.slice(t.image.lastIndexOf('/') + 1);
    assert.doesNotMatch(tail, /(^|:)latest$/i, `${t.name}: latest tag forbidden`);
    assert.doesNotMatch(tail, /nightly/i, `${t.name}: nightly tag forbidden`);
  }
});

test('seed gpu modes are from the fixed set and consistent with privileged', async () => {
  for (const t of SEED_REDROID_TEMPLATES) {
    assert.ok(['swiftshader_indirect', 'host'].includes(t.gpuMode));
    if (t.gpuMode === 'host') assert.equal(t.privileged, true, 'host GPU needs the dedicated privileged template');
  }
});
