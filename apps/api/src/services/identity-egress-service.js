/**
 * W3 (ADR-027) — identity egress binding service.
 *
 * Owns the IdentityEgressBinding rows: the per-identity PINNED egress —
 *   - proxyUrlEncrypted: the identity's egress proxy (AES-256-GCM, the SAME
 *     codec + key as Stage B redroid proxies). Ciphertext at rest. The W3
 *     RUNTIME verification path NEVER decrypts it (presence is enough — see
 *     resolveEgressExpectation); this service decrypts only to compute a
 *     one-way sha256 for change detection, and only inside the request that
 *     SET the URL.
 *   - expectedEgressIp: the ONE exit IP this identity may exit from. DB-unique
 *     fleet-wide — two identities must never share an exit IP (correlation
 *     killer).
 *
 * SECURITY POSTURE (the core W3 invariant, ADR-027 §5):
 *   - the plaintext proxy URL (with credentials) appears ONLY in the memory of
 *     the request that writes it. It is never logged, never audited, never in
 *     an error message, never in an API response.
 *   - the API surface exposes the binding WITHOUT the proxy URL: expected IP +
 *     a short hash prefix (drift/change detection aid) + timestamps + bound
 *     device count. An operator who sets the URL already knows it; the read
 *     path is zero-credential by construction.
 *   - audit events carry IPs + state codes + the hash prefix only.
 *
 * CHANGE SEMANTICS: when expectedEgressIp OR the proxy hash changes, every
 * device bound to this identity is reset to egressState=UNCHECKED — the old
 * VERIFIED evidence (observedIp === OLD expectedIp) is invalid against the new
 * expectation, so the device re-enters fail-closed until a fresh probe matches.
 */
import { createHash } from 'node:crypto';

import { encryptSecret, resolveProviderKey, checkRegionConsistency, ISO2_RE } from '@water-army/shared';
import { validateEgressIp } from './redroid-health.js';
import { RedroidServiceError, validateProxyUrl } from './redroid-service.js';

const fail = (code, status, message, details) => new RedroidServiceError({ code, status, message, details });

/** sha256 hex of a plaintext proxy URL (one-way; change detection only). */
function proxyHash(plainUrl) {
  return createHash('sha256').update(String(plainUrl), 'utf8').digest('hex');
}

/** Short, non-reversible prefix for API display (not the full hash). */
function hashShort(hash) {
  return typeof hash === 'string' && hash.length >= 16 ? hash.slice(0, 16) : hash ?? null;
}

/**
 * @param {object} deps
 * @param {object} deps.db prisma (identity / identityEgress / device models)
 * @param {object} deps.config app config (encryptionKey required)
 * @param {object} [deps.audit] audit fn (failures logged, never throw)
 * @param {object} [deps.log]
 */
export function createIdentityEgressService({ db, config, audit = null, log = { info() {}, warn() {}, error() {} } } = {}) {
  if (!db) throw new Error('createIdentityEgressService: db is required');

  function key() {
    if (!config?.encryptionKey) {
      throw fail('EGRESS_ENCRYPTION_MISSING', 500, 'APP_ENCRYPTION_KEY is not configured — cannot store an egress proxy URL');
    }
    try {
      return resolveProviderKey(config.encryptionKey);
    } catch {
      throw fail('EGRESS_ENCRYPTION_INVALID', 500, 'APP_ENCRYPTION_KEY is invalid — cannot store an egress proxy URL');
    }
  }

  async function assertIdentity(identityId) {
    const identity = await db.identity.findUnique({ where: { id: identityId } });
    if (!identity) throw fail('IDENTITY_NOT_FOUND', 404, `Identity ${identityId} not found — cannot bind egress`);
    return identity;
  }

  /**
   * The row → zero-credential API view. The proxy URL is NEVER returned —
   * only its (truncated) hash, so an operator can tell "did the proxy change?"
   * without ever seeing credentials at rest.
   */
  async function bindingView(row) {
    if (!row) return null;
    let boundDevices = 0;
    try {
      boundDevices = await db.device.count({ where: { identityId: row.identityId } });
    } catch { /* count is display-only; never fail the read */ }
    return {
      identityId: row.identityId,
      expectedEgressIp: row.expectedEgressIp,
      // WA-STEALTH-FIX2 (E): declared exit country (null = legacy / not declared).
      region: row.region ?? null,
      proxyHashShort: hashShort(row.proxyUrlHash),
      schemaVersion: row.schemaVersion ?? 1,
      firstVerifiedAt: row.firstVerifiedAt ?? null,
      lastVerifiedAt: row.lastVerifiedAt ?? null,
      boundDevices,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Reset every device bound to this identity to UNCHECKED. Called when the
   * expectation changes (IP or proxy) or the binding is deleted. Old VERIFIED
   * evidence is invalid — the device re-enters fail-closed (networkReady=false)
   * until a fresh probe matches the NEW expectation.
   */
  async function resetBoundDevices(identityId) {
    const now = new Date();
    try {
      const res = await db.device.updateMany({
        where: { identityId },
        data: {
          egressState: 'UNCHECKED',
          egressStateSince: now,
          egressConsecutiveFailures: 0,
          egressLastErrorCode: null,
          egressLastObservedIp: null,
          egressLastMatchAt: null,
        },
      });
      return res?.count ?? 0;
    } catch (err) {
      // updateMany is a best-effort consistency step; the authoritative
      // fail-closed guarantee is that the device is NOT VERIFIED until a fresh
      // probe. If the bulk reset fails, the device simply stays at its last
      // state (never silently promoted) and the next watchdog tick re-evaluates.
      log.warn({ identityId, error: err?.message }, 'identity egress: bound-device reset failed (non-fatal; watchdog will re-evaluate)');
      return null;
    }
  }

  async function writeAudit(actor, action, resourceId, status, details, requestId, ip) {
    if (!audit) return;
    try {
      await audit({ actorUserId: actor ?? null, action, resourceType: 'identity_egress_binding', resourceId, requestId: requestId ?? null, ip: ip ?? null, status, details });
    } catch { /* audit never throws */ }
  }

  /**
   * Create or update the identity's egress binding. Idempotent on identical
   * input (same URL + same IP → no-op). On a REAL change (IP or proxy hash)
   * the bound devices are reset to UNCHECKED (see above).
   *
   * @param {string} identityId
   * @param {{ proxyUrl: string, expectedEgressIp: string, region?: string, regionOverride?: boolean }} input
   * @param {object} [ctx] { actorUserId, requestId, ip }
   */
  async function upsertBinding(identityId, input, ctx = {}) {
    await assertIdentity(identityId);

    const proxyUrl = typeof input?.proxyUrl === 'string' ? input.proxyUrl.trim() : '';
    const expectedIp = typeof input?.expectedEgressIp === 'string' ? input.expectedEgressIp.trim() : '';

    // Validate the proxy URL (scheme/host/port sanity). validateProxyUrl
    // THROWS on invalid input — map it to the W3 code WITHOUT echoing the
    // submitted value (the shared error message names the format, never the
    // value — credentials stay out of every error surface).
    if (!proxyUrl) {
      throw fail('EGRESS_PROXY_INVALID', 400, 'egress proxyUrl is missing (expected socks5://[user:pass@]host:port)');
    }
    try {
      validateProxyUrl(proxyUrl);
    } catch {
      throw fail('EGRESS_PROXY_INVALID', 400, 'egress proxyUrl is invalid (expected socks5://[user:pass@]host:port — socks5 only, no spaces)');
    }
    // Validate the expected exit IP (strict dotted-quad, no leading zeros).
    const ipCheck = validateEgressIp(expectedIp);
    if (!ipCheck.ok) {
      throw fail('EGRESS_IP_INVALID', 400, `expectedEgressIp is not a valid IPv4 address (${ipCheck.error})`);
    }

    // WA-STEALTH-FIX2 (E): declared exit region + three-way consistency.
    // The profile's region is DERIVED from the fingerprint (timezone /
    // locale subtag — packages/shared/src/region.js); each axis is checked
    // INDEPENDENTLY. Mismatch → 409 unless regionOverride (admin
    // acknowledgement lands in the audit trail). No fingerprint / unknown
    // zone = unverifiable → allowed (fail-open by ruling, visible as
    // region in the view; the D2 case — Paris TZ + en-US + CN exit — breaks
    // on BOTH axes and 409s).
    const region = typeof input?.region === 'string' && input.region.trim()
      ? input.region.trim().toUpperCase()
      : null;
    if (region && !ISO2_RE.test(region)) {
      throw fail('EGRESS_REGION_INVALID', 400, 'region must be an ISO-3166 alpha-2 code (two uppercase letters, e.g. "HK")');
    }
    const regionOverride = input?.regionOverride === true;
    let regionCheck = null;
    if (region) {
      const fp = db.identityFingerprint ? await db.identityFingerprint.findUnique({ where: { identityId } }) : null;
      regionCheck = checkRegionConsistency({ egressRegion: region, timezone: fp?.timezone, locale: fp?.locale });
      if (!regionCheck.ok && !regionOverride) {
        const say = regionCheck.mismatches.map((axis) => `${axis}:${axis === 'timezone' ? regionCheck.tzRegion : regionCheck.localeRegion}`).join(', ');
        throw fail('EGRESS_REGION_MISMATCH', 409, `exit region ${region} contradicts the identity profile (${say}) — pass regionOverride=true to acknowledge`);
      }
    }

    // Correlation killer: no OTHER identity may already pin this exit IP.
    const clash = await db.identityEgress.findFirst({ where: { expectedEgressIp: expectedIp, NOT: { identityId } } });
    if (clash) {
      throw fail('EGRESS_IP_CONFLICT', 409, `exit IP ${expectedIp} is already pinned by identity ${clash.identityId} — each identity needs a UNIQUE exit IP`);
    }

    const encrypted = encryptSecret(proxyUrl, key());
    const hash = proxyHash(proxyUrl);
    const now = new Date();

    const existing = await db.identityEgress.findUnique({ where: { identityId } });
    if (!existing) {
      const row = await db.identityEgress.create({
        data: { identityId, proxyUrlEncrypted: encrypted, proxyUrlHash: hash, expectedEgressIp: expectedIp, region, createdAt: now, updatedAt: now },
      }).catch((err) => {
        if (err?.code === 'P2002') throw fail('EGRESS_IP_CONFLICT', 409, `exit IP ${expectedIp} is already pinned by another identity`);
        throw err;
      });
      if (regionOverride && regionCheck && !regionCheck.ok) {
        await writeAudit(ctx.actorUserId, 'identity.egress_region_override', identityId, 'success',
          { region, tzRegion: regionCheck.tzRegion, localeRegion: regionCheck.localeRegion, mismatches: regionCheck.mismatches }, ctx.requestId, ctx.ip);
      }
      await writeAudit(ctx.actorUserId, 'identity.egress_binding_create', identityId, 'success',
        { expectedEgressIp: expectedIp, region, proxyHashShort: hashShort(hash), action: 'create' }, ctx.requestId, ctx.ip);
      log.info({ identityId, expectedIp, region }, 'identity egress: binding created');
      return bindingView(row);
    }

    const ipChanged = existing.expectedEgressIp !== expectedIp;
    const proxyChanged = existing.proxyUrlHash !== hash;
    const regionChanged = (existing.region ?? null) !== region;
    if (!ipChanged && !proxyChanged && !regionChanged) {
      // Identical → idempotent no-op (still a valid read).
      return bindingView(existing);
    }

    const row = await db.identityEgress.update({
      where: { identityId },
      data: { proxyUrlEncrypted: encrypted, proxyUrlHash: hash, expectedEgressIp: expectedIp, region, updatedAt: now },
    }).catch((err) => {
      if (err?.code === 'P2002') throw fail('EGRESS_IP_CONFLICT', 409, `exit IP ${expectedIp} is already pinned by another identity`);
      throw err;
    });

    if (regionOverride && regionCheck && !regionCheck.ok) {
      await writeAudit(ctx.actorUserId, 'identity.egress_region_override', identityId, 'success',
        { region, tzRegion: regionCheck.tzRegion, localeRegion: regionCheck.localeRegion, mismatches: regionCheck.mismatches }, ctx.requestId, ctx.ip);
    }
    // The expectation moved → old VERIFIED evidence is void. Reset bound
    // devices to UNCHECKED (fail-closed until a fresh probe matches).
    const reset = await resetBoundDevices(identityId);
    await writeAudit(ctx.actorUserId, 'identity.egress_binding_update', identityId, 'success',
      { expectedEgressIp: expectedIp, previousEgressIp: ipChanged ? existing.expectedEgressIp : null, region, previousRegion: regionChanged ? (existing.region ?? null) : null, proxyHashShort: hashShort(hash), proxyChanged, devicesReset: reset }, ctx.requestId, ctx.ip);
    log.info({ identityId, expectedIp, ipChanged, proxyChanged, regionChanged, devicesReset: reset }, 'identity egress: binding updated (bound devices reset to UNCHECKED)');
    return bindingView(row);
  }

  /** Read the binding (null = not bound yet). Zero-credential view. */
  async function getBinding(identityId) {
    await assertIdentity(identityId);
    const row = await db.identityEgress.findUnique({ where: { identityId } });
    return bindingView(row);
  }

  /** List every binding (operator fleet view). Zero-credential. */
  async function listBindings() {
    const rows = await db.identityEgress.findMany();
    return { bindings: await Promise.all(rows.map((r) => bindingView(r))) };
  }

  /**
   * Delete the binding. Devices bound to this identity reset to UNCHECKED and
   * — because resolveEgressExpectation will now return UNBOUND — the next
   * watchdog tick stamps them UNBOUND (fail-closed, never dispatch-ready).
   */
  async function deleteBinding(identityId, ctx = {}) {
    await assertIdentity(identityId);
    const existing = await db.identityEgress.findUnique({ where: { identityId } });
    if (!existing) return { deleted: false };
    await db.identityEgress.delete({ where: { identityId } });
    const reset = await resetBoundDevices(identityId);
    await writeAudit(ctx.actorUserId, 'identity.egress_binding_delete', identityId, 'success',
      { expectedEgressIp: existing.expectedEgressIp, devicesReset: reset }, ctx.requestId, ctx.ip);
    log.info({ identityId, devicesReset: reset }, 'identity egress: binding deleted (bound devices reset to UNCHECKED)');
    return { deleted: true, devicesReset: reset };
  }

  return { upsertBinding, getBinding, listBindings, deleteBinding, __hash: proxyHash, __key: key };
}
