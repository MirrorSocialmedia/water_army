/**
 * BR-B6 G4 — admin-only write surface for the network policy (AppSetting).
 *
 * docs/network-policy.md §3.2/§10: B4 shipped the READ contract (the gate's
 * loadNetworkPolicy); this module adds the missing admin write route (MD §12
 * role requirement) so operators can manage the policy without editing the
 * database by hand.
 *
 * RBAC: ADMIN ONLY for read AND write — the allowlist is security-critical
 * state (it defines exactly where the worker fleet may egress).
 *
 * Write semantics (fail-closed, mirrors loadNetworkPolicy exactly):
 *   - allowlist values are JSON string[]; they are validated with the SAME
 *     parseAllowlist the gate uses at dispatch time — malformed = 400 and
 *     NOTHING is written. An EMPTY array is legal: it removes the DB
 *     contribution for that zone; if the env side is empty too, the policy
 *     becomes unavailable and every run fails closed — the response reports
 *     the resulting state honestly (this is the supported "emergency stop").
 *   - taskTypes must be the COMPLETE object { ai: boolean, adhoc: boolean }
 *     — partial updates are rejected (they would silently leave the other
 *     key at its default).
 *   - every write records updatedBy (acting admin) + an audit row, and
 *     echoes the EFFECTIVE policy (what the gate applies on the NEXT
 *     dispatch — the gate re-reads per attempt, so changes are live).
 */
import {
  NETWORK_POLICY_ENV,
  NETWORK_SETTING_KEYS,
  loadNetworkPolicy,
  parseAllowlist,
} from '@water-army/shared';

/**
 * @param {import('fastify').FastifyInstance} app
 */
export function networkPolicyRoutes(app) {
  const db = app.db;
  // The routes need the appSetting delegate (B1 table). Pre-B1 test fakes
  // don't have it — skip registration there (house pattern, cf. batches.js).
  if (!db?.appSetting) {
    app.log?.warn?.('network-policy routes not registered: db lacks the appSetting delegate');
    return;
  }

  const badRequest = (message) => {
    const err = new Error(message);
    err.statusCode = 400;
    throw err;
  };

  const audit = (req, action, extra = {}) =>
    app.audit({
      actorUserId: req.user?.id ?? null,
      action,
      resourceType: extra.resourceType ?? 'app_setting',
      resourceId: extra.resourceId ?? null,
      requestId: req.id,
      ip: req.ip,
      status: extra.status ?? 'success',
      details: extra.details ?? null,
    });

  /** Load the EFFECTIVE policy (env + AppSetting union) for a response. */
  const effective = () => loadNetworkPolicy({ env: process.env, db, log: app.log });

  /** Validate a zone list with the gate's exact parser (fail-closed). */
  const validateZone = (list, key) => {
    if (!Array.isArray(list)) {
      badRequest(`${key} must be a JSON array of entry strings`);
    }
    for (const e of list) {
      if (typeof e !== 'string') {
        badRequest(`${key} entries must be strings`);
      }
    }
    const parsed = parseAllowlist(list, key);
    if (!parsed.ok) {
      badRequest(`${key} malformed: ${parsed.reason}`);
    }
    return list;
  };

  // ------------------------------------------------------------------ read
  app.get(
    '/api/network-policy',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const policy = await effective();
      const rows = {};
      for (const key of Object.values(NETWORK_SETTING_KEYS)) {
        const row = await db.appSetting.findUnique({ where: { key } });
        rows[key] = row
          ? { valueJson: row.valueJson, updatedBy: row.updatedBy ?? null, updatedAt: row.updatedAt ?? null }
          : null;
      }
      const body = {
        available: policy.available,
        reason: policy.available ? null : policy.reason,
        effective: policy.available ? { entries: policy.entries, taskTypes: policy.taskTypes, sources: policy.sources } : null,
        appSettings: rows,
        env: {
          public: process.env[NETWORK_POLICY_ENV.ALLOWLIST] ?? '',
          internal: process.env[NETWORK_POLICY_ENV.ALLOWLIST_INTERNAL] ?? '',
        },
        note: 'Writes take effect on the NEXT dispatch (the gate re-reads the policy per attempt). An empty allowlist with an empty env = policy unavailable = every run fails closed (supported emergency stop).',
      };
      return reply.code(200).send(body);
    },
  );

  // ------------------------------------------------------------ allowlists
  app.put(
    '/api/network-policy/allowlists',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // null = remove the DB row for that zone (env-only again);
            // absent = leave untouched; [] = clear (legal — see module doc).
            allowlist: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 200 },
            allowlistInternal: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 200 },
          },
          // at least one zone must be addressed
          anyOf: [{ required: ['allowlist'] }, { required: ['allowlistInternal'] }],
        },
      },
    },
    async (req, reply) => {
      const { allowlist, allowlistInternal } = req.body;
      const changes = {};

      if (allowlist !== undefined) {
        changes[NETWORK_SETTING_KEYS.ALLOWLIST] = allowlist === null ? null : validateZone(allowlist, NETWORK_SETTING_KEYS.ALLOWLIST);
      }
      if (allowlistInternal !== undefined) {
        changes[NETWORK_SETTING_KEYS.ALLOWLIST_INTERNAL] = allowlistInternal === null ? null : validateZone(allowlistInternal, NETWORK_SETTING_KEYS.ALLOWLIST_INTERNAL);
      }
      if (Object.keys(changes).length === 0) {
        badRequest('nothing to update — provide allowlist and/or allowlistInternal');
      }

      for (const [key, value] of Object.entries(changes)) {
        if (value === null) {
          await db.appSetting.deleteMany({ where: { key } });
        } else {
          const existed = await db.appSetting.findUnique({ where: { key } });
          if (existed) {
            await db.appSetting.update({ where: { key }, data: { valueJson: value, updatedBy: req.user.id } });
          } else {
            await db.appSetting.create({ data: { key, valueJson: value, updatedBy: req.user.id } });
          }
        }
      }

      await audit(req, 'network_policy.allowlist_set', {
        resourceId: Object.keys(changes).join(','),
        details: {
          zones: Object.keys(changes).map((k) => ({ key: k, action: changes[k] === null ? 'removed' : 'set', count: changes[k]?.length ?? 0 })),
        },
      });

      const policy = await effective();
      return reply.code(200).send({
        available: policy.available,
        reason: policy.available ? null : policy.reason,
        effective: policy.available ? { entries: policy.entries, sources: policy.sources } : null,
        changed: Object.keys(changes),
      });
    },
  );

  // -------------------------------------------------------------- taskTypes
  app.put(
    '/api/network-policy/task-types',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['ai', 'adhoc'],
          properties: { ai: { type: 'boolean' }, adhoc: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) => {
      const value = { ai: req.body.ai, adhoc: req.body.adhoc };
      const key = NETWORK_SETTING_KEYS.TASK_TYPES;
      const existed = await db.appSetting.findUnique({ where: { key } });
      if (existed) {
        await db.appSetting.update({ where: { key }, data: { valueJson: value, updatedBy: req.user.id } });
      } else {
        await db.appSetting.create({ data: { key, valueJson: value, updatedBy: req.user.id } });
      }
      await audit(req, 'network_policy.task_types_set', {
        resourceId: key,
        details: { ...value },
      });
      const policy = await effective();
      return reply.code(200).send({
        available: policy.available,
        reason: policy.available ? null : policy.reason,
        taskTypes: policy.available ? policy.taskTypes : null,
      });
    },
  );
}
