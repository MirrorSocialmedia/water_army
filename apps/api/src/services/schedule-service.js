/**
 * ScheduleService — the single owner of schedule lifecycle (P4, 施工 MD §12.1/§6.6).
 *
 * Consistency model (PG 先、BullMQ 後):
 *   1. Every mutation validates, then writes PostgreSQL FIRST.
 *   2. The BullMQ Job Scheduler (execution index) is synced second via the
 *      locked BullMQ 6 Job Scheduler API (upsertJobScheduler /
 *      removeJobScheduler — legacy repeatable APIs are forbidden).
 *   3. A BullMQ-side failure NEVER undoes the DB row: the row is marked
 *      `sync_status=sync_error` and stays authoritative. The UI offers a
 *      retry (POST /api/schedules/:id/sync) and the worker's background
 *      reconciler heals drift independently (MD §12.1: 可重試 reconciliation).
 *
 * The queue is injected (BullMQ Queue or fake) so unit tests run hermetically;
 * production wiring passes the real queue built on buildRedisConnection().
 */
import { randomUUID } from 'node:crypto';
import {
  SCHEDULE_TYPE,
  SCHEDULE_SYNC_STATUS,
  OVERLAP_POLICY,
  SCHEDULE_FIRE_JOB_NAME,
  SCHEDULE_FIRE_JOB_TIMEOUT_MS,
  SCHEDULE_FIRE_REMOVE_ON_COMPLETE,
  SCHEDULE_FIRE_REMOVE_ON_FAIL,
  schedulerIdFor,
  onceFireJobId,
  fireJobData,
  runNowKey,
  validateCronExpression,
  isIanaTimezone,
  nextCronRun,
  describeCron,
  describeInterval,
} from '@water-army/shared';

export class ScheduleError extends Error {
  /** @param {string} code stable API code @param {string} message @param {number} [status] */
  constructor(code, message, { status = 400 } = {}) {
    super(message);
    this.name = 'ScheduleError';
    this.apiCode = code;
    this.statusCode = status;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {object} deps
 * @param {object} deps.db  Prisma client (or fake) — schedule/taskDefinition/providerConfig/taskRun
 * @param {object} deps.queue BullMQ Queue (or fake) — upsertJobScheduler/removeJobScheduler/add/getJob
 * @param {object} [deps.config] { defaultTimezone, scheduleMinIntervalMs, scheduleMaxIntervalMs }
 * @param {object} [deps.log]
 * @param {object} [deps.taskSvc] TaskRunService (run-now path)
 */
export function createScheduleService({ db, queue, config = {}, log = console, taskSvc }) {
  const defaultTimezone = config.defaultTimezone ?? 'Asia/Taipei';
  const minIntervalMs = config.scheduleMinIntervalMs ?? 10_000;
  const maxIntervalMs = config.scheduleMaxIntervalMs ?? 7 * 24 * 3_600_000; // 7d — fits Int column

  // ------------------------------------------------------------------ helpers
  function notFound(message) {
    return new ScheduleError('SCHEDULE_NOT_FOUND', message, { status: 404 });
  }

  function validationError(message) {
    return new ScheduleError('VALIDATION_ERROR', message, { status: 400 });
  }

  /**
   * Validate the scheduling definition part of a create/patch.
   * @returns {{errors: string[], def: object}}
   */
  function validateDefinition({ scheduleType, cronExpression, intervalMs, timezone, runAt }, { requireRunAtFuture = true } = {}) {
    const errors = [];
    const def = { scheduleType, timezone: timezone ?? defaultTimezone };

    if (!isIanaTimezone(def.timezone)) {
      errors.push(`timezone '${String(timezone ?? '')}' is not a valid IANA timezone (e.g. Asia/Taipei)`);
    }

    if (scheduleType === SCHEDULE_TYPE.CRON) {
      const cron = validateCronExpression(cronExpression);
      if (!cron.ok) errors.push(cron.error);
      def.cronExpression = cron.ok ? cronExpression.trim() : null;
      def.intervalMs = null;
    } else if (scheduleType === SCHEDULE_TYPE.INTERVAL) {
      def.cronExpression = null;
      if (!Number.isInteger(intervalMs) || intervalMs < minIntervalMs) {
        errors.push(`intervalMs must be an integer >= ${minIntervalMs} (minimum run frequency, MD §12.2)`);
      } else if (intervalMs > maxIntervalMs) {
        errors.push(`intervalMs must be <= ${maxIntervalMs} (7 days)`);
      } else {
        def.intervalMs = intervalMs;
      }
    } else if (scheduleType === SCHEDULE_TYPE.ONCE) {
      def.cronExpression = null;
      def.intervalMs = null;
      if (runAt === undefined || runAt === null) {
        errors.push('runAt (ISO datetime) is required for a once schedule');
      } else {
        const d = new Date(runAt);
        if (Number.isNaN(d.getTime())) {
          errors.push(`runAt '${String(runAt)}' is not a valid ISO datetime`);
        } else {
          def.runAt = d;
          if (requireRunAtFuture && d.getTime() <= Date.now()) {
            errors.push('runAt must be in the future');
          }
        }
      }
    } else {
      errors.push(`scheduleType must be one of: ${Object.values(SCHEDULE_TYPE).join(', ')}`);
    }
    return { errors, def };
  }

  /**
   * Next run after `after` in the schedule's OWN timezone (MD §1.4).
   * cron → cron-parser (same lib BullMQ fires with); interval → after+ms;
   * once → the stored runAt itself.
   */
  function computeNextRun(def, after = new Date()) {
    if (def.scheduleType === SCHEDULE_TYPE.ONCE) return def.runAt ?? null;
    if (def.scheduleType === SCHEDULE_TYPE.INTERVAL) {
      return new Date(after.getTime() + def.intervalMs);
    }
    return nextCronRun(def.cronExpression, def.timezone, after);
  }

  /** repeatOpts for BullMQ (cron → {pattern, tz}; interval → {every}). */
  function repeatOptsFor(row) {
    if (row.scheduleType === SCHEDULE_TYPE.CRON) {
      return { pattern: row.cronExpression, tz: row.timezone };
    }
    return { every: row.intervalMs };
  }

  const fireJobTemplate = (row) => ({
    name: SCHEDULE_FIRE_JOB_NAME,
    data: fireJobData(row),
    opts: {
      attempts: 1,
      timeout: SCHEDULE_FIRE_JOB_TIMEOUT_MS,
      removeOnComplete: SCHEDULE_FIRE_REMOVE_ON_COMPLETE,
      removeOnFail: SCHEDULE_FIRE_REMOVE_ON_FAIL,
    },
  });

  /**
   * Write the schedule's execution index into BullMQ (idempotent upserts).
   * cron/interval → upsertJobScheduler(sched-<id>, ...);
   * once → delayed job with deterministic jobId (re-add = same job, no dupes).
   */
  async function syncToQueue(row) {
    if (row.scheduleType === SCHEDULE_TYPE.ONCE) {
      const slotMs = new Date(row.nextRunAt).getTime();
      const delay = Math.max(0, slotMs - Date.now());
      await queue.add(
        SCHEDULE_FIRE_JOB_NAME,
        { ...fireJobData(row), scheduledAt: new Date(slotMs).toISOString(), once: true },
        {
          jobId: onceFireJobId(row.id, slotMs),
          delay,
          attempts: 1,
          timeout: SCHEDULE_FIRE_JOB_TIMEOUT_MS,
          removeOnComplete: SCHEDULE_FIRE_REMOVE_ON_COMPLETE,
          removeOnFail: SCHEDULE_FIRE_REMOVE_ON_FAIL,
        },
      );
      return;
    }
    await queue.upsertJobScheduler(schedulerIdFor(row.id), repeatOptsFor(row), fireJobTemplate(row));
  }

  /**
   * Remove this schedule's execution index from BullMQ. THROWS on failure —
   * callers decide the semantics:
   *   applySync → catch + sync_status=sync_error (honest, retryable)
   *   remove()  → catch + proceed (orphan sweep in the worker reconciler is
   *               the backstop; a deleted schedule's fire job never fires a
   *               run because the fire handler re-reads the DB row).
   */
  async function removeFromQueue(row) {
    if (row.scheduleType === SCHEDULE_TYPE.ONCE) {
      if (row.nextRunAt) {
        const job = await queue.getJob(onceFireJobId(row.id, new Date(row.nextRunAt).getTime()));
        if (job) await job.remove();
      }
      return true;
    }
    return queue.removeJobScheduler(schedulerIdFor(row.id));
  }

  /** Mark sync state (only on change — no write churn). */
  async function setSyncStatus(row, status) {
    if (row.syncStatus === status) return row;
    return db.schedule.update({ where: { id: row.id }, data: { syncStatus: status } });
  }

  /**
   * The consistency step after any DB mutation:
   *  enabled  → ensure the scheduler exists (upsert / re-add delayed job)
   *  disabled → ensure NO scheduler exists (remove orphaned index)
   * Result: sync_status = synced | sync_error (DB row is never rolled back).
   */
  async function applySync(row, { syncReason = 'update' } = {}) {
    const target = row.isEnabled ? SCHEDULE_SYNC_STATUS.SYNCED : SCHEDULE_SYNC_STATUS.SYNCED;
    try {
      if (row.isEnabled) await syncToQueue(row);
      else await removeFromQueue(row);
      return setSyncStatus({ ...row }, target);
    } catch (err) {
      // PG-first invariant: the DB row stands; BullMQ is out of step.
      log.error?.({ scheduleId: row.id, reason: syncReason, error: err.message }, 'schedule: BullMQ sync failed — marked sync_error (retry via /sync or reconciler)');
      return setSyncStatus({ ...row }, SCHEDULE_SYNC_STATUS.SYNC_ERROR);
    }
  }

  // ------------------------------------------------------------------ public
  async function definitionSummary(id) {
    const def = await db.taskDefinition.findUnique({ where: { id } });
    if (!def) return null;
    const provider = await db.providerConfig.findUnique({ where: { id: def.providerConfigId } });
    return {
      id: def.id,
      title: def.title,
      mode: def.mode,
      provider: provider?.name ?? null,
      providerEnabled: provider?.isEnabled ?? false,
      timeoutMs: def.timeoutMs,
      maxAttempts: def.maxAttempts,
      promptTemplate: def.promptTemplate,
    };
  }

  function nextRunDescription(row) {
    if (row.scheduleType === SCHEDULE_TYPE.ONCE) {
      return row.nextRunAt ? `once at ${new Date(row.nextRunAt).toISOString()}` : null;
    }
    if (row.scheduleType === SCHEDULE_TYPE.INTERVAL) {
      return describeInterval(row.intervalMs);
    }
    const d = describeCron(row.cronExpression);
    return `${d ?? row.cronExpression} (${row.timezone})`;
  }

  function publicSchedule(row, def = null, lastRun = null) {
    const delayMs =
      lastRun && typeof lastRun.inputJson?.scheduledSlotAt === 'string'
        ? Math.max(0, new Date(lastRun.createdAt).getTime() - new Date(lastRun.inputJson.scheduledSlotAt).getTime())
        : null;
    return {
      id: row.id,
      name: row.name,
      scheduleType: row.scheduleType,
      cronExpression: row.cronExpression ?? null,
      intervalMs: row.intervalMs ?? null,
      timezone: row.timezone,
      overlapPolicy: row.overlapPolicy,
      taskDefinitionId: row.taskDefinitionId,
      taskDefinition: def
        ? {
            id: def.id,
            title: def.title,
            mode: def.mode,
            provider: def.provider,
            providerEnabled: def.providerEnabled,
            timeoutMs: def.timeoutMs,
            maxAttempts: def.maxAttempts,
          }
        : null,
      isEnabled: row.isEnabled,
      nextRunAt: row.nextRunAt ?? null,
      lastRunAt: row.lastRunAt ?? null,
      lastStatus: row.lastStatus ?? null,
      syncStatus: row.syncStatus,
      bullmqSchedulerId: row.bullmqSchedulerId ?? null,
      createdAt: row.createdAt ?? null,
      updatedAt: row.updatedAt ?? null,
      nextRunDescription: row.isEnabled ? nextRunDescription(row) : null,
      lastRun: lastRun
        ? {
            id: lastRun.id,
            status: lastRun.status,
            createdAt: lastRun.createdAt ?? null,
            durationMs: lastRun.durationMs ?? null,
            // MD §1.4 盡力非硬性: actual-vs-scheduled delay, visible in the UI.
            delayMs,
          }
        : null,
    };
  }

  /** Latest run per schedule (one batched query for the list view). */
  async function lastRunsFor(scheduleIds) {
    if (!scheduleIds.length) return new Map();
    const rows = await db.taskRun.findMany({
      where: { scheduleId: { in: scheduleIds } },
      orderBy: { createdAt: 'asc' },
    });
    const map = new Map();
    for (const r of rows) map.set(r.scheduleId, r); // asc order → last write wins
    return map;
  }

  // ------------------------------------------------------------------ routes
  async function list({ page = 1, pageSize = 20, enabled = null } = {}) {
    const where = {};
    if (enabled === true || enabled === false) where.isEnabled = enabled;
    const [rows, total] = await Promise.all([
      db.schedule.findMany({ where, orderBy: { createdAt: 'asc' } }),
      db.schedule.count({ where }),
    ]);
    const defs = new Map();
    const need = rows.filter((r) => !defs.has(r.taskDefinitionId)).map((r) => r.taskDefinitionId);
    for (const d of await Promise.all(need.map((id) => definitionSummary(id)))) {
      if (d) defs.set(d.id, d);
    }
    const lastRuns = await lastRunsFor(rows.map((r) => r.id));
    const paged = rows.slice((page - 1) * pageSize, page * pageSize);
    return {
      items: paged.map((r) => publicSchedule(r, defs.get(r.taskDefinitionId) ?? null, lastRuns.get(r.id) ?? null)),
      page,
      pageSize,
      total,
    };
  }

  async function get(id) {
    const row = await db.schedule.findUnique({ where: { id } });
    if (!row) throw notFound(`schedule ${id} not found`);
    const [def, lastRun] = await Promise.all([
      definitionSummary(row.taskDefinitionId),
      db.taskRun.findMany({ where: { scheduleId: row.id }, orderBy: { createdAt: 'asc' } }),
    ]);
    return publicSchedule(row, def, lastRun.length ? lastRun[lastRun.length - 1] : null);
  }

  /** MD §12.2: 預覽由後端解析（前端唔好自己猜）— no DB write. */
  async function preview(body) {
    const { errors, def } = validateDefinition(
      {
        scheduleType: body.scheduleType,
        cronExpression: body.cronExpression,
        intervalMs: body.intervalMs,
        timezone: body.timezone,
        runAt: body.runAt,
      },
      { requireRunAtFuture: false }, // preview may show a past slot's semantics
    );
    if (errors.length) throw validationError(errors.join('; '));
    const nextRunAt = computeNextRun(def);
    return {
      nextRunAt: nextRunAt ? new Date(nextRunAt).toISOString() : null,
      description: (() => {
        const fake = { ...def, nextRunAt };
        return nextRunDescription(fake);
      })(),
    };
  }

  async function create(input, user) {
    const errors = [];
    if (typeof input?.name !== 'string' || input.name.trim().length < 1 || input.name.trim().length > 100) {
      errors.push('name is required (1..100 chars)');
    }
    if (!UUID_RE.test(input?.taskDefinitionId ?? '')) {
      errors.push('taskDefinitionId is required (uuid)');
    }
    if (errors.length) throw validationError(errors.join('; '));

    const defRow = await db.taskDefinition.findUnique({ where: { id: input.taskDefinitionId } });
    if (!defRow) throw validationError(`task definition ${input.taskDefinitionId} not found`);

    const { errors: defErrors, def } = validateDefinition(input);
    if (defErrors.length) throw validationError(defErrors.join('; '));

    const overlapPolicy = input.overlapPolicy ?? OVERLAP_POLICY.SKIP_IF_RUNNING;
    if (!Object.values(OVERLAP_POLICY).includes(overlapPolicy)) {
      throw validationError(`overlapPolicy must be 'skip_if_running' or 'queue'`);
    }

    const id = randomUUID();
    const row0 = {
      id,
      name: input.name.trim(),
      taskDefinitionId: defRow.id,
      scheduleType: def.scheduleType,
      cronExpression: def.cronExpression ?? null,
      intervalMs: def.intervalMs ?? null,
      timezone: def.timezone,
      overlapPolicy,
      isEnabled: input.isEnabled ?? true,
      nextRunAt: def.scheduleType === SCHEDULE_TYPE.ONCE ? def.runAt : computeNextRun(def),
      lastRunAt: null,
      lastStatus: null,
      bullmqSchedulerId: schedulerIdFor(id),
      syncStatus: SCHEDULE_SYNC_STATUS.PENDING,
    };

    let row;
    try {
      row = await db.schedule.create({ data: row0 });
    } catch (err) {
      if (String(err?.code ?? '').includes('P2002')) {
        throw new ScheduleError('SCHEDULE_NAME_TAKEN', `schedule name '${row0.name}' already exists`, { status: 409 });
      }
      throw err;
    }

    // PG 先（done）→ BullMQ 後. Failure = sync_error, row stays.
    const synced = await applySync(row, { syncReason: 'create' });
    return { schedule: publicSchedule({ ...synced, nextRunAt: synced.nextRunAt ?? row0.nextRunAt }), def: defRow, created: true };
  }

  /**
   * PATCH: name / taskDefinitionId / scheduleType / cron / interval /
   * timezone / overlapPolicy / runAt(once). Scheduling-affecting changes
   * recompute next_run_at + re-upsert the scheduler (override in place —
   * same bullmq_scheduler_id, 零重複).
   */
  async function update(id, patch, user) {
    const row = await db.schedule.findUnique({ where: { id } });
    if (!row) throw notFound(`schedule ${id} not found`);

    const changes = [];
    const data = {};
    if (patch.name !== undefined) {
      if (typeof patch.name !== 'string' || patch.name.trim().length < 1 || patch.name.trim().length > 100) {
        throw validationError('name must be 1..100 chars');
      }
      data.name = patch.name.trim();
      changes.push('name');
    }
    if (patch.taskDefinitionId !== undefined) {
      if (!UUID_RE.test(patch.taskDefinitionId)) throw validationError('taskDefinitionId must be a uuid');
      const defRow = await db.taskDefinition.findUnique({ where: { id: patch.taskDefinitionId } });
      if (!defRow) throw validationError(`task definition ${patch.taskDefinitionId} not found`);
      data.taskDefinitionId = defRow.id;
      changes.push('taskDefinitionId');
    }
    if (patch.overlapPolicy !== undefined) {
      if (!Object.values(OVERLAP_POLICY).includes(patch.overlapPolicy)) {
        throw validationError(`overlapPolicy must be 'skip_if_running' or 'queue'`);
      }
      data.overlapPolicy = patch.overlapPolicy;
      changes.push('overlapPolicy');
    }
    if (!changes.length && patch.scheduleType === undefined && patch.cronExpression === undefined &&
        patch.intervalMs === undefined && patch.timezone === undefined && patch.runAt === undefined) {
      throw validationError('no updatable fields provided');
    }

    // Rebuild the definition with the patched fields, then validate holistically.
    const next = validateDefinition({
      scheduleType: patch.scheduleType ?? row.scheduleType,
      cronExpression: patch.cronExpression !== undefined ? patch.cronExpression : row.cronExpression,
      intervalMs: patch.intervalMs !== undefined ? patch.intervalMs : row.intervalMs,
      timezone: patch.timezone !== undefined ? patch.timezone : row.timezone,
      runAt: patch.runAt !== undefined ? patch.runAt : row.nextRunAt,
    });
    if (next.errors.length) throw validationError(next.errors.join('; '));

    const def = next.def;
    const schedulingChanged =
      def.scheduleType !== row.scheduleType ||
      def.cronExpression !== (row.cronExpression ?? null) ||
      def.intervalMs !== (row.intervalMs ?? null) ||
      def.timezone !== row.timezone ||
      (def.scheduleType === SCHEDULE_TYPE.ONCE && def.runAt && new Date(def.runAt).getTime() !== new Date(row.nextRunAt ?? 0).getTime());

    data.scheduleType = def.scheduleType;
    data.cronExpression = def.cronExpression ?? null;
    data.intervalMs = def.intervalMs ?? null;
    data.timezone = def.timezone;
    if (schedulingChanged) {
      data.nextRunAt = def.scheduleType === SCHEDULE_TYPE.ONCE ? def.runAt : computeNextRun(def);
      changes.push('scheduling(next_run_at recomputed)');
    }

    let updated;
    try {
      updated = await db.schedule.update({ where: { id }, data });
    } catch (err) {
      if (String(err?.code ?? '').includes('P2002')) {
        throw new ScheduleError('SCHEDULE_NAME_TAKEN', `schedule name '${data.name}' already exists`, { status: 409 });
      }
      throw err;
    }

    // For once schedules a changed slot means the OLD delayed job (old jobId)
    // must go before the new one is added — otherwise the old slot still fires.
    // Best-effort here: if this fails, the orphaned job is inert (the fire
    // handler verifies the job's scheduledAt against the DB's next_run_at)
    // and the reconciler's orphan sweep removes it.
    if (updated.scheduleType === SCHEDULE_TYPE.ONCE && schedulingChanged && row.nextRunAt) {
      try {
        await removeFromQueue({ ...row }); // uses the OLD nextRunAt slot
      } catch (err) {
        log.warn?.({ scheduleId: id, error: err.message }, 'schedule: stale once-slot job removal failed (fire handler slot check + reconciler sweep are the backstops)');
      }
    }
    const synced = await applySync(updated, { syncReason: 'update' });
    return { schedule: publicSchedule(synced), changes };
  }

  async function pause(id, user) {
    const row = await db.schedule.findUnique({ where: { id } });
    if (!row) throw notFound(`schedule ${id} not found`);
    if (!row.isEnabled) {
      // Idempotent: already paused — but still heal a stale sync_error.
      const healed = row.syncStatus === SCHEDULE_SYNC_STATUS.SYNC_ERROR ? await applySync(row, { syncReason: 'pause' }) : row;
      return { schedule: publicSchedule(healed), changed: false };
    }
    const updated = await db.schedule.update({ where: { id }, data: { isEnabled: false } });
    const synced = await applySync(updated, { syncReason: 'pause' });
    return { schedule: publicSchedule(synced), changed: true };
  }

  async function resume(id, user) {
    const row = await db.schedule.findUnique({ where: { id } });
    if (!row) throw notFound(`schedule ${id} not found`);
    if (row.isEnabled) {
      const healed = row.syncStatus === SCHEDULE_SYNC_STATUS.SYNC_ERROR ? await applySync(row, { syncReason: 'resume' }) : row;
      return { schedule: publicSchedule(healed), changed: false };
    }
    // Resuming a stale cron/interval: recompute so the next slot is honest
    // (a cron resuming days late must not fire a burst of missed ticks —
    // BullMQ's override clamps to now anyway; the DB row should say the same).
    const data = { isEnabled: true };
    const now = new Date();
    if (row.scheduleType !== SCHEDULE_TYPE.ONCE && row.nextRunAt && new Date(row.nextRunAt) < now) {
      data.nextRunAt =
        row.scheduleType === SCHEDULE_TYPE.INTERVAL
          ? new Date(now.getTime() + row.intervalMs)
          : nextCronRun(row.cronExpression, row.timezone, now);
    }
    const updated = await db.schedule.update({ where: { id }, data });
    const synced = await applySync(updated, { syncReason: 'resume' });
    return { schedule: publicSchedule(synced), changed: true };
  }

  /**
   * Manual fire (MD §1.4 手動立即執行一次). Explicit operator action:
   * bypasses the scheduler AND the overlap policy (an operator who runs it
   * now means it now — a suppressed manual fire would be confusing). Works
   * on paused schedules too. Idempotent via Idempotency-Key (client uuid) or
   * a server-generated `runnow-<uuid>` — a different namespace from the
   * automatic `sched-<id>-<slot>` keys, so manual never collides with auto.
   */
  async function runNow(id, user, { idempotencyKey = null } = {}) {
    const row = await db.schedule.findUnique({ where: { id } });
    if (!row) throw notFound(`schedule ${id} not found`);
    if (!taskSvc) throw new ScheduleError('SCHEDULE_ENGINE_MISSING', 'run-now requires the task engine (worker taskSvc not wired)', { status: 500 });

    const def = await db.taskDefinition.findUnique({ where: { id: row.taskDefinitionId }, include: { providerConfig: true } });
    if (!def) throw new ScheduleError('DEFINITION_NOT_FOUND', `task definition ${row.taskDefinitionId} not found`, { status: 409 });
    if (!def.providerConfig || !def.providerConfig.isEnabled) {
      throw new ScheduleError('PROVIDER_NOT_CONFIGURED', `schedule's provider '${def.providerConfig?.name ?? '?'}' is missing or disabled`, { status: 409 });
    }

    const key =
      idempotencyKey && /^[A-Za-z0-9_-]{8,64}$/.test(idempotencyKey) ? idempotencyKey : runNowKey();

    const { run, replay } = await taskSvc.createRun(
      {
        prompt: def.promptTemplate,
        provider: def.providerConfig.name,
        mode: def.mode,
        timeoutMs: def.timeoutMs,
        maxAttempts: def.maxAttempts,
        title: `[schedule ${row.name}] manual run`,
        idempotencyKey: key,
        scheduleId: row.id,
        taskDefinitionId: def.id,
        scheduledSlotAt: new Date().toISOString(),
      },
      user,
    );

    const updated = await db.schedule.update({
      where: { id },
      data: { lastRunAt: new Date(), lastStatus: run.status },
    });
    return { run, replay, schedule: publicSchedule(updated) };
  }

  async function remove(id, user) {
    const row = await db.schedule.findUnique({ where: { id } });
    if (!row) throw notFound(`schedule ${id} not found`);
    // Remove the execution index first (best-effort — an orphaned index can
    // never fire a run: the fire handler re-reads the DB row, which is about
    // to be gone; the worker reconciler's orphan sweep is the backstop),
    // then delete the row. task_runs.schedule_id has no FK (schema) —
    // historical runs keep their lineage value.
    let schedulerRemoved = true;
    try {
      await removeFromQueue(row);
    } catch (err) {
      schedulerRemoved = false;
      log.warn?.({ scheduleId: id, error: err.message }, 'schedule: BullMQ remove failed before delete (reconciler will clean the orphan)');
    }
    await db.schedule.delete({ where: { id } });
    return { deleted: true, schedulerRemoved };
  }

  /**
   * Retry sync (MD §6.6: sync_error → 可重試操作). Re-derives the BullMQ
   * index from the DB row — the only path that heals a sync_error manually.
   */
  async function sync(id, user) {
    const row = await db.schedule.findUnique({ where: { id } });
    if (!row) throw notFound(`schedule ${id} not found`);
    const synced = await applySync(row, { syncReason: 'retry-sync' });
    return { schedule: publicSchedule(synced), healed: synced.syncStatus === SCHEDULE_SYNC_STATUS.SYNCED };
  }

  return { list, get, preview, create, update, pause, resume, runNow, remove, sync };
}
