/**
 * WA-UI-SURFACY — pure logic for the surfaced surfaces (fingerprint /
 * egress / account-lifecycle / device-apps / templates / network-policy /
 * settings). Pages stay thin renderers; every decision (RBAC gating that
 * mirrors the backend requireRole matrix, honest error/conflict text,
 * long-string handling, double-submit guarding) lives here and is covered
 * hermetically in tests/unit/surfacy-ui.test.js.
 *
 * RBAC table (mirrored 1:1 from the route sources, 2026-10-28 audit):
 *   fingerprints read   = viewer+            generate/collisions = admin
 *   egress read         = viewer+            bind/unbind         = admin
 *   lifecycle read      = viewer+            transition/provision= operator
 *   device apps read    = viewer+            install/uninstall   = operator
 *   templates read      = viewer+            (writes are admin — UI is read-only)
 *   network policy      = admin ONLY (read AND write)
 *   providers / config-summary / ram-gate = admin
 */

const isOperator = (role) => role === 'operator' || role === 'admin';

export function canManageFleetProfiles(role) {
  // fingerprint generate + collisions audit + egress binding + network policy
  return role === 'admin';
}
export function canOperateLifecycle(role) {
  return isOperator(role);
}
export function canMutateDeviceApps(role) {
  return isOperator(role);
}
export function canViewPolicy(role) {
  return role === 'admin';
}
/** capability matrix for tests / generic lookup */
export function surfacyCan(role, action) {
  switch (action) {
    case 'fingerprint.read':
    case 'egress.read':
    case 'lifecycle.read':
    case 'apps.read':
    case 'templates.read':
    case 'definitions.read':
      return Boolean(role);
    case 'fingerprint.generate':
    case 'fingerprint.collisions':
    case 'egress.write':
    case 'policy.read':
    case 'policy.write':
    case 'providers.read':
    case 'config.summary':
      return role === 'admin';
    case 'lifecycle.transition':
    case 'lifecycle.provision':
    case 'apps.install':
    case 'apps.uninstall':
      return isOperator(role);
    default:
      return false;
  }
}

// ----------------------------------------------------------------- errors ---
/**
 * Honest error text for the standard ApiError envelope ({ status, code,
 * message, requestId }). Never returns an empty string for a real error —
 * an unknown error still renders code + fallback message (no white screen).
 */
export function errorText(err) {
  if (!err) return '';
  const code = err.code ?? 'ERROR';
  const message = err.message ?? 'unknown error';
  return err.requestId ? `${code}: ${message} (request ${err.requestId})` : `${code}: ${message}`;
}

/**
 * 409 conflict copy (fingerprint collision / egress IP taken by another
 * identity / FLOW token reuse…). Returns null for non-409 so callers keep
 * their generic error path. The server message is shown VERBATIM — the
 * backend is the authority on what conflicted.
 */
export function conflictText(err) {
  if (!err || err.status !== 409) return null;
  return `衝突 (409) — ${err.message ?? 'conflict'}`;
}

/** Fail-closed switch guard: 503 + exact code (EGRESS_BINDING_DISABLED etc.). */
export function isSwitchDisabled(err, code) {
  return Boolean(err) && err.status === 503 && err.code === code;
}

/** Honest 403 copy when the frontend gate disagrees with the backend. */
export function forbiddenText(err) {
  if (!err || err.status !== 403) return null;
  return `403 — not permitted for your role (${err.message ?? 'forbidden'})`;
}

// ------------------------------------------------------------ long strings ---
/**
 * CSS class for free-text cells that may carry 300+ char payloads
 * (displayName, proxy hosts, package lists): never let them break layout.
 * .break-anywhere in app.css sets overflow-wrap:anywhere + word-break:break-word.
 */
export const LONG_TEXT_CLASS = 'break-anywhere';

/** Truncated one-line preview (display only; full value belongs in title). */
export function previewText(value, max = 120) {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… (+${s.length - max} more)`;
}

// --------------------------------------------------------------- busy/2x ---
/**
 * Double-submit guard for POST/PUT buttons: `tryBegin()` returns false when
 * a submit is already in flight (second click must fire NOTHING); the caller
 * must call `end()` in a finally block. Pure so it is unit-testable without
 * a DOM.
 */
export function createBusyGuard() {
  let busy = false;
  return {
    tryBegin() {
      if (busy) return false;
      busy = true;
      return true;
    },
    end() {
      busy = false;
    },
    get busy() {
      return busy;
    },
  };
}

// ------------------------------------------------------------- form mirror ---
/**
 * Client-side MIRROR of the PUT /api/identities/:id/egress body schema
 * (authoritative validation stays on the backend — this only prevents
 * obviously-doomed submits). Returns an errors object (empty = look ok).
 */
export function validateEgressForm({ proxyUrl, expectedEgressIp }) {
  const errors = {};
  if (typeof proxyUrl !== 'string' || proxyUrl.trim().length < 8 || proxyUrl.length > 2048) {
    errors.proxyUrl = 'proxyUrl is required (8–2048 chars, scheme host:port form)';
  }
  const ip = typeof expectedEgressIp === 'string' ? expectedEgressIp.trim() : '';
  if (ip.length < 7 || ip.length > 15) {
    errors.expectedEgressIp = 'expectedEgressIp is required (7–15 chars)';
  } else if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    errors.expectedEgressIp = 'expectedEgressIp must look like an IPv4 address';
  }
  return errors;
}

/** reasonCode mirror: ^[A-Z0-9_]{2,60}$ (optional field). */
export function validReasonCode(code) {
  return code === '' || code === undefined || code === null || /^[A-Z0-9_]{2,60}$/.test(code);
}

/** T5 manual-transition targets (mirror of TRANSITION_BODY.enum). */
export const ACCOUNT_STATES = [
  'PREPARING', 'PROVISIONING', 'AWAITING_HUMAN', 'CREATED',
  'RECOVERY_SETUP', 'READY', 'DEAD',
];

// ----------------------------------------------------------------- format ---
/** fleet collision report row → honest one-liner. */
export function formatCollisionRow(c) {
  return `${c.field} = ${previewText(c.value, 60)} ×${c.count}`;
}

/** bytes → human (MiB/GiB, 1 decimal) for RAM-gate config display. */
export function fmtMiB(miB) {
  if (!Number.isFinite(miB)) return '—';
  if (miB >= 1048576) return `${(miB / 1048576).toFixed(1)} TiB`;
  if (miB >= 1024) return `${(miB / 1024).toFixed(1)} GiB`;
  return `${miB} MiB`;
}

/** ms → human duration for intervals. */
export function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms >= 3600000) return `${(ms / 3600000).toFixed(1)} h`;
  if (ms >= 60000) return `${Math.round(ms / 60000)} min`;
  return `${Math.round(ms / 1000)} s`;
}

// ------------------------------------------------- policy allowlist editor ---
// F4 (review mvrvfa9l5l813): the PolicyPanel textareas must re-seed whenever
// server state changes (reload/save) and an untouched/empty editor must not
// fire a PUT that the backend answers 400 "nothing to update". Pure helpers
// so both behaviors are unit-testable without DOM.

export const POLICY_ZONE_KEYS = ['allowlist', 'allowlistInternal'];

/** Textarea seeds from GET /api/network-policy appSettings rows. Missing or
 *  non-array valueJson → '' (honest empty editor, never 'undefined'). */
export function zonesFromPolicyRows(rows) {
  const out = {};
  for (const key of POLICY_ZONE_KEYS) {
    const v = rows?.[key]?.valueJson;
    out[key] = Array.isArray(v) ? v.map(String).join('\n') : '';
  }
  return out;
}

/** Textarea text → PUT body zone array (trim + drop empty lines). */
export function parseZoneLines(text) {
  if (typeof text !== 'string') return [];
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** PUT body from editor state — ALWAYS both keys, so body is never `{}`. */
export function zonesToBody(zones) {
  const body = {};
  for (const key of POLICY_ZONE_KEYS) body[key] = parseZoneLines(zones?.[key]);
  return body;
}

/** True when the editor text is semantically identical to server state —
 *  Save is a no-op then (button disabled), which is what prevents the
 *  unedited-Save → 400 UX trap. Explicit clears still differ → allowed. */
export function zonesMatchServer(zones, rows) {
  const server = zonesFromPolicyRows(rows);
  return POLICY_ZONE_KEYS.every(
    (k) => JSON.stringify(parseZoneLines(zones?.[k])) === JSON.stringify(parseZoneLines(server[k])),
  );
}
