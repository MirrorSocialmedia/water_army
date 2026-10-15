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
