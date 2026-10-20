/**
 * R6 (工單 §8.3 error contract) — stable machine-readable codes for
 * startup/health-check failures, one vocabulary (no second system):
 *
 *  - IMAGE_NOT_FOUND: a missing image reference at device create maps to a
 *    dedicated 404 code with a clean message — NOT the generic DOCKER_ERROR
 *    with the misleading "(HTTP code 404) no such container" prefix (R5
 *    handoff #3; live evidence: docs/live-evidence/r5-20261020/
 *    bad-image-negative.txt).
 *  - ADB_UNAVAILABLE: the ADB health check itself failed (engine cannot run)
 *    — refresh returns the machine-readable `adbError` code; diagnostics
 *    reports the zone as `error` (an engine failure is NOT a device
 *    'offline').
 *  - TUNNEL_SETUP_FAILED: a failed in-device tunnel script stage/run is
 *    persisted as the stable NET_ERRORS code (R6 fix: it was referenced but
 *    never defined, so netLastErrorCode was silently dropped).
 *
 * All fakes carry zero real credentials (fixture proxy targets only).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { makeRedroidTestApp, login, seedRedroidTemplates } from '../helpers/redroid-fakes.js';

async function makeApp(opts = {}) {
  const { app, db, dataRoot } = await makeRedroidTestApp(opts);
  const cookies = {
    admin: await login(app, 'admin'),
    operator: await login(app, 'operator'),
  };
  return { app, db, dataRoot, cookies, close: async () => { await app.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); } };
}

// Exact dockerode error shape from the R5 live negative evidence.
const MISSING_IMAGE_ERR = {
  statusCode: 404,
  message: '(HTTP code 404) no such container - No such image: water-army/redroid:99.9.9-doesnotexist',
};

test('error contract: device create with a missing image → 404 IMAGE_NOT_FOUND (R5 handoff #3)', async (t) => {
  const { app, db, dataRoot, cookies, close } = await makeApp({ redroidMockOpts: { createError: MISSING_IMAGE_ERR } });
  t.after(close);

  // A pinned-format image that does not exist (R5 used the same shape).
  const tpl = await app.inject({
    method: 'POST', url: '/api/redroid/templates', headers: { cookie: cookies.admin },
    payload: { name: 'redroid-missing-img', image: 'water-army/redroid:99.9.9-doesnotexist', androidVersion: '15' },
  });
  assert.equal(tpl.statusCode, 201, tpl.body);

  const res = await app.inject({
    method: 'POST', url: '/api/devices/redroid', headers: { cookie: cookies.operator },
    payload: { name: 'redroid-imgfail', templateName: 'redroid-missing-img', idempotencyKey: 'key-imgfail-1' },
  });
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(res.json().error.code, 'IMAGE_NOT_FOUND');
  assert.match(res.json().error.message, /^Image not found: water-army\/redroid:99\.9\.9-doesnotexist$/);
  assert.ok(!/no such container/i.test(res.json().error.message), 'misleading container prefix must not leak to the client');
  assert.ok(res.json().error.requestId, 'standard error envelope (requestId)');

  // Rollback honesty: no phantom device row, no leaked data dir.
  assert.equal(await db.device.findUnique({ where: { name: 'redroid-imgfail' } }), null);
  const leftover = fs.existsSync(dataRoot) ? fs.readdirSync(dataRoot) : [];
  assert.deepEqual(leftover, [], `data root must be clean after a failed create, got: ${leftover}`);
});

test('error contract: refresh with an unrunnable adb engine → adbError ADB_UNAVAILABLE (never a false state)', async (t) => {
  const { app, cookies, close } = await makeApp({ redroidMockOpts: { spawnError: 'spawn /usr/bin/adb ENOENT' } });
  t.after(close);

  await seedRedroidTemplates(app, cookies.admin);
  const created = await app.inject({
    method: 'POST', url: '/api/devices/redroid', headers: { cookie: cookies.operator },
    payload: { name: 'redroid-adbrun', templateName: 'redroid-14-swiftshader', idempotencyKey: 'key-adbrun-1' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().device.id;

  const res = await app.inject({ method: 'POST', url: `/api/devices/redroid/${id}/refresh`, headers: { cookie: cookies.operator } });
  assert.equal(res.statusCode, 200, res.body);
  // Machine-readable code + honest state: the CHECK failed, not the device.
  assert.equal(res.json().adbError, 'ADB_UNAVAILABLE');
  assert.match(res.json().adbNote, /adb unavailable on this host/);
  assert.equal(res.json().device.adbState, 'unknown', 'an unrunnable check must never imply online/offline');
});

test('error contract: diagnostics adb zone with an unrunnable engine → status error + ADB_UNAVAILABLE (NOT a false offline)', async (t) => {
  const { app, cookies, close } = await makeApp({ redroidMockOpts: { spawnError: 'spawn /usr/bin/adb ENOENT' } });
  t.after(close);

  await seedRedroidTemplates(app, cookies.admin);
  const created = await app.inject({
    method: 'POST', url: '/api/devices/redroid', headers: { cookie: cookies.operator },
    payload: { name: 'redroid-adbdiag', templateName: 'redroid-14-swiftshader', idempotencyKey: 'key-adbdiag-1' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().device.id;

  const res = await app.inject({ method: 'POST', url: `/api/devices/redroid/${id}/diagnostics`, headers: { cookie: cookies.operator } });
  assert.equal(res.statusCode, 200, res.body);
  const zone = res.json().diagnostics.adbConnectivity;
  assert.equal(zone.executed, true);
  assert.equal(zone.status, 'error', 'engine failure is an ERROR, not a device-side offline');
  assert.equal(zone.error, 'ADB_UNAVAILABLE');
  assert.match(zone.note, /adb unavailable/i);
});

test('error contract: delete with removeData + permission failure → 200 + dataRemoved:false + DATA_DIR_PERM_DENIED (R5 handoff #5: surface, never silent)', async (t) => {
  const { app, db, cookies, close } = await makeApp();
  t.after(close);

  await seedRedroidTemplates(app, cookies.admin);
  const created = await app.inject({
    method: 'POST', url: '/api/devices/redroid', headers: { cookie: cookies.operator },
    payload: { name: 'redroid-rmdel', templateName: 'redroid-14-swiftshader', idempotencyKey: 'key-rmdel-1' },
  });
  assert.equal(created.statusCode, 201, created.body);

  // R5 live shape: the privileged container leaves ROOT-OWNED files in the
  // data dir; the API uid cannot remove them → EACCES.
  app.redroidMockEnv.setRemoveDataDirFailure(
    Object.assign(new Error('EACCES: permission denied, rmdir (root-owned data dir)'), { code: 'EACCES' }),
  );

  const res = await app.inject({
    method: 'DELETE', url: '/api/devices/redroid/redroid-rmdel', headers: { cookie: cookies.admin },
    payload: { confirm: 'redroid-rmdel', removeData: true },
  });
  // The delete itself SUCCEEDED (container gone, row gone) — the data
  // cleanup failure is PARTIAL: 200 + explicit machine-readable fields,
  // never a silent success and never a fake error on the delete itself.
  assert.equal(res.statusCode, 200, res.body);
  const j = res.json();
  assert.equal(j.deleted, true);
  assert.equal(j.containerRemoved, true);
  assert.equal(j.removeData, true);
  assert.equal(j.dataRemoved, false);
  assert.equal(j.dataRemoveErrorCode, 'DATA_DIR_PERM_DENIED', 'stable machine code for the known root-owned-dir shape');
  assert.match(j.dataRemoveError, /EACCES/);
  assert.equal(await db.device.findUnique({ where: { name: 'redroid-rmdel' } }), null);
});

test('error contract: tunnel stage failure persists TUNNEL_SETUP_FAILED (was undefined → silently dropped)', async (t) => {
  const { app, db, cookies, close } = await makeApp();
  t.after(close);

  // Template with a (fixture) proxy → the in-device tunnel is provisioned in
  // the background on create. The binary check passes; the script STAGE fails.
  const tpl = await app.inject({
    method: 'POST', url: '/api/redroid/templates', headers: { cookie: cookies.admin },
    payload: {
      name: 'redroid-tsf-tpl', image: 'redroid/redroid:14.0.0', androidVersion: '14',
      proxyUrl: 'socks5://fixture-user:fixture-pass@proxy.example:1080',
    },
  });
  assert.equal(tpl.statusCode, 201, tpl.body);
  app.redroidMockEnv.exec.set({ stageFail: true });

  const created = await app.inject({
    method: 'POST', url: '/api/devices/redroid', headers: { cookie: cookies.operator },
    payload: { name: 'redroid-tsf', templateName: 'redroid-tsf-tpl', idempotencyKey: 'key-tsf-1' },
  });
  assert.equal(created.statusCode, 201, created.body); // create is non-blocking; the failure lands in the net state

  // Poll the persisted state (background provision, deterministic mock).
  let row = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    row = await db.device.findUnique({ where: { name: 'redroid-tsf' } });
    if (row?.netState === 'FAILED') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(row?.netState, 'FAILED', `expected FAILED net state, got ${row?.netState}`);
  assert.equal(row?.netLastErrorCode, 'TUNNEL_SETUP_FAILED', 'the stable code must be persisted (it was undefined before R6)');
  assert.match(row?.netLastErrorDetail ?? '', /stage exit=1/);

  // The API view exposes the same machine-readable code (proxy.network).
  const view = await app.inject({ method: 'GET', url: '/api/devices/redroid/redroid-tsf', headers: { cookie: cookies.operator } });
  assert.equal(view.statusCode, 200, view.body);
  assert.equal(view.json().device.proxy.network.state, 'FAILED');
  assert.equal(view.json().device.proxy.network.lastErrorCode, 'TUNNEL_SETUP_FAILED');
});
