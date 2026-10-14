/**
 * Shared helpers for the Docker container pages (P2 — MD §6.2/§6.3).
 * Pure functions only — no React, so they stay trivially testable.
 */

/**
 * Which state-mutation buttons are applicable for a given container state.
 * (MD §6.2: 按容器狀態禁用不適用操作. The API is idempotent — disabling is
 * UX, not a safety boundary.)
 */
export function actionsForState(state) {
  const s = String(state ?? 'unknown').toLowerCase();
  const running = s === 'running' || s === 'restarting';
  const paused = s === 'paused';
  return {
    start: ['created', 'exited', 'dead'].includes(s),
    stop: running || paused,
    restart: running || paused,
    pause: s === 'running',
    unpause: paused,
  };
}

export function formatBytes(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const bytes = Number(n);
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatPct(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return `${Number(v).toFixed(1)}%`;
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

/** Compact 'x min ago' style, falling back to the full date. */
export function timeAgo(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  if (secs < 86400 * 7) return `${Math.floor(secs / 86400)} d ago`;
  return d.toLocaleDateString();
}

export const STATE_BADGE = {
  running: 'state-running',
  restarting: 'state-running',
  paused: 'state-paused',
  created: 'state-created',
  exited: 'state-exited',
  dead: 'state-dead',
  removing: 'state-exited',
};

export function stateBadgeClass(state) {
  return STATE_BADGE[String(state ?? '').toLowerCase()] ?? 'state-unknown';
}
