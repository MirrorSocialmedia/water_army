/**
 * P4 unit tests — schedule-service (PG-first → BullMQ sync, sync_status state
 * machine, timezone next-run, lifecycle) + the shared createRun/
 * createSkippedRun extensions. All hermetic (fake db + fake queue).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeFakeDb, makeFakeQueue, testConfig } from '../helpers/fakes.js';
import { createScheduleService, ScheduleError } from '../../apps/api/src/services/schedule-service.js';
import { createTaskRunService } from '@water-army/shared';
import {
  schedulerIdFor,
  onceFireJobId,
  SCHEDULE_FIRE_JOB_NAME,
} from '@water-army/shared';

// The fail-fast sync guard (schedule-service.js) reads this at factory time.
// Keep it tiny in unit tests so a stuck sync can never slow the suite down.
process.env.SCHEDULE_SYNC_TIMEOUT_MS = '50';

// -------------------------------------------------------------------- setup
async function mkEnv(overrides = {}) {
  const db = makeFakeDb({
    users: [{ id: 'admin-1', username: 'admin', passwordHash: 'x', role: 'admin' }],
  });
  const queue = makeFakeQueue();

  // One provider + one task definition for the run-now / lineage tests.
  const provider = await awaitProvider(db);
  const def = await awaitDef(db, provider);
  const enqueued = [];
  const taskSvc = createTaskRunService({
    db,
    config: testConfig,
    log: silentLog,
    enqueue: async (job) => {
      enqueued.push(job);
    },
  });
  const svc = createScheduleService({
    db,
    queue,
    config: { defaultTimezone: 'Asia/Taipei', scheduleMinIntervalMs: 10_000 },
    log: silentLog,
    taskSvc,
  });
  return { db, queue, svc, taskSvc, provider, def, enqueued };
}

async function awaitProvider(db) {
  return db.providerConfig.create({
    data: { name: 'mock', baseUrl: 'http://127.0.0.1:9/v1', providerType: 'openai_compatible', timeoutMs: 10_000 },
  });
}

async function awaitDef(db, provider) {
  return db.taskDefinition.create({
    data: {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Nightly check',
      providerConfigId: provider.id,
      promptTemplate: 'Check the fleet and report.',
      mode: 'analysis_only',
      timeoutMs: 30_000,
      maxAttempts: 2,
    },
  });
}

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const USER = { id: 'admin-1', username: 'admin' };
const DEF_ID = '11111111-1111-4111-8111-111111111111';

// -------------------------------------------------------------------- create
test('create cron: PG row + upsert with pattern+tz, next_run_at in schedule timezone', async () => {
  const { db, queue, svc } = await mkEnv();
  const { schedule } = await svc.create(
    { name: 'daily 09:00 TPE', taskDefinitionId: DEF_ID, scheduleType: 'cron', cronExpression: '0 9 * * *', timezone: 'Asia/Taipei' },
    USER,
  );

  assert.equal(schedule.syncStatus, 'synced');
  assert.equal(schedule.isEnabled, true);
  const entry = queue.schedulers.get(schedulerIdFor(schedule.id));
  assert.ok(entry, 'scheduler upserted with stable sched-<id> key');
  assert.equal(entry.pattern, '0 9 * * *');
  assert.equal(entry.tz, 'Asia/Taipei');
  assert.equal(entry.template.data.scheduleId, schedule.id);
  assert.equal(entry.name, SCHEDULE_FIRE_JOB_NAME);

  // next_run_at must be 09:00 in Asia/Taipei (= 01:00 UTC) of the next day it applies.
  const next = new Date(schedule.nextRunAt);
  assert.equal(next.getUTCHours(), 1);
  assert.equal(next.getUTCMinutes(), 0);

  const row = await db.schedule.findUnique({ where: { id: schedule.id } });
  assert.equal(row.syncStatus, 'synced');
});

test('create interval: every=ms, next_run_at = now + intervalMs', async () => {
  const { queue, svc } = await mkEnv();
  const before = Date.now();
  const { schedule } = await svc.create(
    { name: 'every 30s', taskDefinitionId: DEF_ID, scheduleType: 'interval', intervalMs: 30_000 },
    USER,
  );
  const entry = queue.schedulers.get(schedulerIdFor(schedule.id));
  assert.ok(entry);
  assert.equal(entry.every, 30_000);
  assert.equal(entry.pattern, null);
  const next = new Date(schedule.nextRunAt).getTime();
  assert.ok(next >= before + 30_000 - 500 && next <= before + 30_000 + 5_000, `next=${next} before=${before}`);
});

test('create once: delayed job (deterministic jobId), NOT a job scheduler', async () => {
  const { queue, svc } = await mkEnv();
  const runAt = new Date(Date.now() + 60_000).toISOString();
  const { schedule } = await svc.create(
    { name: 'one shot', taskDefinitionId: DEF_ID, scheduleType: 'once', runAt },
    USER,
  );
  assert.equal(new Date(schedule.nextRunAt).toISOString(), runAt);
  assert.equal(queue.schedulers.size, 0, 'once must not use the job scheduler index');
  const jobId = onceFireJobId(schedule.id, new Date(runAt).getTime());
  const job = queue.jobs.get(jobId);
  assert.ok(job, 'delayed fire job present with deterministic id');
  assert.equal(job.data.once, true);
  assert.equal(job.data.scheduledAt, runAt);
  assert.ok(job.opts.delay > 0 && job.opts.delay <= 60_000);
});

test('create validation: bad cron / bad tz / interval too small / once in past / missing definition', async () => {
  const { svc } = await mkEnv();
  const base = { name: 'x', taskDefinitionId: DEF_ID };
  for (const [label, body, msg] of [
    ['bad cron', { ...base, scheduleType: 'cron', cronExpression: 'not a cron' }, 'cron'],
    ['6-field cron', { ...base, scheduleType: 'cron', cronExpression: '0 0 * * * *' }, '5 fields'],
    ['bad tz', { ...base, scheduleType: 'cron', cronExpression: '0 9 * * *', timezone: 'Not/AZone' }, 'timezone'],
    ['interval too small', { ...base, scheduleType: 'interval', intervalMs: 500 }, 'minimum'],
    ['once in past', { ...base, scheduleType: 'once', runAt: new Date(Date.now() - 1000).toISOString() }, 'future'],
    ['once missing runAt', { ...base, scheduleType: 'once' }, 'runAt'],
    ['bad type', { ...base, scheduleType: 'weekly' }, 'scheduleType'],
    ['missing definition', { ...base, scheduleType: 'interval', intervalMs: 60_000, taskDefinitionId: '99999999-9999-4999-8999-999999999999' }, 'not found'],
  ]) {
    await assert.rejects(
      () => svc.create(body, USER),
      (err) => {
        assert.ok(err instanceof ScheduleError, `${label}: expected ScheduleError, got ${err?.name}`);
        assert.equal(err.statusCode, 400, `${label}: expected 400`);
        assert.match(err.message, new RegExp(msg));
        return true;
      },
      label,
    );
  }
});

test('create duplicate name → 409 SCHEDULE_NAME_TAKEN', async () => {
  const { svc } = await mkEnv();
  const body = { name: 'dup', taskDefinitionId: DEF_ID, scheduleType: 'interval', intervalMs: 60_000 };
  await svc.create(body, USER);
  await assert.rejects(() => svc.create(body, USER), (err) => err.apiCode === 'SCHEDULE_NAME_TAKEN' && err.statusCode === 409);
});

// ------------------------------------------------------- PG-first + sync_error
test('PG-first: queue down at create → row exists with sync_status=sync_error (no crash, no rollback)', async () => {
  const { db, queue, svc } = await mkEnv();
  queue.__setSchedulerDown(true);
  const { schedule } = await svc.create(
    { name: 'will desync', taskDefinitionId: DEF_ID, scheduleType: 'cron', cronExpression: '* * * * *' },
    USER,
  );
  assert.equal(schedule.syncStatus, 'sync_error', 'DB row stands; sync flagged');
  const row = await db.schedule.findUnique({ where: { id: schedule.id } });
  assert.equal(row.isEnabled, true);
  assert.equal(row.syncStatus, 'sync_error');
  assert.ok(row.nextRunAt, 'next_run_at still computed from PG data');
});

test('sync retry heals sync_error once the queue recovers', async () => {
  const { db, queue, svc } = await mkEnv();
  queue.__setSchedulerDown(true);
  const { schedule } = await svc.create(
    { name: 'retry-me', taskDefinitionId: DEF_ID, scheduleType: 'cron', cronExpression: '* * * * *' },
    USER,
  );
  assert.equal((await db.schedule.findUnique({ where: { id: schedule.id } })).syncStatus, 'sync_error');

  queue.__setSchedulerDown(false);
  const { schedule: healedSched, healed } = await svc.sync(schedule.id, USER);
  assert.equal(healed, true);
  assert.equal(healedSched.syncStatus, 'synced');
  assert.ok(queue.schedulers.has(schedulerIdFor(schedule.id)));
});

test('sync retry while queue still down → healed=false + row stays sync_error (route maps to 503)', async () => {
  const { db, queue, svc } = await mkEnv();
  queue.__setSchedulerDown(true);
  const { schedule } = await svc.create(
    { name: 'still-down', taskDefinitionId: DEF_ID, scheduleType: 'interval', intervalMs: 60_000 },
    USER,
  );
  // The service reports failure honestly (no throw — the HTTP layer turns
  // healed=false into the 503 envelope); the row stays retryable.
  const { schedule: after, healed } = await svc.sync(schedule.id, USER);
  assert.equal(healed, false);
  assert.equal(after.syncStatus, 'sync_error');
  assert.equal((await db.schedule.findUnique({ where: { id: schedule.id } })).syncStatus, 'sync_error');
});

// ------------------------------------------------------------------- pause
test('pause: DB disabled + scheduler removed; idempotent second pause', async () => {
  const { db, queue, svc } = await mkEnv();
  const { schedule } = await svc.create(
    { name: 'pausable', taskDefinitionId: DEF_ID, scheduleType: 'cron', cronExpression: '*/5 * * * *' },
    USER,
  );
  assert.ok(queue.schedulers.has(schedulerIdFor(schedule.id)));

  const first = await svc.pause(schedule.id, USER);
  assert.equal(first.changed, true);
  assert.equal(first.schedule.isEnabled, false);
  assert.equal(first.schedule.syncStatus, 'synced');
  assert.equal(queue.schedulers.has(schedulerIdFor(schedule.id)), false, 'scheduler removed from BullMQ');

  const second = await svc.pause(schedule.id, USER);
  assert.equal(second.changed, false, 'idempotent');
});

test('pause with queue down → sync_error (safe direction: fire handler guards on DB)', async () => {
  const { db, queue, svc } = await mkEnv();
  const { schedule } = await svc.create(
    { name: 'pause-desync', taskDefinitionId: DEF_ID, scheduleType: 'cron', cronExpression: '* * * * *' },
    USER,
  );
  queue.__setSchedulerDown(true);
  const { schedule: paused } = await svc.pause(schedule.id, USER);
  assert.equal(paused.isEnabled, false, 'DB row is paused regardless');
  assert.equal(paused.syncStatus, 'sync_error', 'leftover scheduler flagged for retry');
  const row = await db.schedule.findUnique({ where: { id: schedule.id } });
  assert.equal(row.isEnabled, false);
});

// ------------------------------------------------------------------- resume
test('resume: re-enables + re-upserts; stale next_run_at recomputed', async () => {
  const { db, queue, svc } = await mkEnv();
  const { schedule } = await svc.create(
    { name: 'resumable', taskDefinitionId: DEF_ID, scheduleType: 'interval', intervalMs: 60_000 },
    USER,
  );
  await svc.pause(schedule.id, USER);

  // Age the stored next_run_at into the past (simulates days-late resume).
  await db.schedule.update({
    where: { id: schedule.id },
    data: { nextRunAt: new Date(Date.now() - 3_600_000) },
  });

  const { schedule: resumed } = await svc.resume(schedule.id, USER);
  assert.equal(resumed.isEnabled, true);
  assert.ok(new Date(resumed.nextRunAt).getTime() > Date.now(), 'stale next_run_at recomputed to the future');
  assert.ok(queue.schedulers.has(schedulerIdFor(schedule.id)), 'scheduler re-upserted');
});

test('resume idempotent when already enabled; heals sync_error as a side effect', async () => {
  const { db, queue, svc } = await mkEnv();
  const { schedule } = await svc.create(
    { name: 'resume-2', taskDefinitionId: DEF_ID, scheduleType: 'cron', cronExpression: '* * * * *' },
    USER,
  );
  const first = await svc.resume(schedule.id, USER);
  assert.equal(first.changed, false);

  // Corrupt the index + mark sync_error; resume must heal (upsert is idempotent).
  queue.schedulers.delete(schedulerIdFor(schedule.id));
  await db.schedule.update({ where: { id: schedule.id }, data: { syncStatus: 'sync_error' } });
  const { schedule: healedSched } = await svc.resume(schedule.id, USER);
  assert.equal(healedSched.syncStatus, 'synced');
  assert.ok(queue.schedulers.has(schedulerIdFor(schedule.id)));
});

// ------------------------------------------------------------------- modify
test('modify cron expression → next_run_at recomputed + scheduler re-upserted (same key, no dupes)', async () => {
  const { queue, svc } = await mkEnv();
  const { schedule } = await svc.create(
    { name: 'mod', taskDefinitionId: DEF_ID, scheduleType: 'cron', cronExpression: '0 9 * * *', timezone: 'Asia/Taipei' },
    USER,
  );
  const key = schedulerIdFor(schedule.id);
  assert.equal(queue.schedulers.size, 1);

  const { schedule: updated, changes } = await svc.update(
    schedule.id,
    { cronExpression: '30 22 * * *', timezone: 'America/New_York' },
    USER,
  );
  assert.ok(changes.includes('scheduling(next_run_at recomputed)'));
  assert.equal(queue.schedulers.size, 1, 'same scheduler key — override in place, zero duplicates');
  const entry = queue.schedulers.get(key);
  assert.equal(entry.pattern, '30 22 * * *');
  assert.equal(entry.tz, 'America/New_York');
  assert.ok(new Date(updated.nextRunAt).getTime() > Date.now());
});

test('modify once runAt → old delayed job removed, new one added', async () => {
  const { queue, svc } = await mkEnv();
  const runAt = new Date(Date.now() + 120_000).toISOString();
  const { schedule } = await svc.create(
    { name: 'once-mod', taskDefinitionId: DEF_ID, scheduleType: 'once', runAt },
    USER,
  );
  const oldJobId = onceFireJobId(schedule.id, new Date(runAt).getTime());
  assert.ok(queue.jobs.has(oldJobId));

  const newRunAt = new Date(Date.now() + 300_000).toISOString();
  await svc.update(schedule.id, { runAt: newRunAt }, USER);
  assert.equal(queue.jobs.has(oldJobId), false, 'stale slot job removed (else the old time would still fire)');
  const newJobId = onceFireJobId(schedule.id, new Date(newRunAt).getTime());
  assert.ok(queue.jobs.has(newJobId), 'new slot job added');
  assert.equal(queue.jobs.get(newJobId).data.scheduledAt, newRunAt);
});

test('modify validation: bad cron rejected, row untouched', async () => {
  const { db, svc } = await mkEnv();
  const { schedule } = await svc.create(
    { name: 'mod2', taskDefinitionId: DEF_ID, scheduleType: 'cron', cronExpression: '0 9 * * *' },
    USER,
  );
  await assert.rejects(
    () => svc.update(schedule.id, { cronExpression: 'garbage' }, USER),
    (err) => err.statusCode === 400,
  );
  const row = await db.schedule.findUnique({ where: { id: schedule.id } });
  assert.equal(row.cronExpression, '0 9 * * *', 'failed patch must not mutate the row');
});

// ------------------------------------------------------------------- run-now
test('run-now: manual fire creates a run with schedule lineage + idempotent on Idempotency-Key', async () => {
  const { db, enqueued, svc } = await mkEnv();
  const { schedule } = await svc.create(
    { name: 'runnow', taskDefinitionId: DEF_ID, scheduleType: 'interval', intervalMs: 60_000 },
    USER,
  );

  const first = await svc.runNow(schedule.id, USER, { idempotencyKey: 'runnow-key-test-1' });
  assert.equal(first.replay, false);
  assert.equal(first.run.scheduleId, schedule.id);
  assert.equal(first.run.taskDefinitionId, DEF_ID);
  assert.equal(first.run.idempotencyKey, 'runnow-key-test-1');
  assert.equal(first.run.status, 'queued');
  assert.equal(enqueued.length, 1, 'manual fire enqueues exactly one job');

  // Same key → replay of the SAME run (no second job, no second row).
  const second = await svc.runNow(schedule.id, USER, { idempotencyKey: 'runnow-key-test-1' });
  assert.equal(second.replay, true);
  assert.equal(second.run.id, first.run.id);
  assert.equal(enqueued.length, 1);

  // A different key → a different run (manual fires never collide with each
  // other, and the namespace (runnow-) never collides with auto (sched-)).
  const third = await svc.runNow(schedule.id, USER, {});
  assert.equal(third.replay, false);
  assert.notEqual(third.run.id, first.run.id);
  assert.match(third.run.idempotencyKey, /^runnow-/);

  // last_run bookkeeping updated.
  const row = await db.schedule.findUnique({ where: { id: schedule.id } });
  assert.equal(row.lastStatus, 'queued');
  assert.ok(row.lastRunAt);
});

test('run-now with disabled provider → 409 PROVIDER_NOT_CONFIGURED (fail closed, like P3 create)', async () => {
  const { db, svc } = await mkEnv();
  const { schedule } = await svc.create(
    { name: 'dead-prov', taskDefinitionId: DEF_ID, scheduleType: 'interval', intervalMs: 60_000 },
    USER,
  );
  const provs = await db.providerConfig.findMany();
  for (const p of provs) await db.providerConfig.update({ where: { id: p.id }, data: { isEnabled: false } });
  await assert.rejects(
    () => svc.runNow(schedule.id, USER, {}),
    (err) => err.apiCode === 'PROVIDER_NOT_CONFIGURED' && err.statusCode === 409,
  );
});

// -------------------------------------------------------------------- delete
test('delete: scheduler removed + row gone; history runs keep lineage (no FK)', async () => {
  const { db, queue, svc } = await mkEnv();
  const { schedule } = await svc.create(
    { name: 'deletable', taskDefinitionId: DEF_ID, scheduleType: 'cron', cronExpression: '* * * * *' },
    USER,
  );
  await svc.runNow(schedule.id, USER, { idempotencyKey: 'runnow-dele-test1' });
  const { deleted, schedulerRemoved } = await svc.remove(schedule.id, USER);
  assert.equal(deleted, true);
  assert.equal(schedulerRemoved, true);
  assert.equal(await db.schedule.findUnique({ where: { id: schedule.id } }), null);
  const runs = await db.taskRun.findMany({ where: { scheduleId: schedule.id } });
  assert.equal(runs.length, 1, 'run rows survive (schedule_id is not an FK)');
});

test('delete with queue down: row still deleted (orphan sweep is the backstop)', async () => {
  const { db, queue, svc } = await mkEnv();
  const { schedule } = await svc.create(
    { name: 'del-desync', taskDefinitionId: DEF_ID, scheduleType: 'cron', cronExpression: '* * * * *' },
    USER,
  );
  queue.__setSchedulerDown(true);
  const { deleted, schedulerRemoved } = await svc.remove(schedule.id, USER);
  assert.equal(deleted, true);
  assert.equal(schedulerRemoved, false, 'honest: the remove failed');
  assert.equal(await db.schedule.findUnique({ where: { id: schedule.id } }), null);
});

// ------------------------------------------------------------------ list/get
test('list: returns schedules with definition summary + lastRun (delay computed)', async () => {
  const { db, svc } = await mkEnv();
  const { schedule } = await svc.create(
    { name: 'listed', taskDefinitionId: DEF_ID, scheduleType: 'cron', cronExpression: '0 9 * * *' },
    USER,
  );
  const fired = await svc.runNow(schedule.id, USER, { idempotencyKey: 'runnow-list-test-1' });
  // Give the run a scheduledSlotAt in the past so delay is measurable.
  await db.taskRun.update({
    where: { id: fired.run.id },
    data: { inputJson: { ...fired.run.inputJson, scheduledSlotAt: new Date(Date.now() - 4200).toISOString() } },
  });

  const { items, total } = await svc.list({ page: 1, pageSize: 20 });
  assert.equal(total, 1);
  assert.equal(items[0].name, 'listed');
  assert.equal(items[0].taskDefinition.title, 'Nightly check');
  assert.equal(items[0].taskDefinition.provider, 'mock');
  assert.equal(items[0].lastRun.id, fired.run.id);
  assert.equal(items[0].lastRun.delayMs, 4200);
  assert.match(items[0].nextRunDescription, /daily at 09:00 \(Asia\/Taipei\)/);

  // svc.get returns the public shape directly (the route wraps it in {schedule}).
  const got = await svc.get(schedule.id);
  assert.equal(got.lastRun.status, 'queued');
});

test('preview: backend-parsed next run (MD §12.2 — 前端唔好自己猜)', async () => {
  const { svc } = await mkEnv();
  const { nextRunAt, description } = await svc.preview({
    scheduleType: 'cron',
    cronExpression: '0 9 * * *',
    timezone: 'Asia/Taipei',
  });
  const d = new Date(nextRunAt);
  assert.equal(d.getUTCHours(), 1, '09:00 Taipei = 01:00 UTC');
  assert.match(description, /daily at 09:00/);

  const int = await svc.preview({ scheduleType: 'interval', intervalMs: 30_000 });
  assert.match(int.description, /every 30s/);
});

// ------------------------------------------- shared createRun/skipped ext
test('createRun carries scheduleId + taskDefinitionId + scheduledSlotAt (P4 lineage)', async () => {
  const { db, taskSvc, enqueued } = await mkEnv();
  const { run } = await taskSvc.createRun(
    {
      prompt: 'auto slot',
      scheduleId: '11111111-2222-4333-8444-555555555555',
      taskDefinitionId: DEF_ID,
      idempotencyKey: 'sched-test-slot-1',
      scheduledSlotAt: '2026-10-15T01:00:00.000Z',
    },
    USER,
  );
  assert.equal(run.scheduleId, '11111111-2222-4333-8444-555555555555');
  assert.equal(run.taskDefinitionId, DEF_ID);
  assert.equal(run.inputJson.scheduledSlotAt, '2026-10-15T01:00:00.000Z');
  assert.equal(enqueued.length, 1);

  // Replay is idempotent (same key → same run).
  const again = await taskSvc.createRun(
    { prompt: 'auto slot', scheduleId: '11111111-2222-4333-8444-555555555555', idempotencyKey: 'sched-test-slot-1' },
    USER,
  );
  assert.equal(again.replay, true);
  assert.equal(again.run.id, run.id);
});

test('createSkippedRun: born terminal skipped, explanatory event, no enqueue, idempotent per slot', async () => {
  const { db, taskSvc, enqueued } = await mkEnv();
  const input = {
    prompt: 'would-have-run',
    scheduleId: '11111111-2222-4333-8444-555555555555',
    taskDefinitionId: DEF_ID,
    idempotencyKey: 'sched-11111111-2222-4333-8444-555555555555-1760456400000-skip',
    reason: 'overlap_policy=skip_if_running: run 999 active',
    activeRunId: '99999999-9999-4999-8999-999999999999',
    scheduledSlotAt: '2026-10-15T01:00:00.000Z',
  };
  const { run, replay } = await taskSvc.createSkippedRun(input, USER);
  assert.equal(replay, false);
  assert.equal(run.status, 'skipped');
  assert.ok(run.finishedAt, 'skipped is terminal: finishedAt written at birth');
  assert.equal(enqueued.length, 0, 'a skipped slot never touches the queue');

  const events = await db.taskRunEvent.findMany({ where: { taskRunId: run.id } });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'status');
  assert.match(events[0].message, /slot skipped/);
  assert.equal(events[0].payloadJson.activeRunId, input.activeRunId);

  // Same slot redelivered → replay, exactly one row.
  const again = await taskSvc.createSkippedRun(input, USER);
  assert.equal(again.replay, true);
  assert.equal(again.run.id, run.id);

  // Validation: reason is mandatory (MD §12.3: 解釋被略過原因).
  await assert.rejects(
    () => taskSvc.createSkippedRun({ ...input, reason: '', idempotencyKey: 'sched-other-slot-9-skip' }, USER),
    (err) => err.apiCode === 'VALIDATION_ERROR',
  );
});

// ------------------------------------------------- fail-fast sync guard (P4)
test('sync guard: HUNG queue (redis offline-queue) fails fast -> sync_error, no hang', async () => {
  const { db, queue, svc } = await mkEnv();
  queue.__setSchedulerHang(true); // command accepted, never settles (real redis-down shape)
  const t0 = Date.now();
  const { schedule } = await svc.create(
    { name: 'hung-sync', taskDefinitionId: DEF_ID, scheduleType: 'interval', intervalMs: 60_000 },
    USER,
  );
  const elapsed = Date.now() - t0;
  queue.__setSchedulerHang(false);
  assert.equal(schedule.syncStatus, 'sync_error', 'row flagged sync_error (PG-first)');
  assert.ok(elapsed < 5_000, `request returned fast (elapsed ${elapsed}ms), not hung in the offline queue`);
  const row = await db.schedule.findUnique({ where: { id: schedule.id } });
  assert.equal(row.syncStatus, 'sync_error');
});
