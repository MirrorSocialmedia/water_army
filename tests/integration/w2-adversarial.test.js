/**
 * W2 (ADR-026) — integration adversarial matrix (mock device).
 *
 *  1. Magic SPOOF end-to-end: a ZIP-magic + garbage APK passes the host gate
 *     (by design — the gate cannot parse APKs), is pushed, and the DEVICE
 *     verdict decides. The platform never claims which package landed —
 *     discovery is `packageInfo` (the device is the truth).
 *  2. UI dump SIZE BOMB: a hierarchy above WA_UIA_MAX_BYTES → 522
 *     UIA_DUMP_TOO_LARGE on BOTH /ui/dump and /ui/tap (tap re-dumps — a
 *     truncated tree is never tappable).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeRedroidTestApp, login, seedRedroidTemplates } from '../helpers/redroid-fakes.js';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

async function makeApp({ adbOpts = {}, configOverride = {} } = {}) {
  const { app, db, dataRoot, redroidMock } = await makeRedroidTestApp({
    redroidMockOpts: adbOpts,
    configOverride: { waAppOpsEnabled: true, ...configOverride },
  });
  app.config.waApkDir = path.join(dataRoot, 'apk');
  fs.mkdirSync(app.config.waApkDir, { recursive: true });
  const cookies = { admin: await login(app, 'admin'), operator: await login(app, 'operator'), viewer: await login(app, 'viewer') };
  await seedRedroidTemplates(app, cookies.admin);
  return {
    app, db, dataRoot, redroidMock, cookies,
    close: async () => { await app.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); },
  };
}

async function createDevice(app, cookie, name = 'redroid-w2a') {
  const res = await app.inject({
    method: 'POST', url: '/api/devices/redroid', headers: { cookie },
    payload: { name, templateName: 'redroid-14-swiftshader', idempotencyKey: `w2a-${name}` },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().device;
}

test('magic spoof: ZIP-magic + garbage — host gate passes, device verdict decides, no package claim, exactly one push', async (t) => {
  const { app, db, dataRoot, redroidMock, cookies, close } = await makeApp();
  t.after(close);
  const device = await createDevice(app, cookies.operator);
  const H = { cookie: cookies.operator };
  const spoof = Buffer.concat([ZIP_MAGIC, Buffer.from('garbage-garbage-no-structure')]);
  fs.writeFileSync(path.join(dataRoot, 'apk', 'spoof.apk'), spoof);

  const before = redroidMock.adb.calls.length;
  const res = await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/apps/install`, headers: H, payload: { fileName: 'spoof.apk' } });
  // The mock device honors the documented corruption semantics (ZIP magic →
  // parseable), so the device verdict is Success here. On a REAL device a
  // magic-spoofed APK answers INSTALL_PARSE_FAILED_NOT_APK → 502
  // APK_INSTALL_FAILED (unit-tested against the real-device verdict shape).
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.installed, true);
  assert.equal('package' in body, false, 'the platform NEVER claims which package landed — discovery is packageInfo (device truth)');

  const newCalls = redroidMock.adb.calls.slice(before);
  assert.equal(newCalls.filter((c) => c.argv.includes('push')).length, 1, 'exactly one push for one install');
  // the device received byte-for-byte what the host served
  assert.equal(redroidMock.adb.w2.files.get('/data/local/tmp/wa_spoof.apk').length, spoof.length);

  // audit recorded the install with byte count (no package claim)
  const install = db.__state.auditRows.filter((a) => a.action === 'app.device.install').at(-1);
  assert.equal(install.status, 'success');
  assert.equal(install.detailsJson.bytes, spoof.length);
  assert.equal(install.detailsJson.package, undefined);
});

test('magic spoof vs corrupt (no magic): corrupt dies on the HOST gate with ZERO device traffic (regression guard)', async (t) => {
  const { app, dataRoot, redroidMock, cookies, close } = await makeApp();
  t.after(close);
  const device = await createDevice(app, cookies.operator);
  const H = { cookie: cookies.operator };
  fs.writeFileSync(path.join(dataRoot, 'apk', 'nomagic.apk'), Buffer.from('plain text, no zip magic'));
  const before = redroidMock.adb.calls.length;
  const res = await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/apps/install`, headers: H, payload: { fileName: 'nomagic.apk' } });
  assert.equal(res.statusCode, 422, res.body);
  assert.equal(res.json().error.code, 'APK_CORRUPT');
  assert.equal(redroidMock.adb.calls.length, before, 'zero adb calls — the corrupt file never leaves the host');
});

const BOMB_NODE = (id) =>
  `<node resource-id="com.demo:id/${id}" text="padding-padding-padding" class="android.widget.TextView" package="com.demo" content-desc="" clickable="false" enabled="true" bounds="[0,0][10,10]" />`;

test('UI dump size bomb: hierarchy above WA_UIA_MAX_BYTES → 522 on dump AND tap (never a partial tree)', async (t) => {
  const bigXml = `<?xml version='1.0' encoding='UTF-8' standalone=yes ?>\n<hierarchy rotation="0">\n` +
    Array.from({ length: 200 }, (_, i) => BOMB_NODE(`bomb${i}`)).join('\n') +
    '\n</hierarchy>';
  assert.ok(Buffer.byteLength(bigXml, 'utf8') > 4096, 'fixture must exceed the 4 KiB cap under test');

  const { app, cookies, close } = await makeApp({
    adbOpts: { appState: { uiXml: bigXml } },
    configOverride: { waUiaMaxBytes: 4096 },
  });
  t.after(close);
  const device = await createDevice(app, cookies.operator);
  const H = { cookie: cookies.operator };

  const dump = await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/ui/dump`, headers: H });
  assert.equal(dump.statusCode, 522, dump.body);
  assert.equal(dump.json().error.code, 'UIA_DUMP_TOO_LARGE');

  const tap = await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/ui/tap`, headers: H, payload: { selector: { resourceId: 'com.demo:id/bomb0' } } });
  assert.equal(tap.statusCode, 522, 'tap re-dumps — a truncated tree must never be tappable');
  assert.equal(tap.json().error.code, 'UIA_DUMP_TOO_LARGE');

  // and the node cap is a SEPARATE bomb: small bytes, too many nodes
  const many = `<?xml version='1.0' encoding='UTF-8' standalone=yes ?>\n<hierarchy rotation="0">\n` +
    Array.from({ length: 60 }, (_, i) => `<node resource-id="com.demo:id/m${i}" class="c" package="p" bounds="[0,0][1,1]" />`).join('\n') +
    '\n</hierarchy>';
  const { app: app2, cookies: c2, close: close2 } = await makeApp({
    adbOpts: { appState: { uiXml: many } },
    configOverride: { waUiaMaxBytes: 4_194_304, waUiaMaxNodes: 50 },
  });
  t.after(close2);
  const device2 = await createDevice(app2, c2.operator, 'redroid-w2b');
  const dump2 = await app2.inject({ method: 'POST', url: `/api/devices/redroid/${device2.id}/ui/dump`, headers: { cookie: c2.operator } });
  // node cap is a SEPARATE bomb from byte cap: parse-level 422 UIA_DUMP_NODE_LIMIT
  assert.equal(dump2.statusCode, 422, dump2.body);
  assert.equal(dump2.json().error.code, 'UIA_DUMP_NODE_LIMIT');
});
