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

// ---------------------------------------------------------------- batch config
/**
 * Adapter registry allowlist (MD §2/§6.3: 真實 adapter 必須明確啟用 — no
 * silent fallback). B3 appends the real container adapter type here; the
 * worker's adapter registry only instantiates types in this list.
 */
export const BATCH_ADAPTER_REGISTRY = Object.freeze(['noop', 'container']);

/** Batch runs reuse the task-run attempt cap (MD §11.8 bounded retry). */
export const BATCH_MAX_ATTEMPTS_CAP = 5;

/** Defaults applied when a cycle's configJson omits a knob. */
export const BATCH_CONFIG_DEFAULTS = Object.freeze({
  /** Per-identity execution deadline (seconds). */
  timeoutSeconds: 900,
  /** Auto-retry attempts per identity (capped at BATCH_MAX_ATTEMPTS_CAP). */
  maxAttempts: 3,
  /** Seconds to wait after a batch completes before its successor starts. */
  interBatchCooldownSeconds: 0,
});

/** AppSetting key holding the global container cap (MD §3.1, admin-managed). */
export const APP_SETTING_BATCH_GLOBAL_MAX_ACTIVE = 'batch.global_max_active_containers';

/** BullMQ job name for batch runs (same queue as task runs; dispatch by name). */
export const BATCH_RUN_JOB_NAME = 'batch-run';

/**
 * Deterministic job id per batch run + attempt → idempotent enqueue
 * (BullMQ forbids ':' in custom job ids — joiner is '-', same lesson as
 * taskJobId; live-accepted 2026-10-15).
 */
export function batchJobId(runId, attempt) {
  return `batch-${runId}-${Number(attempt)}`;
}

/**
 * Validate a cycle/batch config object (MD §12: config is validated at the
 * API boundary AND re-checked by the worker before execution — hostile input
 * is assumed on both sides). Returns an error list (empty = valid).
 *
 * @param {object} config the cycle configJson (optional knobs only)
 * @returns {string[]}
 */
export function validateBatchConfig(config) {
  const errors = [];
  if (config == null) return errors; // no config = all defaults (valid)
  if (typeof config !== 'object' || Array.isArray(config)) {
    return ['config must be a plain object'];
  }
  if (config.interBatchCooldownSeconds !== undefined) {
    if (!Number.isInteger(config.interBatchCooldownSeconds) || config.interBatchCooldownSeconds < 0 || config.interBatchCooldownSeconds > 86_400) {
      errors.push('config.interBatchCooldownSeconds must be an integer 0..86400 (seconds)');
    }
  }
  if (config.timeoutSeconds !== undefined) {
    if (!Number.isInteger(config.timeoutSeconds) || config.timeoutSeconds < 1 || config.timeoutSeconds > 3_600) {
      errors.push('config.timeoutSeconds must be an integer 1..3600 (per-identity deadline)');
    }
  }
  if (config.maxAttempts !== undefined) {
    if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1 || config.maxAttempts > BATCH_MAX_ATTEMPTS_CAP) {
      errors.push(`config.maxAttempts must be an integer 1..${BATCH_MAX_ATTEMPTS_CAP}`);
    }
  }
  if (config.adapter !== undefined) {
    const a = config.adapter;
    if (typeof a !== 'object' || a === null || Array.isArray(a)) {
      errors.push('config.adapter must be a plain object { type, ... }');
    } else {
      if (typeof a.type !== 'string' || !BATCH_ADAPTER_REGISTRY.includes(a.type)) {
        errors.push(`config.adapter.type must be one of ${BATCH_ADAPTER_REGISTRY.join(' | ')} (MD §2: 明確啟用)`);
      }
      if (a.type === 'noop') {
        if (a.durationMs !== undefined && (!Number.isInteger(a.durationMs) || a.durationMs < 0 || a.durationMs > 3_600_000)) {
          errors.push('config.adapter.durationMs must be an integer 0..3600000 (noop)');
        }
        if (a.outcome !== undefined && !['ok', 'fail', 'fail_retryable'].includes(a.outcome)) {
          errors.push("config.adapter.outcome must be 'ok' | 'fail' | 'fail_retryable' (noop)");
        }
        if (a.failures !== undefined) {
          if (typeof a.failures !== 'object' || a.failures === null || Array.isArray(a.failures)) {
            errors.push('config.adapter.failures must be a { identityId: outcome } object (noop)');
          } else {
            for (const [k, v] of Object.entries(a.failures)) {
              if (typeof v !== 'string' || !['ok', 'fail', 'fail_retryable'].includes(v)) {
                errors.push(`config.adapter.failures['${k}'] must be 'ok' | 'fail' | 'fail_retryable'`);
                break;
              }
              if (k.length > 64) {
                errors.push('config.adapter.failures keys must be identity ids (<=64 chars)');
                break;
              }
            }
          }
        }
      }
      if (a.type === 'container') {
        // BR-B3: real container adapter — shape validated by the shared
        // lifecycle module (single source of truth for image/health/work).
        for (const e of validateContainerAdapterConfig(a)) errors.push(e);
      }
    }
  }
  return errors;
}

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
  /** BR-B4: URL scheme other than http/https (file://, gopher://, ftp://, data:, ...). */
  BAD_SCHEME: 'NETWORK_BAD_SCHEME',
  /** BR-B4: unparseable target, credentials in URL (userinfo), invalid port, or protocol downgrade on redirect. */
  BAD_TARGET: 'NETWORK_BAD_TARGET',
  /** BR-B4: a resolved IP is in a blocked class (loopback / private / link-local / CGNAT / metadata 169.254.169.254 / unspecified / multicast / ...). */
  BLOCKED_IP: 'NETWORK_BLOCKED_IP',
  /** BR-B4: DNS failure, zero addresses, or an unparseable resolved address (fail-closed). */
  RESOLUTION_FAILED: 'NETWORK_RESOLUTION_FAILED',
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

// ---------------------------------------------------------------- container adapter spec (BR-B3, MD Phase 3)
/**
 * Image refs must be explicitly pinned (tag or digest), never implicit
 * latest — same rule as the P2 template validator (MD §2-2/§12).
 * (Lives here — next to the noop spec validation — because
 * validateBatchConfig above must stay synchronous and this module keeps
 * its zero-intra-package-imports invariant.)
 */
export const PINNED_IMAGE_RE =
  /^[a-z0-9][a-z0-9._/-]*(:[a-z0-9][a-z0-9._-]*)?(@sha256:[a-f0-9]{64})?$/;

export const CONTAINER_HEALTH_KINDS = Object.freeze(['adb-tcp', 'tcp', 'none']);
export const CONTAINER_WORK_KINDS = Object.freeze(['hold', 'none']);

/**
 * Validate a `container` adapter spec (MD Phase 3: start/health contract).
 * @param {object} spec { image, health?, work? }
 * @returns {string[]} error list (empty = valid)
 */
export function validateContainerAdapterConfig(spec) {
  const errors = [];
  if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) {
    return ['adapter config must be a plain object'];
  }
  const image = spec.image;
  if (typeof image !== 'string' || image.length === 0 || image.length > 512) {
    errors.push('adapter.image must be a non-empty string (<=512 chars)');
  } else if (!PINNED_IMAGE_RE.test(image)) {
    errors.push('adapter.image must be a valid explicitly-pinned image reference');
  } else {
    const tail = image.slice(image.lastIndexOf('/') + 1);
    if (!/[:@]/.test(tail)) {
      errors.push('adapter.image must be explicitly tagged (e.g. foo/bar:1.2.3) or digest-pinned');
    } else if (/(^|:)latest$/i.test(tail)) {
      errors.push('adapter.image tag "latest" is not allowed — pin an explicit version');
    }
  }
  if (spec.health !== undefined) {
    const h = spec.health;
    if (typeof h !== 'object' || h === null || Array.isArray(h)) {
      errors.push('adapter.health must be a plain object { kind, port? }');
    } else {
      if (!CONTAINER_HEALTH_KINDS.includes(h.kind)) {
        errors.push(`adapter.health.kind must be one of ${CONTAINER_HEALTH_KINDS.join(' | ')}`);
      }
      if (h.port !== undefined && (!Number.isInteger(h.port) || h.port < 1 || h.port > 65535)) {
        errors.push('adapter.health.port must be an integer 1..65535 (the container port)');
      }
    }
  }
  if (spec.work !== undefined) {
    const w = spec.work;
    if (typeof w !== 'object' || w === null || Array.isArray(w)) {
      errors.push("adapter.work must be a plain object { kind: 'hold', durationMs? } or { kind: 'none' }");
    } else if (w.kind === 'hold') {
      if (w.durationMs !== undefined && (!Number.isInteger(w.durationMs) || w.durationMs < 0 || w.durationMs > 3_600_000)) {
        errors.push('adapter.work.durationMs must be an integer 0..3600000 (hold work, ms)');
      }
    } else if (w.kind !== 'none') {
      errors.push(`adapter.work.kind must be one of ${CONTAINER_WORK_KINDS.join(' | ')}`);
    }
  }
  return errors;
}

/** The container-side ADB port for redroid-class images (fixed by the image). */
export const ADB_CONTAINER_PORT_DEFAULT = 5555;

/**
 * Effective health probe for a container adapter spec.
 * @returns {{kind:'adb-tcp'|'tcp'|'none', containerPort:number}}
 */
export function effectiveHealthProbe(spec) {
  const h = spec?.health ?? {};
  const kind = CONTAINER_HEALTH_KINDS.includes(h.kind) ? h.kind : 'adb-tcp';
  const port = Number.isInteger(h.port) && h.port >= 1 && h.port <= 65535
    ? h.port
    : ADB_CONTAINER_PORT_DEFAULT;
  return { kind, containerPort: port };
}

/**
 * Effective work spec. B3 has no real QA workload yet — 'hold' (bounded
 * wall-clock, the B2 noop's semantics) and 'none' (a healthy boot IS the
 * run) are the honest options; B6 adds scripted device work behind the
 * same seam.
 * @returns {{kind:'hold'|'none', durationMs:number}}
 */
export function effectiveWorkSpec(spec) {
  const w = spec?.work ?? {};
  if (w.kind === 'none') return { kind: 'none', durationMs: 0 };
  const durationMs = Number.isInteger(w.durationMs) && w.durationMs >= 0
    ? Math.min(w.durationMs, 3_600_000)
    : 0;
  return { kind: 'hold', durationMs };
}

/**
 * Run-level idempotency key for batch runs (MD §12.3 防重複派發).
 * `<batchId>:<identityId>:a<seq>` — the sequence suffix lets a re-dispatched
 * run (e.g. after a pause-stop cancel + resume) get a FRESH run row without
 * colliding on the unique idempotency_key column. seq = 1 for the first run
 * of the (batch, identity) pair.
 */
export function runIdempotencyKey(batchId, identityId, seq = 1) {
  return `${batchId}:${identityId}:a${Number(seq)}`;
}
