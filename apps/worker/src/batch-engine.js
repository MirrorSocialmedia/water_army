/**
 * Batch run engine (BR-B2 gen2, MD §7 worker-side execution).
 *
 * Processes one `batch-run` BullMQ job { runId, attempt, timeoutMs,
 * maxAttempts }. The ordered gates are locked by design (see progress
 * file gen2 section) and mirror the AI task engine where it matters:
 *
 *   0. stale guards (run gone / terminal / superseded attempt)
 *   1. batch gate        — batch must be RUNNING (else: stop the run)
 *   2. identity guard    — identity must be RESERVED/RETRY_WAIT
 *   3. GLOBAL slot gate  — container_slot lease (the MD §3.1 hard cap;
 *                          no slot → job.moveToDelayed, run stays queued —
 *                          NOTHING holds resources while waiting)
 *   4. claim CAS         — queued→running on (id, attempt); the single
 *                          winner of a duplicated delivery
 *   5. identity → RUNNING
 *   6. network gate      — the SAME B4 fail-closed gate the AI engine uses
 *                          (taskType 'batch'; an explicit
 *                          policy.taskTypes.batch === false denies)
 *   7. adapter execution — heartbeat (row heartbeatAt + slot lease renew),
 *                          cancel polling, hard timeout; adapter via the
 *                          registry (allowlist, fail-closed)
 *   8. terminal handling — succeeded / failed (retryable → auto-retry) /
 *                          timed_out / cancelled / SLOT_LEASE_LOST +
 *                          identity + membership sync (shared map) +
 *                          slot release (always)
 *
 * MD §2: the DB is the source of truth — every terminal here is a CAS on
 * the run row, so a crash anywhere leaves an honest, reconcilable state
 * (the scheduler's lease reconciliation is the backstop, MD §6.2).
 */
import {
  TASK_RUN_TERMINAL,
  TASK_EVENT,
  NETWORK_GATE_ERROR,
  BATCH_CONFIG_DEFAULTS,
} from '@water-army/shared';
import { AdapterError } from './adapter-registry.js';

const SLOT_RESOURCE_TYPE = 'container_slot';

function isAbortReason(reason, name) {
  return typeof reason === 'string' && reason.startsWith(name);
}

export function createBatchEngine({
  db,
  taskSvc,
  batchSvc,
  leaseSvc,
  scheduler,
  adapterRegistry,
  networkGate = null,
  config = {},
  log = console,
  now = () => new Date(),
}) {
  const heartbeatMs = Math.max(1_000, Number(config.batchHeartbeatMs ?? 10_000));
  const cancelPollMs = Math.max(250, Number(config.batchCancelPollMs ?? 2_000));
  const slotWaitMs = Math.max(1_000, Number(config.batchSlotWaitMs ?? 15_000));
  const slotTtlMs = Math.max(5_000, Number(config.batchSlotTtlMs ?? 60_000));
  const maxSlotDefers = Math.max(1, Number(config.batchMaxSlotDefers ?? 40));
  const defaultTimeoutMs = Number(config.batchDefaultTimeoutMs ?? 120_000);

  /**
   * Claim the run (CAS on id+status+attempt). count===1 is the single
   * winner; everyone else (duplicate delivery, re-fetch) is a no-op.
   */
  async function claimRun(runId, attempt) {
    const res = await db.taskRun.updateMany({
      where: { id: runId, status: 'queued', attempt },
      data: { status: 'running', startedAt: now(), heartbeatAt: now() },
    });
    return res.count === 1 ? 'won' : 'lost';
  }

  /** queued/cancel_requested run → honest cancelled + identity sync. */
  async function stopQueuedRun(runId, reason) {
    const run = await taskSvc.loadRun(runId, { mustExist: false });
    if (!run) return { stopped: false, stopReason: 'gone' };
    if (TASK_RUN_TERMINAL.includes(run.status)) return { stopped: false, stopReason: 'stale-terminal' };
    if (run.status !== 'cancel_requested') {
      await taskSvc.requestCancel(runId, { actorUserId: 'engine', reason });
    }
    await taskSvc.markCancelled(runId, { reason });
    await scheduler.syncIdentityAfterRunTerminal(await taskSvc.loadRun(runId), { actor: 'engine' });
    return { stopped: true };
  }

  /**
   * B4 network gate (fail-closed). The verdict deny is applied as a FAILED
   * terminal (queued→failed is a legal edge — the gate runs pre-claim here
   * because a denied run must never burn a slot or move the identity):
   * the operator fixes the allowlist and retries (manual).
   */
  async function gateNetwork(runId, attempt, run) {
    if (typeof networkGate !== 'function') return { denied: false }; // no policy configured = allow (default mock)
    let verdict;
    try {
      verdict = await networkGate({
        runId,
        attempt,
        identityId: run?.identityId ?? null,
        batchId: run?.batchId ?? null,
        taskType: 'batch',
      });
    } catch (err) {
      verdict = { allowed: false, code: NETWORK_GATE_ERROR.POLICY_UNAVAILABLE, reason: `network gate crashed: ${err.message}` };
    }
    if (verdict?.allowed !== false) return { denied: false };
    const code = typeof verdict.code === 'string' && verdict.code.length > 0
      ? verdict.code
      : NETWORK_GATE_ERROR.POLICY_UNAVAILABLE;
    const why = String(verdict.reason ?? 'network policy denied').slice(0, 500);
    try {
      await taskSvc.finishRun(runId, { status: 'failed', errorCode: code, errorMessage: `network gate: ${why}`, attempt });
      log.warn?.({ runId, code }, 'batch engine: network gate denied run (fail-closed)');
      return { denied: true, code };
    } catch (err) {
      log.error?.({ runId, code, error: err.message }, 'batch engine: gate deny not applied (run moved on)');
      return { denied: true, code, unapplied: true };
    }
  }

  /**
   * Adapter failure policy (MD §12.3 honest failures):
   *   - retryable (ADAPTER_FAILED_RETRYABLE / transport-class) AND attempts
   *     remain → failed terminal for THIS attempt + identity RETRY_WAIT +
   *     requestRetry (fresh attempt, auto-dispatched via the batch-aware
   *     enqueue seam)
   *   - otherwise → failed terminal + identity FAILED_FINAL (manual retry)
   */
  async function handleAdapterFailure(run, err) {
    const retryable =
      (err instanceof AdapterError && err.retryable) ||
      (err instanceof AdapterError && [502, 503, 504].includes(err.status));
    const code = err instanceof AdapterError ? err.apiCode : 'ADAPTER_ERROR';
    const message = String(err?.message ?? 'adapter error').slice(0, 1_000);
    await taskSvc.finishRun(run.id, {
      status: 'failed',
      errorCode: code,
      errorMessage: message,
      attempt: run.attempt,
    });
    if (retryable && run.attempt < run.maxAttempts) {
      try {
        await batchSvc.transitionIdentity(run.identityId, 'RETRY_WAIT', {
          reason: `attempt ${run.attempt} failed (${code}) — auto-retry`,
          actor: 'engine',
          correlationId: run.batchId ?? null,
        });
      } catch (e) {
        if (e.apiCode === 'ILLEGAL_IDENTITY_TRANSITION') log.info?.({ runId: run.id, status: (await db.identity.findUnique({ where: { id: run.identityId } }))?.status }, 'identity retry sync divergence (already moved)');
        else throw e;
      }
      await taskSvc.requestRetry(run.id, { actorUserId: 'engine:auto-retry', note: code });
      log.warn?.({ runId: run.id, attempt: run.attempt, code }, 'batch engine: retryable adapter failure — auto-retry dispatched');
      return { outcome: 'auto-retry', code, attempt: run.attempt + 1 };
    }
    const after = await taskSvc.loadRun(run.id);
    await scheduler.syncIdentityAfterRunTerminal(after, { actor: 'engine' });
    return { outcome: 'failed-final', code, attempt: run.attempt };
  }

  /**
   * One batch-run job. Always returns an outcome descriptor (never throws
   * for a legitimate terminal); the DB is the source of truth.
   */
  async function handleBatchJob(job) {
    const { runId, attempt, timeoutMs } = job.data ?? {};
    if (!runId || !Number.isInteger(attempt)) {
      log.error?.({ job: job?.data }, 'batch engine: malformed job data (no runId/attempt) — failing loudly');
      throw new Error('batch engine: malformed job data');
    }
    let lease = null;

    try {
      // 0) stale guards -------------------------------------------------
      const run0 = await taskSvc.loadRun(runId, { mustExist: false });
      if (!run0) return { outcome: 'gone' };
      if (TASK_RUN_TERMINAL.includes(run0.status)) return { outcome: 'stale-terminal', status: run0.status };
      if (run0.attempt !== attempt) return { outcome: 'stale-attempt', dbAttempt: run0.attempt };

      // 1) batch gate ---------------------------------------------------
      const batch = run0.batchId ? await db.batch.findUnique({ where: { id: run0.batchId } }) : null;
      if (!batch) return { outcome: 'batch-gone' }; // scheduler reconciliation owns this divergence
      if (batch.status !== 'RUNNING') {
        const stopped = await stopQueuedRun(runId, `batch is ${batch.status} (not RUNNING)`);
        return { outcome: 'batch-not-running', batchStatus: batch.status, ...stopped };
      }

      // 2) identity guard -----------------------------------------------
      // RESERVED/RETRY_WAIT = normal dispatch; RUNNING = a duplicate delivery
      // racing the winner (or a divergence) — the claim CAS below decides it,
      // so we do NOT stop the run here (stopping on RUNNING would let a
      // duplicate kill the live run). Any other state = the identity moved on:
      // stop this run honestly.
      const identity = run0.identityId ? await db.identity.findUnique({ where: { id: run0.identityId } }) : null;
      if (!identity || !['RESERVED', 'RETRY_WAIT', 'RUNNING'].includes(identity.status)) {
        const stopped = await stopQueuedRun(runId, `identity status '${identity?.status ?? 'missing'}' (expected RESERVED/RETRY_WAIT/RUNNING)`);
        return { outcome: 'identity-not-ready', identityStatus: identity?.status ?? null, ...stopped };
      }
      if (identity.status === 'RUNNING') {
        log.info?.({ runId, attempt }, 'batch engine: identity already RUNNING — claim CAS decides (duplicate delivery or divergence)');
      }

      // 3) GLOBAL slot gate (MD §3.1 — the hard cap, before any claim) --
      const { cap: globalCap } = await scheduler.readGlobalMaxActive(db);
      const totalSlots = scheduler.effectiveSlotCap(batch, globalCap);
      const acq = await leaseSvc.acquireSlot({
        totalSlots,
        ownerRunId: runId,
        ownerLabel: `batch:${String(batch.id).slice(0, 8)}`,
        ttlMs: slotTtlMs,
      });
      if (!acq.acquired) {
        const defers = Number.isInteger(job.data.slotDefers) ? job.data.slotDefers : 0;
        if (defers + 1 > maxSlotDefers) {
          // Honest exhaustion: the slot pool is stuck (likely leaked leases —
          // reconciliation will surface them). Never spin forever, never fake.
          await taskSvc.finishRun(runId, {
            status: 'failed',
            errorCode: 'BLOCKED_RESOURCE',
            errorMessage: `no container slot after ${defers} defers (${defers * slotWaitMs}ms) — pool exhausted or leaked`,
            attempt,
          });
          await scheduler.syncIdentityAfterRunTerminal(await taskSvc.loadRun(runId), { actor: 'engine' });
          log.error?.({ runId, defers, totalSlots }, 'batch engine: slot pool exhausted after bounded defers');
          return { outcome: 'slot-exhausted', defers };
        }
        // The run stays QUEUED and holds NOTHING — the job is deferred.
        job.data.slotDefers = defers + 1;
        await job.moveToDelayed(slotWaitMs);
        return { outcome: 'slot-deferred', defer: defers + 1, waitMs: slotWaitMs };
      }
      lease = acq.lease;

      // 4) claim CAS (single winner of a duplicated delivery) -----------
      const claim = await claimRun(runId, attempt);
      if (claim !== 'won') {
        const live = await taskSvc.loadRun(runId, { mustExist: false });
        if (live?.status === 'cancel_requested') {
          await taskSvc.markCancelled(runId, { reason: 'cancel_before_start (claim race)' });
          await scheduler.syncIdentityAfterRunTerminal(await taskSvc.loadRun(runId), { actor: 'engine' });
          return { outcome: 'claim-lost-cancelled' };
        }
        return { outcome: 'claim-lost' };
      }

      // Honest event stream (MD §7): the claim winner records attempt_started
      // (claimRun's raw CAS records nothing on its own).
      await taskSvc.recordEvent(runId, TASK_EVENT.ATTEMPT_STARTED, {
        message: `batch attempt ${attempt} started`,
        payload: { attempt, batchId: batch.id },
      });

      // 5) identity → RUNNING (the run now genuinely owns the identity) --
      //    RETRY_WAIT is a parking state (reconciler / engine auto-retry):
      //    the matrix only allows RETRY_WAIT→RESERVED→RUNNING, so re-reserve
      //    first. (Claiming straight to RUNNING throws
      //    ILLEGAL_IDENTITY_TRANSITION, which the divergence catch below
      //    misreads as "already moved" and proceeds anyway — success sync
      //    then no-ops (it only fires from RUNNING) and the batch never
      //    completes. G8 live smoke, kill -9 scenario: retry succeeded but
      //    the identity sat in RETRY_WAIT forever.)
      let claimed = identity;
      if (claimed.status === 'RETRY_WAIT') {
        try {
          await batchSvc.transitionIdentity(claimed.id, 'RESERVED', {
            reason: `re-reserving for attempt ${attempt} (retry path)`,
            actor: 'engine',
            correlationId: batch.id,
          });
          claimed = { ...claimed, status: 'RESERVED' };
        } catch (e) {
          // Divergent (concurrent cancel / manual move) — the run must not
          // proceed on an identity that is not ours to reserve.
          await stopQueuedRun(runId, `identity re-reserve failed: ${e.message}`);
          return { outcome: 'identity-claim-failed' };
        }
      }
      if (claimed.status !== 'RUNNING') {
        try {
          await batchSvc.transitionIdentity(claimed.id, 'RUNNING', {
            reason: `run ${runId} attempt ${attempt} claimed`,
            actor: 'engine',
            correlationId: batch.id,
          });
        } catch (e) {
          if (e.apiCode === 'ILLEGAL_IDENTITY_TRANSITION') {
            log.info?.({ runId, identityStatus: identity.status }, 'identity claim divergence (already moved — proceeding, sync is best-effort)');
          } else {
            // Unclaimable state → stop honestly (the run must not run).
            await stopQueuedRun(runId, `identity transition failed: ${e.message}`);
            return { outcome: 'identity-claim-failed' };
          }
        }
      }

      // 6) network gate (B4 fail-closed, taskType 'batch') --------------
      const gate = await gateNetwork(runId, attempt, run0);
      if (gate.denied) {
        // The denial already failed the run inside gateNetwork; finish the
        // state sync (identity → FAILED_FINAL) so the batch converges.
        if (!gate.unapplied) {
          await scheduler.syncIdentityAfterRunTerminal(await taskSvc.loadRun(runId), { actor: 'engine' });
        }
        return { outcome: 'network-denied', code: gate.code, unapplied: gate.unapplied ?? false };
      }

      // 7) adapter execution with heartbeat / cancel / timeout ----------
      const runRow = await taskSvc.loadRun(runId);
      const deadlineMs = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : Number(runRow.inputJson?.timeoutMs ?? defaultTimeoutMs);
      const controller = new AbortController();
      let slotLost = false;
      const timers = [];

      timers.push(setInterval(() => {
        void (async () => {
          try {
            const r = await leaseSvc.renew({
              resourceType: SLOT_RESOURCE_TYPE,
              resourceKey: lease.resourceKey,
              ownerRunId: runId,
              ttlMs: slotTtlMs,
            });
            if (!r.renewed) {
              // Our lease is gone (expired + taken, or reconciler-released):
              // another owner may be on this slot — STOP, do not continue.
              if (!controller.signal.aborted) {
                slotLost = true;
                controller.abort('slot-lost');
              }
              return;
            }
            await db.taskRun.update({ where: { id: runId }, data: { heartbeatAt: now() } });
          } catch (err) {
            log.error?.({ runId, error: err.message }, 'batch engine: heartbeat/renew failed (will re-check next tick)');
          }
        })();
      }, heartbeatMs).unref?.());

      timers.push(setInterval(() => {
        void (async () => {
          try {
            const live = await taskSvc.loadRun(runId, { mustExist: false });
            if (live?.status === 'cancel_requested' && !controller.signal.aborted) {
              controller.abort('cancel-requested');
            }
          } catch { /* best-effort poll */ }
        })();
      }, cancelPollMs).unref?.());

      const timeoutHandle = setTimeout(() => {
        if (!controller.signal.aborted) controller.abort('timeout');
      }, (() => {
        // Deadline is relative to the run's own start, computed on the ENGINE
        // clock (now()) — the same clock that wrote startedAt at claim.
        // Never mix with Date.now(): test harnesses inject a fake clock and
        // mixing clocks corrupts the deadline (fired timeouts at ~100ms).
        const nowMs = now().getTime();
        const rowStartMs = runRow.startedAt ? new Date(runRow.startedAt).getTime() : nowMs;
        const remainingMs = Math.max(0, deadlineMs - Math.max(0, nowMs - rowStartMs));
        return Math.max(100, remainingMs);
      })());
      timeoutHandle.unref?.();
      timers.push(timeoutHandle);

      let outcome;
      let finishInfo = null;
      try {
        const result = await adapterRegistry.run(adapterNameOf(runRow), {
          runId,
          attempt,
          identityId: runRow.identityId,
          batchId: batch.id,
          signal: controller.signal,
          deadlineMs,
          log,
        });
        finishInfo = await taskSvc.finishRun(runId, {
          status: 'succeeded',
          resultText: result?.resultText ?? null,
          resultJson: result?.resultJson ?? null,
          attempt,
        });
        outcome = 'succeeded';
      } catch (err) {
        const reason = controller.signal.aborted ? (controller.signal.reason ?? 'aborted') : null;
        if (isAbortReason(reason, 'cancel-requested')) {
          await taskSvc.markCancelled(runId, { reason: 'cancelled_during_run', attempt });
          outcome = 'cancelled';
        } else if (isAbortReason(reason, 'timeout')) {
          await taskSvc.finishRun(runId, {
            status: 'timed_out',
            errorCode: 'RUN_TIMEOUT',
            errorMessage: `run exceeded ${deadlineMs}ms wall clock`,
            attempt,
          });
          outcome = 'timed_out';
        } else if (isAbortReason(reason, 'slot-lost')) {
          await taskSvc.finishRun(runId, {
            status: 'failed',
            errorCode: 'SLOT_LEASE_LOST',
            errorMessage: `container slot lease lost during run (renew: ${slotLost ? 'expired/taken' : 'gone'}) — aborted, no auto re-run (reconciliation owns it)`,
            attempt,
          });
          outcome = 'slot-lost';
        } else {
          const handled = await handleAdapterFailure(runRow, err);
          outcome = handled.outcome;
          if (handled.outcome === 'auto-retry') void finishInfo;
        }
      } finally {
        for (const t of timers) {
          clearTimeout(t);
          clearInterval(t);
        }
        if (lease) {
          try {
            await leaseSvc.release({ resourceType: SLOT_RESOURCE_TYPE, resourceKey: lease.resourceKey, ownerRunId: runId });
          } catch (err) {
            log.error?.({ runId, slot: lease.resourceKey, error: err.message }, 'batch engine: slot release failed (reconciliation will sweep)');
          }
        }
      }

      // 8) identity + membership sync (shared map; divergence is logged,
      //    never thrown) — for the engine-owned terminals.
      if (outcome !== 'auto-retry') {
        const after = await taskSvc.loadRun(runId, { mustExist: false });
        if (after && TASK_RUN_TERMINAL.includes(after.status)) {
          await scheduler.syncIdentityAfterRunTerminal(after, { actor: 'engine' });
        }
      }
      void finishInfo;
      return { outcome };
    } catch (err) {
      // A throw escaping handleBatchJob is a coding bug or a DB outage —
      // the worker's processor records it (ENGINE_CRASH); never mask it.
      log.error?.({ runId, attempt, error: err.message }, 'batch engine crashed outside its error handling');
      throw err;
    }
  }

  return { handleBatchJob };
}

/**
 * inputJson.adapter is the FULL API spec object { type, durationMs, outcome,
 * failures } on the live path (createAndDispatch stores configJson.adapter
 * verbatim) but a bare type string on the unit-test seam. The registry is
 * keyed by the type string — normalize once, at both consumer sites (run +
 * §6.2 inspect). Unknown shapes → null = ADAPTER_NOT_CONFIGURED (fail-closed).
 */
function adapterNameOf(run) {
  const a = run?.inputJson?.adapter;
  if (a == null || a === '') return null; // unconfigured → ADAPTER_NOT_CONFIGURED
  if (typeof a === 'string') return a; // unit-test seam / bare type
  // Non-empty but unrecognizable spec → an UNKNOWN adapter name (never null:
  // null means "nothing ran" (sideEffects=false), which would let the §6.2
  // reconciler auto re-run a run whose adapter we cannot identify. Fail closed.
  if (typeof a === 'object' && !Array.isArray(a) && typeof a.type === 'string') return a.type;
  return 'malformed-adapter-spec';
}

/**
 * Convenience: the inspect seam for the scheduler's lease reconciliation
 * (MD §6.2) — routes to the run's adapter.
 */
export function makeInspectEffects(adapterRegistry) {
  return async (run) => adapterRegistry.inspect(adapterNameOf(run));
}
