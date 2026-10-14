/**
 * @water-army/shared — constants and contracts shared by api/worker/web.
 * Zero dependencies. JavaScript ESM only.
 */

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

/** Task run lifecycle (施工 MD §11.3). Centralised in TaskRunService from P3. */
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

/** Terminal states — `finished_at` is only written for these. */
export const TASK_RUN_TERMINAL = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'skipped',
]);

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
  /** Definitive 404 from the daemon (container/image/network not found). */
  CONTAINER_NOT_FOUND: 'CONTAINER_NOT_FOUND',
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
export const SENSITIVE_ENV_KEY = /(^|[_-])(password|passwd|pass|pwd|secret|token|api_?key|apikey|auth|authorization|credential|credentials|private_?key)([_-]|$)/i;

/**
 * Build BullMQ `connection` options from a redis:// URL.
 *
 * Trap (P1-fix incident 2026-10-14): BullMQ 6's RedisConnection only honours
 * a `url` key. Passing a bare `redis://...` string gets `Object.assign`'d into
 * char-index keys ('0':'r', '1':'e', ...), so the connection silently falls
 * back to the 127.0.0.1:6379 default — the worker ECONNREFUSED-loops forever
 * even though REDIS_URL is correct. Always route Worker/Queue connections
 * through this helper (worker today, api-side Queue in P3).
 *
 * @param {string} redisUrl - redis:// or rediss:// connection string
 * @returns {{ url: string }} BullMQ connection options (url key form)
 */
export function buildRedisConnection(redisUrl) {
  if (typeof redisUrl !== 'string' || !/^rediss?:\/\//.test(redisUrl)) {
    throw new TypeError(
      `buildRedisConnection: expected a redis:// or rediss:// URL, got: ${String(redisUrl)}`,
    );
  }
  return { url: redisUrl };
}
