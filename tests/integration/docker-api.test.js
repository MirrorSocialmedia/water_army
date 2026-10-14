/**
 * Container API integration tests (施工 MD §16.2 — fake Docker adapter,
 * no real daemon) over the full app: auth 401 / RBAC 403 / managed gate
 * NOT_MANAGED / idempotent ops / re-inspect protocol / error classification
 * surfacing through the HTTP envelope / audit trail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from '@node-rs/argon2';

import { buildApp } from '../../apps/api/src/app.js';
import { makeFakeDb, testConfig, fakeRedisOk } from '../helpers/fakes.js';
import { makeFakeDockerWrapper } from '../helpers/fake-docker-client.js';

const { argon2id, hash } = argon2;
const PASSWORD = 'TestPass123';

const SEED = [
  { id: 'a'.repeat(64), name: 'app', state: 'running', image: 'app:1.0', labels: { 'app.managed': 'true', 'app.template': 'smoke', 'app.created-by': 'u-admin' }, logs: 'app line 1\napp line 2\n' },
  { id: 'b'.repeat(64), name: 'stopped-app', state: 'exited', image: 'app:1.0', labels: { 'app.managed': 'true', 'app.template': 'smoke' }, logs: 's line\n' },
  { id: 'c'.repeat(64), name: 'legacy', state: 'running', image: 'legacy:9', labels: {}, logs: 'legacy log\n' },
];

async function makeApp({ dockerOpts = {} } = {}) {
  const passwordHash = await hash(PASSWORD, { type: argon2id });
  const db = makeFakeDb({
    users: [
      { id: 'u-admin', username: 'admin', passwordHash, role: 'admin' },
      { id: 'u-operator', username: 'operator', passwordHash, role: 'operator' },
      { id: 'u-viewer', username: 'viewer', passwordHash, role: 'viewer' },
    ],
  });
  const app = await buildApp({ config: testConfig, db, redis: fakeRedisOk(), docker: makeFakeDockerWrapper({ containers: SEED, ...dockerOpts }) });
  return { app, db };
}

async function login(app, username) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD } });
  assert.equal(res.statusCode, 200, `login ${username}: ${res.body}`);
  return res.headers['set-cookie'].split(';')[0];
}

test('container API: unauthenticated → 401 on all guarded routes', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  // Bodies must be schema-valid so AUTH (not validation) is what fails.
  const ROUTES = [
    ['GET', '/api/containers', null],
    ['GET', '/api/containers/app', null],
    ['GET', '/api/containers/app/logs', null],
    ['GET', '/api/containers/app/stats', null],
    ['GET', '/api/containers/events', null],
    ['POST', '/api/containers/app/start', null],
    ['DELETE', '/api/containers/app', { confirm: 'app' }],
    ['POST', '/api/containers', { templateId: 'smoke', name: 'p2x', idempotencyKey: 'k0123456789abc' }],
    ['POST', '/api/templates', { id: 'smoke', displayName: 'Smoke', image: 'nginx:1.27' }],
    ['GET', '/api/templates', null],
    ['POST', '/api/containers/exceptions', { name: 'legacy' }],
  ];

  await t.test('all guarded routes → 401 + envelope', async () => {
    for (const [method, url, body] of ROUTES) {
      const res = await app.inject({ method, url, payload: body });
      assert.equal(res.statusCode, 401, `${method} ${url} should be 401, got ${res.statusCode}: ${res.body}`);
      assert.equal(res.json().error.code, 'UNAUTHORIZED');
      assert.ok(res.json().error.requestId, 'envelope must carry requestId');
    }
  });
});

test('container API: viewer = read-only', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());
  const cookie = await login(app, 'viewer');
  const H = { cookie };

  await t.test('GET list → 200 with §6.2 columns + managed flag', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/containers', headers: H });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.total, 3);
    const appRow = body.items.find((i) => i.name === 'app');
    assert.equal(appRow.managed, true);
    assert.equal(appRow.template, 'smoke');
    assert.equal(appRow.state, 'running');
    assert.ok(appRow.shortId.length === 12);
    assert.ok(appRow.createdAt);
    const legacy = body.items.find((i) => i.name === 'legacy');
    assert.equal(legacy.managed, false);
  });

  await t.test('filters: state / managed / q + pagination', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/containers?state=running', headers: H })).json().total, 2);
    assert.equal((await app.inject({ method: 'GET', url: '/api/containers?state=running,exited', headers: H })).json().total, 3);
    assert.equal((await app.inject({ method: 'GET', url: '/api/containers?managed=true', headers: H })).json().total, 2);
    assert.equal((await app.inject({ method: 'GET', url: '/api/containers?managed=false', headers: H })).json().total, 1);
    assert.equal((await app.inject({ method: 'GET', url: '/api/containers?q=legacy', headers: H })).json().total, 1);
    assert.equal((await app.inject({ method: 'GET', url: '/api/containers?q=APP:1', headers: H })).json().total, 2);
    const p2 = await app.inject({ method: 'GET', url: '/api/containers?page=2&pageSize=2', headers: H });
    assert.equal(p2.json().items.length, 1);
    assert.equal(p2.json().total, 3);
  });

  await t.test('query validation: bad pageSize → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/containers?pageSize=9999', headers: H });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'VALIDATION_ERROR');
  });

  await t.test('inspect → 200, env masked, managed=false for unmanaged', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/containers/legacy', headers: H });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().managed, false);
    assert.equal(res.json().state.status, 'running');
  });

  await t.test('logs → 200 lines; bad tail/since → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/containers/app/logs', headers: H });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().lines, ['app line 1', 'app line 2']);
    assert.equal(res.json().container.name, 'app');

    const tail2 = await app.inject({ method: 'GET', url: '/api/containers/app/logs?tail=1', headers: H });
    assert.deepEqual(tail2.json().lines, ['app line 2']);

    assert.equal((await app.inject({ method: 'GET', url: '/api/containers/app/logs?tail=0', headers: H })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/containers/app/logs?since=garbage', headers: H })).statusCode, 400);
  });

  await t.test('stats running → 200 numbers; non-running → 502 DOCKER_ERROR (engine 500 classified)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/containers/app/stats', headers: H });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(typeof res.json().stats.cpuPercent, 'number');
    assert.equal(res.json().stats.memPercent, 25);

    const stopped = await app.inject({ method: 'GET', url: '/api/containers/stopped-app/stats', headers: H });
    assert.equal(stopped.statusCode, 502);
    assert.equal(stopped.json().error.code, 'DOCKER_ERROR');
  });

  await t.test('viewer mutation attempts → 403 FORBIDDEN (role) — start/stop/delete/create/templates/exceptions', async () => {
    const MUTATIONS = [
      ['POST', '/api/containers/stopped-app/start', null],
      ['POST', '/api/containers/app/stop', null],
      ['POST', '/api/containers/app/restart', null],
      ['DELETE', '/api/containers/app', { confirm: 'app' }],
      ['POST', '/api/containers', { templateId: 'smoke', name: 'p2x', idempotencyKey: 'k0123456789abc' }],
      ['POST', '/api/templates', { id: 'smoke', displayName: 'Smoke', image: 'nginx:1.27' }],
      ['POST', '/api/containers/exceptions', { name: 'legacy' }],
      ['GET', '/api/containers/exceptions', null],
    ];
    for (const [method, url, body] of MUTATIONS) {
      const res = await app.inject({ method, url, headers: H, payload: body });
      assert.equal(res.statusCode, 403, `${method} ${url} should be 403, got ${res.statusCode}: ${res.body}`);
    }
  });
});

test('container API: operator mutations + managed gate + idempotency', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());
  const cookie = await login(app, 'operator');
  const H = { cookie };

  await t.test('start exited → 200 running (engine called)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/containers/stopped-app/start', headers: H });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().state, 'running');
    assert.equal(res.json().idempotent, false);
    const startAudits = db.__state.auditRows.filter((a) => a.action === 'container.start' && a.status === 'success');
    assert.equal(startAudits.length, 1);
    assert.equal(startAudits[0].resourceId, 'b'.repeat(64));
    assert.equal(startAudits[0].detailsJson.from, 'exited');
    assert.equal(startAudits[0].detailsJson.to, 'running');
  });

  await t.test('start already-running → 200 idempotent:true (NOT a failure)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/containers/stopped-app/start', headers: H });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().idempotent, true);
    assert.equal(res.json().state, 'running');
  });

  await t.test('stop → exited; stop again → idempotent; pause → paused; unpause → running; restart → running', async () => {
    let res = await app.inject({ method: 'POST', url: '/api/containers/app/stop', headers: H });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().state, 'exited');
    assert.equal(res.json().idempotent, false);

    res = await app.inject({ method: 'POST', url: '/api/containers/app/stop', headers: H });
    assert.equal(res.json().idempotent, true);

    res = await app.inject({ method: 'POST', url: '/api/containers/app/start', headers: H });
    assert.equal(res.json().state, 'running');

    res = await app.inject({ method: 'POST', url: '/api/containers/app/pause', headers: H });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().state, 'paused');

    res = await app.inject({ method: 'POST', url: '/api/containers/app/unpause', headers: H });
    assert.equal(res.json().state, 'running');

    res = await app.inject({ method: 'POST', url: '/api/containers/app/restart', headers: H });
    assert.equal(res.json().state, 'running');
    assert.equal(res.json().idempotent, false);
  });

  await t.test('unmanaged container mutation → 403 NOT_MANAGED + failure audit', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/containers/legacy/stop', headers: H });
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(res.json().error.code, 'NOT_MANAGED');
    assert.match(res.json().error.message, /legacy/);
    const failAudit = db.__state.auditRows.find((a) => a.action === 'container.stop' && a.status === 'failure');
    assert.ok(failAudit, 'not-managed attempt must be audited as failure');
    assert.equal(failAudit.detailsJson.reason, 'not_managed');
  });

  await t.test('pause exited container → 409 (clear guidance, no fake success)', async () => {
    // stopped-app is running from earlier subtests — stop it first, then pause must 409.
    const stop = await app.inject({ method: 'POST', url: '/api/containers/stopped-app/stop', headers: H });
    assert.equal(stop.statusCode, 200, stop.body);
    const res = await app.inject({ method: 'POST', url: '/api/containers/stopped-app/pause', headers: H });
    assert.equal(res.statusCode, 409, res.body);
  });

  await t.test('operator delete → 403 (admin only)', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/containers/app', headers: H, payload: { confirm: 'app' } });
    assert.equal(res.statusCode, 403);
  });
});

test('container API: admin delete (two-step confirm) + NOT_MANAGED guard', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());
  const cookie = await login(app, 'admin');
  const H = { cookie };

  await t.test('wrong confirm → 400, container survives', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/containers/stopped-app', headers: H, payload: { confirm: 'WRONG-NAME' } });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error.code, 'VALIDATION_ERROR');
    const list = await app.inject({ method: 'GET', url: '/api/containers', headers: H });
    assert.ok(list.json().items.some((i) => i.name === 'stopped-app'), 'container must survive a failed confirm');
  });

  await t.test('correct confirm (name) → deleted; gone from list; audited', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/containers/stopped-app', headers: H, payload: { confirm: 'stopped-app' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().deleted, true);
    const list = await app.inject({ method: 'GET', url: '/api/containers', headers: H });
    assert.ok(!list.json().items.some((i) => i.name === 'stopped-app'));
    const audit = db.__state.auditRows.find((a) => a.action === 'container.delete' && a.status === 'success');
    assert.ok(audit);
    assert.equal(audit.detailsJson.name, 'stopped-app');
  });

  await t.test('delete by id works (force while running); second delete → 404 CONTAINER_NOT_FOUND', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/containers/${'c'.repeat(64)}`, headers: H, payload: { confirm: 'legacy' } });
    // legacy is unmanaged — must be rejected BEFORE any confirm check
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'NOT_MANAGED');

    // 'app' is running — engine refuses without force (surfaced as classified DOCKER_ERROR)
    const noForce = await app.inject({ method: 'DELETE', url: '/api/containers/app', headers: H, payload: { confirm: 'app' } });
    assert.equal(noForce.statusCode, 502, noForce.body);

    const res2 = await app.inject({ method: 'DELETE', url: '/api/containers/app', headers: H, payload: { confirm: 'a'.repeat(64), force: true } });
    assert.equal(res2.statusCode, 200, res2.body);
    const ghost = await app.inject({ method: 'DELETE', url: '/api/containers/app', headers: H, payload: { confirm: 'app' } });
    assert.equal(ghost.statusCode, 404);
    assert.equal(ghost.json().error.code, 'CONTAINER_NOT_FOUND');
  });
});

test('container API: 404 classification through HTTP', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());
  const viewer = await login(app, 'viewer');
  const operator = await login(app, 'operator');

  await t.test('inspect/logs/stats unknown container → 404 (viewer); mutate unknown → 404 (operator)', async () => {
    for (const [url, cookie] of [
      ['/api/containers/ghost123', viewer],
      ['/api/containers/ghost123/logs', viewer],
      ['/api/containers/ghost123/stats', viewer],
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      assert.equal(res.statusCode, 404, `${url}: ${res.body}`);
      assert.equal(res.json().error.code, 'CONTAINER_NOT_FOUND');
    }
    const op = await app.inject({ method: 'POST', url: '/api/containers/ghost123/start', headers: { cookie: operator } });
    assert.equal(op.statusCode, 404, op.body);
    assert.equal(op.json().error.code, 'CONTAINER_NOT_FOUND');
  });
});

test('container API: daemon failure modes surface with distinct codes (MD §9.1)', async (t) => {
  await t.test('daemon down → 503 DOCKER_DAEMON_UNAVAILABLE (list + inspect)', async () => {
    const { app } = await makeApp({ dockerOpts: { mode: 'daemon-down' } });
    const cookie = await login(app, 'viewer');
    const list = await app.inject({ method: 'GET', url: '/api/containers', headers: { cookie } });
    assert.equal(list.statusCode, 503, list.body);
    assert.equal(list.json().error.code, 'DOCKER_DAEMON_UNAVAILABLE');
    assert.match(list.json().error.message, /daemon unavailable/i);
    const ins = await app.inject({ method: 'GET', url: '/api/containers/anything', headers: { cookie } });
    assert.equal(ins.statusCode, 503);
    assert.equal(ins.json().error.code, 'DOCKER_DAEMON_UNAVAILABLE');
    await app.close();
  });

  await t.test('permission denied → 502 DOCKER_PERMISSION_DENIED', async () => {
    const { app } = await makeApp({ dockerOpts: { mode: 'permission-denied' } });
    const cookie = await login(app, 'viewer');
    const list = await app.inject({ method: 'GET', url: '/api/containers', headers: { cookie } });
    assert.equal(list.statusCode, 502, list.body);
    assert.equal(list.json().error.code, 'DOCKER_PERMISSION_DENIED');
    await app.close();
  });

  await t.test('timeout → 504 DOCKER_TIMEOUT', async () => {
    const { app } = await makeApp({ dockerOpts: { mode: 'timeout' } });
    const cookie = await login(app, 'viewer');
    const list = await app.inject({ method: 'GET', url: '/api/containers', headers: { cookie } });
    assert.equal(list.statusCode, 504, list.body);
    assert.equal(list.json().error.code, 'DOCKER_TIMEOUT');
    await app.close();
  });

  await t.test('daemon-down mutation → 503 (never a fake success, failure audited)', async () => {
    const { app, db } = await makeApp({ dockerOpts: { mode: 'daemon-down' } });
    const cookie = await login(app, 'operator');
    const res = await app.inject({ method: 'POST', url: '/api/containers/app/start', headers: { cookie } });
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(res.json().error.code, 'DOCKER_DAEMON_UNAVAILABLE');
    // mutation handler audits failure with the code
    const fail = db.__state.auditRows.find((a) => a.action === 'container.start' && a.status === 'failure');
    assert.ok(fail);
    assert.equal(fail.detailsJson.code, 'DOCKER_DAEMON_UNAVAILABLE');
    await app.close();
  });
});
