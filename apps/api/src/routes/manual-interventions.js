/**
 * Manual-intervention routes — Mobile Console P4 (MD Phase 4 / §8.2).
 *
 * The durable human-intervention event surface: list/filter, detail+history,
 * the operator state machine (acknowledge / assign / resolve / dismiss /
 * reopen), the badge count for the topbar bell, and the controlled signal
 * entry point (source operator_report | qa_signal | external_verification —
 * the "controlled simulate hook" E2E uses to trigger stuck episodes through
 * the REAL API, MD §6.1).
 *
 * RBAC (MD §11.2/§8.2): viewer = read-only (list/detail/count); operator+
 * for every state-machine action + controlled signal creation. The service
 * adds the role-specific dismiss policy on top: an external_verification
 * event can NEVER be dismissed (only resolved by a human, MD §0.6) and a
 * critical event can only be dismissed by an admin.
 *
 * Error contract: service-layer errors carry their own stable codes
 * (INTERVENTION_NOT_FOUND 404, ILLEGAL_TRANSITION 409, STALE_EVENT 409,
 * DISMISS_NOT_ALLOWED 403/409, NOTE_REQUIRED 400, INTERVENTION_UNAVAILABLE
 * 503) — the global error handler passes them through untouched.
 *
 * Zero secrets (MD §6.2/§13): evidence/summary/note are scrubbed by the
 * service before write; responses never carry screen pixels, logcat dumps,
 * cookies, passwords or proxy URLs.
 */

const UUID = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };

/** Controlled signal sources the OPERATOR API accepts (MD §6.1). System
 *  sources (network_state/adb_health/boot_timeout/container_health/app_crash)
 *  are fired by the wired production paths only — an operator POSTing one of
 *  them would forge a system signal. */
const OPERATOR_SIGNAL_SOURCES = ['operator_report', 'qa_signal', 'external_verification'];

const CATEGORY_VALUES = [
  'DEVICE_OFFLINE', 'BOOT_TIMEOUT', 'APP_CRASH', 'APP_UNRESPONSIVE',
  'PERMISSION_REQUIRED', 'MANUAL_REVIEW', 'NETWORK_BLOCKED',
  'EXTERNAL_VERIFICATION', 'TASK_FAILED', 'OTHER',
];
const SEVERITY_VALUES = ['info', 'warning', 'high', 'critical'];
const STATUS_VALUES = ['open', 'acknowledged', 'in_progress', 'resolved', 'dismissed'];
const DISPOSITION_VALUES = ['not_applicable', 'paused', 'blocked_pending_review'];

const CREATE_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'category', 'title'],
  properties: {
    source: { type: 'string', enum: OPERATOR_SIGNAL_SOURCES },
    category: { type: 'string', enum: CATEGORY_VALUES },
    severity: { type: 'string', enum: SEVERITY_VALUES },
    deviceId: { type: 'string', pattern: UUID.pattern },
    deviceNameSnapshot: { type: 'string', maxLength: 200 },
    title: { type: 'string', minLength: 1, maxLength: 300 },
    summary: { type: 'string', maxLength: 1000 },
    evidence: { type: 'object', additionalProperties: true },
    automationDisposition: { type: 'string', enum: DISPOSITION_VALUES },
    heuristic: { type: 'boolean' },
    relatedTaskRunId: { type: 'string', pattern: UUID.pattern },
  },
};

const NOTE_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: { summary: { type: 'string', minLength: 1, maxLength: 2000 } },
};

const REASON_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['reason'],
  properties: { reason: { type: 'string', minLength: 1, maxLength: 2000 } },
};

const ASSIGN_BODY = {
  type: 'object',
  additionalProperties: false,
  properties: { assigneeUserId: { type: 'string', pattern: UUID.pattern } },
};

const LIST_QUERY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string' }, // comma-separated subset of STATUS_VALUES
    severity: { type: 'string', enum: SEVERITY_VALUES },
    deviceId: { type: 'string', pattern: UUID.pattern },
    category: { type: 'string', enum: CATEGORY_VALUES },
    assigneeUserId: { type: 'string', pattern: UUID.pattern },
    page: { type: 'string' },
    pageSize: { type: 'string' },
  },
};

const ID_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: UUID },
};

export function manualInterventionRoutes(app) {
  const svc = () => app.interventionService;

  // --- badge (topbar bell) — registered BEFORE the :id param route ---------
  app.get(
    '/api/manual-interventions/needs-attention-count',
    { preHandler: app.requireRole('viewer') },
    async (req) => {
      const count = await svc().needsAttentionCount();
      return { count };
    },
  );

  app.get(
    '/api/manual-interventions',
    { preHandler: app.requireRole('viewer'), schema: { query: LIST_QUERY } },
    async (req) => {
      const q = req.query;
      const status = q.status
        ? String(q.status).split(',').map((s) => s.trim()).filter((s) => STATUS_VALUES.includes(s))
        : undefined;
      return svc().list({
        status,
        severity: q.severity,
        deviceId: q.deviceId,
        category: q.category,
        assigneeUserId: q.assigneeUserId,
        page: q.page,
        pageSize: q.pageSize,
      });
    },
  );

  // --- controlled signal entry point (operator_report / qa_signal / --------
  // --- external_verification). E2E "simulate hook" = this real route. -------
  app.post(
    '/api/manual-interventions',
    { preHandler: app.requireRole('operator'), schema: { body: CREATE_BODY } },
    async (req, reply) => {
      const b = req.body;
      if (!b.deviceId && !b.deviceNameSnapshot) {
        const e = new Error('deviceId or deviceNameSnapshot is required');
        e.statusCode = 400; // the error handler maps err.validation → VALIDATION_ERROR
        e.validation = [{ message: 'deviceId or deviceNameSnapshot is required' }];
        throw e;
      }
      // Resolve the snapshot from the live device row when one is given
      // (operators pick a device from the UI — the row name is authoritative).
      let deviceNameSnapshot = b.deviceNameSnapshot;
      let relatedTaskRunId = b.relatedTaskRunId ?? null;
      if (b.deviceId) {
        const dev = await app.db.device.findUnique({ where: { id: b.deviceId } });
        if (!dev) {
          const e = new Error(`device '${b.deviceId}' not found`);
          e.apiCode = 'INTERVENTION_DEVICE_NOT_FOUND';
          e.statusCode = 404;
          throw e;
        }
        deviceNameSnapshot = dev.name;
        // MD §6.2: relatedTaskRunId ownership/scope checked by the caller —
        // the run MUST exist, and when the device linkage is resolvable
        // (inputJson.deviceId) it must match. A run whose linkage cannot be
        // resolved is accepted (documented in the history details) — an
        // unknown run id is always rejected, so a signal can never reference
        // a run out of scope.
        if (relatedTaskRunId) {
          const run = await app.db.taskRun.findUnique({ where: { id: relatedTaskRunId } }).catch(() => null);
          if (!run) {
            const e = new Error(`relatedTaskRunId '${relatedTaskRunId}' not found`);
            e.apiCode = 'INTERVENTION_TASK_RUN_OUT_OF_SCOPE';
            e.statusCode = 409;
            throw e;
          }
          const runDeviceId = run.inputJson?.deviceId ?? null;
          if (runDeviceId && runDeviceId !== b.deviceId) {
            const e = new Error(`relatedTaskRunId '${relatedTaskRunId}' belongs to a different device`);
            e.apiCode = 'INTERVENTION_TASK_RUN_OUT_OF_SCOPE';
            e.statusCode = 409;
            throw e;
          }
        }
      }
      const out = await svc().recordSignal({
        deviceId: b.deviceId ?? null,
        deviceNameSnapshot,
        source: b.source,
        category: b.category,
        severity: b.severity ?? 'warning',
        title: b.title,
        summary: b.summary ?? null,
        evidence: b.evidence ?? null,
        automationDisposition: b.automationDisposition,
        heuristic: b.heuristic === true,
        relatedTaskRunId,
        actorUserId: req.user.id,
        requestId: req.id,
        ip: req.ip,
      });
      if (!out) {
        const e = new Error('failed to record intervention signal');
        e.apiCode = 'INTERVENTION_RECORD_FAILED';
        e.statusCode = 500;
        throw e;
      }
      return reply.code(out.created ? 201 : 200).send({ intervention: out.intervention, created: out.created, dedupeKey: out.dedupeKey });
    },
  );

  app.get(
    '/api/manual-interventions/:id',
    { preHandler: app.requireRole('viewer'), schema: { params: ID_PARAMS } },
    async (req) => svc().get(req.params.id),
  );

  app.post(
    '/api/manual-interventions/:id/acknowledge',
    { preHandler: app.requireRole('operator'), schema: { params: ID_PARAMS } },
    async (req) => svc().acknowledge(req.params.id, { user: req.user, requestId: req.id, ip: req.ip }),
  );

  app.post(
    '/api/manual-interventions/:id/assign',
    { preHandler: app.requireRole('operator'), schema: { params: ID_PARAMS, body: ASSIGN_BODY } },
    async (req) =>
      svc().assign(req.params.id, {
        user: req.user,
        requestId: req.id,
        ip: req.ip,
        assigneeUserId: req.body?.assigneeUserId ?? null,
      }),
  );

  app.post(
    '/api/manual-interventions/:id/resolve',
    { preHandler: app.requireRole('operator'), schema: { params: ID_PARAMS, body: NOTE_BODY } },
    async (req) =>
      svc().resolve(req.params.id, {
        user: req.user,
        requestId: req.id,
        ip: req.ip,
        summary: req.body.summary,
      }),
  );

  app.post(
    '/api/manual-interventions/:id/dismiss',
    { preHandler: app.requireRole('operator'), schema: { params: ID_PARAMS, body: REASON_BODY } },
    async (req) =>
      svc().dismiss(req.params.id, {
        user: req.user,
        requestId: req.id,
        ip: req.ip,
        reason: req.body.reason,
      }),
  );

  app.post(
    '/api/manual-interventions/:id/reopen',
    { preHandler: app.requireRole('operator'), schema: { params: ID_PARAMS, body: REASON_BODY } },
    async (req) =>
      svc().reopen(req.params.id, {
        user: req.user,
        requestId: req.id,
        ip: req.ip,
        reason: req.body.reason,
      }),
  );
}
