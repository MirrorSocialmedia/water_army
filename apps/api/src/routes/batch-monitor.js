/**
 * Batch Rotation monitoring & reporting routes (BR-B5, MD §10/§11/§12/§13).
 *
 * OWNERSHIP NOTE (parallel-lane discipline): this file registers ONLY the
 * read/monitor/report surface. The batch control routes (POST /api/batches,
 * /preview, /start, /pause, /resume, /cancel, task-run retry/cancel/logs)
 * are BR-B2's — they will register their own file. Literal-segment routes
 * (`/api/batches/metrics`, `/api/batch-reports…`) coexist safely with B2's
 * `/api/batches/:id` (find-my-way ranks static segments over params).
 *
 * RBAC (MD §12):
 *   viewer   : identities list/detail, monitor summary, metrics, cycle list
 *   operator : cycle report export (JSON/CSV)
 *   admin    : (control-plane mutations — B2 territory)
 * All responses are secret-free by construction: payloads are allowlisted
 * field picks + scrubObject on free text; the report builder has a hard
 * zero-secret gate (fails the export, never leaks).
 */
import { scrubObject, maskCredentialShapedValues, BatchError } from '@water-army/shared';

const PAGE_MAX = 200;
const DETAIL_METADATA_MAX = 2000;

function safePage(query, def = 1) {
  const v = Number(query.page ?? def);
  return Number.isInteger(v) && v >= 1 ? v : def;
}
function safePageSize(query) {
  const v = Number(query.pageSize ?? 50);
  return Number.isInteger(v) && v >= 1 && v <= PAGE_MAX ? v : 50;
}

/**
 * Mask a free-text/error payload for API responses (MD §12): redact
 * credential-shaped values, scrub sensitive keys, cap length. Returns null
 * for null. (Error messages are the likeliest leak vector — a task that
 * logs a header verbatim.)
 */
function maskText(value, max = 500) {
  if (value == null) return null;
  const s = maskCredentialShapedValues(String(value));
  const scrubbed = scrubObject({ v: s }, max).v;
  return scrubbed.length > max ? `${scrubbed.slice(0, max)}…` : scrubbed;
}

/** Identity row → API shape (metadata scrubbed + capped; no other field leaks). */
function identityShape(i) {
  return {
    id: i.id,
    externalRef: i.externalRef ?? null,
    displayName: i.displayName,
    identityType: i.identityType,
    status: i.status,
    dataPath: i.dataPath,
    metadata: scrubObject(i.metadataJson ?? {}, DETAIL_METADATA_MAX),
    createdAt: i.createdAt ?? null,
    updatedAt: i.updatedAt ?? null,
  };
}

export function batchMonitorRoutes(app) {
  const metrics = app.batchMetrics; // decorated in app.js

  // ------------------------------------------------------------ identities --
  /** GET /api/identities — paginated + status filter (MD §10, viewer). */
  app.get(
    '/api/identities',
    {
      preHandler: app.requireRole('viewer'),
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', maxLength: 32 },
            q: { type: 'string', maxLength: 100 },
            // querystring values arrive as strings (app ajv: coerceTypes false) —
            // pattern here, range enforced in the handler (repo convention).
            page: { type: 'string', pattern: '^[1-9][0-9]*$' },
            pageSize: { type: 'string', pattern: '^[1-9][0-9]*$' },
          },
        },
      },
    },
    async (req) => {
      const { status, q } = req.query;
      const page = safePage(req.query);
      const pageSize = safePageSize(req.query);

      // the fake + prisma both support {status}; q is applied in JS (small
      // table: 200 identities) to keep the query shape identical on both.
      const where = {};
      if (status) where.status = status;
      let rows = await app.db.identity.findMany({ where, orderBy: { createdAt: 'asc' } });
      if (q) {
        const needle = String(q).toLowerCase();
        rows = rows.filter(
          (r) =>
            r.displayName.toLowerCase().includes(needle) ||
            (r.externalRef ?? '').toLowerCase().includes(needle) ||
            r.id.toLowerCase().includes(needle),
        );
      }
      const total = rows.length;
      const items = rows.slice((page - 1) * pageSize, page * pageSize).map(identityShape);
      return { items, total, page, pageSize };
    },
  );

  /** GET /api/identities/:id — detail (MD §11.3, viewer; zero secrets). */
  app.get('/api/identities/:id', { preHandler: app.requireRole('viewer') }, async (req) => {
    const { id } = req.params;
    const identity = await app.db.identity.findUnique({ where: { id } });
    if (!identity) throw new BatchError('IDENTITY_NOT_FOUND', `Identity ${id} not found`, { status: 404 });

    const [memberships, recentRuns, container, dataDir] = await Promise.all([
      app.db.batchIdentity.findMany({ where: { identityId: id }, orderBy: { createdAt: 'desc' } }),
      app.db.taskRun.findMany({ where: { identityId: id }, orderBy: { createdAt: 'desc' }, take: 10 }),
      findIdentityContainer(app, identity.id),
      metrics.probeDataDir(identity.dataPath),
    ]);

    // batch context for the memberships (small fan-out, bounded)
    const batchIds = [...new Set(memberships.map((m) => m.batchId))];
    const batches = batchIds.length ? await app.db.batch.findMany({ where: { id: { in: batchIds } } }) : [];
    const batchOf = new Map(batches.map((b) => [b.id, b]));

    const lastError = recentRuns.find((r) => r.errorCode || r.errorMessage) ?? null;
    const healthBeats = recentRuns.map((r) => r.heartbeatAt).filter(Boolean);
    const lastHealthCheckAt = healthBeats.length
      ? healthBeats.reduce((a, b) => (new Date(a) > new Date(b) ? a : b))
      : null;

    return {
      identity: identityShape(identity),
      dataDir: { path: identity.dataPath, ...dataDir },
      memberships: memberships.map((m) => ({
        batchId: m.batchId,
        batchNo: batchOf.get(m.batchId)?.batchNo ?? null,
        batchName: batchOf.get(m.batchId)?.name ?? null,
        batchStatus: batchOf.get(m.batchId)?.status ?? null,
        position: m.position,
        status: m.status,
        skipReason: m.skipReason ? maskText(m.skipReason, 200) : null,
      })),
      recentRuns: recentRuns.map(runShape),
      lastError: lastError
        ? { code: lastError.errorCode ?? null, message: maskText(lastError.errorMessage), at: lastError.finishedAt ?? lastError.updatedAt ?? null, runId: lastError.id }
        : null,
      container: container ? { id: container.id, shortId: container.shortId, state: container.state } : null,
      lastHealthCheckAt,
    };
  });

  // --------------------------------------------------------- monitor summary --
  /** GET /api/batch-monitor/summary — live monitor (MD §11.2, viewer). */
  app.get('/api/batch-monitor/summary', { preHandler: app.requireRole('viewer') }, async (req) => {
    const snap = await metrics.snapshot();
    return snap;
  });

  // ---------------------------------------------------------------- metrics --
  /** GET /api/batches/metrics — MD §13 metrics + alerts (viewer). */
  app.get('/api/batches/metrics', { preHandler: app.requireRole('viewer') }, async (req) => {
    return metrics.getMetrics();
  });

  // ---------------------------------------------------------------- reports --
  /** GET /api/batch-reports — cycles list (viewer). */
  app.get('/api/batch-reports', { preHandler: app.requireRole('viewer') }, async (req) => {
    return { cycles: await metrics.listCycles() };
  });

  /**
   * GET /api/batch-reports/:cycleId — export (MD §11.4, operator+).
   * ?format=json (default) | csv. Zero secrets by construction + hard gate;
   * every export writes an audit event (actor + request id, MD §12).
   */
  app.get(
    '/api/batch-reports/:cycleId',
    {
      preHandler: app.requireRole('operator'),
      schema: { querystring: { type: 'object', additionalProperties: false, properties: { format: { type: 'string', enum: ['json', 'csv'] } } } },
    },
    async (req, reply) => {
      const { cycleId } = req.params;
      const format = req.query.format === 'csv' ? 'csv' : 'json';

      let report;
      try {
        report = await metrics.getCycleReport(cycleId, { requireTerminal: false });
      } catch (err) {
        if (err instanceof BatchError) throw err;
        throw err;
      }

      await app.audit({
        actorUserId: req.user?.id ?? null,
        action: 'batch.report_exported',
        resourceType: 'batch_cycle',
        resourceId: cycleId,
        requestId: req.id,
        ip: req.ip,
        status: 'success',
        details: { format, batches: report.batches?.length ?? 0, identities: report.totals?.identities ?? 0 },
      });

      if (format === 'csv') {
        const { renderCycleReportCsv } = await import('@water-army/shared');
        const csv = renderCycleReportCsv(report);
        return reply
          .type('text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="batch-cycle-${cycleId}.csv"`)
          .send(csv);
      }
      return report;
    },
  );
}

// ------------------------------------------------------------------ helpers --
/** Monitor task-row shape (allowlisted + masked — MD §11.2/§12). */
function runShape(r) {
  return {
    id: r.id,
    status: r.status,
    attempt: r.attempt ?? 1,
    maxAttempts: r.maxAttempts ?? null,
    batchId: r.batchId ?? null,
    identityId: r.identityId ?? null,
    queuedAt: r.queuedAt ?? null,
    startedAt: r.startedAt ?? null,
    heartbeatAt: r.heartbeatAt ?? null,
    finishedAt: r.finishedAt ?? null,
    durationMs: r.durationMs ?? null,
    errorCode: r.errorCode ?? null,
    errorMessage: maskText(r.errorMessage),
  };
}

/** Live container for an identity via the batch label index (degrades to null). */
async function findIdentityContainer(app, identityId) {
  try {
    const { items } = await app.dockerService.listContainers({ managed: true, pageSize: 200 });
    const hits = items.filter((c) => c.identityId === identityId);
    if (!hits.length) return null;
    const running = hits.find((c) => c.state === 'running');
    return running ?? hits[0];
  } catch {
    return null; // docker down → degraded, not failed
  }
}
