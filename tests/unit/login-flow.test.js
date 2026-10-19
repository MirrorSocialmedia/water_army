/**
 * Login flow unit tests (施工 MD §16.1 / §13.2):
 *  - argon2id verification (wrong password, unknown user, inactive user)
 *  - failures audited with reason
 *  - success → HttpOnly SameSite=Lax cookie → /me → logout revokes
 *  - expired session rejected
 *  - rate limit: 5 failures / 60s / IP → 429
 *  - body validation (missing / unknown fields)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import argon2 from '@node-rs/argon2';

import { buildApp } from '../../apps/api/src/app.js';
import { makeFakeDb, testConfig, fakeRedisOk, fakeDockerOk } from '../helpers/fakes.js';

const { argon2id, hash } = argon2;
const PASSWORD = 'TestPass123';

async function makeApp({ users = [] } = {}) {
  const db = makeFakeDb({ users });
  const app = await buildApp({ config: testConfig, db, redis: fakeRedisOk(), docker: fakeDockerOk() });
  return { app, db };
}

test('login flow', async (t) => {
  const passwordHash = await hash(PASSWORD, { type: argon2id });
  const { app, db } = await makeApp({
    users: [
      { id: 'u1', username: 'admin', passwordHash, role: 'admin' },
      { id: 'u2', username: 'lockedout', passwordHash, role: 'viewer', isActive: false },
    ],
  });
  t.after(() => app.close());

  await t.test('wrong password → 401 INVALID_CREDENTIALS + audit reason bad_password', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'WrongPass99' } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'INVALID_CREDENTIALS');
    const failed = db.__state.auditRows.find((a) => a.action === 'auth.login_failed');
    assert.ok(failed, 'login failure must be audited');
    assert.equal(failed.detailsJson.reason, 'bad_password');
    assert.equal(failed.status, 'failure');
  });

  await t.test('unknown user → 401 + audit reason unknown_user (same generic message)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ghost', password: 'Whatever123' } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'INVALID_CREDENTIALS');
    const failed = db.__state.auditRows.at(-1);
    assert.equal(failed.detailsJson.reason, 'unknown_user');
  });

  await t.test('inactive user → 401 + audit reason inactive', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'lockedout', password: PASSWORD } });
    assert.equal(res.statusCode, 401);
    assert.equal(db.__state.auditRows.at(-1).detailsJson.reason, 'inactive');
  });

  await t.test('success → 200 + user body + HttpOnly SameSite=Lax cookie; /me 200; hash never leaks', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: PASSWORD } });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.deepEqual(body.user, { id: 'u1', username: 'admin', role: 'admin' });
    const cookieHeader = res.headers['set-cookie'];
    assert.ok(cookieHeader.startsWith('session='));
    assert.match(cookieHeader, /httponly/i);
    assert.match(cookieHeader, /samesite=lax/i);
    const maxAge = Number(/max-age=(\d+)/i.exec(cookieHeader)[1]);
    assert.ok(maxAge > 3400 && maxAge <= 3600, `Max-Age should be ~TTL, got ${maxAge}`);
    assert.ok(!res.body.includes('$argon2'), 'hash must never be returned');

    const cookie = cookieHeader.split(';')[0];
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.username, 'admin');
    assert.equal(me.json().user.lastLoginAt != null, true, 'lastLoginAt updated');

    // stored session row must be a hash, not the token
    const stored = [...db.__state.sessionRows.values()][0];
    const rawToken = cookie.split('=')[1];
    assert.equal(stored.tokenHash, createHash('sha256').update(rawToken).digest('hex'), 'sha-256 hex stored');
    assert.ok(!stored.tokenHash.includes(rawToken), 'plaintext token never stored');
  });

  await t.test('logout → 204 + cookie cleared + session revoked (me 401 after)', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: PASSWORD } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const before = db.__state.sessionRows.size;
    assert.ok(before > 0);

    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    assert.equal(out.statusCode, 204);
    assert.match(out.headers['set-cookie'], /max-age=0/i);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    assert.equal(me.statusCode, 401);
    assert.equal(db.__state.sessionRows.size, before - 1);
  });

  await t.test('expired session → rejected (row cleaned), /me 401', async () => {
    // Issue a real session, then backdate its expiry.
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: PASSWORD } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const row = [...db.__state.sessionRows.values()].at(-1);
    row.expiresAt = new Date(Date.now() - 1000);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    assert.equal(me.statusCode, 401);
  });

});

test('rate limit: 5 failed logins / 60s / IP → 6th is 429 (fresh app, clean limiter)', async (t) => {
  const passwordHash = await hash(PASSWORD, { type: argon2id });
  const { app, db } = await makeApp({ users: [{ id: 'u1', username: 'admin', passwordHash, role: 'admin' }] });
  t.after(() => app.close());

  for (let i = 0; i < 5; i++) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: `Wrong${i}99` } });
    assert.equal(res.statusCode, 401, `attempt ${i + 1} should be 401, got ${res.statusCode}`);
  }
  const sixth = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: `WrongX99` } });
  assert.equal(sixth.statusCode, 429);
  assert.equal(sixth.json().error.code, 'RATE_LIMITED');
  assert.ok(Number(sixth.headers['retry-after']) >= 1);
  const last = db.__state.auditRows.at(-1);
  assert.equal(last.action, 'auth.login_failed');
  assert.equal(last.detailsJson.reason, 'rate_limited');

  // correct password is also rejected while the limit is active (no bypass)
  const withReal = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: PASSWORD } });
  assert.equal(withReal.statusCode, 429);
});

test('rate limit is keyed by (ip+username): flooding one account does not lock out another', async (t) => {
  const passwordHash = await hash(PASSWORD, { type: argon2id });
  const { app } = await makeApp({
    users: [
      { id: 'u1', username: 'admin', passwordHash, role: 'admin' },
      { id: 'u2', username: 'victim', passwordHash, role: 'admin' },
    ],
  });
  t.after(() => app.close());

  // Attacker burns the limit on 'admin' (same source ip in app.inject).
  for (let i = 0; i < 6; i++) {
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: `Wrong${i}99` } });
  }
  const adminBlocked = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: PASSWORD } });
  assert.equal(adminBlocked.statusCode, 429, 'the flooded account is rate-limited');

  // A different account from the same ip is unaffected — this is the DoS fix.
  const victimOk = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'victim', password: PASSWORD } });
  assert.equal(victimOk.statusCode, 200, 'other accounts must not be locked out');
});

test('login body validation (fresh app, no rate-limit interference)', async (t) => {
  const { app } = await makeApp({ users: [{ id: 'u1', username: 'admin', passwordHash: await hash(PASSWORD, { type: argon2id }), role: 'admin' }] });
  t.after(() => app.close());

  await t.test('missing field → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin' } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'VALIDATION_ERROR');
  });

  await t.test('unknown extra field → 400 (additionalProperties:false)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: PASSWORD, admin: true } });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /additional properties/i);
  });

  await t.test('bad username shape → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'x', password: PASSWORD } });
    assert.equal(res.statusCode, 400);
  });
});
