/**
 * Task-run domain constants (施工 MD §11.3 / §7).
 *
 * Split from index.js on purpose: task-run-service.js imports these WITHOUT
 * going through index.js (which re-exports the service) — keeps the module
 * graph acyclic.
 */

/** Task run lifecycle (MD §11.3). Centralised in TaskRunService — no route may set status directly. */
export const TASK_RUN_STATUS = Object.freeze([
  'queued',
  'running',
  'needs_approval',
  'succeeded',
  'failed',
  'cancel_requested',
  'cancelled',
  'timed_out',
  'skipped',
]);

/** Terminal states — `finished_at` is only written for these (MD §11.3). */
export const TASK_RUN_TERMINAL = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'skipped',
]);

/**
 * Legal state transitions (MD §11.3: all transitions live in TaskRunService).
 *
 * Notes:
 *  - terminal → queued = MANUAL RETRY only (new attempt; old output preserved
 *    in the event stream, never overwritten — MD §6.5 / 工單 P3).
 *  - `skipped` (P4 overlap policy, P6 concurrency_key) has no outgoing
 *    transitions.
 *  - queued → skipped (P6 flag #5): a run can be declared skipped BEFORE it
 *    starts when its concurrency_key is held past the bounded defer window —
 *    the only pre-start terminal path (same spirit as P4 overlap skips).
 *  - `cancel_requested` is the ONLY path to `cancelled` (worker/reconciler
 *    confirms the stop — API never marks cancelled itself: 真停, not DB-only).
 */
export const TASK_RUN_TRANSITIONS = Object.freeze({
  queued: ['running', 'cancel_requested', 'failed', 'skipped'],
  running: ['succeeded', 'failed', 'timed_out', 'cancel_requested', 'needs_approval'],
  needs_approval: ['running', 'failed', 'timed_out', 'cancel_requested'],
  cancel_requested: ['cancelled', 'failed'],
  // Manual retry (→ queued) is only allowed from failure terminals — re-running a
  // successful run is never useful; `skipped` (P4) is a closed leaf.
  succeeded: [],
  failed: ['queued'],
  cancelled: ['queued'],
  timed_out: ['queued'],
  skipped: [],
});

/**
 * P6 flag #5: statuses that hold a task definition's concurrency_key.
 * Deliberately EXCLUDES 'queued' (a merely queued sibling must not block —
 * two queued same-key runs would defer each other forever) and
 * 'cancel_requested' (winding down; the stop is near). 'needs_approval' IS
 * held: the run is in flight, paused on a human, and the mutual-exclusion
 * purpose (no parallel mutation) applies exactly then.
 */
export const CONCURRENCY_ACTIVE_RUN_STATUSES = Object.freeze([
  'running',
  'needs_approval',
]);

/** Task run event types (MD §7 task_run_events). */
export const TASK_EVENT = Object.freeze({
  QUEUED: 'queued',
  ATTEMPT_STARTED: 'attempt_started',
  PROVIDER_REQUEST: 'provider_request',
  PROVIDER_RESPONSE: 'provider_response',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  WAITING_APPROVAL: 'waiting_approval',
  APPROVAL_RESOLVED: 'approval_resolved',
  RETRY: 'retry',
  RETRY_REQUESTED: 'retry_requested',
  STATUS: 'status',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCEL_REQUESTED: 'cancel_requested',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
  OUTPUT: 'output',
});

/** Tool safety classes (MD §13 / 工單 P3: P3 opens readonly + approval_required only). */
export const TOOL_SAFETY_CLASS = Object.freeze({
  READONLY: 'readonly',
  APPROVAL_REQUIRED: 'approval_required',
  /** Any other class is disabled by default in P3 (MD §11.4). */
  DISABLED: 'disabled',
});

/** Stable provider error codes (MD §11.1: independent codes per failure class). */
export const PROVIDER_ERROR = Object.freeze({
  /** connect refused / reset / DNS — transient. */
  NETWORK: 'PROVIDER_NETWORK',
  /** connect or read timeout (AbortSignal fired) — transient. */
  TIMEOUT: 'PROVIDER_TIMEOUT',
  /** HTTP 429 — transient. */
  RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  /** HTTP 5xx — transient. */
  SERVER: 'PROVIDER_SERVER_ERROR',
  /** HTTP 401/403 — credential problem, NEVER auto-retry (MD §11.1). */
  AUTH: 'PROVIDER_AUTH',
  /** HTTP 400 — bad request, never retry. */
  BAD_REQUEST: 'PROVIDER_BAD_REQUEST',
  /** HTTP 404 — model/endpoint missing, never retry. */
  NOT_FOUND: 'PROVIDER_NOT_FOUND',
  /** malformed JSON / empty body / oversize response — never retry blindly. */
  INVALID_RESPONSE: 'PROVIDER_INVALID_RESPONSE',
  /** cancellation requested (engine handles; not a provider fault). */
  ABORTED: 'PROVIDER_ABORTED',
  /** network policy violation (off-pin dial / rejected redirect) — a policy
   *  fact, NOT transient: never auto-retry (MD Phase 6 G3). */
  NETWORK_POLICY: 'PROVIDER_NETWORK_POLICY',
  /** provider not configured / missing config row. */
  NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  /** anything else — not retryable by default. */
  GENERIC: 'PROVIDER_ERROR',
});

/** Only these may be auto-retried (bounded, exponential backoff). MD §11.1/§12.3. */
export const RETRYABLE_PROVIDER_ERRORS = Object.freeze(
  new Set([
    PROVIDER_ERROR.NETWORK,
    PROVIDER_ERROR.TIMEOUT,
    PROVIDER_ERROR.RATE_LIMITED,
    PROVIDER_ERROR.SERVER,
  ]),
);

/** BullMQ queue name (P1 shell established it; keep stable). */
export const TASK_QUEUE_NAME = 'ai-tasks';

/** BullMQ job name for task runs. */
export const TASK_JOB_NAME = 'task-run';

/** Deterministic job id per run+attempt → idempotent enqueue (no double jobs).
 *  JOINER IS '-' (not ':'): BullMQ throws "Custom Id cannot contain :" on
 *  custom job ids — a live-acceptance catch (2026-10-15, fake queue didn't
 *  validate, so tests were green while real enqueue failed). */
export function taskJobId(runId, attempt) {
  return `${runId}-${attempt}`;
}

/**
 * Fixed non-human identity for service (worker→API) calls, MD §13.2.
 * Operator-level by RBAC, but the API explicitly refuses to let it approve
 * (AI can never self-approve) or otherwise act as a human.
 */
export const SERVICE_USER_ID = '00000000-0000-4000-8000-000000000001';

/** Default + hard caps (MD 附錄 A; overridable per run within cap). */
export const TASK_DEFAULTS = Object.freeze({
  MAX_PROMPT_CHARS: 20_000,
  MAX_ATTEMPTS_CAP: 5,
  MAX_TOOL_ROUNDS: 8,
  /** Run output stored in DB (UI shows it); events carry previews only. */
  OUTPUT_MAX_CHARS: 100_000,
  /** Per-event content preview cap (MD §13.3: no full prompts/outputs in events). */
  EVENT_PREVIEW_CHARS: 1_000,
  /** Tool result fed back to the model, truncated. */
  TOOL_RESULT_CHARS: 8_000,
  /** Auto-retry backoff. */
  RETRY_BASE_MS: 1_000,
  RETRY_FACTOR: 2,
  RETRY_MAX_MS: 30_000,
});
