/**
 * WA-RESCAN (2026-10-30) unit tests — S1 battery wipe-race helpers +
 * S2 Chrome WebRTC carrier. Fixtures for the battery parse are the REAL
 * fx-2 dumps (docs/audits/fix2b/redroid-rdev-fx-2-battery.txt): default
 * pre-override state (status:1 / present:false / level:0) and the
 * post-override state (UPDATES STOPPED block, status:3 / present:true /
 * level:46) — parser behaviour is pinned to the device format, not an
 * imagined one.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBatteryReadbackScript, BATTERY_READBACK_MARKER, parseBatteryReadback,
  batteryStoryNeedsReplay, buildStealthBatteryProfile, buildStealthBatteryScript,
  BATTERY_STEALTH_MARKER, BATTERY_DRIFT_MARKER,
} from '../../packages/shared/src/stealth-battery.js';

// Real fx-2 dump, pre-override container defaults (CRLF as the device emits).
const FX2_DEFAULT = [
  'Current Battery Service state:',
  '  AC powered: false',
  '  USB powered: false',
  '  Wireless powered: false',
  '  Dock powered: false',
  '  Max charging current: 0',
  '  Max charging voltage: 0',
  '  Charge counter: 0',
  '  status: 1',
  '  health: 1',
  '  present: false',
  '  level: 0',
  '  scale: 100',
  '  voltage: 0',
  '  temperature: 0',
  '  technology: ',
].join('\r\n') + '\r\n';

// Real fx-2 dump, post-override (the second block under UPDATES STOPPED).
const FX2_OVERRIDDEN = `${FX2_DEFAULT.replace('status: 1', 'status: 3').replace('present: false', 'present: true').replace('level: 0', 'level: 46')}`;

describe('RESCAN S1: battery readback script', () => {
  test('fixed argv, dumpsys + CR strip + marker', () => {
    const s = buildBatteryReadbackScript();
    assert.ok(s.includes('dumpsys battery'));
    assert.ok(s.includes("tr -d '\\r'"));
    assert.ok(s.endsWith(`echo ${BATTERY_READBACK_MARKER}`));
    // fixed-argv discipline: no expansions, no chaining beyond the ONE
    // documented pipe (same rule as every other battery builder).
    assert.ok(!/[$`]|&&|\|\|/.test(s));
    assert.equal((s.match(/\|/g) ?? []).length, 1);
  });
});

describe('RESCAN S1: parseBatteryReadback (fx-2 real dumps)', () => {
  test('defaults dump → status 1 / present false / level 0', () => {
    assert.deepEqual(parseBatteryReadback(FX2_DEFAULT), { level: 0, status: 1, present: false });
  });
  test('overridden dump → status 3 / present true / level 46', () => {
    assert.deepEqual(parseBatteryReadback(FX2_OVERRIDDEN), { level: 46, status: 3, present: true });
  });
  test('two blocks (UPDATES STOPPED repeats the keys) → LAST occurrence wins', () => {
    const twoBlocks = `${FX2_DEFAULT}\nCurrent Battery Service state:\n  (UPDATES STOPPED -- use 'reset' to restart)\n${FX2_OVERRIDDEN}`;
    assert.deepEqual(parseBatteryReadback(twoBlocks), { level: 46, status: 3, present: true });
  });
  test('LF-only input parses identically (tr already applied)', () => {
    const lf = FX2_OVERRIDDEN.replace(/\r\n/g, '\n');
    assert.deepEqual(parseBatteryReadback(lf), { level: 46, status: 3, present: true });
  });
  test('garbage / empty → all null (caller treats as story-absent)', () => {
    assert.deepEqual(parseBatteryReadback(''), { level: null, status: null, present: null });
    assert.deepEqual(parseBatteryReadback('root 4444 1 0 10:00:00 ? tun2socks'), { level: null, status: null, present: null });
  });
  test('never confuses "Max charging current" style lines with the knobs', () => {
    // The real dump has no 'level:'/'status:' collision, but pin the
    // anchored-match rule anyway: an indented bare key is required.
    assert.deepEqual(parseBatteryReadback('batteryLevel: 99\nstatus: 2\nlevel: 51\npresent: true'), { level: 51, status: 2, present: true });
  });
});

describe('RESCAN S1: batteryStoryNeedsReplay (wipe detection)', () => {
  const profile = { level: 77, status: 3 };
  const story = { level: 77, status: 3, present: true };
  test('story-consistent readback → no replay', () => {
    assert.equal(batteryStoryNeedsReplay({ profile, plannedLevel: 77, readback: story }), false);
  });
  test('drifted target (planned < applied) → replay even if knobs present', () => {
    assert.equal(batteryStoryNeedsReplay({ profile, plannedLevel: 74, readback: story }), true);
  });
  test('wiped defaults → replay', () => {
    assert.equal(batteryStoryNeedsReplay({ profile, plannedLevel: 77, readback: { level: 0, status: 1, present: false } }), true);
  });
  test('level right but status/present wiped → replay (level-only drift would MISS this)', () => {
    assert.equal(batteryStoryNeedsReplay({ profile, plannedLevel: 77, readback: { level: 77, status: 1, present: false } }), true);
  });
  test('unparseable (nulls) → replay, never silent-OK', () => {
    assert.equal(batteryStoryNeedsReplay({ profile, plannedLevel: 77, readback: { level: null, status: null, present: null } }), true);
    assert.equal(batteryStoryNeedsReplay({ profile, plannedLevel: 77, readback: null }), true);
  });
  test('end-to-end race shape: wipe → replay(full story at drifted level) → readback clean', () => {
    const prof = buildStealthBatteryProfile({ seed: 'rescan-race' });
    const planned = 61; // pretend the drift clock says 61
    // device wiped to defaults:
    const wipedReadback = { level: 0, status: 1, present: false };
    assert.equal(batteryStoryNeedsReplay({ profile: prof, plannedLevel: planned, readback: wipedReadback }), true);
    // replay = the FULL story script, level carried at the drifted value:
    const script = buildStealthBatteryScript({ level: planned, status: prof.status });
    assert.ok(script.includes(`dumpsys battery set level ${planned}`));
    assert.ok(script.includes(`dumpsys battery set status ${prof.status}`));
    assert.ok(script.includes('dumpsys battery set present 1'));
    assert.ok(script.includes(`echo ${BATTERY_STEALTH_MARKER}`));
    // after replay the device reads story-consistent:
    const after = { level: planned, status: prof.status, present: true };
    assert.equal(batteryStoryNeedsReplay({ profile: prof, plannedLevel: planned, readback: after }), false);
    // markers stay distinct (mock dispatch relies on it):
    assert.notEqual(BATTERY_STEALTH_MARKER, BATTERY_DRIFT_MARKER);
    assert.notEqual(BATTERY_STEALTH_MARKER, BATTERY_READBACK_MARKER);
    assert.notEqual(BATTERY_DRIFT_MARKER, BATTERY_READBACK_MARKER);
  });
});

