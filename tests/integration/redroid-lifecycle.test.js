/**
 * P5 commit 3 — Redroid device lifecycle integration tests (mock adapter).
 *
 * 工單 硬驗收 2/3/4 (partial): full mock lifecycle create → start → stop →
 * restart → delete with state transitions; adbPort unique allocation with a
 * REAL 127.0.0.1 port-occupied collision case; data dir volume evidence;
 * 127.0.0.1-only bind asserted on the recorded docker create call;
 * zero-arbitrary-shell (no /exec endpoint exists; extra Docker fields 400);
 * GPU honesty (host → 未驗證/unverified, swiftshader → software).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';

import { makeRedroidTestApp, login, seedRedroidTemplates, SEED_TEMPLATES } from '../helpers/redroid-fakes.js';

async function makeApp(opts = {}) {
  const { app, db, dataRoot, redroidMock } = await makeRedroidTestApp(opts);
  const cookies = {
    admin: await login(app, 'admin'),
    operator: await login(app, 'operator'),
    viewer: await login(app, 'viewer'),
  };
  await seedRedroidTemplates(app, cookies.admin);
  return { app, db, dataRoot, redroidMock, cookies, close: async () => { await app.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); } };
}

test('redroid API: unauthenticated → 401 on all guarded routes', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);

  const ROUTES = [
    ['GET', '/api/redroid/preflight', null],
    ['GET', '/api/redroid/templates', null],
    ['POST', '/api/redroid/templates', SEED_TEMPLATES[1]],
    ['PUT', '/api/redroid/templates/some-uuid-0000000000', { isEnabled: false }],
    ['DELETE', '/api/redroid/templates/some-uuid-0000000000', null],
    ['GET', '/api/devices/redroid', null],
    ['POST', '/api/devices/redroid', { name: 'redroid-x', templateName: 'redroid-14-swiftshader', idempotencyKey: 'key-00000001' }],
    ['GET', '/api/devices/redroid/redroid-x', null],
    ['POST', '/api/devices/redroid/redroid-x/start', null],
    ['POST', '/api/devices/redroid/redroid-x/stop', null],
    ['POST', '/api/devices/redroid/redroid-x/restart', null],
    ['POST', '/api/devices/redroid/redroid-x/refresh', null],
    ['DELETE', '/api/devices/redroid/redroid-x', { confirm: 'redroid-x' }],
  ];
  for (const [method, url, body] of ROUTES) {
    const res = await app.inject({ method, url, payload: body });
    assert.equal(res.statusCode, 401, `${method} ${url} should be 401, got ${res.statusCode}: ${res.body}`);
    assert.equal(res.json().error.code, 'UNAUTHORIZED');
  }
});

test('redroid API: RBAC — viewer read-only, operator lifecycle, admin-only deletes/templates', async (t) => {
  const { app, cookies, close } = await makeApp();
  t.after(close);

  await t.test('viewer can list templates and devices', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/redroid/templates', headers: { cookie: cookies.viewer } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/devices/redroid', headers: { cookie: cookies.viewer } })).statusCode, 200);
  });

  await t.test('viewer cannot create template / create device / run actions', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/api/redroid/templates', headers: { cookie: cookies.viewer }, payload: SEED_TEMPLATES[1] });
    assert.equal(r1.statusCode, 403);
    const r2 = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: { cookie: cookies.viewer }, payload: { name: 'redroid-v1', templateName: 'redroid-14-swiftshader', idempotencyKey: 'key-v-00001' } });
    assert.equal(r2.statusCode, 403);
    const r3 = await app.inject({ method: 'POST', url: '/api/devices/redroid/redroid-v1/stop', headers: { cookie: cookies.viewer } });
    assert.equal(r3.statusCode, 403);
  });

  await t.test('operator cannot delete device or write templates', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: { cookie: cookies.operator }, payload: { name: 'redroid-op1', templateName: 'redroid-14-swiftshader', idempotencyKey: 'key-op-0001' } });
    assert.equal(created.statusCode, 201, created.body);
    const r1 = await app.inject({ method: 'DELETE', url: '/api/devices/redroid/redroid-op1', headers: { cookie: cookies.operator }, payload: { confirm: 'redroid-op1' } });
    assert.equal(r1.statusCode, 403);
    // RBAC gate fires BEFORE any lookup — even a name-shaped id gets 403
    const r2 = await app.inject({ method: 'PUT', url: '/api/redroid/templates/redroid-14-swiftshader', headers: { cookie: cookies.operator }, payload: { isEnabled: false } });
    assert.equal(r2.statusCode, 403);
    const tplList = await app.inject({ method: 'GET', url: '/api/redroid/templates', headers: { cookie: cookies.operator } });
    const tpl = tplList.json().templates.find((x) => x.name === 'redroid-14-swiftshader');
    const r3 = await app.inject({ method: 'PUT', url: `/api/redroid/templates/${tpl.id}`, headers: { cookie: cookies.operator }, payload: { isEnabled: false } });
    assert.equal(r3.statusCode, 403);
  });
});

test('template image pinning: latest / nightly / untagged / bad shape all rejected', async (t) => {
  const { app, cookies, close } = await makeApp();
  t.after(close);
  const cases = [
    ['redroid/redroid:latest', 400],
    ['redroid/redroid:15.0.0-nightly', 400],
    ['redroid/redroid', 400], // untagged = implicit latest
    ['redroid/redroid:LATEST', 400],
    ['not an image', 400],
    ['redroid/redroid:15.0.0', 201],
    ['redroid/redroid:14.0.0@sha256:' + 'a'.repeat(64), 201], // digest-pinned is allowed
  ];
  for (const [image, status] of cases) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/redroid/templates',
      headers: { cookie: cookies.admin },
      payload: { name: `tpl-img-${Math.random().toString(36).slice(2, 10)}`, image, androidVersion: '15' },
    });
    assert.equal(res.statusCode, status, `image ${image}: expected ${status}, got ${res.statusCode}: ${res.body}`);
  }
});

test('privileged template requires a reason label (MD §9.2)', async (t) => {
  const { app, cookies, close } = await makeApp();
  t.after(close);
  const noReason = await app.inject({
    method: 'POST',
    url: '/api/redroid/templates',
    headers: { cookie: cookies.admin },
    payload: { name: 'tpl-noreason', image: 'redroid/redroid:15.0.0', androidVersion: '15', privileged: true },
  });
  assert.equal(noReason.statusCode, 400);
  assert.match(noReason.json().error.message, /privilegedReason/);
  const withReason = await app.inject({
    method: 'POST',
    url: '/api/redroid/templates',
    headers: { cookie: cookies.admin },
    payload: { name: 'tpl-reasoned', image: 'redroid/redroid:15.0.0', androidVersion: '15', privileged: true, privilegedReason: 'dedicated redroid host-gpu template' },
  });
  assert.equal(withReason.statusCode, 201, withReason.body);
  assert.equal(withReason.json().template.privileged, true);
});

test('device create: template-only inputs, 127.0.0.1 bind, androidboot.* as START ARGS, data dir, GPU honesty', async (t) => {
  const { app, cookies, dataRoot, close, redroidMock } = await makeApp();
  t.after(close);
  const H = { cookie: cookies.operator };

  const create = await app.inject({
    method: 'POST',
    url: '/api/devices/redroid',
    headers: H,
    payload: { name: 'redroid-lab1', templateName: 'redroid-15-gpu-privileged', idempotencyKey: 'key-lab1-001' },
  });
  assert.equal(create.statusCode, 201, create.body);
  const { device, preflight } = create.json();
  assert.equal(device.name, 'redroid-lab1');
  assert.ok(device.adbPort >= 15000 && device.adbPort <= 15999, `adbPort ${device.adbPort} outside range`);
  assert.equal(device.adbBind, '127.0.0.1');
  assert.equal(device.containerState, 'running');
  assert.equal(device.gpuMode, 'host');
  // MD §2.4 — DeviceRequests 存在 ≠ 正常: host mode starts UNVERIFIED.
  assert.equal(device.gpuStatus, 'unverified', 'host GPU device must start as 未驗證 (unverified)');
  assert.equal(device.templateName, 'redroid-15-gpu-privileged');
  // explicit preflight warning in the create response (MD §2.3)
  assert.equal(preflight.overall, 'supported');
  assert.equal(preflight.mock, true, 'mock preflight must be labelled mock');

  // data dir exists on the host (per-device persistence, MD §10.2)
  const dataDir = `${dataRoot}/redroid-lab1`;
  assert.ok(fs.statSync(dataDir).isDirectory(), 'data dir must be created');

  // docker create call recorded by the mock adapter: assert the HARD shapes
  const client = redroidMock.docker.client;
  const createCall = client.__calls.find((c) => c.method === 'createContainer');
  assert.ok(createCall, 'mock must have recorded createContainer');
  const body = createCall.cfg._body;
  // 127.0.0.1 ONLY (工單 硬驗收 3 — code-level evidence on the real create path)
  const binds = body.HostConfig.PortBindings['5555/tcp'];
  assert.equal(binds.length, 1);
  assert.equal(binds[0].HostIP, '127.0.0.1', 'ADB must bind 127.0.0.1 only');
  assert.equal(binds[0].HostPort, String(device.adbPort));
  // androidboot.* as START ARGS, never Env (MD §2.1)
  assert.ok(Array.isArray(body.Cmd) && body.Cmd.length === 5);
  assert.match(body.Cmd[0], /^androidboot\.redroid_width=1080$/);
  assert.match(body.Cmd[1], /^androidboot\.redroid_height=1920$/);
  assert.match(body.Cmd[2], /^androidboot\.redroid_dpi=440$/);
  assert.match(body.Cmd[3], /^androidboot\.redroid_fps=30$/);
  assert.match(body.Cmd[4], /^androidboot\.redroid_gpu_mode=host$/);
  assert.deepEqual(body.Env, [], 'Env must be empty — android settings are start args (MD §2.1)');
  // privileged comes ONLY from the template
  assert.equal(body.HostConfig.Privileged, true);
  // GPU DeviceRequest present (configuration) — and still unverified (honesty)
  assert.equal(body.HostConfig.DeviceRequests[0].Driver, 'nvidia');
  // /data bind mount to the dedicated data dir
  const mount = body.HostConfig.Mounts.find((m) => m.Target === '/data');
  assert.ok(mount, '/data mount must exist');
  assert.equal(mount.Source, dataDir);
  assert.equal(mount.Type, 'bind');
  // image pinned from the template
  assert.equal(body.Image, 'redroid/redroid:15.0.0');

  await t.test('swiftshader template → gpuStatus "software" (honest, not verified)', async () => {
    const c2 = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: H, payload: { name: 'redroid-sw1', templateName: 'redroid-14-swiftshader', idempotencyKey: 'key-sw1-0001' } });
    assert.equal(c2.statusCode, 201, c2.body);
    assert.equal(c2.json().device.gpuStatus, 'software');
    const c2call = client.__calls.filter((c) => c.method === 'createContainer').at(-1);
    assert.ok(!c2call.cfg._body.HostConfig.DeviceRequests, 'swiftshader mode must not request GPU devices');
    assert.equal(c2call.cfg._body.HostConfig.Privileged, false);
  });
});

test('device create: client cannot inject Docker fields (0.0.0.0 / privileged / hostConfig all 400)', async (t) => {
  const { app, cookies, close } = await makeApp();
  t.after(close);
  const H = { cookie: cookies.operator };
  const base = { name: 'redroid-evil', templateName: 'redroid-14-swiftshader', idempotencyKey: 'key-evil-001' };

  const attempts = [
    { ...base, adbBind: '0.0.0.0' },
    { ...base, privileged: true },
    { ...base, hostConfig: { PortBindings: { '5555/tcp': [{ HostIP: '0.0.0.0', HostPort: '5555' }] } } },
    { ...base, image: 'evil/whatever:1' },
    { ...base, ports: [{ hostPort: 9999 }] },
    { ...base, bind: '0.0.0.0' },
  ];
  for (const payload of attempts) {
    const res = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: H, payload });
    assert.equal(res.statusCode, 400, `payload ${JSON.stringify(payload)} must be 400, got ${res.statusCode}: ${res.body}`);
    assert.equal(res.json().error.code, 'VALIDATION_ERROR');
  }
  // and the name itself rejects injection shapes
  const badName = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: H, payload: { ...base, name: 'redroid-a;id', idempotencyKey: 'key-evil-002' } });
  assert.equal(badName.statusCode, 400);
});

test('device create: idempotency — same key replays, different name with same key returns original', async (t) => {
  const { app, cookies, close } = await makeApp();
  t.after(close);
  const H = { cookie: cookies.operator };
  const body = { name: 'redroid-idem', templateName: 'redroid-14-swiftshader', idempotencyKey: 'key-idem-01' };
  const r1 = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: H, payload: body });
  assert.equal(r1.statusCode, 201);
  const r2 = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: H, payload: body });
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json().replay, true);
  assert.equal(r2.json().device.id, r1.json().device.id);
  // double-click variant: same key, different name → still the ORIGINAL result
  const r3 = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: H, payload: { ...body, name: 'redroid-idem-other' } });
  assert.equal(r3.statusCode, 200);
  assert.equal(r3.json().device.id, r1.json().device.id);
});

test('device create: name taken → 409 (fresh key)', async (t) => {
  const { app, cookies, close } = await makeApp();
  t.after(close);
  const H = { cookie: cookies.operator };
  const r1 = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: H, payload: { name: 'redroid-dup', templateName: 'redroid-14-swiftshader', idempotencyKey: 'key-dup-0001' } });
  assert.equal(r1.statusCode, 201);
  const r2 = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: H, payload: { name: 'redroid-dup', templateName: 'redroid-14-swiftshader', idempotencyKey: 'key-dup-0002' } });
  assert.equal(r2.statusCode, 409);
  assert.equal(r2.json().error.code, 'REDROID_NAME_TAKEN');
});

test('adb port allocation: real 127.0.0.1 collision → next port (工單 硬驗收 2 collision case)', async (t) => {
  // Occupy 15000 on the real loopback; the allocator must skip it.
  const blocker = net.createServer();
  await new Promise((res) => blocker.listen(15000, '127.0.0.1', res));
  try {
    const { app, cookies, close } = await makeApp({ configOverride: { redroidAdbRangeStart: 15000, redroidAdbRangeEnd: 15001 } });
    t.after(close);
    const r = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: { cookie: cookies.operator }, payload: { name: 'redroid-port', templateName: 'redroid-14-swiftshader', idempotencyKey: 'key-port-001' } });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().device.adbPort, 15001, 'occupied 15000 must be skipped (real 127.0.0.1 probe)');
  } finally {
    blocker.close();
  }
});

test('adb port allocation: exhausted range → 503 REDROID_PORT_UNAVAILABLE', async (t) => {
  const blocker = net.createServer();
  await new Promise((res) => blocker.listen(15000, '127.0.0.1', res));
  try {
    const { app, cookies, close } = await makeApp({ configOverride: { redroidAdbRangeStart: 15000, redroidAdbRangeEnd: 15000 } });
    t.after(close);
    const r = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: { cookie: cookies.operator }, payload: { name: 'redroid-port2', templateName: 'redroid-14-swiftshader', idempotencyKey: 'key-port-002' } });
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().error.code, 'REDROID_PORT_UNAVAILABLE');
  } finally {
    blocker.close();
  }
});

test('lifecycle: start (idempotent) → stop → start → restart → refresh (adb state) with state transitions + audit', async (t) => {
  const { app, db, cookies, close } = await makeApp();
  t.after(close);
  const H = { cookie: cookies.operator };
  const created = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: H, payload: { name: 'redroid-lc1', templateName: 'redroid-14-swiftshader', idempotencyKey: 'key-lc1-0001' } });
  const deviceId = created.json().device.id;
  assert.equal(created.json().device.containerState, 'running');

  await t.test('start on running = idempotent success (no fake re-start)', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/devices/redroid/${deviceId}/start`, headers: H });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().idempotent, true);
    assert.equal(r.json().device.containerState, 'running');
  });

  await t.test('stop → exited', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/devices/redroid/${deviceId}/stop`, headers: H });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().device.containerState, 'exited');
  });

  await t.test('start again → running', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/devices/redroid/${deviceId}/start`, headers: H });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().device.containerState, 'running');
  });

  await t.test('restart → running (always performs)', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/devices/redroid/${deviceId}/restart`, headers: H });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().device.containerState, 'running');
  });

  await t.test('refresh syncs container state + adb state via the whitelist op (127.0.0.1:<port>)', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/devices/redroid/${deviceId}/refresh`, headers: H });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().device.containerState, 'running');
    assert.equal(r.json().device.adbState, 'online');
    // the mock adb must have been called with the device's loopback target
    const adbCalls = app.redroidMockEnv.adb.calls;
    const getState = adbCalls.find((c) => c.argv.at(-1) === 'get-state');
    assert.ok(getState, 'adb get-state must have run');
    assert.ok(getState.argv.includes(`127.0.0.1:${created.json().device.adbPort}`), `target must be 127.0.0.1:<adbPort>, got ${JSON.stringify(getState.argv)}`);
  });

  await t.test('every mutation is audited', async () => {
    const actions = db.__state.auditRows.map((a) => a.action);
    for (const expected of ['redroid.device.create', 'redroid.device.stop', 'redroid.device.start', 'redroid.device.restart', 'redroid.device.refresh']) {
      assert.ok(actions.includes(expected), `audit must contain ${expected}; got: ${actions.filter((a) => a.startsWith('redroid.')).join(', ')}`);
    }
    const createAudit = db.__state.auditRows.find((a) => a.action === 'redroid.device.create');
    assert.equal(createAudit.detailsJson.adbBind, '127.0.0.1');
  });

  await t.test('list + get views expose the MD §6.4 columns', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/devices/redroid', headers: { cookie: cookies.viewer } });
    assert.equal(list.statusCode, 200);
    const row = list.json().devices.find((d) => d.id === deviceId);
    for (const col of ['name', 'image', 'androidVersion', 'adbPort', 'adbBind', 'containerState', 'adbState', 'width', 'height', 'dpi', 'fps', 'gpuMode', 'gpuStatus', 'lastDiagnosedAt']) {
      assert.ok(col in row, `list row must expose ${col}`);
    }
    const detail = await app.inject({ method: 'GET', url: `/api/devices/redroid/${deviceId}`, headers: { cookie: cookies.viewer } });
    assert.equal(detail.statusCode, 200);
    assert.ok(detail.json().device.dataDir, 'detail exposes the data dir');
  });
});

test('delete: two-step confirm, container removed, data dir kept unless removeData', async (t) => {
  const { app, cookies, dataRoot, close } = await makeApp();
  t.after(close);
  const HA = { cookie: cookies.admin };
  const created = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: { cookie: cookies.operator }, payload: { name: 'redroid-del1', templateName: 'redroid-14-swiftshader', idempotencyKey: 'key-del1-0001' } });
  assert.equal(created.statusCode, 201);
  const dataDir = `${dataRoot}/redroid-del1`;
  assert.ok(fs.existsSync(dataDir));

  await t.test('wrong confirm → 400', async () => {
    const r = await app.inject({ method: 'DELETE', url: '/api/devices/redroid/redroid-del1', headers: HA, payload: { confirm: 'redroid-other' } });
    assert.equal(r.statusCode, 400);
  });

  await t.test('delete without removeData keeps the data dir (persistence)', async () => {
    const r = await app.inject({ method: 'DELETE', url: '/api/devices/redroid/redroid-del1', headers: HA, payload: { confirm: 'redroid-del1' } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().deleted, true);
    assert.equal(r.json().containerRemoved, true);
    assert.ok(fs.existsSync(dataDir), 'data dir must SURVIVE delete (removeData=false)');
    const list = await app.inject({ method: 'GET', url: '/api/devices/redroid', headers: HA });
    assert.ok(!list.json().devices.some((d) => d.name === 'redroid-del1'));
  });

  await t.test('delete with removeData=true removes ONLY the device dir (strict scope)', async () => {
    // plant a sibling file in the data root that must survive
    fs.writeFileSync(`${dataRoot}/KEEP.txt`, 'not a device dir');
    const c2 = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: { cookie: cookies.operator }, payload: { name: 'redroid-del2', templateName: 'redroid-14-swiftshader', idempotencyKey: 'key-del2-0001' } });
    assert.equal(c2.statusCode, 201);
    const r = await app.inject({ method: 'DELETE', url: '/api/devices/redroid/redroid-del2', headers: HA, payload: { confirm: 'redroid-del2', removeData: true } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().dataRemoved, true);
    assert.ok(!fs.existsSync(`${dataRoot}/redroid-del2`), 'device dir must be removed');
    assert.ok(fs.existsSync(`${dataRoot}/KEEP.txt`), 'sibling files must survive');
  });
});

test('no arbitrary-command endpoint: POST /exec is 404 by construction (工單 硬驗收 4)', async (t) => {
  const { app, cookies, close } = await makeApp();
  t.after(close);
  for (const url of ['/api/devices/redroid/redroid-x/exec', '/api/redroid/exec', '/api/exec', '/api/devices/redroid/exec']) {
    const res = await app.inject({ method: 'POST', url, headers: { cookie: cookies.admin }, payload: { command: 'id' } });
    assert.equal(res.statusCode, 404, `${url} must be 404, got ${res.statusCode}`);
    assert.equal(res.json().error.code, 'NOT_FOUND');
  }
});

test('template delete: in-use → 409; after device gone → 200', async (t) => {
  const { app, cookies, close } = await makeApp();
  t.after(close);
  const HA = { cookie: cookies.admin };
  const tplList = await app.inject({ method: 'GET', url: '/api/redroid/templates', headers: HA });
  const tpl = tplList.json().templates.find((x) => x.name === 'redroid-14-swiftshader');

  const created = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: { cookie: cookies.operator }, payload: { name: 'redroid-inuse', templateName: 'redroid-14-swiftshader', idempotencyKey: 'key-inuse-001' } });
  assert.equal(created.statusCode, 201);

  const r1 = await app.inject({ method: 'DELETE', url: `/api/redroid/templates/${tpl.id}`, headers: HA });
  assert.equal(r1.statusCode, 409);
  assert.equal(r1.json().error.code, 'REDROID_TEMPLATE_IN_USE');

  await app.inject({ method: 'DELETE', url: '/api/devices/redroid/redroid-inuse', headers: HA, payload: { confirm: 'redroid-inuse', removeData: true } });
  const r2 = await app.inject({ method: 'DELETE', url: `/api/redroid/templates/${tpl.id}`, headers: HA });
  assert.equal(r2.statusCode, 200, r2.body);
  assert.equal(r2.json().deleted, true);
});

test('disabled template cannot create devices (409) but can be re-enabled (admin)', async (t) => {
  const { app, cookies, close } = await makeApp();
  t.after(close);
  const HA = { cookie: cookies.admin };
  const tplList = await app.inject({ method: 'GET', url: '/api/redroid/templates', headers: HA });
  const tpl = tplList.json().templates.find((x) => x.name === 'redroid-14-swiftshader');

  const off = await app.inject({ method: 'PUT', url: `/api/redroid/templates/${tpl.id}`, headers: HA, payload: { isEnabled: false } });
  assert.equal(off.statusCode, 200, off.body);
  const r1 = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: { cookie: cookies.operator }, payload: { name: 'redroid-dis', templateName: 'redroid-14-swiftshader', idempotencyKey: 'key-dis-0001' } });
  assert.equal(r1.statusCode, 409);
  assert.equal(r1.json().error.code, 'REDROID_TEMPLATE_DISABLED');
  const on = await app.inject({ method: 'PUT', url: `/api/redroid/templates/${tpl.id}`, headers: HA, payload: { isEnabled: true } });
  assert.equal(on.statusCode, 200);
});

test('mock adapter honesty: mock is labelled mock everywhere it appears', async (t) => {
  const { app, cookies, close } = await makeApp();
  t.after(close);
  const pre = await app.inject({ method: 'GET', url: '/api/redroid/preflight', headers: { cookie: cookies.viewer } });
  assert.equal(pre.statusCode, 200);
  assert.equal(pre.json().mock, true);
  assert.ok(pre.json().warnings.some((w) => /mock/i.test(w)));
  const preGpu = await app.inject({ method: 'GET', url: '/api/redroid/preflight?gpu=true', headers: { cookie: cookies.viewer } });
  assert.equal(preGpu.statusCode, 200);
  assert.equal(preGpu.json().gpu.verified, false, 'even the mock must never claim GPU verified (MD §2.4)');
});
