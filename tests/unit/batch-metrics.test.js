/**
 * BR-B5 metrics core (MD §13) — pure computation tests.
 * Covers: the 14 metric names/semantics, duration stats, concurrency peak,
 * and every alert condition (positive + negative), plus fingerprint stability.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BATCH_METRIC_NAMES,
  DEFAULT_ALERT_LIMITS,
  durationStatsMs,
  maxConcurrentFromIntervals,
  computeBatchMetrics,
  evaluateAlerts,
  alertFingerprint,
} from '@water-army/shared';

const T0 = Date.parse('2026-10-21T06:00:00Z');
const mins = (n) => new Date(T0 + n * 60_000).toISOString();

function baseInputs() {
  return {
    now: new Date(T0),
    batches: [],
    runs: [],
    expiredLeases: 0,
    startDurationsMs: null,
    containers: { available: true, running: 0, total: 0, orphans: [] },
    host: {
      memoryAvailableBytes: 8 * (1 << 30),
      memoryTotalBytes: 16 * (1 << 30),
      diskAvailableBytes: 100 * (1 << 30),
      diskPath: '/data/water_army',
      cpuLoad1m: 1.25,
      cpuLoad5m: 0.75,
    },
    deps: { postgres: 'up', redis: 'up', docker: 'up' },
  };
}

test('metric contract: exactly the 14 MD §13 names, all present', () => {
  assert.equal(BATCH_METRIC_NAMES.length, 14);
  const { metrics } = computeBatchMetrics(baseInputs());
  for (const name of BATCH_METRIC_NAMES) {
    assert.ok(name in metrics, `missing metric ${name}`);
  }
  assert.deepEqual(Object.keys(metrics).sort(), [...BATCH_METRIC_NAMES].sort());
});

test('batch-level counts: running/planned/failed', () => {
  const inputs = baseInputs();
  inputs.batches = [
    { id: 'b1', status: 'RUNNING', cycleId: 'c', maxActiveContainers: 50 },
    { id: 'b2', status: 'PLANNED', cycleId: 'c', maxActiveContainers: 50 },
    { id: 'b3', status: 'PAUSED', cycleId: 'c', maxActiveContainers: 50 },
    { id: 'b4', status: 'COMPLETED_WITH_ERRORS', cycleId: 'c', maxActiveContainers: 50 },
    { id: 'b5', status: 'COMPLETED', cycleId: 'c', maxActiveContainers: 50 },
  ];
  const { metrics } = computeBatchMetrics(inputs);
  assert.equal(metrics.batch_active_count, 1);
  assert.equal(metrics.batch_queued_count, 1);
  assert.equal(metrics.batch_failed_count, 2); // PAUSED + COMPLETED_WITH_ERRORS
});

test('run-level: retry / timeout / network counters', () => {
  const inputs = baseInputs();
  inputs.runs = [
    { id: 'r1', status: 'succeeded', attempt: 1, durationMs: 1000, startedAt: mins(-30), finishedAt: mins(-29), heartbeatAt: mins(-1) },
    { id: 'r2', status: 'succeeded', attempt: 2, durationMs: 3000, startedAt: mins(-28), finishedAt: mins(-27) }, // one retry
    { id: 'r3', status: 'succeeded', attempt: 3, durationMs: 2000, startedAt: mins(-26), finishedAt: mins(-25) }, // one retry
    { id: 'r4', status: 'timed_out', attempt: 1, durationMs: 900_000, startedAt: mins(-24), finishedAt: mins(-19) },
    { id: 'r5', status: 'failed', attempt: 1, errorCode: 'NETWORK_TARGET_DENIED', startedAt: mins(-20), finishedAt: mins(-19) },
    { id: 'r6', status: 'failed', attempt: 1, errorCode: 'NETWORK_BLOCKED_IP', startedAt: mins(-18), finishedAt: mins(-17) },
    { id: 'r7', status: 'failed', attempt: 1, errorCode: 'NETWORK_POLICY_UNAVAILABLE', startedAt: mins(-16), finishedAt: mins(-15) },
  ];
  const { metrics } = computeBatchMetrics(inputs);
  assert.equal(metrics.task_retry_total, 2);
  assert.equal(metrics.task_timeout_total, 1);
  assert.equal(metrics.network_policy_denied_total, 2); // explicit denies only
  assert.equal(metrics.network_health_failures_total, 1); // fail-closed unavailable
  assert.equal(metrics.task_run_duration_seconds.count, 4);
  assert.ok(metrics.task_run_duration_seconds.maxSeconds >= 900);
});

test('heartbeat age: oldest active run; no-heartbeat tracked; terminal runs ignored', () => {
  const inputs = baseInputs();
  inputs.runs = [
    { id: 'r1', status: 'running', heartbeatAt: mins(-10), startedAt: mins(-30) },
    { id: 'r2', status: 'queued', heartbeatAt: mins(-2), startedAt: mins(-3) },
    { id: 'r3', status: 'running', heartbeatAt: null, startedAt: mins(-4) },
    { id: 'r4', status: 'succeeded', heartbeatAt: mins(-99), startedAt: mins(-120), finishedAt: mins(-110) }, // terminal — ignored
  ];
  const { metrics, detail } = computeBatchMetrics(inputs);
  assert.equal(metrics.worker_heartbeat_age_seconds, 600); // r1 is oldest (10 min)
  assert.equal(detail.heartbeats.activeRuns, 3);
  assert.equal(detail.heartbeats.noHeartbeat, 1);
});

test('heartbeat age is null with no active runs', () => {
  const inputs = baseInputs();
  inputs.runs = [{ id: 'r1', status: 'succeeded', finishedAt: mins(-5) }];
  const { metrics } = computeBatchMetrics(inputs);
  assert.equal(metrics.worker_heartbeat_age_seconds, null);
});

test('durationStatsMs: percentiles + null cases', () => {
  assert.equal(durationStatsMs([]), null);
  assert.equal(durationStatsMs(null), null);
  assert.equal(durationStatsMs([null, undefined, -5]), null); // non-finite/negative filtered out
  const s = durationStatsMs([1000, 2000, 3000, 4000, 5000]);
  assert.equal(s.count, 5);
  assert.equal(s.meanSeconds, 3);
  assert.equal(s.p50Seconds, 3);
  assert.equal(s.p95Seconds, 5);
  assert.equal(s.maxSeconds, 5);
});

test('container start duration via state-event seam', () => {
  const inputs = baseInputs();
  inputs.startDurationsMs = [12_000, 18_000, 30_000];
  const { metrics } = computeBatchMetrics(inputs);
  assert.equal(metrics.container_start_duration_seconds.count, 3);
  assert.equal(metrics.container_start_duration_seconds.maxSeconds, 30);
  // no events yet → null (B2/B3 not writing them)
  const { metrics: m2 } = computeBatchMetrics(baseInputs());
  assert.equal(m2.container_start_duration_seconds, null);
});

test('maxConcurrentFromIntervals: overlap sweep + boundary', () => {
  // two runs [0..10], [10..20] → touch at 10, do NOT overlap → peak 1
  assert.equal(
    maxConcurrentFromIntervals([
      { startedAt: mins(0), finishedAt: mins(10) },
      { startedAt: mins(10), finishedAt: mins(20) },
    ]),
    1,
  );
  // three overlapping → peak 3
  assert.equal(
    maxConcurrentFromIntervals([
      { startedAt: mins(0), finishedAt: mins(10) },
      { startedAt: mins(2), finishedAt: mins(12) },
      { startedAt: mins(4), finishedAt: mins(14) },
    ]),
    3,
  );
  assert.equal(maxConcurrentFromIntervals([]), null);
  assert.equal(maxConcurrentFromIntervals([{ startedAt: mins(0), finishedAt: null }]), null);
});

test('host probes: values + degraded nulls', () => {
  const { metrics } = computeBatchMetrics(baseInputs());
  assert.equal(metrics.host_memory_available_bytes, 8 * (1 << 30));
  assert.equal(metrics.host_disk_available_bytes, 100 * (1 << 30));

  const inputs = baseInputs();
  inputs.host = null;
  inputs.containers = null;
  const m2 = computeBatchMetrics(inputs).metrics;
  assert.equal(m2.host_memory_available_bytes, null);
  assert.equal(m2.host_disk_available_bytes, null);
  assert.equal(m2.active_containers, null); // docker unavailable
});

test('expired lease counter', () => {
  const inputs = baseInputs();
  inputs.expiredLeases = 3;
  const { metrics } = computeBatchMetrics(inputs);
  assert.equal(metrics.expired_lease_total, 3);
});

// ------------------------------------------------------------------- alerts
test('alerts: composite failure scene fires the expected set', () => {
  const lim = { ...DEFAULT_ALERT_LIMITS, globalMaxActiveContainers: 2 };
  const out = computeBatchMetrics({
    ...baseInputs(),
    batches: [{ id: 'b1', status: 'RUNNING', maxActiveContainers: 2 }],
    runs: [
      { id: 'r1', status: 'running', heartbeatAt: null, startedAt: mins(-1) }, // no heartbeat → critical
      { id: 'r2', status: 'unknown', updatedAt: mins(-10), createdAt: mins(-12) }, // stale unknown
      { id: 'r3', status: 'failed', errorCode: 'CONTAINER_START_TIMEOUT', startedAt: mins(-2), finishedAt: mins(-1) },
      { id: 'r4', status: 'failed', errorCode: 'DOCKER_START_FAILED', startedAt: mins(-3), finishedAt: mins(-2) },
      { id: 'r5', status: 'failed', errorCode: 'CONTAINER_CREATE_ERR', startedAt: mins(-4), finishedAt: mins(-3) },
      { id: 'r6', status: 'failed', errorCode: 'NETWORK_POLICY_UNAVAILABLE', startedAt: mins(-2), finishedAt: mins(-1) },
    ],
    containers: { available: true, running: 5, total: 5, orphans: ['abc123def456', 'fff000111222'] },
    host: { ...baseInputs().host, diskAvailableBytes: 512 * (1 << 20) }, // below 1 GiB floor
    deps: { postgres: 'down', redis: 'up', docker: 'up' },
  }, lim);
  const byId = Object.fromEntries(out.alerts.map((a) => [a.id, a]));
  assert.equal(byId.BATCH_ACTIVE_OVER_LIMIT.severity, 'critical'); // 5 > cap 2
  assert.equal(byId.WORKER_HEARTBEAT_STALE.severity, 'critical'); // no heartbeat beats stale
  assert.equal(byId.DEPENDENCY_DOWN.severity, 'critical');
  assert.equal(byId.DISK_LOW.severity, 'critical');
  assert.equal(byId.NETWORK_POLICY_UNAVAILABLE.severity, 'critical');
  assert.ok(byId.CONTAINER_START_FAILURE_STREAK, '3 start failures in window');
  assert.ok(byId.TASK_UNKNOWN_PERSISTENT);
  assert.ok(byId.ORPHAN_CONTAINERS);
});

test('alerts: active-over-limit needs the configured cap (seam)', () => {
  // default cap 50 — 5 running must NOT fire; cap=2 must fire
  const inputs = baseInputs();
  inputs.containers = { available: true, running: 5, total: 5, orphans: [] };
  const limDefault = { ...DEFAULT_ALERT_LIMITS };
  const idsDefault = computeBatchMetrics(inputs, limDefault).alerts.map((a) => a.id);
  assert.ok(!idsDefault.includes('BATCH_ACTIVE_OVER_LIMIT'));

  const limTight = { ...DEFAULT_ALERT_LIMITS, globalMaxActiveContainers: 2 };
  const idsTight = computeBatchMetrics(inputs, limTight).alerts.map((a) => a.id);
  assert.ok(idsTight.includes('BATCH_ACTIVE_OVER_LIMIT'));
});

test('alerts: each condition in isolation (positive + negative)', () => {
  const lim = { ...DEFAULT_ALERT_LIMITS };

  // 1. active over limit (cap=1, 2 running)
  let out = computeBatchMetrics({ ...baseInputs(), containers: { available: true, running: 2, total: 2, orphans: [] } }, { ...lim, globalMaxActiveContainers: 1 });
  assert.ok(evaluateAlerts(out.metrics, out.detail, { globalMaxActiveContainers: 1, ...pickExtra(out) }).some((a) => a.id === 'BATCH_ACTIVE_OVER_LIMIT'));

  // 2. no heartbeat (critical) vs stale (warning)
  out = computeBatchMetrics({ ...baseInputs(), runs: [{ id: 'r', status: 'running', heartbeatAt: null, startedAt: mins(-1) }] }, lim);
  assert.ok(evaluateAlerts(out.metrics, out.detail, pickExtra(out)).some((a) => a.id === 'WORKER_HEARTBEAT_STALE' && a.severity === 'critical'));
  out = computeBatchMetrics({ ...baseInputs(), runs: [{ id: 'r', status: 'running', heartbeatAt: mins(-5), startedAt: mins(-10) }] }, lim);
  const stale = evaluateAlerts(out.metrics, out.detail, pickExtra(out)).filter((a) => a.id === 'WORKER_HEARTBEAT_STALE');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].severity, 'warning');

  // 3. dependency down
  out = computeBatchMetrics({ ...baseInputs(), deps: { postgres: 'up', redis: 'down', docker: 'up' } }, lim);
  assert.ok(evaluateAlerts(out.metrics, out.detail, pickExtra(out)).some((a) => a.id === 'DEPENDENCY_DOWN' && a.severity === 'critical'));

  // 4. disk low
  out = computeBatchMetrics({ ...baseInputs(), host: { ...baseInputs().host, diskAvailableBytes: 100 * (1 << 20) } }, lim);
  assert.ok(evaluateAlerts(out.metrics, out.detail, { ...pickExtra(out), diskAvailableBytesFloor: lim.diskAvailableBytesFloor }).some((a) => a.id === 'DISK_LOW'));

  // 5. start failure streak (3 in window)
  const starts = [0, 1, 2].map((i) => ({ id: `s${i}`, status: 'failed', errorCode: 'CONTAINER_START_TIMEOUT', startedAt: mins(-i - 1), finishedAt: mins(-i) }));
  out = computeBatchMetrics({ ...baseInputs(), runs: starts }, lim);
  assert.ok(evaluateAlerts(out.metrics, out.detail, { ...pickExtra(out), startFailureStreak: lim.startFailureStreak }).some((a) => a.id === 'CONTAINER_START_FAILURE_STREAK'));
  // only 2 → no alert
  out = computeBatchMetrics({ ...baseInputs(), runs: starts.slice(0, 2) }, lim);
  assert.ok(!evaluateAlerts(out.metrics, out.detail, { ...pickExtra(out), startFailureStreak: lim.startFailureStreak }).some((a) => a.id === 'CONTAINER_START_FAILURE_STREAK'));

  // 6. persistent UNKNOWN
  out = computeBatchMetrics({ ...baseInputs(), runs: [{ id: 'u', status: 'unknown', updatedAt: mins(-6), createdAt: mins(-8) }] }, lim);
  assert.ok(evaluateAlerts(out.metrics, out.detail, pickExtra(out)).some((a) => a.id === 'TASK_UNKNOWN_PERSISTENT'));
  // fresh unknown → no alert
  out = computeBatchMetrics({ ...baseInputs(), runs: [{ id: 'u', status: 'unknown', updatedAt: mins(-1), createdAt: mins(-2) }] }, lim);
  assert.ok(!evaluateAlerts(out.metrics, out.detail, pickExtra(out)).some((a) => a.id === 'TASK_UNKNOWN_PERSISTENT'));

  // 7. orphan containers
  out = computeBatchMetrics({ ...baseInputs(), containers: { available: true, running: 1, total: 1, orphans: ['abc'] } }, lim);
  assert.ok(evaluateAlerts(out.metrics, out.detail, pickExtra(out)).some((a) => a.id === 'ORPHAN_CONTAINERS'));

  // 8. network policy unavailable (recent)
  out = computeBatchMetrics({ ...baseInputs(), runs: [{ id: 'n', status: 'failed', errorCode: 'NETWORK_POLICY_UNAVAILABLE', startedAt: mins(-2), finishedAt: mins(-1) }] }, lim);
  assert.ok(evaluateAlerts(out.metrics, out.detail, { ...pickExtra(out), networkUnavailableWindowMs: lim.networkUnavailableWindowMs }).some((a) => a.id === 'NETWORK_POLICY_UNAVAILABLE' && a.severity === 'critical'));

  // supplementary: expired leases
  out = computeBatchMetrics({ ...baseInputs(), expiredLeases: 2 }, lim);
  assert.ok(evaluateAlerts(out.metrics, out.detail, { ...pickExtra(out), expiredLeases: 2 }).some((a) => a.id === 'EXPIRED_LEASES_PENDING'));
});

test('alerts: healthy inputs produce zero alerts', () => {
  const out = computeBatchMetrics(
    {
      ...baseInputs(),
      batches: [{ id: 'b1', status: 'RUNNING', maxActiveContainers: 50 }],
      runs: [
        { id: 'r1', status: 'running', heartbeatAt: mins(-1), startedAt: mins(-10), attempt: 1 },
        { id: 'r2', status: 'succeeded', heartbeatAt: mins(-20), startedAt: mins(-30), finishedAt: mins(-20), attempt: 1, durationMs: 60_000 },
      ],
      containers: { available: true, running: 1, total: 3, orphans: [] },
    },
    { ...DEFAULT_ALERT_LIMITS },
  );
  assert.deepEqual(out.alerts, []);
});

test('alert fingerprint: stable + distinct per id/severity/message', () => {
  const a = alertFingerprint({ id: 'X', severity: 'warning', message: 'm1' });
  assert.equal(a, 'X:warning:m1');
  assert.notEqual(a, alertFingerprint({ id: 'X', severity: 'critical', message: 'm1' }));
  assert.notEqual(a, alertFingerprint({ id: 'Y', severity: 'warning', message: 'm1' }));
});

/** pull the per-evaluation extras that computeBatchMetrics kept in detail/limits */
function pickExtra(out) {
  return {
    expiredLeases: out.metrics.expired_lease_total,
  };
}
