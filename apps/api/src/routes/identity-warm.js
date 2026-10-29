/**
 * WA-WARMING s1 — identity warm-state routes (Google/FB 防封门槛).
 *
 *  - GET  /api/identities/:id/warm          viewer+  → state + 進度 (derived-lazy)
 *  - POST /api/identities/:id/warm/start    operator+ → cold -> warming (clock starts)
 *  - POST /api/identities/:id/warm/reset    operator+ → * -> cold (fresh clock)
 *  - POST /api/identities/:id/warm/force    admin     → * -> warm (REASON REQUIRED, audited)
 *  - GET  /api/warm/threshold               viewer+  → effective AppSetting threshold
 *  - PUT  /api/warm/threshold               admin     → set threshold (int 0..365, audited)
 *
 * Promotion warming->warm needs NO route: it is DERIVED (elapsed >= threshold)
 * and persisted lazily on read/gate (see warm-state.js). Manual transitions
 * ride the audited service (StateEvent entityType 'identity_warm'); the
 * force route is the admin override the work order demands (reason is
 * required and lands in the audit + app.audit trail).
 *
 * Fail-closed pre-migration (partial fakes / old DB): 503 WARM_STATE_DISABLED.
 */
import {
  APP_SETTING_WARM_THRESHOLD_DAYS,
  WARM_THRESHOLD_DAYS_MAX,
  WARM_THRESHOLD_DEFAULT_DAYS,
  normalizeWarmThresholdInput,
  readWarmThresholdDays,
} from '@water-army/shared';

const IDENTITY_ID = {
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
};
const PARAMS = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: IDENTITY_ID } };
const ACTION_BODY = {
  type: 'object',
  additionalProperties: false,
  properties: { reason: { type: 'string', minLength: 3, maxLength: 280 } },
};

function disabled(reply) {
  reply.code(503).send({
    error: { code: 'WARM_STATE_DISABLED', message: 'warm-state (WA-WARMING) is unavailable — the identities.warm_state columns are missing (run prisma migrate deploy)' },
  });
}

export function warmStateRoutes(app) {
  const svc = () => app.warmStateService;

  function guard(reply) {
    if (!svc()) { disabled(reply); return false; }
    return true;
  }

  app.get(
    '/api/identities/:id/warm',
    { preHandler: app.requireRole('viewer'), schema: { params: PARAMS } },
    async (req, reply) => {
      if (!guard(reply)) return;
      const progress = await svc().getProgress(req.params.id);
      if (!progress) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: `identity ${req.params.id} not found` } });
      }
      return { warm: progress };
    },
  );

  async function action(name, role, { requireReason = false } = {}) {
    app.post(
      `/api/identities/:id/warm/${name}`,
      { preHandler: app.requireRole(role), schema: { params: PARAMS, body: ACTION_BODY } },
      async (req, reply) => {
        if (!guard(reply)) return;
        if (requireReason && typeof req.body?.reason !== 'string') {
          return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'reason (3..280 chars) is required for force-warm' } });
        }
        const res = await svc().transition(req.params.id, name, {
          actorUserId: req.user?.id ?? null,
          reason: req.body?.reason ?? null,
        });
        if (!res.ok) {
          const status = res.code === 'IDENTITY_NOT_FOUND' ? 404 : 409;
          return reply.code(status).send({ error: { code: res.code, message: res.message } });
        }
        app.audit({
          actorUserId: req.user?.id ?? null,
          action: `identity_warm_${name}`,
          resourceType: 'identity',
          resourceId: req.params.id,
          requestId: req.id,
          ip: req.ip,
          details: { reason: req.body?.reason ?? null, to: res.progress.storedState },
        });
        return { warm: res.progress };
      },
    );
  }
  action('start', 'operator');
  action('reset', 'operator');
  action('force', 'admin', { requireReason: true });

  app.get(
    '/api/warm/threshold',
    { preHandler: app.requireRole('viewer') },
    async (req) => {
      if (!svc()) return { thresholdDays: WARM_THRESHOLD_DEFAULT_DAYS, key: APP_SETTING_WARM_THRESHOLD_DAYS, source: 'default', note: 'warm-state service disabled — showing documented default' };
      const t = await readWarmThresholdDays(app.db, { log: app.log });
      return {
        thresholdDays: t.days,
        key: APP_SETTING_WARM_THRESHOLD_DAYS,
        source: t.source,
        formula: 'effective = identity.metadataJson.warmThresholdDays ?? AppSetting ?? default',
        note: `A warming identity needs ${t.days} days of warming clock before business dispatch is allowed (per-identity override supported).`,
      };
    },
  );

  app.put(
    '/api/warm/threshold',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['days'],
          properties: { days: { type: 'integer', minimum: 0, maximum: WARM_THRESHOLD_DAYS_MAX } },
        },
      },
    },
    async (req, reply) => {
      if (!guard(reply)) return;
      const days = normalizeWarmThresholdInput(req.body.days);
      if (days === null) {
        return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `days must be an integer 0..${WARM_THRESHOLD_DAYS_MAX}` } });
      }
      const key = APP_SETTING_WARM_THRESHOLD_DAYS;
      const existed = await app.db.appSetting.findUnique({ where: { key } });
      if (existed) {
        await app.db.appSetting.update({ where: { key }, data: { valueJson: { value: days }, updatedBy: req.user.id } });
      } else {
        await app.db.appSetting.create({ data: { key, valueJson: { value: days }, updatedBy: req.user.id } });
      }
      app.audit({
        actorUserId: req.user?.id ?? null,
        action: 'warm.threshold_set',
        resourceType: 'app_setting',
        resourceId: key,
        requestId: req.id,
        ip: req.ip,
        details: { days },
      });
      return { thresholdDays: days, key, source: 'appsetting' };
    },
  );
}
