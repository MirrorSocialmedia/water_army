/**
 * BR-B4 — gate SWAP integration (the B1 seam with the real policy gate wired in).
 *
 * Proves the worker-side end-to-end behavior after the worker.js swap:
 *   - allow → run executes exactly as before (transparent)
 *   - deny (any code) → run marked failed BEFORE startAttempt; NO provider call,
 *     NO retry enqueue, FAILED event + stable error code persisted
 *   - policy unavailable → fail-closed NETWORK_POLICY_UNAVAILABLE
 *   - terminal stays terminal (redelivered jobs cannot resurrect a denied run)
 *
 * Hermetic: fake db, mock provider (the gate fences the CONFIGURED targets —
 * provider_configs row + apiInternalUrl — before the engine resolves anything).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTaskRunService,
  TASK_EVENT,
  NETWORK_GATE_ERROR,
  createNetworkPolicyGate,
} from '@water-army/shared';

import { createProvider } from '../../apps/worker/src/providers/index.js';
import { createTaskEngine } from '../../apps/worker/src/task-engine.js';
import { makeFakeDb } from '../helpers/fakes.js';

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const PUB = '93.184.216.34';

const RESOLVE_MAP = {
  api: ['172.18.0.2'],
  'qa.example.com': [PUB],
};
const resolve = async (h) => RESOLVE_MAP[h] ?? [PUB];

/** The policy env the worker would carry (docs/network-policy.md §config). */
const POLICY_ENV = {
  QA_ENDPOINT_ALLOWLIST: 'https://qa.example.com',
  QA_ENDPOINT_ALLOWLIST_INTERNAL: 'http://api:3000',
};

function makeCtx({ env = POLICY_ENV, config = { apiInternalUrl: 'http://api:3000' }, resolve: res = resolve } = {}) {
  const db = makeFakeDb();
  const enqueued = [];
  const providerCalls = [];
  const taskSvc = createTaskRunService({
    db,
    config: { taskDefaultTimeoutMs: 120_000, taskMaxTimeoutMs: 900_000, taskDefaultAttempts: 3 },
    log: SILENT,
    enqueue: async (job) => {
      enqueued.push(job);
    },
  });
  const baseProvider = createProvider({ name: 'mock', mockScript: 'default', log: SILENT });
  const gate = createNetworkPolicyGate({
    getDb: () => db,
    env,
    config,
    log: SILENT,
    resolve: res,
  });
  const engine = createTaskEngine({
    db,
    taskSvc,
    config: {
      taskDefaultTimeoutMs: 120_000,
      taskMaxTimeoutMs: 900_000,
      taskDefaultAttempts: 3,
      approvalPollMs: 30,
      cancelPollMs: 30,
    },
    log: SILENT,
    networkGate: gate, // ← THE SWAP (worker.js:318 after BR-B4)
    providerResolver: async () => ({
      model: 'mock',
      chat: async (args) => {
        providerCalls.push(args);
        return baseProvider.chat(args);
      },
    }),
    toolHandlers: {},
    env: {},
  });
  return { db, taskSvc, engine, enqueued, providerCalls };
}

async function startRun(ctx, { provider = 'mock' } = {}) {
  const input = { prompt: 'test prompt', provider, timeoutMs: 10_000, maxAttempts: 2 };
  const { run } = await ctx.taskSvc.createRun(input, { id: 'u1', username: 'tester' });
  return run.id;
}

const eventsOfType = (db, runId, type) =>
  db.__state.eventRows.filter((e) => e.taskRunId === runId && e.eventType === type);

async function addProvider(ctx, { name, baseUrl, isEnabled = true } = {}) {
  await ctx.db.providerConfig.create({ data: { name, baseUrl, isEnabled } });
}

// ---------------------------------------------------------------------------

test('swap ALLOW: policy loaded, mock provider, api internal listed → run SUCCEEDED (transparent)', async () => {
  const ctx = makeCtx();
  const runId = await startRun(ctx);
  const enqueuedBefore = ctx.enqueued.length; // createRun's initial job
  const outcome = await ctx.engine.handleJob({ id: 'j1', data: { runId, attempt: 1 } });
  assert.equal(outcome.outcome, 'succeeded');
  assert.equal(ctx.providerCalls.length, 1, 'the run executed normally');
  assert.equal(ctx.enqueued.length, enqueuedBefore, 'no extra queue traffic');
  assert.equal(ctx.db.__state.runRows.get(runId).status, 'succeeded');
  assert.equal(ctx.db.__state.auditRows.length, 0, 'no deny audited on the allow path');
});

test('swap ALLOW: named provider + allowlisted baseUrl (public) → run SUCCEEDED (gate saw the real target)', async () => {
  const ctx = makeCtx();
  await addProvider(ctx, { name: 'qa', baseUrl: 'https://qa.example.com' });
  const runId = await startRun(ctx, { provider: 'qa' });
  const outcome = await ctx.engine.handleJob({ id: 'j1', data: { runId, attempt: 1 } });
  assert.equal(outcome.outcome, 'succeeded');
  assert.equal(ctx.providerCalls.length, 1);
  assert.equal(ctx.db.__state.runRows.get(runId).status, 'succeeded');
});

test('swap DENY (BLOCKED_IP): provider target resolves to loopback → run failed pre-start, no provider call, no retry', async () => {
  const ctx = makeCtx({
    resolve: async (h) => (h === 'qa.example.com' ? ['127.0.0.1'] : RESOLVE_MAP[h] ?? [PUB]),
  });
  await addProvider(ctx, { name: 'qa', baseUrl: 'https://qa.example.com' });
  const runId = await startRun(ctx, { provider: 'qa' });
  const enqueuedBefore = ctx.enqueued.length;

  const outcome = await ctx.engine.handleJob({ id: 'j1', data: { runId, attempt: 1 } });
  assert.equal(outcome.outcome, 'network-denied');
  assert.equal(outcome.code, NETWORK_GATE_ERROR.BLOCKED_IP);

  assert.equal(ctx.providerCalls.length, 0, 'the provider was NEVER contacted');
  assert.equal(ctx.enqueued.length, enqueuedBefore, 'a denied run is terminal — no retry enqueued');
  const run = ctx.db.__state.runRows.get(runId);
  assert.equal(run.status, 'failed');
  assert.equal(run.errorCode, NETWORK_GATE_ERROR.BLOCKED_IP);
  assert.match(run.errorMessage, /network gate/);
  assert.equal(eventsOfType(ctx.db, runId, TASK_EVENT.FAILED).length, 1);
  assert.equal(eventsOfType(ctx.db, runId, TASK_EVENT.STARTED).length, 0, 'never started');
  // and the system audit landed
  const denies = ctx.db.__state.auditRows.filter((a) => a.action === 'network_policy_deny');
  assert.equal(denies.length, 1);
  assert.equal(denies[0].detailsJson.code, NETWORK_GATE_ERROR.BLOCKED_IP);
  assert.equal(denies[0].detailsJson.actor, 'system');
});

test('swap DENY (TARGET_DENIED): provider host not on the allowlist → run failed pre-start', async () => {
  const ctx = makeCtx();
  await addProvider(ctx, { name: 'ghost', baseUrl: 'https://notlisted.example.com' });
  const runId = await startRun(ctx, { provider: 'ghost' });
  const outcome = await ctx.engine.handleJob({ id: 'j1', data: { runId, attempt: 1 } });
  assert.equal(outcome.outcome, 'network-denied');
  assert.equal(outcome.code, NETWORK_GATE_ERROR.TARGET_DENIED);
  assert.equal(ctx.providerCalls.length, 0);
  const run = ctx.db.__state.runRows.get(runId);
  assert.equal(run.status, 'failed');
  assert.equal(run.errorCode, NETWORK_GATE_ERROR.TARGET_DENIED);
});

test('swap FAIL-CLOSED: policy not loaded (no env, no AppSetting) → every run denied NETWORK_POLICY_UNAVAILABLE', async () => {
  const ctx = makeCtx({ env: {}, config: {} });
  const runId = await startRun(ctx); // mock provider — still denied: the policy itself must be loaded
  const outcome = await ctx.engine.handleJob({ id: 'j1', data: { runId, attempt: 1 } });
  assert.equal(outcome.outcome, 'network-denied');
  assert.equal(outcome.code, NETWORK_GATE_ERROR.POLICY_UNAVAILABLE);
  assert.equal(ctx.providerCalls.length, 0, 'no network, no provider — fail-closed');
  const run = ctx.db.__state.runRows.get(runId);
  assert.equal(run.status, 'failed');
  assert.equal(run.errorCode, NETWORK_GATE_ERROR.POLICY_UNAVAILABLE);
});

test('swap FAIL-CLOSED: malformed env (wildcard) → POLICY_UNAVAILABLE, never a partial allow', async () => {
  const ctx = makeCtx({ env: { QA_ENDPOINT_ALLOWLIST: 'https://qa.example.com, https://*.example.com' }, config: {} });
  const runId = await startRun(ctx);
  const outcome = await ctx.engine.handleJob({ id: 'j1', data: { runId, attempt: 1 } });
  assert.equal(outcome.outcome, 'network-denied');
  assert.equal(outcome.code, NETWORK_GATE_ERROR.POLICY_UNAVAILABLE);
  assert.equal(ctx.providerCalls.length, 0);
});

test('swap: a redelivered job after a deny cannot resurrect the run (terminal stays terminal)', async () => {
  const ctx = makeCtx({ env: {} });
  const runId = await startRun(ctx);
  const o1 = await ctx.engine.handleJob({ id: 'j1', data: { runId, attempt: 1 } });
  assert.equal(o1.outcome, 'network-denied');
  await ctx.engine.handleJob({ id: 'j2', data: { runId, attempt: 2 } });
  assert.equal(ctx.db.__state.runRows.get(runId).status, 'failed');
  assert.equal(ctx.providerCalls.length, 0, 'no external contact on redelivery either');
});
