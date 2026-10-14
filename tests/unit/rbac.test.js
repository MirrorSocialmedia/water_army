/**
 * RBAC unit tests (施工 MD §16.1):
 *  - unauthenticated → 401 UNAUTHORIZED (envelope + requestId)
 *  - viewer on operator/admin mutation → 403 FORBIDDEN
 *  - role ladder works (viewer < operator < admin)
 *  - authenticated read for viewer allowed
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from '@node-rs/argon2';

import { buildApp } from '../../apps/api/src/app.js';
import { makeFakeDb, testConfig, fakeRedisOk, fakeDockerOk } from '../helpers/fakes.js';

const { argon2id, hash } = argon2;

async function makeApp({ users = [] } = {}) {
  const db = makeFakeDb({ users });
  const app = await buildApp({ config: testConfig, db, redis: fakeRedisOk(), docker: fakeDockerOk() });
  // Test-only guarded routes (exercise the real requireRole guard).
  app.get('/api/test/read', { preHandler: app.requireRole('viewer') }, async () => ({ ok: 'read' }));
  app.post('/api/test/mutate', { preHandler: app.requireRole('operator') }, async () => ({ ok: 'mutate' }));
  app.post('/api/test/admin', { preHandler: app.requireRole('admin') }, async () => ({ ok: 'admin' }));
  return { app, db };
}

async function login(app, username, password) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  assert.equal(res.statusCode, 200, `login should succeed: ${res.body}`);
  return res.headers['set-cookie'].split(';')[0];
}

const PASSWORD = 'TestPass123';

test('rbac matrix', async (t) => {
  const passwordHash = await hash(PASSWORD, { type: argon2id });
  const { app } = await makeApp({
    users: [
      { id: 'u-v', username: 'viewer1', passwordHash, role: 'viewer' },
      { id: 'u-o', username: 'operator1', passwordHash, role: 'operator' },
      { id: 'u-a', username: 'admin1', passwordHash, role: 'admin' },
    ],
  });
  t.after(() => app.close());

  await t.test('unauthenticated: 401 + envelope + requestId on all guarded routes', async () => {
    for (const [method, url] of [['GET', '/api/test/read'], ['POST', '/api/test/mutate'], ['POST', '/api/test/admin']]) {
      const res = await app.inject({ method, url });
      assert.equal(res.statusCode, 401);
      const body = res.json();
      assert.equal(body.error.code, 'UNAUTHORIZED');
      assert.ok(typeof body.error.requestId === 'string' && body.error.requestId.length > 0);
      assert.equal(res.headers['x-request-id'], body.error.requestId);
    }
  });

  await t.test('viewer: read ok, mutate 403, admin 403', async () => {
    const cookie = await login(app, 'viewer1', PASSWORD);
    const read = await app.inject({ method: 'GET', url: '/api/test/read', headers: { cookie } });
    assert.equal(read.statusCode, 200, read.body);

    const mutate = await app.inject({ method: 'POST', url: '/api/test/mutate', headers: { cookie } });
    assert.equal(mutate.statusCode, 403);
    assert.equal(mutate.json().error.code, 'FORBIDDEN');
    assert.ok(mutate.json().error.requestId);

    const admin = await app.inject({ method: 'POST', url: '/api/test/admin', headers: { cookie } });
    assert.equal(admin.statusCode, 403);
    assert.equal(admin.json().error.code, 'FORBIDDEN');
  });

  await t.test('operator: mutate ok, admin 403', async () => {
    const cookie = await login(app, 'operator1', PASSWORD);
    const mutate = await app.inject({ method: 'POST', url: '/api/test/mutate', headers: { cookie } });
    assert.equal(mutate.statusCode, 200, mutate.body);
    const admin = await app.inject({ method: 'POST', url: '/api/test/admin', headers: { cookie } });
    assert.equal(admin.statusCode, 403);
  });

  await t.test('admin: everything ok', async () => {
    const cookie = await login(app, 'admin1', PASSWORD);
    for (const [method, url] of [['GET', '/api/test/read'], ['POST', '/api/test/mutate'], ['POST', '/api/test/admin']]) {
      const res = await app.inject({ method, url, headers: { cookie } });
      assert.equal(res.statusCode, 200, `${method} ${url}: ${res.body}`);
    }
  });

  await t.test('real auth routes respect the same guard (me)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    assert.equal(res.statusCode, 401);
  });
});

test('requireRole rejects unknown roles at wiring time', async () => {
  const { app } = await makeApp();
  app.close();
  assert.throws(() => app.requireRole('superuser'), /unknown role/);
});
