/**
 * WA-UI-SURFACY s4 — GET /api/system/config-summary (Settings 系統配置總覽).
 *
 * Real HTTP path (app.inject) over the REAL app + fake db (house pattern).
 * Covers:
 *  - RBAC: admin-only (anonymous 401; viewer/operator 403) — mirrors the
 *    sibling admin config surfaces (ram-gate, providers)
 *  - projection honesty: caps / switches echo the injected config; the
 *    recovery pool is a COUNT only (mailbox addresses never surface)
 *  - redaction: no secret fragments cross the surface
 *  - ramGate section resolves WITHOUT a constructible gate (pure resolver)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from '@node-rs/argon2';

import { buildApp } from '../../apps/api/src/app.js';
import { makeFakeDb, testConfig, fakeRedisOk, fakeDockerOk } from '../helpers/fakes.js';

const { argon2id, hash } = argon2;
const PASSWORD = 'TestPass123';

const CONFIG = {
  ...testConfig,
  egressBindingEnabled: true,
  egressEchoHost: 'echo.invalid',
  egressEchoPort: 18443,
  egressProbeTimeoutMs: 10_000,
  egressStaleMs: 90_000,
  egressFailThreshold: 2,
  gmailProvisionEnabled: false,
  gmailPerIpDaily: 3,
  gmailPerIdentityDaily: 1,
  gmailMinIntervalMs: 300_000,
  gmailMaxIntervalMs: 900_000,
  gmailCaptchaTimeoutMs: 7_200_000,
  gmailRecoveryPool: ['pool-a@example.invalid', 'pool-b@example.invalid'],
  redroidRoOverridesEnabled: true,
  redroidTemplateProfilesEnabled: false,
  waAppOpsEnabled: true,
};

async function makeApp() {
  const passwordHash = await hash(PASSWORD, { type: argon2id });
  const users = [
    { id: 'u-admin', username: 'admin1', passwordHash, role: 'admin' },
    { id: 'u-op', username: 'operator1', passwordHash, role: 'operator' },
    { id: 'u-view', username: 'viewer1', passwordHash, role: 'viewer' },
  ];
  const db = makeFakeDb({ users });
  const app = await buildApp({ config: CONFIG, db, redis: fakeRedisOk(), docker: fakeDockerOk() });
  return { app, db };
}

async function login(app, username) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD } });
  assert.equal(res.statusCode, 200, `login ${username} failed: ${res.body}`);
  return res.headers['set-cookie'].split(';')[0];
}

test('config-summary rbac: anonymous 401; viewer/operator 403; admin 200', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const anon = await app.inject({ method: 'GET', url: '/api/system/config-summary' });
  assert.equal(anon.statusCode, 401);

  const viewer = await login(app, 'viewer1');
  const v = await app.inject({ method: 'GET', url: '/api/system/config-summary', headers: { cookie: viewer } });
  assert.equal(v.statusCode, 403);

  const op = await login(app, 'operator1');
  const o = await app.inject({ method: 'GET', url: '/api/system/config-summary', headers: { cookie: op } });
  assert.equal(o.statusCode, 403);

  const admin = await login(app, 'admin1');
  const a = await app.inject({ method: 'GET', url: '/api/system/config-summary', headers: { cookie: admin } });
  assert.equal(a.statusCode, 200, a.body);
  return { app, admin };
});

test('config-summary projection: caps/switches honest, pool is COUNT-only, zero secret leakage', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());
  const admin = await login(app, 'admin1');
  const res = await app.inject({ method: 'GET', url: '/api/system/config-summary', headers: { cookie: admin } });
  assert.equal(res.statusCode, 200);
  const s = res.json();

  // egress probe surface (endpoint, not credential)
  assert.equal(s.egress.bindingEnabled, true);
  assert.equal(s.egress.echoHost, 'echo.invalid');
  assert.equal(s.egress.echoPort, 18443);
  assert.equal(s.egress.staleMs, 90_000);

  // registration caps + redaction: pool size only — addresses never travel
  assert.equal(s.registration.perIpDailyCap, 3);
  assert.equal(s.registration.perIdentityDailyCap, 1);
  assert.equal(s.registration.provisionEnabled, false);
  assert.equal(s.registration.recoveryPoolSize, 2);

  // SMS policy constants (human-gate contract, ADR-030)
  assert.equal(s.sms.autoSolveAllowed, false);
  assert.equal(s.sms.captchaTimeoutMs, 7_200_000);

  // fingerprint / app-ops switches
  assert.equal(s.fingerprint.roOverridesEnabled, true);
  assert.equal(s.fingerprint.templateProfilesEnabled, false);
  assert.equal(s.fingerprint.appOpsEnabled, true);

  // ram-gate resolves from defaults+env WITHOUT a gate object (pure resolver)
  assert.equal(s.ramGate.available, true);
  for (const k of ['enabled', 'maxParallel', 'hardFloorMiB', 'postBootTargetMiB', 'perBootBudgetMiB']) {
    assert.ok(k in s.ramGate.config, `ramGate.config.${k} missing`);
  }

  // redaction: no mailbox address / no credential-shaped fragment in the body
  for (const frag of ['pool-a@example.invalid', 'pool-b@example.invalid', 'password', 'proxyUrl', 'token']) {
    assert.ok(!res.body.includes(frag), `config-summary leaked fragment '${frag}'`);
  }
});
