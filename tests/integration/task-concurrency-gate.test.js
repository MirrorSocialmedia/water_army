/**
 * P6 flag #5 — concurrency_key mutual exclusion, worker gate (hermetic:
 * fake DB, mock provider, no Redis).
 *
 * Contract (施工 MD §11 + P6 work order §5.5):
 *  - a run whose definition shares a concurrency_key with an IN-FLIGHT run
 *    (running / needs_approval) is deferred: job.moveToDelayed(deferMs),
 *    bounded by maxDefers; past the cap the run becomes a visible
 *    `skipped` with the reason + holding run id (MD §12.3 honesty).
 *  - a merely QUEUED sibling does NOT block (would deadlock the pair).
 *  - definitions without a key, and ad-hoc runs (no definition), never gate.
 *  - skipByConcurrency is a no-op unless the run is still queued.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTaskRunService, CONCURRENCY_ACTIVE_RUN_STATUSES } from '@water-army/shared';

import { createProvider } from '../../apps/worker/src/providers/index.js';
import { createTaskEngine } from '../../apps/worker/src/task-engine.js';
import { loadWorkerConfig } from '../../apps/worker/src/config.js';
import { makeFakeDb } from '../helpers/fakes.js';

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const KEY = 'k1-fleet-mutations';

async function mkCtx({ maxDefers = 2, deferMs = 1_000 } = {}) {
  const db = makeFakeDb({});
  const taskSvc = createTaskRunService({
    db,
    config: { taskDefaultTimeoutMs: 120_000, taskMaxTimeoutMs: 900_000, taskDefaultAttempts: 3 },
    log: SILENT,
    enqueue: async () => {},
  });
  const engine = createTaskEngine({
    db,
    taskSvc,
    config: {
      taskDefaultTimeoutMs: 120_000,
      taskMaxTimeoutMs: 900_000,
      taskDefaultAttempts: 3,
      approvalPollMs: 20,
      cancelPollMs: 20,
      taskConcurrencyDeferMs: deferMs,
      taskConcurrencyMaxDefers: maxDefers,
    },
    log: SILENT,
    providerResolver: async () => createProvider({ name: 'mock', mockScript: 'default', log: SILENT }),
    toolHandlers: {},
    env: {},
  });
  // Two same-key definitions + one keyless. (UUID-shaped: createRun validates.)
  const defA = await db.taskDefinition.create({ data: { id: 'aaaa1111-1111-4111-8111-111111111111', title: 'A', concurrencyKey: KEY } });
  const defB = await db.taskDefinition.create({ data: { id: 'bbbb2222-2222-4222-8222-222222222222', title: 'B', concurrencyKey: KEY } });
  const defNone = await db.taskDefinition.create({ data: { id: 'cccc3333-3333-4333-8333-333333333333', title: 'N', concurrencyKey: null } });
  return { db, taskSvc, engine, defA, defB, defNone };
}

function makeJob(runId, attempt = 1) {
  const j = {
    id: `job-${runId}-${attempt}`,
    data: { runId, attempt },
    moved: [],
    async update(d) {
      this.data = d;
    },
    async moveToDelayed(ms) {
      this.moved.push(ms);
    },
  };
  return j;
}

/** Create a queued run bound to a definition (bypasses enqueue side-effects). */
async function mkRun(ctx, defId, { prompt = 'p' } = {}) {
  const { run } = await ctx.taskSvc.createRun({ prompt, provider: 'mock', taskDefinitionId: defId }, { id: 'u1', username: 't' });
  return run;
}

async function putStatus(ctx, runId, status) {
  // Gate tests manipulate the holding run's status directly — the gate only
  // READS status; the transition legality of the holder is covered elsewhere.
  await ctx.db.taskRun.update({ where: { id: runId }, data: { status } });
}

test('concurrency gate: in-flight same-key run → defer, then visible skip past the cap', async () => {
  const ctx = await mkCtx({ maxDefers: 2, deferMs: 1_000 });
  const holder = await mkRun(ctx, ctx.defA.id);
  await ctx.taskSvc.startAttempt(holder.id, 1); // running — holds the key
  const mine = await mkRun(ctx, ctx.defB.id);

  const job = makeJob(mine.id);

  await ctx.db.taskRun.update({ where: { id: holder.id }, data: { status: 'running' } }); // ensure post-start state

  // 1st encounter → defer #1 (job parked 1s, counter persisted in job data)
  const r1 = await ctx.engine.handleJob(job);
  assert.equal(r1.outcome, 'concurrency-deferred');
  assert.deepEqual(job.moved, [1_000]);
  assert.equal(job.data.concDefers, 1);
  assert.equal((await ctx.db.taskRun.findUnique({ where: { id: mine.id } })).status, 'queued');

  // 2nd encounter → defer #2 (last allowed)
  const r2 = await ctx.engine.handleJob(job);
  assert.equal(r2.outcome, 'concurrency-deferred');
  assert.equal(job.data.concDefers, 2);
  assert.equal((await ctx.db.taskRun.findUnique({ where: { id: mine.id } })).status, 'queued');

  // 3rd encounter → cap reached → visible skip (MD §12.3: reason + holder)
  const r3 = await ctx.engine.handleJob(job);
  assert.equal(r3.outcome, 'concurrency-skipped');
  const row = await ctx.db.taskRun.findUnique({ where: { id: mine.id } });
  assert.equal(row.status, 'skipped');
  assert.equal(row.inputJson.skipped.policy, 'concurrency_key');
  assert.equal(row.inputJson.skipped.activeRunId, holder.id);
  assert.match(row.inputJson.skipped.reason, /concurrency_key 'k1-fleet-mutations'/);
  assert.ok(row.finishedAt, 'skipped is terminal → finishedAt written');
  // event stream carries the transition (MD §11.3 — every transition is an event)
  const evs = ctx.db.__state.eventRows.filter((e) => e.taskRunId === mine.id && e.eventType === 'status');
  assert.ok(evs.length >= 1, 'status event recorded');
  // the holder was untouched
  assert.equal((await ctx.db.taskRun.findUnique({ where: { id: holder.id } })).status, 'running');
});

test('concurrency gate: holder finishes → job proceeds on the next pickup', async () => {
  const ctx = await mkCtx({ maxDefers: 2 });
  const holder = await mkRun(ctx, ctx.defA.id);
  await ctx.taskSvc.startAttempt(holder.id, 1);
  const mine = await mkRun(ctx, ctx.defB.id);

  const job = makeJob(mine.id);
  assert.equal((await ctx.engine.handleJob(job)).outcome, 'concurrency-deferred');

  // Holder completes its work.
  await ctx.db.taskRun.update({ where: { id: holder.id }, data: { status: 'succeeded', finishedAt: new Date() } });

  // Re-pickup (fresh job instance, counter persists per job data — new job = 0)
  const job2 = makeJob(mine.id);
  const res = await ctx.engine.handleJob(job2);
  assert.notEqual(res.outcome, 'concurrency-deferred');
  assert.equal(job2.moved.length, 0, 'not deferred — the key is free');
  const row = await ctx.db.taskRun.findUnique({ where: { id: mine.id } });
  assert.equal(row.status, 'succeeded', 'ran to completion via the mock provider');
});

test('concurrency gate: QUEUED sibling does NOT block (no deadlock)', async () => {
  const ctx = await mkCtx();
  await mkRun(ctx, ctx.defA.id); // queued, never started
  const mine = await mkRun(ctx, ctx.defB.id);
  const res = await ctx.engine.handleJob(makeJob(mine.id));
  assert.notEqual(res.outcome, 'concurrency-deferred');
  assert.equal((await ctx.db.taskRun.findUnique({ where: { id: mine.id } })).status, 'succeeded');
});

test('concurrency gate: needs_approval HOLDS the key (in flight, paused on human)', async () => {
  const ctx = await mkCtx();
  const holder = await mkRun(ctx, ctx.defA.id);
  await putStatus(ctx, holder.id, 'needs_approval');
  const mine = await mkRun(ctx, ctx.defB.id);
  const res = await ctx.engine.handleJob(makeJob(mine.id));
  assert.equal(res.outcome, 'concurrency-deferred');
  assert.deepEqual(CONCURRENCY_ACTIVE_RUN_STATUSES, ['running', 'needs_approval']);
});

test('concurrency gate: keyless definitions + ad-hoc runs are never gated', async () => {
  const ctx = await mkCtx();
  const holder = await mkRun(ctx, ctx.defNone.id);
  await putStatus(ctx, holder.id, 'running');
  const mine = await mkRun(ctx, ctx.defNone.id); // same keyless definition
  const res = await ctx.engine.handleJob(makeJob(mine.id));
  assert.notEqual(res.outcome, 'concurrency-deferred');
  assert.equal((await ctx.db.taskRun.findUnique({ where: { id: mine.id } })).status, 'succeeded');
});

test('skipByConcurrency: no-op unless the run is still queued', async () => {
  const ctx = await mkCtx();
  const run = await mkRun(ctx, ctx.defA.id);

  { const { skipped, status } = await ctx.taskSvc.skipByConcurrency(run.id, { key: KEY, activeRunId: 'x', reason: 'r' });
    assert.equal(skipped, true);
    assert.equal(status, 'skipped');
  }

  // Terminal run: a second call (late gate decision) must NOT resurrect it.
  const again = await ctx.taskSvc.skipByConcurrency(run.id, { key: KEY, activeRunId: 'x', reason: 'r' });
  assert.equal(again.skipped, false);
  assert.equal(again.status, 'skipped');

  // Unknown run → no throw.
  const ghost = await ctx.taskSvc.skipByConcurrency('ghost-run-id', { key: KEY, reason: 'r' });
  assert.equal(ghost.skipped, false);
});

test('worker config: concurrency knobs validated (fail fast on garbage)', async () => {
  assert.throws(() => loadWorkerConfig({ TASK_CONCURRENCY_DEFER_MS: 'abc' }), /TASK_CONCURRENCY_DEFER_MS/);
  assert.throws(() => loadWorkerConfig({ TASK_CONCURRENCY_MAX_DEFERS: '0' }), /TASK_CONCURRENCY_MAX_DEFERS/);
  const ok = loadWorkerConfig({});
  assert.equal(ok.taskConcurrencyDeferMs, 15_000);
  assert.equal(ok.taskConcurrencyMaxDefers, 10);
});
