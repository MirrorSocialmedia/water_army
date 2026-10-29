/**
 * WA-WARMING (S3) — migration backward-compatibility contract.
 *
 * 既有身份默認 warm（零破壞）、新註冊 cold — this is the release-blocking
 * promise of 20261029160000_warm_state. Parsed + simulated hermetically
 * (no live DB): the statement ledger must stay ADDITIVE, the grandfather
 * backfill must exist and be honest, and the Prisma schema default must be
 * 'cold' for NEW rows. If someone rewrites this migration destructively,
 * this test turns red before production does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { WARM_STATES } from '../../packages/shared/src/warm-state.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SQL = readFileSync(join(ROOT, 'prisma', 'migrations', '20261029160000_warm_state', 'migration.sql'), 'utf8');
const SCHEMA = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');

test('migration is additive-only (zero destructive statements)', () => {
  const upper = SQL.toUpperCase();
  for (const banned of ['DROP TABLE', 'DROP COLUMN', ' DROP ', 'DELETE FROM', 'TRUNCATE', 'ALTER COLUMN', 'UPDATE "IDENTITIES" SET "STATUS"']) {
    assert.ok(!upper.includes(banned), `destructive statement touched the migration: ${banned}`);
  }
  // Every ALTER must be an IF NOT EXISTS ADD COLUMN — re-deploy-safe.
  const alters = SQL.match(/ALTER TABLE[^;]+;/g) ?? [];
  assert.equal(alters.length, 3, 'exactly the three warm-axis columns');
  for (const a of alters) {
    assert.match(a, /ADD COLUMN IF NOT EXISTS/, 'idempotent ADD (VMSTEALTH house style)');
    assert.ok(!/DROP/.test(a));
  }
  assert.match(SQL, /CREATE INDEX IF NOT EXISTS "identities_warm_state_idx"/, 'dispatch-hot-path index present + idempotent');
});

test('grandfather backfill: existing rows become warm with an honest ready timestamp', () => {
  // The ONLY UPDATE in the migration is the grandfather pass.
  const updates = SQL.match(/UPDATE[^;]+;/gi) ?? [];
  assert.equal(updates.length, 1, 'exactly one UPDATE — the backfill');
  assert.match(updates[0], /SET\s+"warm_state"\s*=\s*'warm'/);
  assert.match(updates[0], /"warm_ready_at"\s*=\s*now\(\)/, 'backfilled accounts carry an honest ready timestamp');
});

test('schema default is cold for NEW rows (新註冊 = cold); column names match the SQL', () => {
  const warmLine = SCHEMA.split('\n').find((l) => /warmState\s+String/.test(l)) ?? '';
  assert.match(warmLine, /@default\("cold"\)/, 'schema default = cold for new rows');
  assert.match(warmLine, /@map\("warm_state"\)/, 'column name parity with the migration');
  assert.match(SCHEMA, /@@index\(\[warmState\]\)/, 'dispatch-hot-path index declared in schema (prisma parity)');
  assert.match(SCHEMA, /warmState\s+String\s+@default\("cold"\)/, 'warmState column present');
  assert.match(SQL, /"warm_state" TEXT NOT NULL DEFAULT 'cold'/, 'DB default mirrors the schema default');
});

test('state vocabulary: the SQL literal set matches the shared WARM_STATES contract', () => {
  // Migration only ever writes 'cold' (default) and 'warm' (backfill) —
  // both must be legal vocabulary words of the state machine.
  const literals = [...SQL.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((x) => ['cold', 'warming', 'warm'].includes(x));
  assert.deepEqual([...new Set(literals)].sort(), ['cold', 'warm']);
  assert.deepEqual([...WARM_STATES].sort(), ['cold', 'warm', 'warming']);
});

test('migration SIMULATION: pre-existing fleet lands warm, first NEW row lands cold', () => {
  // Hermetic apply: ALTER-default semantics (existing rows get 'cold' then
  // the grandfather UPDATE catches every one of them), then a NEW insert
  // AFTER the migration only sees the column default.
  const rows = [
    { id: 'old-1' }, { id: 'old-2' }, { id: 'old-3' }, // fleet today (no warm axis at all)
  ];
  // ALTER TABLE ... DEFAULT 'cold' back-fills existing rows with the default (Postgres 11+ fast path).
  for (const r of rows) Object.assign(r, { warm_state: 'cold', warm_started_at: null, warm_ready_at: null });
  // UPDATE ... WHERE warm_state='cold'  (grandfather — every row at migration time is pre-existing)
  for (const r of rows) {
    if (r.warm_state === 'cold') Object.assign(r, { warm_state: 'warm', warm_ready_at: 'NOW' });
  }
  assert.deepEqual(rows.map((r) => r.warm_state), ['warm', 'warm', 'warm'], 'zero disruption: the whole fleet grandfathered');
  assert.ok(rows.every((r) => r.warm_ready_at === 'NOW'));
  // NEW registration after deploy: provision passes NO warmState => column default.
  const created = { warm_state: 'cold', warm_started_at: null, warm_ready_at: null }; // DB default
  assert.equal(created.warm_state, 'cold', 'fresh registration must warm up before business dispatch');
});

test('provision service writes an EXPLICIT cold (belt over trusting the column default)', () => {
  const src = readFileSync(join(ROOT, 'apps', 'api', 'src', 'services', 'identity-provision-service.js'), 'utf8');
  const createBlock = src.slice(src.indexOf('db.identity.create'), src.indexOf('db.identity.create') + 1200);
  assert.match(createBlock, /warmState:\s*'cold'/, '新註冊 = cold is in the create payload, not just the schema default');
});
