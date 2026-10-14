/**
 * Schedule domain constants (施工 MD §1.4 / §12 / §7 schedules).
 *
 * PostgreSQL `schedules` is the single source of truth; BullMQ Job Schedulers
 * are the execution index (MD §12.1). These constants keep the vocabulary in
 * one place for api + worker + tests.
 */
import { randomUUID, createHash } from 'node:crypto';

/** Schedule kinds (MD §1.4: 一次性 / 固定間隔 / cron). */
export const SCHEDULE_TYPE = Object.freeze({
  ONCE: 'once',
  INTERVAL: 'interval',
  CRON: 'cron',
});

/** BullMQ sync health of the schedule row (MD §6.6 / §12.1). */
export const SCHEDULE_SYNC_STATUS = Object.freeze({
  /** DB written; BullMQ sync not yet attempted (transient, in-flight). */
  PENDING: 'pending',
  /** DB and BullMQ verified consistent. */
  SYNCED: 'synced',
  /** Last BullMQ write failed — row is still authoritative; retryable. */
  SYNC_ERROR: 'sync_error',
});

/** Overlap policy (MD §1.4: MVP = skip_if_running | queue; 唔做 cancel-and-replace). */
export const OVERLAP_POLICY = Object.freeze({
  /** If an active run exists for this schedule, the slot is recorded as a
   *  terminal `skipped` run (no enqueue). Default. */
  SKIP_IF_RUNNING: 'skip_if_running',
  /** Enqueue regardless; the worker concurrency cap naturally serialises. */
  QUEUE: 'queue',
});

/** Run statuses that count as "actively running" for the overlap check. */
export const SCHEDULE_ACTIVE_RUN_STATUSES = Object.freeze([
  'queued',
  'running',
  'needs_approval',
  'cancel_requested',
]);

/** Job name for schedule fire jobs (shared `ai-tasks` queue, dispatched by name). */
export const SCHEDULE_FIRE_JOB_NAME = 'schedule-fire';

/**
 * Stable BullMQ Job Scheduler id per schedule. JOINER IS '-' (never ':'):
 * BullMQ throws "Custom Id cannot contain :" on ids that contain colons
 * (P3 live-acceptance catch). The id is derived from the schedule uuid, so
 * it is stable across restarts — the reconcile idempotency anchor.
 */
export function schedulerIdFor(scheduleId) {
  return `sched-${scheduleId}`;
}

/**
 * Deterministic job id for the ONE-SHOT (once) fire job. A `once` schedule is
 * a plain delayed job (BullMQ Job Schedulers have no one-shot-at-date
 * primitive — pattern/every both repeat), so the job id IS the idempotency
 * anchor: re-adding with the same id never creates a second fire.
 *
 * 6 + 36 (uuid) + 1 + 13 (ms) = 56 chars — fits idempotencyKey space as well.
 */
export function onceFireJobId(scheduleId, slotMs) {
  return `schedonce-${scheduleId}-${Number(slotMs)}`;
}

/**
 * Idempotency key for an AUTOMATIC fire of a schedule slot.
 * Scope: one key per (schedule, scheduled slot). A duplicate fire of the same
 * slot (BullMQ redelivery, double reconcile, restart race) replays to the same
 * run row — 零重複 (工單硬驗收). Manual fires use the `runnow-` namespace so
 * they can never collide with automatic slots (驗收 6).
 *
 * 6 + 36 + 1 + 13 = 56 chars ≤ 64, charset [A-Za-z0-9_-] ✓
 */
export function scheduleSlotKey(scheduleId, slotMs) {
  return `sched-${scheduleId}-${Number(slotMs)}`;
}

/**
 * Idempotency key for the SKIP run recorded when overlap_policy=skip_if_running
 * suppresses a slot. Same slot → same key (a re-fired slot skips once, not twice).
 *
 * 6 + 36 + 1 + 13 + 5 = 61 chars ≤ 64 ✓
 */
export function scheduleSkipKey(scheduleId, slotMs) {
  return `sched-${scheduleId}-${Number(slotMs)}-skip`;
}

/** Server-generated idempotency key for run-now (manual) fires. 7 + 36 = 43 ✓ */
export function runNowKey() {
  return `runnow-${randomUUID()}`;
}

/** Minimum interval between runs (MD §12.2: 過高頻率 → 400). Configurable. */
export const SCHEDULE_MIN_INTERVAL_MS_DEFAULT = 10_000;

/** Default background reconcile cadence (防 drift; boot pass is immediate). */
export const SCHEDULE_RECONCILE_INTERVAL_MS_DEFAULT = 5 * 60_000;

/** Per-fire job timeout backstop (the fire handler is fast — DB writes only). */
export const SCHEDULE_FIRE_JOB_TIMEOUT_MS = 30_000;

/** Fire-job transport history bounds (DB holds the real history). */
export const SCHEDULE_FIRE_REMOVE_ON_COMPLETE = { age: 86_400 };
export const SCHEDULE_FIRE_REMOVE_ON_FAIL = { age: 7 * 86_400 };

/**
 * A fire whose scheduled slot is more than this far BEHIND the DB's current
 * next_run_at is a stale redelivery of an already-consumed slot (crash/refire
 * race). Such a fire is dropped (idempotency would have replayed it anyway,
 * but a slot that has already ADVANCED past is a genuine no-op).
 * Generous on purpose: legitimate cron/interval fires land within ms of the
 * slot; only pathologically lagging workers exceed this, and even then the
 * idempotency key keeps the run unique.
 */
export const SCHED_STALE_SLOT_TOLERANCE_MS = 60_000;

/**
 * Stable fingerprint of a schedule's execution parameters. The fire job
 * carries the hash that was current when the BullMQ index entry was written;
 * the fire handler recomputes it from the live DB row on fire. A mismatch means
 * the schedule was modified (cron/interval/tz/overlap changed) but an OLD
 * scheduler entry is still firing — a stale index the reconciler has not yet
 * swept. The handler drops the fire + self-removes the stale entry instead of
 * executing with the wrong cadence.
 */
export function schedulingHash(row) {
  const basis = [
    row.scheduleType ?? '',
    row.cronExpression ?? '',
    String(row.intervalMs ?? ''),
    row.timezone ?? '',
    row.overlapPolicy ?? '',
  ].join('|');
  return createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

/** Fire-job payload (secret-free): identity + the generation hash. */
export function fireJobData(row) {
  return {
    scheduleId: row.id,
    schedHash: schedulingHash(row),
  };
}
