/**
 * T2 (ADR-029) — test-identity PROVISIONING service.
 *
 * Batch-creates N test identities with a READABLE, DETERMINISTIC naming
 * convention so the whole stack (identity.externalRef → device.name →
 * dataDir = dataRoot/<name>) is derivable by eye:
 *
 *   externalRef  = <name>        (pool entries, e.g. "qa-tk-001")
 *   device name  = <name>        (convention — the operator types it 1:1)
 *   dataPath     = <dataRoot>/<name>  (mirrors the device dataDir formula)
 *
 * Determinism everywhere (re-running the same batch is a pure no-op replay):
 *  - idempotency: existing externalRef → `replayed` (never duplicated);
 *  - fingerprint: ensureProfile() is deterministic per identityId and reuses
 *    the W1b template pool when WA_TEMPLATE_PROFILES_ENABLED is on (existing
 *    generator-sticky rows are never re-drawn);
 *  - egress pre-check: every supplied expectedEgressIp is verified UNIQUE
 *    (within the batch AND fleet-wide) BEFORE any write — a collision fails
 *    the whole call closed (zero partial provisioning). Creating the actual
 *    binding stays with PUT /api/identities/:id/egress (it owns the proxy
 *    URL encryption path; this service never touches credentials).
 */

const IDENTITY_TYPES = new Set(['qa_device', 'staging_user']);
const NAME_RE = /^redroid-[a-z0-9][a-z0-9_-]{0,39}$/; // MUST match the device-name pattern (device 1:1 with the pool entry)
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function fail(code, status, message, details) {
  const err = new Error(message);
  err.apiCode = code;
  err.httpStatus = status;
  err.statusCode = status; // app.js error envelope reads statusCode (RedroidServiceError shape)
  if (details) err.details = details;
  throw err;
}

export function createIdentityProvisionService({ db, config, log = { info() {}, warn() {}, error() {} }, audit, fingerprintService } = {}) {
  /**
   * @param {string[]} names          name pool (required, 1..100, unique)
   * @param {string}   [identityType] registry allowlist (default qa_device)
   * @param {string[]} [egressIps]    optional parallel array of expected exit
   *                                  IPs to pre-check for uniqueness
   * @param {boolean}  [dryRun]       validate + report only, zero writes
   */
  async function provision({ names, identityType = 'qa_device', egressIps, dryRun = false, actorUserId, requestId, ip } = {}) {
    if (!Array.isArray(names) || names.length === 0 || names.length > 100) {
      fail('VALIDATION_ERROR', 400, 'names must be an array of 1..100 pool entries');
    }
    if (!IDENTITY_TYPES.has(identityType)) {
      fail('VALIDATION_ERROR', 400, `identityType '${identityType}' not in allowlist (${[...IDENTITY_TYPES].join('|')})`);
    }
    const seen = new Set();
    for (const n of names) {
      if (typeof n !== 'string' || !NAME_RE.test(n)) {
        fail('VALIDATION_ERROR', 400, `name '${n}' invalid (must match the device-name pattern ^redroid-[a-z0-9][a-z0-9_-]{0,39}$ — the pool entry IS the device name)`);
      }
      if (seen.has(n)) fail('VALIDATION_ERROR', 400, `duplicate name in pool: '${n}'`);
      seen.add(n);
    }
    if (egressIps !== undefined && egressIps !== null) {
      if (!Array.isArray(egressIps) || egressIps.length !== names.length) {
        fail('VALIDATION_ERROR', 400, 'egressIps must be parallel to names (same length) or omitted');
      }
    }

    // ---- egress pre-check (BEFORE any write; fail-closed whole batch) ----
    const ipIssues = [];
    if (egressIps) {
      const ipSeen = new Map(); // ip → name (batch-internal uniqueness)
      for (const [i, ipStr] of egressIps.entries()) {
        if (ipStr === null || ipStr === undefined || ipStr === '') continue;
        if (typeof ipStr !== 'string' || !IPV4_RE.test(ipStr) || ipStr.split('.').some((o) => Number(o) > 255)) {
          ipIssues.push({ name: names[i], ip: String(ipStr).slice(0, 16), reason: 'malformed ipv4' });
          continue;
        }
        if (ipSeen.has(ipStr)) {
          ipIssues.push({ name: names[i], ip: ipStr, reason: `duplicate within batch (already claimed by ${ipSeen.get(ipStr)})` });
          continue;
        }
        ipSeen.set(ipStr, names[i]);
        const clash = await db.identityEgress.findUnique({ where: { expectedEgressIp: ipStr } }).catch(() => null);
        if (clash) ipIssues.push({ name: names[i], ip: ipStr, reason: 'already bound to another identity (fleet-wide unique)' });
      }
      if (ipIssues.length > 0) {
        fail('EGRESS_IP_PRECHECK_FAILED', 409, 'egress IP pre-check failed — no identities were created (fail-closed)', { issues: ipIssues });
      }
    }

    const items = [];
    for (const [i, name] of names.entries()) {
      const existing = await db.identity.findUnique({ where: { externalRef: name } });
      if (existing) {
        items.push({ name, identityId: existing.id, action: 'replayed', dataPath: existing.dataPath, suggestedDeviceName: name });
        continue;
      }
      const dataPath = `${config?.redroidDataRoot ?? '/var/lib/water-army/redroid'}/${name}`;
      if (dryRun) {
        items.push({ name, identityId: null, action: 'would_create', dataPath, suggestedDeviceName: name });
        continue;
      }
      const created = await db.identity.create({
        data: {
          externalRef: name,
          displayName: name,
          identityType,
          dataPath,
          // T2: fresh test identity = awaiting a human login assertion.
          loginState: 'PENDING_LOGIN',
          metadataJson: {},
        },
      });
      let fingerprint = 'skipped';
      if (fingerprintService) {
        try {
          await fingerprintService.ensureProfile(created.id);
          fingerprint = 'ensured'; // deterministic per identityId; template pool reused when enabled
        } catch (err) {
          log.warn?.({ error: err?.message, identityId: created.id }, 'provision: fingerprint ensure failed');
          fingerprint = 'failed';
        }
      }
      items.push({ name, identityId: created.id, action: 'created', dataPath, suggestedDeviceName: name, fingerprint, egressIp: egressIps?.[i] ?? null });
    }

    if (!dryRun && items.some((e) => e.action === 'created')) {
      await audit?.({
        actorUserId: actorUserId ?? null,
        action: 'identity.provision_batch',
        resourceType: 'identity',
        resourceId: null,
        requestId: requestId ?? null,
        ip: ip ?? null,
        status: 'success',
        details: { created: items.filter((e) => e.action === 'created').length, replayed: items.filter((e) => e.action === 'replayed').length, identityType },
      }).catch(() => {});
    }
    return { items, created: items.filter((e) => e.action === 'created').length, replayed: items.filter((e) => e.action === 'replayed').length, dryRun: Boolean(dryRun) };
  }

  return { provision };
}
