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

import { PINO_REDACT_PATHS, SESSION_COOKIE, API_ERROR } from '@water-army/shared';

import { loadConfig } from './config.js';
import { createDb, closeDb } from './plugins/db.js';
import { createRedisClient, closeRedis } from './plugins/redis.js';
import { createDockerClient } from './plugins/docker.js';
import { parseCookies } from './security/cookie.js';
import { originCheck } from './security/origin.js';
import { requireRole } from './security/rbac.js';
import { createRateLimiter } from './security/rate-limit.js';
import { createAuditService } from './services/audit.js';
import { createSessionService } from './services/session.js';
import { authRoutes } from './routes/auth.js';

/** Public (unauthenticated) route prefixes — everything else may need a session. */
const PUBLIC_PREFIXES = ['/api/health', '/api/auth/login'];

function publicPath(url) {
  return (url ?? '/').split('?')[0];
}

/**
 * @param {object} [opts]
 * @param {object} [opts.config]  pre-built config (skips env loading)
 * @param {object} [opts.db]      prisma client (or fake)
 * @param {object} [opts.redis]   ioredis instance (or fake)
 * @param {object} [opts.docker]  docker client wrapper (or fake)
 * @param {boolean}[opts.registerHealth] register health routes (default true)
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function buildApp(opts = {}) {
  const config = opts.config ?? loadConfig();
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: [...PINO_REDACT_PATHS], censor: '***', removeOnly: false },
    },
    bodyLimit: 1_000_000,
    ajv: {
      customOptions: { useDefaults: true, removeAdditional: false, coerceTypes: false },
    },
  });

  // --- environment (injectable for tests) ---------------------------------
  const db = opts.db ?? (await createDb(config));
  const redis = opts.redis ?? createRedisClient(config, app.log);
  const docker = opts.docker ?? createDockerClient(config);

  const sessions = createSessionService({ db, config });
  const audit = createAuditService({ db, log: app.log });
  const rateLimiter = createRateLimiter({ limit: 5, windowMs: 60_000 });

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('docker', docker);
  app.decorate('sessions', sessions);
  app.decorate('audit', audit);
  app.decorate('rateLimiter', rateLimiter);
  app.decorate('requireRole', requireRole);

  // --- request id ----------------------------------------------------------
  app.addHook('onRequest', async (req) => {
    req.id = crypto.randomUUID();
    req.log = req.log.child({ requestId: req.id });
  });

  // --- origin guard (CSRF baseline) ----------------------------------------
  app.addHook('onRequest', originCheck(config));

  // --- session auth ---------------------------------------------------------
  app.addHook('onRequest', async (req, reply) => {
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

    if (err.validation) {
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

  // --- lifecycle ---------------------------------------------------------------
  app.addHook('onClose', async () => {
    await closeDb(db);
    await closeRedis(redis);
  });

  await app.ready();
  return app;
}
