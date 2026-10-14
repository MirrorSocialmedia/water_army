/**
 * Worker runtime configuration (env-driven, no defaults that hide problems).
 */
export function loadWorkerConfig(env = process.env) {
  const config = {
    nodeEnv: env.NODE_ENV ?? 'production',
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    healthHost: env.WORKER_HEALTH_HOST ?? '127.0.0.1',
    healthPort: Number(env.WORKER_HEALTH_PORT ?? 3001),
    logLevel: env.LOG_LEVEL ?? 'info',
    taskMaxConcurrency: Number(env.TASK_MAX_CONCURRENCY ?? 4),
  };
  if (!Number.isFinite(config.healthPort) || config.healthPort <= 0) {
    throw new Error(`invalid WORKER_HEALTH_PORT: ${env.WORKER_HEALTH_PORT}`);
  }
  if (!Number.isFinite(config.taskMaxConcurrency) || config.taskMaxConcurrency < 1) {
    throw new Error(`invalid TASK_MAX_CONCURRENCY: ${env.TASK_MAX_CONCURRENCY}`);
  }
  return config;
}
