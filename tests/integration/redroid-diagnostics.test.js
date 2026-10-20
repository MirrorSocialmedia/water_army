/**
 * P5 commit 4 — diagnostics 4-zone + logcat cap integration tests (mock).
 *
 * 工單 硬驗收 1 (partial: 4 區獨立結果 + 零假「已驗證」) / 5 (輸出 cap):
 *  - kernel / containerLogs / adbConnectivity / gpuVerification are
 *    INDEPENDENT results, each with executed + status
 *  - a zone that was not executed = 'unverified' (未驗證), never a pass
 *  - host GPU → 'unverified' (MD §2.4), swiftshader → 'software'
 *  - logcat tail cap enforced server-side (huge tail clamped, truncated
 *    flagged on real truncation)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRedroidTestApp, login, seedRedroidTemplates } from '../helpers/redroid-fakes.js';

async function makeApp(opts = {}) {
  const { app, db, dataRoot } = await makeRedroidTestApp(opts);
  const cookies = { admin: await login(app, 'admin'), operator: await login(app, 'operator'), viewer: await login(app, 'viewer') };
  await seedRedroidTemplates(app, cookies.admin);
  const close = async () => {
    await app.close();
    // dataRoot may be undefined if the app failed to build
    try {
      if (dataRoot) (await import('node:fs')).rmSync(dataRoot, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  };
  return { app, db, dataRoot, cookies, close };
}

async function createRunningDevice(app, cookie, name = 'redroid-diag', templateName = 'redroid-15-gpu-privileged', key = 'key-diag-001') {
  const res = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: { cookie }, payload: { name, templateName, idempotencyKey: key } });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().device;
}

test('diagnostics: five INDEPENDENT zones, all executed, host GPU = unverified (never fake-verified)', async (t) => {
  const { app, db, cookies, close } = await makeApp();
  t.after(close);
  const H = { cookie: cookies.operator };
  const device = await createRunningDevice(app, H.cookie);

  const res = await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/diagnostics`, headers: H });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  const d = body.diagnostics;
  assert.ok(body.checkedAt);

  await t.test('zone 1 kernel: executed + supported (mock-labelled) + suggestions/supported detail', async () => {
    assert.equal(d.kernel.executed, true);
    assert.equal(d.kernel.status, 'supported');
    assert.equal(d.kernel.mock, true, 'mock preflight must be labelled mock');
    assert.equal(d.kernel.details.overall, 'supported');
    assert.ok(Array.isArray(d.kernel.summary));
  });

  await t.test('zone 2 containerLogs: executed + ok + lines (bounded)', async () => {
    assert.equal(d.containerLogs.executed, true);
    assert.equal(d.containerLogs.status, 'ok');
    assert.ok(Array.isArray(d.containerLogs.lines) && d.containerLogs.lines.length > 0);
    assert.equal(d.containerLogs.truncated, false);
  });

  await t.test('zone 3 adbConnectivity: executed + online via the loopback whitelist op', async () => {
    assert.equal(d.adbConnectivity.executed, true);
    assert.equal(d.adbConnectivity.status, 'online');
    assert.equal(d.adbConnectivity.target, `127.0.0.1:${device.adbPort}`);
    assert.equal(d.adbConnectivity.connectAttempted, false);
    assert.match(d.adbConnectivity.evidence, /device online/);
  });

  await t.test('zone 4 gpuVerification: host mode = unverified (MD §2.4 hard rule)', async () => {
    assert.equal(d.gpuVerification.executed, true);
    assert.equal(d.gpuVerification.status, 'unverified', 'host GPU without a render check MUST be 未驗證');
    assert.equal(d.gpuVerification.gpuStatus, 'unverified');
    assert.match(d.gpuVerification.note, /MD §2\.4/);
    // and the device row itself never says verified
    assert.notEqual(device.gpuStatus, 'verified');
  });

  await t.test('zone 5 network (R3): no-proxy device = unconfigured (nothing to verify, no fake pass)', async () => {
    assert.equal(d.network.executed, false);
    assert.equal(d.network.status, 'unconfigured');
    assert.match(d.network.note, /no proxy binding/);
  });

  await t.test('lastDiagnosedAt is stamped + diagnostics audited', async () => {
    const detail = await app.inject({ method: 'GET', url: `/api/devices/redroid/${device.id}`, headers: H });
    assert.ok(detail.json().device.lastDiagnosedAt, 'lastDiagnosedAt must be set');
    const audit = db.__state.auditRows.find((a) => a.action === 'redroid.device.diagnostics');
    assert.ok(audit, 'diagnostics must be audited');
    assert.deepEqual(audit.detailsJson.zones, { kernel: 'supported', containerLogs: 'ok', adbConnectivity: 'online', gpuVerification: 'unverified', network: 'unconfigured' });
  });
});

test('diagnostics: swiftshader device → gpuVerification "software" (honest 軟體/降級 label)', async (t) => {
  const { app, cookies, close } = await makeApp();
  t.after(close);
  const H = { cookie: cookies.operator };
  const device = await createRunningDevice(app, H.cookie, 'redroid-swdiag', 'redroid-14-swiftshader', 'key-swdiag-1');
  const res = await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/diagnostics`, headers: H });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().diagnostics.gpuVerification.status, 'software');
  assert.match(res.json().diagnostics.gpuVerification.note, /software/i);
});

test('diagnostics: stopped device → adb zone NOT executed = unverified (never a fake pass)', async (t) => {
  const { app, cookies, close } = await makeApp();
  t.after(close);
  const H = { cookie: cookies.operator };
  const device = await createRunningDevice(app, H.cookie, 'redroid-stopdiag', 'redroid-14-swiftshader', 'key-stopdiag1');
  const stop = await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/stop`, headers: H });
  assert.equal(stop.statusCode, 200, stop.body);

  const res = await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/diagnostics`, headers: H });
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().diagnostics;
  // the other zones still run independently
  assert.equal(d.kernel.executed, true);
  assert.equal(d.containerLogs.executed, true, 'logs are readable while exited');
  // the adb zone was NOT executed — and that must be honest
  assert.equal(d.adbConnectivity.executed, false);
  assert.equal(d.adbConnectivity.status, 'unverified', 'not executed = 未驗證, never "online"');
  assert.match(d.adbConnectivity.note, /not executed/i);
});

test('diagnostics: adb offline (mock) → connect attempted once, still offline is reported honestly', async (t) => {
  const { app, cookies, close } = await makeApp({ redroidMockOpts: { online: false } });
  t.after(close);
  const H = { cookie: cookies.operator };
  const device = await createRunningDevice(app, H.cookie, 'redroid-offdiag', 'redroid-14-swiftshader', 'key-offdiag-1');

  const res = await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/diagnostics`, headers: H });
  assert.equal(res.statusCode, 200, res.body);
  const zone = res.json().diagnostics.adbConnectivity;
  assert.equal(zone.executed, true);
  assert.equal(zone.status, 'offline');
  assert.equal(zone.connectAttempted, true, 'one connect attempt is allowed');
  // and the adb calls recorded by the mock: get-state, connect, get-state — all loopback, all whitelist
  const adbCalls = app.redroidMockEnv.adb.calls;
  assert.ok(adbCalls.length >= 3);
  for (const c of adbCalls) {
    assert.equal(c.bin, '/usr/bin/adb', 'fixed adb binary path only');
    const target = c.argv.find((a) => /^127\.0\.0\.1:\d+$/.test(a));
    assert.ok(target, `every adb call must carry a loopback target: ${JSON.stringify(c.argv)}`);
    assert.ok(!c.argv.includes('shell') || ['getprop', 'dumpsys', 'logcat'].includes(c.argv[c.argv.indexOf('shell') + 1]), `no non-whitelisted shell op: ${JSON.stringify(c.argv)}`);
  }
});

test('logcat: tail default + explicit tail + SERVER-SIDE cap (huge tail clamped, truncation flagged)', async (t) => {
  // 6000 canned lines — a 5000 cap MUST clamp and flag truncation.
  const bigLines = Array.from({ length: 6000 }, (_, i) => `I/MockBig(${i}): line ${i}`);
  const { app, cookies, close } = await makeApp({
    redroidMockOpts: { logcatLines: bigLines },
    configOverride: { redroidLogcatTailDefault: 200, redroidLogcatTailMax: 5000 },
  });
  t.after(close);
  const H = { cookie: cookies.operator };
  const device = await createRunningDevice(app, H.cookie, 'redroid-catdiag', 'redroid-14-swiftshader', 'key-catdiag-1');

  await t.test('no tail → default (200)', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/devices/redroid/${device.id}/logcat`, headers: H });
    assert.equal(r.statusCode, 200, r.body);
    const b = r.json();
    assert.equal(b.tail, 200);
    assert.equal(b.lines.length, 200);
    assert.equal(b.truncated, false);
  });

  await t.test('explicit tail=50 → 50 lines (the TAIL of the buffer)', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/devices/redroid/${device.id}/logcat?tail=50`, headers: H });
    assert.equal(r.statusCode, 200, r.body);
    const b = r.json();
    assert.equal(b.tail, 50);
    assert.equal(b.lines.length, 50);
    assert.match(b.lines.at(-1), /line 5999/);
  });

  await t.test('tail=999999 → clamped to the tail cap (5000): line-cap enforced server-side (工單 硬驗收 5)', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/devices/redroid/${device.id}/logcat?tail=999999`, headers: H });
    assert.equal(r.statusCode, 200, r.body);
    const b = r.json();
    assert.equal(b.tail, 5000, 'the tail cap is server-side — the client cannot exceed it');
    assert.equal(b.tailCap, 5000);
    assert.equal(b.lines.length, 5000, 'buffer has 6000 lines but only the capped 5000 are returned');
    // the byte cap is a separate backstop; 5000 short lines fit under it → no byte truncation
    assert.equal(b.truncated, false, 'line cap is the logcat cap; byte cap is the backstop (not hit at this line size)');
  });

  await t.test('byte cap backstop: a huge single response is byte-clipped + truncated flagged (never silent)', async () => {
    // Rebuild a mock adb whose lines are big enough that 5000 lines exceed the 256KB byte cap.
    const hugeLines = Array.from({ length: 5200 }, (_, i) => `I/Huge(${i}): ${'x'.repeat(90)}`); // ~100 bytes × 5200 ≈ 520KB
    const { app: app2, cookies: ck2, close: close2 } = await makeApp({
      redroidMockOpts: { logcatLines: hugeLines },
      configOverride: { redroidLogcatTailDefault: 200, redroidLogcatTailMax: 5000 },
    });
    t.after(close2);
    const dev2 = await createRunningDevice(app2, ck2.operator, 'redroid-huge', 'redroid-14-swiftshader', 'key-huge-001');
    const r = await app2.inject({ method: 'GET', url: `/api/devices/redroid/${dev2.id}/logcat?tail=5000`, headers: { cookie: ck2.operator } });
    assert.equal(r.statusCode, 200, r.body);
    const b = r.json();
    assert.equal(b.tail, 5000);
    assert.equal(b.truncated, true, 'byte cap (256KB) MUST flag truncation, not silently drop');
    assert.ok(b.lines.length < 5000, 'byte clipping reduces returned lines below the line cap');
  });

  await t.test('invalid tail values → 400', async () => {
    for (const q of ['tail=0', 'tail=abc', 'tail=-5', 'tail=1.5']) {
      const r = await app.inject({ method: 'GET', url: `/api/devices/redroid/${device.id}/logcat?${q}`, headers: H });
      assert.equal(r.statusCode, 400, `${q} must be 400, got ${r.statusCode}: ${r.body}`);
    }
  });
});

test('diagnostics + logcat RBAC: viewer → 403, unauthenticated → 401', async (t) => {
  const { app, cookies, close } = await makeApp();
  t.after(close);
  const H = { cookie: cookies.operator };
  const device = await createRunningDevice(app, H.cookie, 'redroid-rbacdiag', 'redroid-14-swiftshader', 'key-rbacdiag1');

  assert.equal((await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/diagnostics` })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: `/api/devices/redroid/${device.id}/logcat` })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: `/api/devices/redroid/${device.id}/diagnostics`, headers: { cookie: cookies.viewer } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: `/api/devices/redroid/${device.id}/logcat`, headers: { cookie: cookies.viewer } })).statusCode, 403);
});

test('diagnostics: create with failing start (mock boot crash) → container created but adb unverified, logs still executable', async (t) => {
  const { app, cookies, close } = await makeApp({ redroidMockOpts: { startFails: true } });
  t.after(close);
  const H = { cookie: cookies.operator };
  const res = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: H, payload: { name: 'redroid-crash', templateName: 'redroid-14-swiftshader', idempotencyKey: 'key-crash-001' } });
  assert.equal(res.statusCode, 201, res.body);
  assert.ok(res.json().startError, 'startError must be surfaced (honest, not hidden)');

  const diag = await app.inject({ method: 'POST', url: `/api/devices/redroid/${res.json().device.id}/diagnostics`, headers: H });
  assert.equal(diag.statusCode, 200, diag.body);
  const d = diag.json().diagnostics;
  assert.equal(d.adbConnectivity.executed, false, 'container not running → adb NOT executed');
  assert.equal(d.adbConnectivity.status, 'unverified');
  assert.equal(d.containerLogs.executed, true, 'logs of a created container are still readable');
  assert.equal(d.kernel.executed, true);
  // and the response never claims the device is up
  assert.equal(diag.json().device.containerState, 'created');
});
