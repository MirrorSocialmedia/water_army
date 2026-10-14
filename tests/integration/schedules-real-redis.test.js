/**
 * P4 integration tests — schedules against REAL redis + REAL BullMQ
 * (not the fake): proves the Job Scheduler API surface this phase builds on
 * (`upsertJobScheduler` / `getJobSchedulers` / `getJobSchedulersCount` /
 * `removeJobScheduler` / deterministic delayed jobs) behaves exactly as the
 * zero-duplication design assumes, under the locked BullMQ version.
 *
 * GATED: runs only when SCHEDULES_REDIS_URL (or REDIS_URL) points at a live
 * redis — e.g. a disposable container:
 *   sg docker -c 'docker run -d --rm --name wa-test-redis -p 127.0.0.1:16379:6379 redis:7.4.5'
 *   SCHEDULES_REDIS_URL=redis://127.0.0.1:16379 node --test tests/integration/schedules-real-redis.test.js
 * `npm test` (hermetic) skips this file cleanly when no URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createTaskQueue, schedulerIdFor, onceFireJobId, SCHEDULE_FIRE_JOB_NAME } from '@water-army/shared';

const REDIS_URL = process.env.SCHEDULES_REDIS_URL || process.env.REDIS_URL || '';
const SKIP = !REDIS_URL;

/** @type {any} */
let queue;
const keys = [];

test('real redis + real BullMQ job scheduler (P4)', { skip: SKIP ? 'no SCHEDULES_REDIS_URL/REDIS_URL set (hermetic run)' : false }, async (t) => {
  t.before(async () => {
    queue = createTaskQueue({ redisUrl: REDIS_URL }, { warn() {}, info() {} });
    await queue.waitUntilReady();
  });
  t.after(async () => {
    // Sweep everything this test created (namespaced ids only).
    for (const k of keys) {
      try { await queue.removeJobScheduler(k); } catch { /* already gone */ }
    }
    const delayed = (await queue.getJobs(['delayed', 'wait', 'active', 'completed', 'failed'])) ?? [];
    for (const j of delayed.filter((j) => String(j.id).startsWith('schedonce-'))) {
      try { await j.remove(); } catch { /* already gone */ }
    }
    await queue.close();
  });

  const cronId = schedulerIdFor(randomUUID());
  const intId = schedulerIdFor(randomUUID());
  keys.push(cronId, intId);

  // 1) Two schedulers: one cron (pattern + tz), one interval (every).
  await queue.upsertJobScheduler(cronId, { pattern: '* * * * *', tz: 'Asia/Taipei' }, {
    name: SCHEDULE_FIRE_JOB_NAME, data: { scheduleId: 'x' },
  });
  await queue.upsertJobScheduler(intId, { every: 30_000 }, {
    name: SCHEDULE_FIRE_JOB_NAME, data: { scheduleId: 'y' },
  });

  let all = await queue.getJobSchedulers();
  assert.equal(all.length, 2, 'exactly the two upserted schedulers');
  assert.equal(await queue.getJobSchedulersCount(), 2);
  const cronEntry = all.find((e) => e.key === cronId);
  const intEntry = all.find((e) => e.key === intId);
  assert.ok(cronEntry && intEntry, 'both ids present in the index');
  assert.equal(cronEntry.pattern, '* * * * *');
  assert.equal(cronEntry.tz, 'Asia/Taipei', 'per-schedule timezone round-trips');
  assert.equal(intEntry.every, 30_000);
  assert.equal(cronEntry.name, SCHEDULE_FIRE_JOB_NAME, 'fire job name is top-level in the real entry shape');

  // 2) Zero duplication: re-upsert the SAME id with changed params → in-place
  // override, the index count stays 2 (the 硬驗收 3 invariant at the wire level).
  await queue.upsertJobScheduler(cronId, { pattern: '*/5 * * * *', tz: 'Asia/Taipei' }, {
    name: SCHEDULE_FIRE_JOB_NAME, data: { scheduleId: 'x', schedHash: 'new-gen' },
  });
  all = await queue.getJobSchedulers();
  assert.equal(all.length, 2, 're-upsert never creates a second index entry');
  assert.equal(all.find((e) => e.key === cronId).pattern, '*/5 * * * *', 'params changed in place');
  assert.equal(all.find((e) => e.key === cronId).template.data.schedHash, 'new-gen', 'fire payload generation updated');

  // 3) The once-schedule shape: a deterministic delayed job (NOT a scheduler).
  const onceUuid = randomUUID();
  const slotMs = Date.now() + 600_000;
  const onceJobId = onceFireJobId(onceUuid, slotMs);
  await queue.add(SCHEDULE_FIRE_JOB_NAME, { scheduleId: onceUuid, once: true, scheduledAt: new Date(slotMs).toISOString() }, {
    jobId: onceJobId, delay: 600_000,
  });
  // Idempotent re-add of the same deterministic id → still ONE job. Real
  // BullMQ either no-ops or throws JobExistsError on a duplicate custom id —
  // both are acceptable; the invariant is "exactly one job in the index".
  try {
    await queue.add(SCHEDULE_FIRE_JOB_NAME, { scheduleId: onceUuid, once: true, scheduledAt: new Date(slotMs).toISOString() }, {
      jobId: onceJobId, delay: 600_000,
    });
  } catch (err) {
    assert.equal(err?.name, 'JobExistsError', `duplicate add must be JobExistsError, got: ${err?.name}`);
  }
  const delayedJobs = (await queue.getJobs(['delayed'])) ?? [];
  assert.equal(delayedJobs.filter((j) => j.id === onceJobId).length, 1, 'deterministic once-job id = idempotent add');
  assert.ok(!((await queue.getJobSchedulers()).some((e) => e.key === `sched-${onceUuid}`)), 'once uses a delayed job, not the scheduler index');

  // 4) Remove: the index converges back down.
  await queue.removeJobScheduler(intId);
  all = await queue.getJobSchedulers();
  assert.equal(all.length, 1);
  assert.equal(all[0].key, cronId);
});
