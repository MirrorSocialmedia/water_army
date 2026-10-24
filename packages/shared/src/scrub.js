/**
 * Secret scrubbing for persisted payloads (MD §13.3: payload_json 已清理敏感資料).
 *
 * Task-run events, approval arguments and audit details all pass through
 * `scrubObject` before they hit the DB. Rules:
 *  - Any object key matching a sensitive pattern → value replaced with
 *    `***redacted***` (the key is kept so the shape stays readable).
 *  - Exception: a sensitive key whose value is a plain number/boolean/null is
 *    KEPT — numeric telemetry (e.g. OpenAI usage `promptTokens`) is not a
 *    secret; strings/objects under sensitive keys are redacted.
 *  - VALUE-BASED (MC P4 §6.2): any string containing a URL WITH embedded
 *    userinfo (scheme://user:pass@host — at any position in the string) is
 *    redacted whole, regardless of the key name — a proxy URL carries the
 *    egress credential (MD §13: proxy URL 永不入 log/DB) and a key named
 *    `proxyUrl` would otherwise slip past the key rules. Plain URLs (no
 *    embedded credential) are unaffected.
 *  - VALUE-BASED #2 (P5, MD §11.4 密碼永不入 log/DB): any string containing
 *    a bare secret assignment (`password=hunter2`, `token: abc`, `apiKey = x`)
 *    is redacted whole — free-text notes/summaries are the one place key
 *    rules can't see; 過 mask 無害 (a note saying "password: required" gets
 *    masked; a real leak never survives).
 *  - Deep-walk bounded (depth 6, 500 nodes) — hostile/abusive payloads from
 *    the model or tools cannot DoS the writer.
 *  - Long strings are truncated to `maxChars` (event payloads stay small).
 *
 * Zero dependencies; used by api + worker + tests.
 */

// Boundary-aware: matches at key start, after _/. -, or at a camelCase hump
// (dbPassword / secretKey). Trailing boundary = separator, next hump, or end.
// Deliberately over-approximating (P2 precedent: 過 mask 無害，漏 mask 洩密).
// P5 hardening (MD §11.4/§13 「不記錄：…剪貼簿…畫面影像」): clipboard +
// screen-capture keys are sensitive too — an operator evidence payload
// (free-form JSON, MD §6.2) could otherwise persist a clipboard dump or a
// base64 screenshot past the key rules. P5: proxyUrl added (MD §13: proxy
// URL 永不入 log/DB — the URL itself carries the egress credential context).
const SENSITIVE_KEY = /(^|[_\-.]|(?<=[a-z0-9])[A-Z])((authorization|auth|api[-_]?key|access[-_]?key|secret|token|password|passwd|credential|private[-_]?key|session[-_]?cookie|bearer|client[-_]?secret|clipboard|screenshot|screencapture|screenimage|screencap|proxy[-_]?url))(?:[_\-.]|(?=[A-Z])|$)/i;

const REDACTED = '***redacted***';
const MAX_DEPTH = 6;
const MAX_NODES = 500;

// scheme://user:pass@ — requires a CREDENTIAL (user AND pass) in the
// userinfo. Non-anchored (a URL buried in a longer string still carries the
// secret). Requiring the colon avoids over-redacting user-only forms like
// `ssh://git@github.com` (no password). 過 mask 無害，漏 mask 洩密.
const URL_USERINFO = /[\w+.-]+:\/\/[^@\s/]+:[^@\s/]+@/;

// Bare secret assignments in free text (P5): `password=hunter2`,
// `password: hunter2`, `token = abc` — a value (non-whitespace) must follow
// the separator. Negative lookahead keeps ALREADY-masked placeholders
// (`password=***` from maskCredentialShapedValues, BR-B5 contract) stable —
// idempotent double-processing — while a real value still redacts whole.
// 過 mask 無害 (a note saying "password: required" gets masked).
const BARE_SECRET = /(?:password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|credential|authorization)\s*[=:]\s*(?!\*\*\*)\S/i;

/**
 * @param {unknown} value any JSON-ish value
 * @param {number} [maxChars] per-string cap (default 2000)
 * @returns {unknown} a NEW value (input never mutated)
 */
export function scrubObject(value, maxChars = 2000) {
  let nodes = 0;
  return walk(value, 0, maxChars, () => ++nodes <= MAX_NODES);
}

function walk(value, depth, maxChars, budget) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') {
    const s = String(value);
    if (URL_USERINFO.test(s)) return REDACTED; // embedded credential — always a secret
    if (BARE_SECRET.test(s)) return REDACTED; // bare `password=...` in free text (P5)
    return cap(s, maxChars);
  }
  if (t === 'number' || t === 'boolean') return value;
  if (!budget()) return '[truncated]';

  if (Array.isArray(value)) {
    return value.map((v) => walk(v, depth + 1, maxChars, budget));
  }
  if (t === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k)) {
        // Strings/objects under a sensitive key are redacted; plain
        // number/boolean/null values are kept (usage counters like
        // `promptTokens` are not secrets).
        if (typeof v === 'string' || (v !== null && typeof v === 'object')) {
          out[k] = REDACTED;
        } else {
          out[k] = v;
        }
        continue;
      }
      out[k] = walk(v, depth + 1, maxChars, budget);
    }
    return out;
  }
  // function/symbol etc — stringify defensively
  return cap(String(value), maxChars);
}

function cap(s, maxChars) {
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}…[+${s.length - maxChars}]`;
}
