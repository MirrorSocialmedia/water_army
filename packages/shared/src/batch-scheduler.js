/**
 * BatchScheduler — MD §7 (排程器與批次執行流程) + §6.2 (lease reconciliation).
 * BR-B2 gen2.
 *
 * The scheduler DISPATCHES, it never executes (MD §7.1: "Scheduler 不得在
 * HTTP request 內同步啟動 50 個容器"): it turns PLANNED batches into RUNNING
 * batches, materializes ONE queued task-run per PENDING membership (idempotent
 * on the run's idempotencyKey + the BullMQ job id), and lets the workers pull
 * jobs within the GLOBAL concurrency cap (container_slot leases — MD §3.1/§7.1;
 * a single-process Promise.all() is explicitly forbidden).
 *
 * Multi-replica safe by construction: every mutation is either a
 * compare-and-set (batchSvc transitions, identity reservations, membership
 * updates) or an idempotent enqueue (deterministic job id) — two schedulers
 * ticking the same cycle converge on the same state, never a double dispatch
 * (MD §14.2: 多個 scheduler replica 不能重複啟動同一個 batch occurrence).
 *
 * Postgres is the source of truth; the queue is transport only (MD §2). A
 * scheduler restart re-derives everything from the DB (boot pass = tick).
 *
 * Zero npm dependencies: db/services/queue are injected (Prisma-shaped or
 * fake-shaped), so the whole module runs hermetically in unit tests.
 */
import {
  BATCH_TERMINAL,
  APP_SETTING_BATCH_GLOBAL_MAX_ACTIVE,
  BATCH_CONFIG_DEFAULTS,
  runIdempotencyKey,
  newUuid,
  BatchError,
} from './batch-constants.js';
import { TASK_RUN_TERMINAL as TASK_RUN_TERMINAL_LOCAL } from './task-constants.js';
import { enqueueBatchRun, removeWaitingBatchRun } from './task-queue.js';

/** Re-exported for consumers that import from the scheduler (single source). */
export const BATCH_SCHEDULER_DEFAULTS = Object.freeze({
  schedulerIntervalMs: 5_000,
  /** Container-slot lease TTL (the worker renews from the heartbeat loop). */
  slotTtlMs: 60_000,
  /** A cancel_requested run older than this is confirmed cancelled by the tick (MD §7.1: redis job 遺失補底). */
  staleCancelMs: 60_000,
});

// ------------------------------------------------------------------ helpers
/**
 * Global container cap (MD §3.1 — admin-managed AppSetting, valueJson
 * `{ value: n }`). Unset/invalid → null (no extra cap beyond the batch's own).
 * Read per dispatch (a PK read is cheap; an admin change applies at the next
 * run, not mid-run).
 */
export async function readGlobalMaxActive(db) {
  try {
    const row = await db.appSetting.findUnique({ where: { key: APP_SETTING_BATCH_GLOBAL_MAX_ACTIVE } });
    const v = row?.valueJson?.value;
    if (Number.isInteger(v) && v >= 1) return { cap: v };
    return { cap: null };
  } catch {
    // AppSetting read failure must NOT stop dispatch — the batch's own cap
    // still bounds concurrency (the slot CAS is the hard limit).
    return { cap: null };
  }
}

/** min(batch cap, global cap) — the ACTUAL slot pool size (MD §3.1). */
export function effectiveSlotCap(batch, globalCap) {
  const cap = Number.isInteger(globalCap) && globalCap >= 1 ? globalCap : Infinity;
  return Math.max(1, Math.min(batch.maxActiveContainers, cap));
}

/**
 * Identity sync plan for a run terminal (MD §6.1 — the engine and the
 * reconciler share this map). Only transitions FROM the expected owning
 * states; a divergence (someone/something else moved the identity) is
 * reported and left alone — never a blind overwrite.
 *
 *   succeeded  → COMPLETED    (from RUNNING)
 *   cancelled  → CANCELLED    (from RUNNING/CANCELLING/RETRY_WAIT/RESERVED/RECOVERING)
 *   failed /   → FAILED_FINAL (from RUNNING/RETRY_WAIT/RESERVED/RECOVERING)
 *   timed_out
 */
export const IDENTITY_SYNC_PLAN = Object.freeze({
  succeeded: { to: 'COMPLETED', from: ['RUNNING'] },
  cancelled: { to: 'CANCELLED', from: ['RUNNING', 'CANCELLING', 'RETRY_WAIT', 'RESERVED', 'RECOVERING'] },
  failed: { to: 'FAILED_FINAL', from: ['RUNNING', 'RETRY_WAIT', 'RESERVED', 'RECOVERING'] },
  timed_out: { to: 'FAILED_FINAL', from: ['RUNNING', 'RETRY_WAIT', 'RESERVED', 'RECOVERING'] },
});

/** Run terminal → membership status (batch_identities mirrors the identity terminal set). */
export const MEMBERSHIP_SYNC_PLAN = Object.freeze({
  succeeded: 'COMPLETED',
  failed: 'FAILED_FINAL',
  timed_out: 'FAILED_FINAL',
  cancelled: 'CANCELLED',
});

/** Terminal-ish run statuses (local alias — keeps the import surface small). */
export const RUN_TERMINAL = TASK_RUN_TERMINAL_LOCAL;

/**
 * @param {object} ctx
 * @param {object} ctx.db prisma client (or fake)
 * @param {object} ctx.batchSvc createBatchService result (the single state owner)
 * @param {object} ctx.leaseSvc createLeaseService result (container slots)
 * @param {object} ctx.taskSvc createTaskRunService result (run FSM + events)
 * @param {object} ctx.queue BullMQ queue (ai-tasks) — producer only
 * @param {object} [ctx.log]
 * @param {() => Date} [ctx.now] injectable clock
 * @param {(run: object) => Promise<{sideEffects:boolean, detail?:string}>} [ctx.inspectEffects]
 *   MD §6.2 "先查 container/log/副作用" seam — the worker wires the adapter
 *   registry's inspect (noop = always { sideEffects: false }); B3's real
 *   adapter reports container truth.
 * @param {object} [ctx.config] { slotTtlMs, staleCancelMs }
 */
export function createBatchScheduler({
  db,
  batchSvc,
  leaseSvc,
  taskSvc,
  queue,
  log = console,
  now = () => new Date(),
  inspectEffects,
  config = {},
} = {}) {
  if (!db || !batchSvc || !leaseSvc || !taskSvc || !queue) {
    throw new TypeError('createBatchScheduler: db + batchSvc + leaseSvc + taskSvc + queue are required');
  }
  const slotTtlMs = Number(config.slotTtlMs ?? BATCH_SCHEDULER_DEFAULTS.slotTtlMs);
  const staleCancelMs = Number(config.staleCancelMs ?? BATCH_SCHEDULER_DEFAULTS.staleCancelMs);

  const runTimeoutMs = (batch) => {
    const sec = Number(batch.configJson?.timeoutSeconds ?? BATCH_CONFIG_DEFAULTS.timeoutSeconds);
    return Math.max(1_000, Math.min(sec, 3_600) * 1_000);
  };

  // ------------------------------------------------------------- identity sync
  /**
   * Sync identity + membership after a run reached a terminal. Divergence
   * (identity already moved by another actor) is LOGGED, never thrown — the
   * state_events stream is the audit, the identity row is the truth.
   */
  async function syncIdentityAfterRunTerminal(run, { actor = 'worker' } = {}) {
    const plan = IDENTITY_SYNC_PLAN[run.status];
    let identitySynced = null;
    if (plan && run.identityId) {
      const identity = await db.identity.findUnique({ where: { id: run.identityId } });
      if (identity && plan.from.includes(identity.status)) {
        try {
          // MD §6.1: there is NO direct RUNNING→CANCELLED edge — a cancelling
          // run parks the identity in CANCELLING first (the stop is real
          // before the terminal). A run that was already stopped while the
          // identity sat in CANCELLING goes straight to CANCELLED.
          if (run.status === 'cancelled' && identity.status === 'RUNNING') {
            await batchSvc.transitionIdentity(run.identityId, 'CANCELLING', {
              reason: `run ${run.id} cancel (stop phase)`,
              actor,
              correlationId: run.batchId ?? null,
            });
          }
          await batchSvc.transitionIdentity(run.identityId, plan.to, {
            reason: `run ${run.id} ${run.status} (attempt ${run.attempt})`,
            actor,
            correlationId: run.batchId ?? null,
          });
          identitySynced = plan.to;
        } catch (err) {
          if (err instanceof BatchError && err.apiCode === 'ILLEGAL_IDENTITY_TRANSITION') {
            log.info?.({ runId: run.id, identityId: run.identityId, from: identity.status, attempted: plan.to }, 'identity sync divergence (already moved — logged, not forced)');
          } else {
            throw err;
          }
        }
      } else if (identity) {
        log.info?.({ runId: run.id, identityId: run.identityId, status: identity.status, attempted: plan.to }, 'identity sync skipped (divergent state)');
      }
    }
    // Membership mirror (CAS from ACTIVE only — a pause-stop already parked it).
    let membershipSynced = null;
    if (run.batchId && run.identityId) {
      const to = MEMBERSHIP_SYNC_PLAN[run.status];
      if (to) {
        const res = await db.batchIdentity.updateMany({
          where: { batchId: run.batchId, identityId: run.identityId, status: 'ACTIVE' },
          data: { status: to },
        });
        membershipSynced = res.count > 0 ? to : null;
      }
    }
    return { identitySynced, membershipSynced };
  }

  // ------------------------------------------------------------- reservation
  /**
   * Reserve a READY identity for a NEW dispatch (pre-generated run id — the
   * run row is created under exactly that id after the reservation wins the
   * READY→RESERVED CAS). Two schedulers racing on one membership: one wins
   * the CAS, the other gets IDENTITY_NOT_READY and skips (no double run).
   */
  async function reserveReadyForDispatch(identityId, runId, { batchId, actor } = {}) {
    try {
      await batchSvc.reserveIdentityForRun({ identityId, runId, actor, correlationId: batchId ?? null, reason: 'batch dispatch' });
      return { ok: true };
    } catch (err) {
      if (err instanceof BatchError && (err.apiCode === 'IDENTITY_NOT_READY' || err.apiCode === 'ACTIVE_RUN_EXISTS')) {
        return { ok: false, reason: err.apiCode };
      }
      throw err;
    }
  }

  /** CANCELLED → READY → RESERVED (pause-stop re-arm; the MD §6.1 re-arm edge). */
  async function rearmCancelledForDispatch(identityId, runId, { batchId, actor } = {}) {
    await batchSvc.transitionIdentity(identityId, 'READY', {
      reason: 're-arm after pause-stop (resume)',
      actor,
      correlationId: batchId ?? null,
    });
    return reserveReadyForDispatch(identityId, runId, { batchId, actor });
  }

  // ------------------------------------------------------------- dispatch core
  /**
   * Materialize runs for every PENDING/CANCELLED(re-armable) membership of a
   * RUNNING batch, idempotently:
   *   - non-terminal run exists  → queued: ensure the job is in the queue
   *                                 (deterministic job id ⇒ reuse, never a
   *                                 double); running/cancel_requested: leave
   *                                 (the engine owns it)
   *   - only terminal runs exist → final (no redispatch); EXCEPT a
   *                                 CANCELLED membership (pause-stop) whose
   *                                 identity is CANCELLED → re-arm + fresh
   *                                 seq run (MD §7.1 pause semantics)
   *   - no runs at all           → reserve (CAS) → create run → membership
   *                                 ACTIVE → enqueue
   *
   * @returns {Promise<{dispatched:number, reused:number, skipped:number}>}
   */
  async function ensureRuns(batch, { actor = 'scheduler' } = {}) {
    const members = await db.batchIdentity.findMany({ where: { batchId: batch.id } });
    members.sort((a, b) => a.position - b.position);
    const out = { dispatched: 0, reused: 0, skipped: 0 };

    for (const m of members) {
      if (['COMPLETED', 'FAILED_FINAL', 'SKIPPED'].includes(m.status)) continue;
      const identity = await db.identity.findUnique({ where: { id: m.identityId } });
      if (!identity) {
        log.warn?.({ batchId: batch.id, identityId: m.identityId }, 'ensureRuns: identity row missing — skipped (FK invariant broken?)');
        out.skipped += 1;
        continue;
      }

      const runs = await db.taskRun.findMany({
        where: { batchId: batch.id, identityId: m.identityId },
        orderBy: { createdAt: 'asc' },
      });
      const liveRun = [...runs].reverse().find((r) => !TASK_RUN_TERMINAL_LOCAL.includes(r.status)) ?? null;

      if (liveRun) {
        if (liveRun.status === 'queued') {
          const res = await enqueueBatchRun(queue, {
            runId: liveRun.id,
            attempt: liveRun.attempt,
            timeoutMs: runTimeoutMs(batch),
            maxAttempts: liveRun.maxAttempts,
          });
          if (res.reused) out.reused += 1;
          else out.dispatched += 1;
        }
        // running / cancel_requested → the engine owns it; nothing to do.
        continue;
      }

      // No live run.
      if (runs.length > 0) {
        const latest = runs[runs.length - 1];
        if (latest.status === 'succeeded' || latest.status === 'failed' || latest.status === 'timed_out') {
          out.skipped += 1; // honest terminal — redispatch is a MANUAL retry (MD §10)
          continue;
        }
        // latest = cancelled (pause-stop) → re-arm this membership once.
        if (m.status !== 'CANCELLED') {
          out.skipped += 1; // a cancelled run under a PENDING membership: divergence — human eyes
          continue;
        }
        if (identity.status !== 'CANCELLED') {
          out.skipped += 1; // identity moved on (e.g. DISABLED) — do not force
          continue;
        }
        const runId = newUuid();
        const rearm = await rearmCancelledForDispatch(identity.id, runId, { batchId: batch.id, actor });
        if (!rearm.ok) {
          out.skipped += 1;
          continue;
        }
        const created = await createAndDispatch(batch, m, identity, runId, runs.length + 1, actor);
        if (created) out.dispatched += 1;
        else out.skipped += 1;
        continue;
      }

      // Fresh membership: identity must be READY (the plan cycle SKIPPED everything else).
      if (identity.status !== 'READY') {
        out.skipped += 1;
        continue;
      }
      const runId = newUuid();
      const res = await reserveReadyForDispatch(identity.id, runId, { batchId: batch.id, actor });
      if (!res.ok) {
        out.skipped += 1;
        continue;
      }
      const created = await createAndDispatch(batch, m, identity, runId, 1, actor);
      if (created) out.dispatched += 1;
      else out.skipped += 1;
    }
    return out;
  }

  /** Create the run row (under the pre-reserved id) + membership ACTIVE + enqueue. */
  async function createAndDispatch(batch, membership, identity, runId, seq, actor) {
    const cfg = batch.configJson ?? {};
    const maxAttempts = Math.max(1, Math.min(Number(cfg.maxAttempts ?? BATCH_CONFIG_DEFAULTS.maxAttempts), 5));
    let run;
    try {
      run = await db.taskRun.create({
        data: {
          id: runId,
          batchId: batch.id,
          identityId: identity.id,
          status: 'queued',
          attempt: 1,
          maxAttempts,
          queuedAt: now(),
          requestedBy: batch.createdBy ?? null,
          inputJson: {
            taskType: 'batch',
            position: membership.position,
            timeoutMs: runTimeoutMs(batch),
            maxAttempts,
            adapter: cfg.adapter ?? null,
          },
          idempotencyKey: runIdempotencyKey(batch.id, identity.id, seq),
        },
      });
    } catch (err) {
      if (String(err?.code ?? '').includes('P2002')) {
        // A peer scheduler won the race (same idempotency key). The identity
        // stays RESERVED for the peer's run — the next tick converges.
        log.info?.({ batchId: batch.id, identityId: identity.id, key: runIdempotencyKey(batch.id, identity.id, seq) }, 'ensureRuns: run create raced (P2002) — peer owns it');
        return false;
      }
      throw err;
    }
    // Membership PENDING/CANCELLED → ACTIVE (CAS on the expected status).
    await db.batchIdentity.updateMany({
      where: { batchId: batch.id, identityId: identity.id, status: membership.status },
      data: { status: 'ACTIVE' },
    });
    await taskSvc.recordEvent(run.id, 'queued', {
      message: 'batch run queued (scheduler dispatch)',
      payload: { batchId: batch.id, identityId: identity.id, position: membership.position, attempt: 1, seq, actor },
    });
    try {
      await enqueueBatchRun(queue, { runId: run.id, attempt: 1, timeoutMs: runTimeoutMs(batch), maxAttempts });
    } catch (err) {
      // Honest failure: the run must not pretend to be running. Keep the row
      // (queued) — the tick's recover pass retries the enqueue; if the queue
      // stays down the run ages out via the stale-cancel sweep and the
      // operator sees a QUEUED run with a CRITICAL log (MD §12.3 唔可以靜默丟失).
      log.error?.({ runId: run.id, error: err.message }, 'ensureRuns: enqueue failed — run left queued for the recover pass');
      return false;
    }
    return true;
  }

  /**
   * CAS wrapper: a concurrent peer may win the transition between our read
   * and our write. On a race we RE-READ: if the batch already reached the
   * intended state (or further), treat it as an idempotent no-op; otherwise
   * surface the error. Multi-scheduler / double-click safe (MD §14.2).
   */
  async function casTransition(batchId, to, attempt, { acceptIfNow } = {}) {
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof BatchError && err.apiCode === 'ILLEGAL_BATCH_TRANSITION')) throw err;
      const live = await db.batch.findUnique({ where: { id: batchId } });
      if (live && (live.status === to || (acceptIfNow?.includes(live.status) ?? false))) {
        return { raced: true, batch: live };
      }
      throw err;
    }
  }

  // ------------------------------------------------------------- lifecycle ops
  /**
   * Start a PLANNED batch (MD §7.2): predecessor gate (batch_no ascending —
   * the next batch only after the previous one satisfied its completion
   * policy), CAS PLANNED→RUNNING, initial dispatch. Idempotent: a batch that
   * is already RUNNING returns without error (multi-scheduler boot passes).
   */
  async function startBatch({ batchId, actor = 'scheduler' }) {
    const batch = await db.batch.findUnique({ where: { id: batchId } });
    if (!batch) throw new BatchError('BATCH_NOT_FOUND', `Batch ${batchId} not found`, { status: 404 });
    if (batch.status === 'RUNNING') return { started: false, reason: 'already-running' };
    if (batch.status !== 'PLANNED') {
      throw new BatchError('BATCH_NOT_STARTABLE', `Batch is '${batch.status}' — only PLANNED batches start (use resume for PAUSED)`, { status: 409 });
    }
    const siblings = await db.batch.findMany({ where: { cycleId: batch.cycleId }, orderBy: { batchNo: 'asc' } });
    const blocked = siblings.filter((s) => s.batchNo < batch.batchNo && !['COMPLETED', 'COMPLETED_WITH_ERRORS'].includes(s.status));
    if (blocked.length) {
      const detail = blocked.map((s) => `#${s.batchNo}=${s.status}`).join(', ');
      throw new BatchError('BATCH_ORDER_GATE', `Predecessor batches not complete: ${detail} (MD §3.2)`, { status: 409 });
    }
    const res = await casTransition(batchId, 'RUNNING', async () =>
      batchSvc.transitionBatch(batchId, 'RUNNING', {
        reason: 'batch started',
        actor,
        correlationId: batch.cycleId,
      }),
    );
    if (res.raced) return { started: false, reason: 'already-running' };
    const fresh = await db.batch.findUnique({ where: { id: batchId } });
    const ensured = await ensureRuns(fresh, { actor });
    return { started: true, ...ensured };
  }

  /**
   * Pause (MD §7.1: 暫停只禁止建立新 run；是否停止現有 run 必須明確選項).
   * stopExisting=false → in-flight runs finish, queued runs are cancelled
   * immediately (they own no resources); stopExisting=true → EVERY non-
   * terminal run is cancel_requested (the engine performs the real stop for
   * running ones — 真停).
   */
  async function pauseBatch({ batchId, stopExisting = false, actor = 'operator' }) {
    const batch = await db.batch.findUnique({ where: { id: batchId } });
    if (!batch) throw new BatchError('BATCH_NOT_FOUND', `Batch ${batchId} not found`, { status: 404 });
    if (batch.status !== 'RUNNING') {
      throw new BatchError('BATCH_NOT_PAUSABLE', `Batch is '${batch.status}' — only RUNNING batches pause`, { status: 409 });
    }
    const res = await casTransition(batchId, 'PAUSED', async () =>
      batchSvc.transitionBatch(batchId, 'PAUSED', { reason: `paused (stopExisting=${stopExisting})`, actor, correlationId: batch.cycleId }),
    );
    const runs = await db.taskRun.findMany({
      where: { batchId, status: { in: ['queued', 'running', 'cancel_requested'] } },
    });
    let cancelledQueued = 0;
    let requested = 0;
    for (const run of runs) {
      if (run.status === 'queued') {
        // Not started → no engine, no resources: stop it NOW (honest stop,
        // MD §7.1: pause 唔可以令 queued run 繼續派發).
        await taskSvc.requestCancel(run.id, { actorUserId: actor, reason: 'batch paused' });
        await removeWaitingBatchRun(queue, run.id, run.attempt);
        await taskSvc.markCancelled(run.id, { reason: 'batch paused (queued stop)' });
        await syncIdentityAfterRunTerminal(await taskSvc.loadRun(run.id), { actor: 'scheduler' });
        cancelledQueued += 1;
      } else if (!stopExisting && run.status === 'running') {
        // Keep running: it finishes naturally; the batch stays PAUSED so the
        // scheduler dispatches nothing new while it lands.
        continue;
      } else {
        await taskSvc.requestCancel(run.id, { actorUserId: actor, reason: 'batch paused (stopExisting)' });
        requested += 1;
      }
    }
    const fresh = await db.batch.findUnique({ where: { id: batchId } });
    return { batch: fresh, stopExisting, cancelledQueued, requested };
  }

  /** Resume a PAUSED batch: CAS PAUSED→RUNNING + re-dispatch (re-arms pause-stop victims). */
  async function resumeBatch({ batchId, actor = 'operator' }) {
    const batch = await db.batch.findUnique({ where: { id: batchId } });
    if (!batch) throw new BatchError('BATCH_NOT_FOUND', `Batch ${batchId} not found`, { status: 404 });
    if (batch.status !== 'PAUSED') {
      throw new BatchError('BATCH_NOT_RESUMABLE', `Batch is '${batch.status}' — only PAUSED batches resume`, { status: 409 });
    }
    const res = await casTransition(batchId, 'RUNNING', async () =>
      batchSvc.transitionBatch(batchId, 'RUNNING', { reason: 'resumed', actor, correlationId: batch.cycleId }),
    );
    const fresh = await db.batch.findUnique({ where: { id: batchId } });
    const ensured = await ensureRuns(fresh, { actor });
    return { batch: fresh, ...ensured };
  }

  /**
   * Cancel (MD §7.1): PLANNED → CANCELLED immediately (memberships parked,
   * no runs exist); RUNNING/PAUSED → CANCELLING (requestCancel everything +
   * queued stopped now) — the tick's finalizer flips to CANCELLED once no
   * non-terminal run remains (202 semantics: the API returns immediately).
   */
  async function cancelBatch({ batchId, actor = 'operator' }) {
    const batch = await db.batch.findUnique({ where: { id: batchId } });
    if (!batch) throw new BatchError('BATCH_NOT_FOUND', `Batch ${batchId} not found`, { status: 404 });
    if (BATCH_TERMINAL.includes(batch.status)) {
      return { batch, immediate: false, requested: 0, note: `already ${batch.status}` };
    }

    if (batch.status === 'PLANNED') {
      await batchSvc.transitionBatch(batchId, 'CANCELLED', { reason: 'cancelled before start', actor, correlationId: batch.cycleId });
      await db.batchIdentity.updateMany({ where: { batchId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      const fresh = await db.batch.findUnique({ where: { id: batchId } });
      return { batch: fresh, immediate: true, requested: 0 };
    }

    const res = await casTransition(batchId, 'CANCELLING', async () =>
      batchSvc.transitionBatch(batchId, 'CANCELLING', { reason: 'cancel requested', actor, correlationId: batch.cycleId }),
    );
    const runs = await db.taskRun.findMany({
      where: { batchId, status: { in: ['queued', 'running', 'cancel_requested'] } },
    });
    let cancelledQueued = 0;
    let requested = 0;
    for (const run of runs) {
      if (run.status === 'queued') {
        await taskSvc.requestCancel(run.id, { actorUserId: actor, reason: 'batch cancelled' });
        await removeWaitingBatchRun(queue, run.id, run.attempt);
        await taskSvc.markCancelled(run.id, { reason: 'batch cancelled (queued stop)' });
        await syncIdentityAfterRunTerminal(await taskSvc.loadRun(run.id), { actor: 'scheduler' });
        cancelledQueued += 1;
      } else if (run.status !== 'cancel_requested') {
        await taskSvc.requestCancel(run.id, { actorUserId: actor, reason: 'batch cancelled' });
        requested += 1;
      }
    }
    const fresh = await db.batch.findUnique({ where: { id: batchId } });
    return { batch: fresh, immediate: false, requested, cancelledQueued };
  }

  // ------------------------------------------------------------- tick passes
  /**
   * Pass 1 — progress cycles (MD §3.2): for each cycle, the FIRST PLANNED
   * batch whose predecessors all satisfied the completion policy starts,
   * subject to the successor's inter_batch_cooldown_seconds (measured from
   * the latest predecessor finishedAt). A CANCELLED predecessor STALLS the
   * cycle (human judgement required — logged, never auto-skipped).
   */
  async function progressCycles(ctx) {
    const planned = await db.batch.findMany({ where: { status: 'PLANNED' } });
    const cycleIds = [...new Set(planned.map((b) => b.cycleId))];
    const started = [];
    for (const cycleId of cycleIds) {
      const all = await db.batch.findMany({ where: { cycleId }, orderBy: { batchNo: 'asc' } });
      for (const b of all) {
        if (b.status !== 'PLANNED') continue;
        const preds = all.filter((p) => p.batchNo < b.batchNo);
        if (preds.some((p) => p.status === 'CANCELLED')) {
          log.warn?.({ cycleId, batchNo: b.batchNo }, 'cycle stalled: a predecessor batch was CANCELLED — human judgement required (MD §3.2)');
          break;
        }
        if (!preds.every((p) => ['COMPLETED', 'COMPLETED_WITH_ERRORS'].includes(p.status))) continue;
        const finishedPreds = preds.filter((p) => p.finishedAt).sort((x, y) => new Date(y.finishedAt) - new Date(x.finishedAt));
        const cooldownSec = Number(b.configJson?.interBatchCooldownSeconds ?? 0);
        if (finishedPreds.length && cooldownSec > 0) {
          const waitMs = cooldownSec * 1_000 - (now().getTime() - new Date(finishedPreds[0].finishedAt).getTime());
          if (waitMs > 0) continue; // cooldown not elapsed yet
        }
        try {
          const res = await startBatch({ batchId: b.id, actor: 'scheduler' });
          if (res.started) started.push(b.id);
        } catch (err) {
          log.warn?.({ batchId: b.id, error: err.message }, 'progressCycles: start failed (will retry next tick)');
        }
        break; // at most one start per cycle per tick (deterministic order)
      }
    }
    void ctx;
    return started;
  }

  /** Pass 2 — recover orphaned runs: every RUNNING batch re-ensures dispatch (idempotent). */
  async function recoverOrphanedRuns() {
    const running = await db.batch.findMany({ where: { status: 'RUNNING' } });
    let dispatched = 0;
    let reused = 0;
    for (const batch of running) {
      try {
        const res = await ensureRuns(batch, { actor: 'scheduler' });
        dispatched += res.dispatched;
        reused += res.reused;
      } catch (err) {
        log.error?.({ batchId: batch.id, error: err.message }, 'recoverOrphanedRuns: ensure failed');
      }
    }
    return { dispatched, reused };
  }

  /**
   * Pass 3 — finalize CANCELLING batches: no non-terminal run AND no
   * PENDING/ACTIVE membership left → CANCELLED (the CAS makes double
   * finalization a no-op).
   */
  async function finalizeCancellingBatches() {
    const cancelling = await db.batch.findMany({ where: { status: 'CANCELLING' } });
    const final = [];
    for (const batch of cancelling) {
      const liveRuns = await db.taskRun.findMany({
        where: { batchId: batch.id, status: { notIn: TASK_RUN_TERMINAL_LOCAL } },
      });
      if (liveRuns.length) continue;
      const liveMembers = await db.batchIdentity.count({ where: { batchId: batch.id, status: { in: ['PENDING', 'ACTIVE'] } } });
      if (liveMembers.count > 0) continue;
      try {
        await batchSvc.transitionBatch(batch.id, 'CANCELLED', {
          reason: 'cancel finalized (no live runs remain)',
          actor: 'scheduler',
          correlationId: batch.cycleId,
        });
        final.push(batch.id);
      } catch (err) {
        if (!(err instanceof BatchError && err.apiCode === 'ILLEGAL_BATCH_TRANSITION')) throw err;
      }
    }
    return final;
  }

  /** Pass 4 — completion evaluation for RUNNING batches (B1 service owns the transition). */
  async function evaluateRunningBatches() {
    const running = await db.batch.findMany({ where: { status: 'RUNNING' } });
    const outcomes = [];
    for (const batch of running) {
      try {
        const res = await batchSvc.evaluateBatchCompletion(batch.id, { actor: 'scheduler', correlationId: batch.cycleId });
        outcomes.push({ batchId: batch.id, ...res });
      } catch (err) {
        log.error?.({ batchId: batch.id, error: err.message }, 'evaluateBatchCompletion failed');
      }
    }
    return outcomes;
  }

  /**
   * Pass 5 — expired-lease reconciliation (MD §6.2: 租約過期不能立即任意重跑，
   * 先檢查 container、run log 和外部副作用).
   *
   *   expired container_slot lease
   *     ├─ no run / run terminal → release (owner-only, idempotent)
   *     ├─ side effects TRUE     → identity RUNNING→RECOVERING (isolated),
   *     │                           CRITICAL log, slot freed, NO auto re-run
   *     ├─ cancel_requested      → markCancelled + sync (honest stop)
   *     ├─ attempt ≥ maxAttempts → failed EXECUTOR_LOST + identity FAILED_FINAL
   *     └─ else                  → failed EXECUTOR_LOST + identity RETRY_WAIT
   *                                + requestRetry (fresh attempt, auto-dispatched)
   */
  async function reconcileExpiredLeases() {
    const expired = await leaseSvc.listExpired(now());
    const summary = { scanned: expired.length, released: 0, isolated: 0, cancelled: 0, retried: 0, finalFailed: 0, errors: [] };
    for (const lease of expired) {
      if (lease.resourceType !== 'container_slot') continue; // port/identity leases: B3 scope
      try {
        await reconcileOneSlotLease(lease, summary);
      } catch (err) {
        summary.errors.push({ slot: lease.resourceKey, runId: lease.ownerRunId, error: err.message });
        log.error?.({ slot: lease.resourceKey, runId: lease.ownerRunId, error: err.message }, 'lease reconciliation item failed');
      }
    }
    return summary;
  }

  async function reconcileOneSlotLease(lease, summary) {
    const { resourceType, resourceKey, ownerRunId } = lease;
    const run = ownerRunId ? await db.taskRun.findUnique({ where: { id: ownerRunId } }) : null;

    // No run / run already terminal → the slot is just a stale lease row.
    if (!run || TASK_RUN_TERMINAL_LOCAL.includes(run.status)) {
      if (ownerRunId) {
        await leaseSvc.release({ resourceType, resourceKey, ownerRunId });
      } else {
        // Unbound expired lease (defensive: slots are always bound by the
        // engine). Delete by key with ownerRunId null — no owner can object.
        await db.resourceLease.deleteMany({ where: { resourceType, resourceKey, ownerRunId: null } });
      }
      summary.released += 1;
      return;
    }

    // MD §6.2 — inspect BEFORE any re-run decision (container/log/side effects).
    const inspection = typeof inspectEffects === 'function'
      ? await inspectEffects(run)
      : { sideEffects: false };

    if (inspection.sideEffects) {
      // Isolate: the identity is quarantined for a human (RECOVERING), the
      // slot is freed, and NOTHING is re-run automatically (MD §6.2 紅線).
      const identity = run.identityId ? await db.identity.findUnique({ where: { id: run.identityId } }) : null;
      if (identity && identity.status === 'RUNNING') {
        await batchSvc.transitionIdentity(run.identityId, 'RECOVERING', {
          reason: `expired lease with side effects (run ${run.id}) — isolated, manual review required`,
          actor: 'scheduler:reconciler',
          correlationId: run.batchId ?? null,
          details: { runId: run.id, attempt: run.attempt, inspection: inspection.detail ?? null },
        });
      }
      await leaseSvc.release({ resourceType, resourceKey, ownerRunId });
      log.error?.({ runId: run.id, slot: resourceKey, identityId: run.identityId }, 'CRITICAL: expired lease WITH side effects — identity RECOVERING, no auto re-run (MD §6.2)');
      summary.isolated += 1;
      return;
    }

    if (run.status === 'cancel_requested') {
      await taskSvc.markCancelled(run.id, { reason: 'executor lost during cancel (lease expired)' });
      await syncIdentityAfterRunTerminal(await taskSvc.loadRun(run.id), { actor: 'scheduler:reconciler' });
      await leaseSvc.release({ resourceType, resourceKey, ownerRunId });
      summary.cancelled += 1;
      return;
    }

    // Executor died mid-run (crash / kill -9 / wedged process).
    if (run.attempt >= run.maxAttempts) {
      await taskSvc.finishRun(run.id, {
        status: 'failed',
        errorCode: 'EXECUTOR_LOST',
        errorMessage: `Executor lost: lease ${resourceKey} expired at attempt ${run.attempt} (no auto re-run — max attempts reached)`,
        attempt: run.attempt,
      });
      await syncIdentityAfterRunTerminal(await taskSvc.loadRun(run.id), { actor: 'scheduler:reconciler' });
      await leaseSvc.release({ resourceType, resourceKey, ownerRunId });
      summary.finalFailed += 1;
      return;
    }

    // Fresh attempt: honest terminal + RETRY_WAIT identity + requestRetry
    // (the batch-aware enqueue seam re-dispatches attempt N+1).
    await taskSvc.finishRun(run.id, {
      status: 'failed',
      errorCode: 'EXECUTOR_LOST',
      errorMessage: `Executor lost: lease ${resourceKey} expired at attempt ${run.attempt} — auto-retrying (attempt ${run.attempt + 1})`,
      attempt: run.attempt,
    });
    if (run.identityId) {
      const identity = await db.identity.findUnique({ where: { id: run.identityId } });
      if (identity && identity.status === 'RUNNING') {
        await batchSvc.transitionIdentity(run.identityId, 'RETRY_WAIT', {
          reason: `executor lost (run ${run.id} attempt ${run.attempt}) — auto-retry`,
          actor: 'scheduler:reconciler',
          correlationId: run.batchId ?? null,
        });
      }
    }
    await taskSvc.requestRetry(run.id, { actorUserId: 'scheduler:reconciler', note: 'lease expired — executor lost' });
    await leaseSvc.release({ resourceType, resourceKey, ownerRunId });
    summary.retried += 1;
  }

  /**
   * Pass 6 — stale cancel_requested sweep (MD §7.1 補底): a cancel_requested
   * run whose row is unchanged for staleCancelMs has no live executor to
   * confirm the stop (worker died, job lost) → confirm it + sync.
   */
  async function sweepStaleCancelRequests() {
    const cutoff = new Date(now().getTime() - staleCancelMs);
    const stale = await db.taskRun.findMany({
      where: { status: 'cancel_requested', updatedAt: { lt: cutoff } },
    });
    let confirmed = 0;
    for (const run of stale) {
      try {
        await taskSvc.markCancelled(run.id, { reason: 'stale cancel_requested (executor gone)' });
        if (run.batchId) await syncIdentityAfterRunTerminal(await taskSvc.loadRun(run.id), { actor: 'scheduler' });
        confirmed += 1;
      } catch (err) {
        log.error?.({ runId: run.id, error: err.message }, 'stale cancel sweep item failed');
      }
    }
    return confirmed;
  }

  // ------------------------------------------------------------- tick
  /**
   * One scheduler tick (all passes, in order; each idempotent + guarded).
   * @returns {Promise<object>} per-pass summary (tests assert on it).
   */
  async function tick() {
    const summary = {
      started: [],
      recovered: null,
      finalizing: [],
      completion: [],
      leases: null,
      staleCancelled: 0,
      errors: [],
    };
    for (const [name, fn] of [
      ['progressCycles', () => progressCycles(summary)],
      ['recoverOrphanedRuns', recoverOrphanedRuns],
      ['finalizeCancellingBatches', finalizeCancellingBatches],
      ['evaluateRunningBatches', evaluateRunningBatches],
      ['reconcileExpiredLeases', reconcileExpiredLeases],
      ['sweepStaleCancelRequests', sweepStaleCancelRequests],
    ]) {
      try {
        const res = await fn();
        if (name === 'progressCycles') summary.started = res;
        else if (name === 'recoverOrphanedRuns') summary.recovered = res;
        else if (name === 'finalizeCancellingBatches') summary.finalizing = res;
        else if (name === 'evaluateRunningBatches') summary.completion = res;
        else if (name === 'reconcileExpiredLeases') summary.leases = res;
        else if (name === 'sweepStaleCancelRequests') summary.staleCancelled = res;
      } catch (err) {
        summary.errors.push({ pass: name, error: err.message });
        log.error?.({ pass: name, error: err.message }, 'scheduler pass failed (continuing)');
      }
    }
    return summary;
  }

  return {
    // lifecycle ops (API + tick both call these)
    startBatch,
    pauseBatch,
    resumeBatch,
    cancelBatch,
    ensureRuns,
    // sync + caps
    syncIdentityAfterRunTerminal,
    readGlobalMaxActive,
    effectiveSlotCap,
    // tick passes (exported for hermetic unit tests)
    tick,
    progressCycles,
    recoverOrphanedRuns,
    finalizeCancellingBatches,
    evaluateRunningBatches,
    reconcileExpiredLeases,
    sweepStaleCancelRequests,
  };
}

/**
 * Scheduler wrapper: boot pass (immediate tick) + guarded interval (an
 * in-flight tick never overlaps — a slow tick must not stack; MD §7.1).
 * `start()` is idempotent; `stop()` is safe from shutdown paths.
 */
export function createBatchSchedulerLoop(scheduler, { intervalMs, log = console } = {}) {
  const ms = Math.max(1_000, Number(intervalMs ?? BATCH_SCHEDULER_DEFAULTS.schedulerIntervalMs));
  let timer = null;
  let running = false;
  let stopped = false;

  async function guardedTick() {
    if (stopped || running) return running ? 'skipped-in-flight' : 'stopped';
    running = true;
    try {
      await scheduler.tick();
      return 'ok';
    } catch (err) {
      log.error?.({ error: err.message }, 'batch scheduler tick crashed (guarded)');
      return 'error';
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer || stopped) return;
      void guardedTick(); // boot pass: re-derive from the DB (MD §7.1 重啟 reconcile)
      timer = setInterval(() => void guardedTick(), ms);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** Test seam: drive one guarded tick by hand. */
    tickOnce: guardedTick,
    isRunning: () => running,
  };
}
