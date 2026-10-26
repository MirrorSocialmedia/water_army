/**
 * W1 — identity fingerprint service (ADR-025, 2026-10-26).
 *
 * Owns the IdentityFingerprint rows: deterministic generation (materialising
 * the shared-module profile), drift detection against regeneration, and the
 * fail-closed fleet collision posture (DB unique guards + pre-check via
 * findProfileCollisions).
 *
 * Scope honesty (ADR-025 V3): this service is CODE-level truth. Whether a
 * real redroid device actually boots with these properties is an OPEN
 * verification item — never report this service alone as fingerprint evidence.
 */
import { randomUUID } from 'node:crypto';

import {
  generateFingerprintProfile,
  validateFingerprintProfile,
  findProfileCollisions,
  PROFILE_FIELDS,
  UNIQUE_PROFILE_FIELDS,
} from '@water-army/shared';
import { RedroidServiceError } from './redroid-service.js';

const fail = (code, status, message, details) => new RedroidServiceError({ code, status, message, details });

/** IdentityFingerprint row → the profile object (profileJson is the truth). */
export function rowToProfile(row) {
  return row?.profileJson ?? null;
}

/** Profile → typed IdentityFingerprint column values (unique guards). */
function profileToColumns(identityId, profile) {
  return {
    identityId,
    profileJson: profile,
    brand: profile.brand,
    model: profile.model,
    device: profile.device,
    productName: profile.productName,
    manufacturer: profile.manufacturer,
    androidRelease: profile.androidRelease,
    buildId: profile.buildId,
    displayId: profile.displayId,
    fingerprint: profile.fingerprint,
    serial: profile.serial,
    locale: profile.locale,
    timezone: profile.timezone,
    carrierName: profile.carrierName,
    carrierMcc: profile.carrierMcc,
    carrierMnc: profile.carrierMnc,
  };
}

/**
 * @param {object} deps
 * @param {object} deps.db prisma (identity / identityFingerprint models)
 * @param {object} [deps.log]
 */
export function createFingerprintService({ db, log = { info() {}, warn() {}, error() {} } } = {}) {
  if (!db) throw new Error('createFingerprintService: db is required');

  /**
   * Ensure the identity's fingerprint profile exists and matches the
   * deterministic generator. Idempotent: N calls → same row (this is what
   * makes device recreate stable). Fail-closed on drift or malformed rows.
   */
  async function ensureProfile(identityId) {
    const identity = await db.identity.findUnique({ where: { id: identityId } });
    if (!identity) throw fail('FINGERPRINT_IDENTITY_NOT_FOUND', 404, `Identity ${identityId} not found — cannot generate fingerprint profile`);

    const expected = generateFingerprintProfile(identityId);
    const existing = await db.identityFingerprint.findUnique({ where: { identityId } });
    if (existing) {
      const problems = validateFingerprintProfile(existing.profileJson);
      if (problems.length) {
        throw fail('FINGERPRINT_PROFILE_INVALID', 500, `Stored fingerprint profile for ${identityId} is invalid: ${problems.join('; ')}`);
      }
      // Drift guard: the row MUST equal deterministic regeneration. Divergence
      // means someone edited the row or the generator changed — fail closed
      // rather than silently boot a device on an unknown profile.
      const storedKey = JSON.stringify(PROFILE_FIELDS.map((f) => existing.profileJson[f]));
      const expectedKey = JSON.stringify(PROFILE_FIELDS.map((f) => expected[f]));
      if (storedKey !== expectedKey) {
        throw fail('FINGERPRINT_PROFILE_DRIFT', 500, `Stored fingerprint profile for ${identityId} diverges from deterministic regeneration — refusing to guess (fix or delete the row)`);
      }
      return existing;
    }

    // Pre-check collisions against the fleet (the DB unique guards below are
    // the authoritative race-safe layer; this yields the readable error).
    const others = await db.identityFingerprint.findMany();
    const { collisions } = findProfileCollisions([
      ...others.map((r) => ({ identityId: r.identityId, profile: r.profileJson })),
      { identityId, profile: expected },
    ], UNIQUE_PROFILE_FIELDS);
    if (collisions.length) {
      throw fail(
        'FINGERPRINT_COLLISION',
        409,
        `Generated profile collides with existing identities on: ${collisions.map((c) => `${c.field}(${c.identityIds.join(',')})`).join('; ')}`,
        { collisions: collisions.slice(0, 10) },
      );
    }

    try {
      return await db.identityFingerprint.create({ data: { ...profileToColumns(identityId, expected), createdAt: new Date(), updatedAt: new Date() } });
    } catch (err) {
      if (err?.code === 'P2002') {
        // race or a manually-seeded row — refetch once, else surface the clash
        const refetch = await db.identityFingerprint.findUnique({ where: { identityId } });
        if (refetch) return ensureProfile(identityId); // re-validates drift + shape
        const field = /serial|fingerprint|display_id/.exec(String(err?.message ?? ''))?.[0] ?? 'unknown';
        throw fail('FINGERPRINT_COLLISION', 409, `Fleet unique guard rejected the profile for ${identityId} (${field} already in use)`, { field });
      }
      throw err;
    }
  }

  /** Read a stored profile (null = not generated yet). */
  async function getProfile(identityId) {
    return db.identityFingerprint.findUnique({ where: { identityId } });
  }

  /**
   * Pairwise collision audit across all stored profiles + an optional set of
   * candidate profiles. Returns the full report (never throws — this is the
   * operator-facing fleet view).
   */
  async function fleetCollisionReport(candidates = []) {
    const stored = await db.identityFingerprint.findMany();
    return findProfileCollisions([
      ...stored.map((r) => ({ identityId: r.identityId, profile: r.profileJson })),
      ...candidates,
    ]);
  }

  /**
   * Resolve the profile to inject at device create. Fail-closed matrix:
   *  - no profile row yet → generate via ensureProfile (idempotent)
   *  - invalid / drifting → 500s (see ensureProfile), never partial injection
   */
  async function resolveForDeviceCreate(identityId) {
    const row = await ensureProfile(identityId);
    return rowToProfile(row);
  }

  return { ensureProfile, getProfile, fleetCollisionReport, resolveForDeviceCreate, __uuid: randomUUID };
}
