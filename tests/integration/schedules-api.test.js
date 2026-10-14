/**
 * P4 API integration tests — schedules over the REAL HTTP path (app.inject,
 * fake db/queue per P3 convention). Covers the consistency surface:
 *   - RBAC (read viewer+ / write operator+)
 *   - PG-first: create succeeds (201) even when BullMQ is down → sync_error
 *   - retry-sync: 503 while down, heals once recovered
 *   - run-now: 202 fresh / 200 replay on the same Idempotency-Key
 *   - delete: 204 + 404 after
 * All hermetic — no live redis/postgres (the real-redis round-trip is
 * schedules-real-redis.test.js, gated on REDIS_URL).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from '@node-rs/argon2';

import { buildApp } from '../../apps/api/src/app.js';
import { makeFakeDb, testConfig, fakeRedisOk, fakeDockerOk, makeFakeQueue } from '../helpers/fakes.js';

const { argon2id, hash } = argon2;
const PASSWORD = 'TestPass123';
const DEF_ID = '11111111-1111-4111-8111-111111111111';

async function makeApp({ schedulerDown = false } = {}) {
  const passwordHash = await hash(PASSWORD, { type: argon2id });
  const users = [
    { id: 'u-admin', username: 'admin1', passwordHash, role: 'admin' },
    { id: 'u-op', username: 'operator1', passwordHash, role: 'operator' },
    { id: 'u-view', username: 'viewer1', passwordHash, role: 'viewer' },
  ];
  const db = makeFakeDb({ users });
  const provider = await db.providerConfig.create({
    data: { name: 'mock', baseUrl: 'http://127.0.0.1:9/v1', providerType: 'openai_compatible', timeoutMs: 10_000 },
  });
  await db.taskDefinition.create({
    data: {
      id: DEF_ID, title: 'Nightly check', providerConfigId: provider.id,
      promptTemplate: 'Check the fleet.', mode: 'analysis_only', timeoutMs: 30_000, maxAttempts: 2,
    },
  });
  const queue = makeFakeQueue();
  if (schedulerDown) queue.__setSchedulerDown(true);
  const config = { ...testConfig, aiProvider: 'mock', serviceToken: 'test-service-token-0123456789abcdef01234567' };
  const app = await buildApp({ config, db, redis: fakeRedisOk(), docker: fakeDockerOk(), taskQueue: queue });
  return { app, db, queue };
}

async function login(app, username, password = PASSWORD) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  assert.equal(res.statusCode, 200, `login should succeed: ${res.body}`);
  return res.headers['set-cookie'].split(';')[0];
}

const body = (res) => JSON.parse(res.body);

test('schedules API (P4) — consistency over the real HTTP path', async (t) => {
  const { app, db, queue } = await makeApp();
  t.after(() => app.close());
  const op = await login(app, 'operator1');
  const view = await login(app, 'viewer1');
  const admin = await login(app, 'admin1');

  const CREATE = {
    name: 'nightly',
    taskDefinitionId: DEF_ID,
    scheduleType: 'cron',
    cronExpression: '0 9 * * *',
    timezone: 'Asia/Taipei',
    overlapPolicy: 'skip_if_running',
  };

  // ------------------------------------------------ RBAC
  const denied = await app.inject({ method: 'POST', url: '/api/schedules', headers: { cookie: view }, payload: CREATE });
  assert.equal(denied.statusCode, 403, 'viewer cannot create');
  const deniedRead = await app.inject({ method: 'GET', url: '/api/schedules', headers: { cookie: null } });
  assert.ok(deniedRead.statusCode === 401 || deniedRead.statusCode === 403, 'no session → auth wall');

  // ------------------------------------------------ create (happy)
  const created = await app.inject({ method: 'POST', url: '/api/schedules', headers: { cookie: op }, payload: CREATE });
  assert.equal(created.statusCode, 201, `create: ${created.body}`);
  const sched = body(created).schedule;
  assert.equal(sched.syncStatus, 'synced');
  assert.ok(sched.nextRunAt, 'next_run_at computed (per-schedule timezone)');
  const schedId = sched.id;

  // The BullMQ index has exactly the one stable key.
  assert.equal(queue.schedulers.size, 1);
  assert.ok([...queue.schedulers.keys()].every((k) => k === `sched-${schedId}`), 'stable sched-<uuid> key');

  // ------------------------------------------------ list / get (viewer read)
  const list = await app.inject({ method: 'GET', url: '/api/schedules', headers: { cookie: view } });
  assert.equal(list.statusCode, 200);
  assert.equal(body(list).items.length, 1);
  const got = await app.inject({ method: 'GET', url: `/api/schedules/${schedId}`, headers: { cookie: view } });
  assert.equal(got.statusCode, 200);
  assert.equal(body(got).schedule.id, schedId);

  // ------------------------------------------------ run-now: fresh 202, replay 200
  const rn1 = await app.inject({
    method: 'POST', url: `/api/schedules/${schedId}/run-now`,
    headers: { cookie: op, 'idempotency-key': 'manual-once-123' }, payload: {},
  });
  assert.equal(rn1.statusCode, 202, `run-now fresh: ${rn1.body}`);
  const run1 = body(rn1);
  assert.equal(run1.replay, false);

  const rn2 = await app.inject({
    method: 'POST', url: `/api/schedules/${schedId}/run-now`,
    headers: { cookie: op, 'idempotency-key': 'manual-once-123' }, payload: {},
  });
  assert.equal(rn2.statusCode, 200, `run-now replay: ${rn2.body}`);
  assert.equal(body(rn2).replay, true);
  assert.equal(body(rn2).run.id, run1.run.id, 'same Idempotency-Key → same run row (no duplicate)');

  // A DIFFERENT key → a different run (manual fires are per-request).
  const rn3 = await app.inject({
    method: 'POST', url: `/api/schedules/${schedId}/run-now`,
    headers: { cookie: op, 'idempotency-key': 'manual-twice-456' }, payload: {},
  });
  assert.equal(rn3.statusCode, 202);
  assert.notEqual(body(rn3).run.id, run1.run.id);

  // Runs carry the schedule lineage (task_runs.schedule_id).
  const runs = await db.taskRun.findMany({ where: { scheduleId: schedId } });
  assert.equal(runs.length, 2, 'two manual runs, no duplicates');
  assert.ok(runs.every((r) => r.scheduleId === schedId && r.taskDefinitionId === DEF_ID));

  // ------------------------------------------------ pause / resume (idempotent + RBAC)
  const p1 = await app.inject({ method: 'POST', url: `/api/schedules/${schedId}/pause`, headers: { cookie: op }, payload: {} });
  assert.equal(p1.statusCode, 200);
  assert.equal(body(p1).schedule.isEnabled, false);
  assert.equal(queue.schedulers.size, 0, 'paused → index entry removed');
  const p2 = await app.inject({ method: 'POST', url: `/api/schedules/${schedId}/pause`, headers: { cookie: op }, payload: {} });
  assert.equal(p2.statusCode, 200, 'pause is idempotent');
  const r1 = await app.inject({ method: 'POST', url: `/api/schedules/${schedId}/resume`, headers: { cookie: op }, payload: {} });
  assert.equal(r1.statusCode, 200);
  assert.equal(body(r1).schedule.isEnabled, true);
  assert.equal(queue.schedulers.size, 1, 'resumed → index entry restored (same key)');

  // ------------------------------------------------ delete: 204 then 404 (viewer cannot delete)
  const dDenied = await app.inject({ method: 'DELETE', url: `/api/schedules/${schedId}`, headers: { cookie: view } });
  assert.equal(dDenied.statusCode, 403, 'viewer cannot delete');
  const del = await app.inject({ method: 'DELETE', url: `/api/schedules/${schedId}`, headers: { cookie: admin } });
  assert.equal(del.statusCode, 204);
  const gone = await app.inject({ method: 'GET', url: `/api/schedules/${schedId}`, headers: { cookie: op } });
  assert.equal(gone.statusCode, 404);
  assert.equal(queue.schedulers.size, 0, 'deleted → index entry removed');
});

test('schedules API (P4) — PG-first consistency: BullMQ down → sync_error → retry heals', async (t) => {
  const { app, queue } = await makeApp({ schedulerDown: true });
  t.after(() => app.close());
  const op = await login(app, 'operator1');

  const CREATE = {
    name: 'fragile',
    taskDefinitionId: DEF_ID,
    scheduleType: 'interval',
    intervalMs: 60_000,
    timezone: 'Asia/Taipei',
    overlapPolicy: 'queue',
  };

  // 1) Create with redis down: the DB row MUST exist (PG-first) → 201 + sync_error.
  const created = await app.inject({ method: 'POST', url: '/api/schedules', headers: { cookie: op }, payload: CREATE });
  assert.equal(created.statusCode, 201, `PG-first: ${created.body}`);
  const sched = body(created).schedule;
  assert.equal(sched.syncStatus, 'sync_error', 'honest state — the BullMQ write failed');
  const schedId = sched.id;

  // 2) Retry while still down → 503 (retryable, not a 500, not a fake success).
  const s1 = await app.inject({ method: 'POST', url: `/api/schedules/${schedId}/sync`, headers: { cookie: op }, payload: {} });
  assert.equal(s1.statusCode, 503, `retry while down: ${s1.body}`);
  assert.match(s1.body, /SYNC_ERROR/);

  // 3) Redis recovers → retry heals → synced + the index now has the entry.
  queue.__setSchedulerDown(false);
  const s2 = await app.inject({ method: 'POST', url: `/api/schedules/${schedId}/sync`, headers: { cookie: op }, payload: {} });
  assert.equal(s2.statusCode, 200, `retry after recovery: ${s2.body}`);
  assert.equal(body(s2).schedule.syncStatus, 'synced');
  assert.equal(queue.schedulers.size, 1);
  assert.ok(queue.schedulers.has(`sched-${schedId}`), 'recovered under the stable key');

  // 4) The row never needed a rollback: GET agrees.
  const got = await app.inject({ method: 'GET', url: `/api/schedules/${schedId}`, headers: { cookie: op } });
  assert.equal(body(got).schedule.syncStatus, 'synced');
});

test('schedules API (P4) — run-now with a disabled provider → 409, schedule untouched', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());
  const op = await login(app, 'operator1');

  const created = await app.inject({
    method: 'POST', url: '/api/schedules', headers: { cookie: op },
    payload: { name: 'brokenprov', taskDefinitionId: DEF_ID, scheduleType: 'interval', intervalMs: 60_000 },
  });
  assert.equal(created.statusCode, 201);
  const schedId = body(created).schedule.id;

  const providers = await db.providerConfig.findMany();
  await db.providerConfig.update({ where: { id: providers[0].id }, data: { isEnabled: false } });

  const rn = await app.inject({ method: 'POST', url: `/api/schedules/${schedId}/run-now`, headers: { cookie: op }, payload: {} });
  assert.equal(rn.statusCode, 409, `disabled provider: ${rn.body}`);
  assert.match(rn.body, /PROVIDER_NOT_CONFIGURED/);
  assert.equal((await db.taskRun.findMany({ where: { scheduleId: schedId } })).length, 0, 'no run row');
});
