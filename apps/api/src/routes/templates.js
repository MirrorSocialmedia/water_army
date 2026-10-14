/**
 * Template routes (施工 MD §8: GET/POST /api/templates).
 * Templates are the container-create allowlist (MD §9.2): they pin the
 * image, resource limits, ports, volumes, network and env keys. Admin-only
 * write (RBAC §13.2); reads are allowed for all authenticated roles.
 * The POST body is a schema-validated template object — upsert by id.
 */

const TEMPLATE_SCHEMA = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'displayName', 'image'],
    properties: {
      id: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,39}$' },
      displayName: { type: 'string', minLength: 1, maxLength: 60 },
      image: { type: 'string', minLength: 3, maxLength: 255 },
      cpuLimit: { type: 'number', exclusiveMinimum: 0, maximum: 128 },
      memoryLimitBytes: { type: 'integer', minimum: 8 * 1024 * 1024, maximum: 512 * 1024 * 1024 * 1024 },
      ports: {
        type: 'array',
        maxItems: 32,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['containerPort'],
          properties: {
            containerPort: { type: 'integer', minimum: 1, maximum: 65535 },
            protocol: { type: 'string', enum: ['tcp', 'udp'], default: 'tcp' },
            hostPortMin: { type: 'integer', minimum: 1, maximum: 65535, default: 1 },
            hostPortMax: { type: 'integer', minimum: 1, maximum: 65535, default: 65535 },
          },
        },
      },
      allowedEnvKeys: {
        type: 'array',
        maxItems: 100,
        items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]{0,127}$' },
      },
      command: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 512 } },
      allowCommandOverride: { type: 'boolean', default: false },
      volumes: {
        type: 'array',
        maxItems: 32,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['containerPath'],
          properties: {
            containerPath: { type: 'string', pattern: '^/' },
            type: { type: 'string', enum: ['volume', 'bind'], default: 'volume' },
            name: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}$' },
            hostPath: { type: 'string', pattern: '^/' },
            readOnly: { type: 'boolean', default: false },
          },
        },
      },
      allowedHostPaths: { type: 'array', maxItems: 32, items: { type: 'string', pattern: '^/' } },
      network: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$', default: 'bridge' },
      privileged: { type: 'boolean', default: false },
      privilegedReason: { type: 'string', minLength: 10, maxLength: 200 },
    },
  },
};

export function templateRoutes(app) {
  app.get('/api/templates', { preHandler: app.requireRole('viewer') }, async () => {
    const templates = await app.dockerService.listTemplates();
    return { templates };
  });

  app.post(
    '/api/templates',
    { preHandler: app.requireRole('admin'), schema: TEMPLATE_SCHEMA },
    async (req, reply) => {
      const { template, created } = await app.dockerService.upsertTemplate(req.body, {
        actorUserId: req.user.id,
        requestId: req.id,
        ip: req.ip,
      });
      return reply.code(created ? 201 : 200).send({ template, created });
    },
  );
}
