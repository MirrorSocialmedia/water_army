import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { bindQueueState } from '../../apps/worker/src/worker.js';

function fakeWorker({ counts = async () => ({ waiting: 0 }) } = {}) {
  const w = new EventEmitter();
  w.getJobCounts = counts;
  return w;
}

// Bug (live-verified 2026-10-15): BullMQ 6 emits 'ready' ONCE (one-shot
// waitUntilReady). After a redis blip the backend auto-reconnects and jobs
// flow again, but the health state ratcheted to 'error' forever — /health
// 503 + docker unhealthy for 10+ min AFTER recovery while logs showed jobs
// completing. The degraded probe must flip the state back.
test('degraded -> backend recovered: probe flips state back to connected', async () => {
  const state = { status: 'connected', lastError: null };
  const stop = bindQueueState(fakeWorker(), state, { probeMs: 20 });
  // simulate the 'error' listener firing
  state.status = 'error';
  state.lastError = 'read ECONNRESET';
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(state.status, 'connected', 'probe recovered the degraded state');
  assert.equal(state.lastError, null);
  stop();
});

test('probe stays degraded while redis still down, recovers when the round trip succeeds', async () => {
  let ok = false;
  const state = { status: 'error', lastError: 'getaddrinfo EAI_AGAIN redis' };
  const stop = bindQueueState(
    fakeWorker({ counts: async () => { if (!ok) throw new Error('ECONNREFUSED'); } }),
    state,
    { probeMs: 20 },
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(state.status, 'error', 'still degraded while backend down');
  ok = true;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(state.status, 'connected');
  stop();
});

test('no probing while healthy (zero redis load in steady state)', async () => {
  let calls = 0;
  const state = { status: 'connected', lastError: null };
  const stop = bindQueueState(fakeWorker({ counts: async () => { calls += 1; } }), state, { probeMs: 15 });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, 0, 'healthy state must not probe');
  stop();
});

test('stop() disables the probe', async () => {
  let calls = 0;
  const state = { status: 'error', lastError: 'x' };
  const stop = bindQueueState(fakeWorker({ counts: async () => { calls += 1; } }), state, { probeMs: 15 });
  stop();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, 0);
});
