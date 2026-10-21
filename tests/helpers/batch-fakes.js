/**
 * Batch Rotation (BR-B1) test fakes — hermetic in-memory stand-ins for the
 * Prisma delegates the batch/lease services need.
 *
 * Kept SEPARATE from helpers/fakes.js on purpose: the shared fake is the
 * P1-P6 suite's contract; adding batch delegates there would widen the
 * regression surface of 627 existing tests for zero benefit. The fake
 * enforces the SAME constraints as the migrations (unique external_ref /
 * data_path / idempotencyKey / (cycleId,batchNo) / (resourceType,resourceKey))
 * so service tests stay honest about what Postgres would reject (P2002).
 *
 * CAS semantics mirror the real service: updateMany({where:{..., status}})
 * is a compare-and-set — the where carries the expected state.
 */
import { randomUUID } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function P2002(fields) {
  return Object.assign(new Error(`Unique constraint failed on the fields: (${fields})`), { code: 'P2002' });
}
function P2025(what) {
  return Object.assign(new Error(`${what} not found`), { code: 'P2025' });
}

/**
 * @param {object} [opts]
 * @param {Array<object>} [opts.identities]
 * @param {Array<object>} [opts.batches]
 * @param {Array<object>} [opts.batchIdentities]
 * @param {Array<object>} [opts.taskRuns]
 * @param {Array<object>} [opts.leases]
 * @param {() => Date} [opts.clock]
 */
export function makeBatchFakeDb({ identities = [], batches = [], batchIdentities = [], taskRuns = [], leases = [], clock = () => new Date() } = {}) {
  const identityRows = new Map();
  const batchRows = new Map();
  const membershipRows = [];
  const taskRunRows = [...taskRuns];
  const leaseRows = new Map(); // `${type}\u0000${key}` → row
  const eventRows = [];
  let txDepth = 0;

  for (const r of identities) identityRows.set(r.id, { ...r, updatedAt: r.updatedAt ?? clock() });
  for (const r of batches) batchRows.set(r.id, { ...r });
  for (const r of batchIdentities) membershipRows.push({ ...r });
  for (const r of leases) leaseRows.set(`${r.resourceType}\u0000${r.resourceKey}`, { ...r });

  const db = {
    __state: {
      identities: identityRows,
      batches: batchRows,
      batchIdentities: membershipRows,
      taskRuns: taskRunRows,
      leases: leaseRows,
      stateEvents: eventRows,
    },

    // ------------------------------------------------------------- identity
    identity: {
      findUnique: async ({ where }) => {
        if (where.id && identityRows.has(where.id)) return { ...identityRows.get(where.id) };
        return null;
      },
      findMany: async ({ where = {}, select } = {}) => {
        let rows = [...identityRows.values()];
        if (where.id?.in) {
          const set = new Set(where.id.in);
          rows = rows.filter((r) => set.has(r.id));
        }
        if (where.status !== undefined) rows = rows.filter((r) => r.status === where.status);
        return rows.map((r) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : { ...r }));
      },
      create: async ({ data }) => {
        const id = data.id ?? randomUUID();
        if (identityRows.has(id)) throw P2002('id');
        if (data.externalRef != null && [...identityRows.values()].some((r) => r.externalRef === data.externalRef)) {
          throw P2002('external_ref');
        }
        if (data.dataPath != null && [...identityRows.values()].some((r) => r.dataPath === data.dataPath)) {
          throw P2002('data_path');
        }
        const row = {
          id,
          externalRef: data.externalRef ?? null,
          displayName: data.displayName,
          identityType: data.identityType,
          status: data.status ?? 'READY',
          dataPath: data.dataPath,
          metadataJson: data.metadataJson ?? {},
          createdAt: data.createdAt ?? clock(),
          updatedAt: clock(),
        };
        identityRows.set(id, row);
        return { ...row };
      },
      /** CAS: where.status (when present) is the compare side. */
      updateMany: async ({ where = {}, data }) => {
        let count = 0;
        for (const row of identityRows.values()) {
          const matches =
            (where.id === undefined || row.id === where.id) &&
            (where.status === undefined || row.status === where.status);
          if (matches) {
            Object.assign(row, data, { updatedAt: data.updatedAt ?? clock() });
            count += 1;
          }
        }
        return { count };
      },
      update: async ({ where, data }) => {
        const row = identityRows.get(where.id);
        if (!row) throw P2025('identity');
        Object.assign(row, data, { updatedAt: clock() });
        return { ...row };
      },
    },

    // ---------------------------------------------------------------- batch
    batch: {
      findUnique: async ({ where }) => {
        if (where.id && batchRows.has(where.id)) return { ...batchRows.get(where.id) };
        if (where.idempotencyKey != null) {
          const found = [...batchRows.values()].find((b) => b.idempotencyKey === where.idempotencyKey);
          return found ? { ...found } : null;
        }
        return null;
      },
      findMany: async ({ where = {}, orderBy } = {}) => {
        let rows = [...batchRows.values()];
        if (where.cycleId !== undefined) rows = rows.filter((b) => b.cycleId === where.cycleId);
        if (where.status !== undefined) rows = rows.filter((b) => b.status === where.status);
        if (orderBy?.batchNo) rows.sort((a, b) => (orderBy.batchNo === 'asc' ? a.batchNo - b.batchNo : b.batchNo - a.batchNo));
        return rows.map((b) => ({ ...b }));
      },
      create: async ({ data }) => {
        const id = data.id ?? randomUUID();
        if (batchRows.has(id)) throw P2002('id');
        if (data.idempotencyKey != null && [...batchRows.values()].some((b) => b.idempotencyKey === data.idempotencyKey)) {
          throw P2002('idempotency_key');
        }
        if ([...batchRows.values()].some((b) => b.cycleId === data.cycleId && b.batchNo === data.batchNo)) {
          throw P2002('cycle_id, batch_no');
        }
        const row = {
          id,
          name: data.name,
          cycleId: data.cycleId,
          batchNo: data.batchNo,
          status: data.status ?? 'PLANNED',
          batchSize: data.batchSize,
          maxActiveContainers: data.maxActiveContainers,
          failurePolicy: data.failurePolicy,
          configJson: data.configJson ?? {},
          idempotencyKey: data.idempotencyKey ?? null,
          createdBy: data.createdBy ?? null,
          createdAt: data.createdAt ?? clock(),
          startedAt: data.startedAt ?? null,
          finishedAt: data.finishedAt ?? null,
        };
        batchRows.set(id, row);
        return { ...row };
      },
      updateMany: async ({ where = {}, data }) => {
        let count = 0;
        for (const row of batchRows.values()) {
          const matches =
            (where.id === undefined || row.id === where.id) &&
            (where.status === undefined || row.status === where.status);
          if (matches) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
      update: async ({ where, data }) => {
        const row = batchRows.get(where.id);
        if (!row) throw P2025('batch');
        Object.assign(row, data);
        return { ...row };
      },
      count: async ({ where = {} } = {}) => {
        let rows = [...batchRows.values()];
        if (where.status !== undefined) rows = rows.filter((b) => b.status === where.status);
        return { count: rows.length };
      },
    },

    // -------------------------------------------------------- batch_identity
    batchIdentity: {
      create: async ({ data }) => {
        if (membershipRows.some((m) => m.batchId === data.batchId && m.identityId === data.identityId)) {
          throw P2002('batch_id, identity_id');
        }
        if (membershipRows.some((m) => m.batchId === data.batchId && m.position === data.position)) {
          throw P2002('batch_id, position');
        }
        const row = {
          batchId: data.batchId,
          identityId: data.identityId,
          position: data.position,
          status: data.status ?? 'PENDING',
          skipReason: data.skipReason ?? null,
          createdAt: data.createdAt ?? clock(),
        };
        membershipRows.push(row);
        return { ...row };
      },
      findMany: async ({ where = {} } = {}) => {
        let rows = membershipRows;
        if (where.batchId !== undefined) rows = rows.filter((m) => m.batchId === where.batchId);
        if (where.identityId !== undefined) rows = rows.filter((m) => m.identityId === where.identityId);
        return rows.map((m) => ({ ...m }));
      },
      findFirst: async ({ where = {} } = {}) => {
        const rows = (await db.batchIdentity.findMany({ where }));
        return rows[0] ?? null;
      },
    },

    // --------------------------------------------------------------- events
    stateEvent: {
      create: async ({ data }) => {
        const row = {
          id: data.id ?? randomUUID(),
          entityType: data.entityType,
          entityId: data.entityId,
          fromState: data.fromState ?? null,
          toState: data.toState,
          reason: data.reason ?? null,
          actor: data.actor ?? null,
          correlationId: data.correlationId ?? null,
          detailsJson: data.detailsJson ?? null,
          createdAt: data.createdAt ?? clock(),
        };
        eventRows.push(row);
        return { ...row };
      },
      findMany: async ({ where = {} } = {}) => {
        let rows = eventRows;
        if (where.entityType !== undefined) rows = rows.filter((e) => e.entityType === where.entityType);
        if (where.entityId !== undefined) rows = rows.filter((e) => e.entityId === where.entityId);
        return rows.map((e) => ({ ...e }));
      },
    },

    // ------------------------------------------------------------- task_runs
    taskRun: {
      findUnique: async ({ where }) => {
        const found = taskRunRows.find((r) => r.id === where.id);
        return found ? { ...found } : null;
      },
      findFirst: async ({ where = {} } = {}) => {
        for (const r of taskRunRows) {
          if (where.identityId !== undefined && r.identityId !== where.identityId) continue;
          if (where.status?.in && !where.status.in.includes(r.status)) continue;
          if (where.id && r.id !== where.id) continue;
          return { ...r };
        }
        return null;
      },
      findMany: async ({ where = {} } = {}) => {
        return taskRunRows
          .filter((r) => {
            if (where.identityId !== undefined && r.identityId !== where.identityId) return false;
            if (where.status?.in && !where.status.in.includes(r.status)) return false;
            return true;
          })
          .map((r) => ({ ...r }));
      },
      create: async ({ data }) => {
        const row = {
          id: data.id ?? randomUUID(),
          taskDefinitionId: data.taskDefinitionId ?? null,
          scheduleId: data.scheduleId ?? null,
          batchId: data.batchId ?? null,
          identityId: data.identityId ?? null,
          status: data.status ?? 'queued',
          attempt: data.attempt ?? 1,
          maxAttempts: data.maxAttempts ?? 3,
          leaseOwner: data.leaseOwner ?? null,
          leaseExpiresAt: data.leaseExpiresAt ?? null,
          heartbeatAt: data.heartbeatAt ?? null,
          createdAt: data.createdAt ?? clock(),
          updatedAt: clock(),
        };
        taskRunRows.push(row);
        return { ...row };
      },
      update: async ({ where, data }) => {
        const row = taskRunRows.find((r) => r.id === where.id);
        if (!row) throw P2025('task run');
        Object.assign(row, data, { updatedAt: clock() });
        return { ...row };
      },
    },

    // -------------------------------------------------------- resource leases
    resourceLease: {
      findUnique: async ({ where }) => {
        const k = where.resourceType_resourceKey;
        if (k && leaseRows.has(`${k.resourceType}\u0000${k.resourceKey}`)) {
          return { ...leaseRows.get(`${k.resourceType}\u0000${k.resourceKey}`) };
        }
        return null;
      },
      create: async ({ data }) => {
        const key = `${data.resourceType}\u0000${data.resourceKey}`;
        if (leaseRows.has(key)) throw P2002('resource_type, resource_key');
        const row = {
          id: data.id ?? randomUUID(),
          resourceType: data.resourceType,
          resourceKey: data.resourceKey,
          ownerRunId: data.ownerRunId ?? null,
          ownerLabel: data.ownerLabel ?? null,
          leaseExpiresAt: data.leaseExpiresAt,
          createdAt: data.createdAt ?? clock(),
          updatedAt: clock(),
        };
        leaseRows.set(key, row);
        return { ...row };
      },
      updateMany: async ({ where = {}, data }) => {
        let count = 0;
        for (const row of leaseRows.values()) {
          const matches =
            (where.resourceType === undefined || row.resourceType === where.resourceType) &&
            (where.resourceKey === undefined || row.resourceKey === where.resourceKey) &&
            (where.ownerRunId === undefined || row.ownerRunId === where.ownerRunId) &&
            leaseWindowMatches(row.leaseExpiresAt, where.leaseExpiresAt);
          if (matches) {
            Object.assign(row, data, { updatedAt: data.updatedAt ?? clock() });
            count += 1;
          }
        }
        return { count };
      },
      deleteMany: async ({ where = {} } = {}) => {
        let count = 0;
        for (const [key, row] of [...leaseRows.entries()]) {
          const matches =
            (where.resourceType === undefined || row.resourceType === where.resourceType) &&
            (where.resourceKey === undefined || row.resourceKey === where.resourceKey) &&
            (where.ownerRunId === undefined || row.ownerRunId === where.ownerRunId);
          if (matches) {
            leaseRows.delete(key);
            count += 1;
          }
        }
        return { count };
      },
      findMany: async ({ where = {}, orderBy } = {}) => {
        let rows = [...leaseRows.values()];
        if (where.leaseExpiresAt) rows = rows.filter((r) => leaseWindowMatches(r.leaseExpiresAt, where.leaseExpiresAt));
        if (where.resourceType !== undefined) rows = rows.filter((r) => r.resourceType === where.resourceType);
        if (orderBy?.leaseExpiresAt === 'asc') rows.sort((a, b) => a.leaseExpiresAt - b.leaseExpiresAt);
        return rows.map((r) => ({ ...r }));
      },
      count: async ({ where = {} } = {}) => {
        let rows = [...leaseRows.values()];
        if (where.resourceType !== undefined) rows = rows.filter((r) => r.resourceType === where.resourceType);
        if (where.leaseExpiresAt) rows = rows.filter((r) => leaseWindowMatches(r.leaseExpiresAt, where.leaseExpiresAt));
        return { count: rows.length };
      },
    },

    /**
   * Interactive transaction (hermetic): passes the SAME db (single-process
   * fakes are atomic by construction). On throw, ALL state written inside
   * the callback is rolled back — mirroring a real Postgres transaction,
   * which is the contract the batch service relies on for createCycle.
   */
    $transaction: async (fn) => {
      const snapshot = {
        identities: new Map([...identityRows.entries()].map(([k, v]) => [k, structuredClone(v)])),
        batches: new Map([...batchRows.entries()].map(([k, v]) => [k, structuredClone(v)])),
        memberships: structuredClone(membershipRows),
        leases: new Map([...leaseRows.entries()].map(([k, v]) => [k, structuredClone(v)])),
        taskRuns: structuredClone(taskRunRows),
        events: structuredClone(eventRows),
      };
      txDepth += 1;
      try {
        return await fn(db);
      } catch (err) {
        identityRows.clear();
        for (const [k, v] of snapshot.identities) identityRows.set(k, v);
        batchRows.clear();
        for (const [k, v] of snapshot.batches) batchRows.set(k, v);
        membershipRows.length = 0;
        for (const m of snapshot.memberships) membershipRows.push(m);
        leaseRows.clear();
        for (const [k, v] of snapshot.leases) leaseRows.set(k, v);
        taskRunRows.length = 0;
        for (const r of snapshot.taskRuns) taskRunRows.push(r);
        eventRows.length = 0;
        for (const e of snapshot.events) eventRows.push(e);
        throw err;
      } finally {
        txDepth -= 1;
      }
    },
  };

  return db;
}

/** leaseExpiresAt where-clause: { lte: Date } / { gt: Date }. */
function leaseWindowMatches(value, window) {
  if (!window) return true;
  const v = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (window.lte !== undefined) {
    const l = window.lte instanceof Date ? window.lte.getTime() : new Date(window.lte).getTime();
    if (v > l) return false;
  }
  if (window.gt !== undefined) {
    const g = window.gt instanceof Date ? window.gt.getTime() : new Date(window.gt).getTime();
    if (v <= g) return false;
  }
  return true;
}

export { UUID_RE };
