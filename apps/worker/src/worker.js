/**
 * AI/job worker — P1 shell.
 *
 * Hard boundary (施工 MD §4, threat model T1): this process has NO Docker
 * socket, NO host shell. It only talks to Redis (and, from P3, PostgreSQL)
 * plus configured provider endpoints.
 *
 * P1 scope: BullMQ Worker shell on the `ai-tasks` queue + scheduler
 * reconciler placeholder + a localhost-only health endpoint (used by the
 * compose healthcheck). P3 registers real processors (TaskRunService).
 *
 * P1-fix (2026-10-14): the BullMQ `connection` must be the `{ url }` form
 * (see buildRedisConnection in @water-army/shared) and the health probe
 * connection uses bounded retry so one transient failure cannot kill it.
 * The constructors are injectable so the connection shape is covered by a
 * hermetic regression test.
 */
import http from 'node:http';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { Worker as BullMQWorker } from 'bullmq';
import Redis from 'ioredis';
import pino from 'pino';
import { PINO_REDACT_PATHS, buildRedisConnection } from '@water-army/shared';

import { loadWorkerConfig } from './config.js';
import { createSchedulerReconciler } from './scheduler-reconciler.js';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: [...PINO_REDACT_PATHS], censor: '***' },
});

/**
 * Dedicated connection for health probes (BullMQ keeps its own pool).
 *
 * Bounded retry (P1-fix 2026-10-14): the previous `retryStrategy: () => null`
 * permanently killed the probe after ONE transient failure (e.g. Redis
 * restarting) — "Connection is closed." forever, worker "unhealthy" for
 * hours until a manual restart. Linear backoff capped at 5s keeps the probe
 * alive; `maxRetriesPerRequest: 1` keeps each /health ping failing fast
 * instead of hanging the request.
 *
 * The 'error' listener is mandatory, not cosmetic: without it, the first
 * connect failure is an unhandled 'error' EventEmitter event and crashes the
 * whole worker process — which would defeat the retry entirely.
 */
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

export function createHealthServer(healthRedis) {
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
    const ok = redisStatus === 'up';
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        status: ok ? 'ok' : 'degraded',
        dependencies: {
          redis: { status: redisStatus, ...(redisError ? { error: redisError } : {}) },
        },
      }),
    );
  });
}

/**
 * Create the BullMQ Worker for the `ai-tasks` queue.
 *
 * The Worker constructor is injectable (`Worker`) so hermetic regression
 * tests can assert the connection is passed as `{ url }` — a regression to
 * a bare `redis://` string would silently fall back to 127.0.0.1:6379
 * (BullMQ 6 RedisConnection trap, P1-fix incident 2026-10-14).
 */
export function createBullMqWorker(config, { Worker: WorkerCtor = BullMQWorker, log: workerLog = log } = {}) {
  // P1 shell processor: fail loudly instead of silently "completing" work.
  // Nothing enqueues yet (P3), so this path is unreachable in P1 — if it ever
  // fires, the job must be visible as failed, not marked succeeded.
  const worker = new WorkerCtor(
    'ai-tasks',
    async (job) => {
      workerLog.warn({ jobId: job.id, name: job.name }, 'worker P1 shell: no real processors registered');
      throw new Error('P1 worker shell: no processors registered (lands in P3)');
    },
    {
      // MUST be the { url } form — see buildRedisConnection (BullMQ 6 trap).
      connection: buildRedisConnection(config.redisUrl),
      concurrency: config.taskMaxConcurrency,
    },
  );

  worker.on('ready', () => workerLog.info('worker ready (queue: ai-tasks)'));
  worker.on('failed', (job, err) => {
    workerLog.warn({ jobId: job?.id, error: err?.message }, 'job failed');
  });
  worker.on('error', (err) => workerLog.error({ error: err.message }, 'worker error'));
  return worker;
}

/**
 * Wire the full worker (health redis + health server + BullMQ worker +
 * scheduler reconciler) without starting anything. Returns `start()` and
 * `shutdown(signal)`; exported so tests can inspect the wiring.
 */
export function createWorkerApp({
  config = loadWorkerConfig(),
  Worker = BullMQWorker,
  Redis: RedisCtor = Redis,
} = {}) {
  const healthRedis = createHealthRedis(config, { Redis: RedisCtor });
  const healthServer = createHealthServer(healthRedis);
  const worker = createBullMqWorker(config, { Worker });
  const reconciler = createSchedulerReconciler({ log });

  const start = async () => {
    await new Promise((resolve) => healthServer.listen(config.healthPort, config.healthHost, resolve));
    log.info({ port: config.healthPort, host: config.healthHost }, 'worker health endpoint listening');

    // P1: one placeholder pass at boot; P4 schedules this on an interval.
    const result = await reconciler.reconcile();
    log.info({ result }, 'scheduler reconciliation pass complete');
  };

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'worker shutting down');
    try {
      await worker.close();
    } catch { /* best effort */ }
    try {
      await healthRedis.quit();
    } catch { /* best effort */ }
    healthServer.close();
    process.exit(0);
  };

  return { start, shutdown, healthServer, worker, reconciler, healthRedis };
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
