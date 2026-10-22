/**
 * system-ram-gate.js — admin read/write surface for the host-RAM admission
 * gate (RAM-G1).
 *
 * The backend is authoritative (MD G1: "UI 只係顯示，後端為權威"):
 *   GET  /api/system/ram-gate            — full status (metrics + config +
 *                                          counts + wouldAdmitNext + store)
 *   GET  /api/system/ram-gate/decisions  — recent admit/deny/release trail
 *   PUT  /api/system/ram-gate/config     — operator config patch (validated
 *                                          with the gate's own resolver —
 *                                          invalid = 400, nothing written)
 *   POST /api/system/ram-gate/reconcile  — force one reconcile cycle
 *
 * The UI is a display layer: it renders exactly what the gate reports and
 * makes no admission decision itself.
 *
 * Degrades honestly (BR-B3 house pattern): when the gate is not constructible
 * in this environment (no redis eval — hermetic fakes), the status/decisions/
 * reconcile routes fail closed with 503 RAM_GATE_UNAVAILABLE; the config
 * write route still works when the AppSetting table exists (the config
 * applies as soon as a gate is present).
 */
import {
  RAM_GATE_DEFAULTS,
  RAM_GATE_APP_SETTING_KEY,
  resolveRamGateConfig,
} from '@water-army/shared';

const GATE_UNAVAILABLE = 'RAM_GATE_UNAVAILABLE';

/**
 * @param {import('fastify').FastifyInstance} app
 */
export function systemRamGateRoutes(app) {
  const db = app.db;
  const log = app.log;

  const unavailable = async (req, reply) =>
    reply.code(503).send({
      error: {
        code: GATE_UNAVAILABLE,
        message: 'RAM admission gate unavailable in this environment (no redis eval surface)',
        requestId: req.id,
      },
    });

  const audit = (req, action, extra = {}) =>
    app.audit({
      actorUserId: req.user?.id ?? null,
      action,
      resourceType: 'app_setting',
      resourceId: extra.resourceId ?? RAM_GATE_APP_SETTING_KEY,
      requestId: req.id,
      ip: req.ip,
      status: extra.status ?? 'success',
      details: extra.details ?? null,
    });

  // ------------------------------------------------------------ status
  app.get(
    '/api/system/ram-gate',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const svc = app.ramGateService;
      if (!svc?.gate) return unavailable(req, reply);
      const status = await svc.gate.status();
      return reply.code(200).send(status);
    },
  );

  // ------------------------------------------------------------ decisions
  app.get(
    '/api/system/ram-gate/decisions',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const svc = app.ramGateService;
      if (!svc?.gate) return unavailable(req, reply);
      const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 300);
      return reply.code(200).send({ decisions: svc.decisions().slice(0, limit) });
    },
  );

  // ------------------------------------------------------------ config write
  app.put(
    '/api/system/ram-gate/config',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            maxParallel: { type: 'integer', minimum: 1, maximum: 128 },
            hardFloorMiB: { type: 'integer', minimum: 1024, maximum: 4194304 },
            postBootTargetMiB: { type: 'integer', minimum: 0, maximum: 4194304 },
            perBootBudgetMiB: { type: 'integer', minimum: 128, maximum: 65536 },
            metricsMaxAgeMs: { type: 'integer', minimum: 1000, maximum: 600000 },
            leaseTtlMs: { type: 'integer', minimum: 60000, maximum: 86400000 * 7 },
          },
        },
      },
    },
    async (req, reply) => {
      const body = req.body ?? {};
      if (Object.keys(body).length === 0) {
        const err = new Error('at least one config key is required');
        err.statusCode = 400;
        throw err;
      }
      // Validate with the gate's own resolver (patch only — env overrides
      // stay outside the write surface; the EFFECTIVE config is echoed).
      const check = resolveRamGateConfig(body, {});
      if (!check.ok) {
        const err = new Error(`invalid ram-gate config: ${check.errors.join('; ')}`);
        err.statusCode = 400;
        throw err;
      }
      if (!db?.appSetting) {
        const err = new Error('appSetting store unavailable — cannot persist ram-gate config');
        err.statusCode = 503;
        throw err;
      }

      // Merge semantics: the stored valueJson is the FULL operator patch;
      // a partial PUT merges into it (unset keys keep their stored value).
      const existing = await db.appSetting.findUnique({ where: { key: RAM_GATE_APP_SETTING_KEY } });
      const current = existing?.valueJson && typeof existing.valueJson === 'object' ? existing.valueJson : {};
      const merged = { ...current, ...body };
      // Re-validate the MERGED patch (a partial could combine into a bad set).
      const mergedCheck = resolveRamGateConfig(merged, {});
      if (!mergedCheck.ok) {
        const err = new Error(`merged ram-gate config invalid: ${mergedCheck.errors.join('; ')}`);
        err.statusCode = 400;
        throw err;
      }

      await db.appSetting.upsert({
        where: { key: RAM_GATE_APP_SETTING_KEY },
        create: { key: RAM_GATE_APP_SETTING_KEY, valueJson: merged, updatedBy: req.user?.id ?? null },
        update: { valueJson: merged, updatedBy: req.user?.id ?? null },
      });

      // Echo: stored patch + the gate's effective config (env applied).
      const effective = app.ramGateService?.gate
        ? { ok: true, config: (await app.ramGateService.gate.status()).config }
        : { note: 'gate not constructible in this environment — config stored, applies when present' };
      await audit(req, 'ramgate.config_updated', { details: { merged, effective: effective.config ?? null } });
      return reply.code(200).send({
        stored: merged,
        defaults: RAM_GATE_DEFAULTS,
        effective: effective.config ?? null,
        note: 'Effective config = constants + stored patch + RAM_GATE_* env (env wins). The gate re-reads the stored patch on every decision — the change is live.',
      });
    },
  );

  // ------------------------------------------------------------ reconcile
  app.post(
    '/api/system/ram-gate/reconcile',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const svc = app.ramGateService;
      if (!svc?.gate) return unavailable(req, reply);
      const summary = await svc.gate.reconcile();
      await audit(req, 'ramgate.reconcile_manual', {
        details: { released: summary.released, renewed: summary.renewed, recovered: summary.recovered, errors: summary.errors },
      });
      return reply.code(200).send(summary);
    },
  );

  log?.info?.('system-ram-gate routes registered');
}
