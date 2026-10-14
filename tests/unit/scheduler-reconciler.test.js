/**
 * P4 unit tests — scheduler-reconciler (MD §12.1: PG 為準 + BullMQ index
 * 冪等核對, 重啟零重複). All hermetic (fake db + fake queue).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeFakeDb, makeFakeQueue } from '../helpers/fakes.js';
import { createSchedulerReconciler } from '../../apps/worker/src/scheduler-reconciler.js';
import { schedulerIdFor, SCHEDULE_FIRE_JOB_NAME } from '@water-army/shared';

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

async function mkEnv({ schedules = [], queue = makeFakeQueue() } = {}) {
  const db = makeFakeDb();
  for (const s of schedules) await db.schedule.create({ data: s });
  const reconciler = createSchedulerReconciler({ db, queue, log: silentLog });
  return { db, queue, reconciler };
}

const CRON = (over = {}) => ({
  name: 'daily',
  taskDefinitionId: '11111111-1111-4111-8111-111111111111',
  scheduleType: 'cron',
  cronExpression: '0 9 * * *',
  timezone: 'Asia/Taipei',
  overlapPolicy: 'skip_if_running',
  isEnabled: true,
  nextRunAt: new Date('2026-10-16T01:00:00.000Z'),
  syncStatus: 'synced',
  ...over,
});

test('missing index entries are created (one per enabled non-once schedule)', async () => {
  const { queue, reconciler } = await mkEnv({
    schedules: [CRON({ name: 'a' }), CRON({ name: 'b', cronExpression: '*/5 * * * *' })],
  });
  const r = await reconciler.reconcile();
  assert.equal(r.created, 2);
  assert.equal(r.kept, 0);
  assert.equal(queue.schedulers.size, 2, 'index has exactly the enabled schedules');
});

test('matching index entries are kept (no write churn)', async () => {
  const { queue, reconciler } = await mkEnv({ schedules: [CRON({ name: 'a' })] });
  await reconciler.reconcile();
  const r2 = await reconciler.reconcile();
  assert.equal(r2.kept, 1);
  assert.equal(r2.created, 0);
  assert.equal(r2.driftFixed, 0);
  assert.equal(r2.removed, 0);
  assert.equal(queue.schedulers.size, 1);
});

test('drifted params are re-upserted IN PLACE — same key, 零重複 (硬驗收 3)', async () => {
  const { queue, reconciler } = await mkEnv({ schedules: [CRON({ name: 'a' })] });
  await reconciler.reconcile();
  const key = [...queue.schedulers.keys()][0];

  // Simulate a PATCH whose re-upsert failed (sync_error window): the DB row
  // says '0 9 * * *' but the index still carries an older pattern.
  const entry = queue.schedulers.get(key);
  entry.pattern = '0 8 * * *'; // stale

  const r = await reconciler.reconcile();
  assert.equal(r.driftFixed, 1);
  assert.equal(r.created, 0, 'drift is an in-place override, not a create');
  assert.equal(queue.schedulers.size, 1, 'exactly ONE index entry — zero duplicates');
  assert.equal(queue.schedulers.get(key).pattern, '0 9 * * *', 'index now matches the DB');
});

test('orphan schedulers (sched- prefix, no matching enabled row) are removed', async () => {
  const { queue, reconciler } = await mkEnv({ schedules: [CRON({ name: 'a' })] });
  await queue.upsertJobScheduler('sched-deadbeef-dead-4ead-8ead-deadbeefdead', { pattern: '* * * * *' }, {
    name: SCHEDULE_FIRE_JOB_NAME, data: {},
  });
  const r = await reconciler.reconcile();
  assert.equal(r.removed, 1);
  assert.equal(queue.schedulers.has('sched-deadbeef-dead-4ead-8ead-deadbeefdead'), false);
  assert.equal(queue.schedulers.size, 1, 'the live one survives');
});

test('foreign (non-sched- prefixed) index entries are NEVER touched', async () => {
  const { queue, reconciler } = await mkEnv({ schedules: [] });
  await queue.upsertJobScheduler('other-namespace-1', { every: 60_000 }, { name: 'x', data: {} });
  const r = await reconciler.reconcile();
  assert.equal(r.removed, 0);
  assert.ok(queue.schedulers.has('other-namespace-1'), 'foreign entry untouched');
});

test('a disabled schedule leaves NO index entry (pause consistency)', async () => {
  const { db, queue, reconciler } = await mkEnv({
    schedules: [CRON({ name: 'paused', isEnabled: false })],
  });
  const row = (await db.schedule.findMany())[0];
  // Simulate a pause whose removeJobScheduler failed (index lingers).
  await queue.upsertJobScheduler(schedulerIdFor(row.id), { pattern: '0 9 * * *' }, {
    name: SCHEDULE_FIRE_JOB_NAME, data: {},
  });
  await reconciler.reconcile();
  assert.equal(queue.schedulers.size, 0, 'disabled schedule has no index entry after reconcile');
});

test('once schedule: missing delayed job is re-added; a second pass does NOT duplicate', async () => {
  const runAt = new Date(Date.now() + 120_000).toISOString();
  const { queue, reconciler } = await mkEnv({
    schedules: [{
      name: 'oneshot',
      taskDefinitionId: '11111111-1111-4111-8111-111111111111',
      scheduleType: 'once',
      timezone: 'Asia/Taipei',
      overlapPolicy: 'skip_if_running',
      isEnabled: true,
      nextRunAt: new Date(runAt),
      syncStatus: 'synced',
    }],
  });
  const r = await reconciler.reconcile();
  assert.equal(r.created, 1);
  const r2 = await reconciler.reconcile();
  assert.equal(r2.created, 0, 'idempotent — the once job is not re-created (same deterministic id)');
  const fireJobs = (await queue.getJobs(['delayed'])).filter((j) => j.name === SCHEDULE_FIRE_JOB_NAME);
  assert.equal(fireJobs.length, 1, 'exactly one delayed fire job');
});

test('orphaned delayed fire jobs (schedule gone) are removed', async () => {
  const { queue, reconciler } = await mkEnv({ schedules: [] });
  await queue.add(SCHEDULE_FIRE_JOB_NAME, { scheduleId: '99999999-9999-4999-8999-999999999999', once: true }, {
    jobId: 'schedonce-99999999-9999-4999-8999-999999999999-1',
    delay: 120_000,
  });
  const r = await reconciler.reconcile();
  assert.equal(r.orphanJobs, 1);
  const remaining = (await queue.getJobs(['delayed'])).filter((j) => j.name === SCHEDULE_FIRE_JOB_NAME);
  assert.equal(remaining.length, 0, 'orphan once-job swept');
});

test('sync_status self-heal: a fully-converged pass flips sync_error → synced', async () => {
  const { db, reconciler } = await mkEnv({
    schedules: [CRON({ name: 'was-broken', syncStatus: 'sync_error' })],
  });
  const r = await reconciler.reconcile();
  assert.equal(r.healedSync, 1);
  const row = (await db.schedule.findMany())[0];
  assert.equal(row.syncStatus, 'synced', 'index now matches → honestly synced');
});

test('a failed pass (redis down) throws and touches NOTHING (no false sync_status)', async () => {
  const { db, queue, reconciler } = await mkEnv({
    schedules: [CRON({ name: 'x', syncStatus: 'sync_error' })],
  });
  queue.__setSchedulerDown(true);
  await assert.rejects(() => reconciler.reconcile());
  const row = (await db.schedule.findMany())[0];
  assert.equal(row.syncStatus, 'sync_error', 'a failed pass must not claim success');
});

test('convergence: repeated passes from an empty index reach exactly {enabled} (零重複 invariant)', async () => {
  const { queue, reconciler } = await mkEnv({
    schedules: [CRON({ name: 'a' }), CRON({ name: 'b' }), CRON({ name: 'c' })],
  });
  await reconciler.reconcile();
  await reconciler.reconcile();
  await reconciler.reconcile();
  assert.equal(queue.schedulers.size, 3, 'index count == DB enabled count after repeated passes');
});
