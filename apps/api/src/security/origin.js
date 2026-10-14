/**
 * Origin guard — CSRF baseline for a cookie-authenticated API.
 *
 * Rules (施工 MD §13.2 "Origin/CSRF protection"):
 *  - Mutating requests (POST/PUT/PATCH/DELETE) that carry an Origin header
 *    must come from an allowed origin (APP_PUBLIC_URL + api loopback).
 *  - Requests without an Origin header are non-browser clients (curl,
 *    integration tests) — allowed; SameSite=Lax cookies cover the browser
 *    cross-site baseline.
 *  - GET requests are not origin-gated (public health, same-origin UI reads).
 */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * @param {{allowedOrigins:string[]}} config
 * @returns {import('fastify').RequestHookHandler}
 *
 * NOTE: must be async. Fastify 5 request hooks only auto-continue when the
 * hook returns a promise (or explicitly calls next) — a sync hook that just
 * returns hangs the request pipeline (verified against fastify 5.12.7).
 */
export function originCheck(config) {
  const allowed = new Set(config.allowedOrigins.map((o) => o.toLowerCase().replace(/\/+$/, '')));
  return async function originCheckHook(req, reply) {
    const origin = req.headers.origin;
    if (!origin || !MUTATING.has(req.method)) return;
    const normalized = origin.toLowerCase().replace(/\/+$/, '');
    if (!allowed.has(normalized)) {
      req.log.warn({ origin }, 'origin guard: cross-origin mutating request rejected');
      reply.code(403).send({
        error: {
          code: 'FORBIDDEN_ORIGIN',
          message: 'Cross-origin mutating request rejected',
          requestId: req.id,
        },
      });
    }
  };
}
