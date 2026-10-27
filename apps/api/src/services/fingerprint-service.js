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
  generateTemplateProfile,
  validateTemplateProfile,
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
 * @param {boolean} [deps.templateProfiles] W1b (ADR-028): new rows draw from
 *   the REAL build-profile template pool instead of the W1 synthetic
 *   generator. Existing rows are generator-sticky (drift guard regenerates
 *   with the generator recorded in the row), so flipping the switch mid-fleet
 *   is safe: old identities keep W1 semantics, new ones get real builds.
 */
export function createFingerprintService({ db, log = { info() {}, warn() {}, error() {} }, templateProfiles = false } = {}) {
  if (!db) throw new Error('createFingerprintService: db is required');

  /** Generator recorded in a stored profile (generator-sticky drift checks). */
  const rowIsTemplate = (profileJson) => Boolean(profileJson?.templateId);
  const regen = (identityId, template) => (template ? generateTemplateProfile(identityId) : generateFingerprintProfile(identityId));
  const validate = (profileJson, template) => (template ? validateTemplateProfile(profileJson) : validateFingerprintProfile(profileJson));
  /**
   * W1b collision scope (ADR-028): template profiles share fingerprint and
   * displayId ACROSS identities by design (two phones of the same model run
   * the same build — the REAL-world relation a platform expects). Only the
   * per-device serial must stay unique fleet-wide. W1 rows keep the full
   * UNIQUE_PROFILE_FIELDS scope (synthetic builds have no sharing semantics).
   */
  function scopedCollisions(entries) {
    const all = entries.map((e) => ({ ...e, profile: e.profile }));
    const serialOnly = all.filter((e) => e.profile?.serial); // both generators: serial always per-device
    const w1 = all.filter((e) => !e.profile?.templateId);
    const a = findProfileCollisions(serialOnly, ['serial']);
    const b = findProfileCollisions(w1, UNIQUE_PROFILE_FIELDS);
    return { collisions: [...a.collisions, ...b.collisions] };
  }

  /**
   * Ensure the identity's fingerprint profile exists and matches the
   * deterministic generator. Idempotent: N calls → same row (this is what
   * makes device recreate stable). Fail-closed on drift or malformed rows.
   */
  async function ensureProfile(identityId) {
    const identity = await db.identity.findUnique({ where: { id: identityId } });
    if (!identity) throw fail('FINGERPRINT_IDENTITY_NOT_FOUND', 404, `Identity ${identityId} not found — cannot generate fingerprint profile`);

    const existing = await db.identityFingerprint.findUnique({ where: { identityId } });
    if (existing) {
      const template = rowIsTemplate(existing.profileJson);
      const problems = validate(existing.profileJson, template);
      if (problems.length) {
        throw fail('FINGERPRINT_PROFILE_INVALID', 500, `Stored fingerprint profile for ${identityId} is invalid: ${problems.join('; ')}`);
      }
      // Drift guard: the row MUST equal deterministic regeneration BY ITS OWN
      // GENERATOR (generator-sticky — W1 rows vs W1b template rows never
      // cross-compare). Divergence means someone edited the row or a generator
      // changed — fail closed rather than silently boot a device on an unknown
      // profile.
      const expected = regen(identityId, template);
      if (template) {
        if (JSON.stringify(existing.profileJson) !== JSON.stringify(expected)) {
          throw fail('FINGERPRINT_PROFILE_DRIFT', 500, `Stored fingerprint profile for ${identityId} diverges from deterministic regeneration — refusing to guess (fix or delete the row)`);
        }
      } else {
        const storedKey = JSON.stringify(PROFILE_FIELDS.map((f) => existing.profileJson[f]));
        const expectedKey = JSON.stringify(PROFILE_FIELDS.map((f) => expected[f]));
        if (storedKey !== expectedKey) {
          throw fail('FINGERPRINT_PROFILE_DRIFT', 500, `Stored fingerprint profile for ${identityId} diverges from deterministic regeneration — refusing to guess (fix or delete the row)`);
        }
      }
      return existing;
    }

    const expected = regen(identityId, templateProfiles);

    // Pre-check collisions against the fleet (the DB unique guards below are
    // the authoritative race-safe layer; this yields the readable error).
    const others = await db.identityFingerprint.findMany();
    const { collisions } = scopedCollisions([
      ...others.map((r) => ({ identityId: r.identityId, profile: r.profileJson })),
      { identityId, profile: expected },
    ]);
    if (collisions.length) {
      throw fail(
        'FINGERPRINT_COLLISION',
        409,
        `Generated profile collides with existing identities on: ${collisions.map((c) => `${c.field}(${c.identityIds.join(',')})`).join('; ')}`,
        { collisions: collisions.slice(0, 10) },
      );
    }

    try {
      // schemaVersion 2 = W1b template-backed profile (ADR-028); 1 = W1 synthetic
      return await db.identityFingerprint.create({ data: { ...profileToColumns(identityId, expected), schemaVersion: templateProfiles ? 2 : 1, createdAt: new Date(), updatedAt: new Date() } });
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
    const { collisions } = scopedCollisions([
      ...stored.map((r) => ({ identityId: r.identityId, profile: r.profileJson })),
      ...candidates,
    ]);
    return { collisions, blocking: collisions.some((c) => c.uniqueField) };
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
