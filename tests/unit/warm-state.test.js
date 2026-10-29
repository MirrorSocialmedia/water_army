/**
 * WA-WARMING s1 — warm-state machine + business gate (hermetic, pure).
 * Covers: transition matrix, threshold resolution (global + per-identity),
 * progress math, lazy promotion semantics, the cold/warming/warm gate matrix,
 * the business-vs-warming purpose split, and the grandfathering rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WARM_STATES,
  WARM_GATE_BLOCKED,
  WARM_THRESHOLD_DEFAULT_DAYS,
  APP_SETTING_WARM_THRESHOLD_DAYS,
  BATCH_PURPOSE,
  isValidWarmState,
  resolveStoredWarmState,
  canTransitionWarm,
  readWarmThresholdDays,
  identityWarmThresholdDays,
  resolveWarmThreshold,
  evaluateWarmProgress,
  checkWarmGate,
  batchPurposeOf,
  normalizeWarmThresholdInput,
} from '@water-army/shared';

const DAY = 86_400_000;
const NOW = new Date('2026-10-29T12:00:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * DAY);

// ------------------------------------------------------------------ matrix
test('warm states + transition matrix (cold->warming->warm, reset, re-warm)', () => {
  assert.deepEqual([...WARM_STATES], ['cold', 'warming', 'warm']);
  assert.ok(canTransitionWarm('cold', 'warming'), 'start');
  assert.ok(canTransitionWarm('cold', 'warm'), 'admin force from cold');
  assert.ok(canTransitionWarm('warming', 'warm'), 'promote');
  assert.ok(canTransitionWarm('warming', 'cold'), 'reset');
  assert.ok(canTransitionWarm('warm', 'warming'), 're-warm after incident');
  assert.ok(!canTransitionWarm('cold', 'cold'));
  assert.ok(!canTransitionWarm('warm', 'cold'), 'warm cannot reset — re-warm instead');
  assert.ok(!canTransitionWarm('warming', 'warming'));
  assert.ok(!canTransitionWarm('cold', 'nope'));
});

test('grandfather rule: absent/invalid warmState resolves WARM (zero disruption)', () => {
  assert.equal(resolveStoredWarmState({}), 'warm');
  assert.equal(resolveStoredWarmState({ warmState: null }), 'warm');
  assert.equal(resolveStoredWarmState({ warmState: 'WEIRD' }), 'warm');
  assert.equal(resolveStoredWarmState({ warmState: 'cold' }), 'cold');
  assert.ok(isValidWarmState('warming'));
  assert.ok(!isValidWarmState(undefined));
});

// ------------------------------------------------------------------ threshold
test('threshold: default 14; AppSetting wins; per-identity override wins; garbage fails safe', async () => {
  const db = { appSetting: { findUnique: async () => null } };
  assert.deepEqual(await readWarmThresholdDays(db), { days: WARM_THRESHOLD_DEFAULT_DAYS, source: 'default' });
  assert.deepEqual(await readWarmThresholdDays({ appSetting: { findUnique: async () => { throw new Error('db down'); } } }),
    { days: 14, source: 'default' }, 'read failure = default (never blocks)');

  const mk = (value) => ({ appSetting: { findUnique: async () => ({ valueJson: { value } }) } });
  assert.deepEqual(await readWarmThresholdDays(mk(7)), { days: 7, source: 'appsetting' });
  for (const bad of [0.5, 'x', -1, 366, null, {}, 14.0001]) {
    assert.equal((await readWarmThresholdDays(mk(bad))).source, 'default', `invalid ${JSON.stringify(bad)} => default`);
  }
  assert.equal((await readWarmThresholdDays(mk(0))).days, 0, '0 = instant pass is legal');

  assert.equal(identityWarmThresholdDays({ metadataJson: { warmThresholdDays: 3 } }, 14), 3);
  assert.equal(identityWarmThresholdDays({ metadataJson: { warmThresholdDays: 999 } }, 14), 14, 'out-of-bounds override ignored');
  assert.equal(identityWarmThresholdDays({}, 14), 14);

  const r = await resolveWarmThreshold(mk(10), { metadataJson: { warmThresholdDays: 2 } });
  assert.deepEqual({ days: r.days, source: r.source }, { days: 2, source: 'identity_override' });
  assert.equal(normalizeWarmThresholdInput('9'), 9);
  assert.equal(normalizeWarmThresholdInput(36.5), null);
});

// ------------------------------------------------------------------ progress
test('progress math: cold (no clock), warming elapsed, lazy-derived warm', () => {
  const cold = evaluateWarmProgress({ warmState: 'cold' }, { now: NOW, thresholdDays: 14 });
  assert.equal(cold.effectiveState, 'cold');
  assert.equal(cold.readyAt, null);
  assert.equal(cold.daysRemaining, 14);

  const d3 = evaluateWarmProgress({ warmState: 'warming', warmStartedAt: daysAgo(3) }, { now: NOW, thresholdDays: 14 });
  assert.equal(d3.effectiveState, 'warming');
  assert.equal(d3.elapsedDays, 3);
  assert.equal(d3.daysRemaining, 11);
  assert.equal(d3.progressPct, 21);
  assert.equal(new Date(d3.readyAt).getTime(), daysAgo(3).getTime() + 14 * DAY, 'readyAt = start + threshold');

  const mature = evaluateWarmProgress({ warmState: 'warming', warmStartedAt: daysAgo(15) }, { now: NOW, thresholdDays: 14 });
  assert.equal(mature.effectiveState, 'warm', 'LAZY promotion: derived state closes the gap without a write');

  const exact = evaluateWarmProgress({ warmState: 'warming', warmStartedAt: daysAgo(14) }, { now: NOW, thresholdDays: 14 });
  assert.equal(exact.effectiveState, 'warm', 'elapsed == threshold passes');

  const noStart = evaluateWarmProgress({ warmState: 'warming', createdAt: daysAgo(20) }, { now: NOW, thresholdDays: 14 });
  assert.equal(noStart.effectiveState, 'warm', 'warming without warmStartedAt falls back to createdAt (in service since registration)');

  const warmRow = evaluateWarmProgress({ warmState: 'warm', warmReadyAt: daysAgo(2) }, { now: NOW, thresholdDays: 14 });
  assert.equal(warmRow.effectiveState, 'warm');
  assert.equal(warmRow.daysRemaining, 0);
});

// ------------------------------------------------------------------ gate
test('gate matrix: cold/warming blocked for business; warm + matured pass; warming purpose bypasses', () => {
  const cold = { id: 'i1', warmState: 'cold' };
  const warming = { id: 'i2', warmState: 'warming', warmStartedAt: daysAgo(5) };
  const matured = { id: 'i3', warmState: 'warming', warmStartedAt: daysAgo(15) };
  const warm = { id: 'i4', warmState: 'warm' };

  for (const id of [cold, warming]) {
    const r = checkWarmGate(id, { now: NOW, thresholdDays: 14 });
    assert.equal(r.allowed, false);
    assert.equal(r.code, WARM_GATE_BLOCKED);
    assert.ok(r.message.includes('業務') || r.message.includes('blocked'));
  }
  assert.ok(checkWarmGate(matured, { now: NOW, thresholdDays: 14 }).allowed, 'matured warming passes without a write');
  assert.ok(checkWarmGate(warm, { now: NOW, thresholdDays: 14 }).allowed);

  // the whole point of warming tasks: they exist to warm cold accounts.
  const bypass = checkWarmGate(cold, { now: NOW, thresholdDays: 14, purpose: BATCH_PURPOSE.WARMING });
  assert.equal(bypass.allowed, true);
  assert.equal(bypass.code, null);

  // purpose classification: anything not exactly 'warming' = business (fail-closed).
  assert.equal(batchPurposeOf(undefined), BATCH_PURPOSE.BUSINESS);
  assert.equal(batchPurposeOf({}), BATCH_PURPOSE.BUSINESS);
  assert.equal(batchPurposeOf({ purpose: 'WARMING' }), BATCH_PURPOSE.BUSINESS, 'case-sensitive label');
  assert.equal(batchPurposeOf({ purpose: 'warming' }), BATCH_PURPOSE.WARMING);
});

test('gate honours per-identity threshold (override 0 days => instant business pass)', () => {
  const warming0 = { id: 'i5', warmState: 'warming', warmStartedAt: daysAgo(0.01) };
  const r = checkWarmGate(warming0, { now: NOW, thresholdDays: 0 });
  assert.equal(r.allowed, true, 'threshold 0 = 老細放行 (per-account override semantics)');
});

// ------------------------------------------------------------------ service
test('service: transition writes + StateEvent audit (entityType identity_warm)', async () => {
  const { createWarmStateService } = await import('@water-army/shared');
  const rows = new Map([['x1', { id: 'x1', displayName: 'x1', warmState: 'cold', metadataJson: {}, createdAt: daysAgo(1), updatedAt: daysAgo(1) }]]);
  const events = [];
  const db = {
    identity: {
      findUnique: async ({ where }) => (rows.has(where.id) ? { ...rows.get(where.id) } : null),
      findMany: async ({ where }) => [...rows.values()].filter((r) => where?.id?.in?.includes(r.id)),
      update: async ({ where, data }) => { const r = rows.get(where.id); Object.assign(r, data); return { ...r }; },
    },
    appSetting: { findUnique: async () => null },
    stateEvent: { create: async ({ data }) => { events.push(data); return data; } },
  };
  const svc = createWarmStateService({ db });

  // illegal from-state: promote from cold (must start first)
  const bad = await svc.transition('x1', 'promote', { now: NOW });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'WARM_TRANSITION_INVALID');

  const start = await svc.transition('x1', 'start', { actorUserId: 'u1', reason: 'begin warming', now: NOW });
  assert.equal(start.ok, true);
  assert.equal(rows.get('x1').warmState, 'warming');
  assert.equal(new Date(rows.get('x1').warmStartedAt).getTime(), NOW.getTime());
  assert.equal(events.at(-1).entityType, 'identity_warm');
  assert.equal(events.at(-1).fromState, 'cold');
  assert.equal(events.at(-1).toState, 'warming');

  // gateCheck: blocked list carries progress + message
  const { blocked } = await svc.gateCheck(['x1'], { now: NOW });
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].effectiveState, 'warming');

  // force (admin path) => warm + audited reason
  const forced = await svc.transition('x1', 'force', { actorUserId: 'u9', reason: 'boss said go', now: NOW });
  assert.equal(forced.ok, true);
  assert.equal(rows.get('x1').warmState, 'warm');
  assert.ok(rows.get('x1').warmReadyAt);
  assert.equal(events.at(-1).reason, 'boss said go');

  // lazy promote persists
  rows.set('x2', { id: 'x2', warmState: 'warming', warmStartedAt: daysAgo(20), metadataJson: {}, createdAt: daysAgo(30), updatedAt: daysAgo(1) });
  const p = await svc.getProgress('x2', { now: NOW });
  assert.equal(p.storedState, 'warm', 'promotion persisted on read');
  assert.equal(rows.get('x2').warmState, 'warm');

  // threshold setter round-trips through AppSetting shape
  const key = APP_SETTING_WARM_THRESHOLD_DAYS;
  assert.equal((await readWarmThresholdDays(db)).days, 14);
  db.appSetting.findUnique = async () => ({ valueJson: { value: 7 } });
  assert.equal((await readWarmThresholdDays(db)).days, 7, `key ${key} consumed as {value:int}`);
});
