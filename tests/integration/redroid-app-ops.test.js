/**
 * W2 (ADR-026) integration — app-layer ops through the mock adapter.
 *
 * Hard assertions (代碼段 scope — real devices = NOT VERIFIED, ADR-026 §5):
 *  1. Switch OFF (default): EVERY app route fails closed 503 APP_OPS_DISABLED.
 *  2. Switch ON: install → list → packageInfo → ui/dump → tap flow works end
 *     to end against the mock device state; the tap lands on the element
 *     center recorded by the mock.
 *  3. Corrupt APK fails on the HOST gate (ZIP magic) — ZERO adb calls for
 *     install (no side effects, no half-install).
 *  4. Selector contract through routes: ambiguous 409, absent 404,
 *     off-screen 422 (template geometry drives the bounds check).
 *  5. RBAC: reads = viewer+; install/uninstall/dump/tap = operator+;
 *     every mutation audited (app.device.*).
 *  6. Device not running → 409 APP_DEVICE_NOT_RUNNING (fail-closed, 未執行).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeRedroidTestApp, login, seedRedroidTemplates } from '../helpers/redroid-fakes.js';

const ZIP = (payload = 'pretend-zip') => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(payload)]);

const OFFSCREEN_XML = `<?xml version='1.0' encoding='UTF-8' standalone=yes ?>
<hierarchy rotation="0">
  <node text="Gone" resource-id="com.demo:id/below" class="android.widget.Button" package="com.demo" content-desc="" clickable="true" enabled="true" bounds="[10,2000][200,2080]" />
  <node text="Here" resource-id="com.demo:id/ok" class="android.widget.Button" package="com.demo" content-desc="" clickable="true" enabled="true" bounds="[10,500][200,560]" />
</hierarchy>`;

async function makeApp({ on = true, adbOpts = {}, configOverride = {}, deviceGeometry = null } = {}) {
  const { app, db, dataRoot, redroidMock } = await makeRedroidTestApp({
    redroidMockOpts: adbOpts,
    configOverride: {
      ...(on ? { waAppOpsEnabled: true } : {}),
      ...configOverride,
    },
  });
  // config is the same object the service closes over — set AFTER dataRoot exists
  app.config.waApkDir = path.join(dataRoot, 'apk');
  fs.mkdirSync(app.config.waApkDir, { recursive: true });
  const cookies = { admin: await login(app, 'admin'), operator: await login(app, 'operator'), viewer: await login(app, 'viewer') };
  await seedRedroidTemplates(app, cookies.admin);
  return {
    app, db, dataRoot, redroidMock, cookies,
    close: async () => {
      await app.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

async function createDevice(app, cookie, name = 'redroid-w2') {
  const res = await app.inject({
    method: 'POST', url: '/api/devices/redroid', headers: { cookie },
    payload: { name, templateName: 'redroid-14-swiftshader', idempotencyKey: `w2-${name}` },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().device;
}

// ---- 1. switch OFF ------------------------------------------------------------

test('switch OFF (default): every app route fails closed 503 APP_OPS_DISABLED', async (t) => {
  const { app, cookies, close } = await makeApp({ on: false });
  t.after(close);
  const device = await createDevice(app, cookies.operator);
  const H = { cookie: cookies.operator };
  const calls = [
    ['GET', `/api/devices/redroid/${device.id}/apps`],
    ['GET', `/api/devices/redroid/${device.id}/apps/com.android.mock`],
    ['GET', `/api/devices/redroid/${device.id}/foreground`],
    ['POST', `/api/devices/redroid/${device.id}/apps/install`, { fileName: 'a.apk' }],
    ['DELETE', `/api/devices/redroid/${device.id}/apps/com.android.mock`],
    ['POST', `/api/devices/redroid/${device.id}/ui/dump`],
    ['POST', `/api/devices/redroid/${device.id}/ui/tap`, { selector: { text: 'x' } }],
  ];
  for (const [method, url, payload] of calls) {
    const res = await app.inject({ method, url, headers: H, payload });
    assert.equal(res.statusCode, 503, `${method} ${url} must be 503 while disabled`);
    assert.equal(res.json().error.code, 'APP_OPS_DISABLED');
  }
});

// ---- 2. happy path + audit ------------------------------------------------------

test('switch ON: install → list → packageInfo → dump → tap flow (mock device truth)', async (t) => {
  const { app, db, dataRoot, redroidMock, cookies, close } = await makeApp();
  t.after(close);
  const device = await createDevice(app, cookies.operator);
  const H = { cookie: cookies.operator };
  fs.writeFileSync(path.join(dataRoot, 'apk', 'demo.apk'), ZIP('body package=com.demo.target trailer'));

  const inst = await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/apps/install`, headers: H, payload: { fileName: 'demo.apk' } });
  assert.equal(inst.statusCode, 200, inst.body);
  assert.equal(inst.json().installed, true);
  assert.equal(inst.json().devicePath, '/data/local/tmp/wa_demo.apk');

  const list = await app.inject({ method: 'GET', url: `/api/devices/redroid/${device.id}/apps`, headers: { cookie: cookies.viewer } });
  assert.equal(list.statusCode, 200, list.body);
  const { packages } = list.json();
  assert.ok(packages.includes('com.demo.target'), 'installed package must appear in the list');
  assert.ok(packages.includes('com.android.mock'));
  assert.deepEqual([...packages].sort(), packages, 'list is sorted + deduped');

  const info = await app.inject({ method: 'GET', url: `/api/devices/redroid/${device.id}/apps/com.demo.target`, headers: { cookie: cookies.viewer } });
  assert.equal(info.statusCode, 200, info.body);
  assert.equal(info.json().installed, true);
  assert.match(info.json().versionName, /^mock-/);
  assert.match(info.json().loginState, /activity-level/);

  const fg = await app.inject({ method: 'GET', url: `/api/devices/redroid/${device.id}/foreground`, headers: { cookie: cookies.viewer } });
  assert.equal(fg.statusCode, 200, fg.body);
  assert.deepEqual(fg.json().foreground, { package: 'com.android.mock', activity: 'com.android.mock.MainActivity' });

  const dump = await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/ui/dump`, headers: H });
  assert.equal(dump.statusCode, 200, dump.body);
  const nodes = dump.json().nodes;
  assert.equal(nodes.length, 3);
  assert.equal(nodes[1].resourceId, 'com.android.mock:id/login');

  const tap = await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/ui/tap`, headers: H, payload: { selector: { resourceId: 'com.android.mock:id/login' } } });
  assert.equal(tap.statusCode, 200, tap.body);
  assert.deepEqual(tap.json().tapped, { x: 360, y: 640 }); // element center
  assert.deepEqual(redroidMock.adb.w2.taps.at(-1), { x: 360, y: 640 }, 'the mock device received the tap');

  // uninstall + existence flips to false
  const un = await app.inject({ method: 'DELETE', url: `/api/devices/redroid/${device.id}/apps/com.demo.target`, headers: H });
  assert.equal(un.statusCode, 200, un.body);
  const info2 = await app.inject({ method: 'GET', url: `/api/devices/redroid/${device.id}/apps/com.demo.target`, headers: { cookie: cookies.viewer } });
  assert.equal(info2.json().installed, false);

  // audit trail (mutations audited)
  const actions = db.__state.auditRows.map((a) => a.action);
  for (const a of ['app.device.install', 'app.device.uninstall', 'app.device.ui_dump', 'app.device.ui_tap', 'app.device.packages', 'app.device.foreground']) {
    assert.ok(actions.includes(a), `audit must contain ${a}`);
  }
  // zero-shell evidence: every recorded adb call went through the fixed binary with argv arrays
  for (const c of redroidMock.adb.calls) {
    assert.equal(c.bin, '/usr/bin/adb');
    assert.ok(Array.isArray(c.argv));
  }
});

// ---- 3. corrupt APK: host gate, zero device side effects --------------------------

test('corrupt APK: rejected on the host gate — ZERO adb install/push calls', async (t) => {
  const { app, dataRoot, redroidMock, cookies, close } = await makeApp();
  t.after(close);
  const device = await createDevice(app, cookies.operator);
  const H = { cookie: cookies.operator };
  fs.writeFileSync(path.join(dataRoot, 'apk', 'broken.apk'), 'definitely not a zip file');
  const before = redroidMock.adb.calls.length;

  const res = await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/apps/install`, headers: H, payload: { fileName: 'broken.apk' } });
  assert.equal(res.statusCode, 422, res.body);
  assert.equal(res.json().error.code, 'APK_CORRUPT');
  const newCalls = redroidMock.adb.calls.slice(before).filter((c) => c.argv.some((a) => String(a).includes('install') || String(a).includes('push')));
  assert.deepEqual(newCalls, [], 'a corrupt APK must never reach the device');

  // traversal-shaped names rejected at schema level (400 before the service)
  const bad = await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/apps/install`, headers: H, payload: { fileName: '../../etc/passwd.apk' } });
  assert.equal(bad.statusCode, 400);
  // absent-but-legal name → 404 from the service
  const absent = await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/apps/install`, headers: H, payload: { fileName: 'ghost.apk' } });
  assert.equal(absent.statusCode, 404);
  assert.equal(absent.json().error.code, 'APK_FILE_NOT_FOUND');
});

// ---- 4. selector error contract through routes --------------------------------------

test('selector contract: ambiguous 409 / absent 404 / off-screen 422', async (t) => {
  const { app, cookies, close } = await makeApp();
  t.after(close);
  const device = await createDevice(app, cookies.operator);
  const H = { cookie: cookies.operator };

  const amb = await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/ui/tap`, headers: H, payload: { selector: { text: 'Sign in' } } });
  assert.equal(amb.statusCode, 409, amb.body);
  assert.equal(amb.json().error.code, 'UIA_ELEMENT_AMBIGUOUS');
  assert.match(amb.json().error.message, /2 UI elements match/, 'ambiguous error names the count in the message');

  const gone = await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/ui/tap`, headers: H, payload: { selector: { resourceId: 'com.demo:id/nope' } } });
  assert.equal(gone.statusCode, 404);
  assert.equal(gone.json().error.code, 'UIA_ELEMENT_NOT_FOUND');

  // empty selector object rejected at schema level (minProperties 1)
  const empty = await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/ui/tap`, headers: H, payload: { selector: {} } });
  assert.equal(empty.statusCode, 400);
});

test('off-screen element: template geometry drives the bounds check (422)', async (t) => {
  const { app, cookies, close } = await makeApp({ adbOpts: { appState: { uiXml: OFFSCREEN_XML } } });
  t.after(close);
  const device = await createDevice(app, cookies.operator);
  const H = { cookie: cookies.operator };

  const off = await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/ui/tap`, headers: H, payload: { selector: { resourceId: 'com.demo:id/below' } } });
  assert.equal(off.statusCode, 422, off.body);
  assert.equal(off.json().error.code, 'UIA_ELEMENT_OFFSCREEN', 'y=2040 must miss the 720x1280 template screen');
  const ok = await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/ui/tap`, headers: H, payload: { selector: { resourceId: 'com.demo:id/ok' } } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(ok.json().tapped, { x: 105, y: 530 });
});

// ---- 5. RBAC matrix --------------------------------------------------------------

test('RBAC: viewer reads OK but mutations 403; operator mutations pass', async (t) => {
  const { app, cookies, close } = await makeApp();
  t.after(close);
  const device = await createDevice(app, cookies.operator);
  const V = { cookie: cookies.viewer };

  assert.equal((await app.inject({ method: 'GET', url: `/api/devices/redroid/${device.id}/apps`, headers: V })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/api/devices/redroid/${device.id}/foreground`, headers: V })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/ui/dump`, headers: V })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/ui/tap`, headers: V, payload: { selector: { text: 'x' } } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/apps/install`, headers: V, payload: { fileName: 'a.apk' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/devices/redroid/${device.id}/apps/com.android.mock`, headers: V })).statusCode, 403);
});

// ---- 6. device not running ----------------------------------------------------------

test('stopped device: app ops fail closed 409 APP_DEVICE_NOT_RUNNING (no adb call)', async (t) => {
  const { app, redroidMock, cookies, close } = await makeApp();
  t.after(close);
  const device = await createDevice(app, cookies.operator);
  const H = { cookie: cookies.operator };
  const stop = await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/stop`, headers: H });
  assert.equal(stop.statusCode, 200, stop.body);
  const before = redroidMock.adb.calls.length;
  const res = await app.inject({ method: 'GET', url: `/api/devices/redroid/${device.id}/apps`, headers: H });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error.code, 'APP_DEVICE_NOT_RUNNING');
  assert.equal(redroidMock.adb.calls.length, before, 'no adb traffic for a not-running device');
});
