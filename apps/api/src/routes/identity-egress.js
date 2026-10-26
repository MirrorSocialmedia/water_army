/**
 * W3 (ADR-027) — identity egress binding routes.
 *
 *  - GET    /api/identities/egress            viewer+  → fleet binding list
 *  - GET    /api/identities/:id/egress        viewer+  → one binding (or null)
 *  - PUT    /api/identities/:id/egress        admin    → create/update (idempotent)
 *  - DELETE /api/identities/:id/egress        admin    → remove (resets devices)
 *
 * The binding is the per-identity PINNED egress (pinned proxy + the one exit
 * IP). RBAC mirrors the fingerprint surface: reads = viewer+, writes = admin
 * (a binding changes what exit IP an identity is allowed to use — the same
 * authority class as a fingerprint profile or a redroid template).
 *
 * ZERO-CREDENTIAL contract (ADR-027 §5): every response is the service's
 * bindingView — expected IP + a short hash prefix + timestamps + bound-device
 * count. The proxy URL is NEVER returned, logged, or audited.
 *
 * Switch discipline (W1 lesson): the whole surface fails closed 503
 * EGRESS_BINDING_DISABLED until WA_W3_EGRESS_BINDING_ENABLED is on. With the
 * switch off, W3 is byte-identical inert — no configuration surface either.
 */

const IDENTITY_ID = {
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
};

const PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: IDENTITY_ID },
};

const PUT_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['proxyUrl', 'expectedEgressIp'],
  properties: {
    // The pinned egress proxy (credentials included — validated, encrypted,
    // stored; never echoed back). Scheme host:port form.
    proxyUrl: { type: 'string', minLength: 8, maxLength: 2048 },
    // The ONE exit IP this identity may exit from (DB-unique fleet-wide).
    expectedEgressIp: { type: 'string', minLength: 7, maxLength: 15 },
  },
};

const actorOf = (req) => ({ actorUserId: req.user.id, requestId: req.id, ip: req.ip });

/** Fail-closed switch guard (503 until WA_W3_EGRESS_BINDING_ENABLED — ADR-027). */
function requireEgressEnabled(app, req, reply) {
  if (app.config?.egressBindingEnabled !== true) {
    reply.code(503).send({
      error: { code: 'EGRESS_BINDING_DISABLED', message: 'identity egress binding (W3) is disabled on this host — set WA_W3_EGRESS_BINDING_ENABLED=true after reviewing ADR-027 (real-device matrix NOT VERIFIED)' },
    });
    return false;
  }
  return true;
}

export function identityEgressRoutes(app) {
  // Static route first (fastify matches static above parametric — keep the
  // literal 'egress' segment from being eaten by :id).
  app.get(
    '/api/identities/egress',
    { preHandler: app.requireRole('viewer') },
    async (req, reply) => {
      if (!requireEgressEnabled(app, req, reply)) return undefined;
      return app.identityEgressService.listBindings();
    },
  );

  app.get(
    '/api/identities/:id/egress',
    { preHandler: app.requireRole('viewer'), schema: PARAMS },
    async (req, reply) => {
      if (!requireEgressEnabled(app, req, reply)) return undefined;
      return { binding: await app.identityEgressService.getBinding(req.params.id) };
    },
  );

  app.put(
    '/api/identities/:id/egress',
    { preHandler: app.requireRole('admin'), schema: { params: PARAMS, body: PUT_BODY } },
    async (req, reply) => {
      if (!requireEgressEnabled(app, req, reply)) return undefined;
      const binding = await app.identityEgressService.upsertBinding(req.params.id, req.body, actorOf(req));
      return { binding };
    },
  );

  app.delete(
    '/api/identities/:id/egress',
    { preHandler: app.requireRole('admin'), schema: PARAMS },
    async (req, reply) => {
      if (!requireEgressEnabled(app, req, reply)) return undefined;
      return app.identityEgressService.deleteBinding(req.params.id, actorOf(req));
    },
  );
}
