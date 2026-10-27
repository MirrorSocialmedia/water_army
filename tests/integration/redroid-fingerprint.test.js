/**
 * W1 (ADR-025) integration — identity fingerprint injection through the mock
 * adapter + fingerprint routes.
 *
 * Hard assertions:
 *  1. Switch OFF (default): identityId is accepted and INERT — container Cmd
 *     byte-identical to the no-W1 shape (5 base args), device row unbound.
 *  2. Switch ON: create with identityId → the recorded docker createContainer
 *     body carries the deterministic profile's androidboot.oem_* args (Cmd
 *     carrier, never Env), device row snapshots identityId + merged map.
 *  3. Fail-closed: unknown identity → 404 BEFORE any side effect (no device
 *     row, no container create); template invalid roOverrides → 400 at write.
 *  4. Template roOverrides: merged UNDER the identity profile when ON; inert
 *     when OFF.
 *  5. Routes: ensure is idempotent (regeneration replays the same profile);
 *     collision audit endpoint reports a clean fleet as non-blocking.
 *
 * Real-device consumption of these args = V3 (NOT VERIFIED — ADR-025).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { makeRedroidTestApp, login, seedRedroidTemplates } from '../helpers/redroid-fakes.js';
import { generateFingerprintProfile, profileToRoOverrides, propToAndroidbootKey } from '../../packages/shared/src/fingerprint-profile.js';

async function makeApp(opts = {}) {
  const { app, db, dataRoot, redroidMock } = await makeRedroidTestApp(opts);
  const cookies = {
    admin: await login(app, 'admin'),
    operator: await login(app, 'operator'),
    viewer: await login(app, 'viewer'),
  };
  await seedRedroidTemplates(app, cookies.admin);
  return {
    app, db, dataRoot, redroidMock, cookies,
    close: async () => {
      await app.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

/** Last recorded createContainer body from the mock adapter. */
function lastCreateBody(redroidMock) {
  const calls = redroidMock.docker.client.__calls.filter((c) => c.method === 'createContainer');
  return calls.at(-1)?.cfg._body ?? null;
}

const ON = { configOverride: { redroidRoOverridesEnabled: true } };

test('switch OFF (default): identityId accepted but INERT — Cmd byte-identical, row unbound', async (t) => {
  const { app, db, cookies, redroidMock, close } = await makeApp(); // no configOverride = OFF
  t.after(close);
  const ident = await db.identity.create({ data: { id: randomUUID(), displayName: 'w1-off' } });

  const res = await app.inject({
    method: 'POST', url: '/api/devices/redroid',
    headers: { cookie: cookies.operator },
    payload: { name: 'redroid-w1-off', templateName: 'redroid-14-swiftshader', idempotencyKey: 'w1-off-0001', identityId: ident.id },
  });
  assert.equal(res.statusCode, 201, res.body);
  const { device } = res.json();
  assert.equal(device.identityId, null, 'switch OFF must not bind the identity');
  assert.deepEqual(device.roOverrides, {}, 'switch OFF must snapshot an empty map');
  const cmd = lastCreateBody(redroidMock)?.Cmd ?? [];
  assert.equal(cmd.length, 5, `switch OFF Cmd must stay at the 5 base args, got: ${JSON.stringify(cmd)}`);
  assert.ok(!cmd.some((a) => a.startsWith('androidboot.oem_')), 'no oem_* carrier args may appear with the switch off');

  // no fingerprint row was generated either (zero profile lookup by design)
  assert.equal(await db.identityFingerprint.findUnique({ where: { identityId: ident.id } }), null);
});

test('switch ON: identityId → deterministic profile lands in Cmd (androidboot.oem_* args, never Env) + row snapshot', async (t) => {
  const { app, db, cookies, redroidMock, close } = await makeApp(ON);
  t.after(close);
  const ident = await db.identity.create({ data: { id: randomUUID(), displayName: 'w1-on' } });
  const expected = generateFingerprintProfile(ident.id);

  const res = await app.inject({
    method: 'POST', url: '/api/devices/redroid',
    headers: { cookie: cookies.operator },
    payload: { name: 'redroid-w1-on', templateName: 'redroid-14-swiftshader', idempotencyKey: 'w1-on-00001', identityId: ident.id },
  });
  assert.equal(res.statusCode, 201, res.body);
  const { device } = res.json();
  assert.equal(device.identityId, ident.id);
  // snapshot map = exactly the profile's prop map
  assert.deepEqual(device.roOverrides, profileToRoOverrides(expected));

  const body = lastCreateBody(redroidMock);
  const cmd = body.Cmd;
  // 5 base args + 9 registered props (PROFILE_PROP_MAP), sorted tail
  assert.equal(cmd.length, 5 + Object.keys(profileToRoOverrides(expected)).length, `unexpected Cmd: ${JSON.stringify(cmd)}`);
  assert.deepEqual(cmd.slice(0, 5), [
    'androidboot.redroid_width=720',
    'androidboot.redroid_height=1280',
    'androidboot.redroid_dpi=320',
    'androidboot.redroid_fps=20',
    'androidboot.redroid_gpu_mode=swiftshader_indirect',
  ], 'base args must be untouched (prefix stability)');
  for (const [field, prop] of Object.entries({ fingerprint: 'ro.build.fingerprint', model: 'ro.product.model', serial: 'ro.serialno', brand: 'ro.product.brand' })) {
    assert.ok(cmd.includes(`${propToAndroidbootKey(prop)}=${expected[field]}`), `Cmd must carry ${prop}=${expected[field]}`);
  }
  assert.deepEqual(body.Env, [], 'overrides ride the Cmd carrier — Env stays empty (MD §2.1)');

  // fingerprint row materialised (ensure ran inside create)
  const row = await db.identityFingerprint.findUnique({ where: { identityId: ident.id } });
  assert.ok(row, 'create must materialise the deterministic profile row');
  assert.equal(row.fingerprint, expected.fingerprint);
});

test('switch ON: recreate for the SAME identity replays the identical profile (3× rebuild stability, code level)', async (t) => {
  const { app, db, cookies, redroidMock, close } = await makeApp(ON);
  t.after(close);
  const ident = await db.identity.create({ data: { id: randomUUID(), displayName: 'w1-stable' } });
  const cmds = [];
  for (const n of ['a', 'b', 'c']) {
    const res = await app.inject({
      method: 'POST', url: '/api/devices/redroid',
      headers: { cookie: cookies.operator },
      payload: { name: `redroid-w1-st-${n}`, templateName: 'redroid-14-swiftshader', idempotencyKey: `w1-st-${n}-0001`, identityId: ident.id },
    });
    assert.equal(res.statusCode, 201, res.body);
    cmds.push(lastCreateBody(redroidMock).Cmd.filter((a) => a.startsWith('androidboot.oem_')));
    assert.ok(cmds.at(-1).length > 0, 'switch ON recreate must emit oem_* carrier args (non-vacuous)');
  }
  assert.deepEqual(cmds[1], cmds[0], 'recreate 2 must match recreate 1');
  assert.deepEqual(cmds[2], cmds[0], 'recreate 3 must match recreate 1');
});

test('switch ON fail-closed: unknown identityId → 404 with NO side effects (no row, no container)', async (t) => {
  const { app, cookies, redroidMock, close } = await makeApp(ON);
  t.after(close);
  const ghost = randomUUID();
  const before = redroidMock.docker.client.__calls.filter((c) => c.method === 'createContainer').length;
  const res = await app.inject({
    method: 'POST', url: '/api/devices/redroid',
    headers: { cookie: cookies.operator },
    payload: { name: 'redroid-w1-ghost', templateName: 'redroid-14-swiftshader', idempotencyKey: 'w1-ghost-001', identityId: ghost },
  });
  assert.equal(res.statusCode, 404, res.body);
  const list = await app.inject({ method: 'GET', url: '/api/devices/redroid', headers: { cookie: cookies.viewer } });
  assert.ok(!list.json().devices.some((d) => d.name === 'redroid-w1-ghost'), 'rejected create must leave no device row');
  const after = redroidMock.docker.client.__calls.filter((c) => c.method === 'createContainer').length;
  assert.equal(after, before, 'rejected create must not touch the docker engine');
});

test('template roOverrides: write-validated (400 on junk), merged under identity profile when ON, inert when OFF', async (t) => {
  // 400 at template write (schema propertyNames + service validator)
  const off = await makeApp();
  t.after(off.close);
  const bad = await off.app.inject({
    method: 'POST', url: '/api/redroid/templates',
    headers: { cookie: off.cookies.admin },
    payload: { name: 'tpl-w1-bad', image: 'redroid/redroid:15.0.0', androidVersion: '15', roOverrides: { 'data.bogus': 'x' } },
  });
  assert.equal(bad.statusCode, 400, bad.body);
  const bad2 = await off.app.inject({
    method: 'POST', url: '/api/redroid/templates',
    headers: { cookie: off.cookies.admin },
    payload: { name: 'tpl-w1-bad2', image: 'redroid/redroid:15.0.0', androidVersion: '15', roOverrides: { 'ro.bad': 'has space' } },
  });
  assert.equal(bad2.statusCode, 400, bad2.body);

  // valid baseline stored + echoed
  const okTpl = await off.app.inject({
    method: 'POST', url: '/api/redroid/templates',
    headers: { cookie: off.cookies.admin },
    payload: { name: 'tpl-w1-base', image: 'redroid/redroid:15.0.0', androidVersion: '15', roOverrides: { 'ro.product.brand': 'BaseBrand', 'ro.product.model': 'BaseModel' } },
  });
  assert.equal(okTpl.statusCode, 201, okTpl.body);
  assert.deepEqual(okTpl.json().template.roOverrides, { 'ro.product.brand': 'BaseBrand', 'ro.product.model': 'BaseModel' });

  // OFF → baseline stays inert
  const resOff = await off.app.inject({
    method: 'POST', url: '/api/devices/redroid',
    headers: { cookie: off.cookies.operator },
    payload: { name: 'redroid-w1-baseoff', templateName: 'tpl-w1-base', idempotencyKey: 'w1-baseoff-1' },
  });
  assert.equal(resOff.statusCode, 201, resOff.body);
  assert.equal(lastCreateBody(off.redroidMock).Cmd.length, 5, 'OFF must keep the 5-arg baseline even with template roOverrides');

  // ON (fresh app carrying the same template shape) → baseline applied, profile wins on overlap
  const on = await makeApp(ON);
  t.after(on.close);
  await on.app.inject({
    method: 'POST', url: '/api/redroid/templates',
    headers: { cookie: on.cookies.admin },
    payload: { name: 'tpl-w1-base', image: 'redroid/redroid:15.0.0', androidVersion: '15', roOverrides: { 'ro.product.brand': 'BaseBrand', 'persist.w1.marker': 'on' } },
  });
  const ident = await on.db.identity.create({ data: { id: randomUUID(), displayName: 'w1-merge' } });
  const expected = generateFingerprintProfile(ident.id);
  const resOn = await on.app.inject({
    method: 'POST', url: '/api/devices/redroid',
    headers: { cookie: on.cookies.operator },
    payload: { name: 'redroid-w1-merge', templateName: 'tpl-w1-base', idempotencyKey: 'w1-merge-001', identityId: ident.id },
  });
  assert.equal(resOn.statusCode, 201, resOn.body);
  const snap = resOn.json().device.roOverrides;
  assert.equal(snap['persist.w1.marker'], 'on', 'template-only props survive the merge');
  assert.equal(snap['ro.product.brand'], expected.brand, 'identity profile must WIN over the template baseline');
  const cmd = lastCreateBody(on.redroidMock).Cmd;
  assert.ok(cmd.includes('androidboot.oem_persist_w1_marker=on'), 'merged map must reach the Cmd');
});

test('fingerprint routes: ensure idempotent (same profile on repeat), RBAC, fleet collision audit clean', async (t) => {
  const { app, db, cookies, close } = await makeApp(ON);
  t.after(close);
  const ident = await db.identity.create({ data: { id: randomUUID(), displayName: 'w1-routes' } });
  const expected = generateFingerprintProfile(ident.id);

  // viewer cannot generate
  const denied = await app.inject({ method: 'POST', url: `/api/identities/${ident.id}/fingerprint`, headers: { cookie: cookies.viewer } });
  assert.equal(denied.statusCode, 403);

  // GET before ensure → null
  const empty = await app.inject({ method: 'GET', url: `/api/identities/${ident.id}/fingerprint`, headers: { cookie: cookies.viewer } });
  assert.equal(empty.statusCode, 200, empty.body);
  assert.equal(empty.json().profile, null);

  // admin ensure ×2 → deep-equal profile (idempotent regeneration)
  const first = await app.inject({ method: 'POST', url: `/api/identities/${ident.id}/fingerprint`, headers: { cookie: cookies.admin } });
  assert.equal(first.statusCode, 200, first.body);
  const second = await app.inject({ method: 'POST', url: `/api/identities/${ident.id}/fingerprint`, headers: { cookie: cookies.admin } });
  assert.equal(second.statusCode, 200, second.body);
  assert.deepEqual(second.json().profile, first.json().profile);
  assert.equal(first.json().profile.profile.fingerprint, expected.fingerprint);

  // unknown identity → 404
  const ghost = await app.inject({ method: 'POST', url: `/api/identities/${randomUUID()}/fingerprint`, headers: { cookie: cookies.admin } });
  assert.equal(ghost.statusCode, 404);

  // collision audit: two ensured identities → non-blocking
  const ident2 = await db.identity.create({ data: { id: randomUUID(), displayName: 'w1-routes2' } });
  await app.inject({ method: 'POST', url: `/api/identities/${ident2.id}/fingerprint`, headers: { cookie: cookies.admin } });
  const audit = await app.inject({ method: 'GET', url: '/api/identities/fingerprints/collisions', headers: { cookie: cookies.admin } });
  assert.equal(audit.statusCode, 200, audit.body);
  assert.equal(audit.json().blocking, false);
  assert.equal(audit.json().uniqueFieldCollisions.length, 0);

  // viewer may read own profile
  const read = await app.inject({ method: 'GET', url: `/api/identities/${ident.id}/fingerprint`, headers: { cookie: cookies.viewer } });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().profile.identityId, ident.id);
});
