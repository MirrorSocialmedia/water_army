/**
 * AI tasks / runs / approvals / tools / providers / audit routes (施工 MD §8).
 *
 *  - POST /api/tasks/runs                202 + runId (never waits for the model)
 *  - GET  /api/tasks/runs                list + status/provider filter + paging
 *  - GET  /api/tasks/runs/:runId         detail + events + approvals
 *  - POST /api/tasks/runs/:runId/cancel  (idempotent)
 *  - POST /api/tasks/runs/:runId/retry   (new attempt — old output preserved)
 *  - GET  /api/tasks/runs/:runId/events  SSE (snapshot + replay + live poll)
 *  - GET  /api/tools                     registry metadata (never handlers)
 *  - GET  /api/approvals                 pending/recent approvals
 *  - POST /api/approvals/:id/approve     (admin + real human only)
 *  - POST /api/approvals/:id/reject      (admin + real human only)
 *  - GET/POST/PATCH /api/providers       (secrets write-only, never returned)
 *  - POST /api/providers/:name/test      (admin live ping, classified errors)
 *  - GET  /api/audit-events              (admin; from/to/action/actor filters)
 *
 * RBAC: viewer < operator < admin. The service identity (worker→API token)
 * can call viewer/operator routes but is REFUSED on approvals (no self-approve).
 */
import {
  TOOL_REGISTRY,
  P3_TOOL_NAMES,
  scrubObject,
  resolveProviderKey,
  encryptSecret,
  decryptSecret,
  createTaskRunService,
  ProviderError,
} from '@water-army/shared';

import { enqueueTaskRun, removeWaitingTaskRun } from '../plugins/task-queue.js';
import { requireHuman } from '../security/service-auth.js';

// --------------------------------------------------------------------------
// DTOs
// --------------------------------------------------------------------------

/** Public run shape. `full` adds prompt/output (detail view). */
function publicRun(run, { full = false } = {}) {
  const input = run.inputJson ?? {};
  const base = {
    id: run.id,
    status: run.status,
    attempt: run.attempt,
    provider: input.provider ?? null,
    title: input.title ?? null,
    mode: input.mode ?? null,
    promptPreview: typeof input.prompt === 'string' ? input.prompt.slice(0, 200) : null,
    tools: input.tools ?? null,
    timeoutMs: input.timeoutMs ?? null,
    maxAttempts: input.maxAttempts ?? null,
    errorCode: run.errorCode ?? null,
    errorMessage: run.errorMessage ?? null,
    queuedAt: run.queuedAt ?? null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    durationMs: run.durationMs ?? null,
    requestedBy: run.requestedBy ?? null,
    createdAt: run.createdAt ?? null,
    updatedAt: run.updatedAt ?? null,
  };
  if (full) {
    base.prompt = typeof input.prompt === 'string' ? input.prompt : null;
    base.resultText = run.resultText ?? null;
    base.resultJson = run.resultJson ?? null;
    base.idempotencyKey = run.idempotencyKey ?? null;
  }
  return base;
}

function publicEvent(e) {
  return {
    id: e.id,
    eventType: e.eventType,
    message: e.message ?? null,
    payload: e.payloadJson ?? null,
    createdAt: e.createdAt ?? null,
  };
}

function publicApproval(a) {
  return {
    id: a.id,
    taskRunId: a.taskRunId,
    toolName: a.toolName,
    arguments: a.argumentsJson ?? null,
    status: a.status,
    requestedAt: a.requestedAt ?? null,
    reviewedBy: a.reviewedBy ?? null,
    reviewedAt: a.reviewedAt ?? null,
    reviewNote: a.reviewNote ?? null,
  };
}

/** Provider row → public shape (secret never leaves; hasApiKey only). */
function publicProvider(p) {
  return {
    id: p.id,
    name: p.name,
    providerType: p.providerType,
    baseUrl: p.baseUrl,
    modelId: p.modelId ?? null,
    hasApiKey: Boolean(p.encryptedApiKey),
    timeoutMs: p.timeoutMs ?? null,
    isEnabled: p.isEnabled ?? true,
    createdAt: p.createdAt ?? null,
    updatedAt: p.updatedAt ?? null,
  };
}

// --------------------------------------------------------------------------
// Schemas
// --------------------------------------------------------------------------

const RUN_ID_PARAM = {
  type: 'object',
  additionalProperties: false,
  properties: { runId: { type: 'string', minLength: 8, maxLength: 64 } },
};
const APPROVAL_ID_PARAM = {
  type: 'object',
  additionalProperties: false,
  properties: { id: { type: 'string', minLength: 4, maxLength: 64 } },
};
const NAME_PARAM = {
  type: 'object',
  additionalProperties: false,
  properties: { name: { type: 'string', minLength: 2, maxLength: 64 } },
};

const CREATE_RUN_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', minLength: 1, maxLength: 20_000 },
    provider: { type: 'string', minLength: 1, maxLength: 64 },
    tools: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 128 },
      maxItems: 20,
      uniqueItems: true,
    },
    timeoutMs: { type: 'integer', minimum: 1_000 },
    maxAttempts: { type: 'integer', minimum: 1, maximum: 5 },
    mode: { type: 'string', enum: ['analysis_only', 'approved_tools'] },
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 128 },
    title: { type: 'string', minLength: 1, maxLength: 200 },
  },
};

const LIST_QUERY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', maxLength: 32 },
    provider: { type: 'string', maxLength: 64 },
    page: { type: 'string', pattern: '^[0-9]+$' },
    pageSize: { type: 'string', pattern: '^[0-9]+$' },
  },
};

const SSE_QUERY = {
  type: 'object',
  additionalProperties: false,
  properties: { after: { type: 'string', maxLength: 64 } },
};

const APPROVALS_QUERY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'expired', 'all'] },
    runId: { type: 'string', maxLength: 64 },
    page: { type: 'string', pattern: '^[0-9]+$' },
    pageSize: { type: 'string', pattern: '^[0-9]+$' },
  },
};

const REVIEW_BODY = {
  type: 'object',
  additionalProperties: false,
  properties: { note: { type: 'string', maxLength: 500 } },
};

const PROVIDER_BODY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 64, pattern: '^[a-z0-9][a-z0-9_-]*$' },
    baseUrl: { type: 'string', minLength: 8, maxLength: 512, pattern: '^https?://' },
    modelId: { type: 'string', minLength: 1, maxLength: 128 },
    apiKey: { type: 'string', minLength: 1, maxLength: 512 },
    timeoutMs: { type: 'integer', minimum: 1_000, maximum: 900_000 },
    isEnabled: { type: 'boolean' },
  },
};

const AUDIT_QUERY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'string', maxLength: 64 },
    to: { type: 'string', maxLength: 64 },
    action: { type: 'string', maxLength: 64 },
    actor: { type: 'string', maxLength: 64 },
    page: { type: 'string', pattern: '^[0-9]+$' },
    pageSize: { type: 'string', pattern: '^[0-9]+$' },
  },
};

const RUN_STATUSES = ['queued', 'running', 'needs_approval', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'timed_out', 'skipped'];

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.apiCode = 'VALIDATION_ERROR';
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.statusCode = 404;
  err.apiCode = 'NOT_FOUND';
  return err;
}

function httpError(status, apiCode, message) {
  const err = new Error(message);
  err.statusCode = status;
  err.apiCode = apiCode;
  return err;
}

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{taskQueue?: import('bullmq').Queue}} deps API-side BullMQ Queue (or fake)
 */
export function taskRoutes(app, deps = {}) {
  const db = () => app.db;
  const config = () => app.config;
  const queue = () => deps.taskQueue ?? app.taskQueue;

  // TaskRunService per app (the API is the ONLY enqueuer; the worker builds
  // its own instance without an enqueue callback).
  const taskSvc = createTaskRunService({
    db: db(),
    config: {
      taskDefaultTimeoutMs: config().taskDefaultTimeoutMs,
      taskMaxTimeoutMs: config().taskMaxTimeoutMs,
      taskDefaultAttempts: config().taskDefaultAttempts,
    },
    log: app.log,
    enqueue: async (job) => {
      const run = await db().taskRun.findUnique({ where: { id: job.runId } });
      await enqueueTaskRun(queue(), { runId: job.runId, attempt: job.attempt, timeoutMs: run?.inputJson?.timeoutMs });
    },
  });

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

  // ------------------------------------------------------------------ create
  app.post(
    '/api/tasks/runs',
    { preHandler: app.requireRole('operator'), schema: { body: CREATE_RUN_BODY } },
    async (req, reply) => {
      const body = req.body;
      // Provider: body wins, else AI_PROVIDER env default. Fail closed — an
      // unknown provider name must never silently downgrade to mock.
      const provider = body.provider ?? config().aiProvider ?? null;
      if (!provider) throw badRequest('provider is required (set body.provider or the AI_PROVIDER env)');
      if (provider !== 'mock') {
        const pc = await db().providerConfig.findUnique({ where: { name: provider } });
        if (!pc || !pc.isEnabled) throw httpError(400, 'PROVIDER_NOT_FOUND', `provider '${provider}' is not configured or disabled`);
      }
      if (Array.isArray(body.tools) && body.tools.length) {
        const unknown = body.tools.filter((t) => !P3_TOOL_NAMES.includes(t));
        if (unknown.length) throw badRequest(`unknown tools: ${unknown.join(', ')}`);
      }
      if (typeof body.timeoutMs === 'number' && body.timeoutMs > config().taskMaxTimeoutMs) {
        throw badRequest(`timeoutMs exceeds system cap ${config().taskMaxTimeoutMs}ms`);
      }

      const { run, replay } = await taskSvc.createRun(
        {
          prompt: body.prompt,
          provider,
          tools: body.tools ?? null,
          timeoutMs: body.timeoutMs,
          maxAttempts: body.maxAttempts,
          mode: body.mode,
          idempotencyKey: body.idempotencyKey,
          title: body.title,
        },
        { id: req.user.id, username: req.user.username },
      );
      await audit(req, 'task.create', {
        resourceType: 'task_run',
        resourceId: run.id,
        details: { provider, replay, promptChars: body.prompt.length, tools: body.tools ?? null },
      });
      // MD §8: 提交後立即 202 + runId — 唔可以等模型完成先回 response.
      return reply.code(202).send({ taskRun: publicRun(run, { full: true }), replay });
    },
  );

  // -------------------------------------------------------------------- list
  app.get(
    '/api/tasks/runs',
    { preHandler: app.requireRole('viewer'), schema: { querystring: LIST_QUERY } },
    async (req) => {
      const q = req.query;
      const page = Math.max(1, Number(q.page ?? 1));
      const pageSize = Math.min(100, Math.max(1, Number(q.pageSize ?? 20)));
      const where = {};
      if (q.status) {
        if (!RUN_STATUSES.includes(q.status)) throw badRequest(`invalid status filter '${q.status}'`);
        where.status = q.status;
      }
      const found = await db().taskRun.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize });
      // provider lives inside inputJson (JSONB) — the row set is small (ops
      // UI), so filter in JS after the DB query.
      const items = q.provider ? found.filter((r) => (r.inputJson?.provider ?? null) === q.provider) : found;
      return { items: items.map((r) => publicRun(r)), page, pageSize, total: items.length };
    },
  );

  // ------------------------------------------------------------------ detail
  app.get(
    '/api/tasks/runs/:runId',
    { preHandler: app.requireRole('viewer'), schema: { params: RUN_ID_PARAM } },
    async (req) => {
      const run = await db().taskRun.findUnique({ where: { id: req.params.runId } });
      if (!run) throw notFound(`task run ${req.params.runId} not found`);
      const [events, approvals] = await Promise.all([
        db().taskRunEvent.findMany({ where: { taskRunId: run.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 500 }),
        db().approvalRequest.findMany({ where: { taskRunId: run.id } }),
      ]);
      return { run: publicRun(run, { full: true }), events: events.map(publicEvent), approvals: approvals.map(publicApproval) };
    },
  );

  // ------------------------------------------------------------------ cancel
  app.post(
    '/api/tasks/runs/:runId/cancel',
    { preHandler: app.requireRole('operator'), schema: { params: RUN_ID_PARAM } },
    async (req) => {
      const { run, idempotent } = await taskSvc.requestCancel(req.params.runId, {
        actorUserId: req.user.id,
        reason: 'user cancel',
      });
      // Best-effort: if the job is still waiting in the queue, drop it now.
      // The engine's DB cancel poll is the REAL stop for in-flight work.
      const jobRemoved = await removeWaitingTaskRun(queue(), run.id, run.attempt);
      await audit(req, 'task.cancel', {
        resourceType: 'task_run',
        resourceId: run.id,
        details: { status: run.status, idempotent, jobRemoved },
      });
      return { taskRun: publicRun(run), idempotent, jobRemoved };
    },
  );

  // ------------------------------------------------------------------ retry
  app.post(
    '/api/tasks/runs/:runId/retry',
    { preHandler: app.requireRole('operator'), schema: { params: RUN_ID_PARAM } },
    async (req) => {
      const { run, attempt } = await taskSvc.requestRetry(req.params.runId, { actorUserId: req.user.id, note: 'user retry' });
      await audit(req, 'task.retry', {
        resourceType: 'task_run',
        resourceId: run.id,
        details: { attempt },
      });
      return { taskRun: publicRun(run), attempt };
    },
  );

  // ------------------------------------------------------------- SSE events
  app.get(
    '/api/tasks/runs/:runId/events',
    { preHandler: app.requireRole('viewer'), schema: { params: RUN_ID_PARAM, querystring: SSE_QUERY } },
    async (req, reply) => {
      const dbh = db();
      const run = await dbh.taskRun.findUnique({ where: { id: req.params.runId } });
      if (!run) throw notFound(`task run ${req.params.runId} not found`);

      // Concurrency cap (MD §9.4 pattern): fail loudly, never queue up.
      const cap = config().taskSseMaxConcurrent ?? 10;
      if (app.taskSseActive >= cap) throw httpError(503, 'RATE_LIMITED', 'SSE concurrency limit reached');

      // Resume point: ?after=<eventId> (Last-Event-Id equivalent).
      let afterEvent = null;
      if (req.query.after) {
        // Validate BEFORE Prisma: task_run_events.id is a Postgres uuid column,
        // so a malformed cursor must be a 400, not a P2007 → 500 (live catch).
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.query.after)) {
          throw badRequest('after must be a task event id (uuid)');
        }
        const afterRows = await dbh.taskRunEvent.findMany({ where: { taskRunId: run.id, id: req.query.after } });
        afterEvent = afterRows.length ? afterRows[0] : null;
        if (!afterEvent) throw badRequest('after event not found for this run');
      }

      const openedAt = Date.now();
      const raw = reply.raw;
      reply.hijack();
      app.taskSseActive += 1;
      raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      raw.write('retry: 1500\n\n');

      let torn = false;
      let pollTimer = null;
      let hbTimer = null;
      const teardown = (why) => {
        if (torn) return;
        torn = true;
        clearInterval(pollTimer);
        clearInterval(hbTimer);
        app.taskSseActive = Math.max(0, app.taskSseActive - 1);
        if (!raw.writableEnded) raw.end();
        app.log.info({ runId: run.id, ms: Date.now() - openedAt, why }, 'task sse client disconnected');
      };
      req.raw.on('close', () => teardown('client close'));
      raw.on('close', () => teardown('socket close'));
      raw.on('finish', () => teardown('finished'));

      const send = (event, data, id) => {
        if (raw.writableEnded || torn) return false;
        try {
          if (id) raw.write(`id: ${id}\n`);
          raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          return true;
        } catch {
          teardown('write error');
          return false;
        }
      };

      // 1) snapshot — a reconnecting client re-syncs even without a cursor.
      if (!send('run_snapshot', publicRun(run, { full: true }), null)) return;

      // 2) replay everything after the cursor (or everything, bounded 500).
      let lastSentAt = afterEvent ? new Date(afterEvent.createdAt) : null;
      let lastSentId = afterEvent ? afterEvent.id : null;
      const sentIds = new Set(afterEvent ? [afterEvent.id] : []);

      const fetchSince = async () =>
        dbh.taskRunEvent.findMany({
          where: afterEvent
            ? {
                taskRunId: run.id,
                OR: [
                  { createdAt: { gt: lastSentAt } },
                  { createdAt: { equals: lastSentAt }, id: { gt: lastSentId } },
                ],
              }
            : { taskRunId: run.id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 500,
        });

      const deliver = async (rows) => {
        for (const e of rows) {
          if (sentIds.has(e.id)) continue;
          if (!send(e.eventType, publicEvent(e), e.id)) return false;
          sentIds.add(e.id);
          lastSentAt = new Date(e.createdAt);
          lastSentId = e.id;
        }
        return true;
      };

      try {
        await deliver(await fetchSince());
      } catch {
        teardown('replay error');
        return;
      }

      // 3) live poll until terminal + its terminal event delivered (or gone).
      const pollMs = config().taskSsePollMs ?? 1_000;
      pollTimer = setInterval(async () => {
        if (torn) return;
        let fresh;
        try {
          fresh = await fetchSince();
        } catch {
          app.log.warn({ runId: run.id }, 'task sse poll failed (will retry)');
          return;
        }
        if (fresh.length && !(await deliver(fresh))) return;
        let current = null;
        try {
          current = await dbh.taskRun.findUnique({ where: { id: run.id }, select: { status: true } });
        } catch {
          return;
        }
        if (current && ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(current.status)) {
          send('done', { status: current.status }, null);
          teardown('terminal');
        }
      }, pollMs);

      hbTimer = setInterval(() => {
        if (!raw.writableEnded) raw.write(`:hb ${Date.now()}\n\n`);
      }, config().taskSseHeartbeatMs ?? 25_000);

      app.log.info({ runId: run.id, active: app.taskSseActive, after: req.query.after ?? null }, 'task sse client connected');
    },
  );

  // ------------------------------------------------------------------- tools
  app.get(
    '/api/tools',
    { preHandler: app.requireRole('viewer') },
    async () => ({
      tools: TOOL_REGISTRY.map((t) => ({
        name: t.name,
        description: t.description,
        safetyClass: t.safetyClass,
        parameters: t.parameters,
      })),
    }),
  );

  // ---------------------------------------------------------------- approvals
  app.get(
    '/api/approvals',
    { preHandler: app.requireRole('viewer'), schema: { querystring: APPROVALS_QUERY } },
    async (req) => {
      const q = req.query;
      const page = Math.max(1, Number(q.page ?? 1));
      const pageSize = Math.min(100, Math.max(1, Number(q.pageSize ?? 20)));
      const where = {};
      if (q.status && q.status !== 'all') where.status = q.status;
      if (q.runId) where.taskRunId = q.runId;
      const all = await db().approvalRequest.findMany({ where });
      // Approval volumes are small; sort in JS (requestedAt desc) and page.
      all.sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : a.requestedAt > b.requestedAt ? -1 : 0));
      const items = all.slice((page - 1) * pageSize, page * pageSize);
      return { items: items.map(publicApproval), page, pageSize, total: all.length };
    },
  );

  const reviewRoute = (decision) => async (req, reply) => {
    const human = requireHuman(req, reply);
    if (human) return human;
    const updated = await taskSvc.resolveApproval(req.params.id, {
      decision,
      actorUserId: req.user.id,
      note: req.body?.note ?? null,
    });
    await audit(req, decision === 'approved' ? 'approval.approve' : 'approval.reject', {
      resourceType: 'approval',
      resourceId: updated.id,
      details: { runId: updated.taskRunId, tool: updated.toolName, note: req.body?.note ?? null },
    });
    return { approval: publicApproval(updated) };
  };
  app.post('/api/approvals/:id/approve', { preHandler: app.requireRole('admin'), schema: { params: APPROVAL_ID_PARAM, body: REVIEW_BODY } }, reviewRoute('approved'));
  app.post('/api/approvals/:id/reject', { preHandler: app.requireRole('admin'), schema: { params: APPROVAL_ID_PARAM, body: REVIEW_BODY } }, reviewRoute('rejected'));

  // ---------------------------------------------------------------- providers
  app.get(
    '/api/providers',
    { preHandler: app.requireRole('admin') },
    async () => ({ providers: (await db().providerConfig.findMany()).map(publicProvider) }),
  );

  app.post(
    '/api/providers',
    { preHandler: app.requireRole('admin'), schema: { body: { ...PROVIDER_BODY, required: ['name', 'baseUrl'] } } },
    async (req) => {
      const b = req.body;
      const key = resolveProviderKey(config().encryptionKey);
      let row;
      try {
        row = await db().providerConfig.create({
          data: {
            name: b.name,
            providerType: 'openai_compatible',
            baseUrl: b.baseUrl,
            modelId: b.modelId ?? null,
            encryptedApiKey: b.apiKey ? encryptSecret(b.apiKey, key) : null,
            timeoutMs: b.timeoutMs ?? 120_000,
            isEnabled: b.isEnabled ?? true,
          },
        });
      } catch (err) {
        if (err?.code === 'P2002') throw httpError(409, 'PROVIDER_NAME_TAKEN', `provider '${b.name}' already exists`);
        throw err;
      }
      await audit(req, 'provider.create', {
        resourceType: 'provider',
        resourceId: row.id,
        details: { name: b.name, model: b.modelId ?? null, hasKey: Boolean(b.apiKey) },
      });
      return { provider: publicProvider(row) };
    },
  );

  app.patch(
    '/api/providers/:name',
    { preHandler: app.requireRole('admin'), schema: { params: NAME_PARAM, body: { ...PROVIDER_BODY } } },
    async (req) => {
      const existing = await db().providerConfig.findUnique({ where: { name: req.params.name } });
      if (!existing) throw notFound(`provider '${req.params.name}' not found`);
      const b = req.body;
      const changes = [];
      const data = {};
      if (b.baseUrl !== undefined) {
        data.baseUrl = b.baseUrl;
        changes.push('baseUrl');
      }
      if (b.modelId !== undefined) {
        data.modelId = b.modelId;
        changes.push('modelId');
      }
      if (b.timeoutMs !== undefined) {
        data.timeoutMs = b.timeoutMs;
        changes.push('timeoutMs');
      }
      if (b.isEnabled !== undefined) {
        data.isEnabled = b.isEnabled;
        changes.push('isEnabled');
      }
      if (b.apiKey !== undefined) {
        data.encryptedApiKey = b.apiKey ? encryptSecret(b.apiKey, resolveProviderKey(config().encryptionKey)) : null;
        changes.push('apiKey(rotate)');
      }
      if (!changes.length) throw badRequest('no updatable fields provided');
      const row = await db().providerConfig.update({ where: { id: existing.id }, data });
      await audit(req, 'provider.update', {
        resourceType: 'provider',
        resourceId: row.id,
        details: { name: existing.name, changes },
      });
      return { provider: publicProvider(row), changes };
    },
  );

  // Live provider ping (admin, explicit, bounded): one small chat round with
  // classified errors — same error vocabulary the worker engine sees.
  app.post(
    '/api/providers/:name/test',
    { preHandler: app.requireRole('admin'), schema: { params: NAME_PARAM } },
    async (req) => {
      const pc = await db().providerConfig.findUnique({ where: { name: req.params.name } });
      if (!pc) throw notFound(`provider '${req.params.name}' not found`);
      let apiKey = '';
      if (pc.encryptedApiKey) {
        try {
          apiKey = decryptSecret(pc.encryptedApiKey, resolveProviderKey(config().encryptionKey));
        } catch {
          throw httpError(502, 'PROVIDER_NOT_CONFIGURED', "provider key cannot be decrypted (APP_ENCRYPTION_KEY mismatch?)");
        }
      }
      const result = await pingOpenAICompatible(pc, apiKey);
      await audit(req, 'provider.test', {
        resourceType: 'provider',
        resourceId: pc.id,
        status: result.ok ? 'success' : 'failure',
        details: { name: pc.name, code: result.ok ? null : result.code },
      });
      if (!result.ok) throw httpError(502, result.code, result.message);
      return result;
    },
  );

  // ------------------------------------------------------------------- audit
  app.get(
    '/api/audit-events',
    { preHandler: app.requireRole('admin'), schema: { querystring: AUDIT_QUERY } },
    async (req) => {
      const q = req.query;
      const page = Math.max(1, Number(q.page ?? 1));
      const pageSize = Math.min(100, Math.max(1, Number(q.pageSize ?? 20)));
      const where = {};
      if (q.from || q.to) {
        where.createdAt = {};
        if (q.from) where.createdAt.gte = new Date(q.from);
        if (q.to) where.createdAt.lte = new Date(q.to);
      }
      if (q.action) where.action = q.action;
      if (q.actor) where.actorUserId = q.actor;
      const [rows, total] = await Promise.all([
        db().auditEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
        db().auditEvent.count({ where }),
      ]);
      return {
        items: rows.map((a) => ({
          id: a.id,
          actorUserId: a.actorUserId ?? null,
          action: a.action,
          resourceType: a.resourceType ?? null,
          resourceId: a.resourceId ?? null,
          status: a.status ?? null,
          createdAt: a.createdAt ?? null,
          details: scrubObject(a.detailsJson ?? null, 2_000),
        })),
        page,
        pageSize,
        total,
      };
    },
  );
}

/**
 * Minimal OpenAI-compatible ping (no full provider dep in the API package):
 * one tiny completion, classified like the worker's ProviderError vocabulary.
 */
async function pingOpenAICompatible(pc, apiKey) {
  const url = `${pc.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: pc.modelId ?? 'default',
    messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
    max_tokens: 1,
    stream: false,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(pc.timeoutMs ?? 20_000, 20_000));
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    const timedOut = err?.name === 'AbortError';
    return { ok: false, code: timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK', message: timedOut ? 'provider ping timed out' : `cannot reach provider: ${err?.message ?? err}` };
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => '');
  if (res.status === 401 || res.status === 403) return { ok: false, code: 'PROVIDER_AUTH', message: `provider rejected credentials (HTTP ${res.status})` };
  if (res.status === 429) return { ok: false, code: 'PROVIDER_RATE_LIMITED', message: 'provider rate-limited the ping (HTTP 429)' };
  if (res.status >= 500) return { ok: false, code: 'PROVIDER_SERVER_ERROR', message: `provider error (HTTP ${res.status})` };
  if (res.status === 404) return { ok: false, code: 'PROVIDER_NOT_FOUND', message: 'model/endpoint not found (HTTP 404)' };
  if (res.status >= 400) return { ok: false, code: 'PROVIDER_BAD_REQUEST', message: `provider rejected the request (HTTP ${res.status})` };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, code: 'PROVIDER_INVALID_RESPONSE', message: 'provider returned non-JSON' };
  }
  const choice = data?.choices?.[0];
  if (!choice?.message) return { ok: false, code: 'PROVIDER_INVALID_RESPONSE', message: 'provider response missing choices[0].message' };
  return {
    ok: true,
    model: typeof data.model === 'string' ? data.model : pc.modelId ?? null,
    finishReason: choice.finish_reason ?? null,
    usage: data.usage
      ? { promptTokens: data.usage.prompt_tokens ?? 0, completionTokens: data.usage.completion_tokens ?? 0 }
      : null,
  };
}
