/**
 * RBAC — role guard factory (施工 MD §13.2: admin / operator / viewer).
 *
 * Usage: app.get('/x', { preHandler: app.requireRole('operator') }, handler)
 * viewer < operator < admin. Unauthenticated → 401; insufficient role → 403.
 * Both responses use the standard error envelope with requestId.
 *
 * NOTE: guard must be async — see origin.js note on fastify 5 sync-hook hangs.
 */
import { ROLE_LEVEL } from '@water-army/shared';

/**
 * @param {'viewer'|'operator'|'admin'} minRole
 * @returns {import('fastify').RequestHandler}
 */
export function requireRole(minRole) {
  const required = ROLE_LEVEL[minRole];
  if (!required) {
    throw new Error(`requireRole: unknown role '${minRole}'`);
  }
  return async function roleGuard(req, reply) {
    if (!req.user) {
      return reply.code(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          requestId: req.id,
        },
      });
    }
    const have = ROLE_LEVEL[req.user.role] ?? 0;
    if (have < required) {
      req.log.info({ role: req.user.role, required: minRole }, 'rbac: insufficient role');
      return reply.code(403).send({
        error: {
          code: 'FORBIDDEN',
          message: `This action requires role '${minRole}' or higher`,
          requestId: req.id,
        },
      });
    }
  };
}
