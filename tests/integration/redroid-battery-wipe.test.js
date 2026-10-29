/**
 * WA-RESCAN (S1, 2026-10-30) — battery WIPE-RACE integration.
 *
 * The bug: the BatteryService override lives in system-server memory; any
 * boot event wipes it back to the container defaults (status:1 /
 * present:false / level:0 — fx-2 measured), and the pre-RESCAN drift leg
 * trusted its own per-process map, so the app surface read defaults for up
 * to a full drift step. The fix: the watchdog tick reads the DEVICE BACK
 * first and force-replays the full story (idempotent) on any divergence.
 *
 * This suite drives the REAL service code (mock env, pollMs=0, explicit
 * sweeps): provisioning → wipe → sweep (replay, readback clean) → sweep
 * (steady, zero battery execs). The "抹走 → 重放 → readback" race shape the
 * work order asks for, plus the readback-exec-unavailable degradation path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { makeRedroidTestApp, login, SEED_TEMPLATES } from '../helpers/redroid-fakes.js';
import { buildStealthBatteryProfile } from '../../packages/shared/src/stealth-battery.js';

async function makeApp() {
  const { app, dataRoot, redroidMock } = await makeRedroidTestApp({
    configOverride: { redroidStealthEnabled: true, redroidBatteryDriftEnabled: true },
  });
  const admin = await login(app, 'admin');
  for (const t of SEED_TEMPLATES) {
    const res = await app.inject({ method: 'POST', url: '/api/redroid/templates', headers: { cookie: admin }, payload: t });
    assert.equal(res.statusCode, 201, `seed template: ${res.statusCode} ${res.body}`);
  }
  return {
    app,
    redroidMock,
    cookie: admin,
    close: async () => { await app.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); },
  };
}

async function createRunningDevice(app, cookie, name) {
  const created = await app.inject({
    method: 'POST', url: '/api/devices/redroid', headers: { cookie },
    payload: { name, templateName: 'redroid-14-swiftshader', idempotencyKey: `key-${name}` },
  });
  assert.equal(created.statusCode, 201, `create: ${created.statusCode} ${created.body}`);
  const started = await app.inject({
    method: 'POST', url: `/api/devices/redroid/${name}/start`, headers: { cookie }, payload: {},
  });
  assert.ok([200, 201, 202, 409].includes(started.statusCode), `start: ${started.statusCode} ${started.body}`);
  return created.json();
}

async function waitFor(cond, tries = 60, ms = 25) {
  for (let i = 0; i < tries; i += 1) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, ms));
  }
  return false;
}

const batteryScriptCalls = (mock) => mock.exec.calls.filter((c) => /BATTERY_(STEALTH|DRIFT|READBACK)_OK/.test(c.script)).map((c) => {
  const m = /BATTERY_(STEALTH|DRIFT|READBACK)_OK/.exec(c.script);
  return m[1];
});
const countOf = (calls, kind) => calls.filter((c) => c === kind).length;

test('RESCAN S1: provisioning applies the story to the device (not just the map)', async () => {
  const t = await makeApp();
  try {
    const name = 'redroid-bat-race1';
    await createRunningDevice(t.app, t.cookie, name);
    const applied = await waitFor(() => t.redroidMock.exec.battery.present === true);
    assert.ok(applied, 'provisioning must apply the story (present=true) on the mock device');
    const expected = buildStealthBatteryProfile({ seed: name }); // no identityId in mock → seed = name
    const bat = t.redroidMock.exec.battery;
    assert.equal(bat.status, expected.status);
    assert.equal(bat.level, expected.level);
  } finally { await t.close(); }
});

test('RESCAN S1: boot WIPE → watchdog sweep force-replays the FULL story (race shape)', async () => {
  const t = await makeApp();
  try {
    const name = 'redroid-bat-race2';
    await createRunningDevice(t.app, t.cookie, name);
    assert.ok(await waitFor(() => t.redroidMock.exec.battery.present === true), 'story provisioned');
    const expected = buildStealthBatteryProfile({ seed: name });

    // Simulate the boot event: story wiped to container defaults.
    t.redroidMock.exec.resetBattery();
    assert.deepEqual(
      { level: t.redroidMock.exec.battery.level, status: t.redroidMock.exec.battery.status, present: t.redroidMock.exec.battery.present },
      { level: 0, status: 1, present: false },
    );

    // ONE watchdog sweep = readback detects the wipe → full-story replay.
    await t.app.redroidService.__tickOnceHealth();
    const bat = t.redroidMock.exec.battery;
    assert.equal(bat.present, true, 'replay must restore present (level-only drift never would)');
    assert.equal(bat.status, expected.status, 'replay must restore the story status');
    assert.equal(bat.level, expected.level, 'replay must restore the drifted level');

    // The replay was the FULL story script, not the level-only drift script.
    const calls = batteryScriptCalls(t.redroidMock);
    assert.ok(countOf(calls, 'STEALTH') >= 2, `provisioning + replay story execs: ${calls}`);

    // Steady state: the next sweep reads back clean → zero NEW story/drift
    // execs (readback-only rides each tick by design).
    const before = batteryScriptCalls(t.redroidMock);
    await t.app.redroidService.__tickOnceHealth();
    const after = batteryScriptCalls(t.redroidMock);
    assert.equal(countOf(after, 'STEALTH'), countOf(before, 'STEALTH'), 'steady sweep must not re-run the story');
    assert.equal(countOf(after, 'DRIFT'), countOf(before, 'DRIFT'), 'steady sweep must not move the level');
    assert.ok(countOf(after, 'READBACK') > countOf(before, 'READBACK'), 'every tick carries the readback probe');
  } finally { await t.close(); }
});

test('RESCAN S1: partial wipe (level survives, status/present wiped) is still caught', async () => {
  const t = await makeApp();
  try {
    const name = 'redroid-bat-race3';
    await createRunningDevice(t.app, t.cookie, name);
    assert.ok(await waitFor(() => t.redroidMock.exec.battery.present === true), 'story provisioned');
    const expected = buildStealthBatteryProfile({ seed: name });

    // The nasty shape the pre-RESCAN map missed: level happens to match the
    // planned value, but status/present are wiped → level-only drift says
    // "steady" and the app surface reads a CHARGING phone with no battery.
    const bat = t.redroidMock.exec.battery;
    bat.status = 1;
    bat.present = false;

    await t.app.redroidService.__tickOnceHealth();
    assert.equal(bat.present, true);
    assert.equal(bat.status, expected.status);
    assert.equal(bat.level, expected.level);
  } finally { await t.close(); }
});

test('RESCAN S1: readback exec failure degrades to level-only semantics (no replay spam)', async () => {
  const t = await makeApp();
  try {
    const name = 'redroid-bat-race4';
    await createRunningDevice(t.app, t.cookie, name);
    assert.ok(await waitFor(() => t.redroidMock.exec.battery.present === true), 'story provisioned');
    t.redroidMock.exec.resetBattery();
    // Force exec failures for one sweep (readback AND apply both fail):
    t.redroidMock.exec.set({ fail: true });
    await t.app.redroidService.__tickOnceHealth();
    assert.deepEqual(
      { level: t.redroidMock.exec.battery.level, status: t.redroidMock.exec.battery.status, present: t.redroidMock.exec.battery.present },
      { level: 0, status: 1, present: false },
      'a failed sweep must not corrupt device state',
    );
    // Recovery: exec back → the next sweep replays (never stuck).
    t.redroidMock.exec.set({});
    await t.app.redroidService.__tickOnceHealth();
    assert.equal(t.redroidMock.exec.battery.present, true, 'recovery sweep must restore the story');
  } finally { await t.close(); }
});
