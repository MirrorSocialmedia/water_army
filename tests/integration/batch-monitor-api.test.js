/**
 * BR-B5 S2 — batch monitor / metrics / report API (MD §11.2/§11.3/§11.4/§12/§13).
 *
 * Hermetic: unified fake db (batch-api-fakes.js = API fakes + B1 batch
 * fakes), fake docker client (batch labels per MD §4.3), fake redis,
 * injected os/fs probes (opts.batchMetrics* seams). Covers:
 *  - RBAC matrix (401 / viewer 403 on export / operator+ export)
 *  - monitor summary shape: current batch, cycle, counts, capacity, task
 *    table (stuck flag), host/deps/containers
 *  - the 14 MD §13 metrics + the 5 alert conditions this fixture trips
 *    (over-limit, stale heartbeat, disk low, orphans, expired leases)
 *  - alert side-effects: pino + audit (dedup — second fetch adds none)
 *  - identities list (filter/search/paging) + detail (data dir, runs,
 *    last error, container mapping, health check)
 *  - cycle report: list, JSON export, CSV export, 400/404/409 paths,
 *    audit on export
 *  - zero-secret masking: metadata credential keys redacted, error
 *    messages with credential-shaped values redacted
 *  - Docker-down degradation (200 + nulls, never 500)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from '@node-rs/argon2';

import {
  APP_LABELS,
  CONTAINER_LABELS,
  APP_SETTING_BATCH_GLOBAL_MAX_ACTIVE,
  BATCH_METRIC_NAMES,
} from '@water-army/shared';

import { buildApp } from '../../apps/api/src/app.js';
import { createBatchMetricsService } from '../../apps/api/src/services/batch-metrics-service.js';
import { makeBatchApiDb } from '../helpers/batch-api-fakes.js';
import { testConfig, fakeRedisOk, makeFakeQueue, makeFakeDb } from '../helpers/fakes.js';
import { makeFakeDockerWrapper } from '../helpers/fake-docker-client.js';

const { argon2id, hash } = argon2;
const PASSWORD = 'TestPass123';

// Reference clock = real now at test load (all fixture dates are relative —
// staleness/expiry assertions hold whenever the suite runs).
const NOW = Date.now();
const T = (minAgo) => new Date(NOW - minAgo * 60_000);
const MS = {
  c2Start: NOW - 2 * 86_400_000, // c2 batch 1 start (2 days ago)
  c2b4Start: NOW - 86_400_000, // c2 batch 2 start (1 day ago)
};

// stable fixture ids
const C1 = '11111111-2222-4333-8444-555555555555';
const C2 = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const B1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const B2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const B3 = 'bbbbbbbb-0000-4000-8000-000000000003';
const B4 = 'bbbbbbbb-0000-4000-8000-000000000004';
const ALPHA = 'id-alpha';
const BETA = 'id-beta';
const GAMMA = 'id-gamma';
const DELTA = 'id-delta';

const ID = {
  [ALPHA]: {
    id: ALPHA, externalRef: 'ref-alpha', displayName: 'Alpha', identityType: 'phone',
    status: 'COMPLETED', dataPath: '/data/water_army/identities/alpha', metadataJson: { team: 'qa' },
  },
  [BETA]: {
    id: BETA, externalRef: 'ref-beta', displayName: 'Beta', identityType: 'phone',
    status: 'RUNNING', dataPath: '/data/water_army/identities/beta', metadataJson: {},
  },
  [GAMMA]: {
    id: GAMMA, externalRef: 'ref-gamma', displayName: 'Gamma', identityType: 'phone',
    status: 'FAILED_FINAL', dataPath: '/data/water_army/identities/gamma', metadataJson: {},
  },
  [DELTA]: {
    id: DELTA, externalRef: 'ref-delta', displayName: 'Delta', identityType: 'phone',
    status: 'READY', dataPath: '/data/water_army/identities/delta',
    metadataJson: { team: 'qa', cookieToken: 'secret-token-123456' }, // must never appear in API output
  },
};

const BATCHES = [
  { id: B1, name: 'c1-batch-1', cycleId: C1, batchNo: 1, status: 'RUNNING', batchSize: 2, maxActiveContainers: 3, failurePolicy: 'continue', configJson: {}, idempotencyKey: null, createdBy: 'admin1', createdAt: T(120), startedAt: T(60), finishedAt: null },
  { id: B2, name: 'c1-batch-2', cycleId: C1, batchNo: 2, status: 'PLANNED', batchSize: 1, maxActiveContainers: 3, failurePolicy: 'continue', configJson: {}, idempotencyKey: null, createdBy: 'admin1', createdAt: T(120), startedAt: null, finishedAt: null },
  { id: B3, name: 'c2-batch-1', cycleId: C2, batchNo: 1, status: 'COMPLETED', batchSize: 2, maxActiveContainers: 3, failurePolicy: 'continue', configJson: {}, createdBy: 'admin1', createdAt: T(2885), startedAt: new Date(MS.c2Start), finishedAt: new Date(MS.c2Start + 40 * 60_000) },
  { id: B4, name: 'c2-batch-2', cycleId: C2, batchNo: 2, status: 'COMPLETED_WITH_ERRORS', batchSize: 1, maxActiveContainers: 3, failurePolicy: 'continue', configJson: {}, createdBy: 'admin1', createdAt: T(1445), startedAt: new Date(MS.c2b4Start), finishedAt: new Date(MS.c2b4Start + 35 * 60_000) },
];

const MEMBERSHIPS = [
  { batchId: B1, identityId: ALPHA, position: 1, status: 'RUNNING', createdAt: T(59) },
  { batchId: B1, identityId: BETA, position: 2, status: 'PENDING', createdAt: T(59) },
  { batchId: B2, identityId: DELTA, position: 1, status: 'PENDING', createdAt: T(120) },
  { batchId: B3, identityId: ALPHA, position: 1, status: 'COMPLETED', createdAt: T(2885) },
  { batchId: B3, identityId: GAMMA, position: 2, status: 'FAILED_FINAL', createdAt: T(2885) },
  { batchId: B4, identityId: DELTA, position: 1, status: 'SKIPPED', skipReason: 'data dir locked by previous cycle', createdAt: T(1445) },
];

const RUNS = [
  // c1 (in flight)
  { id: 'r1', batchId: B1, identityId: ALPHA, status: 'succeeded', attempt: 1, queuedAt: T(58), startedAt: T(55), finishedAt: T(50), durationMs: 60_000, heartbeatAt: T(50), errorCode: null, errorMessage: null, createdAt: T(58), updatedAt: T(50) },
  { id: 'r2', batchId: B1, identityId: BETA, status: 'running', attempt: 1, queuedAt: T(31), startedAt: T(30), finishedAt: null, durationMs: null, heartbeatAt: T(180), errorCode: null, errorMessage: null, createdAt: T(31), updatedAt: T(30) }, // stale heartbeat → stuck
  { id: 'r3', batchId: B2, identityId: DELTA, status: 'queued', attempt: 1, queuedAt: T(5), startedAt: null, finishedAt: null, durationMs: null, heartbeatAt: T(0.2), errorCode: null, errorMessage: null, createdAt: T(5), updatedAt: T(5) }, // fresh heartbeat
  { id: 'r4', batchId: B1, identityId: GAMMA, status: 'failed', attempt: 2, queuedAt: T(12), startedAt: T(10), finishedAt: T(9), durationMs: null, heartbeatAt: null, errorCode: 'CONTAINER_START_FAILED', errorMessage: 'docker create failed: no space left on device', createdAt: T(12), updatedAt: T(9) },
  // c2 (history — terminal)
  { id: 'r5', batchId: B3, identityId: ALPHA, status: 'succeeded', attempt: 1, queuedAt: new Date(MS.c2Start + 4 * 60_000), startedAt: new Date(MS.c2Start + 5 * 60_000), finishedAt: new Date(MS.c2Start + 10 * 60_000), durationMs: 420_000, heartbeatAt: new Date(MS.c2Start + 10 * 60_000), errorCode: null, errorMessage: null, createdAt: new Date(MS.c2Start + 4 * 60_000), updatedAt: new Date(MS.c2Start + 10 * 60_000) },
  { id: 'r6', batchId: B3, identityId: GAMMA, status: 'failed', attempt: 1, queuedAt: new Date(MS.c2Start + 4 * 60_000), startedAt: new Date(MS.c2Start + 5 * 60_000), finishedAt: new Date(MS.c2Start + 8 * 60_000), durationMs: null, heartbeatAt: null, errorCode: 'NETWORK_TARGET_DENIED', errorMessage: 'network gate: target not in allowlist (https://example.internal)', createdAt: new Date(MS.c2Start + 4 * 60_000), updatedAt: new Date(MS.c2Start + 8 * 60_000) },
  { id: 'r7', batchId: B3, identityId: GAMMA, status: 'failed', attempt: 2, queuedAt: new Date(MS.c2Start + 8 * 60_000), startedAt: new Date(MS.c2Start + 9 * 60_000), finishedAt: new Date(MS.c2Start + 12 * 60_000), durationMs: 180_000, heartbeatAt: new Date(MS.c2Start + 12 * 60_000), errorCode: 'PROVIDER_ERROR', errorMessage: 'provider returned 500', createdAt: new Date(MS.c2Start + 8 * 60_000), updatedAt: new Date(MS.c2Start + 12 * 60_000) },
  { id: 'r8', batchId: B4, identityId: DELTA, status: 'timed_out', attempt: 1, queuedAt: new Date(MS.c2b4Start), startedAt: new Date(MS.c2b4Start), finishedAt: new Date(MS.c2b4Start + 30 * 60_000), durationMs: 1_800_000, heartbeatAt: new Date(MS.c2b4Start + 30 * 60_000), errorCode: null, errorMessage: 'task exceeded timeout 30m', createdAt: new Date(MS.c2b4Start), updatedAt: new Date(MS.c2b4Start + 30 * 60_000) },
];

const LEASES = [
  { id: 'lease1', resourceType: 'container_slot', resourceKey: 'slot-1', ownerRunId: 'r1', ownerLabel: null, leaseExpiresAt: T(60), createdAt: T(120) },
];

const L = (extra = {}) => ({ [APP_LABELS.MANAGED]: 'true', ...extra });
const CONTAINERS = [
  { name: 'wa-batch-alpha', state: 'running', labels: L({ [CONTAINER_LABELS.IDENTITY_ID]: ALPHA, [CONTAINER_LABELS.BATCH_ID]: B1, [CONTAINER_LABELS.TASK_RUN_ID]: 'r1' }) },
  { name: 'wa-batch-beta', state: 'running', labels: L({ [CONTAINER_LABELS.IDENTITY_ID]: BETA, [CONTAINER_LABELS.BATCH_ID]: B1, [CONTAINER_LABELS.TASK_RUN_ID]: 'r2' }) },
  { name: 'wa-orphan', state: 'running', labels: L({}) }, // managed, no identity → orphan
  { name: 'external-vm', state: 'running', labels: {} }, // unmanaged → excluded
];

// injected probes (hermetic host)
const OS_PROBE = { freemem: () => 8e9, totalmem: () => 16e9, loadavg: () => [0.5, 0.6] };
const ALPHA_MTIME = T(10);
const FS_PROBE = {
  stat: async (p) => {
    if (p === ID[ALPHA].dataPath) return { mtime: ALPHA_MTIME };
    const err = new Error(`ENOENT: ${p}`);
    err.code = 'ENOENT';
    throw err;
  },
  statfs: async () => ({ bavail: 512, bsize: 1_048_576 }), // 512 MiB → below the 1 GiB floor → DISK_LOW
};

async function makeApp({ dockerOpts = {} } = {}) {
  const passwordHash = await hash(PASSWORD, { type: argon2id });
  const db = makeBatchApiDb({
    users: [
      { id: 'u-admin', username: 'admin1', passwordHash, role: 'admin' },
      { id: 'u-op', username: 'op1', passwordHash, role: 'operator' },
      { id: 'u-view', username: 'viewer1', passwordHash, role: 'viewer' },
    ],
    batch: { identities: Object.values(ID), batches: BATCHES, batchIdentities: MEMBERSHIPS, taskRuns: RUNS, leases: LEASES },
  });
  const docker = makeFakeDockerWrapper({ containers: CONTAINERS, ...dockerOpts });
  const config = { ...testConfig, aiProvider: 'mock', serviceToken: 'test-service-token-0123456789abcdef01234567' };
  const app = await buildApp({
    config,
    db,
    redis: fakeRedisOk(),
    docker,
    taskQueue: makeFakeQueue(),
    batchMetricsOsProbe: OS_PROBE,
    batchMetricsFsProbe: FS_PROBE,
  });
  // AppSetting: global cap = 2 → 3 running managed containers trips the limit
  await db.appSetting.upsert({
    where: { key: APP_SETTING_BATCH_GLOBAL_MAX_ACTIVE },
    create: { key: APP_SETTING_BATCH_GLOBAL_MAX_ACTIVE, valueJson: 2 },
    update: { valueJson: 2 },
  });
  // container start durations (B2/B3 write seam — detailsJson.startDurationMs)
  await db.stateEvent.create({ data: { entityType: 'task_run', entityId: 'r1', toState: 'RUNNING', detailsJson: { startDurationMs: 1500 }, createdAt: T(55) } });
  await db.stateEvent.create({ data: { entityType: 'task_run', entityId: 'r2', toState: 'RUNNING', detailsJson: { startDurationMs: 2500 }, createdAt: T(30) } });
  return { app, db };
}

async function login(app, username) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD } });
  assert.equal(res.statusCode, 200, res.body);
  return res.headers['set-cookie'].split(';')[0];
}

const EXPECTED_ALERT_IDS = ['BATCH_ACTIVE_OVER_LIMIT', 'DISK_LOW', 'EXPIRED_LEASES_PENDING', 'ORPHAN_CONTAINERS', 'WORKER_HEARTBEAT_STALE'];

// ============================================================================

test('BR-B5 S2: metrics endpoint — all 14 MD §13 metrics + 5 alerts', async () => {
  const { app } = await makeApp();
  const view = await login(app, 'viewer1');
  const res = await app.inject({ method: 'GET', url: '/api/batches/metrics', headers: { cookie: view } });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();

  // the full MD §13 contract
  for (const name of BATCH_METRIC_NAMES) assert.ok(name in body.metrics, `missing metric ${name}`);
  assert.equal(body.metrics.batch_active_count, 1); // B1 RUNNING
  assert.equal(body.metrics.batch_queued_count, 1); // B2 PLANNED
  assert.equal(body.metrics.batch_failed_count, 1); // B4 COMPLETED_WITH_ERRORS
  assert.equal(body.metrics.active_containers, 3); // 3 running managed
  assert.deepEqual(body.metrics.container_start_duration_seconds, { count: 2, meanSeconds: 2, p50Seconds: 1.5, p95Seconds: 2.5, maxSeconds: 2.5 });
  assert.equal(body.metrics.task_run_duration_seconds.count, 4); // r1, r5, r7, r8 (r4 durationMs null)
  assert.equal(body.metrics.task_retry_total, 2); // r4 (attempt 2), r7 (attempt 2)
  assert.equal(body.metrics.task_timeout_total, 1); // r8
  assert.ok(body.metrics.worker_heartbeat_age_seconds >= 10_000 && body.metrics.worker_heartbeat_age_seconds <= 13_000, `stale heartbeat age ${body.metrics.worker_heartbeat_age_seconds}`);
  assert.equal(body.metrics.expired_lease_total, 1);
  assert.equal(body.metrics.host_memory_available_bytes, 8e9);
  assert.equal(body.metrics.host_disk_available_bytes, 512 * 1_048_576);
  assert.equal(body.metrics.network_policy_denied_total, 1); // r6 NETWORK_TARGET_DENIED
  assert.equal(body.metrics.network_health_failures_total, 0);

  // the 5 alerts this fixture trips — exact set, each with severity + since
  assert.deepEqual(body.alerts.map((a) => a.id), EXPECTED_ALERT_IDS);
  const byId = Object.fromEntries(body.alerts.map((a) => [a.id, a]));
  assert.equal(byId.BATCH_ACTIVE_OVER_LIMIT.severity, 'critical');
  assert.equal(byId.DISK_LOW.severity, 'critical');
  assert.equal(byId.WORKER_HEARTBEAT_STALE.severity, 'warning');
  for (const a of body.alerts) {
    assert.ok(typeof a.since === 'string' && !Number.isNaN(Date.parse(a.since)), 'alert.since must be ISO');
    assert.ok(a.message.length > 0);
  }
  // detail block: containers orphans + deps + heartbeats
  assert.equal(body.detail.containers.running, 3);
  assert.equal(body.detail.containers.orphans.length, 1);
  assert.deepEqual(body.detail.deps, { postgres: 'up', redis: 'up', docker: 'up' });
  assert.equal(body.detail.heartbeats.stale, 1);
  assert.equal(body.detail.heartbeats.noHeartbeat, 0);
  assert.equal(typeof body.generatedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(body.generatedAt)));

  await app.close();
});

test('BR-B5 S2: alert side-effects — audit on raise, dedup on refetch', async () => {
  const { app, db } = await makeApp();
  const view = await login(app, 'viewer1');

  const raised = () => db.__state.auditRows.filter((a) => a.action === 'batch.alert_raised').length;
  assert.equal(raised(), 0);

  const r1 = await app.inject({ method: 'GET', url: '/api/batches/metrics', headers: { cookie: view } });
  assert.equal(r1.statusCode, 200, r1.body);
  assert.equal(raised(), EXPECTED_ALERT_IDS.length, 'each new alert audited once');
  const since1 = r1.json().alerts.map((a) => [a.id, a.since]);

  const r2 = await app.inject({ method: 'GET', url: '/api/batches/metrics', headers: { cookie: view } });
  assert.equal(r2.statusCode, 200, r2.body);
  assert.equal(raised(), EXPECTED_ALERT_IDS.length, 'dedup: no duplicate audit within the re-audit window');
  assert.deepEqual(r2.json().alerts.map((a) => [a.id, a.since]), since1, 'since is stable (first-seen)');

  await app.close();
});

test('BR-B5 S2: monitor summary — current batch, cycle, counts, capacity, task table', async () => {
  const { app } = await makeApp();
  const view = await login(app, 'viewer1');
  const res = await app.inject({ method: 'GET', url: '/api/batch-monitor/summary', headers: { cookie: view } });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();

  assert.equal(body.currentBatch.id, B1);
  assert.equal(body.currentBatch.status, 'RUNNING');
  assert.equal(body.currentBatch.maxActiveContainers, 3);
  assert.equal(body.cycle.cycleId, C1);
  assert.equal(body.cycle.batchCount, 2);
  assert.equal(body.cycle.status, 'RUNNING');
  assert.equal(body.cycleBatches.length, 2);

  assert.deepEqual(body.counts.global, { active: 1, queued: 1, completed: 2, failed: 4, other: 0 });
  assert.deepEqual(body.counts.cycle, { active: 1, queued: 1, completed: 1, failed: 1, other: 0 });

  assert.deepEqual(body.capacity, {
    globalMaxActiveContainers: 2,
    batchMaxActiveContainers: 3,
    activeContainersNow: 3,
  });

  // task table: newest first (r3 created 5 min ago)
  assert.equal(body.tasks.length, 8);
  assert.equal(body.tasks[0].id, 'r3');
  const r2row = body.tasks.find((t) => t.id === 'r2');
  assert.equal(r2row.stuck, true, 'stale-heartbeat run flagged stuck');
  assert.equal(r2row.identityLabel, 'Beta');
  assert.equal(r2row.batchNo, 1);
  assert.equal(r2row.lastError, null);
  const r4row = body.tasks.find((t) => t.id === 'r4');
  assert.equal(r4row.lastError.code, 'CONTAINER_START_FAILED');
  assert.ok(!r4row.lastError.message.includes('stack'), 'no stack traces in the task table');

  // host / deps / containers
  assert.equal(body.host.memoryAvailableBytes, 8e9);
  assert.equal(body.host.diskAvailableBytes, 512 * 1_048_576);
  assert.equal(body.host.diskPath, '/data/water_army');
  assert.equal(body.deps.postgres, 'up');
  assert.equal(body.containers.orphans.length, 1);

  await app.close();
});

test('BR-B5 S2: identities list — filter / search / paging', async () => {
  const { app } = await makeApp();
  const view = await login(app, 'viewer1');

  const all = await app.inject({ method: 'GET', url: '/api/identities', headers: { cookie: view } });
  assert.equal(all.statusCode, 200, all.body);
  assert.equal(all.json().total, 4);
  assert.equal(all.json().items.length, 4);

  const ready = await app.inject({ method: 'GET', url: '/api/identities?status=READY', headers: { cookie: view } });
  assert.equal(ready.json().total, 1);
  assert.equal(ready.json().items[0].id, DELTA);

  const searched = await app.inject({ method: 'GET', url: '/api/identities?q=beta', headers: { cookie: view } });
  assert.equal(searched.json().total, 1);
  assert.equal(searched.json().items[0].id, BETA);

  const paged = await app.inject({ method: 'GET', url: '/api/identities?pageSize=2&page=2', headers: { cookie: view } });
  assert.equal(paged.json().items.length, 2);
  assert.equal(paged.json().total, 4);

  // zero-secret: the credential-shaped metadata key is redacted in list rows
  const delta = all.json().items.find((i) => i.id === DELTA);
  assert.equal(delta.metadata.cookieToken, '***redacted***');
  assert.ok(!all.body.includes('secret-token-123456'), 'raw credential value never appears');

  await app.close();
});

test('BR-B5 S2: identity detail — data dir, runs, last error, container, health', async () => {
  const { app } = await makeApp();
  const view = await login(app, 'viewer1');

  // ---- alpha: completed, container running, no last error ------------------
  const ra = await app.inject({ method: 'GET', url: `/api/identities/${ALPHA}`, headers: { cookie: view } });
  assert.equal(ra.statusCode, 200, ra.body);
  const a = ra.json();
  assert.equal(a.identity.id, ALPHA);
  assert.equal(a.identity.status, 'COMPLETED');
  assert.deepEqual(a.dataDir, { path: ID[ALPHA].dataPath, exists: true, lastModifiedAt: ALPHA_MTIME.toISOString() });
  assert.equal(a.memberships.length, 2);
  assert.equal(a.memberships[0].batchNo, 1);
  assert.equal(a.recentRuns.length, 2);
  assert.equal(a.recentRuns[0].id, 'r1'); // newest first
  assert.equal(a.lastError, null);
  assert.ok(a.container, 'container mapping via batch labels');
  assert.equal(a.container.state, 'running');
  assert.equal(a.container.shortId.length, 12);
  assert.ok(a.container.id.startsWith(a.container.shortId));
  assert.equal(a.lastHealthCheckAt, T(50).toISOString());

  // ---- gamma: failed — lastError from the MOST RECENT errored run (r4,
  //      which is newer than gamma's 2-day-old c2 attempts) ----------------
  const rg = await app.inject({ method: 'GET', url: `/api/identities/${GAMMA}`, headers: { cookie: view } });
  const g = rg.json();
  assert.equal(g.lastError.code, 'CONTAINER_START_FAILED');
  assert.ok(g.lastError.message.includes('no space left on device'));
  assert.equal(g.dataDir.exists, false, 'missing data dir degrades, does not fail');
  assert.equal(g.container, null, 'no live container for gamma');

  // ---- unknown id → 404 IDENTITY_NOT_FOUND ---------------------------------
  const r404 = await app.inject({ method: 'GET', url: '/api/identities/nope-404', headers: { cookie: view } });
  assert.equal(r404.statusCode, 404);
  assert.equal(r404.json().error.code, 'IDENTITY_NOT_FOUND');

  await app.close();
});

test('BR-B5 S2: report list + JSON export (operator) + audit', async () => {
  const { app, db } = await makeApp();
  const op = await login(app, 'op1');

  // list (viewer ok too)
  const view = await login(app, 'viewer1');
  const list = await app.inject({ method: 'GET', url: '/api/batch-reports', headers: { cookie: view } });
  assert.equal(list.statusCode, 200, list.body);
  const cycles = Object.fromEntries(list.json().cycles.map((c) => [c.cycleId, c]));
  assert.deepEqual(Object.keys(cycles).sort(), [C1, C2]);
  assert.equal(cycles[C1].status, 'RUNNING');
  assert.equal(cycles[C2].status, 'COMPLETED_WITH_ERRORS');
  assert.equal(cycles[C2].batchCount, 2);

  // JSON export
  const res = await app.inject({ method: 'GET', url: `/api/batch-reports/${C2}`, headers: { cookie: op } });
  assert.equal(res.statusCode, 200, res.body);
  const report = res.json();
  assert.equal(report.schema, 'water-army/batch-cycle-report/v1');
  assert.equal(report.cycleId, C2);
  assert.equal(report.batches.length, 2);
  assert.equal(report.batches[0].batchNo, 1);

  const totals = report.totals;
  assert.equal(totals.identities, 3); // alpha+gamma (b3), delta (b4)
  assert.equal(totals.completed, 1); // alpha (identity COMPLETED)
  assert.equal(totals.failedFinal, 1); // gamma (identity FAILED_FINAL)
  assert.equal(totals.nonTerminal, 1); // delta (identity READY)
  assert.equal(totals.successRate, 0.33);
  assert.equal(totals.totalRunAttempts, 4);
  assert.equal(totals.retries, 1);
  assert.equal(totals.timeouts, 1);

  // b3 stats + member detail
  const b3 = report.batches[0];
  assert.equal(b3.stats.members, 2);
  assert.equal(b3.stats.completed, 1);
  assert.equal(b3.stats.failedFinal, 1);
  assert.equal(b3.stats.retries, 1);
  assert.equal(b3.stats.peakActiveContainers, 2); // alpha ∥ gamma attempt 1 overlap
  const gamma = b3.members.find((m) => m.identityId === GAMMA);
  assert.equal(gamma.attempts, 2);
  assert.equal(gamma.finalStatus, 'FAILED_FINAL');
  assert.equal(gamma.failure.code, 'PROVIDER_ERROR');
  assert.ok(gamma.failure.at, 'failure carries a timestamp');
  const alpha = b3.members.find((m) => m.identityId === ALPHA);
  assert.equal(alpha.finalStatus, 'COMPLETED');
  assert.equal(alpha.failure, null);

  // b4: the timed-out delta member
  const b4 = report.batches[1];
  assert.equal(b4.stats.byRunStatus.timed_out, 1);
  assert.equal(b4.members[0].skipReason, 'data dir locked by previous cycle');

  // resource peaks + time range
  assert.equal(report.resourcePeaks.peakActiveContainers, 2);
  assert.equal(report.resourcePeaks.batchCaps.length, 2);
  assert.equal(report.timeRange.startedAt, new Date(MS.c2Start).toISOString());
  assert.equal(report.timeRange.finishedAt, new Date(MS.c2b4Start + 35 * 60_000).toISOString());

  // zero secrets in the export body
  const flat = res.body;
  assert.ok(!flat.includes('secret-token-123456'));
  assert.ok(!/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(flat), 'no JWT-shaped values');

  // export audited (the fake audit row carries the Prisma column name)
  const audits = db.__state.auditRows.filter((a) => a.action === 'batch.report_exported');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].resourceId, C2);
  assert.equal(audits[0].detailsJson.format, 'json');
  assert.equal(audits[0].actorUserId, 'u-op');

  await app.close();
});

test('BR-B5 S2: report CSV export — shape + content-disposition', async () => {
  const { app } = await makeApp();
  const op = await login(app, 'op1');
  const res = await app.inject({ method: 'GET', url: `/api/batch-reports/${C2}?format=csv`, headers: { cookie: op } });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.headers['content-type'] ?? '', /text\/csv/);
  assert.ok(
    (res.headers['content-disposition'] ?? '').includes(`attachment; filename="batch-cycle-${C2}.csv"`),
    `content-disposition: ${res.headers['content-disposition']}`,
  );

  const lines = res.body.trim().split('\n');
  assert.equal(lines[0], 'cycle_id,batch_no,batch_id,position,identity_id,external_ref,display_name,final_status,attempts,failure_code,failure_summary,skip_reason,container_id,started_at,finished_at,duration_ms');
  assert.equal(lines.length, 4, 'header + 3 membership rows');
  const gammaRow = lines.find((l) => l.includes(GAMMA));
  assert.ok(gammaRow, 'gamma row present');
  assert.ok(gammaRow.includes('FAILED_FINAL'));
  assert.ok(gammaRow.includes('PROVIDER_ERROR'));
  assert.ok(gammaRow.includes(',2,'), 'attempts=2 round-trips');

  await app.close();
});

test('BR-B5 S2: report 404 (unknown cycle) + 400 (bad id) + 409 (non-terminal, service-level)', async () => {
  const { app, db } = await makeApp();
  const op = await login(app, 'op1');

  const r404 = await app.inject({ method: 'GET', url: '/api/batch-reports/99999999-9999-4999-8999-999999999999', headers: { cookie: op } });
  assert.equal(r404.statusCode, 404);
  assert.equal(r404.json().error.code, 'CYCLE_NOT_FOUND');

  const r400 = await app.inject({ method: 'GET', url: '/api/batch-reports/not-a-uuid', headers: { cookie: op } });
  assert.equal(r400.statusCode, 400);
  assert.equal(r400.json().error.code, 'VALIDATION_ERROR');

  // service-level: C1 still has RUNNING + PLANNED → requireTerminal rejects
  const svc = createBatchMetricsService({
    db,
    dockerService: { listContainers: async () => ({ items: [], total: 0 }) },
    redisPing: async () => 'PONG',
    dockerPing: async () => 'PONG',
    log: { debug() {}, warn() {}, error() {} },
  });
  await assert.rejects(
    () => svc.getCycleReport(C1, { requireTerminal: true }),
    (err) => err.apiCode === 'CYCLE_NOT_COMPLETE' && err.statusCode === 409,
  );
  // terminal cycle C2 passes the same gate
  const ok = await svc.getCycleReport(C2, { requireTerminal: true });
  assert.equal(ok.cycleId, C2);

  await app.close();
});

test('BR-B5 S2: RBAC matrix — 401 unauth, viewer 403 on export, operator export ok', async () => {
  const { app } = await makeApp();
  const view = await login(app, 'viewer1');
  const op = await login(app, 'op1');
  const admin = await login(app, 'admin1');

  const urls = [
    '/api/identities',
    `/api/identities/${ALPHA}`,
    '/api/batch-monitor/summary',
    '/api/batches/metrics',
    '/api/batch-reports',
  ];

  // unauthenticated → 401 on every surface
  for (const url of urls) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 401, `${url} unauthenticated`);
    assert.equal(res.json().error.code, 'UNAUTHORIZED');
  }
  const exportUrl = `/api/batch-reports/${C2}`;
  const unauthExport = await app.inject({ method: 'GET', url: exportUrl });
  assert.equal(unauthExport.statusCode, 401);

  // viewer: read-only surfaces ok, export forbidden
  for (const url of urls) {
    const res = await app.inject({ method: 'GET', url, headers: { cookie: view } });
    assert.equal(res.statusCode, 200, `viewer ${url}`);
  }
  const viewExport = await app.inject({ method: 'GET', url: exportUrl, headers: { cookie: view } });
  assert.equal(viewExport.statusCode, 403);
  assert.equal(viewExport.json().error.code, 'FORBIDDEN');

  // operator + admin: export ok
  for (const cookie of [op, admin]) {
    const res = await app.inject({ method: 'GET', url: exportUrl, headers: { cookie } });
    assert.equal(res.statusCode, 200, `export with cookie ${cookie.slice(0, 12)}…`);
  }

  await app.close();
});

test('BR-B5 S2: zero-secret masking — error messages with credential-shaped values', async () => {
  const { app } = await makeApp();
  const view = await login(app, 'viewer1');
  const op = await login(app, 'op1');

  // seed a run whose error message carries a credential-shaped value
  // (direct state push — the fake taskRun.create drops error/time fields)
  const B5 = 'cccccccc-0000-4000-8000-000000000005';
  await dbCreateBatch(app.db, B5, C2, 3);
  await app.db.batchIdentity.create({ data: { batchId: B5, identityId: DELTA, position: 1, status: 'FAILED_FINAL', createdAt: T(100) } });
  app.db.__batchState.taskRuns.push({
    id: 'r9', batchId: B5, identityId: DELTA, status: 'failed', attempt: 1,
    queuedAt: T(10), startedAt: T(10), finishedAt: T(9), durationMs: null, heartbeatAt: null,
    errorCode: 'AUTH_FAILED',
    errorMessage: 'docker login failed: password=hunter2-s3cret-value',
    createdAt: T(10), updatedAt: T(9),
  });

  // monitor task table: value redacted (label kept, value fully erased)
  const sum = await app.inject({ method: 'GET', url: '/api/batch-monitor/summary', headers: { cookie: view } });
  const row = sum.json().tasks.find((t) => t.id === 'r9');
  assert.ok(row, 'r9 in the task table');
  assert.ok(row.lastError.message.includes('password=***'), `masked message: ${row.lastError.message}`);
  assert.ok(!row.lastError.message.includes('hunter2-s3cret-value'), 'raw secret value absent');

  // identity detail lastError: same masking
  const det = await app.inject({ method: 'GET', url: `/api/identities/${DELTA}`, headers: { cookie: view } });
  assert.equal(det.json().lastError.code, 'AUTH_FAILED');
  assert.ok(det.json().lastError.message.includes('***'));
  assert.ok(!det.body.includes('hunter2-s3cret-value'));

  // report export (now terminal cycle C2 + a new batch): whole body clean,
  // the failed member's summary is masked but present (gate did not trip)
  const exp = await app.inject({ method: 'GET', url: `/api/batch-reports/${C2}`, headers: { cookie: op } });
  assert.equal(exp.statusCode, 200, exp.body);
  assert.ok(exp.body.includes('password=***'), 'masked summary in export');
  assert.ok(!exp.body.includes('hunter2-s3cret-value'), 'export body never carries the raw value');
  assert.ok(!exp.body.includes('secret-token-123456'));

  await app.close();
});

test('BR-B5 S2: Docker-down degradation — 200 + nulls, never 500', async () => {
  const { app } = await makeApp({ dockerOpts: { mode: 'daemon-down' } });
  const view = await login(app, 'viewer1');

  const sum = await app.inject({ method: 'GET', url: '/api/batch-monitor/summary', headers: { cookie: view } });
  assert.equal(sum.statusCode, 200, sum.body);
  assert.equal(sum.json().metrics.active_containers, null, 'containers metric degrades to null');
  assert.equal(sum.json().containers.available, false);
  assert.equal(sum.json().capacity.activeContainersNow, null);

  const det = await app.inject({ method: 'GET', url: `/api/identities/${ALPHA}`, headers: { cookie: view } });
  assert.equal(det.statusCode, 200, det.body);
  assert.equal(det.json().container, null, 'container mapping degrades to null');

  // identity data-dir probe still works (fs, not docker)
  assert.equal(det.json().dataDir.exists, true);

  await app.close();
});

// ---------------------------------------------------------------------------

/** Seed a batch row directly (test helper — B2 owns the create route). */
async function dbCreateBatch(db, id, cycleId, batchNo) {
  await db.batch.create({
    data: {
      id, cycleId, batchNo, name: `extra-${batchNo}`, status: 'COMPLETED',
      batchSize: 1, maxActiveContainers: 3, failurePolicy: 'continue',
      createdAt: T(100), startedAt: T(90), finishedAt: T(80),
    },
  });
}

/**
 * Regression (2026-10-21): a db WITHOUT the B1 batch delegates — the plain
 * API fakes every other suite uses — must not make buildApp throw at
 * construction. That throw aborted buildApp before the onClose hook was
 * registered, leaking the real task-queue handle (infinite redis retries,
 * the test process never exited) and failing 9+ pre-existing suites.
 * Degraded mode = zeroed 200s, never 500.
 */
test('BR-B5 S2: non-batch db — buildApp survives, batch routes degrade to zeroed 200s', async (t) => {
  const passwordHash = await hash(PASSWORD, { type: argon2id });
  const db = makeFakeDb({ users: [{ id: 'u-v', username: 'viewer1', passwordHash, role: 'viewer' }] });
  const app = await buildApp({ config: testConfig, db, redis: fakeRedisOk(), docker: makeFakeDockerWrapper({ containers: [] }), taskQueue: makeFakeQueue() });
  t.after(() => app.close());

  const cookie = await login(app, 'viewer1');

  const metrics = await app.inject({ method: 'GET', url: '/api/batches/metrics', headers: { cookie } });
  assert.equal(metrics.statusCode, 200, metrics.body);
  assert.equal(metrics.json().metrics.batch_active_count, 0);
  assert.equal(metrics.json().metrics.active_containers, 0);

  const summary = await app.inject({ method: 'GET', url: '/api/batch-monitor/summary', headers: { cookie } });
  assert.equal(summary.statusCode, 200);
  assert.equal(summary.json().batchProvisioned, false);
  assert.equal(summary.json().currentBatch, null);
  assert.equal(summary.json().tasks.length, 0);

  const cycles = await app.inject({ method: 'GET', url: '/api/batch-reports', headers: { cookie } });
  assert.equal(cycles.statusCode, 200);
  assert.deepEqual(cycles.json().cycles, []);

  // export on a non-provisioned db — RBAC applies first (viewer → 403)
  const exportRes = await app.inject({ method: 'GET', url: `/api/batch-reports/${C2}`, headers: { cookie } });
  assert.equal(exportRes.statusCode, 403, 'viewer cannot export — RBAC before the db probe');
});
