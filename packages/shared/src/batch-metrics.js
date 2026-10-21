/**
 * Batch Rotation metrics + alert evaluation (BR-B5, 施工 MD §13).
 *
 * The repo has no Prometheus — the established monitoring convention is a
 * queryable summary endpoint + structured pino logs (see routes/dashboard.js).
 * This module is the PURE core of that convention for batch rotation:
 * every metric below is computed from DB-derived rows + host probes that are
 * INJECTED by the API service (packages: api fetches, this file computes),
 * so unit tests run hermetically with fakes.
 *
 * Metric semantics (documented per MD §13 names):
 *  - batch_active_count        batches currently RUNNING
 *  - batch_queued_count        batches PLANNED (created, not yet started)
 *  - batch_failed_count        batches in a failure state: PAUSED (a manual
 *                              pause is indistinguishable at batch level — the
 *                              pause state_event carries the reason) or
 *                              COMPLETED_WITH_ERRORS
 *  - active_containers         running app-managed containers (batch labels
 *                              preferred); null when Docker is unavailable
 *  - container_start_duration_seconds  stats over state_events details that
 *                              carry startDurationMs (B2/B3 write seam); null
 *                              when no events exist yet
 *  - task_run_duration_seconds stats over finished batch task_runs (durationMs)
 *  - task_retry_total          batch runs that needed >1 attempt (attempt > 1)
 *  - task_timeout_total        batch runs that ended TIMED_OUT
 *  - worker_heartbeat_age_seconds  OLDEST heartbeat age over ACTIVE batch runs
 *                              (queued/running/needs_approval/cancel_requested);
 *                              null when no active runs
 *  - expired_lease_total       resource_leases past lease_expires_at (not yet
 *                              reaped — reconciliation lag indicator)
 *  - host_memory_available_bytes   os.freemem() on the API host
 *  - host_disk_available_bytes     statfs on the data root (WA_METRICS_DISK_PATH)
 *  - network_policy_denied_total   batch runs failed by the network GATE with an
 *                              explicit deny code (NETWORK_TARGET_DENIED /
 *                              BAD_SCHEME / BAD_TARGET / BLOCKED_IP /
 *                              RESOLUTION_FAILED) — cumulative
 *  - network_health_failures_total batch runs failed fail-closed because the
 *                              policy was UNAVAILABLE (NETWORK_POLICY_UNAVAILABLE)
 *                              — cumulative (MD §5.1 fail-closed sentinel)
 *
 * Alerts (MD §13 conditions) are evaluated by `evaluateAlerts` as a pure
 * function; the API service adds the `since` bookkeeping + pino/audit side
 * effects (no alert channel exists in this repo — documented in runbook).
 */

/** The 14 MD §13 metric names — the contract the UI/tests assert against. */
export const BATCH_METRIC_NAMES = Object.freeze([
  'batch_active_count',
  'batch_queued_count',
  'batch_failed_count',
  'active_containers',
  'container_start_duration_seconds',
  'task_run_duration_seconds',
  'task_retry_total',
  'task_timeout_total',
  'worker_heartbeat_age_seconds',
  'expired_lease_total',
  'host_memory_available_bytes',
  'host_disk_available_bytes',
  'network_policy_denied_total',
  'network_health_failures_total',
]);

/** Network GATE deny codes (explicit denial — distinct from fail-closed unavailable). */
const NETWORK_DENY_CODES = new Set([
  'NETWORK_TARGET_DENIED',
  'NETWORK_BAD_SCHEME',
  'NETWORK_BAD_TARGET',
  'NETWORK_BLOCKED_IP',
  'NETWORK_RESOLUTION_FAILED',
]);
/** Fail-closed sentinel: policy unavailable (MD §5.1 — never fall back). */
const NETWORK_UNAVAILABLE_CODE = 'NETWORK_POLICY_UNAVAILABLE';

/** Runs that "own" an identity right now (heartbeat/age semantics). */
const ACTIVE_RUN_STATUSES = new Set(['queued', 'running', 'needs_approval', 'cancel_requested']);
const TIMED_OUT_STATUS = 'timed_out';
const UNKNOWN_STATUSES = new Set(['unknown']);
/** Container START failures (heuristic for the start-failure-streak alert). */
const START_FAILURE_CODE_PREFIXES = ['CONTAINER_', 'DOCKER_'];

export const DEFAULT_ALERT_LIMITS = Object.freeze({
  /** active containers above this → BATCH_ACTIVE_OVER_LIMIT (critical). */
  globalMaxActiveContainers: 50,
  /** active run with NO heartbeat at all → WORKER_HEARTBEAT_STALE (critical);
   *  age > this (ms) → same alert (warning). */
  workerHeartbeatStaleMs: 120_000,
  /** host disk below this → DISK_LOW (critical). */
  diskAvailableBytesFloor: 1 << 30, // 1 GiB
  /** >= this many container start failures within the window →
   *  CONTAINER_START_FAILURE_STREAK (warning). */
  startFailureStreak: 3,
  startFailureWindowMs: 10 * 60_000,
  /** a run sitting in UNKNOWN longer than this → TASK_UNKNOWN_PERSISTENT (warning). */
  unknownStaleMs: 5 * 60_000,
  /** NETWORK_POLICY_UNAVAILABLE runs within this window →
   *  NETWORK_POLICY_UNAVAILABLE alert (critical). */
  networkUnavailableWindowMs: 10 * 60_000,
});

/**
 * Summary of a duration series in seconds.
 * @param {number[]} msList durations in ms (any length; empty/undefined → null)
 * @returns {object|null} {count, meanSeconds, p50Seconds, p95Seconds, maxSeconds}
 */
export function durationStatsMs(msList) {
  if (!Array.isArray(msList) || msList.length === 0) return null;
  const ms = msList.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (ms.length === 0) return null;
  const sum = ms.reduce((a, b) => a + b, 0);
  const pct = (p) => {
    if (ms.length === 1) return ms[0];
    const idx = Math.min(ms.length - 1, Math.ceil(p * ms.length) - 1);
    return ms[Math.max(0, idx)];
  };
  return {
    count: ms.length,
    meanSeconds: round2(sum / ms.length / 1000),
    p50Seconds: round2(pct(0.5) / 1000),
    p95Seconds: round2(pct(0.95) / 1000),
    maxSeconds: round2(ms[ms.length - 1] / 1000),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Max concurrency observed from overlapping run intervals (MD §11.4 資源峰值).
 * Classic sweep-line; null when no finished interval exists.
 *
 * @param {Array<{startedAt:Date|null, finishedAt:Date|null}>} runs
 * @returns {number|null}
 */
export function maxConcurrentFromIntervals(runs) {
  const pts = [];
  for (const r of runs ?? []) {
    const s = r?.startedAt ? new Date(r.startedAt).getTime() : null;
    const f = r?.finishedAt ? new Date(r.finishedAt).getTime() : null;
    if (s == null || f == null || f < s) continue;
    pts.push([s, 1], [f, -1]);
  }
  if (pts.length === 0) return null;
  // sort by time; at equal time, endings (-1) before starts (+1) — a run that
  // finishes at T and another starting at T do NOT overlap.
  pts.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  let cur = 0;
  let peak = 0;
  for (const [, d] of pts) {
    cur += d;
    if (cur > peak) peak = cur;
  }
  return peak;
}

/**
 * Compute all 14 MD §13 metrics from injected inputs (pure — no I/O).
 *
 * @param {object} inputs
 * @param {Date|number} inputs.now
 * @param {Array<object>} inputs.batches all batch rows {id,status,cycleId,maxActiveContainers,startedAt,finishedAt}
 * @param {Array<object>} inputs.runs batch-linked task runs (status, attempt,
 *   durationMs, startedAt, finishedAt, heartbeatAt, errorCode, createdAt)
 * @param {number} inputs.expiredLeases
 * @param {number[]|null} inputs.startDurationsMs container start durations (state_event details seam) or null
 * @param {object|null} inputs.containers {available, running, total, orphans: string[]} (null = Docker unknown)
 * @param {object|null} inputs.host {memoryAvailableBytes, memoryTotalBytes, diskAvailableBytes, diskPath, cpuLoad1m, cpuLoad5m} (null = probe failed)
 * @param {object} [inputs.deps] {postgres:'up'|'down', redis:'up'|'down', docker:'up'|'down'|'disabled'}
 * @param {object} [inputs.limits] see DEFAULT_ALERT_LIMITS
 * @returns {{generatedAt:string, metrics:object, detail:object, alerts:Array}}
 */
export function computeBatchMetrics({
  now,
  batches = [],
  runs = [],
  expiredLeases = 0,
  startDurationsMs = null,
  containers = null,
  host = null,
  deps = null,
} = {}, limits = {}) {
  const t = new Date(now).getTime();
  const lim = { ...DEFAULT_ALERT_LIMITS, ...(limits ?? {}) };

  // ---- batch-level counts -------------------------------------------------
  const batchByStatus = {};
  for (const b of batches) batchByStatus[b.status] = (batchByStatus[b.status] ?? 0) + 1;
  const batchActive = batchByStatus.RUNNING ?? 0;
  const batchQueued = batchByStatus.PLANNED ?? 0;
  const batchFailed = (batchByStatus.PAUSED ?? 0) + (batchByStatus.COMPLETED_WITH_ERRORS ?? 0);

  // ---- run-level ----------------------------------------------------------
  const runByStatus = {};
  let retryTotal = 0;
  let timeoutTotal = 0;
  let netDenied = 0;
  let netUnavailable = 0;
  const startFailures = []; // {ts, code}
  let netUnavailableRecent = 0;

  for (const r of runs) {
    const s = r.status;
    runByStatus[s] = (runByStatus[s] ?? 0) + 1;
    if (Number(r.attempt ?? 1) > 1) retryTotal += 1;
    if (s === TIMED_OUT_STATUS) timeoutTotal += 1;

    const code = typeof r.errorCode === 'string' ? r.errorCode : '';
    if (NETWORK_DENY_CODES.has(code)) netDenied += 1;
    if (code === NETWORK_UNAVAILABLE_CODE) {
      netUnavailable += 1;
      if (recentWithin(t, r, lim.networkUnavailableWindowMs)) netUnavailableRecent += 1;
    }
    if (code && START_FAILURE_CODE_PREFIXES.some((p) => code.startsWith(p))) {
      startFailures.push({ ts: r.finishedAt ? new Date(r.finishedAt).getTime() : r.createdAt ? new Date(r.createdAt).getTime() : t, code });
    }
  }

  // ---- heartbeat age (active runs only) ------------------------------------
  let oldestAgeMs = null;
  let noHeartbeatActive = 0;
  let staleActive = 0;
  let activeRuns = 0;
  for (const r of runs) {
    if (!ACTIVE_RUN_STATUSES.has(r.status)) continue;
    activeRuns += 1;
    if (r.heartbeatAt == null) {
      noHeartbeatActive += 1;
      continue;
    }
    const age = t - new Date(r.heartbeatAt).getTime();
    if (age > lim.workerHeartbeatStaleMs) staleActive += 1;
    if (oldestAgeMs == null || age > oldestAgeMs) oldestAgeMs = age;
  }

  // ---- UNKNOWN persistence --------------------------------------------------
  let unknownStale = 0;
  for (const r of runs) {
    if (!UNKNOWN_STATUSES.has(r.status)) continue;
    const ref = r.updatedAt ? new Date(r.updatedAt).getTime() : r.createdAt ? new Date(r.createdAt).getTime() : t;
    if (t - ref > lim.unknownStaleMs) unknownStale += 1;
  }

  // ---- start-failure streak --------------------------------------------------
  const recentStartFailures = startFailures.filter((f) => t - f.ts <= lim.startFailureWindowMs).length;

  const metrics = {
    batch_active_count: batchActive,
    batch_queued_count: batchQueued,
    batch_failed_count: batchFailed,
    active_containers: containers?.available ? containers.running : null,
    container_start_duration_seconds: durationStatsMs(startDurationsMs),
    task_run_duration_seconds: durationStatsMs(runs.filter((r) => Number.isFinite(r.durationMs)).map((r) => r.durationMs)),
    task_retry_total: retryTotal,
    task_timeout_total: timeoutTotal,
    worker_heartbeat_age_seconds: oldestAgeMs == null ? null : Math.round(oldestAgeMs / 1000),
    expired_lease_total: Number(expiredLeases) || 0,
    host_memory_available_bytes: host?.memoryAvailableBytes ?? null,
    host_disk_available_bytes: host?.diskAvailableBytes ?? null,
    network_policy_denied_total: netDenied,
    network_health_failures_total: netUnavailable,
  };

  const detail = {
    batches: batchByStatus,
    runs: runByStatus,
    containers: containers
      ? { available: containers.available, running: containers.running, total: containers.total, orphans: containers.orphans ?? [] }
      : { available: false, running: null, total: null, orphans: [], reason: 'docker-unavailable' },
    host: host
      ? {
          cpuLoad1m: host.cpuLoad1m ?? null,
          cpuLoad5m: host.cpuLoad5m ?? null,
          memoryTotalBytes: host.memoryTotalBytes ?? null,
          memoryAvailableBytes: host.memoryAvailableBytes ?? null,
          diskPath: host.diskPath ?? null,
          diskAvailableBytes: host.diskAvailableBytes ?? null,
        }
      : { available: false, reason: 'host-probe-unavailable' },
    deps: deps ?? { postgres: 'unknown', redis: 'unknown', docker: 'unknown' },
    heartbeats: { activeRuns, noHeartbeat: noHeartbeatActive, stale: staleActive, oldestAgeSeconds: oldestAgeMs == null ? null : Math.round(oldestAgeMs / 1000) },
    network: { deniedByCode: networkDenyBreakdown(runs), unavailableRecent: netUnavailableRecent },
    startFailures: { recent: recentStartFailures, windowMs: lim.startFailureWindowMs },
    unknown: { stale: unknownStale, thresholdMs: lim.unknownStaleMs },
  };

  const alerts = evaluateAlerts(metrics, detail, { ...lim, expiredLeases: Number(expiredLeases) || 0 });
  return {
    generatedAt: new Date(t).toISOString(),
    metrics,
    detail,
    alerts,
  };
}

function networkDenyBreakdown(runs) {
  const out = {};
  for (const r of runs) {
    const code = typeof r.errorCode === 'string' ? r.errorCode : '';
    if (NETWORK_DENY_CODES.has(code)) out[code] = (out[code] ?? 0) + 1;
  }
  return out;
}

function recentWithin(t, run, windowMs) {
  const ref = run.finishedAt ? new Date(run.finishedAt).getTime() : run.updatedAt ? new Date(run.updatedAt).getTime() : run.createdAt ? new Date(run.createdAt).getTime() : t;
  return t - ref <= windowMs;
}

/**
 * Evaluate the MD §13 alert conditions (pure).
 * Returns [{id, severity:'critical'|'warning', message}] — order stable for
 * UI/tests (id-sorted). No I/O; `since`/dedup/audit are the service's job.
 *
 * @param {object} metrics the metrics object from computeBatchMetrics
 * @param {object} detail the detail object from computeBatchMetrics
 * @param {object} [extra] {globalMaxActiveContainers, expiredLeases}
 */
export function evaluateAlerts(metrics, detail = {}, extra = {}) {
  const alerts = [];
  const push = (id, severity, message) => alerts.push({ id, severity, message });
  const cap = extra.globalMaxActiveContainers ?? detail.limits?.globalMaxActiveContainers;

  // 1. active count above configured limit
  if (cap && metrics.active_containers != null && metrics.active_containers > cap) {
    push('BATCH_ACTIVE_OVER_LIMIT', 'critical', `active containers ${metrics.active_containers} exceed configured limit ${cap}`);
  }
  // 2. worker heartbeat missing/stale
  const hb = detail.heartbeats;
  if (hb) {
    if (hb.activeRuns > 0 && hb.noHeartbeat > 0) {
      push('WORKER_HEARTBEAT_STALE', 'critical', `${hb.noHeartbeat} active run(s) have no heartbeat`);
    } else if (hb.stale > 0) {
      push('WORKER_HEARTBEAT_STALE', 'warning', `${hb.stale} active run(s) heartbeat stale (> threshold); oldest ${hb.oldestAgeSeconds}s`);
    }
  }
  // 3. DB/Redis unavailable
  const deps = detail.deps ?? {};
  if (deps.postgres === 'down' || deps.redis === 'down') {
    const down = [deps.postgres === 'down' ? 'postgres' : null, deps.redis === 'down' ? 'redis' : null].filter(Boolean).join(' + ');
    push('DEPENDENCY_DOWN', 'critical', `${down} unavailable (readiness degraded)`);
  }
  // 4. disk low
  if (metrics.host_disk_available_bytes != null && extra.diskAvailableBytesFloor != null && metrics.host_disk_available_bytes < extra.diskAvailableBytesFloor) {
    push('DISK_LOW', 'critical', `disk available ${metrics.host_disk_available_bytes} bytes on ${detail.host?.diskPath ?? 'data root'} (floor ${extra.diskAvailableBytesFloor})`);
  }
  // 5. consecutive container start failures (heuristic: N in window)
  if (detail.startFailures && detail.startFailures.recent >= (extra.startFailureStreak ?? 3)) {
    push('CONTAINER_START_FAILURE_STREAK', 'warning', `${detail.startFailures.recent} container start failures within ${Math.round(detail.startFailures.windowMs / 60000)}m`);
  }
  // 6. tasks persisting in UNKNOWN
  if (detail.unknown && detail.unknown.stale > 0) {
    push('TASK_UNKNOWN_PERSISTENT', 'warning', `${detail.unknown.stale} run(s) in UNKNOWN state for > ${Math.round(detail.unknown.thresholdMs / 60000)}m`);
  }
  // 7. orphan containers (managed label, no valid DB owner)
  if (detail.containers?.available && (detail.containers.orphans?.length ?? 0) > 0) {
    push('ORPHAN_CONTAINERS', 'warning', `${detail.containers.orphans.length} running managed container(s) without a valid DB owner: ${detail.containers.orphans.slice(0, 5).join(', ')}`);
  }
  // 8. network policy unavailable (fail-closed trips recently)
  if (detail.network && detail.network.unavailableRecent > 0) {
    push('NETWORK_POLICY_UNAVAILABLE', 'critical', `network policy unavailable — ${detail.network.unavailableRecent} run(s) failed fail-closed in the last ${Math.round((extra.networkUnavailableWindowMs ?? 600_000) / 60000)}m`);
  }
  // lease reaper lag (supplementary — MD §9.6 reconciliation visibility)
  if ((extra.expiredLeases ?? 0) > 0) {
    push('EXPIRED_LEASES_PENDING', 'warning', `${extra.expiredLeases} expired lease(s) awaiting reconciliation`);
  }

  return alerts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.severity < b.severity ? -1 : 1));
}

/**
 * Stable fingerprint for alert dedup (the service keeps first-seen time per
 * fingerprint and only (re-)audits on change).
 * @param {object} alert {id, severity, message}
 */
export function alertFingerprint(alert) {
  return `${alert.id}:${alert.severity}:${alert.message}`;
}
