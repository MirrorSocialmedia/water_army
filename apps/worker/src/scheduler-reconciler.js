/**
 * Scheduler reconciler — P1 placeholder.
 *
 * P4 contract (施工 MD §12.1): PostgreSQL `schedules` is the single source of
 * truth; BullMQ Job Schedulers are the execution index. Reconciliation must be
 * idempotent (upsertJobScheduler semantics):
 *   - read all enabled schedules
 *   - create/update schedulers whose params drifted
 *   - remove schedulers whose schedule is disabled/deleted
 *   - mark sync_status (`synced` / `sync_error`)
 *
 * Legacy BullMQ repeatable APIs are forbidden (施工 MD §3; ADR §5.2).
 */
export function createSchedulerReconciler({ log } = {}) {
  return {
    /**
     * Run one reconciliation pass.
     * @returns {Promise<{checked:number, created:number, updated:number, removed:number, status:string}>}
     */
    async reconcile() {
      log.info(
        'scheduler-reconciler: P1 placeholder — no-op (PG→BullMQ reconciliation lands in P4)',
      );
      return { checked: 0, created: 0, updated: 0, removed: 0, status: 'placeholder' };
    },
  };
}
