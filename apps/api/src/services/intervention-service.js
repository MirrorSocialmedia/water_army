/**
 * InterventionService — Mobile Console P4 (MD Phase 4 / §6/§8.2).
 *
 * Owns the operator-driven STATE MACHINE on top of the shared signal writer
 * (createInterventionSignalWriter in @water-army/shared — the dedupe/episode
 * + create/re-escalate path that both the API and the worker use).
 *
 * State machine (MD §6.2/§6.3) — every transition is ONE updateMany carrying
 * the expected version + from-status (CAS, same pattern as StreamLease). A
 * concurrent winner bumps the version first; the loser matches 0 rows and gets
 * a STALE_EVENT, so a stale operator action can never clobber a newer state
 * (and a resolved event can never be silently reverted by an old action).
 *
 *   open ──acknowledge──▶ acknowledged ──assign──▶ in_progress ──┐
 *     │                     │                      │            │
 *     ├──assign─────────────┴──────────────────────┤            │
 *     │                     │                      │            ├──resolve──▶ resolved
 *     └─────────────────────┴──────────────────────┴────────────┤            │
 *                                    dismiss────────────────────┴──dismissed──┘
 *   resolved / dismissed ──reopen (explicit operator, reason)──▶ open
 *
 * Hard constraint (MD §0.6/§6.1): external_verification (CAPTCHA / anti-bot /
 * account-integrity) events are created with automationDisposition
 * 'blocked_pending_review' FORCED, cannot be dismissed (only resolved by a
 * human), and are never a trigger to auto-resume batch automation.
 *
 * RBAC is enforced at the route layer (requireRole); this service also re-checks
 * the actor's role for the role-specific dismiss policy (critical ⇒ admin).
 */
import {
  INTERVENTION_STATUS,
  INTERVENTION_SOURCE,
  INTERVENTION_CATEGORY,
  INTERVENTION_SEVERITY,
  AUTOMATION_DISPOSITION,
  INTERVENTION_OPEN_EPISODE,
  createInterventionSignalWriter,
  scrubObject,
  ROLE_LEVEL,
} from '@water-army/shared';

const ROLE = { VIEWER: 'viewer', OPERATOR: 'operator', ADMIN: 'admin' };

/** from → allowed to (transition table). */
const TRANSITIONS = Object.freeze({
  acknowledge: { from: [INTERVENTION_STATUS.OPEN], to: INTERVENTION_STATUS.ACKNOWLEDGED },
  assign: { from: [INTERVENTION_STATUS.OPEN, INTERVENTION_STATUS.ACKNOWLEDGED], to: INTERVENTION_STATUS.IN_PROGRESS },
  resolve: { from: [INTERVENTION_STATUS.OPEN, INTERVENTION_STATUS.ACKNOWLEDGED, INTERVENTION_STATUS.IN_PROGRESS], to: INTERVENTION_STATUS.RESOLVED },
  dismiss: { from: [INTERVENTION_STATUS.OPEN, INTERVENTION_STATUS.ACKNOWLEDGED, INTERVENTION_STATUS.IN_PROGRESS], to: INTERVENTION_STATUS.DISMISSED },
  reopen: { from: [INTERVENTION_STATUS.RESOLVED, INTERVENTION_STATUS.DISMISSED], to: INTERVENTION_STATUS.OPEN },
});

function roleLevel(role) {
  return ROLE_LEVEL[role] ?? 0;
}

/**
 * @param {object} deps
 * @param {object} deps.db Prisma client
 * @param {object} deps.log pino child logger
 * @param {(e:object) => Promise<void>} [deps.audit] audit fn (failures logged, never throw)
 * @param {() => Date} [deps.now] injectable clock
 */
export function createInterventionService({ db, log, audit = null, now } = {}) {
  if (!db?.manualIntervention || typeof db.manualIntervention.findMany !== 'function') {
    throw new TypeError('createInterventionService: db.manualIntervention delegate required');
  }
  const clock = now ?? (() => new Date());
  const signalWriter = createInterventionSignalWriter({ db, log, audit, now: clock });

  function err(code, message, statusCode, details = null) {
    const e = new Error(message);
    e.apiCode = code;
    e.statusCode = statusCode;
    e.details = details;
    return e;
  }
  const auditSafe = async (entry) => {
    if (!audit) return;
    try {
      await audit(entry);
    } catch (e) {
      log.warn({ error: e.message, action: entry.action }, 'intervention audit write failed (non-fatal)');
    }
  };

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
      log.warn({ interventionId, action, error: e.message }, 'intervention history write failed (non-fatal)');
    }
  }

  async function load(id) {
    const row = await db.manualIntervention.findUnique({ where: { id } });
    if (!row) throw err('INTERVENTION_NOT_FOUND', `intervention ${id} not found`, 404);
    return row;
  }

  /**
   * Core CAS transition. Fetches the current row, validates the edge, then runs
   * ONE version-guarded updateMany. On 0 matched rows it re-reads and returns a
   * precise error (STALE_EVENT / ILLEGAL_TRANSITION) so the caller can surface
   * it and the operator can retry against fresh state.
   *
   * `note` (the operator's summary/reason string, ALREADY scrubbed by the
   * caller where it is stored) is validated here when `requireNote` is set;
   * `extra` carries ONLY model columns (it is spread into the updateMany
   * data) — the note itself must never be a model column key.
   */
  async function transition(id, action, { user, requestId, ip, extra = {}, requireNote = null, note = null } = {}) {
    const t = TRANSITIONS[action];
    if (!t) throw err('ILLEGAL_TRANSITION', `unknown action '${action}'`, 400);
    const row = await load(id);
    if (!t.from.includes(row.status)) {
      throw err(
        'ILLEGAL_TRANSITION',
        `cannot ${action} an intervention in status '${row.status}' (allowed from: ${t.from.join(', ')})`,
        409,
        { status: row.status, action },
      );
    }
    // role-specific dismiss policy (MD §6.2/§8.2):
    //  - external_verification (CAPTCHA / account-integrity) can NEVER be
    //    dismissed — only resolved by a human (MD §0.6 hard constraint).
    //  - a 'critical' event can only be dismissed by an admin.
    if (action === 'dismiss') {
      if (row.category === INTERVENTION_CATEGORY.EXTERNAL_VERIFICATION) {
        throw err(
          'DISMISS_NOT_ALLOWED',
          'an external-verification (CAPTCHA / account-integrity) event cannot be dismissed — it must be resolved by a human after review (MD §0.6)',
          409,
          { category: row.category },
        );
      }
      if (row.severity === INTERVENTION_SEVERITY.CRITICAL && roleLevel(user?.role) < roleLevel(ROLE.ADMIN)) {
        throw err(
          'DISMISS_NOT_ALLOWED',
          'a critical event can only be dismissed by an admin',
          403,
          { severity: row.severity, role: user?.role },
        );
      }
    }
    if (requireNote) {
      const n = String(note ?? '').trim();
      if (n.length === 0) throw err('NOTE_REQUIRED', `${requireNote} is required for ${action}`, 400);
      if (n.length > 2000) throw err('NOTE_TOO_LONG', `${requireNote} exceeds 2000 chars`, 400);
    }

    const data = {
      status: t.to,
      version: row.version + 1,
      ...extra,
    };
    const upd = await db.manualIntervention.updateMany({
      where: { id: row.id, version: row.version, status: { in: t.from } },
      data,
    });
    if (upd.count !== 1) {
      const fresh = await load(id);
      throw err(
        'STALE_EVENT',
        `intervention ${id} changed concurrently (now status '${fresh.status}', version ${fresh.version}) — reload and retry`,
        409,
        { status: fresh.status, version: fresh.version },
      );
    }
    const fresh = await load(id);
    await appendHistory(id, {
      fromStatus: row.status,
      toStatus: t.to,
      action,
      actorUserId: user?.id ?? null,
      note: requireNote ? String(note ?? '').trim() : null,
      details: extra.__historyDetails ?? null,
    });
    await auditSafe({
      actorUserId: user?.id ?? null,
      action: `intervention.${action}`,
      resourceType: 'manual_intervention',
      resourceId: id,
      requestId: requestId ?? null,
      ip: ip ?? null,
      status: 'success',
      details: {
        from: row.status,
        to: t.to,
        category: fresh.category,
        severity: fresh.severity,
        version: fresh.version,
        deviceId: fresh.deviceId,
      },
    });
    return fresh;
  }

  // --- operator transitions (route handlers call these) --------------------
  async function acknowledge(id, { user, requestId, ip } = {}) {
    return transition(id, 'acknowledge', {
      user,
      requestId,
      ip,
      extra: { acknowledgedAt: clock() },
    });
  }

  async function assign(id, { user, requestId, ip, assigneeUserId = null } = {}) {
    const target = assigneeUserId ?? user?.id ?? null;
    if (!target) throw err('ASSIGNEE_REQUIRED', 'assigneeUserId is required (or be a logged-in operator)', 400);
    return transition(id, 'assign', {
      user,
      requestId,
      ip,
      extra: { assigneeUserId: target },
    });
  }

  async function resolve(id, { user, requestId, ip, summary } = {}) {
    return transition(id, 'resolve', {
      user,
      requestId,
      ip,
      requireNote: 'summary',
      note: String(summary ?? ''),
      extra: { resolvedAt: clock(), resolutionSummary: scrubObject(String(summary ?? '')) },
    });
  }

  async function dismiss(id, { user, requestId, ip, reason } = {}) {
    return transition(id, 'dismiss', {
      user,
      requestId,
      ip,
      requireNote: 'reason',
      note: String(reason ?? ''),
      extra: { resolvedAt: clock(), resolutionSummary: scrubObject(String(reason ?? '')) },
    });
  }

  async function reopen(id, { user, requestId, ip, reason } = {}) {
    return transition(id, 'reopen', {
      user,
      requestId,
      ip,
      requireNote: 'reason',
      note: String(reason ?? ''),
      extra: {},
    });
  }

  // --- signal entry points (production hooks + controlled qa/test paths) ----
  /**
   * Generic controlled signal (the qa_signal / operator_report / external
   * verification path, and the E2E simulate hook). external_verification FORCES
   * blocked_pending_review (MD §0.6) regardless of the caller's input.
   */
  async function recordSignal(sig) {
    const s = { ...sig };
    if (s.source === INTERVENTION_SOURCE.EXTERNAL_VERIFICATION) {
      // Hard constraint: a third-party challenge always blocks pending review.
      s.automationDisposition = AUTOMATION_DISPOSITION.BLOCKED_PENDING_REVIEW;
    }
    // evidence + summary are scrubbed here (the shared writer also guards, but
    // we scrub at the trusted boundary so the stored row is clean).
    if (s.evidence) s.evidence = scrubObject(s.evidence);
    if (s.summary) s.summary = scrubObject(String(s.summary));
    return signalWriter.recordSignal(s);
  }

  /** Network authoritative state → BLOCKED/FAILED (MD §6.1 network_state). */
  async function signalNetwork(device, to, ev = {}) {
    if (!device?.id) return null;
    const failed = to === 'FAILED';
    return signalWriter.recordSignal({
      deviceId: device.id,
      deviceNameSnapshot: device.name,
      source: INTERVENTION_SOURCE.NETWORK_STATE,
      category: INTERVENTION_CATEGORY.NETWORK_BLOCKED,
      severity: failed ? INTERVENTION_SEVERITY.CRITICAL : INTERVENTION_SEVERITY.HIGH,
      title: failed
        ? `Device '${device.name}' network FAILED — manual intervention`
        : `Device '${device.name}' network BLOCKED`,
      summary: ev.reason ? `network ${to} (${ev.reason})` : `network ${to}`,
      evidence: scrubObject({
        to,
        from: ev.from ?? null,
        errorCode: ev.errorCode ?? null,
        errorDetail: ev.errorDetail ?? null,
        netRecoveries: device.netRecoveries ?? null,
      }),
      automationDisposition: failed ? AUTOMATION_DISPOSITION.BLOCKED_PENDING_REVIEW : AUTOMATION_DISPOSITION.PAUSED,
    });
  }

  /** ADB device-side offline (a real adbd answer, not an engine failure). */
  async function signalAdbOffline(device, { adbError = null, adbNote = null } = {}) {
    if (!device?.id) return null;
    return signalWriter.recordSignal({
      deviceId: device.id,
      deviceNameSnapshot: device.name,
      source: INTERVENTION_SOURCE.ADB_HEALTH,
      category: INTERVENTION_CATEGORY.DEVICE_OFFLINE,
      severity: INTERVENTION_SEVERITY.HIGH,
      title: `Device '${device.name}' ADB offline`,
      summary: adbNote ? `adb offline — ${adbNote}` : 'adb device offline',
      evidence: scrubObject({ adbError: adbError ?? null, containerState: device.containerState ?? null }),
      automationDisposition: AUTOMATION_DISPOSITION.PAUSED,
    });
  }

  /** Android boot timeout (provision / watchdog TUNNEL_START_TIMEOUT). */
  async function signalBootTimeout(device, { reason = null, errorCode = null } = {}) {
    if (!device?.id) return null;
    return signalWriter.recordSignal({
      deviceId: device.id,
      deviceNameSnapshot: device.name,
      source: INTERVENTION_SOURCE.BOOT_TIMEOUT,
      category: INTERVENTION_CATEGORY.BOOT_TIMEOUT,
      severity: INTERVENTION_SEVERITY.HIGH,
      title: `Device '${device.name}' boot timeout`,
      summary: reason ?? 'boot_completed not seen within the boot window',
      evidence: scrubObject({ reason: reason ?? null, errorCode: errorCode ?? null }),
      automationDisposition: AUTOMATION_DISPOSITION.BLOCKED_PENDING_REVIEW,
    });
  }

  /** Container stopped / disappeared (container_health). */
  async function signalContainerOffline(device, { containerState = null } = {}) {
    if (!device?.id) return null;
    return signalWriter.recordSignal({
      deviceId: device.id,
      deviceNameSnapshot: device.name,
      source: INTERVENTION_SOURCE.CONTAINER_HEALTH,
      category: INTERVENTION_CATEGORY.DEVICE_OFFLINE,
      severity: INTERVENTION_SEVERITY.WARNING,
      title: `Device '${device.name}' container ${containerState ?? 'offline'}`,
      summary: `container state '${containerState ?? 'unknown'}'`,
      evidence: scrubObject({ containerState: containerState ?? null }),
      automationDisposition: AUTOMATION_DISPOSITION.PAUSED,
    });
  }

  // --- queries (route handlers) --------------------------------------------
  async function list({ status, severity, deviceId, category, assigneeUserId, page = 1, pageSize = 20 } = {}) {
    const where = {};
    if (status) where.status = Array.isArray(status) ? { in: status } : status;
    if (severity) where.severity = severity;
    if (deviceId) where.deviceId = deviceId;
    if (category) where.category = category;
    if (assigneeUserId) where.assigneeUserId = assigneeUserId;
    const p = Math.max(1, Math.floor(Number(page) || 1));
    const ps = Math.min(100, Math.max(1, Math.floor(Number(pageSize) || 20)));
    const [total, items] = await Promise.all([
      db.manualIntervention.count({ where }),
      db.manualIntervention.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (p - 1) * ps,
        take: ps,
        include: { history: false },
      }),
    ]);
    return { items, total, page: p, pageSize: ps };
  }

  async function get(id) {
    const row = await load(id);
    const history = await db.manualInterventionHistory.findMany({
      where: { interventionId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return { intervention: row, history };
  }

  /** Bell badge: only open + in_progress "need attention" (MD §7.1). */
  async function needsAttentionCount() {
    return db.manualIntervention.count({
      where: { status: { in: ['open', 'in_progress'] } },
    });
  }

  /** Per-device unresolved flag for the device card (MD §3.1). */
  async function unresolvedByDevice() {
    const rows = await db.manualIntervention.groupBy({
      by: ['deviceId'],
      where: { status: { in: INTERVENTION_OPEN_EPISODE }, deviceId: { not: null } },
      _count: { _all: true },
    });
    const map = {};
    for (const r of rows) map[r.deviceId] = r._count._all;
    return map;
  }

  /** Single-device unresolved count (device detail banner, MD §7.1). */
  async function unresolvedCountForDevice(deviceId) {
    if (!deviceId) return 0;
    return db.manualIntervention.count({
      where: { deviceId, status: { in: INTERVENTION_OPEN_EPISODE } },
    });
  }

  return {
    // signal entry points
    recordSignal,
    signalNetwork,
    signalAdbOffline,
    signalBootTimeout,
    signalContainerOffline,
    // operator transitions
    acknowledge,
    assign,
    resolve,
    dismiss,
    reopen,
    // queries
    list,
    get,
    needsAttentionCount,
    unresolvedByDevice,
    unresolvedCountForDevice,
    // internals (tests)
    _load: load,
  };
}

/** Fail-closed stub used when the db lacks the intervention surface (partial
 *  test fakes / pre-migration schemas) — keeps buildApp alive; every route
 *  fails closed with 503 INTERVENTION_UNAVAILABLE. Same contract as the stream
 *  lease stub (MD §9 additive-migration safety). */
export function createUnavailableIntervention() {
  const fail = () => {
    const e = new Error('manual-intervention service unavailable (DB surface missing)');
    e.apiCode = 'INTERVENTION_UNAVAILABLE';
    e.statusCode = 503;
    e.details = null;
    return e;
  };
  const noopAsync = async () => {
    throw fail();
  };
  return {
    recordSignal: async () => null,
    signalNetwork: async () => null,
    signalAdbOffline: async () => null,
    signalBootTimeout: async () => null,
    signalContainerOffline: async () => null,
    acknowledge: noopAsync,
    assign: noopAsync,
    resolve: noopAsync,
    dismiss: noopAsync,
    reopen: noopAsync,
    list: noopAsync,
    get: noopAsync,
    needsAttentionCount: async () => 0,
    unresolvedByDevice: async () => ({}),
    unresolvedCountForDevice: async () => 0,
  };
}
