/**
 * P6 dashboard summary — every number the dashboard renders comes from this
 * endpoint (MD §6.1: no hardcoded demo data). Hermetic (fake db + fake
 * docker client per P2/P3 convention).
 *
 * Covers: RBAC 401, full shape, managed-only container counts (same
 * label-OR-exception rule as the list, flag #1), 24h run windows, recent
 * failures ordering, schedule + notification counts, and Docker-down
 * degradation (200 + containers.available=false, never 500).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from '@node-rs/argon2';

import { APP_LABELS, createTaskRunService } from '@water-army/shared';

import { buildApp } from '../../apps/api/src/app.js';
import { makeFakeDb, testConfig, fakeRedisOk, makeFakeQueue } from '../helpers/fakes.js';
import { makeFakeDockerWrapper } from '../helpers/fake-docker-client.js';

const { argon2id, hash } = argon2;
const PASSWORD = 'TestPass123';
const MANAGED = { [APP_LABELS.MANAGED]: 'true' };

async function makeApp({ dockerOpts = {}, seedRuns = true } = {}) {
  const passwordHash = await hash(PASSWORD, { type: argon2id });
  const db = makeFakeDb({
    users: [
      { id: 'u-admin', username: 'admin1', passwordHash, role: 'admin' },
      { id: 'u-view', username: 'viewer1', passwordHash, role: 'viewer' },
    ],
  });
  const docker = makeFakeDockerWrapper({
    containers: [
      { name: 'svc-web', state: 'running', labels: MANAGED },
      { name: 'svc-api', state: 'running', labels: MANAGED },
      { name: 'svc-dead', state: 'dead', labels: MANAGED },
      { name: 'svc-exited', state: 'exited', labels: MANAGED },
      { name: 'external-vm', state: 'running', labels: {} }, // unmanaged — excluded
    ],
    ...dockerOpts,
  });
  const config = { ...testConfig, aiProvider: 'mock', serviceToken: 'test-service-token-0123456789abcdef01234567' };
  const app = await buildApp({ config, db, redis: fakeRedisOk(), docker, taskQueue: makeFakeQueue() });

  if (seedRuns) {
    const taskSvc = createTaskRunService({ db, config: { taskDefaultTimeoutMs: 120_000, taskMaxTimeoutMs: 900_000, taskDefaultAttempts: 3 }, log: { info() {}, warn() {}, error() {}, debug() {} }, enqueue: async () => {} });
    const mk = async (over = {}) => {
      const { run } = await taskSvc.createRun({ prompt: 'p', provider: 'mock', ...over.input }, over.user ?? { id: 'u1', username: 't' });
      return run;
    };
    // active: 2 queued + 1 running
    const a1 = await mk();
    await mk();
    const a3 = await mk();
    await db.taskRun.update({ where: { id: a3.id }, data: { status: 'running' } });
    // terminal 24h window
    const f1 = await mk();
    await db.taskRun.update({ where: { id: f1.id }, data: { status: 'failed', errorCode: 'PROVIDER_TIMEOUT', finishedAt: new Date(Date.now() - 3_600_000) } });
    const s1 = await mk();
    await db.taskRun.update({ where: { id: s1.id }, data: { status: 'succeeded', finishedAt: new Date(Date.now() - 7_200_000) } });
    // failed OUTSIDE the 24h window — counted in recentFailed list? no: list is
    // all-time failed (ordered), count is 24h only
    const f2 = await mk();
    await db.taskRun.update({ where: { id: f2.id }, data: { status: 'failed', finishedAt: new Date(Date.now() - 48 * 3_600_000) } });
  }
  await db.schedule.create({ data: { id: 's-1', name: 'Nightly', taskDefinitionId: 'aaaa1111-1111-4111-8111-111111111111', scheduleType: 'interval', intervalMs: 60_000 } });
  await db.schedule.create({ data: { id: 's-2', name: 'Paused', taskDefinitionId: 'aaaa1111-1111-4111-8111-111111111111', scheduleType: 'interval', intervalMs: 60_000, isEnabled: false } });
  await db.scheduleNotification.create({ data: { id: 'n1', scheduleId: 's-1', runId: 'r1', status: 'failed', title: 'x failed' } });
  await db.scheduleNotification.create({ data: { id: 'n2', scheduleId: 's-1', runId: 'r2', status: 'succeeded', title: 'x ok' } });
  await db.scheduleNotification.create({ data: { id: 'n3', scheduleId: 's-1', runId: 'r3', status: 'succeeded', title: 'x ok', isRead: true } });

  return { app, db };
}

async function login(app, username) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD } });
  assert.equal(res.statusCode, 200, res.body);
  return res.headers['set-cookie'].split(';')[0];
}

test('dashboard summary API (P6 — MD §6.1 real counters)', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());
  const view = await login(app, 'viewer1');

  await t.test('unauthenticated → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/summary' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'UNAUTHORIZED');
  });

  await t.test('viewer gets the full real shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/summary', headers: { cookie: view } });
    assert.equal(res.statusCode, 200, res.body);
    const j = res.json();

    // managed-only: 4 of the 5 seeded containers (external-vm excluded)
    assert.equal(j.containers.available, true);
    assert.equal(j.containers.total, 4);
    assert.equal(j.containers.running, 2);
    assert.equal(j.containers.attention, 1); // dead
    assert.equal(j.containers.stopped, 1); // exited

    // active = 2 queued + 1 running; 24h window excludes the 48h-old failure
    assert.equal(j.taskRuns.active, 3);
    assert.equal(j.taskRuns.failed24h, 1);
    assert.equal(j.taskRuns.succeeded24h, 1);
    assert.equal(j.taskRuns.recentFailed.length, 2); // all-time failed, newest first
    assert.deepEqual(j.taskRuns.recentFailed[0].errorCode, 'PROVIDER_TIMEOUT');

    assert.deepEqual(j.schedules, { total: 2, enabled: 1 });
    assert.deepEqual(j.notifications, { unread: 2 });
  });
});

test('dashboard summary: Docker down degrades, does not 500', async (t) => {
  const { app } = await makeApp({ dockerOpts: { mode: 'daemon-down' } });
  t.after(() => app.close());
  const view = await login(app, 'viewer1');
  const res = await app.inject({ method: 'GET', url: '/api/dashboard/summary', headers: { cookie: view } });
  assert.equal(res.statusCode, 200, res.body);
  const j = res.json();
  assert.equal(j.containers.available, false);
  assert.equal(j.containers.total, null);
  // the non-Docker sections still render with real numbers
  assert.equal(j.taskRuns.active, 3);
  assert.equal(j.notifications.unread, 2);
});
