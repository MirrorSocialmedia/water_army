/**
 * W1 (ADR-025) — identity fingerprint routes.
 *
 *  - GET  /api/identities/:id/fingerprint        viewer+  → stored profile (or null)
 *  - POST /api/identities/:id/fingerprint        admin    → ensure (idempotent generate)
 *  - GET  /api/identities/fingerprints/collisions admin   → pairwise fleet audit
 *
 * The profile is DETERMINISTIC from the identityId (packages/shared
 * fingerprint-profile.js): ensure regenerates, drift-checks against any stored
 * row, and fail-closes on collision/invalid state. Real-device consumption of
 * these props is NOT VERIFIED (ADR-025 V3) — these routes expose code-level
 * truth only.
 *
 * RBAC: reads = viewer+; generate/audit = admin (profile changes what a device
 * boots as once the W1 switch is on — same authority class as templates).
 */

const IDENTITY_ID = {
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
};

const PARAMS = {
  params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: IDENTITY_ID } },
};

function profileView(row) {
  if (!row) return null;
  return {
    identityId: row.identityId,
    profile: row.profileJson,
    schemaVersion: row.schemaVersion ?? 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function identityFingerprintRoutes(app) {
  // Static route first (fastify matches static above parametric — keep the
  // literal 'fingerprints' segment from being eaten by :id).
  app.get(
    '/api/identities/fingerprints/collisions',
    { preHandler: app.requireRole('admin') },
    async () => {
      const report = await app.fingerprintService.fleetCollisionReport();
      return {
        blocking: report.blocking,
        uniqueFieldCollisions: report.collisions.filter((c) => c.uniqueField),
        informationalRepeats: report.collisions
          .filter((c) => !c.uniqueField)
          .map((c) => ({ field: c.field, value: c.value, count: c.identityIds.length })),
      };
    },
  );

  app.get('/api/identities/:id/fingerprint', { preHandler: app.requireRole('viewer'), schema: PARAMS }, async (req) => {
    const row = await app.fingerprintService.getProfile(req.params.id);
    return { profile: profileView(row) };
  });

  app.post('/api/identities/:id/fingerprint', { preHandler: app.requireRole('admin'), schema: PARAMS }, async (req) => {
    const row = await app.fingerprintService.ensureProfile(req.params.id);
    return { profile: profileView(row) };
  });
}
