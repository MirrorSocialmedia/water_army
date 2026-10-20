/**
 * Shared helpers for the Redroid devices pages (P5 — MD §6.4).
 * Pure functions only — no React, trivially testable.
 *
 * The single most important rule encoded here (MD §2.4 / 工單 硬驗收 6):
 * `gpuStatus` is HONEST — 'verified' can only ever come from the backend
 * after an in-device render check, and P5 never emits it. The UI must show
 * 未驗證 (unverified) / software exactly as reported — never a prettier word.
 */

/** gpuStatus → { label, cls } (labels are deliberately un-pretty). */
export function gpuStatusBadge(status) {
  switch (String(status ?? 'unknown').toLowerCase()) {
    case 'verified':
      return { label: 'verified', cls: 'pill-up' };
    case 'unverified':
      return { label: '未驗證 (unverified)', cls: 'pill-disabled' };
    case 'software':
      return { label: 'software / 降級', cls: 'pill' };
    default:
      return { label: 'unknown', cls: 'pill' };
  }
}

/** adbState → badge. 'unknown'/null = 未檢查 (never implied-healthy). */
export function adbStateBadge(state) {
  const s = String(state ?? 'unknown').toLowerCase();
  if (s === 'online') return { label: 'online', cls: 'pill-up' };
  if (s === 'offline') return { label: 'offline', cls: 'pill-down' };
  return { label: '未檢查', cls: 'pill' };
}

/**
 * Diagnostics zone status → badge.
 * A zone that was NOT executed is ALWAYS '未驗證' (executed=false) — the
 * badge says so explicitly; it is never rendered as a pass.
 */
export function zoneBadge(zone) {
  if (!zone || zone.executed === false) {
    return { label: '未驗證 (not executed)', cls: 'pill' };
  }
  const s = String(zone.status ?? 'unknown').toLowerCase();
  if (s === 'supported' || s === 'ok' || s === 'online') return { label: s, cls: 'pill-up' };
  if (s === 'unsupported' || s === 'error' || s === 'offline') return { label: s, cls: 'pill-down' };
  if (s === 'software') return { label: 'software / 降級', cls: 'pill' };
  return { label: s === 'unknown' ? '未驗證 (unknown)' : s, cls: 'pill-disabled' };
}

/** Which lifecycle buttons apply for a device's container state (UX only — the API is idempotent + authoritative). */
export function deviceActionsForState(state) {
  const s = String(state ?? 'unknown').toLowerCase();
  const running = s === 'running';
  return {
    start: !running,
    stop: running,
    restart: running,
    diagnostics: s !== 'missing',
    delete: true,
  };
}

/** ADB port display — the UI must always say localhost-only (MD §1.2). */
export function adbPortLabel(port, bind) {
  const addr = bind || '127.0.0.1';
  return `${addr}:${port}`;
}

// ---------------------------------------------------------------------------
// R4 (repair MD §6.3): network state badges.
//
// Rules (the UI's honesty contract for network health):
//  - EVERY state has a TEXT label (not just a colour); the badge text IS the
//    state machine state (STOPPED/STARTING/VERIFYING/HEALTHY/DEGRADED/
//    BLOCKED/FAILED) or STALE.
//  - A stale HEALTHY (lastSuccessfulCheckAt older than the TTL) is shown as
//    STALE and treated as UNHEALTHY — never a green badge (old legacy bug).
//  - "recovering" (VERIFYING / recovery in flight) is shown as such, never
//    green.
//  - `dispatch` mirrors the worker gate exactly (networkReady) so the
//    console and the task dispatcher can never disagree.
// `net` = the authoritative API payload (device.proxy.network =
// buildNetPayload). `null` = no egress proxy bound to this device.
// ---------------------------------------------------------------------------

const NET_STATE_TEXT = Object.freeze({
  HEALTHY: 'HEALTHY (network verified)',
  DEGRADED: 'DEGRADED (soft failure — fail-closed)',
  BLOCKED: 'BLOCKED (hard failure — fail-closed)',
  FAILED: 'FAILED (manual intervention required)',
  VERIFYING: 'VERIFYING (recovering — not usable yet)',
  STARTING: 'STARTING (provisioning)',
  STOPPED: 'STOPPED (no active network)',
});

/**
 * @param {object|null} net buildNetPayload() result (or null = no proxy).
 * @returns {{label:string, cls:string, dispatch:'ALLOWED'|'BLOCKED', state:string}}
 */
export function netStateBadge(net) {
  if (!net || typeof net !== 'object') {
    return { label: 'no egress proxy', cls: 'pill', dispatch: 'BLOCKED', state: 'NONE' };
  }
  const state = String(net.state ?? 'STOPPED').toUpperCase();
  // Fail-closed display: a stale check is NEVER shown as healthy, no matter
  // what the stored state says (MD §6.3: 過期 = STALE 或按不健康).
  if (net.stale === true) {
    return { label: 'STALE (last check expired)', cls: 'pill-down', dispatch: 'BLOCKED', state };
  }
  const cls = state === 'HEALTHY' ? 'pill-up'
    : (state === 'DEGRADED' || state === 'VERIFYING') ? 'pill-disabled'
    : (state === 'BLOCKED' || state === 'FAILED') ? 'pill-down'
    : 'pill';
  return {
    label: NET_STATE_TEXT[state] ?? `UNKNOWN (${state})`,
    cls,
    dispatch: net.networkReady === true ? 'ALLOWED' : 'BLOCKED',
    state,
  };
}

/**
 * One MD §6.2 per-check value (PASS/FAIL/UNKNOWN) → badge. Free-text is
 * never rendered; anything unexpected degrades to UNKNOWN (fail-closed).
 * @param {string|undefined|null} value
 * @returns {{label:string, cls:string}}
 */
export function netCheckBadge(value) {
  const v = String(value ?? 'UNKNOWN').toUpperCase();
  if (v === 'PASS') return { label: 'PASS', cls: 'pill-up' };
  if (v === 'FAIL') return { label: 'FAIL', cls: 'pill-down' };
  return { label: 'UNKNOWN', cls: 'pill' };
}
