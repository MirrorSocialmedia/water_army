/**
 * LeaseService — cross-process resource leases (施工 MD §9.6) — BR-B1.
 *
 * Covers: container slots (global concurrency limit, MD §3.1/§7.1), host
 * ports (if host-port ADB workflows return, MD §5.2) and identity
 * reservations (one active run per identity, MD §14.1).
 *
 * CAS design (no advisory locks, safe across API + worker processes):
 *   - fresh acquire  = INSERT; a P2002 unique violation means someone beat
 *     us → re-read and decide.
 *   - expired takeover = ONE statement:
 *       UPDATE ... SET owner=..., lease_expires_at=new
 *       WHERE resource_type=.. AND resource_key=.. AND lease_expires_at <= now
 *     The loser's UPDATE matches 0 rows (the winner already moved the
 *     expiry into the future) — no read-then-write window.
 *   - an EXPIRED lease is never "renewed": renewal requires the lease to be
 *     live under the caller's ownership (an expired lease goes through the
 *     takeover CAS like any other — the MD §6.2 rule that an expired lease
 *     must not be blindly re-run is enforced by the RECONCILIATION callback,
 *     which inspects container/run state before deciding).
 *
 * Zero npm dependencies: db is injected (Prisma-shaped / fake-shaped).
 */
import { BatchError } from './batch-constants.js';

const DEFAULT_TTL_MS = 5 * 60_000;

function isUuid(x) {
  return typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
}

/**
 * @param {object} deps
 * @param {object} deps.db Prisma client (or fake) — needs the resourceLease delegate
 * @param {() => Date} [deps.now] injectable clock (deterministic tests)
 * @param {number} [deps.ttlMs] default lease TTL
 */
export function createLeaseService({ db, now = () => new Date(), ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!db || typeof db.resourceLease?.findUnique !== 'function') {
    throw new TypeError('createLeaseService: db.resourceLease delegate required');
  }

  function validate({ resourceType, resourceKey }) {
    if (typeof resourceType !== 'string' || resourceType.length === 0 || resourceType.length > 64) {
      throw new BatchError('INVALID_LEASE', 'resourceType must be a 1..64 char string');
    }
    if (typeof resourceKey !== 'string' || resourceKey.length === 0 || resourceKey.length > 200) {
      throw new BatchError('INVALID_LEASE', 'resourceKey must be a 1..200 char string');
    }
  }

  function key(resourceType, resourceKey) {
    return { resourceType_resourceKey: { resourceType, resourceKey } };
  }

  /**
   * Acquire a lease (MD §9.6). Atomic across processes — see header.
   *
   * @param {object} p
   * @param {string} p.resourceType
   * @param {string} p.resourceKey
   * @param {string} [p.ownerRunId] uuid of the holding task run (null = unbound)
   * @param {string} [p.ownerLabel] worker instance id (ops visibility)
   * @param {number} [p.ttlMs]
   * @param {Date} [p.now]
   * @returns {Promise<{acquired:boolean, reason:'ACQUIRED'|'RENEWED'|'EXPIRED_TAKEOVER'|'HELD'|'RACE_LOST', lease:object|null}>}
   */
  async function acquire({ resourceType, resourceKey, ownerRunId = null, ownerLabel = null, ttlMs: t, now: when } = {}) {
    validate({ resourceType, resourceKey });
    if (ownerRunId != null && !isUuid(ownerRunId)) {
      throw new BatchError('INVALID_LEASE', 'ownerRunId must be a uuid');
    }
    const tMs = Math.max(1_000, Number(t ?? ttlMs));
    const ts = when ?? now();
    const expiry = new Date(ts.getTime() + tMs);

    let row = await db.resourceLease.findUnique({ where: key(resourceType, resourceKey) });
    if (!row) {
      try {
        row = await db.resourceLease.create({
          data: {
            resourceType,
            resourceKey,
            ownerRunId,
            ownerLabel,
            leaseExpiresAt: expiry,
          },
        });
        return { acquired: true, reason: 'ACQUIRED', lease: row };
      } catch (err) {
        if (String(err?.code ?? '') !== 'P2002') throw err;
        row = await db.resourceLease.findUnique({ where: key(resourceType, resourceKey) });
        if (!row) {
          // Vanished between the race and the re-read — one honest retry.
          return acquire({ resourceType, resourceKey, ownerRunId, ownerLabel, ttlMs: tMs, now: ts });
        }
      }
    }

    // Already ours and live → idempotent success (heartbeat-style re-acquire).
    if (ownerRunId != null && row.ownerRunId === ownerRunId && row.leaseExpiresAt.getTime() > ts.getTime()) {
      return { acquired: true, reason: 'RENEWED', lease: row };
    }
    if (row.leaseExpiresAt.getTime() > ts.getTime()) {
      return { acquired: false, reason: 'HELD', lease: row };
    }

    // Expired → single-statement CAS takeover. Loser matches 0 rows.
    const res = await db.resourceLease.updateMany({
      where: { resourceType, resourceKey, leaseExpiresAt: { lte: ts } },
      data: { ownerRunId, ownerLabel, leaseExpiresAt: expiry, updatedAt: ts },
    });
    if (res.count === 1) {
      return { acquired: true, reason: 'EXPIRED_TAKEOVER', lease: await db.resourceLease.findUnique({ where: key(resourceType, resourceKey) }) };
    }
    return { acquired: false, reason: 'RACE_LOST', lease: await db.resourceLease.findUnique({ where: key(resourceType, resourceKey) }) };
  }

  /**
   * Renew (heartbeat) — only the owner of a LIVE lease may renew (MD §6.2:
   * the worker periodically extends its own lease). An expired lease is NOT
   * renewable — it must go through the reconciliation + takeover path.
   *
   * @returns {Promise<{renewed:boolean, reason?:string, lease:object|null}>}
   */
  async function renew({ resourceType, resourceKey, ownerRunId, ttlMs: t, now: when } = {}) {
    validate({ resourceType, resourceKey });
    if (!isUuid(ownerRunId)) throw new BatchError('INVALID_LEASE', 'renew requires a uuid ownerRunId');
    const tMs = Math.max(1_000, Number(t ?? ttlMs));
    const ts = when ?? now();
    const res = await db.resourceLease.updateMany({
      where: { resourceType, resourceKey, ownerRunId, leaseExpiresAt: { gt: ts } },
      data: { leaseExpiresAt: new Date(ts.getTime() + tMs), updatedAt: ts },
    });
    if (res.count === 1) {
      return { renewed: true, lease: await db.resourceLease.findUnique({ where: key(resourceType, resourceKey) }) };
    }
    const row = await db.resourceLease.findUnique({ where: key(resourceType, resourceKey) });
    if (!row) return { renewed: false, reason: 'GONE', lease: null };
    if (row.leaseExpiresAt.getTime() <= ts.getTime()) return { renewed: false, reason: 'EXPIRED', lease: row };
    return { renewed: false, reason: 'NOT_OWNER', lease: row };
  }

  /**
   * Release — owner-only (a foreign release must never free someone else's
   * resource). Idempotent: releasing an already-gone lease is a no-op success
   * for the owner (the finally-block contract, MD §8.3).
   */
  async function release({ resourceType, resourceKey, ownerRunId } = {}) {
    validate({ resourceType, resourceKey });
    if (!isUuid(ownerRunId)) throw new BatchError('INVALID_LEASE', 'release requires a uuid ownerRunId');
    const res = await db.resourceLease.deleteMany({ where: { resourceType, resourceKey, ownerRunId } });
    return { released: res.count > 0, count: res.count };
  }

  /** Expired leases as of `now` (the reconciliation input, MD §6.2). */
  async function listExpired(when = null) {
    const ts = when ?? now();
    return db.resourceLease.findMany({ where: { leaseExpiresAt: { lte: ts } }, orderBy: { leaseExpiresAt: 'asc' } });
  }

  /**
   * Reconciliation scan (MD §6.2/§9.6). The SERVICE only scans + hands each
   * expired lease to the callback — the POLICY (check container existence,
   * run log, external side effects BEFORE any re-run decision) is the
   * caller's (B2 reconciler) and must be side-effect-free w.r.t. re-runs.
   *
   * @param {{onExpired: (lease: object) => Promise<void>|void, now?: Date}} opts
   * @returns {Promise<{scanned:number, handled:number, errors:Array<{resourceKey:string,error:string}>}>}
   */
  async function reconcile({ onExpired, now: when } = {}) {
    if (typeof onExpired !== 'function') throw new BatchError('INVALID_LEASE', 'reconcile requires onExpired(lease)');
    const expired = await listExpired(when);
    const summary = { scanned: expired.length, handled: 0, errors: [] };
    for (const lease of expired) {
      try {
        await onExpired(lease);
        summary.handled += 1;
      } catch (err) {
        summary.errors.push({ resourceKey: lease.resourceKey, error: err.message });
      }
    }
    return summary;
  }

  /** Count of LIVE leases of a type (e.g. active container slots, MD §3.1). */
  async function activeCount({ resourceType, now: when } = {}) {
    const ts = when ?? now();
    const res = await db.resourceLease.count({ where: { resourceType, leaseExpiresAt: { gt: ts } } });
    return res.count ?? res;
  }

  /**
   * Acquire the first free slot of `totalSlots` (MD §3.1/§7.1 global
   * concurrency). Sequential scan over slot-0..slot-N-1 is fine at this
   * scale (≤50); the DB unique constraint is what makes it race-safe.
   *
   * @returns {Promise<{acquired:boolean, slot?:number, reason?:string, lease?:object|null}>}
   */
  async function acquireSlot({ totalSlots, ownerRunId = null, ownerLabel = null, ttlMs, now: when } = {}) {
    if (!Number.isInteger(totalSlots) || totalSlots < 1) {
      throw new BatchError('INVALID_LEASE', 'totalSlots must be an integer >= 1');
    }
    for (let i = 0; i < totalSlots; i += 1) {
      const res = await acquire({
        resourceType: 'container_slot',
        resourceKey: `slot-${i}`,
        ownerRunId,
        ownerLabel,
        ttlMs,
        now: when,
      });
      if (res.acquired) return { acquired: true, slot: i, lease: res.lease, reason: res.reason };
    }
    return { acquired: false, reason: 'NO_SLOT', lease: null };
  }

  return {
    acquire,
    renew,
    release,
    listExpired,
    reconcile,
    activeCount,
    acquireSlot,
  };
}
