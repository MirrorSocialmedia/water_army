/**
 * In-memory sliding-window rate limiter (dependency-free).
 *
 * Scope: per-IP login throttling (施工 MD §13.2 "basic rate limit").
 * MVP note: state is per-process — a container restart resets counters.
 * That is acceptable for P1; a shared (Redis) limiter can slot in later
 * without touching call sites.
 */
export function createRateLimiter({ limit = 5, windowMs = 60_000, now = () => Date.now() } = {}) {
  const buckets = new Map();

  /**
   * @param {string} key bucket key (e.g. client IP)
   * @returns {{allowed:boolean, retryAfterMs:number}}
   */
  return function check(key) {
    const t = now();
    let bucket = buckets.get(key);
    if (!bucket || t >= bucket.resetAt) {
      bucket = { count: 0, resetAt: t + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (buckets.size > 4096) {
      for (const [k, v] of buckets) {
        if (t >= v.resetAt) buckets.delete(k);
      }
    }
    if (bucket.count <= limit) {
      return { allowed: true, retryAfterMs: 0 };
    }
    return { allowed: false, retryAfterMs: Math.max(0, bucket.resetAt - t) };
  };
}
