/**
 * BR-B2 batch rotation routes (施工 MD §10 — API 契約).
 *
 *  - GET  /api/identities              viewer — paged + status filter (+ per-status counts)
 *  - POST /api/batches/preview         operator — DRY RUN: plan + resource estimate + gaps;
 *                                       ZERO writes, never creates containers
 *  - POST /api/batches                 operator — confirmed cycle (idempotency key REQUIRED)
 *  - GET  /api/batches/capacity        admin — global container cap (AppSetting)
 *  - POST /api/batches/capacity        admin — set/clear the global cap
 *  - GET  /api/batches/:id             viewer — status + per-identity stats + active count
 *  - POST /api/batches/:id/start       operator — predecessor gate + capacity + dispatch
 *  - POST /api/batches/:id/pause       operator — { stopExisting } (MD §7.1 explicit option)
 *  - POST /api/batches/:id/resume      operator — re-arm + re-dispatch
 *  - POST /api/batches/:id/cancel      operator — PLANNED: immediate; RUNNING: CANCELLING (202)
 *  - POST /api/task-runs/:id/retry     operator — BATCH runs only (409 → legacy route otherwise)
 *  - POST /api/task-runs/:id/cancel    operator — BATCH runs only
 *  - GET  /api/task-runs/:id/logs      viewer — BATCH runs only; cursor paging + scrubbed payloads
 *
 * RBAC: viewer < operator < admin (app.requireRole). Write routes are
 * per-USER rate limited (sliding window, ALL calls recorded — not just
 * failures): 30/min lifecycle writes, 10/min retries (MD §13.2).
 *
 * Errors ride the centralized envelope { error: { code, message, requestId } }
 * — service errors (BatchError/TaskRunError) carry their own stable apiCode.
 *
 * This module never runs the scheduler loop — that is worker-side
 * (BATCH_SCHEDULER_ENABLED). The API calls the scheduler's LIFECYCLE ops
 * (start/pause/resume/cancel), which are cross-process safe (CAS + DB).
 */
import {
  API_ERROR,
  APP_SETTING_BATCH_GLOBAL_MAX_ACTIVE,
  createBatchService,
  createLeaseService,
  createBatchScheduler,
  createTaskRunService,
  effectiveSlotCap,
  enqueueAnyRun,
  removeWaitingBatchRun,
  scrubObject,
} from '@water-army/shared';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSINT_RE = '^[0-9]+$';

// The app runs ajv with coerceTypes:false (house style — tasks.js LIST_QUERY):
// query ints are validated as DIGIT STRINGS, then parsed + clamped here.
function parsePosInt(value, def, max) {
  const n = value == null ? Number(def) : Number(value);
  if (!Number.isInteger(n) || n < 1) throw badRequest('page/limit params must be positive integers');
  return max ? Math.min(n, max) : n;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}
function notFound(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}
function httpError(status, apiCode, message) {
  const err = new Error(message);
  err.statusCode = status;
  err.apiCode = apiCode;
  return err;
}

/**
 * Per-key sliding-window limiter that records EVERY call (write budget —
 * different from the login limiter, which counts failures only).
 * State is per-process (same MVP posture as the login limiter).
 */
function createWindowLimiter({ limit = 30, windowMs = 60_000, now = () => Date.now() } = {}) {
  const buckets = new Map();
  return {
    /** @returns {{allowed:boolean, retryAfterMs:number}} (records the call) */
    take(key) {
      const t = now();
      const b = buckets.get(key);
      if (!b || t >= b.resetAt) {
        buckets.set(key, { resetAt: t + windowMs, calls: [{ t }] });
        return { allowed: true, retryAfterMs: 0 };
      }
      if (b.calls.length > limit) b.calls = b.calls.filter((c) => t - c.t < windowMs);
      const inWindow = b.calls.filter((c) => t - c.t < windowMs).length;
      if (inWindow >= limit) {
        return { allowed: false, retryAfterMs: Math.max(1, b.calls[0].t + windowMs - t) };
      }
      b.calls.push({ t });
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}

/** public identity shape — metadata is scrubbed (MD §13.3: no secrets out). */
function publicIdentity(i) {
  return {
    id: i.id,
    externalRef: i.externalRef ?? null,
    displayName: i.displayName ?? null,
    identityType: i.identityType ?? null,
    status: i.status,
    dataPath: i.dataPath ?? null,
    metadata: scrubObject(i.metadataJson ?? null, 1_000),
    createdAt: i.createdAt ?? null,
    updatedAt: i.updatedAt ?? null,
  };
}

/** public event shape — payloadJson ALWAYS scrubbed on read (MD §13.3). */
function publicEvent(e) {
  return {
    id: e.id,
    eventType: e.eventType,
    message: e.message ?? null,
    payload: scrubObject(e.payloadJson ?? null, 1_000),
    createdAt: e.createdAt ?? null,
  };
}

function publicBatch(b) {
  return {
    id: b.id,
    name: b.name,
    cycleId: b.cycleId,
    batchNo: b.batchNo,
    status: b.status,
    batchSize: b.batchSize,
    maxActiveContainers: b.maxActiveContainers,
    failurePolicy: b.failurePolicy,
    config: b.configJson ?? {},
    startedAt: b.startedAt ?? null,
    finishedAt: b.finishedAt ?? null,
    createdAt: b.createdAt ?? null,
    updatedAt: b.updatedAt ?? null,
  };
}

/** 409 for task-runs that are not batch runs (points at the legacy route). */
function assertBatchRun(run, op) {
  if (!run?.batchId) {
    throw httpError(
      409,
      'NOT_A_BATCH_RUN',
      `This ${op} route is for batch runs only — use /api/tasks/runs/${run?.id ?? '<id>'}/* for non-batch (AI/adhoc) runs`,
    );
  }
}

// --------------------------------------------------------------------------
// Route factory
// --------------------------------------------------------------------------

export function batchRoutes(app) {
  const db = app.db;
  // The batch routes need the B2 tables. The real Prisma schema always has
  // them; pre-B2 test fakes (makeFakeDb) don't — skip registration there
  // rather than fail every buildApp-based test that never touches batches.
  if (!db?.identity || !db?.batch || !db?.batchIdentity || !db?.resourceLease) {
    app.log?.warn?.('batch routes not registered: db lacks B2 delegates (pre-B2 fake)');
    return;
  }
  const queue = app.taskQueue;
  const cfg = app.config;
  const log = app.log;

  // --- services (DB-backed; the worker runs the loop, NOT the API) ---------
  const batchSvc = createBatchService({ db, log });
  const leaseSvc = createLeaseService({ db });
  const taskSvc = createTaskRunService({
    db,
    config: {
      taskDefaultTimeoutMs: cfg.taskDefaultTimeoutMs,
      taskMaxTimeoutMs: cfg.taskMaxTimeoutMs,
      taskDefaultAttempts: cfg.taskDefaultAttempts,
    },
    log,
    // Batch-aware enqueue seam: a retried BATCH run re-enters the queue as a
    // `batch-run` job; non-batch runs take the original task path.
    enqueue: async ({ runId, attempt }) => {
      const run = await db.taskRun.findUnique({ where: { id: runId } });
      await enqueueAnyRun(queue, { db, runId, attempt, timeoutMs: run?.inputJson?.timeoutMs, run });
    },
  });
  const scheduler = createBatchScheduler({
    db,
    batchSvc,
    leaseSvc,
    taskSvc,
    queue,
    log,
    // The API never runs reconcile passes; if one ever did, treat unknown
    // adapters as side-effectful (isolate, never auto re-run — fail closed).
    inspectEffects: async () => ({ sideEffects: true }),
  });

  // --- per-user write budgets (MD §13.2) ------------------------------------
  const writeLimiter = createWindowLimiter({ limit: 30, windowMs: 60_000 });
  const retryLimiter = createWindowLimiter({ limit: 10, windowMs: 60_000 });

  function rateGuard(limiter, req, reply, what) {
    const key = req.user?.id ?? req.ip ?? 'anon';
    const res = limiter.take(key);
    if (!res.allowed) {
      const secs = Math.max(1, Math.ceil(res.retryAfterMs / 1000));
      reply.header('retry-after', String(secs));
      throw httpError(429, API_ERROR.RATE_LIMITED, `Too many ${what} — retry after ${secs}s`);
    }
  }

  const audit = (req, action, extra = {}) =>
    app.audit({
      actorUserId: req.user?.id ?? null,
      action,
      resourceType: extra.resourceType ?? null,
      resourceId: extra.resourceId ?? null,
      requestId: req.id,
      ip: req.ip,
      status: extra.status ?? 'success',
      details: extra.details ?? null,
    });

  // --------------------------------------------------------------- identities
  app.get(
    '/api/identities',
    {
      preHandler: app.requireRole('viewer'),
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', maxLength: 32 },
            page: { type: 'string', pattern: POSINT_RE },
            pageSize: { type: 'string', pattern: POSINT_RE },
          },
        },
      },
    },
    async (req) => {
      const q = req.query;
      const where = q.status ? { status: q.status } : {};
      const page = parsePosInt(q.page, 1);
      const pageSize = parsePosInt(q.pageSize, 50, 200);
      const [items, total, counts] = await Promise.all([
        db.identity.findMany({ where, orderBy: { createdAt: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }),
        db.identity.count({ where }),
        db.identity.groupBy({ by: ['status'], _count: { _all: true } }),
      ]);
      return {
        items: items.map(publicIdentity),
        page,
        pageSize,
        total,
        statusCounts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
      };
    },
  );

  // ------------------------------------------------------------------ preview
  app.post(
    '/api/batches/preview',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['identities', 'batchSize', 'maxActiveContainers', 'failurePolicy'],
          properties: {
            identities: { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'string', pattern: UUID_RE.source } },
            batchSize: { type: 'integer', minimum: 1, maximum: 1000 },
            maxActiveContainers: { type: 'integer', minimum: 1, maximum: 100 },
            failurePolicy: { type: 'string', enum: ['stop_batch', 'continue_and_report'] },
            config: { type: 'object' },
          },
        },
      },
    },
    async (req) => {
      const body = req.body;
      const ids = [...new Set(body.identities)];
      const found = await db.identity.findMany({ where: { id: { in: ids } } });
      const foundIds = new Set(found.map((i) => i.id));
      const unknown = ids.filter((id) => !foundIds.has(id));

      // Order = operator's input order (binding order); unknown ids ride
      // along as SKIPPED so the plan is a faithful preview of the create.
      const rows = ids.map((id) => {
        const i = found.find((f) => f.id === id);
        return { id, status: i?.status ?? 'UNKNOWN' };
      });
      const plan = batchSvc.previewCycle({ identities: rows, batchSize: body.batchSize });

      // Resource estimate (MD §10: 資源估算) — containers are the unit of
      // cost; per-batch peak = min(batchSize, caps), total included.
      const { cap: globalCap } = await scheduler.readGlobalMaxActive(db);
      const fakeBatch = { maxActiveContainers: body.maxActiveContainers };
      const perBatchPeak = effectiveSlotCap(fakeBatch, globalCap);
      const included = plan.stats.included;
      const estBatches = Math.max(1, Math.ceil(included / body.batchSize));

      return {
        preview: true,
        plan,
        unknown,
        estimate: {
          identitiesTotal: plan.stats.total,
          identitiesIncluded: included,
          identitiesSkipped: plan.stats.skipped,
          batchesPlanned: estBatches,
          peakActiveContainersPerBatch: perBatchPeak,
          // sequential cycle: total container-hours ∝ included × runtime;
          // peak CONCURRENT across the whole cycle = perBatchPeak.
          peakConcurrentContainers: perBatchPeak,
        },
        capacity: {
          batchCap: body.maxActiveContainers,
          globalCap,
          effectiveCap: perBatchPeak,
        },
        networkPolicy: {
          // B4 gate is always active (SSRF classification); the allowlist
          // narrows targets when configured (MD §5.1).
          allowlistConfigured: Boolean(process.env.QA_ENDPOINT_ALLOWLIST || process.env.QA_ENDPOINT_ALLOWLIST_INTERNAL),
          note: 'The B4 network gate (fail-closed) applies to every batch run at dispatch time (taskType=batch).',
        },
      };
    },
  );

  // ------------------------------------------------------------------- create
  app.post(
    '/api/batches',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'idempotencyKey', 'identities', 'batchSize', 'maxActiveContainers', 'failurePolicy'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 128 },
            idempotencyKey: { type: 'string', minLength: 8, maxLength: 64, pattern: '^[A-Za-z0-9_-]{8,64}$' },
            identities: { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'string', pattern: UUID_RE.source } },
            batchSize: { type: 'integer', minimum: 1, maximum: 1000 },
            maxActiveContainers: { type: 'integer', minimum: 1, maximum: 100 },
            failurePolicy: { type: 'string', enum: ['stop_batch', 'continue_and_report'] },
            config: { type: 'object' },
          },
        },
      },
    },
    async (req, reply) => {
      rateGuard(writeLimiter, req, reply, 'batch writes');
      const body = req.body;
      const res = await batchSvc.createCycle(
        {
          name: body.name,
          idempotencyKey: body.idempotencyKey,
          identities: body.identities.map((id) => ({ id })),
          batchSize: body.batchSize,
          maxActiveContainers: body.maxActiveContainers,
          failurePolicy: body.failurePolicy,
          config: body.config ?? {},
        },
        { id: req.user.id, username: req.user.username },
      );
      await audit(req, 'batch.cycle_create', {
        resourceType: 'batch_cycle',
        resourceId: res.cycleId,
        details: { replay: res.replay, batchCount: res.batches.length, idempotencyKey: body.idempotencyKey },
      });
      return reply.code(res.replay ? 200 : 201).send(res);
    },
  );

  // ----------------------------------------------------------------- capacity
  const CAP_KEY = APP_SETTING_BATCH_GLOBAL_MAX_ACTIVE;

  app.get(
    '/api/batches/capacity',
    { preHandler: app.requireRole('admin') },
    async (req) => {
      const { cap } = await scheduler.readGlobalMaxActive(db);
      return {
        globalCap: cap,
        key: CAP_KEY,
        formula: 'effective = min(batch.maxActiveContainers, globalCap ?? ∞)',
        note: cap === null ? 'No global cap — each batch is bounded only by its own maxActiveContainers.' : `Global cap active: ${cap} concurrent batch containers fleet-wide.`,
      };
    },
  );

  app.post(
    '/api/batches/capacity',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['maxActiveContainers'],
          properties: { maxActiveContainers: { type: ['integer', 'null'], minimum: 1, maximum: 1000 } },
        },
      },
    },
    async (req) => {
      const value = req.body.maxActiveContainers;
      if (value === null) {
        await db.appSetting.deleteMany({ where: { key: CAP_KEY } });
      } else {
        const existed = await db.appSetting.findUnique({ where: { key: CAP_KEY } });
        if (existed) {
          await db.appSetting.update({ where: { key: CAP_KEY }, data: { valueJson: { value }, updatedBy: req.user.id } });
        } else {
          await db.appSetting.create({ data: { key: CAP_KEY, valueJson: { value }, updatedBy: req.user.id } });
        }
      }
      await audit(req, 'batch.capacity_set', {
        resourceType: 'app_setting',
        resourceId: CAP_KEY,
        details: { value },
      });
      const { cap } = await scheduler.readGlobalMaxActive(db);
      return { globalCap: cap, key: CAP_KEY };
    },
  );

  // ------------------------------------------------------------------- detail
  app.get(
    '/api/batches/:id',
    {
      preHandler: app.requireRole('viewer'),
      schema: {
        params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: UUID_RE.source } } },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { runsLimit: { type: 'string', pattern: POSINT_RE } },
        },
      },
    },
    async (req) => {
      const batch = await db.batch.findUnique({ where: { id: req.params.id } });
      if (!batch) throw notFound(`batch ${req.params.id} not found`);
      const runsLimit = parsePosInt(req.query.runsLimit, 100, 500);
      const [members, runs, { cap: globalCap }] = await Promise.all([
        db.batchIdentity.findMany({ where: { batchId: batch.id }, orderBy: { position: 'asc' } }),
        db.taskRun.findMany({ where: { batchId: batch.id }, orderBy: { createdAt: 'desc' }, take: runsLimit }),
        scheduler.readGlobalMaxActive(db),
      ]);
      const identityIds = members.map((m) => m.identityId);
      const identities = identityIds.length ? await db.identity.findMany({ where: { id: { in: identityIds } } }) : [];
      const byId = new Map(identities.map((i) => [i.id, i]));

      const membershipCounts = {};
      for (const m of members) membershipCounts[m.status] = (membershipCounts[m.status] ?? 0) + 1;
      const runCounts = {};
      for (const r of runs) runCounts[r.status] = (runCounts[r.status] ?? 0) + 1;
      const activeRuns = runs.filter((r) => r.status === 'running').length;

      // Per-identity: latest run (runs are desc by createdAt; first seen wins).
      const latestRunByIdentity = new Map();
      for (const r of runs) {
        if (r.identityId && !latestRunByIdentity.has(r.identityId)) latestRunByIdentity.set(r.identityId, r);
      }

      return {
        batch: publicBatch(batch),
        capacity: {
          batchCap: batch.maxActiveContainers,
          globalCap,
          effectiveCap: effectiveSlotCap(batch, globalCap),
        },
        activeCount: activeRuns,
        stats: {
          memberships: membershipCounts,
          runs: runCounts,
          totals: { members: members.length, runs: runs.length },
        },
        identities: members.map((m) => {
          const id = byId.get(m.identityId);
          const lr = latestRunByIdentity.get(m.identityId);
          return {
            position: m.position,
            identityId: m.identityId,
            displayName: id?.displayName ?? null,
            identityStatus: id?.status ?? 'UNKNOWN',
            membershipStatus: m.status,
            skipReason: m.skipReason ?? null,
            latestRun: lr ? { id: lr.id, status: lr.status, attempt: lr.attempt, errorCode: lr.errorCode ?? null, finishedAt: lr.finishedAt ?? null } : null,
          };
        }),
        runs: runs.slice(0, 50).map((r) => ({
          id: r.id,
          identityId: r.identityId ?? null,
          status: r.status,
          attempt: r.attempt,
          errorCode: r.errorCode ?? null,
          queuedAt: r.queuedAt ?? null,
          startedAt: r.startedAt ?? null,
          finishedAt: r.finishedAt ?? null,
        })),
      };
    },
  );

  // ---------------------------------------------------------------- lifecycle
  async function lifecycle(op, batchId, actor, body = {}) {
    const batch = await db.batch.findUnique({ where: { id: batchId } });
    if (!batch) throw notFound(`batch ${batchId} not found`);
    const res = await scheduler[op]({ batchId, actor, ...body });
    const fresh = res.batch ?? (await db.batch.findUnique({ where: { id: batchId } }));
    return { batch: publicBatch(fresh), res };
  }

  app.post(
    '/api/batches/:id/start',
    {
      preHandler: app.requireRole('operator'),
      schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: UUID_RE.source } } } },
    },
    async (req, reply) => {
      rateGuard(writeLimiter, req, reply, 'batch writes');
      const { batch, res } = await lifecycle('startBatch', req.params.id, req.user.id);
      await audit(req, 'batch.start', { resourceType: 'batch', resourceId: req.params.id, details: { started: res.started, reason: res.reason ?? null } });
      return reply.code(res.started ? 202 : 200).send({
        batch, started: res.started, reason: res.reason ?? null,
        dispatch: { dispatched: res.dispatched ?? 0, reused: res.reused ?? 0, skipped: res.skipped ?? 0 },
      });
    },
  );

  app.post(
    '/api/batches/:id/pause',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: UUID_RE.source } } },
        body: { type: 'object', additionalProperties: false, properties: { stopExisting: { type: 'boolean', default: false } } },
      },
    },
    async (req, reply) => {
      rateGuard(writeLimiter, req, reply, 'batch writes');
      const { batch, res } = await lifecycle('pauseBatch', req.params.id, req.user.id, { stopExisting: req.body?.stopExisting ?? false });
      await audit(req, 'batch.pause', { resourceType: 'batch', resourceId: req.params.id, details: { stopExisting: res.stopExisting, cancelledQueued: res.cancelledQueued, requested: res.requested } });
      return reply.code(202).send({ batch, stopExisting: res.stopExisting, cancelledQueued: res.cancelledQueued, requested: res.requested });
    },
  );

  app.post(
    '/api/batches/:id/resume',
    {
      preHandler: app.requireRole('operator'),
      schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: UUID_RE.source } } } },
    },
    async (req, reply) => {
      rateGuard(writeLimiter, req, reply, 'batch writes');
      const { batch, res } = await lifecycle('resumeBatch', req.params.id, req.user.id);
      await audit(req, 'batch.resume', { resourceType: 'batch', resourceId: req.params.id, details: { dispatched: res.dispatched ?? 0, reused: res.reused ?? 0 } });
      return reply.code(202).send({ batch, dispatch: { dispatched: res.dispatched ?? 0, reused: res.reused ?? 0, skipped: res.skipped ?? 0 } });
    },
  );

  app.post(
    '/api/batches/:id/cancel',
    {
      preHandler: app.requireRole('operator'),
      schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: UUID_RE.source } } } },
    },
    async (req, reply) => {
      rateGuard(writeLimiter, req, reply, 'batch writes');
      const { batch, res } = await lifecycle('cancelBatch', req.params.id, req.user.id);
      await audit(req, 'batch.cancel', { resourceType: 'batch', resourceId: req.params.id, details: { immediate: res.immediate, requested: res.requested ?? 0, cancelledQueued: res.cancelledQueued ?? 0 } });
      // 202: RUNNING batches converge via the worker's finalizer (CANCELLING→CANCELLED).
      return reply.code(res.immediate ? 200 : 202).send({ batch, immediate: res.immediate, requested: res.requested ?? 0, cancelledQueued: res.cancelledQueued ?? 0 });
    },
  );

  // ------------------------------------------------------- task-run (batch) ops
  const RUN_PARAMS = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: UUID_RE.source } } };

  app.post(
    '/api/task-runs/:id/retry',
    { preHandler: app.requireRole('operator'), schema: { params: RUN_PARAMS } },
    async (req, reply) => {
      rateGuard(retryLimiter, req, reply, 'task-run retries');
      const run = await db.taskRun.findUnique({ where: { id: req.params.id } });
      if (!run) throw notFound(`task run ${req.params.id} not found`);
      assertBatchRun(run, 'retry');
      const { run: fresh, attempt } = await taskSvc.requestRetry(run.id, { actorUserId: req.user.id, note: 'user retry (batch)' });
      await audit(req, 'task_retry', { resourceType: 'task_run', resourceId: run.id, details: { attempt, batchId: run.batchId } });
      return { taskRun: { id: fresh.id, status: fresh.status, attempt: fresh.attempt, batchId: fresh.batchId }, attempt };
    },
  );

  app.post(
    '/api/task-runs/:id/cancel',
    { preHandler: app.requireRole('operator'), schema: { params: RUN_PARAMS } },
    async (req, reply) => {
      rateGuard(writeLimiter, req, reply, 'task-run cancels');
      const run = await db.taskRun.findUnique({ where: { id: req.params.id } });
      if (!run) throw notFound(`task run ${req.params.id} not found`);
      assertBatchRun(run, 'cancel');
      const { run: fresh, idempotent } = await taskSvc.requestCancel(run.id, { actorUserId: req.user.id, reason: 'user cancel (batch)' });
      // Best-effort: drop the waiting job now (the engine's DB poll is the
      // real stop for in-flight work — same posture as the legacy route).
      const jobRemoved = await removeWaitingBatchRun(queue, run.id, run.attempt).catch(() => false);
      await audit(req, 'task_cancel', { resourceType: 'task_run', resourceId: run.id, details: { status: fresh.status, idempotent, jobRemoved, batchId: run.batchId } });
      return { taskRun: { id: fresh.id, status: fresh.status, attempt: fresh.attempt, batchId: fresh.batchId }, idempotent, jobRemoved };
    },
  );

  app.get(
    '/api/task-runs/:id/logs',
    {
      preHandler: app.requireRole('viewer'),
      schema: {
        params: RUN_PARAMS,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            after: { type: 'string' }, // event cursor (event id)
            limit: { type: 'string', pattern: POSINT_RE },
          },
        },
      },
    },
    async (req) => {
      const run = await db.taskRun.findUnique({ where: { id: req.params.id } });
      if (!run) throw notFound(`task run ${req.params.id} not found`);
      assertBatchRun(run, 'logs');
      const limit = parsePosInt(req.query.limit, 100, 500);
      const where = { taskRunId: run.id };
      let items;
      if (req.query.after) {
        // Cursor: (createdAt > c) OR (createdAt = c AND id > after) — stable
        // under concurrent appends (same pattern as the SSE replay path).
        const prev = await db.taskRunEvent.findUnique({ where: { id: req.query.after } });
        if (!prev || prev.taskRunId !== run.id) throw badRequest(`cursor '${req.query.after}' is not an event of this run`);
        where.OR = [
          { createdAt: { gt: prev.createdAt } },
          { createdAt: prev.createdAt, id: { gt: prev.id } },
        ];
      }
      items = await db.taskRunEvent.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limit + 1 });
      const hasMore = items.length > limit;
      if (hasMore) items = items.slice(0, limit);
      return {
        runId: run.id,
        items: items.map(publicEvent),
        nextCursor: hasMore ? items[items.length - 1].id : null,
        hasMore,
      };
    },
  );
}
