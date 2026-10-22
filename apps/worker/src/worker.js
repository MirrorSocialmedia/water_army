/**
 * AI/job worker — P3 (施工 MD §17 Phase 3).
 *
 * Hard boundary (施工 MD §4, threat model T1): this process has NO Docker
 * socket, NO host shell. It talks to Redis (BullMQ) + PostgreSQL (task
 * source of truth) + the API over HTTP (tool execution, service token) +
 * configured provider endpoints.
 *
 * P3 scope:
 *   - BullMQ Worker on `ai-tasks` (job name `task-run`, payload {runId, attempt}
 *     — secret-free) driving the task engine (provider chat + tool loop +
 *     approval wait + real-stop cancel + deadline timeout)
 *   - boot-time stale-run reconciliation (MD §12.3: 唔可以靜默丟失任務)
 *   - /health reports redis + QUEUE + db status (P1-fix iron rule: a dead
 *     queue must never read "healthy")
 *
 * P1-fix (2026-10-14) invariants preserved: BullMQ connection is ALWAYS the
 * `{ url }` form via buildRedisConnection(); every ioredis instance has an
 * `error` listener (without one, the first connect failure crashes the
 * process via unhandled EventEmitter 'error').
 */
import http from 'node:http';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { Worker as BullMQWorker } from 'bullmq';
import Redis from 'ioredis';
import pino from 'pino';
import { PINO_REDACT_PATHS, buildRedisConnection, createTaskRunService, TASK_QUEUE_NAME, createTaskQueue, enqueueTaskRun, enqueueAnyRun, closeTaskQueue, SCHEDULE_FIRE_JOB_NAME, createNetworkPolicyGate, BATCH_RUN_JOB_NAME, createBatchService, createLeaseService, createBatchScheduler, createBatchSchedulerLoop } from '@water-army/shared';
import { createAdapterRegistry } from './adapter-registry.js';
import { createContainerAdapter } from './container-adapter.js';
import { createBatchEngine, makeInspectEffects } from './batch-engine.js';

import { loadWorkerConfig } from './config.js';
import { createSchedulerReconciler } from './scheduler-reconciler.js';
import { createScheduleFireHandler } from './schedule-fire-handler.js';
import { createDb, closeDb } from './db.js';
import { resolveProviderForRun } from './provider-resolver.js';
import { createApiClient, createToolHandlers } from './tool-helpers.js';
import { createTaskEngine } from './task-engine.js';
import { createScheduleNotifier } from './schedule-notifier.js';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: [...PINO_REDACT_PATHS], censor: '***' },
});

// Re-exported for tests/other modules (canonical values live in shared).
export { TASK_QUEUE_NAME };

// --------------------------------------------------------------------------
// Health probe redis (P1, unchanged semantics)
// --------------------------------------------------------------------------

export function createHealthRedis(config, { Redis: RedisCtor = Redis } = {}) {
  const healthRedis = new RedisCtor(config.redisUrl, {
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 500, 5000),
    lazyConnect: true,
  });
  healthRedis.on('error', (err) => {
    log.debug({ error: err.message }, 'health redis transient error (probe will retry)');
  });
  return healthRedis;
}

// --------------------------------------------------------------------------
// Queue state — /health must reflect the BullMQ Worker lifecycle
// --------------------------------------------------------------------------

/**
 * Live state derived from BullMQ Worker events (ready/closed/error + job
 * counters). The /health endpoint reports this verbatim so "queue: dead"
 * can never masquerade as healthy (P1 虛報 教訓).
 */
export function createQueueState() {
  return {
    status: 'starting', // starting | connected | error | closed
    lastError: null,
    active: 0,
    waiting: 0,
    delayed: 0,
    completed: 0,
    failed: 0,
  };
}

export function bindQueueState(worker, state, { probeMs = 15_000 } = {}) {
  worker.on('ready', () => {
    state.status = 'connected';
    state.lastError = null;
  });
  worker.on('error', (err) => {
    state.status = 'error';
    state.lastError = err?.message ?? 'unknown';
  });
  worker.on('closed', () => {
    state.status = 'closed';
  });
  // BullMQ 6 emits 'ready' ONCE (one-shot waitUntilReady, verified in
  // dist/cjs/classes/worker.js). After a redis blip the backend
  // auto-reconnects and jobs flow again, but the state would ratchet to
  // 'error' forever (live-verified 2026-10-15: /health 503 + docker
  // unhealthy for 10+ min AFTER recovery, while logs showed jobs
  // completing). While degraded, probe with a real redis round trip.
  const probe = setInterval(async () => {
    if (state.status !== 'error') return;
    try {
      await worker.getJobCounts?.();
      state.status = 'connected';
      state.lastError = null;
    } catch {
      /* still degraded — retry next tick */
    }
  }, probeMs);
  if (typeof probe.unref === 'function') probe.unref();
  return () => clearInterval(probe);
  worker.on('active', () => {
    state.active += 1;
  });
  worker.on('waiting', () => {
    state.waiting += 1;
  });
  worker.on('delayed', () => {
    state.delayed += 1;
  });
  worker.on('completed', () => {
    state.active = Math.max(0, state.active - 1);
    state.waiting = Math.max(0, state.waiting - 1);
    state.delayed = Math.max(0, state.delayed - 1);
    state.completed += 1;
  });
  worker.on('failed', () => {
    state.active = Math.max(0, state.active - 1);
    state.waiting = Math.max(0, state.waiting - 1);
    state.delayed = Math.max(0, state.delayed - 1);
    state.failed += 1;
  });
}

// --------------------------------------------------------------------------
// Health server (redis + queue + db)
// --------------------------------------------------------------------------

export function createHealthServer(healthRedis, getQueueState, getDbStatus) {
  return http.createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
      return;
    }
    let redisStatus = 'down';
    let redisError;
    try {
      await healthRedis.ping();
      redisStatus = 'up';
    } catch (err) {
      redisError = err.message;
    }
    let dbStatus = 'unknown';
    let dbError;
    try {
      dbStatus = (await getDbStatus()) ? 'up' : 'down';
    } catch (err) {
      dbStatus = 'down';
      dbError = err.message;
    }
    const queue = getQueueState();
    const ok = redisStatus === 'up' && queue.status === 'connected' && dbStatus === 'up';
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        status: ok ? 'ok' : 'degraded',
        dependencies: {
          redis: { status: redisStatus, ...(redisError ? { error: redisError } : {}) },
          queue: {
            status: queue.status,
            ...(queue.lastError ? { lastError: queue.lastError } : {}),
            active: queue.active,
            waiting: queue.waiting,
            delayed: queue.delayed,
            completed: queue.completed,
            failed: queue.failed,
          },
          db: { status: dbStatus, ...(dbError ? { error: dbError } : {}) },
        },
      }),
    );
  });
}

// --------------------------------------------------------------------------
// BullMQ worker
// --------------------------------------------------------------------------

/**
 * @param {object} config
 * @param {object} [deps]
 * @param {Function} [deps.Worker]  injectable ctor (tests assert { url } shape)
 * @param {object}   [deps.log]
 * @param {Function} [deps.processor]  job → result (defaults to a loud no-op)
 * @param {object}   [deps.queueState] state object bound to worker events
 * @param {object}   [deps.deferTracker] { budget: Map<string, number> } —
 *   per-job-id artifact BUDGET for jobs the processor knowingly moved to
 *   DELAYED (slot deferral). BullMQ's completion path then fails on the
 *   no-longer-active job and surfaces TWO 'error'/'failed' events per
 *   deferral (observed live: 'Job ... is not in the active state.
 *   moveToFinished' + 'Missing lock for job ...' — exact pairs in E2E
 *   run-4/run-5). Each event consumes one budget; when the budget is
 *   exhausted, further same-id errors are first-class errors again.
 */
export function createBullMqWorker(config, { Worker: WorkerCtor = BullMQWorker, log: workerLog = log, processor, queueState, deferTracker } = {}) {
  const state = queueState ?? createQueueState();
  const deferredBudget = deferTracker?.budget ?? new Map();
  let deferredArtifactCount = 0;
  // BR-B6 (E2E run-4/run-5): the sanctioned slot-defer path calls
  // job.moveToDelayed() from inside the processor; BullMQ's completion
  // handling then fails ('Job ... is not in the active state. moveToFinished'
  // + 'Missing lock for job ...') and surfaces it as worker 'error'. Every
  // deferral emitted TWO error-level lines — a 9-minute run with 196 queued
  // runs and a 1s deferral wait stormed 468k lines. The deferral itself is
  // healthy (run stays QUEUED, holds nothing, re-lands after the delay), so
  // budgeted artifacts are demoted to debug with a running count; anything
  // over budget is still a first-class error.
  const isDeferralArtifact = (err, jobId) => {
    let candidate = jobId;
    if (candidate == null && typeof err?.message === 'string') {
      candidate = err.message.match(/\bJob ([0-9a-zA-Z_-]+)/)?.[1] ?? err.message.match(/Missing lock for job ([0-9a-zA-Z_-]+)/)?.[1] ?? null;
    }
    if (candidate == null) return null;
    const left = (deferredBudget.get(candidate) ?? 0) - 1;
    if (left < 0) return null; // no budget — a real error
    if (left === 0) deferredBudget.delete(candidate);
    else deferredBudget.set(candidate, left);
    return candidate;
  };
  const demote = (candidate, kind) => {
    deferredArtifactCount += 1;
    workerLog.debug?.({ jobId: candidate, deferredArtifacts: deferredArtifactCount, kind }, 'worker noise suppressed: slot-defer completion artifact (job is delayed by design, run stays QUEUED)');
  };
  const worker = new WorkerCtor(
    TASK_QUEUE_NAME,
    processor ??
      (async () => {
        workerLog.error('worker: job received but no task engine wired — failing loudly');
        throw new Error('worker: no task engine wired (P3 regression?)');
      }),
    {
      // MUST be the { url } form — see buildRedisConnection (BullMQ 6 trap).
      connection: buildRedisConnection(config.redisUrl),
      concurrency: config.taskMaxConcurrency,
    },
  );

  const stopStateProbe = bindQueueState(worker, state);
  Object.defineProperty(worker, 'queueStateProbeStop', { value: stopStateProbe });
  worker.on('ready', () => workerLog.info('worker ready (queue: ai-tasks)'));
  worker.on('completed', (job) => {
    workerLog.info?.({ jobId: job?.id, runId: job?.data?.runId }, 'job completed');
  });
  worker.on('failed', (job, err) => {
    const artifact = isDeferralArtifact(err, job?.id);
    if (artifact) return demote(artifact, 'failed');
    workerLog.warn({ jobId: job?.id, runId: job?.data?.runId, error: err?.message }, 'job failed');
  });
  worker.on('error', (err) => {
    const artifact = isDeferralArtifact(err);
    if (artifact) return demote(artifact, 'error');
    workerLog.error({ error: err.message }, 'worker error');
  });
  Object.defineProperty(worker, 'queueState', { value: state });
  return worker;
}

// --------------------------------------------------------------------------
// App wiring
// --------------------------------------------------------------------------

/**
 * Wire the full worker (health redis + db + engine + BullMQ worker + health
 * server + scheduler reconciler) without starting anything. Returns `start()`
 * and `shutdown(signal)`; exported so tests can inspect the wiring.
 *
 * Injectables (hermetic tests): Worker, Redis, db, engine, taskSvc.
 * When `engine` is not injected the REAL engine is built from config
 * (DB-backed TaskRunService + API-over-HTTP tool handlers + provider resolver).
 */
export function createWorkerApp({
  config = loadWorkerConfig(),
  Worker = BullMQWorker,
  Redis: RedisCtor = Redis,
  db: injectedDb,
  engine: injectedEngine,
  taskSvc: injectedSvc,
} = {}) {
  const healthRedis = createHealthRedis(config, { Redis: RedisCtor });
  const queueState = createQueueState();
  // BR-B6 (E2E run-4/run-5): the batch engine's slot-defer path parks the
  // job in DELAYED from inside the processor; BullMQ's completion handling
  // then emits a PAIR of 'error'/'failed' events for the no-longer-active
  // job. The processor budgets two artifact events per deferred job id so
  // createBullMqWorker can demote exactly those (468k error lines per run
  // otherwise); anything over budget stays at error level.
  const deferTracker = { budget: new Map() };

  // P4: the worker is ALSO a producer — schedule fires enqueue task-run jobs
  // through this queue (same queue, same job name; idempotent job ids make
  // it safe). Same iron rules as the API's producer (buildRedisConnection +
  // error listener, both enforced inside createTaskQueue).
  const producerQueue = createTaskQueue(config, log);

  // Mutable holders: in the real main run the DB (and therefore the
  // TaskRunService + engine that need it) only exists after start(). Tests
  // inject db/engine/taskSvc directly and the holders are filled at wiring.
  const dbRef = { client: injectedDb ?? null };
  const svcRef = { impl: injectedSvc ?? null };
  const engineRef = { impl: injectedEngine ?? null };
  // P4: built in start() once the DB exists (tests can read them off the app).
  const reconcilerRef = { impl: null };
  const fireHandlerRef = { impl: null };
  // P6 flag #3: schedule notification writer (terminal scheduled runs → UI badge).
  const notifierRef = { impl: null };
  // BR-B2: batch lane (built in start() once the DB exists, like the engine).
  const batchSvcRef = { impl: null };
  const leaseSvcRef = { impl: null };
  const adapterRegistryRef = { impl: null };
  const batchSchedulerRef = { impl: null };
  const batchSchedulerLoopRef = { impl: null };
  const batchEngineRef = { impl: null };

  const buildRealServices = () => {
    if (!svcRef.impl) {
      svcRef.impl = createTaskRunService({
        db: dbRef.client,
        config: {
          taskDefaultTimeoutMs: config.taskDefaultTimeoutMs,
          taskMaxTimeoutMs: config.taskMaxTimeoutMs,
          taskDefaultAttempts: config.taskDefaultAttempts,
        },
        log,
        // P4: schedule fire → createRun must reach the queue (the worker is
        // the producer for schedule-originated runs). BR-B2: batch-aware
        // router — a batch run re-enqueues as a `batch-run` job, an AI/adhoc
        // run takes the original path unchanged (enqueueAnyRun is a strict
        // superset of enqueueTaskRun; the returned job is ignored here).
        enqueue: async ({ runId, attempt, delayMs }) => {
          // RAM-G2 (E5 finding): delayMs was DROPPED here — batch auto-retries
          // were enqueued at t+0 instead of t+BATCH_RETRY_DELAY_MS, so the
          // maxAttempts budget burned inside one gate-denied window (3
          // attempts in ~30ms at MAX_PARALLEL → FAILED_FINAL). B6 gen3's
          // backoff intent (see enqueueBatchRun) is now honored end-to-end.
          const run = await dbRef.client.taskRun.findUnique({ where: { id: runId } });
          await enqueueAnyRun(producerQueue, { db: dbRef.client, runId, attempt, timeoutMs: run?.inputJson?.timeoutMs, run, delayMs });
        },
      });
    }
    if (!notifierRef.impl) {
      notifierRef.impl = createScheduleNotifier({ db: dbRef.client, log });
    }
    if (!fireHandlerRef.impl) {
      fireHandlerRef.impl = createScheduleFireHandler({
        db: dbRef.client,
        taskSvc: svcRef.impl,
        queue: producerQueue,
        notifier: notifierRef.impl,
        log,
      });
    }
    if (!engineRef.impl) {
      engineRef.impl = createTaskEngine({
        db: dbRef.client,
        taskSvc: svcRef.impl,
        config: {
          taskDefaultTimeoutMs: config.taskDefaultTimeoutMs,
          taskMaxTimeoutMs: config.taskMaxTimeoutMs,
          taskDefaultAttempts: config.taskDefaultAttempts,
          approvalPollMs: config.approvalPollMs,
          cancelPollMs: config.cancelPollMs,
          taskConcurrencyDeferMs: config.taskConcurrencyDeferMs,
          taskConcurrencyMaxDefers: config.taskConcurrencyMaxDefers,
        },
        // BR-B4: network policy gate (MD §5.1/§12) — real allowlist + SSRF
        // hardening, fail-closed (never allow-all; docs/network-policy.md).
        // getDb is lazy: the prisma client only exists after start().
        networkGate: createNetworkPolicyGate({ getDb: () => dbRef.client, env: process.env, config, log }),
        log,
        providerResolver: (args) => resolveProviderForRun({ ...args, env: process.env }),
        toolHandlers: createToolHandlers({
          api: createApiClient({ baseUrl: config.apiInternalUrl, serviceToken: config.workerApiToken }),
          log,
        }),
      });
    }
    // BR-B2: batch lane — services + scheduler + engine. Multi-replica safe
    // by construction (CAS + idempotent enqueue; MD §14.2): every worker may
    // run a scheduler loop; they converge, they never double-dispatch.
    if (!batchSvcRef.impl) {
      batchSvcRef.impl = createBatchService({ db: dbRef.client, log });
    }
    if (!leaseSvcRef.impl) {
      leaseSvcRef.impl = createLeaseService({ db: dbRef.client });
    }
    if (!adapterRegistryRef.impl) {
      const registry = createAdapterRegistry({ env: process.env, log });
      // BR-B3: the container adapter drives containers through the API's
      // lifecycle routes with the service token (the worker has no docker
      // socket, MD §4). Fail closed: without the API credentials the
      // adapter is NOT registered — container batches hit the registry's
      // ADAPTER_NOT_CONFIGURED path instead of guessing.
      if (config.apiInternalUrl && config.workerApiToken) {
        registry.register('container', () =>
          createContainerAdapter({
            env: process.env,
            log,
            api: createApiClient({ baseUrl: config.apiInternalUrl, serviceToken: config.workerApiToken, log }),
          }),
        );
      } else {
        log.warn?.('adapter registry: container adapter NOT registered (API_INTERNAL_URL/WORKER_API_TOKEN unset) — container batches fail closed (ADAPTER_NOT_CONFIGURED)');
      }
      adapterRegistryRef.impl = registry;
    }
    if (!batchSchedulerRef.impl) {
      batchSchedulerRef.impl = createBatchScheduler({
        db: dbRef.client,
        batchSvc: batchSvcRef.impl,
        leaseSvc: leaseSvcRef.impl,
        taskSvc: svcRef.impl,
        queue: producerQueue,
        log,
        inspectEffects: makeInspectEffects(adapterRegistryRef.impl),
        config: { slotTtlMs: config.batchSlotTtlMs, staleCancelMs: 60_000 },
      });
    }
    if (!batchEngineRef.impl) {
      batchEngineRef.impl = createBatchEngine({
        db: dbRef.client,
        taskSvc: svcRef.impl,
        batchSvc: batchSvcRef.impl,
        leaseSvc: leaseSvcRef.impl,
        scheduler: batchSchedulerRef.impl,
        adapterRegistry: adapterRegistryRef.impl,
        // BR-B4: the SAME fail-closed allowlist/SSRF gate the AI engine uses
        // (second, stateless instance — ctx.taskType = 'batch', so an explicit
        // policy.taskTypes.batch === false denies batch runs; unset = allowed).
        networkGate: createNetworkPolicyGate({ getDb: () => dbRef.client, env: process.env, config, log }),
        config: {
          batchHeartbeatMs: config.batchHeartbeatMs,
          batchCancelPollMs: config.batchCancelPollMs,
          batchSlotWaitMs: config.batchSlotWaitMs,
          batchSlotTtlMs: config.batchSlotTtlMs,
          batchMaxSlotDefers: config.batchMaxSlotDefers,
          batchDefaultTimeoutMs: config.batchDefaultTimeoutMs,
          batchRetryDelayMs: config.batchRetryDelayMs,
        },
        log,
      });
    }
  };
  if (dbRef.client && !injectedEngine) buildRealServices();

  const processor = async (job) => {
    // P4: schedule fire jobs share the queue — dispatch by name (fire jobs
    // carry {scheduleId, ...}, never a runId).
    if (job?.name === SCHEDULE_FIRE_JOB_NAME) {
      if (!fireHandlerRef.impl) {
        log.error?.({ jobId: job?.id }, 'worker: fire job received but fire handler not built — failing loudly');
        throw new Error('worker: fire handler not ready');
      }
      return fireHandlerRef.impl.handleFireJob(job);
    }
    // BR-B2: batch-run jobs (global container-slot cap, adapter registry).
    if (job?.name === BATCH_RUN_JOB_NAME) {
      if (!batchEngineRef.impl) {
        log.error?.({ jobId: job?.id }, 'worker: batch job received but batch engine not built — failing loudly');
        throw new Error('worker: batch engine not ready');
      }
      const out = await batchEngineRef.impl.handleBatchJob(job);
      if (out?.outcome === 'slot-deferred' && job?.id != null) {
        // expect the paired completion artifacts for this id (see createBullMqWorker)
        deferTracker.budget.set(job.id, (deferTracker.budget.get(job.id) ?? 0) + 2);
      }
      return out;
    }
    const engineImpl = engineRef.impl;
    if (!engineImpl) {
      log.error({ jobId: job?.id }, 'worker: job received but engine not built yet — failing loudly');
      throw new Error('worker: engine not ready');
    }
    const notifyScheduledTerminal = async (runId) => {
      // P6 flag #3: non-fatal UI notification for terminal scheduled runs
      // (all terminal paths converge here — engine success/timeout/cancel/
      // retry-exhaustion inside handleJob, crash path below).
      if (!runId || !svcRef.impl || !notifierRef.impl) return;
      try {
        const run = await svcRef.impl.loadRun(runId, { mustExist: false });
        if (run) await notifierRef.impl.notifyTerminal(run);
      } catch { /* presentation only — never fail the job */ }
    };
    try {
      const outcome = await engineImpl.handleJob(job);
      await notifyScheduledTerminal(job?.data?.runId);
      return outcome;
    } catch (err) {
      // The engine owns every terminal transition; a throw here is a coding
      // bug. Record it honestly (if the run is still live) and let the job
      // complete — no BullMQ auto-retry (attempts:1): a half-executed run is
      // never silently re-run; the user retries via the API (new attempt).
      log.error({ err, runId: job?.data?.runId, attempt: job?.data?.attempt }, 'engine crashed outside its error handling');
      const runId = job?.data?.runId;
      const attempt = job?.data?.attempt;
      if (runId && svcRef.impl) {
        try {
          await svcRef.impl.finishRun(runId, {
            status: 'failed',
            errorCode: 'ENGINE_CRASH',
            errorMessage: `worker engine crash: ${err?.message}`.slice(0, 1000),
            attempt,
          });
        } catch {
          /* run already terminal — nothing to do */
        }
      }
      await notifyScheduledTerminal(runId);
      return { outcome: 'crash' };
    }
  };

  const worker = createBullMqWorker(config, { Worker, processor, queueState, deferTracker });
  const healthServer = createHealthServer(
    healthRedis,
    () => queueState,
    async () => {
      if (!dbRef.client || !dbRef.client.$queryRaw) return false;
      await dbRef.client.$queryRaw`SELECT 1`;
      return true;
    },
  );

  let dbOwned = false;

  const start = async () => {
    if (!dbRef.client) {
      if (!config.databaseUrl) {
        throw new Error('worker: DATABASE_URL is required (task history is DB-backed, MD §11.2)');
      }
      dbRef.client = await createDb(config);
      dbOwned = true;
      log.info('worker: postgres connected (task source of truth)');
    }
    buildRealServices();

    await new Promise((resolve) => healthServer.listen(config.healthPort, config.healthHost, resolve));
    log.info({ port: config.healthPort, host: config.healthHost }, 'worker health endpoint listening');

    // MD §12.3: boot-time reconciliation — non-terminal runs stranded by a
    // worker crash/queue flush become honest terminal states (retryable).
    const reconciled = await svcRef.impl.reconcileStaleRuns({ staleMs: 10 * 60_000 });
    log.info({ reconciled }, 'boot reconciliation complete');

    // P4 (MD §12.1): scheduler reconcile — boot pass + background cadence.
    // DB is the source of truth; this pass converges the BullMQ index onto it
    // (zero duplicates by same-key upsert; orphans swept).
    if (!reconcilerRef.impl) {
      reconcilerRef.impl = createSchedulerReconciler({ db: dbRef.client, queue: producerQueue, log });
    }
    reconcilerRef.impl.start({ intervalMs: config.scheduleReconcileIntervalMs });
    log.info({ intervalMs: config.scheduleReconcileIntervalMs }, 'scheduler reconciler started (boot pass + background)');

    // BR-B2 (MD §7.1): batch scheduler — boot pass (re-derive dispatch from
    // the DB after a restart) + guarded interval. Multiple workers = multiple
    // replicas: safe by construction (MD §14.2), bounded by CAS + idempotent
    // enqueue; BATCH_SCHEDULER_ENABLED=false can confine scheduling to one
    // designated replica operationally.
    if (config.batchSchedulerEnabled) {
      if (!batchSchedulerLoopRef.impl) {
        batchSchedulerLoopRef.impl = createBatchSchedulerLoop(batchSchedulerRef.impl, {
          intervalMs: config.batchSchedulerIntervalMs,
          log,
        });
      }
      batchSchedulerLoopRef.impl.start();
      log.info({ intervalMs: config.batchSchedulerIntervalMs }, 'batch scheduler started (boot pass + background)');
    } else {
      log.info('batch scheduler disabled (BATCH_SCHEDULER_ENABLED=false) — this replica only executes batch jobs');
    }
  };

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'worker shutting down');
    try {
      reconcilerRef.impl?.stop();
    } catch { /* best effort */ }
    try {
      batchSchedulerLoopRef.impl?.stop();
    } catch { /* best effort */ }
    try {
      worker.queueStateProbeStop?.();
    } catch { /* best effort */ }
    try {
      await worker.close();
    } catch { /* best effort */ }
    try {
      await closeTaskQueue(producerQueue);
    } catch { /* best effort */ }
    try {
      await healthRedis.quit();
    } catch { /* best effort */ }
    if (dbOwned && dbRef.client) await closeDb(dbRef.client);
    healthServer.close();
    process.exit(0);
  };

  return {
    start, shutdown, healthServer, worker, healthRedis, queueState, dbRef, engineRef, svcRef,
    // P4 (test inspection): producer + reconciler + fire handler.
    producerQueue, reconcilerRef, fireHandlerRef,
    // BR-B2 (test inspection): batch lane refs.
    batchSvcRef, leaseSvcRef, adapterRegistryRef, batchSchedulerRef, batchSchedulerLoopRef, batchEngineRef,
  };
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const app = createWorkerApp();
  app.start()
    .catch((err) => {
      log.error({ error: err.message, stack: err.stack }, 'worker failed to start');
      process.exit(1);
    });
  process.on('SIGTERM', () => app.shutdown('SIGTERM'));
  process.on('SIGINT', () => app.shutdown('SIGINT'));
}
