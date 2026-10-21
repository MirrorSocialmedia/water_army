/**
 * Batch Rotation container lifecycle — PURE decision helpers (BR-B3, MD
 * Phase 3: Docker / identity data lifecycle).
 *
 * Side-effect-free by design (hermetically unit-testable, same pattern as
 * batch-constants.js): the API's batch-lifecycle-service.js and the
 * worker's container adapter both import these verdicts so the docker-side
 * and DB-side never disagree about WHAT a container means.
 *
 * The two ownership halves (MD §4.3):
 *   - container labels  : com.mirrorsocialmedia.water-army.* (batch-constants)
 *   - DB row            : task_runs (batchId/identityId lineage + containerId)
 * An operation is legal ONLY when both agree — never a single source.
 */
import { CONTAINER_LABELS } from './batch-constants.js';
import { TASK_RUN_TERMINAL } from './task-constants.js';

// --------------------------------------------------------------------------
// Stable error codes (MD §10 error envelope — the API maps these to HTTP)
// --------------------------------------------------------------------------
export const BATCH_LIFECYCLE_ERROR = Object.freeze({
  /** run id unknown, or not a batch run (no batchId/identityId lineage). */
  RUN_NOT_FOUND: 'RUN_NOT_FOUND',
  /** the run is not in a state that lifecycle ops serve (e.g. already terminal). */
  RUN_STATE_INVALID: 'RUN_STATE_INVALID',
  /** identity row missing or not READY-family at create time. */
  IDENTITY_INVALID: 'IDENTITY_INVALID',
  /** image not on the admin allowlist (MD §12: 明確啟用, no user input). */
  IMAGE_NOT_ALLOWLISTED: 'IMAGE_NOT_ALLOWLISTED',
  /** no allowlist configured at all — fail closed, never default-open. */
  IMAGE_ALLOWLIST_UNAVAILABLE: 'IMAGE_ALLOWLIST_UNAVAILABLE',
  /** identity.dataPath failed string-level validation (corrupt row). */
  VOLUME_PATH_INVALID: 'VOLUME_PATH_INVALID',
  /** fs-level check: the path is (or resolves through) a symlink escaping
   *  the data root (MD §4.1) — security event, refused. */
  VOLUME_SYMLINK_ESCAPE: 'VOLUME_SYMLINK_ESCAPE',
  /** another live managed container already mounts the same writable source
   *  (MD §4.1: 唔好讓兩個 identity 同時掛載同一可寫目錄). */
  MOUNT_SOURCE_CONFLICT: 'MOUNT_SOURCE_CONFLICT',
  /** label ↔ DB double check failed (MD §4.3) — the operation is REFUSED and
   *  audited; the container is never touched. */
  CONTAINER_OWNERSHIP_MISMATCH: 'CONTAINER_OWNERSHIP_MISMATCH',
  /** the container exists but is in a state that forbids the requested op. */
  CONTAINER_STATE_INVALID: 'CONTAINER_STATE_INVALID',
  /** host-port pool has no free port left (MD §5.2 bounded range). */
  PORT_POOL_EXHAUSTED: 'PORT_POOL_EXHAUSTED',
  /** the daemon refused the port binding (collision the pre-check missed). */
  PORT_BIND_FAILED: 'PORT_BIND_FAILED',
  /** create/start failed for an engine-classified reason (code is attached). */
  CONTAINER_OP_FAILED: 'CONTAINER_OP_FAILED',
  /** purge dry-run/confirm contract violated (MD §4.2). */
  PURGE_CONFIRM_REQUIRED: 'PURGE_CONFIRM_REQUIRED',
  /** reconcile requested fix on a non-admin (or service) identity. */
  RECONCILE_FIX_FORBIDDEN: 'RECONCILE_FIX_FORBIDDEN',
});

export const BATCH_LIFECYCLE_ERROR_STATUS = Object.freeze({
  [BATCH_LIFECYCLE_ERROR.RUN_NOT_FOUND]: 404,
  [BATCH_LIFECYCLE_ERROR.RUN_STATE_INVALID]: 409,
  [BATCH_LIFECYCLE_ERROR.IDENTITY_INVALID]: 409,
  [BATCH_LIFECYCLE_ERROR.IMAGE_NOT_ALLOWLISTED]: 403,
  [BATCH_LIFECYCLE_ERROR.IMAGE_ALLOWLIST_UNAVAILABLE]: 503,
  [BATCH_LIFECYCLE_ERROR.VOLUME_PATH_INVALID]: 500,
  [BATCH_LIFECYCLE_ERROR.VOLUME_SYMLINK_ESCAPE]: 500,
  [BATCH_LIFECYCLE_ERROR.MOUNT_SOURCE_CONFLICT]: 409,
  [BATCH_LIFECYCLE_ERROR.CONTAINER_OWNERSHIP_MISMATCH]: 409,
  [BATCH_LIFECYCLE_ERROR.CONTAINER_STATE_INVALID]: 409,
  [BATCH_LIFECYCLE_ERROR.PORT_POOL_EXHAUSTED]: 503,
  [BATCH_LIFECYCLE_ERROR.PORT_BIND_FAILED]: 503,
  [BATCH_LIFECYCLE_ERROR.CONTAINER_OP_FAILED]: 502,
  [BATCH_LIFECYCLE_ERROR.PURGE_CONFIRM_REQUIRED]: 400,
  [BATCH_LIFECYCLE_ERROR.RECONCILE_FIX_FORBIDDEN]: 403,
});

/** Error carrying a stable API code (the API error handler passes it through). */
export class BatchLifecycleError extends Error {
  constructor(code, message, { status, details } = {}) {
    super(message ?? code);
    this.name = 'BatchLifecycleError';
    this.apiCode = code;
    this.statusCode = status ?? BATCH_LIFECYCLE_ERROR_STATUS[code] ?? 500;
    this.details = details ?? undefined;
  }
}

// --------------------------------------------------------------------------
// AppSetting key (admin-managed image allowlist, MD §12)
// --------------------------------------------------------------------------
export const APP_SETTING_BATCH_CONTAINER_IMAGE_ALLOWLIST =
  'batch.container_image_allowlist';

// --------------------------------------------------------------------------
// Container naming (deterministic — the daemon's name-uniqueness is the
// durable double-click backstop, same lesson as the P2 create path)
// --------------------------------------------------------------------------
const NAME_PREFIX_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

/**
 * @param {string} runId task run uuid
 * @param {number} attempt
 * @param {string} [prefix] e.g. 'wa-batch-' (config; must be docker-name-safe)
 * @returns {string} docker container name (<= 255 chars, name-safe)
 */
export function containerNameForRun(runId, attempt, prefix = 'wa-batch-') {
  if (typeof runId !== 'string' || runId.length < 8) {
    throw new TypeError('containerNameForRun: runId must be a non-trivial id');
  }
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TypeError('containerNameForRun: attempt must be an integer >= 1');
  }
  if (typeof prefix !== 'string' || !NAME_PREFIX_RE.test(prefix)) {
    throw new TypeError('containerNameForRun: bad name prefix');
  }
  const name = `${prefix}${runId}-a${attempt}`;
  if (name.length > 255) return `${prefix}${runId.slice(0, 8)}-a${attempt}`;
  return name;
}

// --------------------------------------------------------------------------
// Host-port allocation (MD §5.2 — atomic via ResourceLease in the service;
// the pure half lives here)
// --------------------------------------------------------------------------
/**
 * @param {string} spec '16370-16419' (or a single port '16370')
 * @returns {{start:number, end:number}|null}
 */
export function parsePortRange(spec) {
  if (typeof spec !== 'string') return null;
  const m = spec.trim().match(/^([0-9]+)(?:-([0-9]+))?$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : start;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 1 || end > 65535 || start > end) return null;
  return { start, end };
}

/**
 * Smallest port in [start, end] not in `taken` (already-leased per DB) and
 * not in `occupied` (observed on the host). Deterministic + pure.
 * @returns {number|null}
 */
export function pickAvailablePort(start, end, taken, occupied) {
  const blocked = new Set([...(taken ?? []), ...(occupied ?? [])].map((p) => Number(p)));
  for (let p = start; p <= end; p += 1) {
    if (!blocked.has(p)) return p;
  }
  return null;
}

// --------------------------------------------------------------------------
// Ownership double check (MD §4.3) — the core B3 gate
// --------------------------------------------------------------------------
/**
 * Verdict for one (container, run) pair. `labels` is the container's live
 * label map (from inspect); `run` is the DB task-run row; `containerId` is
 * the inspected container's id.
 *
 *   'ok'        labels agree with the run lineage AND the run row records
 *               this exact container (containerId) — full double verification.
 *   'label-only' labels agree with the run lineage, but the run row has no
 *               containerId yet (the create→DB-write crash window). Only the
 *               create/bind path may act on this; destructive ops refuse.
 *   'mismatch'  any disagreement (missing managed label, uuid drift, run
 *               bound to a DIFFERENT container) — refuse + audit, never touch.
 *
 * @returns {{verdict:'ok'|'label-only'|'mismatch', problems:string[]}}
 */
export function ownershipVerdict(labels, run, containerId) {
  const problems = [];
  const L = labels ?? {};
  if (String(L[CONTAINER_LABELS.MANAGED]) !== 'true') {
    problems.push('missing/false managed label');
  }
  if (!run || typeof run !== 'object') {
    problems.push('run row missing');
    return { verdict: 'mismatch', problems };
  }
  if (!run.id || !run.identityId || !run.batchId) {
    problems.push('run has no batch lineage (not a batch run)');
    return { verdict: 'mismatch', problems };
  }
  if (L[CONTAINER_LABELS.IDENTITY_ID] !== undefined && L[CONTAINER_LABELS.IDENTITY_ID] !== run.identityId) {
    problems.push(`identity label '${L[CONTAINER_LABELS.IDENTITY_ID]}' != run.identityId '${run.identityId}'`);
  }
  if (L[CONTAINER_LABELS.BATCH_ID] !== undefined && L[CONTAINER_LABELS.BATCH_ID] !== run.batchId) {
    problems.push(`batch label '${L[CONTAINER_LABELS.BATCH_ID]}' != run.batchId '${run.batchId}'`);
  }
  if (L[CONTAINER_LABELS.TASK_RUN_ID] !== undefined && L[CONTAINER_LABELS.TASK_RUN_ID] !== run.id) {
    problems.push(`task-run label '${L[CONTAINER_LABELS.TASK_RUN_ID]}' != run.id '${run.id}'`);
  }
  if (
    (L[CONTAINER_LABELS.IDENTITY_ID] === undefined ||
      L[CONTAINER_LABELS.BATCH_ID] === undefined ||
      L[CONTAINER_LABELS.TASK_RUN_ID] === undefined) &&
    problems.length === 0
  ) {
    problems.push('one or more water-army labels missing');
  }
  if (problems.length > 0) return { verdict: 'mismatch', problems };

  // Labels agree. Now the DB half: does the run row record THIS container?
  if (typeof run.containerId === 'string' && run.containerId.length > 0) {
    if (containerId && run.containerId !== containerId) {
      problems.push(`run.containerId '${run.containerId}' != inspected container '${String(containerId).slice(0, 12)}…'`);
      return { verdict: 'mismatch', problems };
    }
    return { verdict: 'ok', problems: [] };
  }
  // Crash window: container exists + labels agree, but the DB write of
  // containerId never landed (worker/API died between docker create and
  // the DB update). The create/bind path may bind it; nothing else may act.
  return { verdict: 'label-only', problems: [] };
}

// --------------------------------------------------------------------------
// Reconcile classification (MD Phase 3: DB vs docker 對賬)
// --------------------------------------------------------------------------
export const RECONCILE_STATES = Object.freeze([
  'ok',              // running run (lease alive) + its container running
  'orphan',          // container exists but its run is terminal/gone → fix: stop+remove
  'stale_running',   // run non-terminal but its lease expired (worker crash) → fix: stop
  'mismatch',        // label↔DB disagreement → NEVER touched, audited
  'db_only',         // run RUNNING with containerId, but the container is gone
  'unbound',         // run RUNNING without containerId (crash window; the next
                     // attempt's create-sweep owns the cleanup)
]);

/**
 * @param {object} p
 * @param {object|null} p.run the DB task-run row for the container's
 *        task-run-id label (null = the run row is gone)
 * @param {boolean} p.containerRunning docker state running
 * @param {boolean} p.leaseAlive the run's execution lease is unexpired
 *        (true for terminal runs' historical window is irrelevant — the
 *        run's terminal status already routes to orphan below)
 * @param {string[]} p.ownershipProblems from ownershipVerdict (empty = labels
 *        agree with the run)
 * @returns {{state:string, fixable:boolean, reason:string}}
 */
export function reconcileVerdict({ run, containerRunning, leaseAlive, ownershipProblems }) {
  if (!run) {
    return {
      state: 'orphan',
      fixable: true,
      reason: 'container task-run label references a run that no longer exists',
    };
  }
  if (Array.isArray(ownershipProblems) && ownershipProblems.length > 0) {
    return {
      state: 'mismatch',
      fixable: false,
      reason: `label/DB disagreement: ${ownershipProblems.join('; ')}`,
    };
  }
  if (TASK_RUN_TERMINAL.includes(run.status)) {
    return {
      state: 'orphan',
      fixable: true,
      reason: `run is terminal (${run.status}) but its container still ${containerRunning ? 'runs' : 'exists'}`,
    };
  }
  if (!leaseAlive) {
    return {
      state: 'stale_running',
      fixable: containerRunning,
      reason: `run ${run.status} but its execution lease expired (worker crash) — re-dispatch owns the re-run; the container must not keep running`,
    };
  }
  return {
    state: 'ok',
    fixable: false,
    reason: 'run active + lease alive + container present',
  };
}

// --------------------------------------------------------------------------
// Adapter spec validation — re-exported from batch-constants.js, where it
// lives next to the noop spec validation so validateBatchConfig stays
// synchronous and batch-constants keeps its zero-intra-package-imports
// invariant.
// --------------------------------------------------------------------------
export {
  PINNED_IMAGE_RE,
  CONTAINER_HEALTH_KINDS,
  CONTAINER_WORK_KINDS,
  validateContainerAdapterConfig,
  ADB_CONTAINER_PORT_DEFAULT,
  effectiveHealthProbe,
  effectiveWorkSpec,
} from './batch-constants.js';

// --------------------------------------------------------------------------
// ADB wire-protocol handshake (health = app layer, MD §8.2)
// --------------------------------------------------------------------------
/**
 * The ADB client/server command framing: 4-hex-digit length + command
 * string. 'host:version' is answered by adbd with a length-prefixed
 * version string — the cheapest genuine APP-LAYER proof that the Android
 * side (not just the docker state) is up. Returns the raw answer bytes
 * (the caller judges it) — pure protocol constants, no I/O here.
 */
export const ADB_HOST_VERSION_CMD = '000chost:version';

/**
 * Parse an ADB handshake reply: 4-hex-digit length + payload.
 * @param {Buffer} buf
 * @returns {{ok:boolean, version:string|null, reason:string|null}}
 */
export function parseAdbVersionReply(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 5) {
    return { ok: false, version: null, reason: 'short reply (<5 bytes)' };
  }
  const lenHex = buf.subarray(0, 4).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) {
    return { ok: false, version: null, reason: 'reply is not length-prefixed' };
  }
  const len = parseInt(lenHex, 16);
  if (len === 0 || buf.length < 4 + len) {
    return { ok: false, version: null, reason: 'truncated reply payload' };
  }
  return { ok: true, version: buf.subarray(4, 4 + len).toString('utf8'), reason: null };
}
