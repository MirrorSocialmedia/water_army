/**
 * BR-B1 — network policy gate seam (施工 MD §5.1/§12 + B4 interface):
 *   - deny → run marked failed BEFORE startAttempt; NO provider call, NO
 *     retry enqueue; FAILED event + error code persisted
 *   - gate CRASH → fail-closed as NETWORK_POLICY_UNAVAILABLE (MD §5.1/§12)
 *   - gate absent (no policy configured) → proceed (default mock pass)
 *   - allow → transparent: run executes exactly as today
 *   - the gate receives the run context (identityId/batchId/attempt)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTaskRunService,
  TASK_EVENT,
  NETWORK_GATE_ERROR,
  createAllowAllNetworkGate,
} from '@water-army/shared';

import { createProvider } from '../../apps/worker/src/providers/index.js';
import { createTaskEngine } from '../../apps/worker/src/task-engine.js';
import { makeFakeDb } from '../helpers/fakes.js';

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

function makeCtx({ networkGate } = {}) {
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
    networkGate,
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

async function startRun(ctx, overrides = {}) {
  const input = { prompt: 'test prompt', provider: 'mock', timeoutMs: overrides.timeoutMs, maxAttempts: 2 };
  const { run } = await ctx.taskSvc.createRun(input, { id: 'u1', username: 'tester' });
  return run.id;
}

/** Bind the run to an identity/batch (B2 will do this at create time). */
function bindRun(ctx, runId, { identityId = null, batchId = null } = {}) {
  const row = ctx.db.__state.runRows.get(runId);
  row.identityId = identityId;
  row.batchId = batchId;
}

const eventsOfType = (db, runId, type) =>
  db.__state.eventRows.filter((e) => e.taskRunId === runId && e.eventType === type);

test('gate denies → run failed pre-startAttempt: NO provider call, NO retry, FAILED event + code', async () => {
  const ctx = makeCtx({
    networkGate: async () => ({ allowed: false, code: NETWORK_GATE_ERROR.TARGET_DENIED, reason: 'example.com not allowlisted' }),
  });
  const runId = await startRun(ctx);
  bindRun(ctx, runId, { identityId: 'ident-1', batchId: 'batch-1' });
  const enqueuedBefore = ctx.enqueued.length; // createRun's initial job — NOT a retry

  const outcome = await ctx.engine.handleJob({ id: 'j1', data: { runId, attempt: 1 } });
  assert.equal(outcome.outcome, 'network-denied');
  assert.equal(outcome.code, NETWORK_GATE_ERROR.TARGET_DENIED);

  assert.equal(ctx.providerCalls.length, 0, 'the provider was NEVER contacted');
  assert.equal(ctx.enqueued.length, enqueuedBefore, 'no retry enqueued — a denied run is terminal');
  const run = ctx.db.__state.runRows.get(runId);
  assert.equal(run.status, 'failed');
  assert.equal(run.errorCode, NETWORK_GATE_ERROR.TARGET_DENIED);
  assert.match(run.errorMessage, /example\.com not allowlisted/);
  assert.equal(eventsOfType(ctx.db, runId, TASK_EVENT.FAILED).length, 1);
  assert.equal(eventsOfType(ctx.db, runId, TASK_EVENT.STARTED).length, 0, 'never started');
});

test('gate CRASH → fail-closed as NETWORK_POLICY_UNAVAILABLE (MD §5.1/§12: never fall back to unrestricted)', async () => {
  const ctx = makeCtx({
    networkGate: async () => {
      throw new Error('policy service 500');
    },
  });
  const runId = await startRun(ctx);
  const outcome = await ctx.engine.handleJob({ id: 'j1', data: { runId, attempt: 1 } });
  assert.equal(outcome.outcome, 'network-denied');
  assert.equal(outcome.code, NETWORK_GATE_ERROR.POLICY_UNAVAILABLE);
  assert.equal(ctx.providerCalls.length, 0);
  const run = ctx.db.__state.runRows.get(runId);
  assert.equal(run.status, 'failed');
  assert.equal(run.errorCode, NETWORK_GATE_ERROR.POLICY_UNAVAILABLE);
  assert.match(run.errorMessage, /network gate crashed/);
});

test('gate returns a deny WITHOUT a stable code → classified as POLICY_UNAVAILABLE (a codeless deny is a policy bug)', async () => {
  const ctx = makeCtx({ networkGate: async () => ({ allowed: false, reason: 'weird' }) });
  const runId = await startRun(ctx);
  const outcome = await ctx.engine.handleJob({ id: 'j1', data: { runId, attempt: 1 } });
  assert.equal(outcome.outcome, 'network-denied');
  assert.equal(outcome.code, NETWORK_GATE_ERROR.POLICY_UNAVAILABLE);
  assert.equal(ctx.providerCalls.length, 0);
});

test('gate absent (no policy configured) → proceed: the 627-baseline behavior is untouched', async () => {
  const ctx = makeCtx({}); // networkGate never passed
  const runId = await startRun(ctx);
  const outcome = await ctx.engine.handleJob({ id: 'j1', data: { runId, attempt: 1 } });
  assert.equal(ctx.providerCalls.length, 1, 'ran normally');
  assert.equal(outcome.outcome, 'succeeded');
  assert.equal(ctx.db.__state.runRows.get(runId).status, 'succeeded');
});

test('gate allow (B4 default mock) → transparent: run succeeds, gate saw the context', async () => {
  const seen = [];
  const ctx = makeCtx({
    networkGate: async (gctx) => {
      seen.push(gctx);
      return { allowed: true };
    },
  });
  const runId = await startRun(ctx);
  bindRun(ctx, runId, { identityId: 'ident-9', batchId: 'batch-9' });
  await ctx.engine.handleJob({ id: 'j1', data: { runId, attempt: 1 } });
  assert.equal(ctx.db.__state.runRows.get(runId).status, 'succeeded');
  assert.equal(seen.length, 1, 'the gate ran exactly once per job');
  assert.equal(seen[0].runId, runId);
  assert.equal(seen[0].attempt, 1);
  assert.equal(seen[0].identityId, 'ident-9', 'B4 policy gets the identity (per-identity allowlist)');
  assert.equal(seen[0].batchId, 'batch-9');
});

test('createAllowAllNetworkGate: the default mock passes (the documented B4 swap point)', async () => {
  const gate = createAllowAllNetworkGate();
  assert.equal((await gate({ runId: 'r', attempt: 1, identityId: null, batchId: null, taskType: 'adhoc' })).allowed, true);
  const ctx = makeCtx({ networkGate: gate });
  const runId = await startRun(ctx);
  await ctx.engine.handleJob({ id: 'j1', data: { runId, attempt: 1 } });
  assert.equal(ctx.db.__state.runRows.get(runId).status, 'succeeded');
});

test('a LATER deny after an earlier allow does not resurrect the failed run (terminal stays terminal)', async () => {
  let deny = false;
  const ctx = makeCtx({
    networkGate: async () => (deny ? { allowed: false, code: NETWORK_GATE_ERROR.TARGET_DENIED } : { allowed: true }),
  });
  const runId = await startRun(ctx);
  deny = true;
  const o1 = await ctx.engine.handleJob({ id: 'j1', data: { runId, attempt: 1 } });
  assert.equal(o1.outcome, 'network-denied');
  // Redelivered job for an already-terminal run: the run can't start again
  // (stale/terminal) — either way, NO provider call may happen.
  await ctx.engine.handleJob({ id: 'j2', data: { runId, attempt: 2 } });
  assert.equal(ctx.db.__state.runRows.get(runId).status, 'failed');
  assert.equal(ctx.providerCalls.length, 0);
});
