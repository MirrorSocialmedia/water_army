/**
 * Health endpoints (施工 MD §8):
 *  - GET /api/health/live  → process alive only (200 always)
 *  - GET /api/health/ready → DB / Redis / Docker each reported independently.
 *
 * Readiness semantics:
 *  - PostgreSQL or Redis down  → 503 (the API cannot serve authenticated requests)
 *  - ONLY Docker down          → 200 + status 'degraded' + detail (work order:
 *                                "down 時 200 + degraded 明細，唔好 500")
 *  - Docker disabled by config → reported as 'disabled', not a failure
 *
 * Checks are bounded (HEALTH_CHECK_TIMEOUT_MS) so a wedged dependency can
 * never hang the probe.
 */
import { HEALTH_CHECK_TIMEOUT_MS } from '@water-army/shared';

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} name dependency name
 * @param {() => Promise<unknown>} probe
 * @returns {Promise<{status:'up'|'down'|'disabled', error?:string}>}
 */
async function check(name, probe) {
  try {
    await withTimeout(probe(), HEALTH_CHECK_TIMEOUT_MS);
    return { status: 'up' };
  } catch (err) {
    const status = err.code === 'DOCKER_DISABLED' ? 'disabled' : 'down';
    return { status, error: err.message };
  }
}

export function healthRoutes(app) {
  app.get('/api/health/live', async () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get('/api/health/ready', async (req, reply) => {
    const [postgres, redis, docker] = await Promise.all([
      check('postgres', () => app.db.$queryRaw`SELECT 1`),
      check('redis', () => app.redis.ping()),
      check('docker', () => app.docker.ping()),
    ]);

    const hardDepDown = postgres.status !== 'up' || redis.status !== 'up';
    const dockerDown = docker.status === 'down';
    const overall = hardDepDown || dockerDown ? 'degraded' : 'ok';
    const status = hardDepDown ? 503 : 200;

    if (overall === 'degraded') {
      req.log.warn(
        { postgres: postgres.status, redis: redis.status, docker: docker.status },
        'readiness degraded',
      );
    }

    return reply.code(status).send({
      status: overall,
      dependencies: { postgres, redis, docker },
      uptimeSeconds: Math.round(process.uptime()),
    });
  });
}
