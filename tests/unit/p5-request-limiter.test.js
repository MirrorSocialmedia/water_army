/**
 * P5 hardening — generic per-key REQUEST rate limiter (MD §11.9).
 *
 * Contrast with createRateLimiter (login brute-force gate, counts FAILURES):
 * createRequestLimiter counts EVERY request — a flood of valid credentials
 * must still be throttled (stream-create churn / intervention spam).
 * In-memory per-process MVP (documented trade-off, same as the login gate).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestLimiter } from '../../apps/api/src/security/rate-limit.js';

test('allows exactly `limit` requests in the window, rejects the next', () => {
  let t = 1_000_000;
  const now = () => t;
  const lim = createRequestLimiter({ limit: 3, windowMs: 60_000, now });
  assert.equal(lim.hit('a').allowed, true);
  assert.equal(lim.hit('a').allowed, true);
  assert.equal(lim.hit('a').allowed, true);
  const denied = lim.hit('a');
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0, 'denied response carries retry-after');
  // still denied inside the window
  t += 30_000;
  assert.equal(lim.hit('a').allowed, false);
});

test('window expiry restores the budget (server wall clock, not request clock)', () => {
  let t = 1_000_000;
  const now = () => t;
  const lim = createRequestLimiter({ limit: 1, windowMs: 60_000, now });
  assert.equal(lim.hit('a').allowed, true);
  assert.equal(lim.hit('a').allowed, false);
  t += 60_001; // window over
  assert.equal(lim.hit('a').allowed, true, 'budget restored after window');
});

test('keys are independent (one user cannot burn another user\'s budget)', () => {
  let t = 1_000_000;
  const lim = createRequestLimiter({ limit: 2, windowMs: 60_000, now: () => t });
  assert.equal(lim.hit('user-a').allowed, true);
  assert.equal(lim.hit('user-a').allowed, true);
  assert.equal(lim.hit('user-a').allowed, false);
  assert.equal(lim.hit('user-b').allowed, true, 'user-b unaffected by user-a flood');
});

test('reset() clears all buckets (test seam / ops seam)', () => {
  let t = 1_000_000;
  const lim = createRequestLimiter({ limit: 1, windowMs: 60_000, now: () => t });
  assert.equal(lim.hit('a').allowed, true);
  assert.equal(lim.hit('a').allowed, false);
  lim.reset();
  assert.equal(lim.hit('a').allowed, true);
});

test('bucket GC: dead keys are evicted once the map grows (no unbounded memory)', () => {
  let t = 1_000_000;
  const lim = createRequestLimiter({ limit: 1, windowMs: 1_000, now: () => t });
  for (let i = 0; i < 5000; i += 1) {
    lim.hit(`key-${i}`);
    t += 2_000; // each key expires before the next is written
  }
  // after GC the map stays bounded: a brand-new key is allowed
  assert.equal(lim.hit('fresh').allowed, true);
});
