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
 */
import http from 'node:http';
import process from 'node:process';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import pino from 'pino';
import { PINO_REDACT_PATHS } from '@water-army/shared';

import { loadWorkerConfig } from './config.js';
import { createSchedulerReconciler } from './scheduler-reconciler.js';

const config = loadWorkerConfig();
const log = pino({
  level: config.logLevel,
  redact: { paths: [...PINO_REDACT_PATHS], censor: '***' },
});

/** Dedicated connection for health probes (BullMQ keeps its own pool). */
const healthRedis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 1,
  retryStrategy: () => null, // fail fast: health probes must not hang
  lazyConnect: true,
});

let worker = null;
const reconciler = createSchedulerReconciler({ log });

function createHealthServer() {
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

async function main() {
  const healthServer = createHealthServer();
  await new Promise((resolve) => healthServer.listen(config.healthPort, config.healthHost, resolve));
  log.info({ port: config.healthPort, host: config.healthHost }, 'worker health endpoint listening');

  // P1 shell processor: fail loudly instead of silently "completing" work.
  // Nothing enqueues yet (P3), so this path is unreachable in P1 — if it ever
  // fires, the job must be visible as failed, not marked succeeded.
  worker = new Worker(
    'ai-tasks',
    async (job) => {
      log.warn({ jobId: job.id, name: job.name }, 'worker P1 shell: no real processors registered');
      throw new Error('P1 worker shell: no processors registered (lands in P3)');
    },
    { connection: config.redisUrl, concurrency: config.taskMaxConcurrency },
  );

  worker.on('ready', () => log.info('worker ready (queue: ai-tasks)'));
  worker.on('failed', (job, err) => {
    log.warn({ jobId: job?.id, error: err?.message }, 'job failed');
  });
  worker.on('error', (err) => log.error({ error: err.message }, 'worker error'));

  // P1: one placeholder pass at boot; P4 schedules this on an interval.
  const result = await reconciler.reconcile();
  log.info({ result }, 'scheduler reconciliation pass complete');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'worker shutting down');
    try {
      if (worker) await worker.close();
    } catch { /* best effort */ }
    try {
      await healthRedis.quit();
    } catch { /* best effort */ }
    healthServer.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error({ error: err.message, stack: err.stack }, 'worker failed to start');
  process.exit(1);
});
