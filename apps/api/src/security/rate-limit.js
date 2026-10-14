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

  function snapshot(key, t) {
    const bucket = buckets.get(key);
    const count = bucket && t < bucket.resetAt ? bucket.count : 0;
    const retryAfterMs = bucket && t < bucket.resetAt ? Math.max(0, bucket.resetAt - t) : 0;
    return count >= limit ? { allowed: false, retryAfterMs } : { allowed: true, retryAfterMs: 0 };
  }

  function gc(t) {
    if (buckets.size > 4096) {
      for (const [k, v] of buckets) {
        if (t >= v.resetAt) buckets.delete(k);
      }
    }
  }

  const limiter = {
    /**
     * Peek without recording (call at request entry). Allowed iff fewer than
     * `limit` failures fall inside the current window.
     * @param {string} key
     * @returns {{allowed:boolean, retryAfterMs:number}}
     */
    check(key) {
      const t = now();
      gc(t);
      return snapshot(key, t);
    },
    /**
     * Record one failed attempt (call on failed logins only — successful
     * logins must not count against the brute-force budget).
     * @param {string} key
     * @returns {{allowed:boolean, retryAfterMs:number}}
     */
    hit(key) {
      const t = now();
      gc(t);
      let bucket = buckets.get(key);
      if (!bucket || t >= bucket.resetAt) {
        bucket = { count: 0, resetAt: t + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      return snapshot(key, t);
    },
    /** Test seam. */
    reset() {
      buckets.clear();
    },
  };
  return limiter;
}
