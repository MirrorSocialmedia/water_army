/**
 * Batch Rotation UI — pure presentation logic (BR-B5, MD §11/§12/§13).
 *
 * Kept JSX-free on purpose: it is unit-tested with plain `node --test`
 * (the repo has no frontend test toolchain — see P0 ADR lockfile rule),
 * and the pages are thin renderers over these functions.
 */
import { planCycle } from '@water-army/shared/batch-constants';

// ------------------------------------------------------------------ pills ---
/** Batch status → pill class (MD §3.2 batch state machine). */
export const BATCH_STATUS_PILL = {
  PLANNED: 'pill-disabled',
  RUNNING: 'pill-up',
  PAUSED: 'pill-disabled',
  COMPLETED: 'pill-up',
  COMPLETED_WITH_ERRORS: 'pill-down',
  CANCELLED: 'pill-disabled',
};

/** Task-run status → pill class (MD §6.2 run state machine). */
export const RUN_STATUS_PILL = {
  queued: 'pill-disabled',
  needs_approval: 'pill-disabled',
  running: 'pill-up',
  cancel_requested: 'pill-disabled',
  succeeded: 'pill-up',
  failed: 'pill-down',
  timed_out: 'pill-down',
  cancelled: 'pill-disabled',
  unknown: 'pill-disabled',
};

/** Identity status → pill class (MD §6.1 identity state machine). */
export const IDENTITY_PILL = {
  READY: 'pill-up',
  RUNNING: 'pill-up',
  RESERVED: 'pill-up',
  RETRY_WAIT: 'pill-disabled',
  RECOVERING: 'pill-disabled',
  CANCELLING: 'pill-disabled',
  COMPLETED: 'pill-up',
  SKIPPED: 'pill-disabled',
  CANCELLED: 'pill-disabled',
  FAILED_FINAL: 'pill-down',
  DISABLED: 'pill-down',
};

/** T2 (ADR-029) — identity login-state pill colours (client mirror). */
export const LOGIN_STATE_PILL = {
  PENDING_LOGIN: 'pill-disabled',
  CONFIRMED_LOGGED_IN: 'pill-up',
  RELOGIN_REQUIRED: 'pill-down',
  LOGGED_OUT: 'pill-disabled',
};

/**
 * Client-side mirror of the fail-closed transition matrix in
 * apps/api/src/services/login-state-service.js — keep the two in sync
 * (unit tests pin the server matrix; this map only drives button
 * visibility, the server is always the authority and 409s anything else).
 */
export const LOGIN_TRANSITIONS_UI = {
  PENDING_LOGIN: ['CONFIRMED_LOGGED_IN', 'LOGGED_OUT'],
  CONFIRMED_LOGGED_IN: ['RELOGIN_REQUIRED', 'LOGGED_OUT'],
  RELOGIN_REQUIRED: ['CONFIRMED_LOGGED_IN', 'PENDING_LOGIN', 'LOGGED_OUT'],
  LOGGED_OUT: ['PENDING_LOGIN'],
};

/** Operator-facing labels for manual login transitions (ADR-029 manual flow). */
export const LOGIN_TRANSITION_LABELS = {
  CONFIRMED_LOGGED_IN: '已確認登入',
  RELOGIN_REQUIRED: '需重新驗證',
  PENDING_LOGIN: '標記待登入',
  LOGGED_OUT: '標記已登出',
};

/** Cycle status (derived by the API) → pill class. */
export const CYCLE_STATUS_PILL = {
  PLANNED: 'pill-disabled',
  RUNNING: 'pill-up',
  PAUSED: 'pill-disabled',
  COMPLETED: 'pill-up',
  COMPLETED_WITH_ERRORS: 'pill-down',
  CANCELLED: 'pill-disabled',
};

export function pillClass(map, status) {
  return map[status] ?? 'pill-disabled';
}

// ------------------------------------------------------------------- RBAC ---
/**
 * UI capability matrix (MD §12): Viewer = read + masked data only; Operator =
 * run approved work (control + export); Admin = everything here (policy /
 * allowlist changes live in Settings, not on these pages).
 */
export function can(role, action) {
  const isOp = role === 'operator' || role === 'admin';
  switch (action) {
    case 'view':
      return role === 'viewer' || isOp;
    case 'pause':
    case 'resume':
    case 'cancel':
    case 'start':
    case 'retry':
    case 'create':
      return isOp;
    case 'export':
      return isOp;
    default:
      return false;
  }
}

// ----------------------------------------------------------------- format ---
/** null-safe ISO → HH:MM:SS (host-local display; no secret/PII in dates). */
export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour12: false });
}

/** null-safe ISO → YYYY-MM-DD HH:MM. */
export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Byte count → human (B/KB/MB/GB), null-safe. */
export function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  const shown = v >= 100 || u === 0 ? Math.round(v) : Number.isInteger(v) ? v : v.toFixed(1);
  return `${shown} ${units[u]}`;
}

/** Milliseconds → human duration, null-safe. */
export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Age of an instant relative to now — "3m ago", null-safe. */
export function fmtAge(iso, nowMs = Date.now()) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const age = Math.max(0, nowMs - t);
  const s = Math.floor(age / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Truncate an id for compact display (stable prefix — MD §11.3 stable ID). */
export function shortId(id, n = 8) {
  return id ? String(id).slice(0, n) : '—';
}

// ----------------------------------------------------------------- planner --
/**
 * Client-side plan preview from REAL read data (GET /api/identities + the
 * configured capacity) — used while POST /api/batches/preview (B2) is not
 * yet on main, and as the fallback when it 404s. Same math as the shared
 * planner (planCycle), so the numbers match B2's server-side preview.
 *
 * @returns {{ok:boolean, total:number, ready:number, skippedDisabled:number,
 *            skippedOther:number, batchCount:number, perBatch:number[],
 *            estimatedContainers:number, peakConcurrent:number, error?:string}}
 */
export function summarizePlan(identities, { batchSize, maxActiveContainers }) {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    return { ok: false, error: 'Batch size must be an integer ≥ 1' };
  }
  const list = Array.isArray(identities) ? identities : [];
  if (!list.length) return { ok: true, total: 0, ready: 0, skippedDisabled: 0, skippedOther: 0, batchCount: 0, perBatch: [], estimatedContainers: 0, peakConcurrent: 0 };
  try {
    const plan = planCycle({ identities: list, batchSize });
    const perBatch = plan.batches.map((b) => b.size);
    const flat = plan.batches.flatMap((b) => b.members);
    const skippedDisabled = flat.filter((m) => m.state === 'SKIPPED' && m.skipReason === 'identity disabled').length;
    const skippedOther = plan.stats.skipped - skippedDisabled;
    const ready = plan.stats.included;
    const cap = Number.isInteger(maxActiveContainers) && maxActiveContainers >= 1 ? maxActiveContainers : null;
    return {
      ok: true,
      total: list.length,
      ready,
      skippedDisabled,
      skippedOther,
      batchCount: plan.batches.length,
      perBatch,
      // every READY identity gets one container during the cycle
      estimatedContainers: ready,
      // steady-state concurrency = the cap (or the batch size when uncapped)
      peakConcurrent: cap ? Math.min(cap, Math.max(1, Math.max(...perBatch, 0))) : Math.max(...perBatch),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------- monitor ---
/** Derive the per-row highlight flags the monitor uses for banners/outline. */
export function taskFlags(task) {
  return {
    stuck: Boolean(task?.stuck),
    unknown: Boolean(task?.unknown),
    failed: task?.status === 'failed' || task?.status === 'timed_out',
  };
}

/** Alert severity → banner class. */
export function alertClass(alert) {
  return alert?.severity === 'critical' ? 'alert-banner critical' : 'alert-banner warning';
}

/** Host health verdict for a metric (null-safe, threshold from the API). */
export function hostHealth(host, diskLowBytes) {
  const out = { memory: 'unknown', disk: 'unknown' };
  if (!host) return out;
  if (Number.isFinite(host.memoryAvailableBytes)) {
    const total = Number.isFinite(host.memoryTotalBytes) && host.memoryTotalBytes > 0 ? host.memoryTotalBytes : 0;
    out.memory = total && host.memoryAvailableBytes / total < 0.1 ? 'low' : 'ok';
  }
  if (Number.isFinite(host.diskAvailableBytes)) {
    const low = Number.isFinite(diskLowBytes) ? diskLowBytes : 1024 * 1024 * 1024;
    out.disk = host.diskAvailableBytes < low ? 'low' : 'ok';
  }
  return out;
}

// ----------------------------------------------------------------- report ---
/** Export formats the report page offers (MD §11.4). */
export const REPORT_FORMATS = [
  { id: 'json', label: 'JSON' },
  { id: 'csv', label: 'CSV' },
];

/**
 * A cycle is exportable once all its batches are terminal (the API 409s
 * otherwise when ?requireTerminal=1 — we surface the flag to the UI).
 */
export function cycleExportable(cycle) {
  return cycle?.status === 'COMPLETED' || cycle?.status === 'COMPLETED_WITH_ERRORS' || cycle?.status === 'CANCELLED';
}
