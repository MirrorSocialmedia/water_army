/**
 * BR-B3 gen2 (S4) — container batch FAULT tests (MD Phase 3 item 5;
 * MD §14.1/§14.3).
 *
 * The strongest hermetic fault surface this repo can express: REAL batch
 * engine (batch-engine.js) + REAL container adapter (container-adapter.js,
 * B3) + REAL API app over the HTTP path (app.inject bridge) + REAL S2
 * lifecycle service + engine-faithful FAKE docker client + REAL fs tmp data
 * root. Only the outer world (docker daemon, redis, queue, postgres) is fake
 * — every protocol, RBAC, lease, audit and state machine on the path is real.
 *
 * Faults covered:
 *   ① startup failure:
 *       - bad image (daemon 404 No such image) → 404 CONTAINER_OP_FAILED →
 *         NON-retryable → identity FAILED_FINAL on the FIRST attempt
 *         (no silent retry-burn, no success claim)
 *       - port pool exhausted (every 163xx port held) → 503 → RETRY_WAIT →
 *         bounded auto-retry to the attempt cap → FAILED_FINAL
 *   ② worker crash (kill -9 aftermath: container running, run still
 *     'running'): the next attempt ADOPTS the orphan container — exactly
 *     ONE createContainer, ONE container for the identity (no double-start)
 *   ③ docker daemon down: FAIL-CLOSED — start/stop/health/list all refuse
 *     with error envelopes (nothing is ever claimed to have happened); the
 *     engine sees 503 → RETRY_WAIT (never success, never silent)
 *   ④ volume retention through failure: a mid-hold health death stops the
 *     container but the identity data dir (the volume) stays intact; the
 *     success path stops (does NOT remove) and frees the port lease
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createBatchScheduler,
  createBatchService,
  createLeaseService,
  createTaskRunService,
  enqueueAnyRun,
  batchJobId,
  BATCH_RUN_JOB_NAME,
  APP_SETTING_BATCH_CONTAINER_IMAGE_ALLOWLIST,
  CONTAINER_LABELS,
  buildContainerLabels,
} from '@water-army/shared';

import { buildApp } from '../../apps/api/src/app.js';
import { makeFakeDb, testConfig, fakeRedisOk, makeFakeQueue } from '../helpers/fakes.js';
import { makeBatchFakeDb } from '../helpers/batch-fakes.js';
import { makeFakeDockerWrapper } from '../helpers/fake-docker-client.js';
import { createBatchEngine, makeInspectEffects } from '../../apps/worker/src/batch-engine.js';
import { createAdapterRegistry } from '../../apps/worker/src/adapter-registry.js';
import { createContainerAdapter } from '../../apps/worker/src/container-adapter.js';
import { createApiClient } from '../../apps/worker/src/tool-helpers.js';

const SERVICE_TOKEN = 'fault-test-service-token-0123456789abcdef0123';
const IMG = 'water-army/redroid:14.0.0-240527-matrixa-r3';
const IMG_GHOST = 'water-army/ghost:0.0.1';

const uid = (n) => `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const B3_KEYS = {
  batchContainerAllowedImages: [],
  batchPortLeaseTtlMs: 3_600_000,
  batchContainerStopTimeoutSec: 1,
  batchContainerNamePrefix: 'br-b3-',
  batchContainerHealthTimeoutMs: 2_000,
  batchContainerHealthPollMs: 10,
  batchContainerHealthProbeTimeoutMs: 1_000,
};

/** fetch impl that routes the worker's HTTP calls into app.inject. */
function injectFetch(app) {
  return async (url, opts = {}) => {
    const u = new URL(String(url));
    const res = await app.inject({
      method: opts.method ?? 'GET',
      url: u.pathname + (u.search ?? ''),
      headers: opts.headers ?? {},
      payload: opts.body ?? undefined,
    });
    return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => res.body };
  };
}

/**
 * @param {object} p
 * @param {object} [p.dockerOpts]   fake docker client opts (mode/containers)
 * @param {object} [p.appConfig]    extra API config overrides (port range…)
 * @param {object} [p.adapterEnv]   container adapter env (hold/poll knobs)
 * @param {string[]} [p.allowlist]  image allowlist entries (default [IMG])
 * @param {boolean} [p.engine]      also build the engine world (default true)
 */
async function makeWorld({ dockerOpts = {}, appConfig = {}, adapterEnv = { CONTAINER_ADAPTER_HOLD_MS: '200' }, allowlist = [IMG], engine = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-br3-faults-'));
  const db = { ...makeFakeDb({}), ...makeBatchFakeDb() };
  db.__state.appSettings.set(APP_SETTING_BATCH_CONTAINER_IMAGE_ALLOWLIST, {
    key: APP_SETTING_BATCH_CONTAINER_IMAGE_ALLOWLIST,
    valueJson: allowlist,
    updatedBy: 'test',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const probeState = { healthy: true, version: 'br3-fault-probe' };
  const probe = async () => ({ healthy: probeState.healthy, detail: null, version: probeState.version });
  const config = {
    ...testConfig,
    serviceToken: SERVICE_TOKEN,
    taskDefaultTimeoutMs: 60_000,
    taskMaxTimeoutMs: 600_000,
    taskDefaultAttempts: 3,
    ...B3_KEYS,
    batchAdbHostPortRange: '16370-16419',
    batchContainerDataRoot: root,
    ...appConfig,
  };
  const docker = makeFakeDockerWrapper(dockerOpts);
  const app = await buildApp({
    config,
    db,
    redis: fakeRedisOk(),
    docker,
    taskQueue: makeFakeQueue(),
    batchLifecycleHealthProbe: probe,
  });

  const world = { root, db, app, docker: docker.client, probeState };
  const logs = [];
  const log = {
    info: (o, m) => logs.push({ level: 'info', o, m }),
    warn: (o, m) => logs.push({ level: 'warn', o, m }),
    error: (o, m) => logs.push({ level: 'error', o, m }),
  };
  world.log = log;
  world.logs = logs;
  let t = Date.now();
  const now = () => new Date(t);
  world.now = now;
  world.batchSvc = createBatchService({ db, log, now, dataRoot: root });

  if (engine) {
    const batchSvc = world.batchSvc;
    const queue = makeFakeQueue();
    const taskSvc = createTaskRunService({
      db, log,
      config: { taskDefaultTimeoutMs: 60_000, taskDefaultAttempts: 3 },
      enqueue: ({ runId, attempt }) => enqueueAnyRun(queue, { db, runId, attempt, timeoutMs: 60_000 }),
    });
    const leaseSvc = createLeaseService({ db, now });
    const adapterRegistry = createAdapterRegistry({ env: { ...adapterEnv }, log });
    const api = createApiClient({ baseUrl: 'http://127.0.0.1:3000', serviceToken: SERVICE_TOKEN, fetchImpl: injectFetch(app), log });
    assert.ok(adapterRegistry.register('container', () => createContainerAdapter({ env: adapterEnv, log, api })), 'container adapter registered');
    const scheduler = createBatchScheduler({
      db, batchSvc, leaseSvc, taskSvc, queue, log, now,
      inspectEffects: makeInspectEffects(adapterRegistry),
      config: { slotTtlMs: 60_000, staleCancelMs: 60_000 },
    });
    const engineSvc = createBatchEngine({
      db, taskSvc, batchSvc, leaseSvc, scheduler, adapterRegistry, networkGate: null, log, now,
      config: {
        batchHeartbeatMs: 1_000,
        batchCancelPollMs: 250,
        batchSlotWaitMs: 1_000,
        batchSlotTtlMs: 60_000,
        batchMaxSlotDefers: 3,
        batchDefaultTimeoutMs: 60_000,
      },
    });
    Object.assign(world, { queue, taskSvc, leaseSvc, adapterRegistry, scheduler, engine: engineSvc });
  }
  return world;
}

const closeWorld = (w) => () => {
  fs.rmSync(w.root, { recursive: true, force: true });
  return w.app.close();
};

const serviceInj = (w, method, url, body) =>
  w.app.inject({
    method,
    url,
    headers: { 'x-wa-service-token': SERVICE_TOKEN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });

/** Create a container-batch cycle and dispatch it; returns batch + runs. */
async function seedContainerBatch(w, { identities = 1, maxAttempts = 3, allowlistImage = IMG } = {}) {
  const ids = [];
  for (let i = 0; i < identities; i += 1) {
    const { identity } = await w.batchSvc.createIdentity({
      displayName: `fault-ident-${Math.random().toString(36).slice(2, 8)}-${i}`,
      identityType: 'qa_device',
      user: { id: 'tester' },
    });
    ids.push(identity);
  }
  const res = await w.batchSvc.createCycle(
    {
      name: `fault-${Math.random().toString(36).slice(2, 8)}`,
      idempotencyKey: `fault-${Math.random().toString(36).slice(2, 12)}`,
      identities: ids.map((x) => ({ id: x.id })),
      batchSize: identities,
      maxActiveContainers: identities,
      failurePolicy: 'continue_and_report',
      config: { adapter: { type: 'container', image: allowlistImage }, timeoutSeconds: 60, maxAttempts, interBatchCooldownSeconds: 0 },
    },
    { id: 'tester' },
  );
  const batch = (await w.db.batch.findMany({ where: { cycleId: res.cycleId } }))[0];
  await w.scheduler.startBatch({ batchId: batch.id });
  const runs = (await w.db.taskRun.findMany({ where: { batchId: batch.id } })).sort((a, b) => a.createdAt - b.createdAt);
  return { batch, identities: ids, runs };
}

const jobFor = (run) => ({
  id: batchJobId(run.id, run.attempt),
  name: BATCH_RUN_JOB_NAME,
  data: { runId: run.id, attempt: run.attempt, timeoutMs: 60_000, maxAttempts: run.maxAttempts },
  state: 'active',
  async moveToDelayed(ms) { this.state = 'delayed'; },
});

/**
 * Direct-seed helper for the non-engine worlds: one identity (via the real
 * batch service, so dataPath is canonical), one container-spec batch, one
 * 'running' run with a live lease — the shape the S2 lifecycle serves.
 * runId must be UUID-shaped (the routes validate it).
 */
async function seedRunningRun(w, { id, image = IMG } = {}) {
  const { identity } = await w.batchSvc.createIdentity({
    displayName: `direct-${id}`, identityType: 'qa_device', user: { id: 'tester' },
  });
  const batchId = uid(id + 1000);
  await w.db.batch.create({
    data: {
      id: batchId, name: `direct-batch-${id}`, cycleId: uid(id + 2000), batchNo: 1, status: 'RUNNING',
      batchSize: 1, maxActiveContainers: 1, failurePolicy: 'CONTINUE',
      configJson: { adapter: { type: 'container', image } }, idempotencyKey: `ik-${id}`,
    },
  });
  const runId = uid(id);
  await w.db.taskRun.create({
    data: {
      id: runId, taskType: 'batch', batchId, identityId: identity.id, status: 'running',
      attempt: 1, maxAttempts: 3, leaseExpiresAt: new Date(Date.now() + 3_600_000), createdAt: new Date(),
      inputJson: { taskType: 'batch', adapter: { type: 'container', image } },
    },
  });
  return { identity, batchId, runId };
}

// ============================================================================
test('S4① bad image → 404 → NON-retryable: identity FAILED_FINAL on the FIRST attempt (no silent retry-burn)', async (t) => {
  const w = await makeWorld({ allowlist: [IMG, IMG_GHOST] });
  t.after(closeWorld(w));
  // The image IS allowlisted, so the API lets it through — and the daemon's
  // definitive 404 for a missing image reference is what fails the start
  // (dockerode wording — R5 live evidence shape).
  const origCreate = w.docker.createContainer.bind(w.docker);
  w.docker.createContainer = async (cfg) => {
    w.docker.__calls.push({ method: 'createContainer', id: null, opts: cfg });
    void origCreate;
    const e = new Error(`(HTTP code 404) no such container - No such image: ${IMG_GHOST}`);
    e.statusCode = 404;
    throw e;
  };
  const { runs, identities } = await seedContainerBatch(w, { identities: 1, allowlistImage: IMG_GHOST });
  const run = runs[0];
  const outcome = await w.engine.handleBatchJob(jobFor(run));
  assert.equal(outcome.outcome, 'failed-final', 'a bad image is a permanent config error — no auto-retry');

  const after = await w.db.taskRun.findUnique({ where: { id: run.id } });
  assert.equal(after.status, 'failed');
  assert.equal(after.errorCode, 'CONTAINER_OP_FAILED');
  assert.match(after.errorMessage, /Image not found/i);

  const ident = await w.db.identity.findUnique({ where: { id: identities[0].id } });
  assert.equal(ident.status, 'FAILED_FINAL', 'permanent failure → FAILED_FINAL (manual re-try only)');

  // nothing was re-enqueued, and the create happened exactly once
  const retryJobs = w.queue.enqueued.filter((j) => j.name === BATCH_RUN_JOB_NAME && (j.data?.attempt ?? 1) > 1);
  assert.equal(retryJobs.length, 0, 'no auto-retry job for a permanent failure');
  assert.equal(w.docker.__calls.filter((c) => c.method === 'createContainer').length, 1);
});

test('S4① port pool exhausted → 503 → RETRY_WAIT → bounded auto-retry → FAILED_FINAL at the cap', async (t) => {
  const w = await makeWorld({ appConfig: { batchAdbHostPortRange: '16370-16370' } }); // pool of 1
  t.after(closeWorld(w));
  // The only 163xx port is already held by another live managed container
  // (another identity's run) — the collision the pre-check must see.
  w.docker.__register({
    name: 'br-b3-occupier',
    state: 'running',
    labels: buildContainerLabels({ identityId: uid(72), batchId: uid(73), taskRunId: uid(71), createdBy: 'test' }),
    portBindings: { '5555/tcp': [{ HostIp: '127.0.0.1', HostPort: '16370' }] },
  });

  const { runs, identities } = await seedContainerBatch(w, { identities: 1, maxAttempts: 2 });
  const run = runs[0];

  // attempt 1 → 503 → RETRY_WAIT + an auto-retry job (attempt 2 queued)
  let outcome = await w.engine.handleBatchJob(jobFor(run));
  assert.equal(outcome.outcome, 'auto-retry', 'a port collision is transient — RETRY_WAIT, not FAILED_FINAL');
  let after = await w.db.taskRun.findUnique({ where: { id: run.id } });
  assert.equal(after.attempt, 2, 'requestRetry bumped the attempt + re-queued');
  assert.equal((await w.db.identity.findUnique({ where: { id: identities[0].id } })).status, 'RETRY_WAIT', 'identity honestly parked in RETRY_WAIT');
  assert.ok(w.queue.enqueued.some((j) => j.name === BATCH_RUN_JOB_NAME && (j.data?.attempt ?? 1) === 2), 'the auto-retry job (attempt 2) was enqueued');

  // attempt 2 → same collision → cap reached → FAILED_FINAL
  outcome = await w.engine.handleBatchJob(jobFor({ ...run, attempt: 2 }));
  assert.equal(outcome.outcome, 'failed-final');
  after = await w.db.taskRun.findUnique({ where: { id: run.id } });
  assert.equal(after.status, 'failed');
  assert.equal(after.attempt, 2);
  assert.equal(after.errorCode, 'PORT_POOL_EXHAUSTED');
  assert.equal((await w.db.identity.findUnique({ where: { id: identities[0].id } })).status, 'FAILED_FINAL', 'at the attempt cap the identity is FAILED_FINAL (never stuck in RETRY_WAIT)');
  // no container was ever created (the pre-check refuses before create)
  assert.equal(w.docker.__calls.filter((c) => c.method === 'createContainer').length, 0);
});

test('S4② worker crash (kill -9 aftermath) → the next attempt ADOPTS the orphan: one create, one container, run completes', async (t) => {
  const w = await makeWorld({ engine: false });
  t.after(closeWorld(w));
  const { identity, runId } = await seedRunningRun(w, { id: 101 });
  const api = createApiClient({ baseUrl: 'http://127.0.0.1:3000', serviceToken: SERVICE_TOKEN, fetchImpl: injectFetch(w.app), log: w.log });
  const env = { CONTAINER_ADAPTER_HOLD_MS: '200', CONTAINER_ADAPTER_HEALTH_POLL_MS: '500' };

  // --- attempt 1: the worker starts the container (the normal first step)…
  const startRes = await serviceInj(w, 'POST', `/api/task-runs/${runId}/containers/start`, {});
  assert.equal(startRes.statusCode, 200, startRes.body);
  const orphanId = JSON.parse(startRes.body).containerId;
  assert.equal((await w.docker.getContainer(orphanId).inspect()).State.Status, 'running');
  assert.equal(w.docker.__calls.filter((c) => c.method === 'createContainer').length, 1, 'attempt 1 creates exactly one container');

  // …then the worker process is KILL -9'd mid-hold: no finally, no stop.
  // The container keeps running and the run row still says "running" —
  // exactly the aftermath a real kill leaves (the G8 regression shape).

  // --- attempt 2: a FRESH worker process (fresh adapter instance, as a new
  // worker replica would be) picks the same run up again.
  const second = createContainerAdapter({ env, log: w.log, api });
  const start2 = await second.run({ runId, signal: new AbortController().signal });
  assert.equal(start2.resultJson.adopted, true, 'attempt 2 ADOPTS the crash-window container');
  assert.equal(start2.resultJson.containerId, orphanId, 'same container — no double-start');
  assert.equal(w.docker.__calls.filter((c) => c.method === 'createContainer').length, 1, 'the adopter did NOT re-create (still exactly one create)');

  // docker side: one container for the run, now stopped (volume kept)
  // by the adopter's clean completion.
  const info = await w.docker.getContainer(orphanId).inspect();
  assert.equal(info.State.Status, 'exited', 'the adopter completed the hold and released the slot');
  const list = await serviceInj(w, 'GET', '/api/batch-containers');
  const rows = JSON.parse(list.body).containers.filter((c) => c.identityId === identity.id);
  assert.equal(rows.length, 1, 'one container for the identity, never two');

  // the volume survived the whole crash cycle
  assert.ok(fs.existsSync(identity.dataPath), 'the identity data dir is intact');
});

test('S4③ docker daemon down → FAIL-CLOSED: no op is ever claimed as success', async (t) => {
  const w = await makeWorld({ dockerOpts: { mode: 'daemon-down' }, engine: false });
  t.after(closeWorld(w));
  const { identity, batchId, runId } = await seedRunningRun(w, { id: 111 });

  // A bound, running container that the dead daemon used to know (labels +
  // DB bind both agree) — the hardest case: stop must not CLAIM success it
  // cannot verify.
  const seedId = w.docker.__register({
    name: 'br-b3-daemon-bound',
    state: 'running',
    labels: buildContainerLabels({ identityId: identity.id, batchId: batchId, taskRunId: runId, createdBy: 'test' }),
    portBindings: { '5555/tcp': [{ HostIp: '127.0.0.1', HostPort: '16371' }] },
  });
  await w.db.taskRun.update({ where: { id: runId }, data: { containerId: seedId } });

  // every op that needs the daemon refuses with an error envelope
  const start = await serviceInj(w, 'POST', `/api/task-runs/${runId}/containers/start`, {});
  assert.equal(start.statusCode, 503, `start must fail closed (got ${start.statusCode}: ${start.body})`);
  assert.match(JSON.parse(start.body).error.message, /daemon unavailable|failing closed/i);
  const list = await serviceInj(w, 'GET', '/api/batch-containers');
  assert.equal(list.statusCode, 503, 'the inventory is UNKNOWN — not an empty success');
  const health = await serviceInj(w, 'GET', `/api/task-runs/${runId}/containers/health`);
  assert.ok(health.statusCode >= 500, `health must be UNKNOWN when the daemon is silent (got ${health.statusCode})`);
  const stop = await serviceInj(w, 'POST', `/api/task-runs/${runId}/containers/stop`, {});
  assert.ok(stop.statusCode >= 500, `stop must not return a fake success (got ${stop.statusCode}: ${stop.body})`);

  // the container was NOT touched by any of the refusals (check the fake's
  // internal state — even `inspect` is fail-closed while the daemon is down)
  assert.equal(w.docker.__byId.get(seedId).inspect.State.Status, 'running', 'refusals never touch the container');

  // the adapter (worker side) surfaces it as a 503 AdapterError — the run
  // can never claim success
  const api = createApiClient({ baseUrl: 'http://127.0.0.1:3000', serviceToken: SERVICE_TOKEN, fetchImpl: injectFetch(w.app), log: w.log });
  const adapter = createContainerAdapter({ env: { CONTAINER_ADAPTER_HOLD_MS: '200' }, log: w.log, api });
  await assert.rejects(
    adapter.run({ runId, signal: new AbortController().signal }),
    (err) => err.name === 'AdapterError' && err.status === 503 && /daemon unavailable|failing closed/i.test(err.message),
    'the run must fail closed when the daemon does not answer',
  );

  // and through the REAL engine: 503 → RETRY_WAIT (honest — the daemon may
  // come back), never success, never silent
  const w2 = await makeWorld({ dockerOpts: { mode: 'daemon-down' } });
  t.after(closeWorld(w2));
  const seed = await seedContainerBatch(w2);
  const outcome = await w2.engine.handleBatchJob(jobFor(seed.runs[0]));
  assert.equal(outcome.outcome, 'auto-retry', 'daemon-down is a TRANSIENT failure (RETRY_WAIT), never success');
  assert.equal((await w2.db.identity.findUnique({ where: { id: seed.identities[0].id } })).status, 'RETRY_WAIT');
});

test('S4④ volume retention through failure: mid-hold health death stops the container, the VOLUME stays', async (t) => {
  const w = await makeWorld({ engine: false });
  t.after(closeWorld(w));
  const { identity, runId } = await seedRunningRun(w, { id: 121 });
  // "app work" wrote identity state into the volume before the device died
  fs.mkdirSync(identity.dataPath, { recursive: true, mode: 0o700 });
  const marker = path.join(identity.dataPath, 'identity-state.json');
  fs.writeFileSync(marker, JSON.stringify({ identity: identity.id, note: 'must survive the device death' }), { mode: 0o600 });

  const api = createApiClient({ baseUrl: 'http://127.0.0.1:3000', serviceToken: SERVICE_TOKEN, fetchImpl: injectFetch(w.app), log: w.log });
  const adapter = createContainerAdapter({ env: { CONTAINER_ADAPTER_HOLD_MS: '1500', CONTAINER_ADAPTER_HEALTH_POLL_MS: '500' }, log: w.log, api });

  // healthy at start, dead by the 2nd in-hold re-probe (device wedged)
  const timer = setTimeout(() => { w.probeState.healthy = false; }, 700);
  try {
    await assert.rejects(
      adapter.run({ runId, signal: new AbortController().signal }),
      (err) => err.name === 'AdapterError' && err.apiCode === 'CONTAINER_UNHEALTHY' && err.status === 503 && err.retryable === true,
      'a mid-hold health death is a RETRYABLE adapter failure',
    );
  } finally {
    clearTimeout(timer);
  }

  // the container was stopped (slot freed) — but the VOLUME is intact
  const run = await w.db.taskRun.findUnique({ where: { id: runId } });
  assert.ok(run.containerId, 'the containerId stays bound (reconcile/cleanup can verify it)');
  const info = await w.docker.getContainer(run.containerId).inspect();
  assert.equal(info.State.Status, 'exited', 'the dead device was stopped (not left burning a port)');
  assert.ok(fs.existsSync(marker), 'the identity data (the volume) SURVIVED the device death');
  const leases = await w.db.resourceLease.findMany({ where: { resourceType: 'port' } });
  assert.equal(leases.length, 0, 'the port lease was released with the container');
});

test('S4 (contract): the full happy loop — engine → adapter → API → start/hold/stop → identity COMPLETED, volume kept, lease freed', async (t) => {
  const w = await makeWorld({ adapterEnv: { CONTAINER_ADAPTER_HOLD_MS: '300', CONTAINER_ADAPTER_HEALTH_POLL_MS: '500' } });
  t.after(closeWorld(w));
  const { identities, runs } = await seedContainerBatch(w, { identities: 1 });
  const run = runs[0];

  const outcome = await w.engine.handleBatchJob(jobFor(run));
  assert.equal(outcome.outcome, 'succeeded', `engine outcome: ${JSON.stringify(outcome)}`);

  const after = await w.db.taskRun.findUnique({ where: { id: run.id } });
  assert.equal(after.status, 'succeeded');
  assert.ok(after.resultJson?.containerId, 'the result carries the containerId (MD §6.2 receipt)');
  assert.equal(after.resultJson.adopted, false);

  const ident = await w.db.identity.findUnique({ where: { id: identities[0].id } });
  assert.equal(ident.status, 'COMPLETED', 'the identity completed the rotation slot');

  // docker: the container is STOPPED (reversible — the next rotation
  // re-mounts the same volume), NOT removed
  const info = await w.docker.getContainer(after.resultJson.containerId).inspect();
  assert.equal(info.State.Status, 'exited');
  assert.equal(info.Config.Labels[CONTAINER_LABELS.TASK_RUN_ID], run.id);
  assert.equal(info.Config.Labels[CONTAINER_LABELS.IDENTITY_ID], identities[0].id);

  // volume + lease: the whole point of rotation
  assert.ok(fs.existsSync(identities[0].dataPath), 'the identity volume dir survives the stop');
  const marker = path.join(identities[0].dataPath, 'work.json');
  fs.writeFileSync(marker, 'app wrote during the hold'); // the dir is real + writable
  assert.ok(fs.existsSync(marker));
  const leases = await w.db.resourceLease.findMany({ where: { resourceType: 'port' } });
  assert.equal(leases.length, 0, 'the port lease is freed for the next identity');
});
