/**
 * T5 (ADR-030) — account lifecycle routes.
 *
 *  - GET  /api/identities/:id/account          viewer+   → lifecycle state + vault summary (masked)
 *  - GET  /api/identities/:id/account/audit    viewer+   → transition audit (newest first)
 *  - POST /api/identities/:id/account/transition operator+ → manual override (audited, matrix-checked)
 *  - POST /api/identities/:id/account/provision  operator+ → one driver touch (fresh start / gate resume)
 *
 * Unlike the login machine (human-ONLY, ADR-029), this axis is
 * system-writable by the driver and operator-overridable here — the
 * manual/automatic boundary is the whole point of the sibling split.
 *
 * Fail-closed when the T5 tables are absent (partial fakes / pre-migration):
 * 503 ACCOUNT_LIFECYCLE_DISABLED (W3/T2 stub discipline). The provision route
 * additionally 503s GMAIL_PROVISION_DISABLED while WA_GMAIL_PROVISION_ENABLED
 * is off (default off — 老細 inputs pending: recovery pool / proxy / volume).
 */

const IDENTITY_ID = {
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
};

const PARAMS = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: IDENTITY_ID } };

const TRANSITION_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['to'],
  properties: {
    to: { type: 'string', enum: ['PREPARING', 'PROVISIONING', 'AWAITING_HUMAN', 'CREATED', 'RECOVERY_SETUP', 'READY', 'DEAD'] },
    reasonCode: { type: 'string', maxLength: 60, pattern: '^[A-Z0-9_]{2,60}$' },
  },
};

function disabled(reply) {
  reply.code(503).send({
    error: { code: 'ACCOUNT_LIFECYCLE_DISABLED', message: 'account lifecycle (T5) is unavailable — the account_lifecycles / gmail_accounts tables are missing (run prisma migrate deploy)' },
  });
}

export function accountLifecycleRoutes(app) {
  const svc = () => app.accountLifecycleService;
  const driver = () => app.gmailProvisionDriver;

  app.get(
    '/api/identities/:id/account',
    { preHandler: app.requireRole('viewer'), schema: { params: PARAMS } },
    async (req, reply) => {
      if (!svc()) return disabled(reply);
      const account = await svc().getState(req.params.id);
      let vault = null;
      const row = await app.db.gmailAccount.findUnique({ where: { identityId: req.params.id } });
      if (row) {
        vault = {
          emailMasked: row.emailMasked ?? null,
          hasPassword: Boolean(row.passwordCipher),
          recoveryEmailMasked: row.recoveryEmailMasked ?? null,
          profile: row.profileJson ?? {},
          createdAt: row.createdAt,
        };
      }
      return { account, vault };
    },
  );

  app.get(
    '/api/identities/:id/account/audit',
    { preHandler: app.requireRole('viewer'), schema: { params: PARAMS, querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } } } } },
    async (req, reply) => {
      if (!svc()) return disabled(reply);
      return svc().listAudit(req.params.id, { limit: req.query?.limit });
    },
  );

  app.post(
    '/api/identities/:id/account/transition',
    { preHandler: app.requireRole('operator'), schema: { params: PARAMS, body: TRANSITION_BODY } },
    async (req, reply) => {
      if (!svc()) return disabled(reply);
      return svc().transition(req.params.id, req.body.to, {
        actorUserId: req.user.id, actorKind: 'human', reasonCode: req.body.reasonCode ?? 'OPERATOR_OVERRIDE',
        requestId: req.id, ip: req.ip,
      });
    },
  );

  app.post(
    '/api/identities/:id/account/provision',
    { preHandler: app.requireRole('operator'), schema: { params: PARAMS } },
    async (req, reply) => {
      if (!svc()) return disabled(reply);
      const d = driver();
      if (!d) {
        return reply.code(503).send({
          error: { code: 'GMAIL_PROVISION_DISABLED', message: 'Gmail provisioning is disabled — set WA_GMAIL_PROVISION_ENABLED=true and configure WA_GMAIL_RECOVERY_POOL (fail-closed, ADR-030)' },
        });
      }
      return d.provisionOne(req.params.id, { actorUserId: req.user.id, requestId: req.id, ip: req.ip });
    },
  );
}
