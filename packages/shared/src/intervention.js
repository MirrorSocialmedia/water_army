/**
 * Manual-intervention domain contracts + the SHARED signal writer
 * (Mobile Console MD Phase 4 / §6 — human intervention events).
 *
 * WHY a shared module: the intervention "episode" logic (dedupe one open event
 * per device+category+source, re-escalate on repeat, create a NEW episode after
 * a terminal) must be IDENTICAL whether the signal arrives from the API process
 * (network/adb/boot/qa paths) or the worker process (task-failure path). Both
 * hold a Prisma client; the state-machine *transitions* (ack/assign/resolve/
 * dismiss/reopen) are operator-driven and live in the API service, but the
 * *signal record* path is shared so dedupe semantics never drift.
 *
 * Hard constraint (MD §0.6 / §6.1): third-party CAPTCHA / anti-bot /
 * account-integrity challenges are NEVER auto-resolved and are NEVER a trigger
 * to auto-resume batch automation. Such signals MUST carry
 * automationDisposition = 'blocked_pending_review'. This module enforces that
 * the disposition is one of the fixed enum values and that a
 * 'blocked_pending_review' can never be *downgraded* by a later signal on the
 * same open episode (re-escalation only).
 */

/** Intervention lifecycle (MD §6.2). open/in_progress need attention;
 *  acknowledged = seen (still an active episode, not needs-attention);
 *  resolved/dismissed = terminal. */
export const INTERVENTION_STATUS = Object.freeze({
  OPEN: 'open',
  ACKNOWLEDGED: 'acknowledged',
  IN_PROGRESS: 'in_progress',
  RESOLVED: 'resolved',
  DISMISSED: 'dismissed',
});

/** Non-terminal statuses — an OPEN EPISODE (dedupe window). */
export const INTERVENTION_OPEN_EPISODE = Object.freeze([
  INTERVENTION_STATUS.OPEN,
  INTERVENTION_STATUS.ACKNOWLEDGED,
  INTERVENTION_STATUS.IN_PROGRESS,
]);

/** Terminal statuses (episode closed). */
export const INTERVENTION_TERMINAL = Object.freeze([
  INTERVENTION_STATUS.RESOLVED,
  INTERVENTION_STATUS.DISMISSED,
]);

/** Statuses that "need attention" (the bell badge counts these — MD §7.1:
 *  only open/in_progress; acknowledged is a separate read state). */
export const INTERVENTION_NEEDS_ATTENTION = Object.freeze([
  INTERVENTION_STATUS.OPEN,
  INTERVENTION_STATUS.IN_PROGRESS,
]);

/** Event sources (MD §6.2). */
export const INTERVENTION_SOURCE = Object.freeze({
  CONTAINER_HEALTH: 'container_health',
  ADB_HEALTH: 'adb_health',
  BOOT_TIMEOUT: 'boot_timeout',
  APP_CRASH: 'app_crash',
  QA_SIGNAL: 'qa_signal',
  NETWORK_STATE: 'network_state',
  OPERATOR_REPORT: 'operator_report',
  EXTERNAL_VERIFICATION: 'external_verification',
});

/** Categories (MD §6.2). */
export const INTERVENTION_CATEGORY = Object.freeze({
  DEVICE_OFFLINE: 'DEVICE_OFFLINE',
  BOOT_TIMEOUT: 'BOOT_TIMEOUT',
  APP_CRASH: 'APP_CRASH',
  APP_UNRESPONSIVE: 'APP_UNRESPONSIVE',
  PERMISSION_REQUIRED: 'PERMISSION_REQUIRED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  NETWORK_BLOCKED: 'NETWORK_BLOCKED',
  EXTERNAL_VERIFICATION: 'EXTERNAL_VERIFICATION',
  TASK_FAILED: 'TASK_FAILED',
  OTHER: 'OTHER',
});

/** Severity (MD §6.2), ordered low → high for re-escalation. */
export const INTERVENTION_SEVERITY = Object.freeze({
  INFO: 'info',
  WARNING: 'warning',
  HIGH: 'high',
  CRITICAL: 'critical',
});

const SEVERITY_RANK = Object.freeze({
  info: 0,
  warning: 1,
  high: 2,
  critical: 3,
});

/** Automation disposition (MD §6.2), ordered weak → strong for re-escalation. */
export const AUTOMATION_DISPOSITION = Object.freeze({
  NOT_APPLICABLE: 'not_applicable',
  PAUSED: 'paused',
  BLOCKED_PENDING_REVIEW: 'blocked_pending_review',
});

const DISPOSITION_RANK = Object.freeze({
  not_applicable: 0,
  paused: 1,
  blocked_pending_review: 2,
});

const SEVERITIES = new Set(Object.values(INTERVENTION_SEVERITY));
const DISPOSITIONS = new Set(Object.values(AUTOMATION_DISPOSITION));

/**
 * Stable dedupe key for one open episode (MD §6.3: one event per same device
 * + same category + same source while the episode is open). The DB partial
 * unique index on (dedupeKey) WHERE status IN open-episode is the race guard.
 */
export function interventionDedupeKey(deviceId, category, source) {
  return `${deviceId ?? 'orphan'}::${category}::${source}`;
}

/**
 * Create the shared signal writer. NON-FATAL by contract: a signal-record
 * failure is logged and returns null — it must never crash the caller
 * (the network watchdog / adb refresh / task engine keep running).
 *
 * @param {object} deps
 * @param {object} deps.db Prisma client (manualIntervention + manualInterventionHistory delegates)
 * @param {object} [deps.log] pino-style logger
 * @param {(e:object) => Promise<void>} [deps.audit] audit fn (failures logged, never thrown)
 * @param {() => Date} [deps.now] injectable clock
 */
export function createInterventionSignalWriter({ db, log = console, audit = null, now } = {}) {
  if (!db?.manualIntervention || typeof db.manualIntervention.create !== 'function') {
    throw new TypeError('createInterventionSignalWriter: db.manualIntervention delegate required');
  }
  const clock = now ?? (() => new Date());
  const auditSafe = async (entry) => {
    if (!audit) return;
    try {
      await audit(entry);
    } catch (e) {
      log.warn?.({ error: e?.message, action: entry?.action }, 'intervention audit write failed (non-fatal)');
    }
  };

  function validate(s) {
    if (!s.deviceId && !s.deviceNameSnapshot) {
      throw new TypeError('recordSignal: deviceId or deviceNameSnapshot required');
    }
    if (!SEVERITIES.has(s.severity)) throw new TypeError(`recordSignal: bad severity '${s.severity}'`);
    if (!DISPOSITIONS.has(s.automationDisposition)) {
      throw new TypeError(`recordSignal: bad automationDisposition '${s.automationDisposition}'`);
    }
    if (!s.source) throw new TypeError('recordSignal: source required');
    if (!s.category) throw new TypeError('recordSignal: category required');
    if (!s.title || String(s.title).trim() === '') throw new TypeError('recordSignal: title required');
  }

  function maxSeverity(a, b) {
    return (SEVERITY_RANK[b] ?? 0) > (SEVERITY_RANK[a] ?? 0) ? b : a;
  }
  function maxDisposition(a, b) {
    return (DISPOSITION_RANK[b] ?? 0) > (DISPOSITION_RANK[a] ?? 0) ? b : a;
  }

  async function appendHistory(interventionId, { fromStatus, toStatus, action, actorUserId, note, details }) {
    try {
      await db.manualInterventionHistory.create({
        data: {
          interventionId,
          fromStatus: fromStatus ?? null,
          toStatus,
          action,
          actorUserId: actorUserId ?? null,
          note: note ?? null,
          detailsJson: details ?? undefined,
        },
      });
    } catch (e) {
      log.warn?.({ interventionId, action, error: e?.message }, 'intervention history write failed (non-fatal)');
    }
  }

  /**
   * Record one intervention signal (create a new open episode, or re-escalate
   * the existing open one). Returns { intervention, created } or null on a
   * non-fatal failure.
   *
   * @param {object} s
   * @param {string|null} s.deviceId device uuid (nullable when the device row is gone)
   * @param {string} [s.deviceNameSnapshot] human-readable device name (kept if device later deleted)
   * @param {string} s.source INTERVENTION_SOURCE.*
   * @param {string} s.category INTERVENTION_CATEGORY.*
   * @param {string} s.severity INTERVENTION_SEVERITY.*
   * @param {string} s.title short title (no secrets)
   * @param {string|null} [s.summary] short summary (no secrets)
   * @param {object|null} [s.evidence] ALREADY-scrubbed evidence (event ids, error codes, timestamps) — never pixels/logcat
   * @param {string} [s.automationDisposition] AUTOMATION_DISPOSITION.* (default not_applicable)
   * @param {string|null} [s.relatedTaskRunId]
   * @param {boolean} [s.heuristic] true = heuristic signal (user may confirm/false-positive)
   * @param {string|null} [s.actorUserId]
   * @param {string|null} [s.requestId]
   * @param {string|null} [s.ip]
   */
  async function recordSignal(s) {
    const sig = {
      deviceId: s.deviceId ?? null,
      deviceNameSnapshot: s.deviceNameSnapshot ?? null,
      source: s.source,
      category: s.category,
      severity: s.severity,
      title: String(s.title).slice(0, 300),
      summary: s.summary ? String(s.summary).slice(0, 1000) : null,
      evidence: s.evidence ?? null,
      automationDisposition: s.automationDisposition || AUTOMATION_DISPOSITION.NOT_APPLICABLE,
      relatedTaskRunId: s.relatedTaskRunId ?? null,
      heuristic: s.heuristic === true,
      actorUserId: s.actorUserId ?? null,
      requestId: s.requestId ?? null,
      ip: s.ip ?? null,
    };
    validate(sig);
    const t0 = clock();
    const dedupeKey = interventionDedupeKey(sig.deviceId, sig.category, sig.source);

    try {
      // 1) existing OPEN episode? (dedupe window = open/acknowledged/in_progress)
      let existing = await db.manualIntervention.findFirst({
        where: { dedupeKey, status: { in: INTERVENTION_OPEN_EPISODE } },
      });

      if (existing) {
        // Re-escalate the open episode (severity/disposition only go UP), bump
        // the signal counter + updatedAt, version-guarded (MD §6.3 no storm,
        // MD §6.2 no auto-downgrade of a blocked_pending_review).
        const data = {
          signalCount: { increment: 1 },
          updatedAt: t0,
          severity: maxSeverity(existing.severity, sig.severity),
          automationDisposition: maxDisposition(existing.automationDisposition, sig.automationDisposition),
          version: existing.version + 1,
        };
        // A NEW episode must be able to reference the freshest evidence, but
        // we keep the ORIGINAL evidence of the episode (it is the first sight
        // of the problem); repeat evidence is recorded in history details.
        const upd = await db.manualIntervention.updateMany({
          where: { id: existing.id, version: existing.version, status: { in: INTERVENTION_OPEN_EPISODE } },
          data,
        });
        if (upd.count !== 1) {
          // A concurrent transition (resolve/dismiss/reopen) won the race —
          // fall through to the create path (a NEW episode is correct for a
          // signal that lands after the previous one closed).
          existing = null;
        } else {
          const fresh = await db.manualIntervention.findUnique({ where: { id: existing.id } });
          await appendHistory(existing.id, {
            fromStatus: existing.status,
            toStatus: existing.status,
            action: 'signal',
            actorUserId: sig.actorUserId,
            note: `signal #${existing.signalCount + 1} (${sig.source})`,
            details: {
              severity: sig.severity,
              automationDisposition: sig.automationDisposition,
              summary: sig.summary,
              heuristic: sig.heuristic,
            },
          });
          await auditSafe({
            actorUserId: sig.actorUserId,
            action: 'intervention.signal',
            resourceType: 'manual_intervention',
            resourceId: existing.id,
            requestId: sig.requestId,
            ip: sig.ip,
            status: 'success',
            details: { dedupeKey, category: sig.category, source: sig.source, severity: sig.severity, signalCount: existing.signalCount + 1 },
          });
          return { intervention: fresh, created: false, dedupeKey };
        }
      }

      // 2) create a NEW open episode. 23505 (P2002) = a concurrent creator
      //    won the partial-unique race → refetch the open one and re-escalate.
      const base = {
        deviceId: sig.deviceId,
        deviceNameSnapshot: sig.deviceNameSnapshot,
        source: sig.source,
        category: sig.category,
        severity: sig.severity,
        status: INTERVENTION_STATUS.OPEN,
        automationDisposition: sig.automationDisposition,
        title: sig.title,
        summary: sig.summary,
        evidence: sig.evidence,
        relatedTaskRunId: sig.relatedTaskRunId,
        heuristic: sig.heuristic,
        dedupeKey,
        signalCount: 1,
        version: 1,
      };
      let created;
      try {
        created = await db.manualIntervention.create({ data: base });
      } catch (err) {
        if (String(err?.code ?? '').includes('P2002')) {
          const raced = await db.manualIntervention.findFirst({
            where: { dedupeKey, status: { in: INTERVENTION_OPEN_EPISODE } },
          });
          if (raced) {
            const upd = await db.manualIntervention.updateMany({
              where: { id: raced.id, version: raced.version, status: { in: INTERVENTION_OPEN_EPISODE } },
              data: {
                signalCount: { increment: 1 },
                updatedAt: t0,
                severity: maxSeverity(raced.severity, sig.severity),
                automationDisposition: maxDisposition(raced.automationDisposition, sig.automationDisposition),
                version: raced.version + 1,
              },
            });
            const fresh = await db.manualIntervention.findUnique({ where: { id: raced.id } });
            if (upd.count === 1) {
              await appendHistory(raced.id, {
                fromStatus: raced.status,
                toStatus: raced.status,
                action: 'signal',
                actorUserId: sig.actorUserId,
                note: `signal #${raced.signalCount + 1} (${sig.source})`,
                details: { severity: sig.severity },
              });
              return { intervention: fresh, created: false, dedupeKey };
            }
            // Lost the re-escalate race too — report the row as-is (non-fatal).
            return { intervention: fresh, created: false, dedupeKey };
          }
          // dedupeKey now unoccupied (the racer went terminal between the
          // unique violation and our refetch) — fall through and create.
        } else {
          throw err;
        }
      }

      await appendHistory(created.id, {
        fromStatus: null,
        toStatus: INTERVENTION_STATUS.OPEN,
        action: 'created',
        actorUserId: sig.actorUserId,
        note: sig.title,
        details: {
          dedupeKey,
          source: sig.source,
          category: sig.category,
          severity: sig.severity,
          automationDisposition: sig.automationDisposition,
          heuristic: sig.heuristic,
          summary: sig.summary,
        },
      });
      await auditSafe({
        actorUserId: sig.actorUserId,
        action: 'intervention.created',
        resourceType: 'manual_intervention',
        resourceId: created.id,
        requestId: sig.requestId,
        ip: sig.ip,
        status: sig.severity === 'critical' ? 'failure' : 'success',
        details: {
          dedupeKey,
          source: sig.source,
          category: sig.category,
          severity: sig.severity,
          automationDisposition: sig.automationDisposition,
          heuristic: sig.heuristic,
          deviceId: sig.deviceId,
          relatedTaskRunId: sig.relatedTaskRunId,
        },
      });
      return { intervention: created, created: true, dedupeKey };
    } catch (err) {
      log.error?.({ dedupeKey, error: err?.message }, 'intervention recordSignal failed (non-fatal)');
      return null;
    }
  }

  return { recordSignal };
}
