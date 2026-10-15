/**
 * P6 flag #3 — schedule notifications API integration tests (real HTTP path,
 * fake db per P3 convention):
 *  - RBAC: read viewer+, mark-read operator+ (strict viewer=read-only)
 *  - 401 unauthenticated on all routes
 *  - list ordering (newest first), unreadOnly, limit
 *  - unread-count
 *  - read-all / read-one / 404 on unknown id
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from '@node-rs/argon2';

import { buildApp } from '../../apps/api/src/app.js';
import { makeFakeDb, testConfig, fakeRedisOk, fakeDockerOk, makeFakeQueue } from '../helpers/fakes.js';

const { argon2id, hash } = argon2;
const PASSWORD = 'TestPass123';

const SCHED_ID = '22222222-2222-4222-8222-222222222222';

async function makeApp() {
  const passwordHash = await hash(PASSWORD, { type: argon2id });
  const db = makeFakeDb({
    users: [
      { id: 'u-admin', username: 'admin1', passwordHash, role: 'admin' },
      { id: 'u-op', username: 'operator1', passwordHash, role: 'operator' },
      { id: 'u-view', username: 'viewer1', passwordHash, role: 'viewer' },
    ],
  });
  await db.schedule.create({ data: { id: SCHED_ID, name: 'Nightly check', taskDefinitionId: 'def-1', scheduleType: 'interval', intervalMs: 60000 } });
  const t0 = new Date('2026-10-15T01:00:00Z');
  const mk = (i, status, at) => db.scheduleNotification.create({
    data: { id: `n${i}`, scheduleId: SCHED_ID, runId: `run-${i}`, status, title: `[Nightly check] ${status}`, createdAt: at },
  });
  await mk(1, 'succeeded', new Date(t0.getTime() + 0 * 60000));
  await mk(2, 'failed', new Date(t0.getTime() + 1 * 60000), );
  await mk(3, 'skipped', new Date(t0.getTime() + 2 * 60000));
  const config = { ...testConfig, aiProvider: 'mock', serviceToken: 'test-service-token-0123456789abcdef01234567' };
  const app = await buildApp({ config, db, redis: fakeRedisOk(), docker: fakeDockerOk(), taskQueue: makeFakeQueue() });
  return { app, db };
}

async function login(app, username) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD } });
  assert.equal(res.statusCode, 200, `login ${username}: ${res.body}`);
  return res.headers['set-cookie'].split(';')[0];
}

test('schedule notifications API (P6 flag #3)', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());
  const view = await login(app, 'viewer1');
  const op = await login(app, 'operator1');

  await t.test('unauthenticated → 401 on all four routes', async () => {
    for (const [method, url] of [
      ['GET', '/api/schedule-notifications'],
      ['GET', '/api/schedule-notifications/unread-count'],
      ['POST', '/api/schedule-notifications/read-all'],
      ['POST', '/api/schedule-notifications/n1/read'],
    ]) {
      const res = await app.inject({ method, url });
      assert.equal(res.statusCode, 401, `${method} ${url}: ${res.body}`);
      assert.equal(res.json().error.code, 'UNAUTHORIZED');
    }
  });

  await t.test('viewer: list newest-first + unread-count + unreadOnly', async () => {
    const H = { cookie: view };
    const list = await app.inject({ method: 'GET', url: '/api/schedule-notifications', headers: H });
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(list.json().items.map((i) => i.id), ['n3', 'n2', 'n1']);

    const count = await app.inject({ method: 'GET', url: '/api/schedule-notifications/unread-count', headers: H });
    assert.equal(count.json().count, 3);

    const unread = await app.inject({ method: 'GET', url: '/api/schedule-notifications?unreadOnly=true', headers: H });
    assert.equal(unread.json().items.length, 3);
  });

  await t.test('viewer: mark-read attempts → 403 (strict read-only)', async () => {
    const H = { cookie: view };
    for (const [url] of [['/api/schedule-notifications/read-all'], ['/api/schedule-notifications/n1/read']]) {
      const res = await app.inject({ method: 'POST', url, headers: H });
      assert.equal(res.statusCode, 403, res.body);
    }
    assert.equal((await app.inject({ method: 'GET', url: '/api/schedule-notifications/unread-count', headers: H })).json().count, 3);
  });

  await t.test('operator: read-one → 200; list unreadOnly shrinks; count drops', async () => {
    const H = { cookie: op };
    const one = await app.inject({ method: 'POST', url: '/api/schedule-notifications/n1/read', headers: H });
    assert.equal(one.statusCode, 200, one.body);
    assert.equal(one.json().isRead, true);
    assert.equal((await app.inject({ method: 'GET', url: '/api/schedule-notifications/unread-count', headers: H })).json().count, 2);
    const unread = await app.inject({ method: 'GET', url: '/api/schedule-notifications?unreadOnly=true', headers: H });
    assert.deepEqual(unread.json().items.map((i) => i.id), ['n3', 'n2']);
  });

  await t.test('operator: read-all → marks the rest, idempotent second call', async () => {
    const H = { cookie: op };
    const all = await app.inject({ method: 'POST', url: '/api/schedule-notifications/read-all', headers: H });
    assert.equal(all.statusCode, 200, all.body);
    assert.equal(all.json().marked, 2);
    assert.equal((await app.inject({ method: 'GET', url: '/api/schedule-notifications/unread-count', headers: H })).json().count, 0);
    const again = await app.inject({ method: 'POST', url: '/api/schedule-notifications/read-all', headers: H });
    assert.equal(again.json().marked, 0);
    // list still returns everything (read rows included)
    const list = await app.inject({ method: 'GET', url: '/api/schedule-notifications', headers: H });
    assert.equal(list.json().items.length, 3);
  });

  await t.test('operator: read unknown id → 404 envelope', async () => {
    const H = { cookie: op };
    const res = await app.inject({ method: 'POST', url: '/api/schedule-notifications/ghost9/read', headers: H });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'NOT_FOUND');
  });

  await t.test('limit param is honoured and bounded', async () => {
    const H = { cookie: op };
    const res = await app.inject({ method: 'GET', url: '/api/schedule-notifications?limit=2', headers: H });
    assert.equal(res.json().items.length, 2);
    const big = await app.inject({ method: 'GET', url: '/api/schedule-notifications?limit=9999', headers: H });
    assert.equal(big.json().items.length, 3); // only 3 exist
  });
});
