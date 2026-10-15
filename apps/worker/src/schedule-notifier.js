/**
 * Schedule notifier (P6 flag #3 — 施工 MD 尾段: 「排程執行完成/失敗 → UI
 * 通知」).
 *
 * One notification per TERMINAL scheduled run. `run_id` is unique, and a run
 * can only reach terminal once, so at most one row per run. Ad-hoc (non-
 * schedule) runs never notify.
 *
 * Also writes the schedule's terminal `last_status` back: the P4 fire path
 * only ever wrote 'queued' at fire time, so without this the Schedules UI
 * would show a permanently stale status.
 *
 * Failure policy: NON-FATAL. The run's own state is already durable in
 * task_runs/events; a notification write failure must never fail the job.
 * P2002 on the run_id unique (a double terminal write race) = already
 * notified → success.
 */
import { TASK_RUN_TERMINAL } from '@water-army/shared';

const TERMINAL_STATUSES = new Set(TASK_RUN_TERMINAL); // succeeded/failed/cancelled/timed_out/skipped

const VERB = Object.freeze({
  succeeded: 'completed',
  failed: 'failed',
  timed_out: 'timed out',
  cancelled: 'cancelled',
  skipped: 'skipped',
});

/**
 * @param {object} deps
 * @param {object} deps.db Prisma client (schedule + scheduleNotification)
 * @param {object} [deps.log]
 */
export function createScheduleNotifier({ db, log = console } = {}) {
  /**
   * @param {object} run terminal TaskRun row (or subset: id, scheduleId,
   *   status, errorCode, errorMessage)
   * @returns {Promise<string|null>} notification id, or null when nothing
   *   was written (non-schedule run / deleted schedule / already notified /
   *   write failure — logged, never thrown).
   */
  async function notifyTerminal(run) {
    if (!run?.id || !run?.scheduleId || !TERMINAL_STATUSES.has(run?.status)) return null;
    try {
      const row = await db.schedule.findUnique({ where: { id: run.scheduleId }, select: { id: true, name: true } });
      if (!row) {
        // Schedule deleted while the run was in flight. The run row keeps
        // its lineage, but a notification would dangle with no UI surface —
        // skip rather than orphan.
        if (log.debug) log.debug({ runId: run.id, scheduleId: run.scheduleId }, 'schedule notification skipped — schedule deleted');
        return null;
      }
      const message = run.errorCode
        ? `${run.errorCode}${run.errorMessage ? `: ${String(run.errorMessage).slice(0, 200)}` : ''}`
        : null;
      const created = await db.scheduleNotification.create({
        data: {
          scheduleId: row.id,
          runId: run.id,
          status: run.status,
          title: `[${row.name}] ${VERB[run.status] ?? run.status}`,
          message,
        },
      });
      // Terminal last_status backfill (fire path only wrote 'queued').
      await db.schedule.update({ where: { id: row.id }, data: { lastStatus: run.status } });
      return created.id;
    } catch (err) {
      // Unique violation on run_id = a second terminal write raced us —
      // the notification exists, treat as success.
      if (String(err?.code ?? '').includes('P2002')) return null;
      if (log.warn) log.warn({ runId: run?.id, error: err?.message }, 'schedule notification failed (non-fatal)');
      return null;
    }
  }

  return { notifyTerminal };
}
