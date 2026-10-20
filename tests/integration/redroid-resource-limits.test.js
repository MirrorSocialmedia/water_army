/**
 * R5 — Redroid per-template resource limits (MD §7.2.7).
 *
 * Product gap fixed here: the docker create path had a dead
 * template.cpuLimit/memoryLimitBytes branch (docker-service generic builder
 * only) while the RedroidTemplate model had no such columns — redroid
 * devices could NEVER be limited. Now: nullable columns (NULL = unlimited,
 * the honest default), validated ranges, HostConfig.NanoCpus/Memory at
 * container create, and the 127.0.0.1 ADB bind rule still holds alongside.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { makeRedroidTestApp, login } from '../helpers/redroid-fakes.js';

const LIMITS_TPL = {
  name: 'redroid-14-limits',
  image: 'water-army/redroid:14.0.0-240527-matrixa-r3',
  androidVersion: '14',
  gpuMode: 'swiftshader_indirect',
  privileged: false,
  cpuLimit: 2,
  memoryLimitBytes: 4294967296, // 4 GiB
};

async function makeApp() {
  const { app, dataRoot, redroidMock } = await makeRedroidTestApp();
  const cookies = { admin: await login(app, 'admin') };
  return { app, redroidMock, cookies, close: async () => { await app.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); } };
}

test('redroid limits: template create echoes limits; device create maps them into HostConfig', async (t) => {
  const { app, redroidMock, cookies, close } = await makeApp();
  t.after(close);
  const H = { cookie: cookies.admin, 'content-type': 'application/json' };

  const created = await app.inject({ method: 'POST', url: '/api/redroid/templates', headers: H, payload: LIMITS_TPL });
  assert.equal(created.statusCode, 201, created.body);
  const tpl = created.json().template;
  assert.equal(tpl.cpuLimit, 2);
  assert.equal(tpl.memoryLimitBytes, 4294967296);

  const dev = await app.inject({
    method: 'POST',
    url: '/api/devices/redroid',
    headers: H,
    payload: { name: 'redroid-matrix-r5-limits', templateName: 'redroid-14-limits', idempotencyKey: 'r5-limits-0001' },
  });
  assert.equal(dev.statusCode, 201, dev.body);

  const createCalls = (redroidMock.docker.client.__calls ?? []).filter((c) => c.method === 'createContainer');
  assert.ok(createCalls.length >= 1, 'fake docker must have recorded the create');
  const body = createCalls[createCalls.length - 1].cfg._body;
  // R5: limits mapped to the exact Docker HostConfig fields
  assert.equal(body.HostConfig.NanoCpus, 2_000_000_000, 'cpuLimit 2 → NanoCpus 2e9');
  assert.equal(body.HostConfig.Memory, 4294967296, 'memoryLimitBytes → Memory bytes');
  // regression: the ADB bind rule coexists with the limits
  const bind = body.HostConfig.PortBindings['5555/tcp'][0];
  assert.equal(bind.HostIP, '127.0.0.1');
});

test('redroid limits: omitted = unlimited (no NanoCpus/Memory in the body)', async (t) => {
  const { app, redroidMock, cookies, close } = await makeApp();
  t.after(close);
  const H = { cookie: cookies.admin, 'content-type': 'application/json' };
  const { cpuLimit, memoryLimitBytes, ...noLimits } = LIMITS_TPL;
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/redroid/templates', headers: H, payload: noLimits })).statusCode,
    201,
  );
  const dev = await app.inject({
    method: 'POST',
    url: '/api/devices/redroid',
    headers: H,
    payload: { name: 'redroid-matrix-r5-nolimits', templateName: 'redroid-14-limits', idempotencyKey: 'r5-nolimits-0001' },
  });
  assert.equal(dev.statusCode, 201, dev.body);
  const createCalls = (redroidMock.docker.client.__calls ?? []).filter((c) => c.method === 'createContainer');
  const body = createCalls[createCalls.length - 1].cfg._body;
  assert.equal(body.HostConfig.NanoCpus, undefined, 'no cpuLimit → no NanoCpus (unlimited, honest default)');
  assert.equal(body.HostConfig.Memory, undefined, 'no memoryLimitBytes → no Memory (unlimited, honest default)');
});

test('redroid limits: validation rejects out-of-range values (both fields)', async (t) => {
  const { app, cookies, close } = await makeApp();
  t.after(close);
  const H = { cookie: cookies.admin, 'content-type': 'application/json' };
  const cases = [
    { ...LIMITS_TPL, name: 'redroid-14-bad1', cpuLimit: 0 },
    { ...LIMITS_TPL, name: 'redroid-14-bad2', cpuLimit: 257 },
    { ...LIMITS_TPL, name: 'redroid-14-bad3', cpuLimit: '2' },
    { ...LIMITS_TPL, name: 'redroid-14-bad4', memoryLimitBytes: 1024 },
    { ...LIMITS_TPL, name: 'redroid-14-bad5', memoryLimitBytes: 274877906945 },
    { ...LIMITS_TPL, name: 'redroid-14-bad6', memoryLimitBytes: 4.5 },
  ];
  for (const body of cases) {
    const res = await app.inject({ method: 'POST', url: '/api/redroid/templates', headers: H, payload: body });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(body.cpuLimit ?? body.memoryLimitBytes)}: ${res.body}`);
    assert.equal(res.json().error.code, 'VALIDATION_ERROR');
  }
});

test('redroid limits: explicit null clears a previously-set limit (update)', async (t) => {
  const { app, cookies, close } = await makeApp();
  t.after(close);
  const H = { cookie: cookies.admin, 'content-type': 'application/json' };
  // host + privileged template: the R5 data-corruption regression (AJV schema
  // defaults clobbering absent fields on a partial PUT) would flip these back
  // to swiftshader_indirect/false — this asserts they survive a partial patch.
  const HOST_PRIV = {
    ...LIMITS_TPL,
    name: 'redroid-14-hostpriv',
    gpuMode: 'host',
    privileged: true,
    privilegedReason: 'test: privileged host template',
  };
  const created = await app.inject({ method: 'POST', url: '/api/redroid/templates', headers: H, payload: HOST_PRIV });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().template.id;

  // partial update without the fields → keep (gpuMode/privileged included!)
  const keep = await app.inject({ method: 'PUT', url: `/api/redroid/templates/${id}`, headers: H, payload: { fps: 60 } });
  assert.equal(keep.statusCode, 200, keep.body);
  assert.equal(keep.json().template.cpuLimit, 2);
  assert.equal(keep.json().template.memoryLimitBytes, 4294967296);
  assert.equal(keep.json().template.gpuMode, 'host', 'partial PUT must NOT reset gpuMode (schema-default clobber)');
  assert.equal(keep.json().template.privileged, true, 'partial PUT must NOT reset privileged (schema-default clobber)');

  // explicit null → clear
  const clear = await app.inject({
    method: 'PUT',
    url: `/api/redroid/templates/${id}`,
    headers: H,
    payload: { cpuLimit: null, memoryLimitBytes: null },
  });
  assert.equal(clear.statusCode, 200, clear.body);
  assert.equal(clear.json().template.cpuLimit, null);
  assert.equal(clear.json().template.memoryLimitBytes, null);
  // still intact after the null-clear patch
  assert.equal(clear.json().template.gpuMode, 'host');
  assert.equal(clear.json().template.privileged, true);
});
