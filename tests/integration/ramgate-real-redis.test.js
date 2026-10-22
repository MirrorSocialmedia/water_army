/**
 * RAM-G1 — real-Redis atomicity & crash-recovery (Phase C scenario 3).
 *
 * ENV-GATED: runs ONLY when RAM_GATE_REAL_REDIS_URL points at a scratch
 * redis (never the user stack's redis). Launch:
 *   sg docker -c "docker run -d --name g1-gate-redis -p 127.0.0.1:16495:6379 redis:7.4.5"
 *   RAM_GATE_REAL_REDIS_URL=redis://127.0.0.1:16495 node tests/integration/ramgate-real-redis.test.js
 *
 * Why real redis: the hermetic fake emulates the Lua semantics single-
 * threaded; this file proves the ACTUAL primitives under true concurrency:
 *   A. 10 concurrent admits (one gate) vs maxParallel=3 → EXACTLY 3 admitted
 *   B. 2 independent gate instances ("2 workers") vs maxParallel=2 →
 *      exactly 2 admitted across BOTH
 *   C. owner-checked release: stale admissionId cannot delete a fresh lease
 *   D. TTL backstop: a crashed holder's lease self-expires
 *   E. crash recovery: reconcile releases the lease of a gone entity
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const URL = process.env.RAM_GATE_REAL_REDIS_URL;

const skipMsg = 'no RAM_GATE_REAL_REDIS_URL (scratch redis not launched) — see file header';

function makeMetrics(memMiB = 30_000) {
  return {
    sample: async () => ({
      ts: Date.now(),
      memAvailableMiB: memMiB,
      memTotalMiB: 94_000,
      memFreeMiB: 2_500,
      swapTotalMiB: 8192,
      swapFreeMiB: 8_100,
      loadAvg: [1, 1, 1],
      source: 'real-redis-test',
    }),
  };
}

async function makeGate(redis, { configPatch = {}, entityState = null, expectedEntities = null } = {}) {
  const { createRamGate } = await import('../../packages/shared/src/ram-gate.js');
  return createRamGate({
    redis,
    metrics: makeMetrics(),
    configSource: async () => (configPatch && Object.keys(configPatch).length ? configPatch : null),
    entityState,
    expectedEntities,
    log: { warn() {}, error: (m) => console.error('[gate]', m), info() {} },
  });
}

test('RAM-G1 real-redis A — single process: 10 concurrent admits vs cap 3 → exactly 3', async (t) => {
  if (!URL) return t.skip(skipMsg);
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(URL, { maxRetriesPerRequest: 1 });
  t.after(async () => {
    await redis.flushdb().catch(() => {});
    redis.disconnect();
  });
  await redis.flushdb();

  const gate = await makeGate(redis, { configPatch: { maxParallel: 3 } });
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => gate.admit({ kind: 'device', entityKey: `s3a-${i}`, source: 'test' })),
  );
  const admitted = results.filter((r) => r.admitted);
  const denied = results.filter((r) => !r.admitted);
  assert.equal(admitted.length, 3, `exactly 3 of 10 concurrent admits pass (got ${admitted.length})`);
  assert.equal(denied.length, 7);
  for (const d of denied) assert.equal(d.reason, 'MAX_PARALLEL');
  assert.equal(await gate.liveCount(), 3, 'exactly 3 leases in the store');
});

test('RAM-G1 real-redis B — two workers (2 gate instances) vs cap 2 → exactly 2 total', async (t) => {
  if (!URL) return t.skip(skipMsg);
  const { default: Redis } = await import('ioredis');
  const r1 = new Redis(URL, { maxRetriesPerRequest: 1 });
  const r2 = new Redis(URL, { maxRetriesPerRequest: 1 });
  t.after(async () => {
    await r1.flushdb().catch(() => {});
    r1.disconnect();
    r2.disconnect();
  });
  await r1.flushdb();

  const g1 = await makeGate(r1, { configPatch: { maxParallel: 2 } });
  const g2 = await makeGate(r2, { configPatch: { maxParallel: 2 } });
  const w1 = Array.from({ length: 5 }, (_, i) => g1.admit({ kind: 'device', entityKey: `s3b-w1-${i}`, source: 'w1' }));
  const w2 = Array.from({ length: 5 }, (_, i) => g2.admit({ kind: 'device', entityKey: `s3b-w2-${i}`, source: 'w2' }));
  const [res1, res2] = await Promise.all([Promise.all(w1), Promise.all(w2)]);
  const admitted = [...res1, ...res2].filter((r) => r.admitted);
  assert.equal(admitted.length, 2, `exactly 2 of 10 cross-worker admits pass (got ${admitted.length})`);
  assert.equal(await g1.liveCount(), 2);
  assert.equal(await g2.liveCount(), 2, 'both workers see the same atomic count');
});

test('RAM-G1 real-redis C — owner-checked release: stale admissionId is a no-op', async (t) => {
  if (!URL) return t.skip(skipMsg);
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(URL, { maxRetriesPerRequest: 1 });
  t.after(async () => {
    await redis.flushdb().catch(() => {});
    redis.disconnect();
  });
  await redis.flushdb();

  const gate = await makeGate(redis);
  const a1 = await gate.admit({ kind: 'device', entityKey: 's3c-dev', source: 'test' });
  assert.equal(a1.admitted, true);
  // a stale stop (crashed-then-restarted entity) tries to release with a
  // DIFFERENT admissionId — must NOT delete the live lease
  const stale = await gate.release({ kind: 'device', entityKey: 's3c-dev', admissionId: 'stale-id-000', reason: 'stop' });
  assert.equal(await gate.liveCount(), 1, 'stale release did not delete the lease');
  void stale;
  const ok = await gate.release({ kind: 'device', entityKey: 's3c-dev', admissionId: a1.admissionId, reason: 'stop' });
  assert.equal(ok.released, true, 'owner-checked release removes its own lease');
  assert.equal(await gate.liveCount(), 0);
});

test('RAM-G1 real-redis D — TTL backstop: crashed holder self-expires', async (t) => {
  if (!URL) return t.skip(skipMsg);
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(URL, { maxRetriesPerRequest: 1 });
  t.after(async () => {
    await redis.flushdb().catch(() => {});
    redis.disconnect();
  });
  await redis.flushdb();

  const gate = await makeGate(redis, { configPatch: { leaseTtlMs: 60_000 } });
  const a = await gate.admit({ kind: 'device', entityKey: 's3d-dev', source: 'test' });
  assert.equal(a.admitted, true, JSON.stringify(a));
  assert.equal(await gate.liveCount(), 1);
  // fast-forward the backstop: shrink the lease TTL to 100ms (the mechanism
  // under test is Redis TTL + lazy prune-at-count, not wall-clock waiting)
  await redis.pexpire('ramgate:lease:device:s3d-dev', 100);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await gate.liveCount(), 0, 'lease self-expired via TTL (crash backstop, pruned at count)');
});

test('RAM-G1 real-redis E — crash recovery: reconcile releases a gone entity', async (t) => {
  if (!URL) return t.skip(skipMsg);
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(URL, { maxRetriesPerRequest: 1 });
  t.after(async () => {
    await redis.flushdb().catch(() => {});
    redis.disconnect();
  });
  await redis.flushdb();

  // the crashed worker had admitted s3e-dev; the surviving reconciler sees
  // the entity as GONE (deleted/terminal) → release.
  const gate = await makeGate(redis, {
    entityState: async (lease) => (lease.e === 's3e-dev' ? 'gone' : 'running'),
  });
  await gate.admit({ kind: 'device', entityKey: 's3e-dev', source: 'crashed-worker' });
  assert.equal(await gate.liveCount(), 1);
  const summary = await gate.reconcile();
  assert.equal(summary.released.length, 1, JSON.stringify(summary));
  assert.equal(summary.released[0], 'device:s3e-dev');
  assert.equal(await gate.liveCount(), 0, 'crashed holder\'s lease recovered');
});

if (!URL) {
  test('RAM-G1 real-redis — SKIPPED (env-gated)', () => {
    console.log('# SKIP: ' + skipMsg);
  });
}
