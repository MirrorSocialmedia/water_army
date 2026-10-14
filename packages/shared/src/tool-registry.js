/**
 * Tool Registry — metadata (shared) + minimal JSON-Schema validation (MD §11.4/§11.5).
 *
 * SECURITY (MD §13):
 *  - Only `readonly` and `approval_required` classes exist in P3; anything else
 *    is treated as disabled (fail-closed).
 *  - Handlers live in the WORKER (apps/worker/src/tool-handlers.js) and only
 *    call the API's readonly endpoints over HTTP with a service token — the
 *    worker NEVER touches the Docker socket (threat model T1).
 *  - Tool arguments are ALWAYS schema-validated before execution; unknown
 *    properties are rejected (additionalProperties:false semantics).
 *  - There is deliberately NO shell.exec / docker.raw_api / arbitrary ADB.
 */
import { TOOL_SAFETY_CLASS } from './task-constants.js';

/** @param {string} name @param {string} desc @param {object} params @param {string} cls */
function tool(name, description, parameters, safetyClass) {
  return Object.freeze({ name, description, parameters, safetyClass });
}

/**
 * P3 tool set (MD §11.4 readonly/low-risk first + one state-changing tool to
 * exercise the human-approval flow end to end).
 */
export const TOOL_REGISTRY = Object.freeze([
  tool(
    'system.get_health',
    'Read App/DB/Redis/Docker health status (GET /api/health/ready).',
    Object.freeze({ type: 'object', additionalProperties: false, properties: {} }),
    TOOL_SAFETY_CLASS.READONLY,
  ),
  tool(
    'docker.list_managed_containers',
    'List app-managed container summaries (id, name, state). Read-only.',
    Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        state: Object.freeze({ type: 'string', maxLength: 64 }),
        q: Object.freeze({ type: 'string', maxLength: 100 }),
        page: Object.freeze({ type: 'integer', minimum: 1, maximum: 100 }),
        pageSize: Object.freeze({ type: 'integer', minimum: 1, maximum: 100 }),
      }),
    }),
    TOOL_SAFETY_CLASS.READONLY,
  ),
  tool(
    'docker.get_managed_container_status',
    "Inspect ONE app-managed container (state, ports, labels). Read-only.",
    Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['container']),
      properties: Object.freeze({
        container: Object.freeze({ type: 'string', minLength: 1, maxLength: 191, description: 'Container id or name (must be app-managed)' }),
      }),
    }),
    TOOL_SAFETY_CLASS.READONLY,
  ),
  tool(
    'docker.get_managed_container_logs',
    "Tail ONE app-managed container's logs (bounded lines). Read-only.",
    Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['container']),
      properties: Object.freeze({
        container: Object.freeze({ type: 'string', minLength: 1, maxLength: 191 }),
        tail: Object.freeze({ type: 'integer', minimum: 10, maximum: 500, default: 100 }),
      }),
    }),
    TOOL_SAFETY_CLASS.READONLY,
  ),
  tool(
    'docker.restart_managed',
    'RESTART an app-managed container. State-changing — requires human admin approval before execution.',
    Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['container']),
      properties: Object.freeze({
        container: Object.freeze({ type: 'string', minLength: 1, maxLength: 191, description: 'Container id or name to restart (must be app-managed)' }),
      }),
    }),
    TOOL_SAFETY_CLASS.APPROVAL_REQUIRED,
  ),
]);

/** name → tool def (O(1) lookup). */
export const TOOL_BY_NAME = Object.freeze(
  new Map(TOOL_REGISTRY.map((t) => [t.name, t])),
);

/** Tool names the P3 engine may dispatch (everything registered is enabled). */
export const P3_TOOL_NAMES = Object.freeze(TOOL_REGISTRY.map((t) => t.name));

/**
 * Safety-class gate (MD §11.4: 其他 class P3 唔开放 / disabled by default).
 * Exported so the fail-closed rule is directly testable for future classes.
 */
export function isToolClassEnabled(safetyClass) {
  return safetyClass === TOOL_SAFETY_CLASS.READONLY || safetyClass === TOOL_SAFETY_CLASS.APPROVAL_REQUIRED;
}

/**
 * Look up a tool by name. Unknown names → null (fail-closed: the engine
 * reports `tool_unavailable` and the tool is NEVER executed).
 */
export function findTool(name) {
  if (typeof name !== 'string') return null;
  const t = TOOL_BY_NAME.get(name);
  if (!t) return null;
  if (!isToolClassEnabled(t.safetyClass)) return null;
  return t;
}

/**
 * Minimal JSON-Schema validator for tool arguments — zero dependencies
 * (MD §11.5: tool input MUST be schema-validated before execution).
 *
 * Supported subset (exactly what P3 schemas use, fail-closed beyond it):
 *   type: object | string | integer | number | boolean
 *   object: properties, required, additionalProperties:false
 *   string: minLength, maxLength, pattern
 *   number/integer: minimum, maximum
 *   enum, default (applied to a copy — input is never mutated)
 *
 * @param {object} schema
 * @param {unknown} args
 * @returns {{ok:true, value:object} | {ok:false, errors:string[]}}
 */
export function validateToolArgs(schema, args) {
  const errors = [];
  const value = validateNode(schema, args, '', errors);
  if (errors.length) return { ok: false, errors: errors.slice(0, 8) };
  return { ok: true, value };
}

function isInteger(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

/** @returns {unknown} validated (default-applied) value */
function validateNode(schema, value, path, errors) {
  if (schema === undefined || schema === null) {
    if (value === undefined) return undefined;
    return value;
  }

  // enum wins first (most specific)
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      errors.push(`${path || 'arguments'}: value ${JSON.stringify(value)} not in enum [${schema.enum.join(', ')}]`);
      return value;
    }
  }

  if (value === undefined) {
    if (schema.default !== undefined) return schema.default;
    return undefined;
  }

  const t = schema.type;
  if (t === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${path}: expected object, got ${Array.isArray(value) ? 'array' : typeof value}`);
      return value;
    }
    const props = schema.properties ?? {};
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (!(k in props)) {
        if (schema.additionalProperties === false) {
          errors.push(`${path}.${k}: unknown property (additionalProperties: false)`);
        }
        // drop unknown keys either way — handlers must never see junk
        continue;
      }
      out[k] = validateNode(props[k], v, path ? `${path}.${k}` : k, errors);
    }
    // Apply schema defaults for absent optional properties (input never mutated).
    for (const [k, sub] of Object.entries(props)) {
      if (value[k] === undefined && sub && sub.default !== undefined) {
        out[k] = sub.default;
      }
    }
    for (const req of schema.required ?? []) {
      if (value[req] === undefined && (props[req]?.default === undefined)) {
        errors.push(`${path || 'arguments'}: missing required property '${req}'`);
      }
    }
    return out;
  }
  if (t === 'string') {
    if (typeof value !== 'string') {
      errors.push(`${path}: expected string, got ${typeof value}`);
      return value;
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than maxLength ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match pattern ${schema.pattern}`);
    return value;
  }
  if (t === 'integer' || t === 'number') {
    const num = typeof value === 'number' ? value : typeof value === 'string' && value !== '' && !Number.isNaN(Number(value)) ? Number(value) : value;
    if (typeof num !== 'number' || Number.isNaN(num)) {
      errors.push(`${path}: expected ${t}, got ${typeof value}`);
      return value;
    }
    if (t === 'integer' && !isInteger(num)) {
      errors.push(`${path}: expected integer, got ${num}`);
      return value;
    }
    if (schema.minimum !== undefined && num < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && num > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
    return num;
  }
  if (t === 'boolean') {
    if (typeof value !== 'boolean') {
      errors.push(`${path}: expected boolean, got ${typeof value}`);
      return value;
    }
    return value;
  }
  // Unknown type in OUR own schemas = authoring bug: fail closed.
  errors.push(`${path}: unsupported schema type '${String(t)}' (fail-closed)`);
  return value;
}

/**
 * Truncate + stringify a tool result for event previews / model context.
 * Deterministic, size-bounded (MD §11.5: output size limits).
 */
export function truncateText(text, maxChars) {
  const s = typeof text === 'string' ? text : safeStringify(text);
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}…[truncated ${s.length - maxChars} chars]`;
}

export function safeStringify(value) {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? String(value) : s;
  } catch {
    return String(value);
  }
}
