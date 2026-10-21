/**
 * Batch Rotation domain constants (施工 MD §3/§4/§6/§9) — BR-B1.
 *
 * Split from index.js on purpose (same acyclic pattern as task-constants.js):
 * batch-constants.js has ZERO intra-package imports.
 *
 * Status columns are TEXT in the DB (R3 precedent, devices.net_state): the
 * legal state sets below are the single source of truth, and extending a
 * state must not require a Postgres enum migration.
 */
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------- identity FSM
// MD §6.1. Terminal set drives batch completion (MD §3.3):
// a batch is complete only when every membership is in IDENTITY_TERMINAL.
export const IDENTITY_STATUS = Object.freeze([
  'DISABLED',
  'READY',
  'RESERVED',
  'RUNNING',
  'CANCELLING',
  'COMPLETED',
  'RETRY_WAIT',
  'RECOVERING',
  'FAILED_FINAL',
  'CANCELLED',
  'SKIPPED',
]);

/** Terminal (closed-leaf or re-arm-able) identity states, MD §3.3. */
export const IDENTITY_TERMINAL = Object.freeze(['COMPLETED', 'FAILED_FINAL', 'CANCELLED', 'SKIPPED']);

/**
 * Legal identity transitions (MD §6.1 graph).
 * Extensions beyond the drawn graph (documented, all audited via state_events):
 *  - FAILED_FINAL → RESERVED : manual retry (MD §10 POST /api/task-runs/:id/retry)
 *  - CANCELLED/SKIPPED → READY : re-arm for a future cycle
 *  - RECOVERING → CANCELLED : recovery pass finds a pending cancel
 *  - RESERVED → CANCELLED : MD §6.1 direct cancel edge (no CANCELLING detour
 *    before the run started)
 */
export const IDENTITY_TRANSITIONS = Object.freeze({
  DISABLED: ['READY'],
  READY: ['RESERVED', 'DISABLED', 'CANCELLED', 'SKIPPED'],
  RESERVED: ['RUNNING', 'RETRY_WAIT', 'FAILED_FINAL', 'CANCELLED'],
  RUNNING: ['COMPLETED', 'RETRY_WAIT', 'FAILED_FINAL', 'CANCELLING', 'RECOVERING'],
  CANCELLING: ['CANCELLED'],
  RECOVERING: ['RUNNING', 'RETRY_WAIT', 'FAILED_FINAL', 'CANCELLED'],
  RETRY_WAIT: ['RESERVED', 'FAILED_FINAL', 'CANCELLED'],
  COMPLETED: [],
  FAILED_FINAL: ['RESERVED'],
  CANCELLED: ['READY'],
  SKIPPED: ['READY'],
});

/** Identity types the registry allowlists (MD §9.1: only registry types). */
export const IDENTITY_TYPE_REGISTRY = Object.freeze(['qa_device', 'staging_user']);

// ---------------------------------------------------------------- batch FSM
export const BATCH_STATUS = Object.freeze([
  'PLANNED',
  'RUNNING',
  'PAUSED',
  'CANCELLING',
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
  'CANCELLED',
]);

export const BATCH_TERMINAL = Object.freeze(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED']);

/**
 * Legal batch transitions (MD §3.3/§7.2).
 * stop_batch failure_policy parks the batch in PAUSED (human judgement);
 * continue_and_report ends in COMPLETED_WITH_ERRORS (failures never masquerade
 * as success, MD §1.1/§3.3).
 */
export const BATCH_TRANSITIONS = Object.freeze({
  PLANNED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['PAUSED', 'CANCELLING', 'COMPLETED', 'COMPLETED_WITH_ERRORS'],
  PAUSED: ['RUNNING', 'CANCELLED', 'CANCELLING'],
  CANCELLING: ['CANCELLED'],
  COMPLETED: [],
  COMPLETED_WITH_ERRORS: [],
  CANCELLED: [],
});

/** MD §3.3 failure policies. */
export const FAILURE_POLICY = Object.freeze(['stop_batch', 'continue_and_report']);

// ---------------------------------------------------------------- capacity
/**
 * MD §3.1: TOTAL_IDENTITIES >= 0, BATCH_SIZE >= 1, MAX_ACTIVE_CONTAINERS >= 1.
 * The ACTUAL start count is min(batch_remaining, MAX_ACTIVE_CONTAINERS,
 * configured_resource_limit) — enforced at dispatch time (B2), validated here.
 */
export function validateCapacityInput({ batchSize, maxActiveContainers, failurePolicy }) {
  const errors = [];
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    errors.push('batchSize must be an integer >= 1 (MD §3.1)');
  }
  if (!Number.isInteger(maxActiveContainers) || maxActiveContainers < 1) {
    errors.push('maxActiveContainers must be an integer >= 1 (MD §3.1)');
  }
  if (!FAILURE_POLICY.includes(failurePolicy)) {
    errors.push(`failurePolicy must be one of ${FAILURE_POLICY.join(' | ')} (MD §3.3)`);
  }
  return errors;
}

/**
 * MD §3.1/§3.2 — pure batch splitter. Stable position binding: input order is
 * the batch order (positions are 1-based per batch). Disabled / not-READY
 * identities occupy their position as SKIPPED with a reason (MD §3.2: never
 * silently rebind other identities). Nothing is dropped.
 *
 * @param {object} input
 * @param {Array<{id:string, status?:string}>} input.identities identity rows (input order = binding order)
 * @param {number} input.batchSize
 * @returns {{batchSize:number, batchCount:number, batches:Array, stats:{total:number,included:number,skipped:number}}}
 */
export function planCycle({ identities, batchSize }) {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new TypeError('planCycle: batchSize must be an integer >= 1');
  }
  if (!Array.isArray(identities)) {
    throw new TypeError('planCycle: identities must be an array');
  }
  const batches = [];
  identities.forEach((identity, i) => {
    const batchNo = Math.floor(i / batchSize) + 1;
    let batch = batches.find((b) => b.batchNo === batchNo);
    if (!batch) {
      batch = { batchNo, members: [] };
      batches.push(batch);
    }
    const status = identity?.status ?? 'READY';
    if (status === 'DISABLED') {
      batch.members.push({
        identityId: identity?.id ?? null,
        position: batch.members.length + 1,
        state: 'SKIPPED',
        skipReason: 'identity disabled',
      });
    } else if (status !== 'READY') {
      batch.members.push({
        identityId: identity?.id ?? null,
        position: batch.members.length + 1,
        state: 'SKIPPED',
        skipReason: `identity status '${status}' at planning time`,
      });
    } else {
      batch.members.push({
        identityId: identity?.id ?? null,
        position: batch.members.length + 1,
        state: 'PENDING',
        skipReason: null,
      });
    }
  });
  const flat = batches.flatMap((b) => b.members);
  return {
    batchSize,
    batchCount: batches.length,
    batches: batches.map((b) => ({ batchNo: b.batchNo, size: b.members.length, members: b.members })),
    stats: {
      total: identities.length,
      included: flat.filter((m) => m.state === 'PENDING').length,
      skipped: flat.filter((m) => m.state === 'SKIPPED').length,
    },
  };
}

// ---------------------------------------------------------------- leases
/** MD §9.6 resource types. */
export const LEASE_RESOURCE_TYPE = Object.freeze({
  CONTAINER_SLOT: 'container_slot',
  PORT: 'port',
  IDENTITY_RESERVATION: 'identity_reservation',
});

/** Slot key helper: 'slot-0' .. 'slot-(N-1)'. */
export function slotKey(index) {
  return `slot-${Number(index)}`;
}

// ---------------------------------------------------------------- task runs
/**
 * Run statuses that mean "this identity is busy" (MD §14.1: the same
 * identity may hold at most ONE active run). Deliberately includes queued
 * (a dispatched but not-yet-started run still owns the identity — two queued
 * runs for one identity would serialize into a phantom double-execution
 * window) — the engine-side concurrency_key gate (P6) excluded queued for a
 * DIFFERENT purpose (same-DEFINITION serialization); identity exclusivity is
 * stricter by design.
 */
export const IDENTITY_ACTIVE_RUN_STATUSES = Object.freeze([
  'queued',
  'running',
  'needs_approval',
  'cancel_requested',
]);

// ---------------------------------------------------------------- container labels (B3)
/**
 * MD §4.3 — every managed container MUST carry these labels. The Docker
 * Controller operates ONLY on label + DB double-verified resources (B3).
 * B3 imports these constants — do not re-spell the keys elsewhere.
 */
export const CONTAINER_LABEL_PREFIX = 'com.mirrorsocialmedia.water-army';
export const CONTAINER_LABELS = Object.freeze({
  MANAGED: `${CONTAINER_LABEL_PREFIX}.managed`, // 'true'
  IDENTITY_ID: `${CONTAINER_LABEL_PREFIX}.identity-id`,
  BATCH_ID: `${CONTAINER_LABEL_PREFIX}.batch-id`,
  TASK_RUN_ID: `${CONTAINER_LABEL_PREFIX}.task-run-id`,
  CREATED_BY: `${CONTAINER_LABEL_PREFIX}.created-by`,
});

/** Standard label set for a managed container (MD §4.3). */
export function buildContainerLabels({ identityId, batchId, taskRunId, createdBy }) {
  return {
    [CONTAINER_LABELS.MANAGED]: 'true',
    [CONTAINER_LABELS.IDENTITY_ID]: identityId,
    [CONTAINER_LABELS.BATCH_ID]: batchId,
    [CONTAINER_LABELS.TASK_RUN_ID]: taskRunId,
    [CONTAINER_LABELS.CREATED_BY]: createdBy,
  };
}

// ---------------------------------------------------------------- identity data paths (B3)
/**
 * MD §4.1 — per-identity persistent layout. The identity row's dataPath is
 * UNIQUE in the DB (no two identities ever share a writable path); the
 * fs.realpath symlink-escape check is B3's runtime responsibility
 * (docker create path), the string-level contract is here.
 */
export const IDENTITY_DATA_ROOT_DEFAULT = '/data/water_army/identities';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {string} identityId uuid
 * @param {string} [root] canonical data root
 * @returns {{data:string, artifacts:string}}
 */
export function identityDataPaths(identityId, root = IDENTITY_DATA_ROOT_DEFAULT) {
  if (typeof identityId !== 'string' || !UUID_RE.test(identityId)) {
    throw new TypeError('identityDataPaths: identityId must be a uuid');
  }
  const rootNorm = typeof root === 'string' && root.endsWith('/') ? root.slice(0, -1) : root;
  return {
    data: `${rootNorm}/${identityId}/data`,
    artifacts: `${rootNorm}/${identityId}/artifacts`,
  };
}

/**
 * String-level canonical-path validation (MD §4.1: reject '..', symlink
 * escape is checked at fs level by B3). Pure, no fs.
 *
 * @param {string} root canonical allowed root (absolute)
 * @param {string} candidate path to validate
 * @returns {{ok:boolean, reason?:string, canonical?:string}}
 */
export function validateIdentityDataPath(root, candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return { ok: false, reason: 'path is empty' };
  }
  if (typeof root !== 'string' || !root.startsWith('/')) {
    return { ok: false, reason: 'root must be an absolute path' };
  }
  if (candidate !== candidate.trim()) {
    return { ok: false, reason: 'path contains leading/trailing whitespace' };
  }
  if (candidate.includes('\0')) {
    return { ok: false, reason: 'path contains NUL byte' };
  }
  const rootNorm = root.endsWith('/') ? root.slice(0, -1) : root;
  const segments = candidate.split('/');
  if (segments.includes('..')) {
    return { ok: false, reason: 'path traversal (.. segment) rejected' };
  }
  if (!candidate.startsWith('/')) {
    return { ok: false, reason: 'path must be absolute' };
  }
  // Normalize duplicate slashes (canonical form); refuse empty segments
  // (they indicate a malformed absolute path like '/a//b' with a hole).
  const norm = segments.filter((s) => s !== '').join('/');
  if (norm.length === 0) {
    return { ok: false, reason: 'path is empty after normalization' };
  }
  const canonical = `/${norm}`;
  if (segments.slice(1).some((s) => s === '')) {
    return { ok: false, reason: 'duplicate slash in path' };
  }
  if (canonical !== rootNorm && !canonical.startsWith(`${rootNorm}/`)) {
    return { ok: false, reason: 'path escapes the identity data root' };
  }
  return { ok: true, canonical };
}

/**
 * Duplicate-mount guard (MD §4.1: 不要讓兩個 identity 同時掛載同一可寫目錄).
 * Pure: given the (id, dataPath) pairs that would be mounted, returns the
 * colliding dataPath set. Caller rejects the batch of creates on collision.
 *
 * @param {Array<{id:string, dataPath:string}>} rows
 * @returns {string[]} dataPaths claimed by more than one identity
 */
export function findDuplicateMountSources(rows) {
  const seen = new Map();
  for (const r of rows ?? []) {
    if (!r || typeof r.dataPath !== 'string' || r.dataPath.length === 0) continue;
    seen.set(r.dataPath, (seen.get(r.dataPath) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([p]) => p);
}

// ---------------------------------------------------------------- network gate (B4 seam)
/**
 * MD §5.1 — the worker-side policy gate contract.
 *
 *   networkGate(ctx) => { allowed: true }
 *                      | { allowed: false, code: string, reason?: string }
 *
 * ctx = { runId, attempt, identityId, batchId, taskType }
 *
 * A gate that CRASHES must be treated as { allowed: false, code:
 * NETWORK_POLICY_UNAVAILABLE } — fail closed, never fall back to an
 * unrestricted connection (MD §5.1/§12). B4 implements the real
 * allowlist/fail-closed policy; until then the engine defaults to
 * createAllowAllNetworkGate().
 */
export const NETWORK_GATE_ERROR = Object.freeze({
  /** Policy not loaded / gate unavailable — fail-closed. */
  POLICY_UNAVAILABLE: 'NETWORK_POLICY_UNAVAILABLE',
  /** Target not on the approved allowlist. */
  TARGET_DENIED: 'NETWORK_TARGET_DENIED',
});

/** Mock/default gate — passes everything (B4 replaces this). */
export function createAllowAllNetworkGate() {
  return async function allowAllNetworkGate() {
    return { allowed: true };
  };
}

// ---------------------------------------------------------------- ids
/** Fresh uuid (explicit id for identity rows whose dataPath depends on it). */
export function newUuid() {
  return randomUUID();
}

/**
 * Stable error for the batch/identity services (mirrors TaskRunError so the
 * API layer can shape the MD §10 error envelope from one field).
 */
export class BatchError extends Error {
  /**
   * @param {string} code e.g. 'ILLEGAL_IDENTITY_TRANSITION', 'ACTIVE_RUN_EXISTS'
   * @param {string} message
   * @param {object} [opts]
   * @param {number} [opts.status] HTTP status
   */
  constructor(code, message, { status = 400 } = {}) {
    super(message);
    this.name = 'BatchError';
    this.apiCode = code;
    this.statusCode = status;
  }
}

/** idempotencyKey contract (MD §10: POST /api/batches requires it). */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
