/**
 * T2 (ADR-029) — identity login-state + provisioning routes.
 *
 *  - GET  /api/identities/provision?names=…      admin    → (handy) not provided; POST only
 *  - POST /api/identities/provision              admin    → batch-provision test identities (idempotent)
 *  - GET  /api/identities/:id/login              viewer+  → current login state
 *  - GET  /api/identities/:id/login/audit        viewer+  → transition audit (newest first)
 *  - POST /api/identities/:id/login/transition   operator+→ manual transition (the ONLY write path)
 *
 * RBAC rationale (mirrors the MD §12 class model):
 *  - reads = viewer+ (zero secrets — state + audit metadata only);
 *  - CONFIRMED_LOGGED_IN and every other transition require an operator+
 *    HUMAN session — this surface has no system/machine caller by design
 *    (no worker token may assert login truth; ADR-029);
 *  - provisioning (creates fleet rows + fingerprints) = admin, same class as
 *    PUT egress binding.
 *
 * Fail-closed when the T2 tables are absent (partial test fakes / pre-
 * migration schema): 503 LOGIN_STATE_DISABLED — same stub discipline as W3.
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

const TRANSITION_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['to'],
  properties: {
    to: { type: 'string', enum: ['PENDING_LOGIN', 'CONFIRMED_LOGGED_IN', 'RELOGIN_REQUIRED', 'LOGGED_OUT'] },
    evidence: { type: 'string', maxLength: 500 },
  },
};

const PROVISION_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['names'],
  properties: {
    names: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 3, maxLength: 40 } },
    identityType: { type: 'string', enum: ['qa_device', 'staging_user'] },
    egressIps: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 7, maxLength: 15 } },
    dryRun: { type: 'boolean' },
  },
};

const actorOf = (req) => ({ actorUserId: req.user.id, requestId: req.id, ip: req.ip });

function disabled(reply) {
  reply.code(503).send({
    error: { code: 'LOGIN_STATE_DISABLED', message: 'identity login-state (T2) is unavailable — the identity_login_audits / identity_data_dir_claims tables are missing (run prisma migrate deploy)' },
  });
}

export function identityLoginRoutes(app) {
  const svc = () => app.loginStateService;
  const prov = () => app.identityProvisionService;

  // Static route first (keep 'provision' from being eaten by :id).
  app.post(
    '/api/identities/provision',
    { preHandler: app.requireRole('admin'), schema: { body: PROVISION_BODY } },
    async (req, reply) => {
      const service = prov();
      if (!service || !svc()) return disabled(reply);
      return service.provision({ ...req.body, ...actorOf(req) });
    },
  );

  app.get(
    '/api/identities/:id/login',
    { preHandler: app.requireRole('viewer'), schema: PARAMS },
    async (req, reply) => {
      if (!svc()) return disabled(reply);
      return { login: await svc().getLoginState(req.params.id) };
    },
  );

  app.get(
    '/api/identities/:id/login/audit',
    { preHandler: app.requireRole('viewer'), schema: { params: PARAMS, querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } } } } },
    async (req, reply) => {
      if (!svc()) return disabled(reply);
      return svc().listAudit(req.params.id, { limit: req.query?.limit });
    },
  );

  app.post(
    '/api/identities/:id/login/transition',
    { preHandler: app.requireRole('operator'), schema: { params: PARAMS, body: TRANSITION_BODY } },
    async (req, reply) => {
      if (!svc()) return disabled(reply);
      // The manual-only guarantee lives HERE: this route is session-cookie
      // auth (requireRole) and the service has no other write caller. No
      // worker/queue path imports this service — grep-enforced in ADR-029.
      return svc().transition(req.params.id, req.body.to, { evidence: req.body.evidence, ...actorOf(req) });
    },
  );
}
