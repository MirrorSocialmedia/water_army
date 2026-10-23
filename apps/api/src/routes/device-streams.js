/**
 * Device stream routes — Mobile Console (MD §8.1, ADR-019 §19.11).
 *
 *  - POST /api/devices/redroid/:id/streams — create a viewer|controller lease.
 *    Returns {lease, ticket, streamWsPath, usage}. The ticket is SINGLE-USE,
 *    60s TTL, HMAC-bound to user+device+lease+mode (MD §11.8) — it is the
 *    only credential the WS layer accepts (P2). Response carries NO adb
 *    material, NO proxy credentials, NO upstream URL (MD §8.1).
 *  - GET /api/device-streams — current lease summaries + global n/5 usage.
 *  - POST /api/device-streams/:leaseId/heartbeat — owner (or admin) extends
 *    the lease with SERVER time (MD §4.1/§8.1).
 *  - DELETE /api/device-streams/:leaseId — close + release, IDEMPOTENT (MD
 *    §8.1/§15). Owner (or admin).
 *
 * RBAC: the preHandler requires a logged-in viewer+ session (baseline); the
 * service enforces the PER-MODE rule (controller needs operator+, MD §8.1)
 * and owner/admin on lease mutation. All rejections use the fixed error
 * codes (STREAM_*) — capacity = 409 STREAM_CAPACITY_REACHED (the MD §4.1
 * "409/429 擇一固定碼" decision, ADR-019 §19.11).
 */

const UUID = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const DEVICE_ID = UUID; // devices.id is @db.Uuid (prisma schema) — reject garbage at the schema layer
const LEASE_ID = UUID; // stream_leases.id is @db.Uuid

const STREAM_CREATE_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['mode'],
  properties: {
    mode: { type: 'string', enum: ['viewer', 'controller'] },
  },
};

export function deviceStreamRoutes(app) {
  app.post(
    '/api/devices/redroid/:id/streams',
    { preHandler: app.requireRole('viewer'), schema: { body: STREAM_CREATE_BODY, params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: DEVICE_ID } } } },
    async (req, reply) => {
      const out = await app.streamLeaseService.acquire({
        deviceId: req.params.id,
        user: req.user,
        mode: req.body.mode,
        requestId: req.id,
        ip: req.ip,
      });
      // 201 = lease resource created (codebase create-route convention).
      return reply.code(201).send(out);
    },
  );

  app.get('/api/device-streams', { preHandler: app.requireRole('viewer') }, async (req) => {
    return app.streamLeaseService.list();
  });

  app.post(
    '/api/device-streams/:leaseId/heartbeat',
    { preHandler: app.requireRole('viewer'), schema: { params: { type: 'object', additionalProperties: false, required: ['leaseId'], properties: { leaseId: LEASE_ID } } } },
    async (req) => {
      return app.streamLeaseService.heartbeat({ leaseId: req.params.leaseId, user: req.user, requestId: req.id, ip: req.ip });
    },
  );

  app.delete(
    '/api/device-streams/:leaseId',
    { preHandler: app.requireRole('viewer'), schema: { params: { type: 'object', additionalProperties: false, required: ['leaseId'], properties: { leaseId: LEASE_ID } } } },
    async (req) => {
      return app.streamLeaseService.close({ leaseId: req.params.leaseId, user: req.user, reason: 'user_closed', requestId: req.id, ip: req.ip });
    },
  );
}
