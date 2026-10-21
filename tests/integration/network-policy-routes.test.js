/**
 * BR-B6 G4 — network policy admin routes (apps/api/src/routes/network-policy.js).
 *
 * Real HTTP path (app.inject) over the REAL app with the fake db (house
 * convention). Covers:
 *   - RBAC: admin-only for BOTH read and write (401 anonymous / 403 viewer+operator)
 *   - GET: effective policy = env + AppSetting union; honest unavailable state
 *   - PUT allowlists: validation with the GATE's exact parser (malformed = 400,
 *     nothing written), null = remove row, [] = clear (legal emergency stop),
 *     updatedBy + audit on every write, effective echo on every response
 *   - PUT task-types: complete-object-only ({ai, adhoc} booleans)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from '@node-rs/argon2';

import { buildApp } from '../../apps/api/src/app.js';
import { makeFakeDb, testConfig, fakeRedisOk, fakeDockerOk } from '../helpers/fakes.js';
import { NETWORK_SETTING_KEYS } from '../../packages/shared/src/network-policy.js';

const { argon2id, hash } = argon2;
const PASSWORD = 'TestPass123';

async function makeApp() {
  const passwordHash = await hash(PASSWORD, { type: argon2id });
  const users = [
    { id: 'u-admin', username: 'admin1', passwordHash, role: 'admin' },
    { id: 'u-op', username: 'operator1', passwordHash, role: 'operator' },
    { id: 'u-view', username: 'viewer1', passwordHash, role: 'viewer' },
  ];
  const db = makeFakeDb({ users });
  const app = await buildApp({ config: testConfig, db, redis: fakeRedisOk(), docker: fakeDockerOk() });
  return { app, db };
}

async function login(app, username) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD } });
  assert.equal(res.statusCode, 200, `login ${username} failed: ${res.body}`);
  return res.headers['set-cookie'].split(';')[0];
}

const body = (res) => JSON.parse(res.body);
const H = (cookie) => ({ cookie });

test('g4 rbac: anonymous 401 on all three routes; viewer/operator 403 on read AND write', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  for (const [method, url, payload] of [
    ['GET', '/api/network-policy', null],
    ['PUT', '/api/network-policy/allowlists', { allowlist: [] }],
    ['PUT', '/api/network-policy/task-types', { ai: true, adhoc: true }],
  ]) {
    // NOTE: schema-valid bodies — fastify validates the body BEFORE the auth
    // preHandler, so an anonymous call with a bad body would 400, masking
    // the 401 we are actually testing.
    const anon = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    assert.equal(anon.statusCode, 401, `${method} ${url} anonymous must be 401`);
    assert.equal(body(anon).error.code, 'UNAUTHORIZED');
  }

  const view = await login(app, 'viewer1');
  const op = await login(app, 'operator1');
  for (const cookie of [view, op]) {
    const read = await app.inject({ method: 'GET', url: '/api/network-policy', headers: H(cookie) });
    assert.equal(read.statusCode, 403, 'non-admin read must be 403');
    const putA = await app.inject({ method: 'PUT', url: '/api/network-policy/allowlists', headers: H(cookie), payload: { allowlist: ['https://qa.example.com'] } });
    assert.equal(putA.statusCode, 403, 'non-admin allowlist write must be 403');
    const putT = await app.inject({ method: 'PUT', url: '/api/network-policy/task-types', headers: H(cookie), payload: { ai: true, adhoc: true } });
    assert.equal(putT.statusCode, 403, 'non-admin task-types write must be 403');
  }
});

test('g4 read: no policy anywhere → honestly unavailable (fail-closed state, not a 500)', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());
  delete process.env.QA_ENDPOINT_ALLOWLIST;
  delete process.env.QA_ENDPOINT_ALLOWLIST_INTERNAL;

  const admin = await login(app, 'admin1');
  const res = await app.inject({ method: 'GET', url: '/api/network-policy', headers: H(admin) });
  assert.equal(res.statusCode, 200, res.body);
  const v = body(res);
  assert.equal(v.available, false);
  assert.match(v.reason, /no allowlist entries/);
  assert.equal(v.effective, null);
  assert.equal(v.appSettings[NETWORK_SETTING_KEYS.ALLOWLIST], null);
  assert.equal(v.appSettings[NETWORK_SETTING_KEYS.TASK_TYPES], null);
});

test('g4 write allowlist: valid entry → 200 + row (updatedBy) + audit + effective echo', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());
  delete process.env.QA_ENDPOINT_ALLOWLIST;
  delete process.env.QA_ENDPOINT_ALLOWLIST_INTERNAL;

  const admin = await login(app, 'admin1');
  const res = await app.inject({
    method: 'PUT',
    url: '/api/network-policy/allowlists',
    headers: H(admin),
    payload: { allowlist: ['https://qa.example.com'] },
  });
  assert.equal(res.statusCode, 200, res.body);
  const v = body(res);
  assert.equal(v.available, true);
  assert.equal(v.changed[0], NETWORK_SETTING_KEYS.ALLOWLIST);
  assert.deepEqual(v.effective.entries.public, [{ scheme: 'https', host: 'qa.example.com', port: 443 }]);

  const row = await db.appSetting.findUnique({ where: { key: NETWORK_SETTING_KEYS.ALLOWLIST } });
  assert.deepEqual(row.valueJson, ['https://qa.example.com']);
  assert.equal(row.updatedBy, 'u-admin');

  const audits = db.__state.auditRows.filter((a) => a.action === 'network_policy.allowlist_set');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actorUserId, 'u-admin');
  assert.equal(audits[0].detailsJson.zones[0].count, 1);
});

test('g4 write allowlist: MALFORMED entry → 400 + nothing written (same parser as the gate)', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());
  delete process.env.QA_ENDPOINT_ALLOWLIST;
  delete process.env.QA_ENDPOINT_ALLOWLIST_INTERNAL;

  const admin = await login(app, 'admin1');
  const cases = [
    ['ftp://qa.example.com', /scheme/],
    ['https://user:pass@qa.example.com', /credentials/],
    ['https://qa.example.com/path', /path/],
    ['https://qa.example.com:70000', /port/],
    ['https://*.example.com', /wildcard/],
  ];
  for (const [entry, re] of cases) {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/network-policy/allowlists',
      headers: H(admin),
      payload: { allowlist: [entry] },
    });
    assert.equal(res.statusCode, 400, `${entry} must be 400, got ${res.statusCode}: ${res.body}`);
    assert.match(body(res).error.message, re);
  }
  for (const key of Object.values(NETWORK_SETTING_KEYS)) {
    assert.equal(await db.appSetting.findUnique({ where: { key } }), null, `${key} must not be written on validation failure`);
  }
});

test('g4 write allowlist: body guards — empty body / unknown property / non-string item → 400', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());
  const admin = await login(app, 'admin1');
  for (const payload of [{}, { allowlist: 42 }, { allowlist: [42] }, { allowlist: ['https://qa.example.com'], noSuchKey: true }]) {
    const res = await app.inject({ method: 'PUT', url: '/api/network-policy/allowlists', headers: H(admin), payload });
    assert.equal(res.statusCode, 400, `payload ${JSON.stringify(payload)} must be 400`);
  }
});

test('g4 write allowlist: null removes the row (back to env-only); [] is a legal clear', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());
  process.env.QA_ENDPOINT_ALLOWLIST = 'https://envhost.example.com';
  t.after(() => { delete process.env.QA_ENDPOINT_ALLOWLIST; });

  const admin = await login(app, 'admin1');
  const put = (payload) => app.inject({ method: 'PUT', url: '/api/network-policy/allowlists', headers: H(admin), payload });

  // set a DB entry → union has both
  let res = await put({ allowlist: ['https://dbhost.example.com'] });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(body(res).effective.entries.public.length, 2, 'env + db union');

  // [] clears the DB zone → env-only (still available via env)
  res = await put({ allowlist: [] });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(body(res).available, true);
  assert.deepEqual(body(res).effective.entries.public, [{ scheme: 'https', host: 'envhost.example.com', port: 443 }]);
  assert.deepEqual((await db.appSetting.findUnique({ where: { key: NETWORK_SETTING_KEYS.ALLOWLIST } })).valueJson, []);

  // null removes the row entirely
  res = await put({ allowlist: null });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await db.appSetting.findUnique({ where: { key: NETWORK_SETTING_KEYS.ALLOWLIST } }), null);
});

test('g4 write allowlist: emergency stop — [] with empty env → policy UNAVAILABLE (honest echo, not 500)', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());
  delete process.env.QA_ENDPOINT_ALLOWLIST;
  delete process.env.QA_ENDPOINT_ALLOWLIST_INTERNAL;

  const admin = await login(app, 'admin1');
  await app.inject({ method: 'PUT', url: '/api/network-policy/allowlists', headers: H(admin), payload: { allowlist: ['https://qa.example.com'] } });
  const res = await app.inject({ method: 'PUT', url: '/api/network-policy/allowlists', headers: H(admin), payload: { allowlist: [] } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(body(res).available, false, 'cleared allowlist + empty env = fail-closed policy');
  assert.match(body(res).reason, /no allowlist entries/);
  const read = await app.inject({ method: 'GET', url: '/api/network-policy', headers: H(admin) });
  assert.equal(body(read).available, false, 'GET agrees: the gate would deny everything');
});

test('g4 write task-types: complete object → 200 + effective echo; partial / non-boolean → 400', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());
  process.env.QA_ENDPOINT_ALLOWLIST = 'https://qa.example.com';
  t.after(() => { delete process.env.QA_ENDPOINT_ALLOWLIST; });

  const admin = await login(app, 'admin1');
  const put = (payload) => app.inject({ method: 'PUT', url: '/api/network-policy/task-types', headers: H(admin), payload });

  let res = await put({ ai: true, adhoc: false });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(body(res).taskTypes, { ai: true, adhoc: false });
  const row = await db.appSetting.findUnique({ where: { key: NETWORK_SETTING_KEYS.TASK_TYPES } });
  assert.deepEqual(row.valueJson, { ai: true, adhoc: false });
  assert.equal(row.updatedBy, 'u-admin');
  assert.equal(db.__state.auditRows.filter((a) => a.action === 'network_policy.task_types_set').length, 1);

  for (const payload of [{ ai: false }, { ai: 'yes', adhoc: true }, { ai: true, adhoc: true, extra: false }]) {
    res = await put(payload);
    assert.equal(res.statusCode, 400, `payload ${JSON.stringify(payload)} must be 400`);
  }
});

test('g4 read: env + AppSetting union with source counts (an entry living ONLY in AppSetting is honored)', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());
  process.env.QA_ENDPOINT_ALLOWLIST = 'https://envhost.example.com';
  process.env.QA_ENDPOINT_ALLOWLIST_INTERNAL = 'http://api:3000';
  t.after(() => {
    delete process.env.QA_ENDPOINT_ALLOWLIST;
    delete process.env.QA_ENDPOINT_ALLOWLIST_INTERNAL;
  });

  const admin = await login(app, 'admin1');
  await app.inject({ method: 'PUT', url: '/api/network-policy/allowlists', headers: H(admin), payload: { allowlist: ['https://dbhost.example.com'] } });
  const res = await app.inject({ method: 'GET', url: '/api/network-policy', headers: H(admin) });
  assert.equal(res.statusCode, 200, res.body);
  const v = body(res);
  assert.equal(v.available, true);
  const hosts = v.effective.entries.public.map((e) => e.host);
  assert.ok(hosts.includes('envhost.example.com') && hosts.includes('dbhost.example.com'));
  assert.deepEqual(v.effective.entries.internal, [{ scheme: 'http', host: 'api', port: 3000 }]);
  assert.equal(v.effective.sources.envPublic, 1);
  assert.equal(v.effective.sources.dbPublic, 1);
  assert.equal(v.appSettings[NETWORK_SETTING_KEYS.ALLOWLIST].updatedBy, 'u-admin');
});
