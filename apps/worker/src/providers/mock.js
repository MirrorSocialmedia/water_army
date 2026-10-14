/**
 * Orchestratable mock provider (施工 MD §17 Phase 3) — deterministic
 * stand-in for a real model so the WHOLE P3 lifecycle (tool calls, approval,
 * retries, timeout, cancel, SSE) is testable without a model server.
 *
 * Script source (env AI_MOCK_SCRIPT, resolved once per run):
 *   - built-in name: default | tool-docker-list | tool-restart-approve |
 *     slow | fail-then-ok | fail-auth | fail-bad-request | empty
 *   - absolute/relative file path to a JSON script
 *   - inline JSON (string starting with '{' or '[')
 *
 * Script shape:
 *   { "steps": [ {step}, ... ] }   (or a bare array of steps)
 *
 * A step:
 *   { "delayMs": 250 }                    — sleep (abort-aware)
 *   { "error": "PROVIDER_NETWORK", "errorMessage": "..." }
 *   { "content": "...", "finishReason": "stop" }
 *   { "toolCalls": [{ "name": "docker.list_managed_containers", "arguments": {} }] }
 *   — fields may be combined; a step is CONSUMED once per provider.chat()
 *
 * The step cursor is per provider INSTANCE (= per run, shared across
 * attempts): `fail-then-ok` therefore demos engine-level auto-retry —
 * attempt 1 burns the error step, attempt 2 gets the success step.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROVIDER_ERROR, ProviderError } from '@water-army/shared';

export const MOCK_BUILTIN_SCRIPTS = Object.freeze({
  default: {
    steps: [{ content: 'Mock provider response (script "default"). No tool calls needed.', finishReason: 'stop' }],
  },
  'tool-docker-list': {
    steps: [
      { toolCalls: [{ name: 'docker.list_managed_containers', arguments: {} }] },
      { content: 'I listed the managed containers via the tool. All reported states are in the tool result above.', finishReason: 'stop' },
    ],
  },
  'tool-restart-approve': {
    steps: [
      {
        toolCalls: [{ name: 'docker.restart_managed', arguments: { container: 'water-army-web-1' } }],
      },
      { content: 'Restart approval handled and the operation result is in the tool result above.', finishReason: 'stop' },
    ],
  },
  slow: {
    steps: [{ delayMs: 2500, content: 'Slow mock response.', finishReason: 'stop' }],
  },
  'fail-then-ok': {
    steps: [
      { error: PROVIDER_ERROR.NETWORK, errorMessage: 'connection reset by peer (mock transient fault)' },
      { content: 'Recovered after a transient network fault (mock fail-then-ok).', finishReason: 'stop' },
    ],
  },
  'fail-auth': {
    steps: [{ error: PROVIDER_ERROR.AUTH, errorMessage: 'invalid api key (mock)' }],
  },
  'fail-bad-request': {
    steps: [{ error: PROVIDER_ERROR.BAD_REQUEST, errorMessage: 'model not found (mock)' }],
  },
  empty: {
    steps: [{ content: '', finishReason: 'stop' }],
  },
});

// Short aliases accepted in scripts: NETWORK → PROVIDER_NETWORK, …
const ERROR_ALIASES = Object.freeze({
  NETWORK: PROVIDER_ERROR.NETWORK,
  TIMEOUT: PROVIDER_ERROR.TIMEOUT,
  RATE_LIMITED: PROVIDER_ERROR.RATE_LIMITED,
  SERVER: PROVIDER_ERROR.SERVER,
  AUTH: PROVIDER_ERROR.AUTH,
  BAD_REQUEST: PROVIDER_ERROR.BAD_REQUEST,
  NOT_FOUND: PROVIDER_ERROR.NOT_FOUND,
  INVALID_RESPONSE: PROVIDER_ERROR.INVALID_RESPONSE,
  ABORTED: PROVIDER_ERROR.ABORTED,
  GENERIC: PROVIDER_ERROR.GENERIC,
});

const VALID_ERROR_CODES = new Set(Object.values(PROVIDER_ERROR));

function validateStep(step, i) {
  if (step == null || typeof step !== 'object' || Array.isArray(step)) {
    throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, `mock script step[${i}] must be an object`);
  }
  for (const key of Object.keys(step)) {
    if (!['delayMs', 'error', 'errorMessage', 'content', 'toolCalls', 'finishReason'].includes(key)) {
      throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, `mock script step[${i}] has unknown field '${key}'`);
    }
  }
  if (step.delayMs !== undefined && (!Number.isFinite(step.delayMs) || step.delayMs < 0)) {
    throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, `mock script step[${i}].delayMs must be a number >= 0`);
  }
  if (step.error !== undefined) {
    const code = ERROR_ALIASES[step.error] ?? step.error;
    if (!VALID_ERROR_CODES.has(code)) {
      throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, `mock script step[${i}].error '${step.error}' is not a valid provider error code`);
    }
    step.error = code;
  }
  if (step.errorMessage !== undefined && typeof step.errorMessage !== 'string') {
    throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, `mock script step[${i}].errorMessage must be a string`);
  }
  if (step.content !== undefined && typeof step.content !== 'string') {
    throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, `mock script step[${i}].content must be a string`);
  }
  if (step.finishReason !== undefined && !['stop', 'tool_calls'].includes(step.finishReason)) {
    throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, `mock script step[${i}].finishReason must be 'stop' or 'tool_calls'`);
  }
  if (step.toolCalls !== undefined) {
    if (!Array.isArray(step.toolCalls) || step.toolCalls.length === 0) {
      throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, `mock script step[${i}].toolCalls must be a non-empty array`);
    }
    step.toolCalls.forEach((tc, j) => {
      if (tc == null || typeof tc !== 'object' || typeof tc.name !== 'string' || tc.name.length === 0) {
        throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, `mock script step[${i}].toolCalls[${j}].name must be a non-empty string`);
      }
      if (tc.arguments !== undefined && (tc.arguments == null || typeof tc.arguments !== 'object' || Array.isArray(tc.arguments))) {
        throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, `mock script step[${i}].toolCalls[${j}].arguments must be an object`);
      }
    });
  }
  if (step.error === undefined && step.content === undefined && step.toolCalls === undefined && step.delayMs === undefined) {
    throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, `mock script step[${i}] does nothing (need content/toolCalls/error/delayMs)`);
  }
}

/**
 * Resolve the AI_MOCK_SCRIPT raw value into a validated { steps: [...] }.
 * @param {string|undefined} raw
 */
export function resolveMockScript(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  let obj;
  if (s === '') {
    obj = MOCK_BUILTIN_SCRIPTS.default;
  } else if (MOCK_BUILTIN_SCRIPTS[s]) {
    obj = MOCK_BUILTIN_SCRIPTS[s];
  } else if (s.startsWith('{') || s.startsWith('[')) {
    try {
      obj = JSON.parse(s);
    } catch (e) {
      throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, `AI_MOCK_SCRIPT inline JSON is invalid: ${e.message}`);
    }
  } else {
    const p = path.isAbsolute(s) ? s : path.join(process.cwd(), s);
    let text;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch (e) {
      throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, `AI_MOCK_SCRIPT file not readable (${p}): ${e.code ?? e.message}`);
    }
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, `AI_MOCK_SCRIPT file is not valid JSON (${p}): ${e.message}`);
    }
  }
  const steps = Array.isArray(obj) ? obj : obj?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, 'mock script must be an array of steps or { "steps": [...] } (non-empty)');
  }
  steps.forEach(validateStep);
  // Deep-freeze is overkill; a shallow copy keeps builtin scripts safe from mutation.
  return { steps: steps.map((st) => ({ ...st })) };
}

async function abortableSleep(ms, signal) {
  if (ms <= 0) return;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new ProviderError(PROVIDER_ERROR.ABORTED, 'aborted during mock delay', { cause: signal?.reason }));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * @param {{ scriptName?: string, log?: object }} opts
 */
export function createMockProvider({ scriptName, log = console } = {}) {
  const script = resolveMockScript(scriptName);
  let cursor = 0;

  return {
    name: 'mock',
    kind: 'mock',
    model: `mock/${scriptName ?? 'default'}`,
    /** Remaining unconsumed steps (for tests + /health-style introspection). */
    get remainingSteps() {
      return Math.max(0, script.steps.length - cursor);
    },
    async chat({ signal, onEvent } = {}) {
      if (cursor >= script.steps.length) {
        // Script exhausted: return an empty stop. The engine's maxToolRounds
        // guard also bounds the loop, so this is safe.
        return { finishReason: 'stop', content: '', toolCalls: [], usage: null, model: this.model };
      }
      const step = script.steps[cursor];
      const stepNo = cursor + 1;
      cursor += 1;

      if (step.delayMs) {
        onEvent?.({ type: 'mock_step', step: stepNo, delayMs: step.delayMs });
        await abortableSleep(step.delayMs, signal);
      }
      onEvent?.({ type: 'mock_step', step: stepNo });

      if (step.error) {
        log?.debug?.({ step: stepNo, code: step.error }, 'mock provider raising scripted error');
        throw new ProviderError(step.error, step.errorMessage ?? `mock scripted error (${step.error})`, {
          statusCode: step.error === PROVIDER_ERROR.RATE_LIMITED ? 429 : undefined,
        });
      }
      const toolCalls = (step.toolCalls ?? []).map((tc, i) => ({
        id: `mock-tc-${stepNo}-${i + 1}`,
        name: tc.name,
        arguments: { ...(tc.arguments ?? {}) },
      }));
      // OpenAI semantics: a step with tool calls finishes as 'tool_calls'
      // unless the script says otherwise explicitly.
      const finishReason = step.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop');
      return {
        finishReason,
        content: step.content ?? null,
        toolCalls,
        usage: { promptTokens: 12, completionTokens: 34 },
        model: this.model,
      };
    },
  };
}
