/**
 * Task engine integration tests — hermetic (fake DB, mock provider, stub
 * tool handlers, no Redis/Docker/network).
 *
 * Covers the work-order lifecycle matrix (P3 §7):
 *   - queued → running → succeeded (full event stream)
 *   - transient failure → auto-retry (new attempt) → succeeded
 *   - permanent failure (AUTH never retried)
 *   - running → cancel → cancelled (REAL stop: in-flight mock delay aborts,
 *     no further provider activity after the cancel)
 *   - deadline timeout (run + BullMQ-independent)
 *   - tool call (readonly) → executed via handler
 *   - tool call (approval_required) → needs_approval → approve → executed
 *   - approval rejected → tool error fed back, run continues
 *   - cancel while waiting approval → cancelled + approval expired
 *   - timeout while waiting approval → timed_out + approval expired
 *   - unknown tool / handler failure → fed back, run still succeeds
 *   - stale job (attempt mismatch) → no-op; pre-start cancel → no execution
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  createTaskRunService,
  TASK_EVENT,
  ProviderError,
  PROVIDER_ERROR,
} from '@water-army/shared';

import { createProvider } from '../../apps/worker/src/providers/index.js';
import { createTaskEngine } from '../../apps/worker/src/task-engine.js';
import { makeFakeDb } from '../helpers/fakes.js';

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

function makeEngine({ db, script = 'default', toolHandlers = {}, runInput = {}, pollMs = 30 } = {}) {
  const enqueued = [];
  const taskSvc = createTaskRunService({
    db,
    config: { taskDefaultTimeoutMs: 120_000, taskMaxTimeoutMs: 900_000, taskDefaultAttempts: 3 },
    log: SILENT,
    enqueue: async (job) => {
      enqueued.push(job);
    },
  });
  const engine = createTaskEngine({
    db,
    taskSvc,
    config: {
      taskDefaultTimeoutMs: 120_000,
      taskMaxTimeoutMs: 900_000,
      taskDefaultAttempts: 3,
      approvalPollMs: pollMs,
      cancelPollMs: pollMs,
    },
    log: SILENT,
    providerResolver: async () => createProvider({ name: 'mock', mockScript: script, log: SILENT }),
    toolHandlers,
    env: {},
  });
  return { db, taskSvc, engine, enqueued, runInput };
}

/** Create a run (via the service, so enqueue + queued event happen) and return its id. */
async function startRun(ctx, overrides = {}) {
  const input = {
    prompt: 'test prompt',
    provider: 'mock',
    timeoutMs: overrides.timeoutMs,
    maxAttempts: overrides.maxAttempts,
    tools: overrides.tools,
  };
  const { run } = await ctx.taskSvc.createRun(input, { id: 'u1', username: 'tester' });
  return run.id;
}

const eventsOfType = (db, runId, type) =>
  db.__state.eventRows.filter((e) => e.taskRunId === runId && e.eventType === type);

/**
 * Suite-hang guard: if a test fails while an engine job is still parked
 * (e.g. waiting approval forever), cancel the run so the engine reaches a
 * terminal state and the event loop can drain — otherwise the test child
 * process never exits and the whole suite hangs.
 */
function releaseOnFinish(t, ctx, runId, pending) {
  t.after(async () => {
    try {
      const row = ctx.db.__state.runRows.get(runId);
      if (row && !['succeeded', 'failed', 'cancelled', 'timed_out'].includes(row.status)) {
        await ctx.taskSvc.requestCancel(runId, { actorUserId: 'u1' });
      }
      await pending;
    } catch {
      /* best effort — the test outcome is already recorded */
    }
  });
}

test('engine: full lifecycle queued → running → succeeded (events persisted)', async () => {
  const db = makeFakeDb();
  const ctx = makeEngine({ db, script: 'default' });
  const runId = await startRun(ctx);
  assert.equal(ctx.enqueued.length, 1, 'createRun enqueued attempt 1');
  assert.deepEqual(ctx.enqueued[0], { runId, attempt: 1 }, 'job payload is secret-free {runId, attempt}');

  const outcome = await ctx.engine.handleJob({ id: 'job1', data: { runId, attempt: 1 } });

  assert.equal(outcome.outcome, 'succeeded');
  const run = db.__state.runRows.get(runId);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.attempt, 1);
  assert.ok(run.startedAt, 'startedAt set');
  assert.ok(run.finishedAt, 'finishedAt set (terminal)');
  assert.ok(run.durationMs >= 0);
  assert.ok(run.resultText.includes('Mock provider response'), 'output persisted');
  assert.equal(run.errorCode, null);

  const types = db.__state.eventRows.filter((e) => e.taskRunId === runId).map((e) => e.eventType);
  for (const t of [
    TASK_EVENT.QUEUED,
    TASK_EVENT.ATTEMPT_STARTED,
    TASK_EVENT.PROVIDER_REQUEST,
    TASK_EVENT.PROVIDER_RESPONSE,
    TASK_EVENT.SUCCEEDED,
    TASK_EVENT.OUTPUT,
  ]) {
    assert.ok(types.includes(t), `event stream contains '${t}' (got: ${types.join(', ')})`);
  }
});

test('engine: transient failure → auto-retry as NEW attempt → succeeded', async () => {
  const db = makeFakeDb();
  const ctx = makeEngine({ db, script: 'fail-then-ok' });
  const runId = await startRun(ctx, { maxAttempts: 3 });

  const outcome = await ctx.engine.handleJob({ id: 'job1', data: { runId, attempt: 1 } });

  assert.equal(outcome.outcome, 'succeeded');
  const run = db.__state.runRows.get(runId);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.attempt, 2, 'attempt incremented (new attempt, not overwrite)');
  const retries = eventsOfType(db, runId, TASK_EVENT.RETRY);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].payloadJson.code, PROVIDER_ERROR.NETWORK);
  assert.equal(retries[0].payloadJson.toAttempt, 2);
  // The failed attempt's error is preserved in the event stream, and the
  // successful attempt's output is what the row carries.
  assert.ok(run.resultText.includes('Recovered after a transient network fault'));
  assert.equal(run.errorCode, null, 'terminal success clears the error');
});

test('engine: permanent failure (AUTH) is never auto-retried', async () => {
  const db = makeFakeDb();
  const ctx = makeEngine({ db, script: 'fail-auth' });
  const runId = await startRun(ctx, { maxAttempts: 5 });

  const outcome = await ctx.engine.handleJob({ id: 'job1', data: { runId, attempt: 1 } });

  assert.equal(outcome.outcome, 'failed');
  assert.equal(outcome.code, PROVIDER_ERROR.AUTH);
  const run = db.__state.runRows.get(runId);
  assert.equal(run.status, 'failed');
  assert.equal(run.attempt, 1, 'no retry happened');
  assert.equal(run.errorCode, PROVIDER_ERROR.AUTH);
  assert.equal(run.finishedAt != null, true);
  assert.equal(run.resultText, null, 'failed runs carry no result');
  assert.equal(eventsOfType(db, runId, TASK_EVENT.RETRY).length, 0);
});

test('engine: retry attempts exhaust maxAttempts → failed', async () => {
  const db = makeFakeDb();
  const ctx = makeEngine({ db, script: 'fail-then-ok' });
  const runId = await startRun(ctx, { maxAttempts: 1 });

  const outcome = await ctx.engine.handleJob({ id: 'job1', data: { runId, attempt: 1 } });

  assert.equal(outcome.outcome, 'failed');
  const run = db.__state.runRows.get(runId);
  assert.equal(run.status, 'failed');
  assert.equal(run.attempt, 1, 'maxAttempts=1 → no second attempt');
  assert.equal(run.errorCode, PROVIDER_ERROR.NETWORK);
});

test('engine: cancel while running = REAL stop (in-flight abort, no further work)', async (t) => {
  const db = makeFakeDb();
  const handlerCalls = [];
  const ctx = makeEngine({
    db,
    script: JSON.stringify({ steps: [{ delayMs: 5_000, content: 'should never arrive', finishReason: 'stop' }] }),
    toolHandlers: { 'docker.list_managed_containers': async () => { handlerCalls.push(1); return { ok: true }; } },
  });
  const runId = await startRun(ctx);

  const pending = ctx.engine.handleJob({ id: 'job1', data: { runId, attempt: 1 } });
  releaseOnFinish(t, ctx, runId, pending);
  // Let the run reach 'running' and the provider delay start.
  await new Promise((r) => setTimeout(r, 120));
  let run = db.__state.runRows.get(runId);
  assert.equal(run.status, 'running');

  const { idempotent: firstCancelIdempotent } = await ctx.taskSvc.requestCancel(runId, { actorUserId: 'u1' });
  assert.equal(firstCancelIdempotent, false);
  const { idempotent: secondCancelIdempotent } = await ctx.taskSvc.requestCancel(runId, { actorUserId: 'u1' });
  assert.equal(secondCancelIdempotent, true, 'cancel is idempotent');

  const outcome = await pending;
  assert.equal(outcome.outcome, 'cancelled');

  run = db.__state.runRows.get(runId);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.resultText, null, 'no output after cancel');
  assert.equal(handlerCalls.length, 0, 'no tool executed after cancel');
  assert.equal(eventsOfType(db, runId, TASK_EVENT.PROVIDER_RESPONSE).length, 0, 'provider response never landed after abort');
  const types = db.__state.eventRows.filter((e) => e.taskRunId === runId).map((e) => e.eventType);
  assert.ok(types.includes(TASK_EVENT.CANCEL_REQUESTED));
  assert.ok(types.includes(TASK_EVENT.CANCELLED));
});

test('engine: deadline timeout (run-level) → timed_out', async () => {
  const db = makeFakeDb();
  const ctx = makeEngine({ db, script: JSON.stringify({ steps: [{ delayMs: 30_000, content: 'late', finishReason: 'stop' }] }) });
  const runId = await startRun(ctx, { timeoutMs: 1_000 });

  const startedAt = Date.now();
  const outcome = await ctx.engine.handleJob({ id: 'job1', data: { runId, attempt: 1 } });
  const elapsed = Date.now() - startedAt;

  assert.equal(outcome.outcome, 'timed_out');
  assert.equal(outcome.timeoutMs, 1_000);
  const run = db.__state.runRows.get(runId);
  assert.equal(run.status, 'timed_out');
  assert.equal(run.errorCode, 'TIMEOUT');
  assert.ok(elapsed < 10_000, `aborted near the deadline (took ${elapsed}ms), not after the mock delay`);
});

test('engine: readonly tool call → validated + executed via handler', async () => {
  const db = makeFakeDb();
  const calls = [];
  const ctx = makeEngine({
    db,
    script: 'tool-docker-list',
    toolHandlers: {
      'docker.list_managed_containers': async (args) => {
        calls.push(args);
        return { ok: true, result: { total: 2, containers: [{ id: 'abc', name: 'api', state: 'running' }] } };
      },
    },
  });
  const runId = await startRun(ctx);

  const outcome = await ctx.engine.handleJob({ id: 'job1', data: { runId, attempt: 1 } });

  assert.equal(outcome.outcome, 'succeeded');
  assert.equal(calls.length, 1, 'handler executed once');
  const run = db.__state.runRows.get(runId);
  assert.equal(run.status, 'succeeded');
  const toolCalls = eventsOfType(db, runId, TASK_EVENT.TOOL_CALL);
  const toolResults = eventsOfType(db, runId, TASK_EVENT.TOOL_RESULT);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].payloadJson.ok, true);
  // tool result fed back was truncated + JSON (mock step 2 then stops)
  assert.ok(run.resultText.length > 0);
});

test('engine: invalid tool arguments → rejected pre-execution, fed back to model', async () => {
  const db = makeFakeDb();
  const calls = [];
  const ctx = makeEngine({
    db,
    script: JSON.stringify({
      steps: [
        { toolCalls: [{ name: 'docker.get_managed_container_status', arguments: { container: 42 } }] },
        { content: 'reported the invalid args', finishReason: 'stop' },
      ],
    }),
    toolHandlers: {
      'docker.get_managed_container_status': async () => {
        calls.push(1);
        return { ok: true };
      },
    },
  });
  const runId = await startRun(ctx);

  const outcome = await ctx.engine.handleJob({ id: 'job1', data: { runId, attempt: 1 } });

  assert.equal(outcome.outcome, 'succeeded');
  assert.equal(calls.length, 0, 'invalid args must never reach the handler');
  const toolCallEvents = eventsOfType(db, runId, TASK_EVENT.TOOL_CALL);
  assert.equal(toolCallEvents[0].payloadJson.ok, false);
  assert.equal(toolCallEvents[0].payloadJson.errorCode, 'invalid_arguments');
});

test('engine: unknown tool → fed back as tool_unavailable, run continues', async () => {
  const db = makeFakeDb();
  const ctx = makeEngine({
    db,
    script: JSON.stringify({
      steps: [
        { toolCalls: [{ name: 'shell.exec', arguments: { command: 'rm -rf /' } }] },
        { content: 'shell.exec is not an available tool; I did not run it', finishReason: 'stop' },
      ],
    }),
  });
  const runId = await startRun(ctx);

  const outcome = await ctx.engine.handleJob({ id: 'job1', data: { runId, attempt: 1 } });

  assert.equal(outcome.outcome, 'succeeded', 'an unknown tool is a model-visible error, not a crash');
  const toolCallEvents = eventsOfType(db, runId, TASK_EVENT.TOOL_CALL);
  assert.equal(toolCallEvents[0].payloadJson.errorCode, 'tool_unavailable');
  const run = db.__state.runRows.get(runId);
  assert.equal(run.status, 'succeeded');
});

test('engine: approval_required tool → needs_approval → human approves → executed', async (t) => {
  const db = makeFakeDb();
  const calls = [];
  const ctx = makeEngine({
    db,
    script: 'tool-restart-approve',
    toolHandlers: {
      'docker.restart_managed': async (args) => {
        calls.push(args);
        return { ok: true, result: { restarted: args.container } };
    },
    },
  });
  const runId = await startRun(ctx);

  const pending = ctx.engine.handleJob({ id: 'job1', data: { runId, attempt: 1 } });
  releaseOnFinish(t, ctx, runId, pending);
  await new Promise((r) => setTimeout(r, 150));
  let run = db.__state.runRows.get(runId);
  assert.equal(run.status, 'needs_approval', 'run parked in needs_approval');
  assert.equal(calls.length, 0, 'NOT executed before approval (MD §11.4)');
  const approvals = db.__state.approvalRows;
  assert.equal(approvals.size, 1);
  const approval = [...approvals.values()][0];
  assert.equal(approval.status, 'pending');
  assert.equal(approval.toolName, 'docker.restart_managed');

  const resolved = await ctx.taskSvc.resolveApproval(approval.id, {
    decision: 'approved',
    actorUserId: 'u-admin',
    note: 'ok, restart it',
  });
  assert.equal(resolved.status, 'approved');

  const outcome = await pending;
  assert.equal(outcome.outcome, 'succeeded');
  run = db.__state.runRows.get(runId);
  assert.equal(run.status, 'succeeded');
  assert.equal(calls.length, 1, 'executed exactly once, after approval');
  const types = db.__state.eventRows.filter((e) => e.taskRunId === runId).map((e) => e.eventType);
  assert.ok(types.includes(TASK_EVENT.WAITING_APPROVAL));
  assert.ok(types.includes(TASK_EVENT.APPROVAL_RESOLVED));
  assert.ok(types.includes(TASK_EVENT.TOOL_RESULT));
});

test('engine: approval rejected → error fed back, model reports, run continues', async (t) => {
  const db = makeFakeDb();
  const calls = [];
  const ctx = makeEngine({
    db,
    script: 'tool-restart-approve',
    toolHandlers: {
      'docker.restart_managed': async () => {
        calls.push(1);
        return { ok: true };
      },
    },
  });
  const runId = await startRun(ctx);

  const pending = ctx.engine.handleJob({ id: 'job1', data: { runId, attempt: 1 } });
  releaseOnFinish(t, ctx, runId, pending);
  await new Promise((r) => setTimeout(r, 150));
  const approval = [...db.__state.approvalRows.values()][0];
  assert.equal(db.__state.runRows.get(runId).status, 'needs_approval');

  await ctx.taskSvc.resolveApproval(approval.id, { decision: 'rejected', actorUserId: 'u-admin', note: 'not now' });

  const outcome = await pending;
  assert.equal(outcome.outcome, 'succeeded', 'the model is told of the rejection and finishes');
  assert.equal(calls.length, 0, 'rejected action is never executed');
  const toolResults = eventsOfType(db, runId, TASK_EVENT.TOOL_RESULT);
  assert.equal(toolResults[0].payloadJson.errorCode, 'approval_rejected');
});

test('engine: cancel while waiting approval → cancelled + approval expired', async (t) => {
  const db = makeFakeDb();
  const ctx = makeEngine({ db, script: 'tool-restart-approve', toolHandlers: {} });
  const runId = await startRun(ctx);

  const pending = ctx.engine.handleJob({ id: 'job1', data: { runId, attempt: 1 } });
  releaseOnFinish(t, ctx, runId, pending);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(db.__state.runRows.get(runId).status, 'needs_approval');

  await ctx.taskSvc.requestCancel(runId, { actorUserId: 'u1' });
  const outcome = await pending;

  assert.equal(outcome.outcome, 'cancelled');
  assert.equal(db.__state.runRows.get(runId).status, 'cancelled');
  const approval = [...db.__state.approvalRows.values()][0];
  assert.equal(approval.status, 'expired', 'pending approval expired with the run');
});

test('engine: timeout while waiting approval → timed_out + approval expired', async (t) => {
  const db = makeFakeDb();
  const ctx = makeEngine({ db, script: 'tool-restart-approve', toolHandlers: {} });
  const runId = await startRun(ctx, { timeoutMs: 1_000 }); // service validation floor is 1s

  const pending = ctx.engine.handleJob({ id: 'job1', data: { runId, attempt: 1 } });
  releaseOnFinish(t, ctx, runId, pending);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(db.__state.runRows.get(runId).status, 'needs_approval');

  const outcome = await pending;
  assert.equal(outcome.outcome, 'timed_out');
  assert.equal(db.__state.runRows.get(runId).status, 'timed_out');
  assert.equal([...db.__state.approvalRows.values()][0].status, 'expired');
});

test('engine: tool handler failure is NOT a run failure (fed back to model)', async () => {
  const db = makeFakeDb();
  const ctx = makeEngine({
    db,
    script: JSON.stringify({
      steps: [
        { toolCalls: [{ name: 'docker.get_managed_container_logs', arguments: { container: 'c1', tail: 50 } }] },
        { content: 'the log fetch failed with TOOL_ERROR; reporting it', finishReason: 'stop' },
      ],
    }),
    toolHandlers: {
      'docker.get_managed_container_logs': async () => {
        throw Object.assign(new Error('container not found'), { apiCode: 'NOT_FOUND' });
      },
    },
  });
  const runId = await startRun(ctx);

  const outcome = await ctx.engine.handleJob({ id: 'job1', data: { runId, attempt: 1 } });

  assert.equal(outcome.outcome, 'succeeded');
  const toolResults = eventsOfType(db, runId, TASK_EVENT.TOOL_RESULT);
  assert.equal(toolResults[0].payloadJson.ok, false);
  assert.equal(toolResults[0].payloadJson.preview.includes('container not found'), true);
});

test('engine: stale job (attempt mismatch) → no-op, run untouched', async () => {
  const db = makeFakeDb();
  const ctx = makeEngine({ db, script: 'default' });
  const runId = await startRun(ctx);

  const outcome = await ctx.engine.handleJob({ id: 'jobX', data: { runId, attempt: 7 } });
  assert.equal(outcome.outcome, 'stale');
  const run = db.__state.runRows.get(runId);
  assert.equal(run.status, 'queued', 'stale job must not mutate the run');
});

test('engine: cancel before start → job sees cancelled, provider never called', async () => {
  const db = makeFakeDb();
  const ctx = makeEngine({ db, script: 'default' });
  const runId = await startRun(ctx);
  await ctx.taskSvc.requestCancel(runId, { actorUserId: 'u1' });

  const outcome = await ctx.engine.handleJob({ id: 'job1', data: { runId, attempt: 1 } });
  assert.equal(outcome.outcome, 'cancelled');
  const run = db.__state.runRows.get(runId);
  assert.equal(run.status, 'cancelled');
  assert.equal(eventsOfType(db, runId, TASK_EVENT.PROVIDER_REQUEST).length, 0);
});

test('engine: provider resolver failure → run failed with classified code', async () => {
  const db = makeFakeDb();
  const taskSvc = createTaskRunService({
    db,
    config: { taskDefaultTimeoutMs: 120_000, taskMaxTimeoutMs: 900_000, taskDefaultAttempts: 3 },
    log: SILENT,
    enqueue: async () => {},
  });
  const engine = createTaskEngine({
    db,
    taskSvc,
    log: SILENT,
    providerResolver: async () => {
      throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, "provider 'openai' is not configured or disabled");
    },
    toolHandlers: {},
    env: {},
  });
  const { run } = await taskSvc.createRun({ prompt: 'hi', provider: 'openai' }, { id: 'u1', username: 't' });

  const outcome = await engine.handleJob({ id: 'job1', data: { runId: run.id, attempt: 1 } });

  assert.equal(outcome.outcome, 'failed');
  assert.equal(outcome.code, PROVIDER_ERROR.NOT_CONFIGURED);
  assert.equal(db.__state.runRows.get(run.id).status, 'failed');
});
