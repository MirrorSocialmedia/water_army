/**
 * Redroid template routes (工單 P5 / 施工 MD §7 Templates-Redroid).
 *
 * RBAC (P3 ADR §12.9 口徑): reads = viewer+; writes = admin ONLY
 * (privileged 只可存在於專用 Redroid Template，建/改 template 係 admin 權).
 *
 * Image pinning is enforced twice: the schema allows any explicit reference,
 * the service validates pinned-tag/digest (no latest/nightly/untagged).
 */

const ID_PARAM = {
  params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 64 } } },
};

const TEMPLATE_BODY = {
  type: 'object',
  additionalProperties: false, // NO raw Docker fields — template fields only
  required: ['name', 'image', 'androidVersion'],
  properties: {
    name: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,39}$' },
    image: { type: 'string', minLength: 3, maxLength: 255 },
    androidVersion: { type: 'string', pattern: '^\\d{1,2}$' },
    width: { type: 'integer', minimum: 160, maximum: 8192, default: 1080 },
    height: { type: 'integer', minimum: 160, maximum: 8192, default: 1920 },
    dpi: { type: 'integer', minimum: 100, maximum: 1200, default: 440 },
    fps: { type: 'integer', minimum: 1, maximum: 120, default: 30 },
    gpuMode: { type: 'string', enum: ['swiftshader_indirect', 'host'], default: 'swiftshader_indirect' },
    privileged: { type: 'boolean', default: false },
    privilegedReason: { type: 'string', minLength: 10, maxLength: 200 },
    isEnabled: { type: 'boolean', default: true },
    // Stage B: optional fleet egress proxy. socks5://[user:pass@]host:port only.
    // Encrypted at rest by the service; the response never echoes the URL.
    proxyUrl: { type: ['string', 'null'], maxLength: 512 },
  },
};

const TEMPLATE_PATCH_BODY = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: { ...TEMPLATE_BODY.properties },
};

export function redroidTemplateRoutes(app) {
  // Preflight — the real (or mock-labelled) host check, MD §10.1.
  app.get(
    '/api/redroid/preflight',
    {
      preHandler: app.requireRole('viewer'),
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          // querystring values arrive as strings (app ajv: coerceTypes false)
          properties: {
            gpu: { type: 'string', enum: ['true', 'false'] },
            port: { type: 'string', pattern: '^[1-9][0-9]{0,4}$' },
          },
        },
      },
    },
    async (req) => {
      const { gpu, port } = req.query;
      return app.redroidService.getPreflight({ gpuMode: gpu === 'true', port: port ? Number(port) : null });
    },
  );

  app.get('/api/redroid/templates', { preHandler: app.requireRole('viewer') }, async () => {
    return { templates: await app.redroidService.listTemplates() };
  });

  app.post('/api/redroid/templates', { preHandler: app.requireRole('admin'), schema: { body: TEMPLATE_BODY } }, async (req, reply) => {
    const template = await app.redroidService.createTemplate(req.body, { actorUserId: req.user.id, requestId: req.id, ip: req.ip });
    return reply.code(201).send({ template });
  });

  app.put('/api/redroid/templates/:id', { preHandler: app.requireRole('admin'), schema: { ...ID_PARAM, body: TEMPLATE_PATCH_BODY } }, async (req) => {
    const template = await app.redroidService.updateTemplate(req.params.id, req.body, { actorUserId: req.user.id, requestId: req.id, ip: req.ip });
    return { template };
  });

  app.delete('/api/redroid/templates/:id', { preHandler: app.requireRole('admin'), schema: ID_PARAM }, async (req) => {
    return app.redroidService.deleteTemplate(req.params.id, { actorUserId: req.user.id, requestId: req.id, ip: req.ip });
  });
}
