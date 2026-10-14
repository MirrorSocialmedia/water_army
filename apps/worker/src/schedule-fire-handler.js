/**
 * Schedule fire handler (P4) — processes `schedule-fire` jobs from the shared
 * `ai-tasks` queue. This is where the MD semantics become runs:
 *
 *   PG row re-read (source of truth) → guards → overlap policy → createRun
 *   (idempotency key = sched-<id>-<slotMs>) → advance next_run_at.
 *
 * Zero-duplicate guarantees (工單硬驗收):
 *   1. createRun's idempotency key is per (schedule, slot) — a redelivered
 *      fire of the same slot replays to the SAME run row (no second row, no
 *      second enqueue — the BullMQ job id `${runId}-1` is also stable).
 *   2. next_run_at is advanced AFTER the run is durably enqueued, so a crash
 *      in between simply re-fires the same slot → replay (not a new run).
 *   3. Stale-generation guards (schedHash mismatch / already-advanced slot)
 *      drop fires produced by an index entry the reconciler hasn't swept yet.
 *
 * Overlap policy (MD §1.4 — worker 側執行):
 *   skip_if_running (default) → the slot is recorded as a terminal `skipped`
 *   run (visible, with reason — MD §12.3) and the slot is consumed.
 *   queue → the run is created regardless; the worker concurrency cap
 *   serialises execution. (cancel-and-replace is explicitly out of MVP.)
 *
 * Once schedules self-disable after their single fire (MD acceptance #2).
 */
import {
  SCHEDULE_TYPE,
  SCHEDULE_SYNC_STATUS,
  OVERLAP_POLICY,
  SCHEDULE_ACTIVE_RUN_STATUSES,
  SCHED_STALE_SLOT_TOLERANCE_MS,
  schedulingHash,
  scheduleSlotKey,
  scheduleSkipKey,
  schedulerIdFor,
  nextCronRun,
  SERVICE_USER_ID,
} from '@water-army/shared';

/**
 * Caller identity for scheduler-created runs (no user involved).
 * requested_by is @db.Uuid → must use the fixed service UUID (P3),
 * never a bare string.
 */
const SYSTEM = Object.freeze({ id: SERVICE_USER_ID, username: 'scheduler' });

/**
 * @param {object} deps
 * @param {object} deps.db     Prisma client — schedule/taskDefinition/taskRun
 * @param {object} deps.taskSvc TaskRunService (worker instance: createRun +
 *   createSkippedRun; enqueue callback already wired to the producer queue)
 * @param {object} [deps.queue] BullMQ Queue — self-removal of stale schedulers
 * @param {object} [deps.log]
 */
export function createScheduleFireHandler({ db, taskSvc, queue, log = console } = {}) {
  /**
   * Consume the slot after the run is durably recorded/enqueued.
   * Non-once: next_run_at → the slot AFTER this one (computed from the slot,
   * NOT from now — deterministic across crashes/delays).
   * Once: the schedule has served its only slot → self-disable + clear.
   */
  async function consumeSlot(row, slotMs) {
    if (row.scheduleType === SCHEDULE_TYPE.ONCE) {
      await db.schedule.update({
        where: { id: row.id },
        data: {
          isEnabled: false,
          nextRunAt: null,
          lastRunAt: new Date(slotMs),
          lastStatus: 'queued',
          syncStatus: SCHEDULE_SYNC_STATUS.SYNCED, // index is now (correctly) empty
        },
      });
      return;
    }
    const nextMs =
      row.scheduleType === SCHEDULE_TYPE.INTERVAL
        ? slotMs + row.intervalMs
        : nextCronRun(row.cronExpression, row.timezone, new Date(slotMs)).getTime();
    await db.schedule.update({
      where: { id: row.id },
      data: {
        nextRunAt: new Date(nextMs),
        lastRunAt: new Date(slotMs),
        lastStatus: 'queued',
      },
    });
  }

  /**
   * @param {object} job BullMQ Job — data {scheduleId, schedHash, scheduledAt?}.
   *   Slot (ms) resolution order:
   *     1. data.scheduledAt — delayed once-jobs carry it explicitly;
   *     2. job.id — BullMQ 6 Job Scheduler fires carry the slot in the job id
   *        (`repeat:<schedulerId>:<nextMillis>`; confirmed against the
   *        installed bullmq source, job-scheduler.js getSchedulerNextJobId);
   *     3. opts.prevMillis — kept for forward compatibility;
   *     4. wall clock (logged) — last resort for malformed jobs.
   */
  async function handleFireJob(job) {
    const data = job?.data ?? {};
    const scheduleId = data.scheduleId;
    if (!scheduleId) {
      log.error?.({ jobId: job?.id }, 'fire job without scheduleId — dropping');
      return { outcome: 'invalid' };
    }

    // The scheduled slot (ms) — see resolution order in the doc above.
    let slotMs = data.scheduledAt ? new Date(data.scheduledAt).getTime() : null;
    if (slotMs == null) {
      const m = /^repeat:[^:]+:(\d+)$/.exec(String(job?.id ?? ''));
      if (m) slotMs = Number(m[1]);
    }
    if (slotMs == null && Number.isFinite(job?.opts?.prevMillis)) slotMs = job.opts.prevMillis;
    if (slotMs == null) {
      slotMs = Date.now();
      log.warn?.({ scheduleId, jobId: job?.id }, 'fire job carried no slot — falling back to wall clock');
    }

    // ------------------------------------------------ PG row (source of truth)
    const row = await db.schedule.findUnique({ where: { id: scheduleId } });
    if (!row) {
      // Deleted after the job was queued (or orphan the reconciler will sweep).
      log.warn?.({ scheduleId, slotMs }, 'fire for a deleted schedule — dropping');
      return { outcome: 'skipped-gone' };
    }
    if (!row.isEnabled) {
      // Paused/deleted-then-rescued edge; the index entry is stale (swept by
      // the reconciler). Safe direction: nothing fires for a disabled row.
      log.warn?.({ scheduleId, slotMs }, 'fire for a disabled schedule — dropping (reconciler will sweep the index)');
      return { outcome: 'skipped-disabled' };
    }

    // ------------------------------------------- guard 1: stale generation
    // The job carries the parameter hash from when the index entry was
    // written. If the schedule changed since (PATCH cron/interval/tz/overlap)
    // and the re-upsert failed (sync_error window), this fire has the WRONG
    // cadence → drop it, and remove the stale index entry on the spot so the
    // next reconcile doesn't re-heal a row that's actually consistent.
    const wantHash = schedulingHash(row);
    if (data.schedHash && data.schedHash !== wantHash) {
      log.warn?.({ scheduleId, slotMs }, 'fire from a stale scheduler generation — dropping + self-removing index entry');
      if (queue && row.scheduleType !== SCHEDULE_TYPE.ONCE) {
        try {
          await queue.removeJobScheduler(schedulerIdFor(row.id));
        } catch { /* reconciler sweep is the backstop */ }
      }
      return { outcome: 'skipped-stale' };
    }

    // ------------------------------------------- guard 2: consumed slot
    // A fire whose slot is already in the past relative to next_run_at is a
    // redelivery of a slot that was advanced (crash between enqueue and the
    // next_run_at write would replay via the idempotency key instead — this
    // catches the other direction: the slot moved on without us).
    const nextMs = row.nextRunAt ? new Date(row.nextRunAt).getTime() : null;
    if (nextMs != null && slotMs < nextMs - SCHED_STALE_SLOT_TOLERANCE_MS) {
      log.warn?.({ scheduleId, slotMs, nextRunAt: row.nextRunAt }, 'fire slot already consumed by a newer next_run_at — dropping');
      return { outcome: 'skipped-stale-slot' };
    }

    // ------------------------------------------- idempotency (PG 為準, 零重複)
    // At-least-once redelivery of the SAME slot (crash between createRun and
    // the next_run_at advance, or a BullMQ redelivery). An existing run with
    // this slot's key → replay: no second run, no second enqueue. This MUST
    // precede the overlap check — the slot's own (still queued) run is not
    // an "overlap" of another slot.
    const slotKey = scheduleSlotKey(row.id, slotMs);
    const existingRun = await db.taskRun.findFirst({ where: { idempotencyKey: slotKey } });
    if (existingRun) {
      log.info?.({ scheduleId, slotMs, runId: existingRun.id }, 'fire redelivered for an already-consumed slot — replaying (no second run)');
      return { outcome: 'replayed', runId: existingRun.id };
    }

    // ------------------------------------------------ overlap policy (worker)
    const activeRun = await db.taskRun.findFirst({
      where: { scheduleId: row.id, status: { in: SCHEDULE_ACTIVE_RUN_STATUSES } },
    });
    if (activeRun && row.overlapPolicy === OVERLAP_POLICY.SKIP_IF_RUNNING) {
      const { run: skipRun } = await taskSvc.createSkippedRun(
        {
          scheduleId: row.id,
          taskDefinitionId: row.taskDefinitionId,
          idempotencyKey: scheduleSkipKey(row.id, slotMs),
          reason: `overlap_policy=skip_if_running: run ${activeRun.id} is ${activeRun.status}`,
          activeRunId: activeRun.id,
          scheduledSlotAt: new Date(slotMs).toISOString(),
          prompt: '[slot skipped — a run of this schedule is still active]',
          title: `[schedule ${row.name}] slot skipped`,
        },
        SYSTEM,
      );
      await consumeSlot(row, slotMs); // the slot is consumed either way
      log.info?.({ scheduleId, slotMs, activeRunId: activeRun.id, skipRunId: skipRun.id }, 'schedule slot skipped (skip_if_running)');
      return { outcome: 'skipped-overlap', runId: skipRun.id };
    }

    // ------------------------------------------------ resolve the task
    const def = await db.taskDefinition.findUnique({
      where: { id: row.taskDefinitionId },
      include: { providerConfig: true },
    });
    if (!def) {
      log.error?.({ scheduleId, taskDefinitionId: row.taskDefinitionId }, 'fire aborted: task definition missing');
      return { outcome: 'aborted-definition' };
    }
    if (!def.providerConfig || !def.providerConfig.isEnabled) {
      // Config error, not a transport error: enqueuing would just fail later.
      // No run row is created (the schedule stays enabled — the operator
      // re-enables the provider, the next slot fires normally).
      log.error?.({ scheduleId, provider: def.providerConfig?.name ?? 'missing' }, 'fire aborted: provider disabled/missing — no run created (operator must fix)');
      return { outcome: 'aborted-provider' };
    }

    // ------------------------------------------------ create the run (idempotent)
    const { run, replay } = await taskSvc.createRun(
      {
        prompt: def.promptTemplate,
        provider: def.providerConfig.name,
        mode: def.mode,
        timeoutMs: def.timeoutMs,
        maxAttempts: def.maxAttempts,
        title: `[schedule ${row.name}] ${row.scheduleType} slot ${new Date(slotMs).toISOString()}`,
        idempotencyKey: scheduleSlotKey(row.id, slotMs),
        scheduleId: row.id,
        taskDefinitionId: def.id,
        scheduledSlotAt: new Date(slotMs).toISOString(),
      },
      SYSTEM,
    );

    // ------------------------------------------------ consume the slot (AFTER)
    await consumeSlot(row, slotMs);
    log.info?.(
      { scheduleId, runId: run.id, replay, slotMs, overlapPolicy: activeRun ? row.overlapPolicy : null },
      replay ? 'schedule slot replayed (idempotent — same run)' : 'schedule slot fired',
    );
    return { outcome: replay ? 'replayed' : 'fired', runId: run.id };
  }

  return { handleFireJob };
}
