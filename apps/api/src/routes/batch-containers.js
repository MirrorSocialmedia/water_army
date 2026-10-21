/**
 * BR-B3 — batch container lifecycle routes (MD Phase 3, lane A).
 *
 * OWNERSHIP NOTE (parallel-lane discipline): this file registers ONLY the
 * low-level container lifecycle surface (MD §4/§8/§9). The batch CONTROL
 * routes (create/preview/start/pause/resume/cancel, run retry/cancel) are
 * BR-B2's (routes/batches.js); the read/monitor surface is BR-B5's
 * (routes/batch-monitor.js). Literal-segment paths (`/api/batch-containers`)
 * coexist safely with B2's `/api/batches/:id` (find-my-way ranks static over
 * param segments).
 *
 * SECURITY MODEL (MD §4.3 / §12 / threat T1):
 *  - The worker NEVER holds the Docker socket; the container adapter (S4)
 *    calls these routes with the service token (operator-level identity).
 *  - Every op re-verifies ownership (container labels x DB TaskRun) inside
 *    the service; a disagreement refuses + audits — the route layer adds
 *    RBAC + write budgets on top, it does not trust the caller's claims.
 *  - purge is ADMIN + HUMAN only (requireHuman: a service/AI identity can
 *    never wipe identity data, MD §4.2 — batch completion does not auto-
 *    purge; only a human with the confirm-token may).
 *  - reconcile fix=true is ADMIN + HUMAN (it stops/removed containers);
 *    fix=false (classify only) is operator (the worker's finally path).
 *
 * All responses are secret-free: the service returns id/path/label/audit
 * shapes only; docker error messages are classified, not echoed raw.
 */
import { API_ERROR } from '@water-army/shared';

import { requireHuman } from '../security/service-auth.js';

function httpError(status, apiCode, message) {
  const err = new Error(message);
  err.statusCode = status;
  err.apiCode = apiCode;
  return err;
}

function createWindowLimiter({ limit = 30, windowMs = 60_000, now = () => Date.now() } = {}) {
  const hits = new Map();
  return {
    take(key) {
      const t = now();
      const w = hits.get(key);
      if (!w || t - w.start >= windowMs) {
        hits.set(key, { start: t, n: 1 });
        return { allowed: true, retryAfterMs: 0 };
      }
      if (w.n >= limit) {
        return { allowed: false, retryAfterMs: windowMs - (t - w.start) };
      }
      w.n += 1;
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}

export function batchContainerRoutes(app) {
  // The routes need the B1 tables (identity/taskRun/appSetting/lease) and
  // the decorated lifecycle service. Pre-B2 test fakes (makeFakeDb) lack the
  // delegates — skip registration rather than fail every buildApp test that
  // never touches batch containers.
  const db = app.db;
  if (!db?.identity || !db?.taskRun || !db?.appSetting || !db?.resourceLease || !app.batchLifecycle) {
    app.log?.warn?.('batch-container routes not registered: missing B1 delegates or batchLifecycle service (pre-B2 fake)');
    return;
  }
  const lifecycle = app.batchLifecycle;
  const log = app.log;

  // --- per-actor write budgets (MD §13.2 — lifecycle ops are expensive) ----
  const startLimiter = createWindowLimiter({ limit: 20, windowMs: 60_000 });
  const mutateLimiter = createWindowLimiter({ limit: 30, windowMs: 60_000 });

  function rateGuard(limiter, req, reply, what) {
    const key = req.user?.id ?? req.ip ?? 'anon';
    const res = limiter.take(key);
    if (!res.allowed) {
      const secs = Math.max(1, Math.ceil(res.retryAfterMs / 1000));
      reply.header('retry-after', String(secs));
      throw httpError(429, API_ERROR.RATE_LIMITED, `Too many ${what} — retry after ${secs}s`);
    }
  }

  function actor(req) {
    return { userId: req.user?.id ?? null, label: req.user?.username ?? 'unknown', isService: Boolean(req.user?.isService) };
  }

  /** admin + human gate for destructive/irreversible ops (MD §4.2/§12). */
  function requireAdminHuman(req, reply, what) {
    if (req.user?.isService) return requireHuman(req, reply);
    if ((req.user?.role ?? 'viewer') !== 'admin') {
      return reply.code(403).send({
        error: { code: API_ERROR.FORBIDDEN, message: `${what} requires an ADMIN human operator (MD §4.2)`, requestId: req.id },
      });
    }
    return null;
  }

  /**
   * GET /api/batch-containers — the managed container inventory (operator).
   * One row per label-managed container with its run/identity/batch lineage,
   * docker state, host ports and lease liveness. B6's UI lists from here.
   */
  app.get('/api/batch-containers', { preHandler: app.requireRole('operator') }, async (req) => {
    const containers = await lifecycle.list();
    return { containers, count: containers.length };
  });

  /**
   * POST /api/batch-containers/reconcile — DB x docker state reconciliation
   * (MD Phase 3 item 3/5). Body: { fix?: boolean }.
   *   fix=false (default, operator — also the worker's finally path):
   *     classify only (ok/orphan/stale_running/db_only/unbound/mismatch).
   *   fix=true (admin + human): stop orphans + stale_running; NEVER starts
   *     anything (no double-start); mismatches are refused + audited.
   */
  app.post(
    '/api/batch-containers/reconcile',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        body: { type: 'object', additionalProperties: false, properties: { fix: { type: 'boolean' } } },
      },
    },
    async (req, reply) => {
      const fix = req.body?.fix === true;
      if (fix) {
        const denied = requireAdminHuman(req, reply, 'Reconcile fix');
        if (denied) return denied;
      }
      rateGuard(mutateLimiter, req, reply, 'reconcile requests');
      return lifecycle.reconcile({ fix, actor: actor(req) });
    },
  );

  /**
   * POST /api/task-runs/:runId/containers/start — start the run's container
   * (MD Phase 3 item 3). Empty body; provenance is the AUTHENTICATED actor
   * (never caller-supplied — the created-by label is an audit fact).
   * Idempotent-friendly: a crash-window container of this run is ADOPTED,
   * not re-created (no double-start); the DB bind is the second ownership
   * half and is written before the engine start completes.
   */
  app.post(
    '/api/task-runs/:runId/containers/start',
    {
      preHandler: app.requireRole('operator'),
      schema: {
        body: { type: 'object', additionalProperties: false },
      },
    },
    async (req, reply) => {
      rateGuard(startLimiter, req, reply, 'start requests');
      return lifecycle.startForRun(req.params.runId, actor(req));
    },
  );

  /**
   * GET /api/task-runs/:runId/containers/health — app-layer health
   * (MD §8.2: ADB handshake, NOT docker state). Single probe, bounded.
   */
  app.get('/api/task-runs/:runId/containers/health', { preHandler: app.requireRole('operator') }, async (req) => {
    return lifecycle.healthForRun(req.params.runId);
  });

  /**
   * POST /api/task-runs/:runId/containers/stop — reversible stop
   * (MD Phase 3 item 4): container exits, VOLUME + data intact, port lease
   * released. The re-dispatch path may start the run again.
   */
  app.post('/api/task-runs/:runId/containers/stop', { preHandler: app.requireRole('operator') }, async (req) => {
    rateGuard(mutateLimiter, req, reply, 'stop requests');
    return lifecycle.stopForRun(req.params.runId, actor(req));
  });

  /**
   * POST /api/task-runs/:runId/containers/remove — container removal with
   * VOLUME RETENTION (MD Phase 3 item 4): the container goes, the identity
   * data STAYS (only purge may wipe it). Idempotent (already-gone = no-op).
   */
  app.post('/api/task-runs/:runId/containers/remove', { preHandler: app.requireRole('operator') }, async (req) => {
    rateGuard(mutateLimiter, req, reply, 'remove requests');
    return lifecycle.removeForRun(req.params.runId, actor(req));
  });

  /**
   * POST /api/identities/:id/purge — the ONLY data-wipe path (MD Phase 3
   * item 4; MD §4.2). ADMIN + HUMAN only (service identities refused).
   * Body: { dryRun?: boolean, confirm?: string }.
   *   dryRun=true  → preview (size/files/containers), NOTHING changes.
   *   dryRun=false → confirm MUST equal the identity id (typo-proof token),
   *     containers are ownership-gated + stopped/removed, then the data dir
   *     is wiped and the whole action is audited.
   */
  app.post(
    '/api/identities/:id/purge',
    {
      // requireHuman runs INSIDE the handler (repo pattern, tasks.js): a
      // preHandler may not return an already-sent reply.
      preHandler: app.requireRole('admin'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { dryRun: { type: 'boolean' }, confirm: { type: 'string', maxLength: 128 } },
        },
      },
    },
    async (req, reply) => {
      const denied = requireAdminHuman(req, reply, 'Purge');
      if (denied) return denied;
      rateGuard(mutateLimiter, req, reply, 'purge requests');
      const { dryRun = false, confirm } = req.body ?? {};
      try {
        return await lifecycle.purgeIdentity(req.params.id, { dryRun, confirm: confirm ?? null, actor: actor(req) });
      } catch (err) {
        log.warn?.({ identityId: req.params.id, code: err.apiCode, error: err.message }, 'purge rejected');
        throw err;
      }
    },
  );
}
