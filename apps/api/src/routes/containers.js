/**
 * Container routes (施工 MD §8 容器段 + §9 + §13.2).
 * Routes only talk to DockerService (MD §9: dockerode stays inside the
 * service). RBAC: viewer = read (list/inspect/logs/stats/events),
 * operator = state ops + create-from-template, admin = delete + exceptions.
 * Managed gate (MD §11.2): only app.managed=true containers (or
 * admin-granted exceptions) may be mutated — else 403 NOT_MANAGED.
 * Every mutation is audited (MD §7/§13.3 — env VALUES never reach audit).
 */
import { isManaged, DockerServiceError } from '../services/docker-service.js';

const CONTAINER_ID = { type: 'string', minLength: 1, maxLength: 191 };

const LIST_QUERY = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      state: { type: 'string', maxLength: 64 },
      managed: { type: 'string', enum: ['true', 'false'] },
      q: { type: 'string', maxLength: 100 },
      page: { type: 'integer', minimum: 1, default: 1 },
      pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      withStats: { type: 'boolean', default: false },
    },
  },
};

const LOGS_QUERY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tail: { type: 'integer', minimum: 1, maximum: 5000 },
    since: { type: 'string', maxLength: 64 },
  },
};

const DELETE_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['confirm'],
  properties: {
    confirm: { type: 'string', minLength: 1, maxLength: 200 },
    removeVolumes: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  },
};

const EXCEPTION_BODY = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      containerId: { type: 'string', minLength: 4, maxLength: 191 },
      name: { type: 'string', minLength: 1, maxLength: 200 },
      note: { type: 'string', maxLength: 200 },
    },
  },
};

const CREATE_BODY = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['templateId', 'name', 'idempotencyKey'],
    properties: {
      templateId: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,39}$' },
      name: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$' },
      ports: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['containerPort', 'hostPort'],
          properties: {
            containerPort: { type: 'integer', minimum: 1, maximum: 65535 },
            hostPort: { type: 'integer', minimum: 1, maximum: 65535 },
            protocol: { type: 'string', enum: ['tcp', 'udp'], default: 'tcp' },
          },
        },
      },
      env: {
        type: 'object',
        maxProperties: 50,
        patternProperties: {
          '^[A-Za-z_][A-Za-z0-9_]{0,127}$': { type: 'string', maxLength: 2048 },
        },
        additionalProperties: false,
      },
      command: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 512 } },
      idempotencyKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' },
    },
  },
};

const EVENT_ACTIONS = new Set([
  'create', 'start', 'die', 'stop', 'pause', 'unpause', 'kill',
  'rename', 'destroy', 'health_status', 'update', 'oom',
]);

function parseSince(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
  throw new DockerServiceError({ code: 'VALIDATION_ERROR', status: 400, message: 'since must be unix seconds or an ISO timestamp' });
}

export function containerRoutes(app) {
  const svc = () => app.dockerService;

  // ------------------------------------------------------------------ list
  app.get(
    '/api/containers',
    { preHandler: app.requireRole('viewer'), schema: LIST_QUERY },
    async (req) => {
      return svc().listContainers(req.query);
    },
  );

  // ------------------------------------------------------- events (SSE)
  app.get(
    '/api/containers/events',
    { preHandler: app.requireRole('viewer'), schema: { querystring: { type: 'object', additionalProperties: false, properties: { since: { type: 'string', maxLength: 64 } } } } },
    async (req, reply) => {
      // Open BEFORE hijack: failure flows through the normal error handler.
      const opened = await svc().openEventStream({ since: parseSince(req.query.since) });
      const raw = reply.raw;
      reply.hijack();

      raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      raw.write('retry: 3000\n\n');

      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            continue; // torn line — skip, never crash the stream
          }
          if (ev?.Type !== 'container' || !EVENT_ACTIONS.has(ev?.Action)) continue; // §9.4 只轉送必要事件
          const payload = {
            action: ev.Action,
            id: ev.Actor?.ID ?? null,
            name: ev.Actor?.Attributes?.name ?? null,
            image: ev.Actor?.Attributes?.image ?? null,
            timestamp: ev.timestamp ?? null,
          };
          if (!raw.writableEnded) raw.write(`event: container\ndata: ${JSON.stringify(payload)}\n\n`);
        }
      };
      opened.stream.on('data', onData);

      const hb = setInterval(() => {
        if (!raw.writableEnded) raw.write(`:hb ${Date.now()}\n\n`);
      }, app.config.dockerSseHeartbeatMs ?? 25000);
      req.log.info({ userId: req.user?.id, active: app.dockerService.sseStats().active }, 'sse client connected');

      // MD §9.4: 斷線時釋放 Docker event stream（+計數+log 證據）。
      req.raw.on('close', () => {
        clearInterval(hb);
        opened.release();
        req.log.info({ userId: req.user?.id, active: app.dockerService.sseStats().active }, 'sse client disconnected — docker event stream released');
      });
    },
  );

  // ---------------------------------------------------- managed exceptions
  app.get(
    '/api/containers/exceptions',
    { preHandler: app.requireRole('admin') },
    async (req) => {
      const entries = await svc().listExceptions();
      return { exceptions: Object.entries(entries).map(([key, v]) => ({ key, ...v })) };
    },
  );

  app.post(
    '/api/containers/exceptions',
    { preHandler: app.requireRole('admin'), schema: EXCEPTION_BODY },
    async (req, reply) => {
      const { containerId, name, note } = req.body;
      if (!containerId && !name) {
        return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Provide containerId or name', requestId: req.id } });
      }
      // Resolve against the daemon when possible (404 = honest error).
      let resolvedId = containerId ?? null;
      let resolvedName = name ?? null;
      try {
        const summary = await svc().inspectSummary(containerId || name);
        resolvedId = summary.id;
        resolvedName = summary.name;
      } catch (err) {
        if (!(err instanceof DockerServiceError && err.apiCode === 'CONTAINER_NOT_FOUND' && name)) {
          throw err;
        }
        // No daemon id — grant by name only (explicitly allowed, noted).
      }
      const grant = await svc().grantException({ containerId: resolvedId, name: resolvedName, note }, {
        actorUserId: req.user.id,
        requestId: req.id,
        ip: req.ip,
      });
      return reply.code(201).send({ exception: grant });
    },
  );

  app.delete(
    '/api/containers/exceptions/:key',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      await svc().revokeException(req.params.key, { actorUserId: req.user.id, requestId: req.id, ip: req.ip });
      return reply.code(204).send();
    },
  );

  // ------------------------------------------------------ create (template)
  app.post(
    '/api/containers',
    { preHandler: app.requireRole('operator'), schema: CREATE_BODY },
    async (req, reply) => {
      const { container, replay } = await svc().createContainerFromTemplate(req.body, {
        actorUserId: req.user.id,
        requestId: req.id,
        ip: req.ip,
      });
      if (replay) reply.header('idempotent-replay', 'true');
      return reply.code(201).send({ container });
    },
  );

  // --------------------------------------------------------------- reads
  app.get(
    '/api/containers/:id',
    { preHandler: app.requireRole('viewer'), schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: CONTAINER_ID } } } },
    async (req) => {
      const summary = await svc().inspectSummary(req.params.id);
      const exceptions = await svc().listExceptions();
      const managed = isManaged({ labels: summary.labels, containerId: summary.id, name: summary.name, exceptions });
      return { ...summary, managed, managedByException: managed.byException };
    },
  );

  app.get(
    '/api/containers/:id/logs',
    { preHandler: app.requireRole('viewer'), schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: CONTAINER_ID } }, querystring: LOGS_QUERY } },
    async (req) => {
      return svc().getLogs(req.params.id, { tail: req.query.tail, since: req.query.since });
    },
  );

  app.get(
    '/api/containers/:id/stats',
    { preHandler: app.requireRole('viewer'), schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: CONTAINER_ID } } } },
    async (req) => {
      const stats = await svc().getStats(req.params.id);
      return { container: req.params.id, stats };
    },
  );

  // ------------------------------------------------------ state mutations
  const MUTATIONS = ['start', 'stop', 'restart', 'pause', 'unpause'];

  for (const action of MUTATIONS) {
    app.post(
      `/api/containers/:id/${action}`,
      { preHandler: app.requireRole('operator'), schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: CONTAINER_ID } } } },
      async (req, reply) => {
        const { id } = req.params;
        const before = await svc().inspectSummary(id); // 404/503/502 classified here
        const exceptions = await svc().listExceptions();
        const managed = isManaged({ labels: before.labels, containerId: before.id, name: before.name, exceptions });

        const auditBase = {
          actorUserId: req.user.id,
          action: `container.${action}`,
          resourceType: 'container',
          resourceId: before.id,
          requestId: req.id,
          ip: req.ip,
        };

        if (!managed.managed) {
          await app.audit({ ...auditBase, status: 'failure', details: { name: before.name, reason: 'not_managed' } });
          return reply.code(403).send({
            error: {
              code: 'NOT_MANAGED',
              message: `Container '${before.name}' is not app-managed (no app.managed label) — modify it via the host, or grant an admin exception`,
              requestId: req.id,
            },
          });
        }

        try {
          const result = await svc().runAction(before.id, action);
          await app.audit({
            ...auditBase,
            status: 'success',
            details: { name: result.name, from: before.state.status, to: result.state, idempotent: result.idempotent, byException: managed.byException },
          });
          return { ...result, byException: managed.byException };
        } catch (err) {
          await app.audit({ ...auditBase, status: 'failure', details: { name: before.name, code: err.apiCode ?? 'UNKNOWN' } });
          throw err;
        }
      },
    );
  }

  // ---------------------------------------------------------------- delete
  app.delete(
    '/api/containers/:id',
    { preHandler: app.requireRole('admin'), schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: CONTAINER_ID } }, body: DELETE_BODY } },
    async (req, reply) => {
      const { id } = req.params;
      const { confirm, removeVolumes, force } = req.body;
      const before = await svc().inspectSummary(id);
      const exceptions = await svc().listExceptions();
      const managed = isManaged({ labels: before.labels, containerId: before.id, name: before.name, exceptions });

      const auditBase = {
        actorUserId: req.user.id,
        action: 'container.delete',
        resourceType: 'container',
        resourceId: before.id,
        requestId: req.id,
        ip: req.ip,
      };

      if (!managed.managed) {
        await app.audit({ ...auditBase, status: 'failure', details: { name: before.name, reason: 'not_managed' } });
        return reply.code(403).send({
          error: { code: 'NOT_MANAGED', message: `Container '${before.name}' is not app-managed — cannot delete via the app`, requestId: req.id },
        });
      }

      try {
        const result = await svc().deleteContainer(before.id, { confirm, removeVolumes, force });
        await app.audit({
          ...auditBase,
          status: 'success',
          details: { name: result.name, removeVolumes: result.removeVolumes, bindsPreserved: result.bindsPreserved, byException: managed.byException },
        });
        return { ...result, byException: managed.byException };
      } catch (err) {
        await app.audit({ ...auditBase, status: 'failure', details: { name: before.name, code: err.apiCode ?? 'UNKNOWN' } });
        throw err;
      }
    },
  );
}
