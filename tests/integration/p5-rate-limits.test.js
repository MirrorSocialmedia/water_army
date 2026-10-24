/**
 * P5 hardening — HTTP-level rate limiting on Mobile Console create paths
 * (MD §11.9: 「Rate limit stream create … 和通知建立」).
 *
 * Proves at the HTTP layer (real route + preHandler code, hermetic db):
 *  - stream create (POST /api/devices/redroid/:id/streams): per-user 10/min —
 *    the 11th request in the window gets 429 RATE_LIMITED + Retry-After,
 *    regardless of what the service layer would have returned
 *  - intervention create (POST /api/manual-interventions): per-user 30/min —
 *    31st gets 429; dedupe still yields ONE episode row under the spam
 *    (rate limit must not create a notification storm, MD §6.3)
 *  - ordering: unauthenticated requests are 401 at requireRole BEFORE the
 *    limiter and never burn a budget slot (a login flood is the login
 *    limiter's job, not this one)
 *  - role denied (viewer creating an intervention) is 403 before the limiter
 *
 * The hermetic app has NO stream data surface (fake db lacks the
 * streamLease/resourceLease delegates) → the service layer answers 503
 * STREAM_LEASE_UNAVAILABLE. That is FINE: the rate-limit preHandler runs
 * before the handler, so the 429 boundary is exercised independently of
 * the service (real-stack coverage = scripts/mobileconsole-p5 E2E).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRedroidTestApp, login } from '../helpers/redroid-fakes.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

async function makeApp() {
  const { app, db, close } = await makeRedroidTestApp();
  const admin = await login(app, 'admin');
  const operator = await login(app, 'operator');
  const viewer = await login(app, 'viewer');
  return { app, db, close, cookies: { admin, operator, viewer } };
}

test('stream create: per-user rate limit (10/min) → 429 + Retry-After on the 11th', async () => {
  const { app, close, cookies } = await makeApp();
  try {
    const status = [];
    let retryAfter = null;
    for (let i = 0; i < 11; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/devices/redroid/${UUID}/streams`,
        headers: { cookie: cookies.admin },
        payload: { mode: 'viewer' },
      });
      status.push(res.statusCode);
      if (res.statusCode === 429) retryAfter = res.headers['retry-after'];
      const body = res.json();
      if (res.statusCode === 429) assert.equal(body.error.code, 'RATE_LIMITED');
      else assert.notEqual(res.statusCode, 429, `request ${i + 1} must pass the limiter (got 429)`);
    }
    // hermetic: the service is 503-unavailable, but the LIMITER boundary is
    // exactly 10 → the 11th is 429, not another 503.
    assert.equal(status.filter((s) => s === 429).length, 1, `statuses: ${status.join(',')}`);
    assert.equal(status[10], 429);
    assert.ok(Number(retryAfter) >= 1, '429 carries a sane Retry-After (seconds)');
  } finally {
    await close();
  }
});

test('stream create: unauthenticated floods do NOT burn the user budget', async () => {
  const { app, close, cookies } = await makeApp();
  try {
    // 20 unauthenticated requests → all 401 (requireOrder: auth before limiter)
    for (let i = 0; i < 20; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/devices/redroid/${UUID}/streams`,
        payload: { mode: 'viewer' },
      });
      assert.equal(res.statusCode, 401, `unauth ${i + 1} must be 401, got ${res.statusCode}`);
    }
    // the user's FULL budget is intact: 10 pass, 11th = 429
    let got429At = null;
    for (let i = 0; i < 11; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/devices/redroid/${UUID}/streams`,
        headers: { cookie: cookies.admin },
        payload: { mode: 'viewer' },
      });
      if (res.statusCode === 429) { got429At = i; break; }
    }
    assert.equal(got429At, 10, 'unauth flood must not consume the user budget');
  } finally {
    await close();
  }
});

test('intervention create: per-user rate limit (30/min) → 429 on the 31st; dedupe keeps ONE episode', async () => {
  const { app, db, close, cookies } = await makeApp();
  try {
    const body = {
      source: 'operator_report',
      category: 'OTHER',
      title: `p5 spam ${Date.now()}`,
      deviceNameSnapshot: 'spam-device',
      severity: 'info',
    };
    const status = [];
    for (let i = 0; i < 31; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/manual-interventions',
        headers: { cookie: cookies.operator },
        payload: body,
      });
      status.push(res.statusCode);
    }
    const n429 = status.filter((s) => s === 429).length;
    assert.equal(n429, 1, `exactly one 429 in the window: ${status.join(',')}`);
    assert.equal(status[30], 429);
    const denied = await app.inject({
      method: 'POST',
      url: '/api/manual-interventions',
      headers: { cookie: cookies.operator },
      payload: body,
    });
    assert.equal(denied.statusCode, 429);
    assert.ok(Number(denied.headers['retry-after']) >= 1);

    // The 30 accepted signals all hit the SAME dedupe episode
    // (device::category::source) → exactly one row, signalCount = 30.
    const rows = await db.manualIntervention.findMany({
      where: { deviceNameSnapshot: 'spam-device' },
    });
    assert.equal(rows.length, 1, 'spam must collapse into one episode (no notification storm)');
    assert.equal(rows[0].signalCount, 30);
  } finally {
    await close();
  }
});

test('intervention create: viewer is 403 (role) and does not burn the operator budget', async () => {
  const { app, close, cookies } = await makeApp();
  try {
    const body = { source: 'operator_report', category: 'OTHER', title: 'x', deviceNameSnapshot: 'x' };
    const denied = await app.inject({
      method: 'POST',
      url: '/api/manual-interventions',
      headers: { cookie: cookies.viewer },
      payload: body,
    });
    assert.equal(denied.statusCode, 403, 'viewer cannot create interventions (MD §11.2)');
    // operator budget intact: 31st still the boundary
    let got429At = null;
    for (let i = 0; i < 31; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/manual-interventions',
        headers: { cookie: cookies.operator },
        payload: body,
      });
      if (res.statusCode === 429) { got429At = i; break; }
    }
    assert.equal(got429At, 30);
  } finally {
    await close();
  }
});
