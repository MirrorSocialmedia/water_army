/**
 * Service authentication — worker→API calls (tool execution) over HTTP.
 *
 * The worker has no Docker socket (MD §4 / threat T1); its tool handlers
 * call the API's P2 endpoints with `x-wa-service-token` = WORKER_API_TOKEN.
 * A valid token mints the fixed non-human SERVICE_USER_ID (operator role).
 *
 * Security notes:
 *  - constant-time comparison (timingSafeEqual)
 *  - fail-closed: token presented but not configured on the server → 401
 *  - the service identity is REFUSED on approval endpoints (AI can never
 *    self-approve; MD §11.5) and is flagged (isService) for audit visibility
 */
import crypto from 'node:crypto';
import { SERVICE_USER_ID } from '@water-army/shared';

export const SERVICE_TOKEN_HEADER = 'x-wa-service-token';

/**
 * @param {{serviceToken?:string}} config
 * @returns {import('fastify').RequestHandler} onRequest hook
 */
export function createServiceAuthHook(config) {
  const configured = typeof config.serviceToken === 'string' && config.serviceToken.length >= 32;
  return async function serviceAuthHook(req, reply) {
    const header = req.headers[SERVICE_TOKEN_HEADER];
    if (header === undefined) return; // normal session flow

    if (!configured) {
      // Fail closed: someone is trying to use a service identity we never enabled.
      req.log.warn('service token presented but WORKER_API_TOKEN is not configured — rejecting');
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Service auth not configured', requestId: req.id },
      });
    }
    const given = Buffer.from(String(header));
    const expected = Buffer.from(config.serviceToken);
    const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!ok) {
      req.log.warn('service token rejected (mismatch)');
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Invalid service token', requestId: req.id },
      });
    }
    req.user = {
      id: SERVICE_USER_ID,
      username: 'service-worker',
      role: 'operator',
      isService: true,
    };
    req.session = null;
  };
}

/**
 * Guard for human-only actions (approvals). The service identity is
 * operator-level by RBAC, so a plain requireRole('admin') would NOT stop it —
 * this explicit refusal is the AI self-approval control (MD §11.5).
 */
export function requireHuman(req, reply) {
  if (req.user?.isService) {
    return reply.code(403).send({
      error: {
        code: 'FORBIDDEN',
        message: 'Service identities cannot perform this action (a real human is required)',
        requestId: req.id,
      },
    });
  }
  return null;
}
