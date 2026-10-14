/**
 * Schedules routes (施工 MD §8 Schedules + §6.6).
 *
 *  - GET    /api/schedules            (viewer+)   list incl. next/last run + delay
 *  - POST   /api/schedules            (operator+) create — PG first, BullMQ after
 *  - GET    /api/schedules/:id        (viewer+)
 *  - PATCH  /api/schedules/:id        (operator+) modify — recompute next_run_at + re-upsert
 *  - POST   /api/schedules/:id/pause  (operator+)
 *  - POST   /api/schedules/:id/resume (operator+)
 *  - POST   /api/schedules/:id/run-now (operator+) manual fire (Idempotency-Key honoured)
 *  - POST   /api/schedules/:id/sync   (operator+) retry sync (heals sync_error)
 *  - DELETE /api/schedules/:id        (operator+)
 *  - POST   /api/schedules/preview    (viewer+)   backend-parsed next-run preview (MD §12.2)
 *
 * RBAC follows the P3 ADR §12.9 task-resource line: writes = operator+ (same
 * as POST /api/tasks/runs), reads = viewer+. Mutations are audited.
 */
import { createScheduleService, ScheduleError } from '../services/schedule-service.js';
import { createTaskRunService } from '@water-army/shared';
import { enqueueTaskRun } from '../plugins/task-queue.js';

const SCHEDULE_ID_PARAM = {
  type: 'object',
  additionalProperties: false,
  properties: { id: { type: 'string', minLength: 8, maxLength: 64 } },
};

const SCHEDULE_LIST_QUERY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: { type: 'string', enum: ['true', 'false'] },
    page: { type: 'string', pattern: '^[0-9]+$' },
    pageSize: { type: 'string', pattern: '^[0-9]+$' },
  },
};

const SCHEDULE_CREATE_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'taskDefinitionId', 'scheduleType'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    taskDefinitionId: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
    scheduleType: { type: 'string', enum: ['once', 'interval', 'cron'] },
    cronExpression: { type: 'string', minLength: 3, maxLength: 120 },
    intervalMs: { type: 'integer', minimum: 1 },
    runAt: { type: 'string', maxLength: 64 },
    timezone: { type: 'string', minLength: 1, maxLength: 64 },
    overlapPolicy: { type: 'string', enum: ['skip_if_running', 'queue'] },
    isEnabled: { type: 'boolean' },
  },
};

const SCHEDULE_UPDATE_BODY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    taskDefinitionId: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
    scheduleType: { type: 'string', enum: ['once', 'interval', 'cron'] },
    cronExpression: { type: 'string', minLength: 3, maxLength: 120 },
    intervalMs: { type: 'integer', minimum: 1 },
    runAt: { type: 'string', maxLength: 64 },
    timezone: { type: 'string', minLength: 1, maxLength: 64 },
    overlapPolicy: { type: 'string', enum: ['skip_if_running', 'queue'] },
  },
};

const SCHEDULE_PREVIEW_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['scheduleType'],
  properties: {
    scheduleType: { type: 'string', enum: ['once', 'interval', 'cron'] },
    cronExpression: { type: 'string', minLength: 3, maxLength: 120 },
    intervalMs: { type: 'integer', minimum: 1 },
    runAt: { type: 'string', maxLength: 64 },
    timezone: { type: 'string', minLength: 1, maxLength: 64 },
  },
};

const RUN_NOW_HEADERS = {
  type: 'object',
  additionalProperties: true,
  properties: { 'idempotency-key': { type: 'string', minLength: 8, maxLength: 64 } },
};

/**
 * @param {import('fastify').FastifyInstance} app
 */
export function scheduleRoutes(app) {
  const db = () => app.db;
  const config = () => app.config;

  // TaskRunService for run-now — same shape as tasks.js' instance (the API is
  // the queue's producer, so a manual fire enqueues exactly like any other
  // run). Built here (not shared) to keep P3's tasks.js untouched.
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
      await enqueueTaskRun(app.taskQueue, { runId: job.runId, attempt: job.attempt, timeoutMs: run?.inputJson?.timeoutMs });
    },
  });

  const svc = createScheduleService({
    db: db(),
    queue: app.taskQueue,
    config: {
      defaultTimezone: config().defaultTimezone,
      scheduleMinIntervalMs: config().scheduleMinIntervalMs,
      scheduleMaxIntervalMs: config().scheduleMaxIntervalMs,
    },
    log: app.log,
    taskSvc,
  });

  const audit = (req, action, resourceId, extra = {}) =>
    app.audit({
      actorUserId: req.user?.id ?? null,
      action,
      resourceType: 'schedule',
      resourceId: resourceId ?? null,
      requestId: req.id,
      ip: req.ip,
      status: extra.status ?? 'success',
      details: extra.details ?? null,
    });

  app.get(
    '/api/schedules',
    { preHandler: app.requireRole('viewer'), schema: { querystring: SCHEDULE_LIST_QUERY } },
    async (req) => {
      const page = Math.max(1, Number(req.query.page ?? 1));
      const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20)));
      const enabled = req.query.enabled === 'true' ? true : req.query.enabled === 'false' ? false : null;
      return svc.list({ page, pageSize, enabled });
    },
  );

  // MD §12.2: 預覽至少下一次執行時間 — 由後端解析（cron-parser，同 BullMQ 同庫）。
  app.post(
    '/api/schedules/preview',
    { preHandler: app.requireRole('viewer'), schema: { body: SCHEDULE_PREVIEW_BODY } },
    async (req) => svc.preview(req.body),
  );

  app.post(
    '/api/schedules',
    { preHandler: app.requireRole('operator'), schema: { body: SCHEDULE_CREATE_BODY } },
    async (req, reply) => {
      const { schedule } = await svc.create(req.body, { id: req.user.id, username: req.user.username });
      await audit(req, 'schedule.create', schedule.id, {
        details: { name: schedule.name, type: schedule.scheduleType, timezone: schedule.timezone, overlapPolicy: schedule.overlapPolicy },
      });
      // 201 even when sync_status=sync_error: the DB row exists (PG-first).
      // The client sees the flagged state and can POST /:id/sync to retry.
      return reply.code(201).send({ schedule });
    },
  );

  app.get(
    '/api/schedules/:id',
    { preHandler: app.requireRole('viewer'), schema: { params: SCHEDULE_ID_PARAM } },
    async (req) => ({ schedule: await svc.get(req.params.id) }),
  );

  app.patch(
    '/api/schedules/:id',
    { preHandler: app.requireRole('operator'), schema: { params: SCHEDULE_ID_PARAM, body: SCHEDULE_UPDATE_BODY } },
    async (req) => {
      const { schedule, changes } = await svc.update(req.params.id, req.body, { id: req.user.id, username: req.user.username });
      await audit(req, 'schedule.update', schedule.id, { details: { changes } });
      return { schedule, changes };
    },
  );

  app.post(
    '/api/schedules/:id/pause',
    { preHandler: app.requireRole('operator'), schema: { params: SCHEDULE_ID_PARAM } },
    async (req) => {
      const { schedule, changed } = await svc.pause(req.params.id, { id: req.user.id, username: req.user.username });
      if (changed) await audit(req, 'schedule.pause', schedule.id);
      return { schedule, changed };
    },
  );

  app.post(
    '/api/schedules/:id/resume',
    { preHandler: app.requireRole('operator'), schema: { params: SCHEDULE_ID_PARAM } },
    async (req) => {
      const { schedule, changed } = await svc.resume(req.params.id, { id: req.user.id, username: req.user.username });
      if (changed) await audit(req, 'schedule.resume', schedule.id);
      return { schedule, changed };
    },
  );

  app.post(
    '/api/schedules/:id/run-now',
    { preHandler: app.requireRole('operator'), schema: { params: SCHEDULE_ID_PARAM, headers: RUN_NOW_HEADERS } },
    async (req, reply) => {
      const { run, replay, schedule } = await svc.runNow(
        req.params.id,
        { id: req.user.id, username: req.user.username },
        { idempotencyKey: req.headers['idempotency-key'] ?? null },
      );
      await audit(req, 'schedule.run_now', schedule.id, {
        details: { runId: run.id, replay, status: run.status },
      });
      return reply.code(replay ? 200 : 202).send({ run, replay, schedule });
    },
  );

  app.post(
    '/api/schedules/:id/sync',
    { preHandler: app.requireRole('operator'), schema: { params: SCHEDULE_ID_PARAM } },
    async (req) => {
      const { schedule, healed } = await svc.sync(req.params.id, { id: req.user.id, username: req.user.username });
      await audit(req, 'schedule.sync', schedule.id, {
        status: healed ? 'success' : 'failure',
        details: { syncStatus: schedule.syncStatus },
      });
      if (!healed) {
        // The 503 envelope is enough for the client (it can re-GET the row);
        // keep the response shape identical to every other error here.
        throw new ScheduleError('SYNC_ERROR', 'BullMQ sync failed again — DB row is authoritative; retry later or check worker/redis', { status: 503 });
      }
      return { schedule, healed };
    },
  );

  app.delete(
    '/api/schedules/:id',
    { preHandler: app.requireRole('operator'), schema: { params: SCHEDULE_ID_PARAM } },
    async (req, reply) => {
      const { schedulerRemoved } = await svc.remove(req.params.id, { id: req.user.id, username: req.user.username });
      await audit(req, 'schedule.delete', req.params.id, { details: { schedulerRemoved } });
      return reply.code(204).send();
    },
  );
}
