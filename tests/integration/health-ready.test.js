/**
 * Health readiness integration tests (施工 MD §16.1 / work order P1):
 *  - all up → 200 ok
 *  - docker down → 200 degraded (worker can restart api later; per work order)
 *  - docker disabled (DOCKER_SOCKET_PATH empty) → not a readiness failure
 *  - redis down → 503 (worker queue unavailable)
 *  - db down → 503 (auth unusable)
 *  - live → always 200 (process alive only)
 *  - down dependencies carry error detail; checks are bounded (no hangs)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../../apps/api/src/app.js';
import {
  makeFakeDb,
  dbDownFake,
  testConfig,
  fakeRedisOk,
  fakeRedisDown,
  fakeDockerOk,
  fakeDockerDown,
  fakeDockerDisabled,
} from '../helpers/fakes.js';

async function ready({ db, redis, docker }) {
  const app = await buildApp({ config: testConfig, db, redis, docker });
  try {
    return await app.inject({ method: 'GET', url: '/api/health/ready' });
  } finally {
    await app.close();
  }
}

test('ready: all up → 200 ok', async () => {
  const res = await ready({ db: makeFakeDb(), redis: fakeRedisOk(), docker: fakeDockerOk() });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.dependencies.postgres.status, 'up');
  assert.equal(body.dependencies.redis.status, 'up');
  assert.equal(body.dependencies.docker.status, 'up');
});

test('ready: docker down → 200 degraded (work-order contract)', async () => {
  const res = await ready({ db: makeFakeDb(), redis: fakeRedisOk(), docker: fakeDockerDown() });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'degraded');
  assert.equal(body.dependencies.docker.status, 'down');
  assert.ok(body.dependencies.docker.error.length > 0, 'error detail present');
});

test('ready: docker disabled → 200 ok (opt-out, not a failure)', async () => {
  const res = await ready({ db: makeFakeDb(), redis: fakeRedisOk(), docker: fakeDockerDisabled() });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
  assert.equal(res.json().dependencies.docker.status, 'disabled');
});

test('ready: redis down → 503 degraded', async () => {
  const res = await ready({ db: makeFakeDb(), redis: fakeRedisDown(), docker: fakeDockerOk() });
  assert.equal(res.statusCode, 503);
  const body = res.json();
  assert.equal(body.status, 'degraded');
  assert.equal(body.dependencies.redis.status, 'down');
  assert.ok(body.dependencies.redis.error.length > 0);
});

test('ready: db down → 503 degraded', async () => {
  const res = await ready({ db: dbDownFake(), redis: fakeRedisOk(), docker: fakeDockerOk() });
  assert.equal(res.statusCode, 503);
  const body = res.json();
  assert.equal(body.status, 'degraded');
  assert.equal(body.dependencies.postgres.status, 'down');
  assert.ok(body.dependencies.postgres.error.length > 0);
});

test('ready: multiple deps down still bounded (resolves, no hang)', async () => {
  const res = await ready({ db: dbDownFake(), redis: fakeRedisDown(), docker: fakeDockerDown() });
  assert.equal(res.statusCode, 503);
  const body = res.json();
  assert.equal(body.dependencies.postgres.status, 'down');
  assert.equal(body.dependencies.redis.status, 'down');
  assert.equal(body.dependencies.docker.status, 'down');
});

test('live: always 200 even with all deps down', async () => {
  const app = await buildApp({ config: testConfig, db: dbDownFake(), redis: fakeRedisDown(), docker: fakeDockerDown() });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/health/live' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'ok');
    assert.equal(typeof res.json().uptimeSeconds, 'number');
  } finally {
    await app.close();
  }
});

test('ready: response is machine-readable and has no secret leakage', async () => {
  const res = await ready({ db: makeFakeDb(), redis: fakeRedisDown(), docker: fakeDockerDown() });
  const out = res.body;
  assert.doesNotMatch(out, /password|secret|Bearer|session=/i);
  assert.equal(typeof JSON.parse(out), 'object');
});
