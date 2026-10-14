/**
 * Scheduler reconciler (P4, 施工 MD §12.1) — PostgreSQL is the source of
 * truth; the BullMQ Job Scheduler index must be brought in line with it.
 *
 * Invariants (工單硬驗收 3 — 重啟 reconcile 零重複):
 *   - Idempotent by construction: every desired scheduler is upserted under
 *     the SAME stable key `sched-<schedule uuid>` (BullMQ upsertJobScheduler
 *     overrides in place — a second upsert can never create a second index).
 *   - DB-first: we only ever ADD/REFRESH what the DB says should exist and
 *     REMOVE index entries the DB says should not. A crashed/restarted worker
 *     therefore converges to exactly {enabled schedules} — 零重複.
 *   - Namespaced sweep: only `sched-`-prefixed Job Scheduler keys are ever
 *     removed (this platform's namespace) — foreign keys are never touched.
 *   - `sync_status` self-heal: a pass that completes fully re-marks any
 *     `sync_error`/`pending` row as `synced` (the index now provably matches).
 *     A pass that THROWS (redis down) touches nothing — the row stays
 *     honestly flagged; the next pass retries.
 *
 * Once schedules are plain DELAYED JOBS (not Job Schedulers — see
 * schedule-constants), so they are healed by re-adding their deterministic
 * `schedonce-<id>-<slotMs>` job (same id = same job, no dupes) and by
 * removing orphaned delayed fire jobs whose schedule/slot no longer exists.
 *
 * Legacy BullMQ repeatable APIs are forbidden (施工 MD §3; ADR §5.2).
 */
import {
  SCHEDULE_TYPE,
  SCHEDULE_SYNC_STATUS,
  SCHEDULE_FIRE_JOB_NAME,
  SCHEDULE_FIRE_JOB_TIMEOUT_MS,
  SCHEDULE_FIRE_REMOVE_ON_COMPLETE,
  SCHEDULE_FIRE_REMOVE_ON_FAIL,
  schedulerIdFor,
  onceFireJobId,
  schedulingHash,
} from '@water-army/shared';

/**
 * @param {object} deps
 * @param {object} deps.db    Prisma client — schedule model
 * @param {object} deps.queue BullMQ Queue — Job Scheduler API + delayed jobs
 * @param {object} [deps.log] pino logger
 */
export function createSchedulerReconciler({ db, queue, log = console } = {}) {
  /**
   * repeatOpts for BullMQ (same shape the API writes — the index must not
   * depend on which component last touched it).
   */
  function repeatOptsFor(row) {
    if (row.scheduleType === SCHEDULE_TYPE.CRON) {
      return { pattern: row.cronExpression, tz: row.timezone };
    }
    return { every: row.intervalMs };
  }

  function fireTemplate(row) {
    return {
      name: SCHEDULE_FIRE_JOB_NAME,
      data: { scheduleId: row.id, schedHash: schedulingHash(row) },
      opts: {
        attempts: 1,
        timeout: SCHEDULE_FIRE_JOB_TIMEOUT_MS,
        removeOnComplete: SCHEDULE_FIRE_REMOVE_ON_COMPLETE,
        removeOnFail: SCHEDULE_FIRE_REMOVE_ON_FAIL,
      },
    };
  }

  /**
   * Run ONE reconciliation pass.
   * @returns {Promise<{status:string, checked:number, kept:number, created:number, driftFixed:number, removed:number, orphanJobs:number, healedSync:number}>}
   */
  async function reconcile() {
    const summary = {
      status: 'ok',
      checked: 0,
      kept: 0,
      created: 0,
      driftFixed: 0,
      removed: 0,
      orphanJobs: 0,
      healedSync: 0,
    };

    const rows = await db.schedule.findMany();
    const enabled = rows.filter((r) => r.isEnabled);
    const [schedulers, delayedJobs] = await Promise.all([
      queue.getJobSchedulers(),
      queue.getJobs(['delayed']),
    ]);
    const indexByKey = new Map(schedulers.map((s) => [s.key, s]));

    // ------------------------------------------------ desired index (DB-first)
    for (const row of enabled) {
      summary.checked += 1;

      if (row.scheduleType === SCHEDULE_TYPE.ONCE) {
        // Heal the deterministic delayed job (redis flush / missed add).
        if (row.nextRunAt) {
          const slotMs = new Date(row.nextRunAt).getTime();
          const jobId = onceFireJobId(row.id, slotMs);
          const job = await queue.getJob(jobId);
          if (!job) {
            try {
              await queue.add(SCHEDULE_FIRE_JOB_NAME, {
                scheduleId: row.id,
                schedHash: schedulingHash(row),
                scheduledAt: new Date(slotMs).toISOString(),
                once: true,
              }, {
                jobId,
                delay: Math.max(0, slotMs - Date.now()),
                attempts: 1,
                timeout: SCHEDULE_FIRE_JOB_TIMEOUT_MS,
                removeOnComplete: SCHEDULE_FIRE_REMOVE_ON_COMPLETE,
                removeOnFail: SCHEDULE_FIRE_REMOVE_ON_FAIL,
              });
              summary.created += 1;
            } catch (err) {
              // Overlapping pass beat us to the add (same deterministic id) —
              // the job exists now, which is exactly the desired state.
              if (err?.name !== 'JobExistsError') throw err;
            }
          }
        }
        continue;
      }

      const key = schedulerIdFor(row.id);
      const entry = indexByKey.get(key);
      const want = repeatOptsFor(row);
      const wantHash = schedulingHash(row);
      const haveHash = entry?.template?.data?.schedHash;

      if (!entry) {
        // Missing from the index (never synced, or redis lost it) → create.
        await queue.upsertJobScheduler(key, want, fireTemplate(row));
        summary.created += 1;
        continue;
      }

      const drifted =
        entry.pattern !== (want.pattern ?? null) ||
        entry.every !== (want.every ?? null) ||
        entry.tz !== (want.tz ?? null) ||
        haveHash !== wantHash;
      if (drifted) {
        // Params moved under the index (e.g. a PATCH whose re-upsert failed
        // and left sync_error) → override in place. Same key = 零重複.
        await queue.upsertJobScheduler(key, want, fireTemplate(row));
        summary.driftFixed += 1;
      } else {
        summary.kept += 1;
      }
    }

    // ------------------------------------------------ orphan sweep (index)
    const validKeys = new Set(
      enabled.filter((r) => r.scheduleType !== SCHEDULE_TYPE.ONCE).map((r) => schedulerIdFor(r.id)),
    );
    for (const s of schedulers) {
      if (!String(s.key).startsWith('sched-')) continue; // foreign namespace — never touch
      if (!validKeys.has(s.key)) {
        await queue.removeJobScheduler(s.key);
        summary.removed += 1;
        log.info?.({ key: s.key }, 'reconciler: removed orphan scheduler (no matching enabled schedule)');
      }
    }

    // ------------------------------------------- orphan sweep (once jobs)
    const enabledOnce = new Map(enabled.filter((r) => r.scheduleType === SCHEDULE_TYPE.ONCE).map((r) => [r.id, r]));
    for (const job of delayedJobs) {
      if (job?.name !== SCHEDULE_FIRE_JOB_NAME) continue;
      const sid = job?.data?.scheduleId;
      const row = sid ? enabledOnce.get(sid) : null;
      if (!row || !row.nextRunAt) {
        // Schedule deleted/disabled, or once slot already consumed → orphan.
        await job.remove().catch((err) => log.debug?.({ error: err.message }, 'orphan once-job remove no-op'));
        summary.orphanJobs += 1;
        continue;
      }
      const currentJobId = onceFireJobId(row.id, new Date(row.nextRunAt).getTime());
      if (job.id !== currentJobId) {
        // Stale slot (e.g. the runAt PATCH failed to remove the old job) →
        // keep exactly ONE fire per schedule: the current slot's job.
        await job.remove().catch((err) => log.debug?.({ error: err.message }, 'stale once-job remove no-op'));
        summary.orphanJobs += 1;
      }
    }

    // ------------------------------------------------ sync_status self-heal
    for (const row of enabled) {
      if (row.syncStatus !== SCHEDULE_SYNC_STATUS.SYNCED) {
        await db.schedule.update({ where: { id: row.id }, data: { syncStatus: SCHEDULE_SYNC_STATUS.SYNCED } });
        summary.healedSync += 1;
      }
    }

    return summary;
  }

  let timer = null;

  /**
   * Boot pass + background cadence. Pass failures are logged and retried on
   * the next tick — they NEVER mark rows sync_error (the index may still be
   * intact; only the API's own failed write is the sync_error trigger).
   */
  function start({ intervalMs } = {}) {
    stop();
    const run = async () => {
      try {
        const result = await reconcile();
        if (result.created || result.driftFixed || result.removed || result.orphanJobs || result.healedSync) {
          log.info?.({ result }, 'scheduler reconcile: drift corrected');
        }
      } catch (err) {
        log.error?.({ error: err.message }, 'scheduler reconcile pass failed (DB stays authoritative; next pass retries)');
      }
    };
    void run(); // boot pass (async; errors self-log)
    if (Number.isFinite(intervalMs) && intervalMs > 0) {
      timer = setInterval(() => void run(), intervalMs);
      // Don't let the timer pin the process open during tests/shutdown.
      timer.unref?.();
    }
    return { run };
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { reconcile, start, stop };
}
