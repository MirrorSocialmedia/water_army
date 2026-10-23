/**
 * P3 Fleet Console — pure layout/decision logic (MD §14 Phase 3:
 * "layout 1–5、slot count、全域上限、併發競爭、lazy start、單格關閉和全關閉").
 *
 * Kept DOM-free so it is hermetically unit-testable (same pattern as
 * lib/batch-ui.js). The React page (pages/FleetConsole.jsx) is a thin
 * renderer over these functions.
 */

/** Hard global cap (MD §4.1 — MAX_CONCURRENT_DEVICE_STREAMS, server is
 *  authoritative; this is only the local pre-check that keeps the UI honest). */
export const MAX_FLEET_TILES = 5;

/**
 * Grid column count for n open tiles (MD §14 Phase 3 "layout 1–5").
 * 1→1 wide, 2→2, 3→3, 4→2×2, 5→3+2 rows.
 */
export function fleetColumns(n) {
  if (!Number.isFinite(n) || n <= 0) return 1;
  if (n === 1) return 1;
  if (n === 2) return 2;
  if (n === 3) return 3;
  if (n === 4) return 2;
  return 3;
}

/** 'n/max' slot text from the server usage payload (MD §14 Phase 3 slot count). */
export function slotText(usage) {
  if (!usage) return `?/${MAX_FLEET_TILES}`;
  return `${usage.active ?? 0}/${usage.max ?? MAX_FLEET_TILES}`;
}

/** Global cap reached? Prefers the server usage; falls back to local count. */
export function capReached(usage, openCount) {
  if (usage) return (usage.active ?? 0) >= (usage.max ?? MAX_FLEET_TILES);
  return openCount >= MAX_FLEET_TILES;
}

/** Lease mode for the current user on any fleet tile. */
export function tileModeFor(user) {
  return ['admin', 'operator'].includes(user?.role) ? 'controller' : 'viewer';
}

/**
 * Can this device's tile be opened right now?
 * Returns { ok, reason } — reason ∈ null | 'device-not-running' |
 * 'already-open' | 'cap-reached'. (Server remains authoritative: the real
 * 409 STREAM_CAPACITY_REACHED / STREAM_DEVICE_HELD still lands here and is
 * rendered as the tile's error state.)
 */
export function canOpenTile({ device, openIds, usage, openCount }) {
  if (!device || device.containerState !== 'running') {
    return { ok: false, reason: 'device-not-running' };
  }
  if (openIds.includes(device.id)) return { ok: false, reason: 'already-open' };
  if (capReached(usage, openCount)) return { ok: false, reason: 'cap-reached' };
  return { ok: true, reason: null };
}

/**
 * Per-tile stream-source label (MD §3.2 tile info + ADR-020 degrade display).
 */
export function sourceLabel(stats) {
  if (!stats?.source) return 'not ready';
  if (stats.source === 'scrcpy') return 'scrcpy H.264';
  return stats.degraded ? `screencap (degraded: ${stats.degradeReason ?? 'reason unknown'})` : 'screencap PNG (default — ADR-020)';
}

/** 'last frame <1s / Ns ago / stalled' — the MD §3.2 last-frame time. */
export function lastFrameLabel(stats, now = Date.now()) {
  if (!stats?.lastFrameAt) return '—';
  const age = now - stats.lastFrameAt;
  if (age < 1000) return '<1s';
  if (age < 60_000) return `${Math.round(age / 1000)}s ago`;
  return 'stalled';
}
