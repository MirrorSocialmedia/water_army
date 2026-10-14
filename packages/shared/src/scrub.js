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
 *  - Deep-walk bounded (depth 6, 500 nodes) — hostile/abusive payloads from
 *    the model or tools cannot DoS the writer.
 *  - Long strings are truncated to `maxChars` (event payloads stay small).
 *
 * Zero dependencies; used by api + worker + tests.
 */

// Boundary-aware: matches at key start, after _/. -, or at a camelCase hump
// (dbPassword / secretKey). Trailing boundary = separator, next hump, or end.
// Deliberately over-approximating (P2 precedent: 過 mask 無害，漏 mask 洩密).
const SENSITIVE_KEY = /(^|[_\-.]|(?<=[a-z0-9])[A-Z])((authorization|auth|api[-_]?key|access[-_]?key|secret|token|password|passwd|credential|private[-_]?key|session[-_]?cookie|bearer|client[-_]?secret))(?:[_\-.]|(?=[A-Z])|$)/i;

const REDACTED = '***redacted***';
const MAX_DEPTH = 6;
const MAX_NODES = 500;

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
  if (t === 'string') return cap(String(value), maxChars);
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
