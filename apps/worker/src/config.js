/**
 * Worker runtime configuration (env-driven, no defaults that hide problems).
 */
export function loadWorkerConfig(env = process.env) {
  const config = {
    nodeEnv: env.NODE_ENV ?? 'production',
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    databaseUrl: env.DATABASE_URL ?? '',
    healthHost: env.WORKER_HEALTH_HOST ?? '127.0.0.1',
    healthPort: Number(env.WORKER_HEALTH_PORT ?? 3001),
    logLevel: env.LOG_LEVEL ?? 'info',
    taskMaxConcurrency: Number(env.TASK_MAX_CONCURRENCY ?? 4),
    /** Task engine defaults (MD §11.2: per-task overridable, capped). */
    taskDefaultTimeoutMs: Number(env.TASK_DEFAULT_TIMEOUT_MS ?? 120_000),
    taskMaxTimeoutMs: Number(env.TASK_MAX_TIMEOUT_MS ?? 900_000),
    taskDefaultAttempts: Number(env.TASK_DEFAULT_ATTEMPTS ?? 3),
    /** Tool execution goes over HTTP to the API (the worker has no Docker socket). */
    apiInternalUrl: env.API_INTERNAL_URL ?? '',
    workerApiToken: env.WORKER_API_TOKEN ?? '',
    /** Poll cadence for cancel + approval (job-internal). */
    cancelPollMs: Number(env.TASK_CANCEL_POLL_MS ?? 1_000),
    approvalPollMs: Number(env.TASK_APPROVAL_POLL_MS ?? 1_000),
  };
  if (!Number.isFinite(config.healthPort) || config.healthPort <= 0) {
    throw new Error(`invalid WORKER_HEALTH_PORT: ${env.WORKER_HEALTH_PORT}`);
  }
  if (!Number.isFinite(config.taskMaxConcurrency) || config.taskMaxConcurrency < 1) {
    throw new Error(`invalid TASK_MAX_CONCURRENCY: ${env.TASK_MAX_CONCURRENCY}`);
  }
  if (!Number.isFinite(config.taskDefaultTimeoutMs) || config.taskDefaultTimeoutMs < 1_000) {
    throw new Error(`invalid TASK_DEFAULT_TIMEOUT_MS: ${env.TASK_DEFAULT_TIMEOUT_MS}`);
  }
  if (!Number.isFinite(config.taskMaxTimeoutMs) || config.taskMaxTimeoutMs < config.taskDefaultTimeoutMs) {
    throw new Error(`invalid TASK_MAX_TIMEOUT_MS: ${env.TASK_MAX_TIMEOUT_MS}`);
  }
  if (!Number.isFinite(config.taskDefaultAttempts) || config.taskDefaultAttempts < 1) {
    throw new Error(`invalid TASK_DEFAULT_ATTEMPTS: ${env.TASK_DEFAULT_ATTEMPTS}`);
  }
  return config;
}
