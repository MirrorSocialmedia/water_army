/**
 * P4 unit tests — schedule fire handler (fire → guards → overlap → createRun
 * idempotent → advance/finalize). All hermetic (fake db + fake queue +
 * real TaskRunService with a recording enqueue).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeFakeDb, makeFakeQueue, testConfig } from '../helpers/fakes.js';
import { createScheduleFireHandler } from '../../apps/worker/src/schedule-fire-handler.js';
import { createTaskRunService } from '@water-army/shared';
import { scheduleSlotKey, scheduleSkipKey, nextCronRun } from '@water-army/shared';

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const DEF_ID = '11111111-1111-4111-8111-111111111111';

async function mkEnv(scheduleOver = {}) {
  const db = makeFakeDb();
  const queue = makeFakeQueue();
  const provider = await db.providerConfig.create({
    data: { name: 'mock', baseUrl: 'http://127.0.0.1:9/v1', providerType: 'openai_compatible', timeoutMs: 10_000 },
  });
  await db.taskDefinition.create({
    data: {
      id: DEF_ID, title: 'Nightly check', providerConfigId: provider.id,
      promptTemplate: 'Check the fleet.', mode: 'analysis_only', timeoutMs: 30_000, maxAttempts: 2,
    },
  });
  const enqueued = [];
  const taskSvc = createTaskRunService({
    db, config: testConfig, log: silentLog,
    enqueue: async (job) => { enqueued.push(job); },
  });
  const schedule = await db.schedule.create({
    data: {
      name: 'fireme', taskDefinitionId: DEF_ID, scheduleType: 'cron',
      cronExpression: '0 9 * * *', timezone: 'Asia/Taipei', overlapPolicy: 'skip_if_running',
      isEnabled: true, nextRunAt: new Date('2026-10-15T01:00:00.000Z'), syncStatus: 'synced',
      ...scheduleOver,
    },
  });
  const handler = createScheduleFireHandler({ db, taskSvc, queue, log: silentLog });
  return { db, queue, taskSvc, schedule, enqueued, handler, provider };
}

// schedHash is OPTIONAL in the payload: absent = "no generation stamp" →
// proceed (pre-stamp jobs / delayed once jobs). A PRESENT hash that mismatches
// the live row is a stale-generation fire (dropped + self-removal).
const fireJob = (scheduleId, slotMs, over = {}) => ({
  id: `fire-${slotMs}`,
  name: 'schedule-fire',
  data: { scheduleId, ...over.data },
  opts: over.opts ?? { prevMillis: slotMs },
});
test('cron fire: run created with slot idempotency key + lineage; next_run_at advances to the NEXT slot', async () => {
  const slotMs = new Date('2026-10-15T01:00:00.000Z').getTime();
  const { db, handler, enqueued, schedule } = await mkEnv();
  const result = await handler.handleFireJob(fireJob(schedule.id, slotMs, { data: {} }));

  assert.equal(result.outcome, 'fired');
  assert.equal(enqueued.length, 1, 'exactly one task-run job enqueued');

  const runs = await db.taskRun.findMany({ where: { scheduleId: schedule.id } });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'queued');
  assert.equal(runs[0].idempotencyKey, scheduleSlotKey(schedule.id, slotMs));
  assert.equal(runs[0].taskDefinitionId, DEF_ID);
  assert.equal(runs[0].inputJson.scheduledSlotAt, '2026-10-15T01:00:00.000Z');

  const row = await db.schedule.findUnique({ where: { id: schedule.id } });
  assert.equal(row.lastRunAt.toISOString(), '2026-10-15T01:00:00.000Z');
  assert.equal(row.lastStatus, 'queued');
  const expectedNext = nextCronRun('0 9 * * *', 'Asia/Taipei', new Date(slotMs)).getTime();
  assert.equal(new Date(row.nextRunAt).getTime(), expectedNext, 'next slot = cron next AFTER this slot (not now)');
});

test('redelivered fire of the SAME slot → replay: one run, one enqueue (零重複, 硬驗收)', async () => {
  const slotMs = new Date('2026-10-15T01:00:00.000Z').getTime();
  const { db, handler, enqueued, schedule } = await mkEnv();
  const first = await handler.handleFireJob(fireJob(schedule.id, slotMs, { data: {} }));
  // Crash window: next_run_at was advanced, but imagine the same slot's job
  // is redelivered (the advance write raced). The idempotency key must win.
  await db.schedule.update({ where: { id: schedule.id }, data: { nextRunAt: new Date('2026-10-15T01:00:00.000Z') } });
  const second = await handler.handleFireJob(fireJob(schedule.id, slotMs, { data: {} }));

  assert.equal(first.outcome, 'fired');
  assert.equal(second.outcome, 'replayed');
  assert.equal(second.runId, first.runId, 'same run row');
  assert.equal((await db.taskRun.findMany({ where: { scheduleId: schedule.id } })).length, 1);
  assert.equal(enqueued.length, 1, 'no second job');
});

test('fire for an already-ADVANCED slot (beyond tolerance) → dropped, no run', async () => {
  const slotMs = new Date('2026-10-15T01:00:00.000Z').getTime();
  const { db, handler, schedule } = await mkEnv({
    nextRunAt: new Date('2026-10-16T01:00:00.000Z'), // one day ahead of the fired slot
  });
  const result = await handler.handleFireJob(fireJob(schedule.id, slotMs, { data: {} }));
  assert.equal(result.outcome, 'skipped-stale-slot');
  assert.equal((await db.taskRun.findMany({ where: { scheduleId: schedule.id } })).length, 0);
});

test('fire for a DELETED schedule → dropped (idempotent no-op)', async () => {
  const slotMs = new Date('2026-10-15T01:00:00.000Z').getTime();
  const { db, handler, schedule } = await mkEnv();
  await db.schedule.delete({ where: { id: schedule.id } });
  const result = await handler.handleFireJob(fireJob(schedule.id, slotMs, { data: {} }));
  assert.equal(result.outcome, 'skipped-gone');
});

test('fire for a DISABLED schedule → dropped (safe direction)', async () => {
  const slotMs = new Date('2026-10-15T01:00:00.000Z').getTime();
  const { db, handler, schedule } = await mkEnv({ isEnabled: false });
  const result = await handler.handleFireJob(fireJob(schedule.id, slotMs, { data: {} }));
  assert.equal(result.outcome, 'skipped-disabled');
  assert.equal((await db.taskRun.findMany({ where: { scheduleId: schedule.id } })).length, 0);
});

test('stale generation (schedHash mismatch) → dropped + stale index entry self-removed', async () => {
  const slotMs = new Date('2026-10-15T01:00:00.000Z').getTime();
  const { db, queue, handler, schedule } = await mkEnv();
  await queue.upsertJobScheduler(`sched-${schedule.id}`, { pattern: '0 8 * * *' }, { name: 'schedule-fire', data: {} });

  const result = await handler.handleFireJob(fireJob(schedule.id, slotMs, { data: { schedHash: 'deadbeefdeadbeef' } }));
  assert.equal(result.outcome, 'skipped-stale');
  assert.equal((await db.taskRun.findMany({ where: { scheduleId: schedule.id } })).length, 0, 'no run from a stale cadence');
  assert.equal(queue.schedulers.has(`sched-${schedule.id}`), false, 'stale index entry self-removed (reconciler backstop)');
});

test('overlap skip_if_running: active run → terminal skipped row + slot consumed, NO enqueue', async () => {
  const slotMs = new Date('2026-10-15T01:00:00.000Z').getTime();
  const { db, handler, enqueued, schedule } = await mkEnv();
  // An active run of this schedule (e.g. a long-running previous slot).
  const activeRun = await db.taskRun.create({
    data: { status: 'running', inputJson: { prompt: 'long' }, scheduleId: schedule.id, taskDefinitionId: DEF_ID },
  });

  const result = await handler.handleFireJob(fireJob(schedule.id, slotMs, { data: {} }));
  assert.equal(result.outcome, 'skipped-overlap');
  assert.equal(enqueued.length, 0, 'a skipped slot never touches the queue');

  const rows = await db.taskRun.findMany({ where: { scheduleId: schedule.id } });
  assert.equal(rows.length, 2, 'active run + skipped slot row');
  const skipped = rows.find((r) => r.status === 'skipped');
  assert.ok(skipped, 'skipped run row exists (MD §12.3 解釋被略過原因)');
  assert.equal(result.runId, skipped.id, 'the handler returns the skipped row it created');
  assert.equal(skipped.idempotencyKey, scheduleSkipKey(schedule.id, slotMs));
  assert.match(skipped.inputJson.skipped.reason, /skip_if_running/);
  assert.equal(skipped.inputJson.skipped.activeRunId, activeRun.id);
  assert.ok(skipped.finishedAt, 'skipped is terminal at birth');

  const row = await db.schedule.findUnique({ where: { id: schedule.id } });
  const expectedNext = nextCronRun('0 9 * * *', 'Asia/Taipei', new Date(slotMs)).getTime();
  assert.equal(new Date(row.nextRunAt).getTime(), expectedNext, 'the slot is consumed even when skipped');
});

test('overlap queue policy: active run → the new run is STILL created (queued behind the cap)', async () => {
  const slotMs = new Date('2026-10-15T01:00:00.000Z').getTime();
  const { db, handler, enqueued, schedule } = await mkEnv({ overlapPolicy: 'queue' });
  await db.taskRun.create({
    data: { status: 'running', inputJson: { prompt: 'long' }, scheduleId: schedule.id, taskDefinitionId: DEF_ID },
  });
  const result = await handler.handleFireJob(fireJob(schedule.id, slotMs, { data: {} }));
  assert.equal(result.outcome, 'fired', 'queue policy enqueues regardless');
  assert.equal(enqueued.length, 1);
});

test('once fire: run created + schedule self-disabled + next_run_at cleared (硬驗收 2)', async () => {
  const runAt = '2026-10-15T01:00:00.000Z';
  const slotMs = new Date(runAt).getTime();
  const { db, handler, enqueued, schedule } = await mkEnv({
    scheduleType: 'once', cronExpression: null, nextRunAt: new Date(runAt),
  });
  const result = await handler.handleFireJob({
    id: 'fire-once', name: 'schedule-fire',
    data: { scheduleId: schedule.id, scheduledAt: runAt, once: true },
    opts: {},
  });
  assert.equal(result.outcome, 'fired');
  assert.equal(enqueued.length, 1);

  const row = await db.schedule.findUnique({ where: { id: schedule.id } });
  assert.equal(row.isEnabled, false, 'once schedule disables itself after its single fire');
  assert.equal(row.nextRunAt, null, 'no future slot');
  assert.equal(row.lastRunAt.toISOString(), runAt);
});

test('provider disabled at fire time → aborted, NO run, slot NOT consumed (next slot retries)', async () => {
  const slotMs = new Date('2026-10-15T01:00:00.000Z').getTime();
  const { db, handler, schedule, provider } = await mkEnv();
  await db.providerConfig.update({ where: { id: provider.id }, data: { isEnabled: false } });

  const result = await handler.handleFireJob(fireJob(schedule.id, slotMs, { data: {} }));
  assert.equal(result.outcome, 'aborted-provider');
  assert.equal((await db.taskRun.findMany({ where: { scheduleId: schedule.id } })).length, 0);
  const row = await db.schedule.findUnique({ where: { id: schedule.id } });
  assert.equal(row.isEnabled, true, 'schedule stays enabled — operator fixes the provider');
  assert.equal(new Date(row.nextRunAt).toISOString(), '2026-10-15T01:00:00.000Z', 'slot not consumed');
});
