/**
 * Docker error classification (施工 MD §9.1 hard rule + §16.1):
 *   - definitive 404 / "no such container"  → CONTAINER_NOT_FOUND (404)
 *   - EACCES / permission denied            → PERMISSION_DENIED (502)
 *   - socket errno / daemon down            → DAEMON_UNAVAILABLE (503)
 *   - timeout                               → TIMEOUT (504)
 *   - anything else                         → GENERIC (502)
 * Precedence: a timeout or socket error must NEVER be read as not-found,
 * and a definitive 404 wins over message noise (ADR §3-2-7).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyDockerError } from '../../apps/api/src/services/docker-service.js';
import { DOCKER_ERROR } from '@water-army/shared';

function withCode(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function withStatus(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

test('classification: definitive 404 (statusCode or daemon wording)', async (t) => {
  await t.test('statusCode 404 → CONTAINER_NOT_FOUND 404', () => {
    const r = classifyDockerError(withStatus(404, 'No such container: abc'));
    assert.equal(r.code, DOCKER_ERROR.CONTAINER_NOT_FOUND);
    assert.equal(r.status, 404);
  });

  await t.test('engine wording "No such container" (any 4xx status) → CONTAINER_NOT_FOUND', () => {
    const r = classifyDockerError(withStatus(400, 'No such container: deadbeef'));
    assert.equal(r.code, DOCKER_ERROR.CONTAINER_NOT_FOUND);
    assert.equal(r.status, 404); // normalized to 404
  });

  await t.test('daemon 4xx + "No such network" wording → CONTAINER_NOT_FOUND', () => {
    const r = classifyDockerError(withStatus(400, 'No such network: x'));
    assert.equal(r.code, DOCKER_ERROR.CONTAINER_NOT_FOUND);
  });

  await t.test('wording ALONE (no daemon status) is NOT definitive → stays GENERIC (MD §9.1)', () => {
    // No statusCode = no proven daemon answer — must not be read as not-found.
    const r = classifyDockerError(new Error('network "x" not found'));
    assert.equal(r.code, DOCKER_ERROR.GENERIC);
  });
});

test('classification: permission denied', async (t) => {
  await t.test('EACCES → PERMISSION_DENIED 502', () => {
    const r = classifyDockerError(withCode('EACCES', 'open /var/run/docker.sock: permission denied'));
    assert.equal(r.code, DOCKER_ERROR.PERMISSION_DENIED);
    assert.equal(r.status, 502);
  });

  await t.test('message-only "permission denied" → PERMISSION_DENIED', () => {
    const r = classifyDockerError(new Error('dial unix: permission denied'));
    assert.equal(r.code, DOCKER_ERROR.PERMISSION_DENIED);
  });
});

test('classification: daemon unavailable (socket failures)', async (t) => {
  const cases = [
    ['ECONNREFUSED', 'connect ECONNREFUSED /var/run/docker.sock'],
    ['ENOENT', 'ENOENT: no such file or directory, stat /var/run/docker.sock'],
    ['ECONNRESET', 'read ECONNRESET'],
    ['EPIPE', 'write EPIPE'],
    ['ENETUNREACH', 'connect ENETUNREACH'],
    ['EHOSTUNREACH', 'connect EHOSTUNREACH'],
  ];
  for (const [code, msg] of cases) {
    await t.test(`${code} → DAEMON_UNAVAILABLE 503`, () => {
      const r = classifyDockerError(withCode(code, msg));
      assert.equal(r.code, DOCKER_ERROR.DAEMON_UNAVAILABLE);
      assert.equal(r.status, 503);
    });
  }
  await t.test('"dial unix" wording without errno → DAEMON_UNAVAILABLE', () => {
    const r = classifyDockerError(new Error('dial unix /var/run/docker.sock: connect: connection refused'));
    assert.equal(r.code, DOCKER_ERROR.DAEMON_UNAVAILABLE);
  });
  await t.test('daemon dropped connection (client connection lost) → DAEMON_UNAVAILABLE', () => {
    const r = classifyDockerError(new Error('client connection lost'));
    assert.equal(r.code, DOCKER_ERROR.DAEMON_UNAVAILABLE);
  });
});

test('classification: timeout', async (t) => {
  await t.test('ETIMEDOUT → TIMEOUT 504', () => {
    const r = classifyDockerError(withCode('ETIMEDOUT', 'connect ETIMEDOUT'));
    assert.equal(r.code, DOCKER_ERROR.TIMEOUT);
    assert.equal(r.status, 504);
  });
  await t.test('ESOCKETTIMEDOUT → TIMEOUT 504', () => {
    const r = classifyDockerError(withCode('ESOCKETTIMEDOUT', 'socket timed out'));
    assert.equal(r.code, DOCKER_ERROR.TIMEOUT);
  });
  await t.test('statusCode 408 → TIMEOUT', () => {
    const r = classifyDockerError(withStatus(408, 'Request Timeout'));
    assert.equal(r.code, DOCKER_ERROR.TIMEOUT);
  });
  await t.test('message "request timed out" → TIMEOUT', () => {
    const r = classifyDockerError(new Error('request timed out after 30000ms'));
    assert.equal(r.code, DOCKER_ERROR.TIMEOUT);
  });
});

test('classification: unclassified → GENERIC 502 (message preserved)', () => {
  const r = classifyDockerError(new Error('weird engine blerg 418'));
  assert.equal(r.code, DOCKER_ERROR.GENERIC);
  assert.equal(r.status, 502);
  assert.match(r.message, /weird engine blerg/);
});

test('precedence: never conflate (MD §9.1)', async (t) => {
  await t.test('timeout error with not-found-ish message → TIMEOUT (code wins)', () => {
    const r = classifyDockerError(withCode('ETIMEDOUT', 'container xyz not found (timed out)'));
    assert.equal(r.code, DOCKER_ERROR.TIMEOUT);
  });

  await t.test('socket error with scary message → DAEMON_UNAVAILABLE, not not-found', () => {
    const r = classifyDockerError(withCode('ECONNREFUSED', 'no such container: dial failed'));
    assert.equal(r.code, DOCKER_ERROR.DAEMON_UNAVAILABLE);
  });

  await t.test('definitive 404 wins over socket-errno noise', () => {
    const e = withStatus(404, 'No such container: abc');
    e.code = 'ECONNREFUSED'; // contradictory — daemon did answer, 404 is definitive
    const r = classifyDockerError(e);
    assert.equal(r.code, DOCKER_ERROR.CONTAINER_NOT_FOUND);
  });

  await t.test('empty/null error → GENERIC, not a crash', () => {
    const r = classifyDockerError(null);
    assert.equal(r.code, DOCKER_ERROR.GENERIC);
    assert.ok(r.message.length > 0);
  });
});
