/**
 * F-RDFA-3 (WA-RDFA-FIX S3) — boot-health window defaults + the API/worker
 * relationship, pinned hermetically.
 *
 * Why: the old code defaults were mock-calibrated (api 60s window, worker
 * 120s client). Real MTG boots (2026-10-28, docs/audits/realdevice-final/p2/):
 * single boot ≈115-125s (v6: HEALTH_TIMEOUT at the 60s default), 3 concurrent
 * boots >120s (v8, p2-43: worker TOOL_TIMEOUT at t+120s → attempt-2 adopt
 * 304 already-started). The worker client must NEVER time out before the
 * API's window closes, or the adoption path double-fails (v8 shape).
 *
 * The values now live in one place (shared batch-constants.js) and the worker
 * default is DERIVED from the API window, so this test pins:
 *   - both defaults ≥ 180s (work-order floor)
 *   - worker client ≥ api window + 30s margin
 *   - api loadConfig default + env override
 *   - worker adapter default observed through the real client seam
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BATCH_BOOT_HEALTH_WINDOW_MS,
  BATCH_LIFECYCLE_CLIENT_TIMEOUT_MS,
} from '../../packages/shared/src/batch-constants.js';
import { loadConfig } from '../../apps/api/src/config.js';
import { createContainerAdapter } from '../../apps/worker/src/container-adapter.js';

// --- hermetic loadConfig (same pattern as redroid-boot-timeout-config.test.js)
const base = {
  DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:5432/water_army_test',
  REDIS_URL: 'redis://127.0.0.1:6379',
  SESSION_SECRET: 'ci-test-session-secret-0000000000000000000000000000000',
  APP_ENCRYPTION_KEY: 'ci-test-encryption-key-0000000000000000000000000000000',
};
const cfg = (env = {}) => loadConfig({ ...base, ...env }, { envFile: false });

test('window: both defaults ≥ 180s (work-order floor)', () => {
  assert.ok(BATCH_BOOT_HEALTH_WINDOW_MS >= 180_000, 'api window ≥ 180s');
  assert.ok(BATCH_LIFECYCLE_CLIENT_TIMEOUT_MS >= 180_000, 'worker client ≥ 180s');
});

test('window: worker client ≥ api window + 30s margin (v8 304-double-fail shape)', () => {
  assert.ok(
    BATCH_LIFECYCLE_CLIENT_TIMEOUT_MS >= BATCH_BOOT_HEALTH_WINDOW_MS + 30_000,
    `worker ${BATCH_LIFECYCLE_CLIENT_TIMEOUT_MS} must be ≥ api ${BATCH_BOOT_HEALTH_WINDOW_MS} + 30s`,
  );
});

test('window: calibrated values — api 300s, worker 360s (real MTG boot 115-125s, 3-concurrent >120s)', () => {
  assert.equal(BATCH_BOOT_HEALTH_WINDOW_MS, 300_000);
  assert.equal(BATCH_LIFECYCLE_CLIENT_TIMEOUT_MS, 360_000);
});

test('window: api loadConfig default = 300s; env override still works', () => {
  assert.equal(cfg().batchContainerHealthTimeoutMs, 300_000, 'code default 300s (was mock-calibrated 60s)');
  assert.equal(cfg({ BATCH_CONTAINER_HEALTH_TIMEOUT_MS: '450000' }).batchContainerHealthTimeoutMs, 450_000);
});

test('window: worker adapter default = 360s (observed through the real client seam)', async () => {
  const RUN = '22222222-2222-4222-8222-222222222222';
  const calls = [];
  const api = {
    async batchContainersStart(runId, opts) {
      calls.push({ op: 'start', runId, opts });
      return { containerId: 'container0002', hostPort: 16302, adopted: false };
    },
    async batchContainersHealth() {
      return { healthy: true, state: 'running' };
    },
    async batchContainersStop() {
      return { stopped: true };
    },
  };
  const adapter = createContainerAdapter({
    api,
    env: { CONTAINER_ADAPTER_HOLD_MS: '200', CONTAINER_ADAPTER_HEALTH_POLL_MS: '500' },
    log: { warn() {}, info() {} },
  });
  await adapter.run({ runId: RUN, signal: new AbortController().signal });
  assert.equal(calls[0].opts?.timeoutMs, 360_000, 'start rides the 360s default (no env)');
});
