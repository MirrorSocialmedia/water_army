/**
 * Fastify application factory — the single wiring point.
 *
 * Everything environment-facing is injectable (db/redis/docker/config) so
 * unit + integration tests run hermetically (fakes, no network).
 *
 * Security plumbing (施工 MD §8, §13):
 *  - request id on every request (header + error envelope + logs)
 *  - centralized error handler → { error: { code, message, requestId } }
 *  - JSON Schema validation, unknown fields rejected (additionalProperties:false)
 *  - pino structured logs with redaction (authorization/keys/passwords/cookie/session)
 *  - origin guard (CSRF baseline) + security headers
 *  - session auth hook + RBAC decorator (requireRole)
 */
import crypto from 'node:crypto';
import Fastify from 'fastify';

import { PINO_REDACT_PATHS, SESSION_COOKIE, API_ERROR, createLeaseService, BatchLifecycleError } from '@water-army/shared';

import { loadConfig } from './config.js';
import { createDb, closeDb } from './plugins/db.js';
import { createRedisClient, closeRedis } from './plugins/redis.js';
import { createDockerClient } from './plugins/docker.js';
import { parseCookies } from './security/cookie.js';
import { originCheck } from './security/origin.js';
import { requireRole } from './security/rbac.js';
import { createServiceAuthHook } from './security/service-auth.js';
import { createRateLimiter, createRequestLimiter } from './security/rate-limit.js';
import { createAuditService } from './services/audit.js';
import { createBatchLifecycleService } from './services/batch-lifecycle-service.js';
import { createSessionService } from './services/session.js';
import { createDockerService } from './services/docker-service.js';
import { createBatchMetricsService } from './services/batch-metrics-service.js';
import { runRedroidPreflight } from './services/preflight.js';
import { createRedroidService } from './services/redroid-service.js';
import { buildRamGateService } from './services/ram-gate-service.js';
import { createAdbWhitelist } from './services/adb-whitelist.js';
import { createMockRedroidEnvironment } from './services/redroid-mock.js';
import { createTaskQueue, closeTaskQueue } from './plugins/task-queue.js';
import { authRoutes } from './routes/auth.js';
import { containerRoutes } from './routes/containers.js';
import { templateRoutes } from './routes/templates.js';
import { redroidTemplateRoutes } from './routes/redroid-templates.js';
import { redroidDeviceRoutes } from './routes/devices.js';
import { taskRoutes } from './routes/tasks.js';
import { batchRoutes } from './routes/batches.js';
import { scheduleRoutes } from './routes/schedules.js';
import { scheduleNotificationRoutes } from './routes/schedule-notifications.js';
import { taskDefinitionRoutes } from './routes/task-definitions.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { batchMonitorRoutes } from './routes/batch-monitor.js';
import { batchContainerRoutes } from './routes/batch-containers.js';
import { networkPolicyRoutes } from './routes/network-policy.js';
import { systemRamGateRoutes } from './routes/system-ram-gate.js';
import { deviceStreamRoutes } from './routes/device-streams.js';
import { manualInterventionRoutes } from './routes/manual-interventions.js';
import { buildStreamSidecarManager, STREAM_SIDECAR_ENTRY } from './plugins/stream-sidecar.js';
import { createStreamGateway } from './services/stream-gateway.js';
import { createStreamLeaseService } from './services/stream-lease-service.js';
import { createInterventionService, createUnavailableIntervention } from './services/intervention-service.js';

function createUnavailableStreamLease() {
  const unavailable = () => {
    const e = new Error('stream lease service unavailable — this deployment has no stream data surface');
    e.apiCode = 'STREAM_LEASE_UNAVAILABLE';
    e.statusCode = 503;
    throw e;
  };
  return {
    maxStreams: 0,
    ttlMs: 0,
    usage: unavailable,
    acquire: unavailable,
    list: unavailable,
    heartbeat: unavailable,
    close: unavailable,
    validateTicket: unavailable,
    consumeTicket: unavailable,
    reconcileStartup: async () => 0,
    reconcileExpired: async () => 0,
    startReconciler() {},
    stopReconciler() {},
  };
}

/** Public (unauthenticated) route prefixes — everything else may need a session. */
const PUBLIC_PREFIXES = ['/api/health', '/api/auth/login'];

function publicPath(url) {
  return (url ?? '/').split('?')[0];
}

/**
 * BR-B3: fail-closed stand-in for the container lifecycle service when the db
 * has no batch surface (partial test fakes / legacy schemas). Every op throws
 * a 503 BATCH_LIFECYCLE_UNAVAILABLE — the routes degrade honestly instead of
 * crashing boot or claiming success (MD §9.1 fail-closed).
 */
function createUnavailableBatchLifecycle() {
  const unavailable = () => {
    throw new BatchLifecycleError(
      'BATCH_LIFECYCLE_UNAVAILABLE',
      'batch container lifecycle unavailable — this deployment has no batch data surface',
      { status: 503 },
    );
  };
  return {
    startForRun: unavailable,
    healthForRun: unavailable,
    stopForRun: unavailable,
    removeForRun: unavailable,
    purgeIdentity: unavailable,
    reconcile: unavailable,
    list: unavailable,
  };
}

/**
 * @param {object} [opts]
 * @param {object} [opts.config]  pre-built config (skips env loading)
 * @param {object} [opts.db]      prisma client (or fake)
 * @param {object} [opts.redis]   ioredis instance (or fake)
 * @param {object} [opts.docker]  docker client wrapper (or fake)
 * @param {boolean}[opts.registerHealth] register health routes (default true)
 * @param {object} [opts.logStream] pino stream override (test seam for log capture)
 * @param {object} [opts.batchMetricsOsProbe]  {freemem,totalmem,loadavg} (test seam)
 * @param {object} [opts.batchMetricsFsProbe]  {stat,statfs} (test seam)
 * @param {string} [opts.batchMetricsDiskPath] statfs path override (test seam)
 * @param {object} [opts.batchMetricsLimits]  alert limit overrides (test seam)
 * @param {object} [opts.batchLifecycleHealthProbe] (host,port,timeoutMs)=>Promise<{healthy,detail,version?}> canned ADB probe (test seam)
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function buildApp(opts = {}) {
  const config = opts.config ?? loadConfig();
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: [...PINO_REDACT_PATHS], censor: '***', removeOnly: false },
      stream: opts.logStream,
    },
    bodyLimit: 1_000_000,
    // Behind the web reverse proxy; req.ip reflects X-Forwarded-For (the proxy
    // overwrites it with the socket peer, so it cannot be spoofed by clients).
    // Without this, login rate limiting keys on the proxy IP and one flooder
    // can lock out every user. Disable with TRUST_PROXY=false if api is direct.
    trustProxy: config.trustProxy ?? true,
    ajv: {
      customOptions: { useDefaults: true, removeAdditional: false, coerceTypes: false },
    },
  });

  // --- environment (injectable for tests) ---------------------------------
  const db = opts.db ?? (await createDb(config));
  const redis = opts.redis ?? createRedisClient(config, app.log);
  const docker = opts.docker ?? createDockerClient(config);
  const taskQueue = opts.taskQueue ?? createTaskQueue(config, app.log);

  const sessions = createSessionService({ db, config });
  const audit = createAuditService({ db, log: app.log });

  // RAM-G1 (boss MD 2026-10-22): product-grade host-RAM admission gate.
  // Constructed ONLY when redis has eval() (real ioredis; hermetic fakes
  // lack it → gate null → boot paths behave exactly as pre-G1, the
  // documented zero-regression isolation). In production: always on unless
  // RAM_GATE_ENABLED=false. Test seam: opts.ramGate / opts.ramGateMetrics.
  // NOTE: constructed BEFORE the batch lifecycle below (it takes the gate
  // at creation time).
  const ramGateService = opts.ramGate
    ? { gate: opts.ramGate, skipped: null, decisions: () => [] }
    : (await buildRamGateService({
        db,
        redis,
        config,
        log: app.log,
        audit,
        metrics: opts.ramGateMetrics,
      }));
  if (!ramGateService.gate) {
    app.log.warn(`RAM gate OFF — ${ramGateService.skipped} (boot paths run un-gated; production always has redis eval)`);
  } else {
    app.log.info('RAM gate ON — host-RAM admission active for device/batch boots');
  }

  // BR-B3 (MD Phase 3, lane A): batch container lifecycle. The API owns the
  // Docker socket for batch containers (worker never holds it — threat T1);
  // the S4 worker container adapter reaches this surface via service-token
  // routes, and B6's UI via session routes. Faults fail closed (MD §9.1).
  //
  // The wiring is conditional on the db exposing the batch surface: a
  // non-batch db (partial test fakes, legacy schemas) must keep buildApp
  // alive — boot must never crash on a missing table (BR-B5 "non-batch db"
  // contract). With the stub, every B3 route fails closed with
  // 503 BATCH_LIFECYCLE_UNAVAILABLE instead.
  const hasBatchSurface = Boolean(
    db?.batch && db?.identity && db?.taskRun && typeof db?.resourceLease?.create === 'function',
  );
  const batchLifecycle = hasBatchSurface
    ? createBatchLifecycleService({
        db,
        docker,
        config,
        lease: createLeaseService({ db }),
        audit,
        log: app.log,
        // test seam: hermetic suites inject a canned ADB probe (the default is a
        // real node:net handshake to 127.0.0.1 — no container in the test host).
        healthProbe: opts.batchLifecycleHealthProbe,
        // RAM-G1: host-RAM admission gate (null = pre-G1 behaviour).
        ramGate: ramGateService.gate,
      })
    : createUnavailableBatchLifecycle();
  const rateLimiter = createRateLimiter({ limit: 5, windowMs: 60_000 });
  // P5 hardening (Mobile Console MD §11.9: rate limit stream create +
  // notification creation). Per-user, per-process (same MVP trade-off as the
  // login limiter). Counts EVERY request (valid or not) — unlike the login
  // brute-force gate, a flood of valid credentials must still be throttled.
  //   - streamCreateLimiter: 10/min/user on POST /devices/redroid/:id/streams
  //     (the 5-slot global cap is the second, authoritative layer).
  //   - interventionCreateLimiter: 30/min/user on POST /manual-interventions
  //     (controlled-signal entry; prevents notification-storm self-abuse,
  //     MD §6.3).
  const streamCreateLimiter = createRequestLimiter({ limit: 10, windowMs: 60_000 });
  const interventionCreateLimiter = createRequestLimiter({ limit: 30, windowMs: 60_000 });
  const dockerService = createDockerService({ docker, db, config, log: app.log, audit });

  // BR-B5 (MD §11.2/§13): batch rotation monitor + metrics — the read-only
  // surface. All probes injectable; alerts land in pino + audit (this repo
  // has no alert channel — documented in the service + runbook).
  const batchMetrics = createBatchMetricsService({
    db,
    dockerService,
    log: app.log,
    audit,
    redisPing: () => redis.ping(),
    dockerPing: () => docker.ping(),
    // test seams (all undefined in production)
    osProbe: opts.batchMetricsOsProbe,
    fsProbe: opts.batchMetricsFsProbe,
    diskPath: opts.batchMetricsDiskPath,
    limits: opts.batchMetricsLimits,
  });

  // P5 redroid (工單: device 操作全部 API 側同步 — worker 唔涉及).
  // REDROID_ADAPTER=mock → deterministic mock docker+adb+preflight (never in
  // production — config forces 'real' when NODE_ENV=production).
  const redroidEnv = config.redroidAdapter === 'mock' ? createMockRedroidEnvironment(opts.redroidMockOpts ?? {}) : null;
  if (config.redroidAdapter === 'mock') {
    app.log.warn('REDROID_ADAPTER=mock — deterministic mock redroid environment (NOT a real host; results are labelled mock)');
  }
  const redroidDocker = redroidEnv?.docker ?? docker;
  const redroidDockerService = redroidEnv
    ? createDockerService({ docker: redroidEnv.docker, db, config, log: app.log, audit })
    : dockerService;

  // MC P4 (Mobile Console MD Phase 4 / §6): human-intervention events — the
  // durable notification/audit surface on top of the reliable signals
  // (network BLOCKED/FAILED, adb offline, boot timeout). Conditional wiring
  // (same contract as the stream-lease surface): a db WITHOUT the
  // intervention tables (partial test fakes / pre-migration schemas) keeps
  // buildApp alive — with the stub every intervention route fails closed
  // 503 INTERVENTION_UNAVAILABLE and the redroid signal hooks stay inert.
  const hasInterventionSurface = Boolean(
    db?.manualIntervention && typeof db.manualIntervention.findMany === 'function' &&
    db?.manualInterventionHistory && typeof db.manualInterventionHistory.create === 'function',
  );
  const interventionService = hasInterventionSurface
    ? createInterventionService({ db, log: app.log, audit })
    : createUnavailableIntervention();
  if (hasInterventionSurface) {
    app.log.info('intervention service ON — Mobile Console human-intervention events (MD Phase 4)');
  }

  const redroidService = createRedroidService({
    db,
    docker: redroidDocker,
    dockerService: redroidDockerService,
    config,
    log: app.log,
    audit,
    // RAM-G1: host-RAM admission gate (null = pre-G1 behaviour).
    ramGate: ramGateService.gate,
    // MC P4: intervention signal hooks (persistNet BLOCKED/FAILED, adb
    // offline, boot timeout). null/unavailable stub = hooks inert.
    intervention: interventionService,
    // Mock mode: the adb engine runs through the canned mock executor (calls
    // are recorded on redroidMockEnv.adb.calls for zero-shell assertions).
    adb: redroidEnv
      ? createAdbWhitelist({
          adbBinary: config.redroidAdbBinary ?? '/usr/bin/adb',
          timeoutMs: config.redroidAdbTimeoutMs ?? 20_000,
          maxOutputBytes: config.redroidAdbMaxOutput ?? 262_144,
          logcatTailMax: config.redroidLogcatTailMax ?? 5000,
          logcatTailDefault: config.redroidLogcatTailDefault ?? 200,
          execFile: redroidEnv.adb.exec,
          log: app.log,
        })
      : undefined,
    // Stage B: in-container exec seam. Mock mode = recorder (asserted in tests);
    // real mode = undefined → the service builds a dockerode exec internally.
    exec: redroidEnv ? redroidEnv.exec.exec : undefined,
    // R3: host-side proxy-leg probe (mock mode = deterministic {ok, error}).
    proxyReachable: redroidEnv ? redroidEnv.proxyReachable : undefined,
    // R6: data-dir removal (mock mode = seam that can force the EACCES shape
    // from the R5 live finding; real mode = the guarded removeRedroidDataDir).
    removeDataDir: redroidEnv ? redroidEnv.removeDataDir : undefined,
    preflight:
      redroidEnv?.preflight ??
      ((params) =>
        runRedroidPreflight({
          config,
          docker: {
            ping: () => docker.ping(),
            // R5: read-only socket vantage for GPU runtime visibility.
            info: () =>
              docker.client
                ? docker.client.info()
                : Promise.reject(new Error('docker client not configured')),
            // R5: image arch check (read-only inspect; 'not local' = null, never a throw).
            imageArchitecture: async (name) => {
              if (!docker.client) return null;
              try {
                const meta = await docker.client.getImage(name).inspect();
                return meta?.Architecture ?? null;
              } catch (err) {
                if (err?.statusCode === 404 || /no such image/i.test(String(err?.message ?? ''))) return null;
                throw err;
              }
            },
          },
          log: app.log,
          ...params,
        })),
  });
  if (redroidEnv) app.decorate('redroidMockEnv', redroidEnv); // test seam — exists ONLY in mock mode

  // MC P1 (Mobile Console MD §4.1/§8.1): stream lease + ticket service.
  // Conditional wiring (same contract as BR-B3 batch lifecycle): a db without
  // the stream surface (partial test fakes / pre-migration schemas) must keep
  // buildApp alive — boot never crashes on a missing table. With the stub,
  // every stream route fails closed with 503 STREAM_LEASE_UNAVAILABLE.
  const hasStreamSurface = Boolean(
    db?.streamLease && typeof db.streamLease.findMany === 'function' && db?.resourceLease && typeof db.resourceLease.create === 'function',
  );
  const streamLeaseService = hasStreamSurface
    ? createStreamLeaseService({
        db,
        redis,
        config,
        log: app.log,
        audit,
        leaseService: createLeaseService({ db }),
      })
    : createUnavailableStreamLease();
  if (hasStreamSurface) {
    app.log.info(
      { maxStreams: streamLeaseService.maxStreams, ttlMs: streamLeaseService.ttlMs },
      'stream lease service ON — Mobile Console 5-screen streaming (MD §4.1)',
    );
  }

  // --- P2: stream gateway (WS upgrade auth chain + sidecar tunnel, MD §8.1) ---
  // The upgrade path cannot use Fastify hooks (raw socket), so session → user
  // is re-resolved here with the SAME session store (server-side truth, never
  // a client-supplied identity).
  const streamGateway = createStreamGateway({
    db,
    config,
    streamLeaseService,
    log: app.log,
    resolveUser: async (req) => {
      const token = parseCookies(req.headers.cookie ?? '')[SESSION_COOKIE];
      if (!token) return null;
      const result = await sessions.verify(token);
      if (result) {
        try { await sessions.touch(result.session); } catch { /* non-fatal */ }
        return result.user;
      }
      return null;
    },
  });
  buildStreamSidecarManager({ app, config, entryPath: STREAM_SIDECAR_ENTRY });
  app.decorate('streamGateway', streamGateway);

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('docker', docker);
  app.decorate('sessions', sessions);
  app.decorate('audit', audit);
  app.decorate('rateLimiter', rateLimiter);
  app.decorate('streamCreateLimiter', streamCreateLimiter);
  app.decorate('interventionCreateLimiter', interventionCreateLimiter);
  app.decorate('requireRole', requireRole);
  app.decorate('dockerService', dockerService);
  app.decorate('batchLifecycle', batchLifecycle);
  app.decorate('batchMetrics', batchMetrics);
  app.decorate('redroidService', redroidService);
  app.decorate('ramGateService', ramGateService);
  app.decorate('streamLeaseService', streamLeaseService);
  app.decorate('interventionService', interventionService);
  app.decorate('taskQueue', taskQueue);
  app.decorate('taskSseActive', 0); // P3 SSE concurrency cap counter

  // --- request id ----------------------------------------------------------
  app.addHook('onRequest', async (req) => {
    req.id = crypto.randomUUID();
    req.log = req.log.child({ requestId: req.id });
  });

  // --- origin guard (CSRF baseline) ----------------------------------------
  app.addHook('onRequest', originCheck(config));

  // --- session auth ---------------------------------------------------------
  app.addHook('onRequest', async (req, reply) => {
    // Service identity (worker→API token) wins when the header is present:
    // the hook below sets req.user = SERVICE_USER_ID on a valid token, or 401
    // on an invalid one. Runs AFTER the session hook on purpose so a token
    // always produces the deterministic non-human identity.
    if (req.headers['x-wa-service-token'] !== undefined) return;

    req.user = null;
    req.session = null;
    const path = publicPath(req.raw.url);
    if (PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return;

    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return; // unauthenticated; route guards decide 401

    try {
      const result = await sessions.verify(token);
      if (result) {
        req.user = result.user;
        req.session = result.session;
        await sessions.touch(result.session);
      }
    } catch (err) {
      // Session store unavailable (DB down): be honest, don't pretend logged-in.
      req.log.error({ error: err.message }, 'session verification unavailable');
      return reply.code(503).send({
        error: {
          code: API_ERROR.INTERNAL,
          message: 'Session store temporarily unavailable',
          requestId: req.id,
        },
      });
    }
  });

  // --- service auth (worker→API tool calls, MD §13.2) ------------------------
  app.addHook('onRequest', createServiceAuthHook(config));

  // --- response headers -----------------------------------------------------
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
  });

  // --- centralized error envelope -------------------------------------------
  app.setErrorHandler((err, req, reply) => {
    const status =
      err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;

    let code = API_ERROR.INTERNAL;
    let message = 'Internal server error';

    // Service-layer errors carry their own stable code + message (P2 docker
    // domain codes — MD §9.1). Pass through untouched.
    if (err.apiCode) {
      code = err.apiCode;
      message = err.message || code;
    } else if (err.validation) {
      code = API_ERROR.VALIDATION_ERROR;
      const details = err.validation
        .slice(0, 5)
        .map((v) => v.message)
        .join('; ');
      message = `Request validation failed: ${details}`;
    } else if (status === 404) {
      code = API_ERROR.NOT_FOUND;
      message = 'Not found';
    } else if (status === 405) {
      code = 'METHOD_NOT_ALLOWED';
      message = 'Method not allowed';
    } else if (status === 400) {
      code = API_ERROR.VALIDATION_ERROR;
      message = err.message || 'Bad request';
    } else if (status === 401) {
      code = err.code === API_ERROR.INVALID_CREDENTIALS ? API_ERROR.INVALID_CREDENTIALS : API_ERROR.UNAUTHORIZED;
      message = err.message || 'Unauthorized';
    } else if (status === 403) {
      code = err.code ?? API_ERROR.FORBIDDEN;
      message = err.message || 'Forbidden';
    } else if (status === 429) {
      code = API_ERROR.RATE_LIMITED;
      message = err.message || 'Too many requests';
    }

    if (status >= 500) {
      req.log.error({ err, code }, 'request failed');
    } else {
      req.log.warn({ code, message }, 'request rejected');
    }

    return reply.code(status).send({
      error: {
        code,
        message: status >= 500 ? message : message,
        requestId: req.id,
      },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    return reply.code(404).send({
      error: {
        code: API_ERROR.NOT_FOUND,
        message: `Route ${req.method} ${publicPath(req.raw.url)} not found`,
        requestId: req.id,
      },
    });
  });

  // --- routes ----------------------------------------------------------------
  authRoutes(app);
  const { healthRoutes } = await import('./routes/health.js');
  healthRoutes(app);
  containerRoutes(app);
  templateRoutes(app);
  redroidTemplateRoutes(app);
  redroidDeviceRoutes(app);
  taskRoutes(app, { taskQueue });
  batchRoutes(app);
  scheduleRoutes(app);
  scheduleNotificationRoutes(app);
  taskDefinitionRoutes(app);
  dashboardRoutes(app);
  batchMonitorRoutes(app);
  batchContainerRoutes(app);
  networkPolicyRoutes(app);
  systemRamGateRoutes(app);
  deviceStreamRoutes(app);
  manualInterventionRoutes(app);

  // --- P2: console WS endpoint (MD §8.1) ------------------------------------
  // Raw upgrade (no Fastify route): the browser WebSocket API cannot set
  // headers, so auth = session cookie + one-shot stream_ticket cookie, all
  // re-verified server-side (streamGateway.authenticateUpgrade). After a
  // clean sidecar handshake we write the 101 and blind-pipe the two sockets;
  // the gateway never inspects stream bytes (video is NOT logged — MD §15.2).
  const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  const WS_REASONS = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };
  app.server.on('upgrade', (req, socket, head) => {
    // A raw socket with no 'error' listener crashes the WHOLE process on
    // ECONNRESET (observed live in P2 E2E: a client aborted right after a
    // 403 reject → the buffered write reset → unhandled 'error' event took
    // down the API, sidecar and every active stream). Upgrade-phase errors
    // just mean "the client went away" → destroy quietly. Once the tunnel
    // is up, pipeTunnel attaches its own (actionable) error handlers.
    socket.on('error', () => { try { socket.destroy(); } catch { /* already gone */ } });
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      socket.destroy();
      return;
    }
    // stream_leases.id is @db.Uuid (P1) — the path id MUST match the UUID
    // shape; anything else is 404 (not a stream path). [gen3 fix: the WIP
    // regex [a-z0-9]{8,64} rejected every real (hyphenated) lease id.]
    const m = /^\/api\/device-streams\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/ws$/i.exec(url.pathname);
    const reject = (status, code, message) => {
      const requestId = crypto.randomUUID();
      app.log.warn({ requestId, code, status, path: url.pathname, leaseId: m?.[1] ?? null }, 'stream ws upgrade rejected');
      try {
        socket.write(
          `HTTP/1.1 ${status} ${WS_REASONS[status] ?? 'Error'}\r\n` +
            'content-type: application/json; charset=utf-8\r\n' +
            'x-content-type-options: nosniff\r\n' +
            `x-request-id: ${requestId}\r\n` +
            'connection: close\r\n\r\n',
        );
        socket.end(JSON.stringify({ error: { code, message, requestId } }));
      } catch { /* socket already gone */ }
    };
    void (async () => {
      if (!m) return reject(404, API_ERROR.NOT_FOUND, 'not found');
      // Origin (MD §15.2): browsers MUST send Origin on WS; fail closed if absent.
      const origin = req.headers.origin;
      if (!origin || !config.allowedOrigins.includes(origin)) {
        return reject(403, 'ORIGIN_NOT_ALLOWED', 'cross-origin stream connection refused');
      }
      if (!app.streamSidecar.isReady()) {
        return reject(503, 'STREAM_SIDECAR_UNAVAILABLE', 'stream sidecar unavailable (fail-closed)');
      }
      let verdict;
      try {
        verdict = await streamGateway.authenticateUpgrade({ leaseId: m[1], req });
      } catch (e) {
        return reject(e.statusCode ?? 500, e.apiCode ?? API_ERROR.INTERNAL, e.message ?? 'stream connection rejected');
      }
      let sidecar;
      try {
        sidecar = await streamGateway.connectAndHandshake({
          lease: verdict.lease,
          device: verdict.device,
          serial: verdict.serial,
          videoSource: config.streamVideoSource,
          quality: config.streamQuality,
        });
      } catch (e) {
        return reject(e.statusCode ?? 500, e.apiCode ?? API_ERROR.INTERNAL, e.message ?? 'stream handshake failed');
      }
      // NV5b(c) 「成功 handshake 先消耗」: the ticket is burned ONLY now that
      // the sidecar tunnel is live. A failed handshake above leaves the
      // ticket spendable (retry inside the TTL without a fresh /reconnect).
      // A concurrent duplicate that raced past validation loses here and
      // tears its fresh sidecar socket down (fail closed).
      try {
        await streamLeaseService.consumeTicket({ ticket: verdict.ticket });
      } catch (e) {
        try { sidecar.sock.destroy(); } catch { /* ignore */ }
        return reject(e.statusCode ?? 500, e.apiCode ?? API_ERROR.INTERNAL, e.message ?? 'stream ticket consumption failed');
      }
      // 101 to the browser (manual upgrade — we own the response).
      const accept = crypto.createHash('sha1').update(String(req.headers['sec-websocket-key'] ?? '') + WS_GUID).digest('base64');
      try {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
            'upgrade: websocket\r\n' +
            'connection: Upgrade\r\n' +
            `sec-websocket-accept: ${accept}\r\n\r\n`,
        );
      } catch { return; }
      // Bytes already buffered from the client go to the sidecar FIRST.
      if (head && head.length) {
        try { sidecar.sock.write(head); } catch { /* race — tunnel teardown handles it */ }
      }
      streamGateway.pipeTunnel({ clientSock: socket, sidecar, lease: verdict.lease, user: verdict.user });
      app.log.info(
        { leaseId: verdict.lease.id, deviceId: verdict.device.id, userId: verdict.user.id, mode: verdict.lease.mode },
        'stream ws live',
      );
      void audit({
        actorUserId: verdict.user.id,
        action: 'stream.connect',
        resourceType: 'StreamLease',
        resourceId: verdict.lease.id,
        requestId: null,
        ip: req.socket?.remoteAddress ?? null,
        status: 'ok',
        details: { deviceId: verdict.device.id, mode: verdict.lease.mode, videoSource: config.streamVideoSource, quality: config.streamQuality },
      }).catch(() => {});
    })().catch((e) => {
      app.log.error({ error: e.message }, 'stream ws upgrade handler crashed');
      try { socket.destroy(); } catch { /* ignore */ }
    });
  });

  // MC P1 (MD §10): reconcile BEFORE the first request — the previous (dead)
  // API process's leases cannot be assumed alive; then run the expiry sweep.
  app.addHook('onReady', async () => {
    if (hasStreamSurface) {
      try {
        await streamLeaseService.reconcileStartup();
      } catch (e) {
        app.log.error({ error: e.message }, 'stream lease startup reconcile FAILED (streams may show stale leases)');
      }
      streamLeaseService.startReconciler();
    }
    // MC P2: sidecar (no-op 'disabled' when STREAM_SIDECAR_TOKEN is unset —
    // console streaming stays fail-closed 503 in that case).
    try {
      await app.streamSidecar.start();
    } catch (e) {
      app.log.error({ error: e.message }, 'stream sidecar startup FAILED (console streaming fail-closed)');
    }
  });

  // --- lifecycle ---------------------------------------------------------------
  app.addHook('onClose', async () => {
    ramGateService.gate?.stop?.();
    await closeDb(db);
    await closeRedis(redis);
    await closeTaskQueue(taskQueue);
  });

  // NOTE: no app.ready() here — callers (tests) may register extra routes
  // before the first request; fastify boots lazily on listen()/inject().
  return app;
}
