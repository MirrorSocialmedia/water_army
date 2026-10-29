/**
 * Unified hermetic DB for BR-B5 API integration tests (S2).
 *
 * `makeFakeDb` (fakes.js) carries all pre-B5 API delegates (users/sessions/
 * appSetting/audit/$queryRaw/…). `makeBatchFakeDb` (batch-fakes.js) carries
 * the B1 batch delegates (identity/batch/batchIdentity/stateEvent/
 * resourceLease/taskRun). The monitor surface needs BOTH, plus a few query
 * shapes neither fake had — this helper merges them:
 *
 *   - taskRun.findMany/count: where.batchId {not:null | in:[..]},
 *     orderBy {createdAt}, take/skip (the monitor sorts runs newest-first)
 *   - stateEvent.findMany: where.createdAt.gte + orderBy + take + select
 *     (the container start-duration probe)
 *   - batchIdentity.findMany: where.batchId.in (the cycle report fan-out)
 *
 * The monitor's taskRun store is the BATCH fake's (its rows carry
 * batchId/identityId/heartbeatAt/maxAttempts), so the two fakes never
 * share a table.
 */
import { makeFakeDb } from './fakes.js';
import { makeBatchFakeDb } from './batch-fakes.js';

function matchesBatchId(row, spec) {
  if (spec === undefined) return true;
  if (spec && typeof spec === 'object') {
    if ('not' in spec) return row.batchId != null;
    if ('in' in spec) return spec.in.includes(row.batchId);
  }
  return row.batchId === spec;
}

function stripBatchId(where = {}) {
  const { batchId: _b, ...rest } = where;
  return rest;
}

function sortRuns(rows, orderBy) {
  if (!orderBy) return rows;
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  for (const spec of [...specs].reverse()) {
    const [key, dir] = Object.entries(spec)[0];
    if (!key || !rows[0]?.[key]) continue;
    rows.sort((a, b) => {
      const av = new Date(a[key]).getTime() - 0 || 0;
      const bv = new Date(b[key]).getTime() - 0 || 0;
      return dir === 'asc' ? av - bv : bv - av;
    });
  }
  return rows;
}

/**
 * @param {object} [opts]
 * @param {object[]} [opts.users] makeFakeDb users seed
 * @param {object} [opts.batch] makeBatchFakeDb seed {identities, batches, batchIdentities, taskRuns, leases}
 * @param {() => Date} [opts.clock]
 */
export function makeBatchApiDb({ users = [], batch = {}, clock } = {}) {
  const db = makeFakeDb({ users });
  const bdb = makeBatchFakeDb({ ...batch, clock });

  // B1 delegates own these tables wholesale
  db.identity = bdb.identity;
  db.batch = bdb.batch;
  db.batchIdentity = bdb.batchIdentity;
  db.stateEvent = bdb.stateEvent;
  db.resourceLease = bdb.resourceLease;
  db.taskRun = bdb.taskRun;
  // WA-IPGROUP: delegate the W3 bindings table too, so the API fake can
  // exercise egress-group derivation via expectedEgressIp (layer 2).
  if (bdb.identityEgress) db.identityEgress = bdb.identityEgress;
  // WA-WARMING: createCycle writes inside db.$transaction — the base fake
  // never had one (its callers never used transactions). Delegate the BATCH
  // fake's interactive-transaction sim (was silently 500-ing POST /api/batches).
  db.$transaction = bdb.$transaction.bind(bdb);

  // ---- taskRun: + batchId / orderBy / take / skip --------------------------
  const trFindMany = bdb.taskRun.findMany.bind(bdb.taskRun);
  db.taskRun.findMany = async ({ where = {}, orderBy, take, skip } = {}) => {
    let rows = await trFindMany({ where: stripBatchId(where) });
    rows = rows.filter((r) => matchesBatchId(r, where.batchId));
    rows = sortRuns(rows, orderBy);
    if (skip) rows = rows.slice(skip);
    if (take !== undefined) rows = rows.slice(0, take);
    return rows;
  };
  const trCount = async ({ where = {} } = {}) => {
    const all = await trFindMany({ where: stripBatchId(where) });
    return all.filter((r) => matchesBatchId(r, where.batchId)).length;
  };
  db.taskRun.count = trCount;

  // ---- stateEvent: + createdAt.gte / orderBy / take / select ----------------
  const seFindMany = bdb.stateEvent.findMany.bind(bdb.stateEvent);
  db.stateEvent.findMany = async ({ where = {}, orderBy, take, select } = {}) => {
    let rows = await seFindMany({ where: { entityType: where.entityType, entityId: where.entityId } });
    if (where.createdAt?.gte) {
      const gte = new Date(where.createdAt.gte).getTime();
      rows = rows.filter((e) => new Date(e.createdAt).getTime() >= gte);
    }
    if (orderBy) rows = sortRuns(rows, orderBy);
    if (take !== undefined) rows = rows.slice(0, take);
    if (select) rows = rows.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])));
    return rows;
  };

  // ---- batchIdentity: + batchId.in ------------------------------------------
  const biFindMany = bdb.batchIdentity.findMany.bind(bdb.batchIdentity);
  db.batchIdentity.findMany = async ({ where = {} } = {}) => {
    if (where.batchId && typeof where.batchId === 'object' && Array.isArray(where.batchId.in)) {
      const rows = await biFindMany({});
      const set = new Set(where.batchId.in);
      return rows.filter((m) => set.has(m.batchId));
    }
    return biFindMany({ where });
  };

  db.__batchState = bdb.__state;
  return db;
}
