/**
 * Redroid device routes (工單 P5 / 施工 MD §7).
 *
 *  - POST /api/devices/redroid — create STRICTLY from a template. The body
 *    has NO Docker HostConfig / privileged / image / port-bind fields —
 *    the only client inputs are name + templateName + display-geometry
 *    overrides + idempotency key (MD §7 硬規則).
 *  - ADB is published on 127.0.0.1 ONLY (server-side constant; there is no
 *    request field that can change the bind address — 0.0.0.0 attempts
 *    fail schema validation, 工單 硬驗收 3).
 *  - RBAC (P3 ADR §12.9): reads = viewer+; create/start/stop/restart/refresh
 *    = operator+; delete = admin (two-step confirm).
 *  - Audit: every mutation is audited in the service (workorder 審計要求).
 *  - NO arbitrary-command endpoint exists: diagnostics is a whitelist op
 *    (commit 4); `POST /exec` is 404 by construction.
 */

const DEVICE_ID = { type: 'string', minLength: 1, maxLength: 64 };

const CREATE_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'templateName', 'idempotencyKey'],
  properties: {
    name: { type: 'string', pattern: '^redroid-[a-z0-9][a-z0-9_-]{0,39}$' },
    templateName: { type: 'string', minLength: 1, maxLength: 40 },
    // The ONLY override scope: display geometry (工單: template 允許嘅字段).
    // image / gpuMode / privileged / ports / bind — intentionally NOT here.
    overrides: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', minimum: 160, maximum: 8192 },
        height: { type: 'integer', minimum: 160, maximum: 8192 },
        dpi: { type: 'integer', minimum: 100, maximum: 1200 },
        fps: { type: 'integer', minimum: 1, maximum: 120 },
      },
    },
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 64, pattern: '^[a-zA-Z0-9_-]+$' },
  },
};

const DELETE_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['confirm'],
  properties: {
    confirm: { type: 'string', minLength: 1, maxLength: 64 },
    removeData: { type: 'boolean', default: false },
  },
};

const LIST_QUERY = {
  type: 'object',
  additionalProperties: false,
  properties: { template: { type: 'string', minLength: 1, maxLength: 40 } },
};

export function redroidDeviceRoutes(app) {
  app.get('/api/devices/redroid', { preHandler: app.requireRole('viewer'), schema: { querystring: LIST_QUERY } }, async (req) => {
    return { devices: await app.redroidService.listDevices({ templateName: req.query.template }) };
  });

  app.post(
    '/api/devices/redroid',
    { preHandler: app.requireRole('operator'), schema: { body: CREATE_BODY } },
    async (req, reply) => {
      const { device, replay, startError, preflight } = await app.redroidService.createDevice(req.body, {
        actorUserId: req.user.id,
        requestId: req.id,
        ip: req.ip,
      });
      return reply.code(replay ? 200 : 201).send({ device, replay, startError: startError ?? null, preflight: preflight ?? null });
    },
  );

  app.get(
    '/api/devices/redroid/:id',
    { preHandler: app.requireRole('viewer'), schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: DEVICE_ID } } } },
    async (req) => {
      return { device: await app.redroidService.getDeviceView(req.params.id, { withDataDir: true }) };
    },
  );

  for (const action of ['start', 'stop', 'restart']) {
    app.post(
      `/api/devices/redroid/:id/${action}`,
      { preHandler: app.requireRole('operator'), schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: DEVICE_ID } } } },
      async (req) => {
        const { device, idempotent } = await app.redroidService.runDeviceAction(req.params.id, action, {
          actorUserId: req.user.id,
          requestId: req.id,
          ip: req.ip,
        });
        return { device, idempotent, action };
      },
    );
  }

  app.post(
    '/api/devices/redroid/:id/refresh',
    { preHandler: app.requireRole('operator'), schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: DEVICE_ID } } } },
    async (req) => {
      const { device, adbNote } = await app.redroidService.refreshDevice(req.params.id, {
        actorUserId: req.user.id,
        requestId: req.id,
        ip: req.ip,
      });
      return { device, adbNote: adbNote ?? null };
    },
  );

  app.post(
    '/api/devices/redroid/:id/diagnostics',
    { preHandler: app.requireRole('operator'), schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: DEVICE_ID } } } },
    async (req) => {
      return app.redroidService.diagnoseDevice(req.params.id, {
        actorUserId: req.user.id,
        requestId: req.id,
        ip: req.ip,
      });
    },
  );

  app.get(
    '/api/devices/redroid/:id/logcat',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: DEVICE_ID } },
        // querystring values arrive as strings (app ajv: coerceTypes false);
        // the numeric cap is enforced server-side in the service (single source).
        querystring: { type: 'object', additionalProperties: false, properties: { tail: { type: 'string', pattern: '^[1-9][0-9]*$' } } },
      },
    },
    async (req) => {
      const tail = req.query.tail !== undefined ? Number(req.query.tail) : undefined;
      return app.redroidService.getLogcat(req.params.id, {
        tail,
        actorUserId: req.user.id,
        requestId: req.id,
        ip: req.ip,
      });
    },
  );

  app.delete(
    '/api/devices/redroid/:id',
    { preHandler: app.requireRole('admin'), schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: DEVICE_ID } }, body: DELETE_BODY } },
    async (req) => {
      return app.redroidService.deleteDevice(req.params.id, {
        confirm: req.body.confirm,
        removeData: req.body.removeData,
        actorUserId: req.user.id,
        requestId: req.id,
        ip: req.ip,
      });
    },
  );
}
