/**
 * F-RDFA-1 (WA-RDFA-FIX) — create-time config validation.
 *
 * The P2 real-device audit (WA-REALDEVICE-FINAL, v7 batch 2cbb2ce4) proved
 * the old hole: POST /api/batches accepted `config.adapter` = the STRING
 * "container" (joi only checked `type: 'object'` on the config root),
 * createCycle never called validateBatchConfig, and the malformed spec
 * 201'd at create to die as 409 RUN_STATE_INVALID at dispatch — every
 * attempt-1 FAILED_FINAL for the whole batch.
 *
 * Contract fixed here:
 *   - createCycle (the single cycle-write path = the API boundary) calls
 *     validateBatchConfig synchronously BEFORE the persistence transaction
 *   - malformed config → 400 VALIDATION_ERROR at create, ZERO rows written
 *   - valid configs (noop / container / knobs-only / absent) still create
 *   - the shared validateBatchConfig stays the single source of truth for
 *     the config shape (dispatch re-checks the adapter spec separately)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createBatchService, BatchError } from '@water-army/shared';
import { makeBatchFakeDb } from '../helpers/batch-fakes.js';

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const NOW = () => new Date('2026-10-29T02:00:00Z');

function makeCtx() {
  const db = makeBatchFakeDb({ clock: NOW });
  const svc = createBatchService({ db, log: SILENT, now: NOW });
  return { db, svc };
}

async function seedIds(ctx, n) {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const { identity } = await ctx.svc.createIdentity({ displayName: `cfgv-${i}`, identityType: 'qa_device' });
    ids.push(identity.id);
  }
  return ids;
}

const baseInput = (ids, key) => ({
  name: 'cfgv cycle',
  idempotencyKey: key,
  batchSize: 50,
  maxActiveContainers: 50,
  failurePolicy: 'continue_and_report',
  identities: ids.map((id) => ({ id })),
});

/** Assert a create is refused with 400 VALIDATION_ERROR + a naming message,
 *  and that NOTHING was persisted (no batches / memberships / events). */
async function expectCreate400(ctx, input, msgRe) {
  let threw = null;
  try {
    await ctx.svc.createCycle(input, { id: 'u1', username: 'admin' });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw instanceof BatchError, 'createCycle must throw BatchError');
  assert.equal(threw.apiCode, 'VALIDATION_ERROR');
  assert.equal(threw.statusCode, 400);
  assert.match(threw.message, msgRe);
  assert.equal((await ctx.db.batch.findMany({})).length, 0, 'no batch rows persisted');
  assert.equal((await ctx.db.batchIdentity.findMany({})).length, 0, 'no membership rows persisted');
}

test('F-RDFA-1: config.adapter = the string "container" (the exact v7 payload) → 400 at create', async () => {
  const ctx = makeCtx();
  const ids = await seedIds(ctx, 2);
  await expectCreate400(
    ctx,
    { ...baseInput(ids, 'cfgv-str-0001'), config: { adapter: 'container' } },
    /config\.adapter must be a plain object/,
  );
});

test('F-RDFA-1: container adapter missing the required image → 400 at create', async () => {
  const ctx = makeCtx();
  const ids = await seedIds(ctx, 2);
  await expectCreate400(
    ctx,
    { ...baseInput(ids, 'cfgv-nomsg-0002'), config: { adapter: { type: 'container' } } },
    /adapter\.image must be a non-empty string/,
  );
});

test('F-RDFA-1: container adapter with an unpinned image ref → 400 at create', async () => {
  const ctx = makeCtx();
  const ids = await seedIds(ctx, 2);
  await expectCreate400(
    ctx,
    { ...baseInput(ids, 'cfgv-unsafe-0003'), config: { adapter: { type: 'container', image: 'foo/bar' } } },
    /explicitly tagged/,
  );
});

test('F-RDFA-1: unknown adapter type → 400 at create', async () => {
  const ctx = makeCtx();
  const ids = await seedIds(ctx, 2);
  await expectCreate400(
    ctx,
    { ...baseInput(ids, 'cfgv-unk-0004'), config: { adapter: { type: 'emulator', image: 'foo/bar:1' } } },
    /config\.adapter\.type must be one of noop \| container/,
  );
});

test('F-RDFA-1: invalid config knobs (maxAttempts above cap) → 400 at create', async () => {
  const ctx = makeCtx();
  const ids = await seedIds(ctx, 2);
  await expectCreate400(
    ctx,
    { ...baseInput(ids, 'cfgv-knob-0005'), config: { maxAttempts: 99 } },
    /config\.maxAttempts must be an integer 1\.\.5/,
  );
});

test('F-RDFA-1: config = an array (not an object) → 400 at create', async () => {
  const ctx = makeCtx();
  const ids = await seedIds(ctx, 2);
  await expectCreate400(
    ctx,
    { ...baseInput(ids, 'cfgv-arr-0006'), config: [{ adapter: 'container' }] },
    /config must be a plain object/,
  );
});

test('F-RDFA-1: valid container adapter spec still creates (201 path, cycle persisted)', async () => {
  const ctx = makeCtx();
  const ids = await seedIds(ctx, 2);
  const res = await ctx.svc.createCycle(
    {
      ...baseInput(ids, 'cfgv-ok-0007'),
      config: {
        adapter: {
          type: 'container',
          image: 'water-army/redroid:14.0.0-240527-gms-mtg',
          health: { kind: 'adb-tcp', port: 5555 },
          work: { kind: 'none' },
        },
      },
    },
    { id: 'u1', username: 'admin' },
  );
  assert.equal(res.replay, false);
  assert.equal(res.batches.length, 1);
  const batch = await ctx.db.batch.findUnique({ where: { id: res.batches[0].id } });
  assert.deepEqual(batch.configJson.adapter.type, 'container');
});

test('F-RDFA-1: valid noop adapter + knobs-only config + absent config all still create', async () => {
  const ctx = makeCtx();
  const ids = await seedIds(ctx, 2);

  const noop = await ctx.svc.createCycle(
    { ...baseInput(ids, 'cfgv-noop-0008'), config: { adapter: { type: 'noop', outcome: 'ok' } } },
    { id: 'u1', username: 'admin' },
  );
  assert.equal(noop.replay, false);

  const knobs = await ctx.svc.createCycle(
    { ...baseInput(ids, 'cfgv-knobs-0009'), config: { timeoutSeconds: 600, maxAttempts: 2, interBatchCooldownSeconds: 5 } },
    { id: 'u1', username: 'admin' },
  );
  assert.equal(knobs.replay, false);

  const absent = await ctx.svc.createCycle(baseInput(ids, 'cfgv-absent-0010'), { id: 'u1', username: 'admin' });
  assert.equal(absent.replay, false);
});
