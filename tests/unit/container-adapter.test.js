/**
 * B6 gen3 — container adapter: probe grace + lifecycle timeouts.
 *
 * E2E run-3: the restart wave's 6 runs ALL went FAILED_FINAL during a ~5s
 * API rolling restart — an in-flight hold's health probe could not REACH
 * the API (transport failure) and the run failed as if the device were
 * dead. A control-plane blip means the device state is UNKNOWN, not dead:
 * consecutive probe TRANSPORT failures now get a bounded grace
 * (CONTAINER_ADAPTER_PROBE_GRACE_MS, default 15s; 0 = legacy fail-fast)
 * before the hold fails RETRYABLE. An unhealthy ANSWER (the API replied)
 * still fails fast — the grace never masks a real device death.
 *
 * E2E run-4: 2/6 broken-image runs ended TOOL_TIMEOUT after the worker's
 * 15s client timeout while the API was still inside its boot-health window.
 * start/stop now ride CONTAINER_ADAPTER_LIFECYCLE_TIMEOUT_MS (default 360s
 * = API window 300s + 60s margin, F-RDFA-3) so a slow boot is filed as the
 * API's honest error.
 *
 * Hermetic: fake api client (records call options), small real timers
 * (health poll floor is 500ms — tests run in ~6s total).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createContainerAdapter } from '../../apps/worker/src/container-adapter.js';
import { AdapterError } from '../../apps/worker/src/adapter-registry.js';

const RUN = '11111111-1111-4111-8111-111111111111';

/** @returns {{api:object, calls:object[]}} */
function makeFakeApi({ probe = () => ({ healthy: true, state: 'running' }) } = {}) {
  const calls = [];
  return {
    calls,
    api: {
      async batchContainersStart(runId, opts) {
        calls.push({ op: 'start', runId, opts });
        return { containerId: 'container0001', hostPort: 16301, adopted: false };
      },
      async batchContainersHealth(runId, opts) {
        calls.push({ op: 'health', runId, opts });
        return probe();
      },
      async batchContainersStop(runId, opts) {
        calls.push({ op: 'stop', runId, opts });
        return { stopped: true };
      },
    },
  };
}

/** Transport-class probe failure (API unreachable — NOT an unhealthy answer). */
const UNREACHABLE = Object.assign(new Error('API unreachable: fetch failed'), {
  name: 'ToolExecutionError',
  apiCode: 'TOOL_UNAVAILABLE',
  statusCode: 503,
});

test('adapter: happy path — holds, counts successful probes, stop rides the lifecycle timeout', async () => {
  const { api, calls } = makeFakeApi();
  const adapter = createContainerAdapter({ api, env: { CONTAINER_ADAPTER_HOLD_MS: '600', CONTAINER_ADAPTER_HEALTH_POLL_MS: '500' }, log: { warn() {}, info() {} } });
  const res = await adapter.run({ runId: RUN, signal: new AbortController().signal });
  assert.match(res.resultText, /container ok/);
  assert.ok(res.resultJson.healthChecks >= 1, 'at least one healthy probe counted');
  const starts = calls.filter((c) => c.op === 'start');
  const stops = calls.filter((c) => c.op === 'stop');
  assert.equal(stops.length, 1, 'success path stops the container (volume kept)');
  // lifecycle timeout (default 360s = API window 300s + margin, F-RDFA-3)
  // must override the 15s client default
  assert.equal(starts[0].opts?.timeoutMs, 360_000, 'start rides the lifecycle timeout');
  assert.equal(stops[0].opts?.timeoutMs, 360_000, 'stop rides the lifecycle timeout');
});

test('adapter: lifecycle timeout is env-configurable', async () => {
  const { api, calls } = makeFakeApi();
  const adapter = createContainerAdapter({
    api,
    env: { CONTAINER_ADAPTER_HOLD_MS: '200', CONTAINER_ADAPTER_HEALTH_POLL_MS: '500', CONTAINER_ADAPTER_LIFECYCLE_TIMEOUT_MS: '60000' },
    log: { warn() {}, info() {} },
  });
  await adapter.run({ runId: RUN, signal: new AbortController().signal });
  assert.equal(calls.find((c) => c.op === 'start').opts?.timeoutMs, 60_000);
});

test('adapter: probe grace — control-plane blip inside the grace window does NOT kill the run', async () => {
  // Blip on the first two probes (1s of API-unreachable), then recovery.
  // Grace 2s > blip 1s → the hold survives; the run succeeds.
  let probes = 0;
  const { api, calls } = makeFakeApi({
    probe: () => {
      probes += 1;
      if (probes <= 2) throw UNREACHABLE;
      return { healthy: true, state: 'running' };
    },
  });
  const adapter = createContainerAdapter({
    api,
    env: { CONTAINER_ADAPTER_HOLD_MS: '2500', CONTAINER_ADAPTER_HEALTH_POLL_MS: '500', CONTAINER_ADAPTER_PROBE_GRACE_MS: '2000' },
    log: { warn() {}, info() {} },
  });
  const res = await adapter.run({ runId: RUN, signal: new AbortController().signal });
  assert.match(res.resultText, /container ok/, 'run survives the 1s control-plane blip');
  assert.equal(res.resultJson.healthChecks, 2, 'only SUCCESSFUL probes are counted as health checks');
  assert.equal(calls.filter((c) => c.op === 'stop').length, 1, 'clean stop at hold end');
});

test('adapter: probe grace exhausted → fail-closed with RETRYABLE CONTAINER_PROBE_UNREACHABLE', async () => {
  // API unreachable for the whole hold (1000ms > grace 1000ms) → the hold
  // must fail (fail-closed preserved) as a retryable 503, and the container
  // gets a best-effort stop.
  const { api, calls } = makeFakeApi({ probe: () => { throw UNREACHABLE; } });
  const adapter = createContainerAdapter({
    api,
    env: { CONTAINER_ADAPTER_HOLD_MS: '4000', CONTAINER_ADAPTER_HEALTH_POLL_MS: '500', CONTAINER_ADAPTER_PROBE_GRACE_MS: '1000' },
    log: { warn() {}, info() {} },
  });
  await assert.rejects(
    () => adapter.run({ runId: RUN, signal: new AbortController().signal }),
    (err) => {
      assert.ok(err instanceof AdapterError, 'AdapterError, not a raw fetch error');
      assert.equal(err.apiCode, 'CONTAINER_PROBE_UNREACHABLE');
      assert.equal(err.status, 503, 'retryable class — the engine auto-retries with backoff');
      assert.equal(err.retryable, true);
      return true;
    },
  );
  assert.equal(calls.filter((c) => c.op === 'stop').length, 1, 'best-effort stop on the failure path');
});

test('adapter: grace=0 → legacy fail-fast on the first transport failure', async () => {
  const { api } = makeFakeApi({ probe: () => { throw UNREACHABLE; } });
  const adapter = createContainerAdapter({
    api,
    env: { CONTAINER_ADAPTER_HOLD_MS: '4000', CONTAINER_ADAPTER_HEALTH_POLL_MS: '500', CONTAINER_ADAPTER_PROBE_GRACE_MS: '0' },
    log: { warn() {}, info() {} },
  });
  await assert.rejects(
    () => adapter.run({ runId: RUN, signal: new AbortController().signal }),
    (err) => err.apiCode === 'CONTAINER_PROBE_UNREACHABLE' && err.retryable === true,
  );
});

test('adapter: unhealthy ANSWER fails fast — the grace never masks a real device death', async () => {
  const { api } = makeFakeApi({ probe: () => ({ healthy: false, state: 'exited' }) });
  const adapter = createContainerAdapter({
    api,
    env: { CONTAINER_ADAPTER_HOLD_MS: '8000', CONTAINER_ADAPTER_HEALTH_POLL_MS: '500', CONTAINER_ADAPTER_PROBE_GRACE_MS: '15000' },
    log: { warn() {}, info() {} },
  });
  const t0 = Date.now();
  await assert.rejects(
    () => adapter.run({ runId: RUN, signal: new AbortController().signal }),
    (err) => {
      assert.equal(err.apiCode, 'CONTAINER_UNHEALTHY', 'unhealthy answer → the pre-existing fast path');
      assert.equal(err.status, 503);
      assert.equal(err.retryable, true);
      return true;
    },
  );
  assert.ok(Date.now() - t0 < 4_000, 'failed on the FIRST probe — no grace wait');
});

test('adapter: an error the API ANSWERED is never masked by the grace (no re-judgement)', async () => {
  // 404 RUN_NOT_FOUND (the API replied) → the original error identity must
  // propagate unchanged — the engine's 4xx-permanent policy applies, and
  // the grace (15s) must NOT swallow it.
  const RUN_GONE = Object.assign(new Error('task run does not exist'), {
    name: 'ToolExecutionError',
    apiCode: 'RUN_NOT_FOUND',
    statusCode: 404,
  });
  const { api } = makeFakeApi({ probe: () => { throw RUN_GONE; } });
  const adapter = createContainerAdapter({
    api,
    env: { CONTAINER_ADAPTER_HOLD_MS: '8000', CONTAINER_ADAPTER_HEALTH_POLL_MS: '500', CONTAINER_ADAPTER_PROBE_GRACE_MS: '15000' },
    log: { warn() {}, info() {} },
  });
  const t0 = Date.now();
  await assert.rejects(
    () => adapter.run({ runId: RUN, signal: new AbortController().signal }),
    (err) => {
      assert.equal(err.apiCode, 'RUN_NOT_FOUND', 'original API error identity preserved');
      assert.equal(err.status, 404, 'permanent class — NOT re-judged retryable');
      return true;
    },
  );
  assert.ok(Date.now() - t0 < 4_000, 'failed on the FIRST probe — no grace wait');
});

test('adapter: abort mid-hold still wins over the grace (cancel propagates)', async () => {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort('cancel test'), 650);
  const { api } = makeFakeApi({ probe: () => { throw UNREACHABLE; } }); // blips, but the abort must win
  const adapter = createContainerAdapter({
    api,
    env: { CONTAINER_ADAPTER_HOLD_MS: '4000', CONTAINER_ADAPTER_HEALTH_POLL_MS: '500', CONTAINER_ADAPTER_PROBE_GRACE_MS: '15000' },
    log: { warn() {}, info() {} },
  });
  await assert.rejects(
    () => adapter.run({ runId: RUN, signal: ctrl.signal }),
    (err) => err.name === 'AbortError',
  );
});
