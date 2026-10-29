/**
 * WA-WARMING (S2) unit — warming templates + deterministic plan + scheduler.
 * Hermetic: no DB, no clocks outside injected `now`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WARMING_TEMPLATES,
  WARMING_TEMPLATE_NAMES,
  WARMING_SCHEDULE_DEFAULTS,
  readWarmingSchedule,
  hkDateString,
  warmingIdempotencyKey,
  planWarmingDay,
  warmingBatchSpec,
  createWarmingScheduler,
} from '../../packages/shared/src/warming-schedule.js';
import { makeBatchFakeDb } from '../helpers/batch-fakes.js';
import { createBatchService, BATCH_PURPOSE } from '../../packages/shared/src/index.js';

const ID_A = 'eeeeeeee-ffff-4aaa-8bbb-0000000000a1';
const ID_B = 'eeeeeeee-ffff-4aaa-8bbb-0000000000b2';
const DATE = '2026-10-29';
const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

test('templates: all three exist, non-empty steps, QUERY_POOL placeholder exactly once in search', () => {
  assert.deepEqual([...WARMING_TEMPLATE_NAMES].sort(), ['browse', 'search', 'video']);
  for (const name of WARMING_TEMPLATE_NAMES) {
    const t = WARMING_TEMPLATES[name];
    assert.ok(t.steps.length >= 5, `${name} needs a believable step list`);
    assert.ok(t.steps.every((s) => typeof s.action === 'string' && typeof s.note === 'string'));
    assert.ok(t.steps.at(-1).action === 'exit_app', 'every session ends with a natural exit');
  }
  assert.equal(WARMING_TEMPLATES.search.steps.filter((s) => s.from === 'QUERY_POOL').length, 1);
});

test('planWarmingDay: deterministic across calls/processes; 1-2 sessions inside HK window; never overlap; keys legal', () => {
  const now = new Date('2026-10-29T01:00:00Z'); // 09:00 HK
  const p1 = planWarmingDay({ identityId: ID_A, date: DATE, now });
  const p2 = planWarmingDay({ identityId: ID_A, date: DATE, now });
  assert.deepEqual(p1, p2, 'same seed => byte-identical plan (restart-safe)');

  const pB = planWarmingDay({ identityId: ID_B, date: DATE, now });
  assert.notDeepEqual(p1.sessions.map((s) => s.startAt), pB.sessions.map((s) => s.startAt), 'per-identity texture differs');

  for (const p of [p1, pB]) {
    assert.ok(p.sessions.length >= 1 && p.sessions.length <= 2);
    let prevEnd = -1;
    for (const s of p.sessions) {
      const hkMinutes = (new Date(s.startAt).getTime() + 8 * 3_600_000) / 60_000 % 1440;
      assert.ok(hkMinutes >= 9 * 60, `session starts >= 09:00 HK (${s.startAt})`);
      assert.ok(hkMinutes + s.durationMinutes <= 21 * 60, 'session ends <= 21:00 HK');
      assert.ok(s.durationMinutes >= 6 && s.durationMinutes <= 15, 'short session');
      assert.ok(hkMinutes >= prevEnd, 'sessions never overlap');
      prevEnd = hkMinutes + s.durationMinutes;
      assert.match(s.idempotencyKey, KEY_RE, 'createCycle idempotency contract');
      assert.equal(s.idempotencyKey, warmingIdempotencyKey(p.identityId, DATE, s.index));
      assert.ok(WARMING_TEMPLATE_NAMES.includes(s.template));
      const queryStep = s.steps.find((st) => st.action === 'type_query');
      if (queryStep) assert.ok(typeof queryStep.query === 'string' && queryStep.query.length > 0, 'seeded query resolves');
    }
  }
});

test('planWarmingDay: status due/future/missed honour the window + catch-up grace', () => {
  const early = new Date('2026-10-28T23:00:00Z'); // 07:00 HK — everything ahead
  const p1 = planWarmingDay({ identityId: ID_A, date: DATE, now: early });
  assert.ok(p1.sessions.every((s) => s.status === 'future'));
  const late = new Date('2026-10-29T14:00:00Z'); // 22:00 HK — everything > grace behind
  const p2 = planWarmingDay({ identityId: ID_A, date: DATE, now: late });
  assert.ok(p2.sessions.every((s) => s.status === 'missed'));
  // exactly at startAt -> due; 91 min later -> missed (grace boundary honest)
  const s0 = p1.sessions[0];
  const due = planWarmingDay({ identityId: ID_A, date: DATE, now: new Date(s0.startAt) }).sessions[0];
  assert.equal(due.status, 'due');
  const justLate = planWarmingDay({ identityId: ID_A, date: DATE, now: new Date(new Date(s0.startAt).getTime() + 91 * 60_000) }).sessions[0];
  assert.equal(justLate.status, 'missed');
});

test('readWarmingSchedule: fail-safe per-field, honest swap/clamp, AppSetting round-trip', async () => {
  const db = makeBatchFakeDb({});
  const defs = await readWarmingSchedule(db);
  assert.deepEqual({ ...defs }, { ...WARMING_SCHEDULE_DEFAULTS, source: 'default' });

  const set = async (value) => {
    await db.appSetting.upsert({ where: { key: 'warm.schedule' }, create: { key: 'warm.schedule', valueJson: { value } }, update: { valueJson: { value } } });
  };
  await set({ sessions_min: 2, sessions_max: 3, window_start_hour: 10, window_end_hour: 20 });
  assert.equal((await readWarmingSchedule(db)).source, 'appsetting');
  assert.deepEqual(await readWarmingSchedule(db), { sessionsMin: 2, sessionsMax: 3, windowStartHour: 10, windowEndHour: 20, source: 'appsetting' });

  await set({ sessions_min: 'two', window_end_hour: 42 }); // both bad -> defaults
  assert.equal((await readWarmingSchedule(db)).source, 'default');
  await set({ sessions_min: 3, sessions_max: 1 }); // min>max -> swap
  const swapped = await readWarmingSchedule(db);
  assert.deepEqual({ min: swapped.sessionsMin, max: swapped.sessionsMax }, { min: 1, max: 3 });
  await set({ window_start_hour: 18, window_end_hour: 6 }); // start>=end -> clamp start+1
  const clamped = await readWarmingSchedule(db);
  assert.equal(clamped.windowEndHour, 19);
  await set(null);
  assert.equal((await readWarmingSchedule(db)).source, 'default');
});

test('warmingBatchSpec: single identity, purpose warming (gate bypass label), template + steps ride in config', () => {
  const plan = planWarmingDay({ identityId: ID_A, date: DATE, now: new Date('2026-10-29T01:30:00Z'), template: 'search' });
  const spec = warmingBatchSpec({ identityId: ID_A, session: plan.sessions[0] });
  assert.equal(spec.identities.length, 1);
  assert.equal(spec.config.purpose, BATCH_PURPOSE.WARMING);
  assert.equal(spec.config.warmingTemplate, 'search');
  assert.ok(Array.isArray(spec.config.steps) && spec.config.steps.length > 0);
  assert.match(spec.name, /^warm /);
});

test('scheduler tick: promotes matured, dispatches due, replays are honest, poisoned account does not stop the farm', async () => {
  // Derive `now` from the SEED PLAN so the first session is exactly due —
  // the dispatch path must be exercised deterministically, not by luck.
  const seedNow = new Date('2026-10-29T00:00:00Z');
  const warming = { id: 'eeeeeeee-ffff-4aaa-8bbb-0000000000c3', externalRef: 'c', displayName: 'c', identityType: 'ACCOUNT', status: 'READY', dataPath: '/d/c', warmState: 'warming', warmStartedAt: new Date('2026-10-27T00:00:00Z') };
  const firstDue = planWarmingDay({ identityId: warming.id, date: DATE, now: seedNow }).sessions[0];
  const now = new Date(firstDue.startAt); // session 1 exactly due
  const matured = { id: ID_B, externalRef: 'b', displayName: 'b', identityType: 'ACCOUNT', status: 'READY', dataPath: '/d/b', warmState: 'warming', warmStartedAt: new Date('2026-10-01T00:00:00Z') };
  const coldIgnored = { id: ID_A, externalRef: 'a', displayName: 'a', identityType: 'ACCOUNT', status: 'READY', dataPath: '/d/a', warmState: 'cold' };
  const db = makeBatchFakeDb({ identities: [matured, coldIgnored, warming] });
  const batchService = createBatchService({ db, now: () => now });
  // Hand-rolled warm-state stub: ID_B is matured by any sane threshold.
  const warmStateService = {
    async promoteIfReady(identity) {
      const warm = identity.id === ID_B;
      return { effectiveState: warm ? 'warm' : 'warming', storedState: 'warming' };
    },
  };
  const sched = createWarmingScheduler({ db, batchService, warmStateService, now: () => now, log: { info() {}, warn() {}, error() {} } });

  const t1 = await sched.tick({ date: DATE });
  assert.equal(t1.promoted, 1, 'matured ID_B exits the pool');
  assert.equal(t1.considered, 2, 'cold identity is not even listed (where warmState=warming)');
  // ID_A(cold) skipped; only the warming account can dispatch — its seeded
  // sessions are either already due (dispatched[]) or still ahead (future
  // counter); "all missed" is impossible at 10:00 HK in a 09–21 window.
  assert.ok(t1.dispatched.length >= 1, `first session due => dispatches (got ${JSON.stringify(t1)})`);
  for (const key of t1.dispatched) {
    const row = await db.batch.findUnique({ where: { idempotencyKey: key } });
    assert.ok(row, 'dispatched session persisted via createCycle');
    assert.equal(row.configJson.purpose, 'warming');
  }
  const t2 = await sched.tick({ date: DATE });
  assert.equal(t2.dispatched.length, 0, 'second tick never double-books');
  assert.equal(t2.replayed.length, t1.dispatched.length, 'replays are counted honestly');

  // Poison path: a broken createCycle (DB hiccup / gate refusal) must be
  // COLLECTED, not thrown — one poisoned account never stops the farm.
  const broken = createWarmingScheduler({
    db,
    batchService: { async createCycle() { const e = new Error('db down'); e.apiCode = 'WARM_FAKE'; throw e; } },
    warmStateService,
    now: () => now,
    log: { info() {}, warn() {}, error() {} },
  });
  const t3 = await broken.tick({ date: DATE });
  assert.ok(Array.isArray(t3.errors) && t3.errors.length >= 0); // never throws
  const plan = planWarmingDay({ identityId: warming.id, date: DATE, now });
  const dueCount = plan.sessions.filter((s) => s.status === 'due').length;
  assert.equal(t3.errors.length, dueCount, 'every due dispatch attempt against a broken service reports exactly one error entry');
});

test('worker config: warming dispatcher is env-gated OFF by default', async () => {
  const { loadWorkerConfig } = await import('../../apps/worker/src/config.js');
  const base = loadWorkerConfig({});
  assert.equal(base.warmingSchedulerEnabled, false, 'DEFAULT OFF — real-stack behaviour ships with WA-ADVERSARIAL-FINAL');
  assert.equal(base.warmingSchedulerIntervalMs, 300_000);
  assert.equal(loadWorkerConfig({ WA_WARMING_SCHEDULE_ENABLED: 'true' }).warmingSchedulerEnabled, true);
  assert.equal(loadWorkerConfig({ WA_WARMING_SCHEDULE_ENABLED: '1' }).warmingSchedulerEnabled, true);
  assert.equal(loadWorkerConfig({ WA_WARMING_SCHEDULE_ENABLED: 'false' }).warmingSchedulerEnabled, false);
  assert.equal(loadWorkerConfig({ WA_WARMING_INTERVAL_MS: '60000' }).warmingSchedulerIntervalMs, 60_000);
});
