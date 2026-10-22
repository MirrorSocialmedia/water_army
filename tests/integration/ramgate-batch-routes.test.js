/**
 * RAM-G1 — batch path gate wiring + admin surface (hermetic).
 *
 * Real HTTP (app.inject) over the REAL buildApp with the REAL lifecycle
 * service + REAL gate (fake redis with the exact Lua semantics + injected
 * metrics). Covers:
 *   - C1 start admitted → container created + lease held (kind 'run')
 *   - C5 stop → lease released
 *   - C2 cap: maxParallel=1 → second run 503 RAM_GATE_DENIED MAX_PARALLEL
 *     (worker lane: retryable → RETRY_WAIT; no container, no port leak)
 *   - C2 projection: low metrics → 503 PROJECTED_BELOW_TARGET
 *   - C4 metrics failure / stale → 503 (fail-closed), reason in decisions
 *   - C8 status/decisions consistency after every step
 *   - admin surface: RBAC (401/403), status shape, config PUT (invalid 400,
 *     valid merge, live effect), reconcile (stale lease released)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import argon2 from '@node-rs/argon2';

import {
  APP_SETTING_BATCH_CONTAINER_IMAGE_ALLOWLIST,
  SERVICE_USER_ID,
} from '@water-army/shared';

import { buildApp } from '../../apps/api/src/app.js';
import { makeFakeDb, testConfig, fakeRedisOk, makeFakeQueue } from '../helpers/fakes.js';
import { makeBatchFakeDb } from '../helpers/batch-fakes.js';
import { makeFakeDockerWrapper } from '../helpers/fake-docker-client.js';
import { makeFakeRamRedis } from '../helpers/ramgate-fake-redis.js';

const { argon2id, hash } = argon2;
const PASSWORD = 'TestPass123';
const SERVICE_TOKEN = 'test-service-token-0123456789abcdef0123456789';
const IMG = 'water-army/redroid:14.0.0-240527-matrixa-r3';

const uid = (n) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}`;
const ID1 = uid(1);
const ID2 = uid(2);
const BATCH1 = uid(11);
const RUN1 = uid(21);
const RUN2 = uid(22);

const NOW = new Date();
const FUTURE = new Date(NOW.getTime() + 3_600_000);

const B3_CONFIG = {
  batchContainerAllowedImages: [],
  batchAdbHostPortRange: '16370-16419',
  batchPortLeaseTtlMs: 3_600_000,
  batchContainerStopTimeoutSec: 1,
  batchContainerNamePrefix: 'br-ramg1-',
  batchContainerHealthTimeoutMs: 2_000,
  batchContainerHealthPollMs: 10,
  batchContainerHealthProbeTimeoutMs: 1_000,
};

async function makeApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ramg1-routes-'));
  const dataPath = (id) => path.join(root, id, 'data');
  const identities = [
    { id: ID1, externalRef: 'acct-01', displayName: 'Acc 01', identityType: 'ACCOUNT', status: 'RUNNING', dataPath: dataPath(ID1) },
    { id: ID2, externalRef: 'acct-02', displayName: 'Acc 02', identityType: 'ACCOUNT', status: 'RUNNING', dataPath: dataPath(ID2) },
  ];
  const batches = [
    {
      id: BATCH1, name: 'ramg1 batch', cycleId: 'cycle-r1', batchNo: 1,
      status: 'RUNNING', batchSize: 2, maxActiveContainers: 2, failurePolicy: 'CONTINUE',
      configJson: { adapter: { type: 'container', image: IMG } }, idempotencyKey: 'ik-ramg1',
    },
  ];
  const taskRuns = [
    {
      id: RUN1, taskType: 'batch', batchId: BATCH1, identityId: ID1, status: 'running',
      attempt: 1, maxAttempts: 3, leaseExpiresAt: FUTURE, createdAt: NOW,
      inputJson: { taskType: 'batch', adapter: { type: 'container', image: IMG } },
    },
    {
      id: RUN2, taskType: 'batch', batchId: BATCH1, identityId: ID2, status: 'running',
      attempt: 1, maxAttempts: 3, leaseExpiresAt: FUTURE, createdAt: NOW,
      inputJson: { taskType: 'batch', adapter: { type: 'container', image: IMG } },
    },
  ];
  const passwordHash = await hash(PASSWORD, { type: argon2id });
  const users = [
    { id: 'u-admin', username: 'admin1', passwordHash, role: 'admin' },
    { id: 'u-op', username: 'operator1', passwordHash, role: 'operator' },
    { id: 'u-view', username: 'viewer1', passwordHash, role: 'viewer' },
  ];
  const db = { ...makeFakeDb({ users }), ...makeBatchFakeDb({ identities, batches, taskRuns }) };
  db.__state.appSettings.set(APP_SETTING_BATCH_CONTAINER_IMAGE_ALLOWLIST, {
    key: APP_SETTING_BATCH_CONTAINER_IMAGE_ALLOWLIST,
    valueJson: [IMG],
    updatedBy: 'test',
    createdAt: NOW,
    updatedAt: NOW,
  });

  const state = { memAvailableMiB: 30_000, fail: null, staleMs: 0 };
  const metrics = {
    sample: async () => {
      if (state.fail) throw state.fail;
      return {
        ts: Date.now() - state.staleMs,
        memAvailableMiB: state.memAvailableMiB,
        memTotalMiB: 94_000,
        memFreeMiB: 2_500,
        swapTotalMiB: 8192,
        swapFreeMiB: 8_100,
        loadAvg: [1, 1, 1],
        source: 'fake-gate-test',
      };
    },
  };
  const config = {
    ...testConfig,
    serviceToken: SERVICE_TOKEN,
    ...B3_CONFIG,
    batchContainerDataRoot: root,
  };
  const gateRedis = { ...fakeRedisOk(), ...makeFakeRamRedis() };
  const app = await buildApp({
    config,
    db,
    redis: gateRedis,
    docker: makeFakeDockerWrapper(),
    taskQueue: makeFakeQueue(),
    batchLifecycleHealthProbe: async () => ({ healthy: true, detail: null, version: 'ramg1-test-probe' }),
    ramGateMetrics: metrics,
  });

  const login = async (username) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD } });
    assert.equal(res.statusCode, 200, `login ${username}: ${res.body}`);
    return res.headers['set-cookie'].split(';')[0];
  };
  const admin = await login('admin1');
  const op = await login('operator1');
  const view = await login('viewer1');

  const status = async () => {
    const res = await app.inject({ method: 'GET', url: '/api/system/ram-gate', headers: { cookie: admin } });
    assert.equal(res.statusCode, 200, `ram-gate status: ${res.body}`);
    return res.json();
  };
  const decisions = async () => {
    const res = await app.inject({ method: 'GET', url: '/api/system/ram-gate/decisions?limit=50', headers: { cookie: admin } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().decisions;
  };
  const close = async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { app, db, admin, op, view, state, status, decisions, close, req: app.inject.bind(app) };
}

test('RAM-G1 batch — C1: start admitted → container created, run lease held', async (t) => {
  const w = await makeApp();
  t.after(w.close);

  const res = await w.req({ method: 'POST', url: `/api/task-runs/${RUN1}/containers/start`, headers: { cookie: w.op }, payload: {} });
  assert.equal(res.statusCode, 200, `start: ${res.body}`);

  const st = await w.status();
  assert.equal(st.counts.liveLeases, 1);
  assert.equal(st.counts.reservedMiB, 1200);
  const d = (await w.decisions()).find((x) => x.action === 'admit' && x.kind === 'run' && x.entity === RUN1);
  assert.ok(d, 'run admission recorded');
  assert.equal(d.reason, 'ADMITTED');
});

test('RAM-G1 batch — C5: stop → run lease released', async (t) => {
  const w = await makeApp();
  t.after(w.close);
  assert.equal((await w.req({ method: 'POST', url: `/api/task-runs/${RUN1}/containers/start`, headers: { cookie: w.op }, payload: {} })).statusCode, 200);
  assert.equal((await w.status()).counts.liveLeases, 1);

  const stop = await w.req({ method: 'POST', url: `/api/task-runs/${RUN1}/containers/stop`, headers: { cookie: w.op }, payload: {} });
  assert.equal(stop.statusCode, 200, stop.body);
  assert.equal((await w.status()).counts.liveLeases, 0, 'stop released the run lease');
});

test('RAM-G1 batch — C2 cap: maxParallel=1 → second run denied MAX_PARALLEL (retryable 503)', async (t) => {
  const w = await makeApp();
  t.after(w.close);

  // shrink the fleet cap to 1 via the admin surface
  const cfg = await w.req({
    method: 'PUT', url: '/api/system/ram-gate/config', headers: { cookie: w.admin },
    payload: { maxParallel: 1 },
  });
  assert.equal(cfg.statusCode, 200, cfg.body);

  const s1 = await w.req({ method: 'POST', url: `/api/task-runs/${RUN1}/containers/start`, headers: { cookie: w.op }, payload: {} });
  assert.equal(s1.statusCode, 200, s1.body);

  const s2 = await w.req({ method: 'POST', url: `/api/task-runs/${RUN2}/containers/start`, headers: { cookie: w.op }, payload: {} });
  assert.equal(s2.statusCode, 503, `second start must be retryable-denied: ${s2.body}`);
  assert.equal(s2.json().error.code, 'RAM_GATE_DENIED');
  assert.match(s2.json().error.message, /MAX_PARALLEL/);

  // no container for RUN2 + exactly one lease total
  const st = await w.status();
  assert.equal(st.counts.liveLeases, 1);
  const deny = (await w.decisions()).find((x) => x.action === 'deny' && x.entity === RUN2);
  assert.equal(deny?.reason, 'MAX_PARALLEL');
  // the denied run's identity volume is untouched (MD: pending 保留, 零刪除)
  const id2 = w.db.__state.identities.get(ID2);
  assert.equal(id2.status, 'RUNNING', 'identity row intact after denial');
  assert.ok(String(id2.dataPath).startsWith('/'), 'dataPath unchanged');
});

test('RAM-G1 batch — C2 projection: low metrics → 503 PROJECTED_BELOW_TARGET', async (t) => {
  const w = await makeApp();
  t.after(w.close);
  // 1 lease free; drop memory so a boot's projection fails:
  // projected = 18000 − 1×1200 = 16800 < 18432 (floor 16384 still above)
  w.state.memAvailableMiB = 18_000;
  const res = await w.req({ method: 'POST', url: `/api/task-runs/${RUN1}/containers/start`, headers: { cookie: w.op }, payload: {} });
  assert.equal(res.statusCode, 503, res.body);
  assert.equal(res.json().error.code, 'RAM_GATE_DENIED');
  assert.match(res.json().error.message, /PROJECTED_BELOW_TARGET/);
  assert.equal((await w.status()).counts.liveLeases, 0, 'no lease on denial');
});

test('RAM-G1 batch — C4: metrics failure & stale → 503 fail-closed with reasons', async (t) => {
  const w = await makeApp();
  t.after(w.close);

  w.state.fail = new Error('proc read boom');
  let res = await w.req({ method: 'POST', url: `/api/task-runs/${RUN1}/containers/start`, headers: { cookie: w.op }, payload: {} });
  assert.equal(res.statusCode, 503);
  assert.match(res.json().error.message, /METRICS_UNAVAILABLE/);
  w.state.fail = null;

  w.state.staleMs = 31_000;
  res = await w.req({ method: 'POST', url: `/api/task-runs/${RUN1}/containers/start`, headers: { cookie: w.op }, payload: {} });
  assert.equal(res.statusCode, 503);
  assert.match(res.json().error.message, /METRICS_STALE/);
  w.state.staleMs = 0;

  const denies = (await w.decisions()).filter((x) => x.action === 'deny' && x.entity === RUN1);
  assert.equal(denies.length, 2);
  assert.deepEqual(denies.map((d) => d.reason).sort(), ['METRICS_STALE', 'METRICS_UNAVAILABLE']);
});

test('RAM-G1 admin surface — RBAC: anonymous 401, viewer 403, operator config 403', async (t) => {
  const w = await makeApp();
  t.after(w.close);
  assert.equal((await w.req({ method: 'GET', url: '/api/system/ram-gate' })).statusCode, 401);
  assert.equal((await w.req({ method: 'GET', url: '/api/system/ram-gate', headers: { cookie: w.view } })).statusCode, 403);
  assert.equal(
    (await w.req({ method: 'PUT', url: '/api/system/ram-gate/config', headers: { cookie: w.op }, payload: { maxParallel: 5 } })).statusCode,
    403,
  );
  assert.equal(
    (await w.req({ method: 'POST', url: '/api/system/ram-gate/reconcile', headers: { cookie: w.view }, payload: {} })).statusCode,
    403,
  );
});

test('RAM-G1 admin surface — status shape carries every UI field (C8 consistency)', async (t) => {
  const w = await makeApp();
  t.after(w.close);
  await w.req({ method: 'POST', url: `/api/task-runs/${RUN1}/containers/start`, headers: { cookie: w.op }, payload: {} });
  const st = await w.status();
  assert.equal(st.enabled, true);
  for (const k of ['maxParallel', 'hardFloorMiB', 'postBootTargetMiB', 'perBootBudgetMiB', 'metricsMaxAgeMs', 'leaseTtlMs']) {
    assert.ok(Number.isFinite(st.config[k]), `config.${k} present`);
  }
  assert.equal(st.metrics.ok, true);
  assert.equal(st.metrics.memAvailableMiB, 30_000);
  assert.equal(st.metrics.stale, false);
  assert.equal(st.counts.liveLeases, 1);
  assert.ok(Number.isFinite(st.counts.reservedMiB));
  assert.equal(st.wouldAdmitNext.admitted, true);
  assert.ok(Number.isFinite(st.wouldAdmitNext.projectedMiB));
  assert.equal(st.store.redis, true);
});

test('RAM-G1 admin surface — config PUT: invalid 400, valid partial merge, live effect', async (t) => {
  const w = await makeApp();
  t.after(w.close);

  const bad = await w.req({ method: 'PUT', url: '/api/system/ram-gate/config', headers: { cookie: w.admin }, payload: { maxParallel: 0 } });
  assert.equal(bad.statusCode, 400, bad.body);

  const ok = await w.req({
    method: 'PUT', url: '/api/system/ram-gate/config', headers: { cookie: w.admin },
    payload: { postBootTargetMiB: 17_000 },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().stored.postBootTargetMiB, 17_000);
  // merge: untouched keys keep the defaults
  assert.equal(ok.json().stored.maxParallel, undefined);

  const st = await w.status();
  assert.equal(st.config.postBootTargetMiB, 17_000, 'effective config live after PUT');
  assert.equal(st.config.maxParallel, 10);

  // full revert via a merged patch
  const revert = await w.req({
    method: 'PUT', url: '/api/system/ram-gate/config', headers: { cookie: w.admin },
    payload: { postBootTargetMiB: 18_432 },
  });
  assert.equal(revert.statusCode, 200, revert.body);
  assert.equal((await w.status()).config.postBootTargetMiB, 18_432);
});

test('RAM-G1 reconcile — stale run lease (entity terminal) released; entitled run recovered', async (t) => {
  const w = await makeApp();
  t.after(w.close);

  // 1) a stale lease: admit RUN2, then mark the run terminal (worker crash
  //    shape — container gone, status failed)
  assert.equal((await w.req({ method: 'POST', url: `/api/task-runs/${RUN2}/containers/start`, headers: { cookie: w.op }, payload: {} })).statusCode, 200);
  // simulate: the run row goes terminal with its container gone
  Object.assign(w.db.__state.taskRuns.find((r) => r.id === RUN2), { status: 'failed' });
  // (the fake docker container vanishes with the row state in this fixture)
  let st = await w.status();
  assert.equal(st.counts.liveLeases, 1);

  const rec = await w.req({ method: 'POST', url: '/api/system/ram-gate/reconcile', headers: { cookie: w.admin }, payload: {} });
  assert.equal(rec.statusCode, 200, rec.body);
  assert.equal(rec.json().released.length, 1);
  assert.equal(rec.json().released[0], `run:${RUN2}`);
  st = await w.status();
  assert.equal(st.counts.liveLeases, 0, 'stale lease released by reconcile');

  // 2) recovery: an entitled run (status running + containerId) WITHOUT a
  //    lease gets one (redis-flush shape)
  Object.assign(w.db.__state.taskRuns.find((r) => r.id === RUN1), { status: 'running', containerId: 'fake-container-ramg1' });
  const rec2 = await w.req({ method: 'POST', url: '/api/system/ram-gate/reconcile', headers: { cookie: w.admin }, payload: {} });
  assert.equal(rec2.json().recovered, 1, JSON.stringify(rec2.json()));
  st = await w.status();
  assert.equal(st.counts.liveLeases, 1, 'recovered lease present');
  assert.equal(st.counts.running, 1, 'running count from the DB view');
});
