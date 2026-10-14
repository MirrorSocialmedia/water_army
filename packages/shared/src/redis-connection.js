/**
 * BullMQ connection helper (moved out of index.js in P4 — task-queue.js
 * needs it without a circular import through the barrel).
 */

/**
 * Build BullMQ `connection` options from a redis:// URL.
 *
 * Trap (P1-fix incident 2026-10-14): BullMQ 6's RedisConnection only honours
 * a `url` key. Passing a bare `redis://...` string gets `Object.assign`'d into
 * char-index keys ('0':'r', '1':'e', ...), so the connection silently falls
 * back to the 127.0.0.1:6379 default — the worker ECONNREFUSED-loops forever
 * even though REDIS_URL is correct. Always route Worker/Queue connections
 * through this helper (worker today, api-side Queue in P3).
 *
 * @param {string} redisUrl - redis:// or rediss:// connection string
 * @returns {{ url: string }} BullMQ connection options (url key form)
 */
export function buildRedisConnection(redisUrl) {
  if (typeof redisUrl !== 'string' || !/^rediss?:\/\//.test(redisUrl)) {
    throw new TypeError(
      `buildRedisConnection: expected a redis:// or rediss:// URL, got: ${String(redisUrl)}`,
    );
  }
  return { url: redisUrl };
}
