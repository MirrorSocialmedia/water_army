/**
 * Redis client — ioredis with bounded retries. Connection errors must not
 * crash the process: readiness degrades (health/ready reports redis: down)
 * instead of the API going down (施工 MD §15: apps must handle brief outages).
 */
import Redis from 'ioredis';

/**
 * @param {{redisUrl:string}} config
 * @param {{warn:Function}} log pino child logger
 */
export function createRedisClient(config, log) {
  const redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
  redis.on('error', (err) => {
    log?.warn?.({ error: err.message }, 'redis connection error (non-fatal)');
  });
  return redis;
}

/** @param {any} redis */
export async function closeRedis(redis) {
  try {
    await redis?.quit();
  } catch {
    try {
      redis?.disconnect();
    } catch {
      /* best effort */
    }
  }
}
