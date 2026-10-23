/**
 * P3 Fleet Console — hermetic unit tests for lib/fleet-ui.js
 * (MD §14 Phase 3: layout 1–5, slot count, global cap, lazy start
 * pre-checks, single-tile / close-all decisions).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_FLEET_TILES,
  fleetColumns,
  slotText,
  capReached,
  tileModeFor,
  canOpenTile,
  sourceLabel,
  lastFrameLabel,
} from '../../apps/web/src/lib/fleet-ui.js';

const DEV = (id, containerState = 'running') => ({ id, name: `dev-${id}`, containerState });
const RUNNING = [DEV('a'), DEV('b'), DEV('c'), DEV('d'), DEV('e')];
const OPEN = (n) => RUNNING.slice(0, n).map((d) => d.id);

// ------------------------------------------------------------- layout 1–5 ---
test('fleetColumns: the MD §14 Phase 3 "layout 1–5" grid shape', () => {
  assert.equal(fleetColumns(0), 1); // empty grid → single column
  assert.equal(fleetColumns(1), 1); // one wide tile
  assert.equal(fleetColumns(2), 2);
  assert.equal(fleetColumns(3), 3);
  assert.equal(fleetColumns(4), 2); // 2×2
  assert.equal(fleetColumns(5), 3); // 3 + 2 rows
  assert.equal(fleetColumns(6), 3); // never more than the cap shape
  assert.equal(fleetColumns(null), 1);
  assert.equal(fleetColumns(NaN), 1);
});

test('global cap is exactly 5 (MD §4.1)', () => {
  assert.equal(MAX_FLEET_TILES, 5);
});

// ------------------------------------------------------------- slot count ---
test('slotText renders n/max from the server usage payload', () => {
  assert.equal(slotText(null), '?/5');
  assert.equal(slotText({ active: 0, max: 5 }), '0/5');
  assert.equal(slotText({ active: 5, max: 5 }), '5/5');
  assert.equal(slotText({ active: 3 }), '3/5');
});

test('capReached prefers server usage over the local tile count', () => {
  assert.equal(capReached(null, 5), true); // local fallback at 5 tiles
  assert.equal(capReached(null, 4), false);
  assert.equal(capReached({ active: 4, max: 5 }, 0), false);
  assert.equal(capReached({ active: 5, max: 5 }, 0), true);
  // server truth wins even when the local count lies (other operators):
  assert.equal(capReached({ active: 5, max: 5 }, 1), true);
});

// ------------------------------------------------------------------- RBAC ---
test('tileModeFor: only admin/operator get controller leases', () => {
  assert.equal(tileModeFor({ role: 'admin' }), 'controller');
  assert.equal(tileModeFor({ role: 'operator' }), 'controller');
  assert.equal(tileModeFor({ role: 'viewer' }), 'viewer');
  assert.equal(tileModeFor(null), 'viewer');
});

// ------------------------------------------------------------ canOpenTile ---
test('canOpenTile: running device, cap, and already-open rules', () => {
  assert.deepEqual(canOpenTile({ device: DEV('a'), openIds: [], usage: { active: 0, max: 5 }, openCount: 0 }), { ok: true, reason: null });
  assert.equal(canOpenTile({ device: DEV('a', 'stopped'), openIds: [], usage: null, openCount: 0 }).reason, 'device-not-running');
  assert.equal(canOpenTile({ device: DEV('a'), openIds: ['a'], usage: null, openCount: 1 }).reason, 'already-open');
  // cap via server usage (the 5th slot belongs to another operator — only 4
  // local tiles, but the new device is refused because the server says 5/5):
  assert.equal(canOpenTile({ device: DEV('f'), openIds: OPEN(4), usage: { active: 5, max: 5 }, openCount: 4 }).reason, 'cap-reached');
  // local pre-check (no usage yet) still refuses a 6th local tile:
  assert.equal(canOpenTile({ device: DEV('f'), openIds: OPEN(5), usage: null, openCount: 5 }).reason, 'cap-reached');
});

// ------------------------------------------------------------- tile labels --
test('sourceLabel: ADR-020 default/degrade wording', () => {
  assert.equal(sourceLabel({}), 'not ready');
  assert.equal(sourceLabel({ source: 'scrcpy' }), 'scrcpy H.264');
  assert.equal(sourceLabel({ source: 'screencap' }), 'screencap PNG (default — ADR-020)');
  assert.equal(sourceLabel({ source: 'screencap', degraded: true, degradeReason: 'gralloc missing' }), 'screencap (degraded: gralloc missing)');
});

test('lastFrameLabel: <1s / Ns ago / stalled', () => {
  const now = 1_000_000;
  assert.equal(lastFrameLabel({}, now), '—');
  assert.equal(lastFrameLabel({ lastFrameAt: now - 500 }, now), '<1s');
  assert.equal(lastFrameLabel({ lastFrameAt: now - 12_000 }, now), '12s ago');
  assert.equal(lastFrameLabel({ lastFrameAt: now - 120_000 }, now), 'stalled');
});
