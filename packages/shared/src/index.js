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
  'session',
  'sessionToken',
  'session_token',
  '*.session',
  '*.encryptedApiKey',
  '*.encrypted_api_key',
]);

/** Health dependency check timeout (ms). */
export const HEALTH_CHECK_TIMEOUT_MS = 2500;
