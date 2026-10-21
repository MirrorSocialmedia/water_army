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
    /** P4: background scheduler reconcile cadence (boot pass is immediate). */
    scheduleReconcileIntervalMs: Number(env.SCHEDULE_RECONCILE_INTERVAL_MS ?? 300_000),
    /** P6 flag #5: concurrency_key mutual exclusion — defer window + cap. */
    taskConcurrencyDeferMs: Number(env.TASK_CONCURRENCY_DEFER_MS ?? 15_000),
    taskConcurrencyMaxDefers: Number(env.TASK_CONCURRENCY_MAX_DEFERS ?? 10),
    /**
     * BR-B2 batch execution (MD §7): heartbeat renews the container-slot
     * lease (ttl must comfortably exceed 2× heartbeat); cancel polling is
     * the "real stop" path; slot deferral is bounded (honest exhaustion).
     */
    batchHeartbeatMs: Number(env.BATCH_HEARTBEAT_MS ?? 10_000),
    batchCancelPollMs: Number(env.BATCH_CANCEL_POLL_MS ?? 2_000),
    batchSlotWaitMs: Number(env.BATCH_SLOT_WAIT_MS ?? 15_000),
    batchSlotTtlMs: Number(env.BATCH_SLOT_TTL_MS ?? 60_000),
    batchMaxSlotDefers: Number(env.BATCH_MAX_SLOT_DEFERS ?? 40),
    batchDefaultTimeoutMs: Number(env.BATCH_DEFAULT_TIMEOUT_MS ?? 120_000),
    /** Scheduler tick cadence (boot pass is immediate) + master switch. */
    batchSchedulerIntervalMs: Number(env.BATCH_SCHEDULER_INTERVAL_MS ?? 5_000),
    batchSchedulerEnabled: env.BATCH_SCHEDULER_ENABLED !== 'false' && env.BATCH_SCHEDULER_ENABLED !== '0',
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
  if (!Number.isFinite(config.scheduleReconcileIntervalMs) || config.scheduleReconcileIntervalMs < 1_000) {
    throw new Error(`invalid SCHEDULE_RECONCILE_INTERVAL_MS: ${env.SCHEDULE_RECONCILE_INTERVAL_MS}`);
  }
  if (!Number.isFinite(config.taskConcurrencyDeferMs) || config.taskConcurrencyDeferMs < 1_000) {
    throw new Error(`invalid TASK_CONCURRENCY_DEFER_MS: ${env.TASK_CONCURRENCY_DEFER_MS}`);
  }
  if (!Number.isFinite(config.taskConcurrencyMaxDefers) || config.taskConcurrencyMaxDefers < 1) {
    throw new Error(`invalid TASK_CONCURRENCY_MAX_DEFERS: ${env.TASK_CONCURRENCY_MAX_DEFERS}`);
  }
  // BR-B2: the slot lease TTL must outlive two missed heartbeats (crash →
  // reconcile window), and the scheduler cadence must stay sane.
  if (!Number.isFinite(config.batchHeartbeatMs) || config.batchHeartbeatMs < 1_000) {
    throw new Error(`invalid BATCH_HEARTBEAT_MS: ${env.BATCH_HEARTBEAT_MS}`);
  }
  if (!Number.isFinite(config.batchSlotTtlMs) || config.batchSlotTtlMs < 2 * config.batchHeartbeatMs) {
    throw new Error(`invalid BATCH_SLOT_TTL_MS: ${env.BATCH_SLOT_TTL_MS} (must be >= 2 x BATCH_HEARTBEAT_MS)`);
  }
  if (!Number.isFinite(config.batchMaxSlotDefers) || config.batchMaxSlotDefers < 1) {
    throw new Error(`invalid BATCH_MAX_SLOT_DEFERS: ${env.BATCH_MAX_SLOT_DEFERS}`);
  }
  if (!Number.isFinite(config.batchSchedulerIntervalMs) || config.batchSchedulerIntervalMs < 1_000) {
    throw new Error(`invalid BATCH_SCHEDULER_INTERVAL_MS: ${env.BATCH_SCHEDULER_INTERVAL_MS}`);
  }
  return config;
}
