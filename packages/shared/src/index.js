/**
 * @water-army/shared — constants and contracts shared by api/worker/web.
 * Runtime deps: cron-parser (schedule math) + bullmq (queue producer utils) —
 * both hoisted from the app workspaces. JavaScript ESM only.
 */

import { buildRedisConnection } from './redis-connection.js';
export { buildRedisConnection };

/** RBAC roles (施工 MD §13.2). Ordered low → high. */
export const ROLES = Object.freeze({
  VIEWER: 'viewer',
  OPERATOR: 'operator',
  ADMIN: 'admin',
});

/** Role → privilege level. A request needs level ≥ the route's minimum. */
export const ROLE_LEVEL = Object.freeze({
  viewer: 1,
  operator: 2,
  admin: 3,
});

/** Task-run domain constants (施工 MD §11.3) — defined in task-constants.js (acyclic). */
export {
  TASK_RUN_STATUS,
  TASK_RUN_TERMINAL,
  TASK_RUN_TRANSITIONS,
  CONCURRENCY_ACTIVE_RUN_STATUSES,
  TASK_EVENT,
  TOOL_SAFETY_CLASS,
  PROVIDER_ERROR,
  RETRYABLE_PROVIDER_ERRORS,
  TASK_QUEUE_NAME,
  TASK_JOB_NAME,
  taskJobId,
  SERVICE_USER_ID,
  TASK_DEFAULTS,
} from './task-constants.js';

/** Schedule domain constants (MD §1.4/§12 — PG source of truth + BullMQ index). */
export {
  SCHEDULE_TYPE,
  SCHEDULE_SYNC_STATUS,
  OVERLAP_POLICY,
  SCHEDULE_ACTIVE_RUN_STATUSES,
  SCHEDULE_FIRE_JOB_NAME,
  schedulerIdFor,
  onceFireJobId,
  scheduleSlotKey,
  scheduleSkipKey,
  runNowKey,
  SCHEDULE_MIN_INTERVAL_MS_DEFAULT,
  SCHEDULE_RECONCILE_INTERVAL_MS_DEFAULT,
  SCHEDULE_FIRE_JOB_TIMEOUT_MS,
  SCHEDULE_FIRE_REMOVE_ON_COMPLETE,
  SCHEDULE_FIRE_REMOVE_ON_FAIL,
  SCHED_STALE_SLOT_TOLERANCE_MS,
  schedulingHash,
  fireJobData,
} from './schedule-constants.js';

/** Task queue producer utilities (canonical; API plugin re-exports). */
export {
  createTaskQueue,
  enqueueTaskRun,
  removeWaitingTaskRun,
  closeTaskQueue,
  // BR-B2 (gen1): batch-run job helpers (idempotent enqueue / waiting removal /
  // batch-aware router — see task-queue.js).
  enqueueBatchRun,
  removeWaitingBatchRun,
  enqueueAnyRun,
} from './task-queue.js';

/** Schedule cron/timezone utilities (same cron-parser as BullMQ). */
export {
  isIanaTimezone,
  validateCronExpression,
  nextCronRun,
  describeCron,
  describeInterval,
} from './schedule-cron.js';

/** Tool registry metadata + arg validation (MD §11.4/§11.5). */
export {
  TOOL_REGISTRY,
  TOOL_BY_NAME,
  P3_TOOL_NAMES,
  findTool,
  isToolClassEnabled,
  validateToolArgs,
  truncateText,
  safeStringify,
} from './tool-registry.js';

/** TaskRunService — single owner of run state (MD §11.3). */
export {
  createTaskRunService,
  TaskRunError,
  backoffDelay,
  providerErrorToRun,
  describeRun,
} from './task-run-service.js';

/** Batch Rotation domain constants (BR-B1, 施工 MD §3/§4/§6/§9). */
export {
  IDENTITY_STATUS,
  IDENTITY_TERMINAL,
  IDENTITY_TRANSITIONS,
  IDENTITY_TYPE_REGISTRY,
  BATCH_STATUS,
  BATCH_TERMINAL,
  BATCH_TRANSITIONS,
  FAILURE_POLICY,
  validateCapacityInput,
  planCycle,
  LEASE_RESOURCE_TYPE,
  slotKey,
  IDENTITY_ACTIVE_RUN_STATUSES,
  CONTAINER_LABEL_PREFIX,
  CONTAINER_LABELS,
  buildContainerLabels,
  APP_SETTING_BATCH_GLOBAL_MAX_ACTIVE,
  IDENTITY_DATA_ROOT_DEFAULT,
  identityDataPaths,
  validateIdentityDataPath,
  findDuplicateMountSources,
  NETWORK_GATE_ERROR,
  createAllowAllNetworkGate,
  newUuid,
  BatchError,
  IDEMPOTENCY_KEY_RE,
  // BR-B3 (Phase 3): container adapter spec contract (MD Phase 3 item 3/5).
  PINNED_IMAGE_RE,
  CONTAINER_HEALTH_KINDS,
  CONTAINER_WORK_KINDS,
  validateContainerAdapterConfig,
  ADB_CONTAINER_PORT_DEFAULT,
  effectiveHealthProbe,
  effectiveWorkSpec,
  // BR-B2 (gen1): scheduler/queue constants + helpers.
  BATCH_ADAPTER_REGISTRY,
  BATCH_MAX_ATTEMPTS_CAP,
  BATCH_CONFIG_DEFAULTS,
  BATCH_RUN_JOB_NAME,
  batchJobId,
  runIdempotencyKey,
  validateBatchConfig,
} from './batch-constants.js';

/** BatchService — single owner of batch/identity state (BR-B1, MD §6/§9). */
export { createBatchService } from './batch-service.js';

/** BatchScheduler — dispatch/tick/reconciliation (BR-B2 gen2, MD §6.2/§7). */
export {
  createBatchScheduler,
  createBatchSchedulerLoop,
  readGlobalMaxActive,
  effectiveSlotCap,
  IDENTITY_SYNC_PLAN,
  MEMBERSHIP_SYNC_PLAN,
  RUN_TERMINAL,
  BATCH_SCHEDULER_DEFAULTS,
} from './batch-scheduler.js';

/** Batch Rotation metrics + alert evaluation (BR-B5, MD §13 — pure core). */
export {
  BATCH_METRIC_NAMES,
  DEFAULT_ALERT_LIMITS,
  durationStatsMs,
  maxConcurrentFromIntervals,
  computeBatchMetrics,
  evaluateAlerts,
  alertFingerprint,
} from './batch-metrics.js';

/** Batch cycle audit report (BR-B5, MD §11.4 — zero-secrets export). */
export { REPORT_SCHEMA, buildCycleReport, renderCycleReportCsv, assertNoSecrets, maskCredentialShapedValues } from './batch-report.js';

/**
 * Batch container lifecycle — pure decision helpers (BR-B3, MD Phase 3):
 * error codes, naming, port allocation, the label×DB ownership double
 * check, reconcile classification, ADB handshake parsing.
 */
export {
  BATCH_LIFECYCLE_ERROR,
  BATCH_LIFECYCLE_ERROR_STATUS,
  BatchLifecycleError,
  APP_SETTING_BATCH_CONTAINER_IMAGE_ALLOWLIST,
  containerNameForRun,
  parsePortRange,
  pickAvailablePort,
  ownershipVerdict,
  RECONCILE_STATES,
  reconcileVerdict,
  ADB_HOST_VERSION_CMD,
  parseAdbVersionReply,
} from './batch-lifecycle.js';

/** LeaseService — cross-process resource leases (BR-B1, MD §9.6). */
export { createLeaseService } from './lease-service.js';

/** Host metrics sampler (RAM-G1) — /proc/meminfo + /proc/loadavg. */
export { createHostMetrics, parseMeminfo } from './host-metrics.js';

/**
 * RAM Gate — product-grade host-RAM admission gate (RAM-G1).
 * Fail-closed admission for RAM-heavy redroid boots; atomic reservation in
 * one Redis Lua script; lease reconciliation + recovery; UI status surface.
 */
export {
  RAM_GATE_DEFAULTS,
  RAM_GATE_ENV,
  RAM_GATE_APP_SETTING_KEY,
  RAM_GATE_REASON,
  resolveRamGateConfig,
  computeAdmission,
  createRamGate,
  ADMIT_LUA,
  DRY_RUN_LUA,
  RELEASE_LUA,
  RELEASE_BY_KEY_LUA,
  RENEW_LUA,
  COUNT_LUA,
} from './ram-gate.js';

/**
 * Network policy — QA endpoint allowlist + SSRF hardening (BR-B4, MD §5/§12).
 * The worker.js gate swap-in is createNetworkPolicyGate (B1 seam, zero engine change).
 */
export {
  NETWORK_POLICY_ENV,
  NETWORK_SETTING_KEYS,
  parseAllowlistEntry,
  parseAllowlist,
  parseIp4,
  parseIp6Literal,
  classifyIp,
  isIpAllowedForZone,
  normalizeHost,
  parseTarget,
  defaultResolve,
  assessTarget,
  assessRedirect,
  loadNetworkPolicy,
  redactTarget,
  createNetworkPolicyGate,
} from './network-policy.js';

/** Secret scrubbing for persisted payloads (MD §13.3). */
export { scrubObject } from './scrub.js';

/** Manual-intervention domain + shared signal writer (MC MD Phase 4 / §6). */
export {
  INTERVENTION_STATUS,
  INTERVENTION_OPEN_EPISODE,
  INTERVENTION_TERMINAL,
  INTERVENTION_NEEDS_ATTENTION,
  INTERVENTION_SOURCE,
  INTERVENTION_CATEGORY,
  INTERVENTION_SEVERITY,
  AUTOMATION_DISPOSITION,
  interventionDedupeKey,
  createInterventionSignalWriter,
} from './intervention.js';

/** Provider credential encryption — AES-256-GCM (MD §11.7/§13.2). */
export {
  ProviderCryptoError,
  resolveProviderKey,
  encryptSecret,
  decryptSecret,
  maskSecret,
} from './provider-crypto.js';

/** Classified provider failure (MD §11.8). */
export { ProviderError } from './provider-error.js';

/**
 * Canonical API error codes (施工 MD §8 error envelope).
 * Every error response is: { error: { code, message, requestId } }
 */
export const API_ERROR = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  FORBIDDEN_ORIGIN: 'FORBIDDEN_ORIGIN',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
});

/** Session cookie name (HttpOnly). */
export const SESSION_COOKIE = 'session';

/** Docker container labels marking app-managed resources (施工 MD §9.2). */
export const APP_LABELS = Object.freeze({
  MANAGED: 'app.managed',
  TEMPLATE: 'app.template',
  CREATED_BY: 'app.created-by',
});

/**
 * Pino redaction paths — secrets must never reach logs (施工 MD §13.3).
 * Covers: authorization headers, API keys, passwords, cookies, sessions.
 */
export const PINO_REDACT_PATHS = Object.freeze([
  'req.headers.authorization',
  'req.headers.proxy-authorization',
  'req.headers.cookie',
  'req.headers.api-key',
  'req.headers.x-api-key',
  // P6: worker→API service token (threat-model T7) — never log it, even if a
  // future code path serializes req.headers.
  'req.headers.x-wa-service-token',
  'password',
  'pass',
  'passwd',
  '*.password',
  '*.pass',
  '*.apiKey',
  '*.api_key',
  '*.api-key',
  'api_key',
  'apiKey',
  'token',
  '*.token',
  'session',
  'sessionToken',
  'session_token',
  '*.session',
  '*.encryptedApiKey',
  '*.encrypted_api_key',
]);

/** Health dependency check timeout (ms). */
export const HEALTH_CHECK_TIMEOUT_MS = 2500;

/**
 * Docker API error codes (施工 MD §9.1 — 硬規：只有確定 404/no such container
 * 才可判 not found；daemon down / permission / timeout 各獨立 code，唔好混同).
 * Each code maps to a fixed HTTP status in DockerService.
 */
export const DOCKER_ERROR = Object.freeze({
  /** Definitive 404 from the daemon (container/network not found). */
  CONTAINER_NOT_FOUND: 'CONTAINER_NOT_FOUND',
  /** Definitive 404 for a missing image reference (create/pull of an
   *  unknown image). Distinct from CONTAINER_NOT_FOUND — R5 live evidence:
   *  dockerode composes "(HTTP code 404) no such container - No such image:
   *  <ref>", where the 404 is about the IMAGE, not a container. */
  IMAGE_NOT_FOUND: 'IMAGE_NOT_FOUND',
  /** Socket connect refused / missing / reset — daemon down or path wrong. */
  DAEMON_UNAVAILABLE: 'DOCKER_DAEMON_UNAVAILABLE',
  /** EACCES on the socket — api lacks docker group permission. */
  PERMISSION_DENIED: 'DOCKER_PERMISSION_DENIED',
  /** Request timed out (op timeout / stats timeout). */
  TIMEOUT: 'DOCKER_TIMEOUT',
  /** Docker disabled via config (DOCKER_SOCKET_PATH empty). */
  DISABLED: 'DOCKER_DISABLED',
  /** Op API succeeded but post-op inspect shows state unchanged. */
  OPERATION_PENDING: 'OPERATION_PENDING',
  /** Container not app-managed (no app.managed label + no admin exception). */
  NOT_MANAGED: 'NOT_MANAGED',
  /** Unknown/unclassified Docker failure — surfaced with original message. */
  GENERIC: 'DOCKER_ERROR',
});

/** HTTP status per Docker error code (single source of truth). */
export const DOCKER_ERROR_STATUS = Object.freeze({
  [DOCKER_ERROR.CONTAINER_NOT_FOUND]: 404,
  [DOCKER_ERROR.IMAGE_NOT_FOUND]: 404,
  [DOCKER_ERROR.DAEMON_UNAVAILABLE]: 503,
  [DOCKER_ERROR.PERMISSION_DENIED]: 502,
  [DOCKER_ERROR.TIMEOUT]: 504,
  [DOCKER_ERROR.DISABLED]: 503,
  [DOCKER_ERROR.OPERATION_PENDING]: 500,
  [DOCKER_ERROR.NOT_MANAGED]: 403,
  [DOCKER_ERROR.GENERIC]: 502,
});

/**
 * Env key pattern treated as sensitive (施工 MD §6.3 / §13.3): such values
 * are masked server-side before any API response. Match on the full key or
 * on `_`-separated segments so e.g. `DB_PASSWORD` / `API_KEY` hit.
 */
/**
 * Env-var keys whose VALUES are sensitive and must never be returned by the
 * Docker API (施工 MD §10.5). Match on the full key or on `_`/`-`-separated
 * segments so e.g. `DB_PASSWORD` / `API_KEY` / `DATABASE_URL` / 
 * `APP_ENCRYPTION_KEY` hit.
 *
 * Deliberately over-approximating (live finding 2026-10-14): `*_URL` / `*_DSN`
 * / `*_URI` connection strings embed credentials (user:pass@host) — a
 * `DATABASE_URL` that slips through leaks the DB password. Over-masking an
 * innocuous `APP_PUBLIC_URL` is acceptable; under-masking is not.
 */
export const SENSITIVE_ENV_KEY = /(^|[_-])(password|passwd|pass|pwd|secret|token|api_?key|apikey|auth|authorization|credential|credentials|private_?key|key|url|dsn|uri|connection_?string)([_-]|$)/i;

export * from './fingerprint-profile.js';
export * from './w1b-profiles.js';
export * from './w1b-image-mapping.js';
export * from './w1b-consistency.js';

/**
 * T5 (ADR-030) — Gmail account lifecycle: matrix (authoritative), throttle
 * evaluator, deterministic realism profile, masking. Web mirror lives in
 * batch-ui.js ACCOUNT_TRANSITIONS_UI (three-way sync discipline, ADR-029 §3).
 */
export {
  ACCOUNT_STATES,
  ACCOUNT_TRANSITIONS,
  ACCOUNT_RESUMABLE,
  isLegalAccountTransition,
  deriveAccountProfile,
  maskEmail,
  dayKey,
  evaluateThrottle,
  throttleScopeKeys,
  pickRecoveryEmail,
} from './gmail-provision.js';
