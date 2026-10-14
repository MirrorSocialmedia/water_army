/**
 * OpenAI-compatible chat-completions provider adapter (施工 MD §17 Phase 3).
 *
 * Works against any `/v1/chat/completions` endpoint (OpenAI, vLLM, SGLang,
 * LM Studio, Ollama-with-compat, …) — baseUrl + apiKey + model, configured
 * per provider in the provider_configs table (key encrypted at rest).
 *
 * Contract (provider interface, also implemented by the mock):
 *   chat({ messages, tools, signal, onEvent }) →
 *     { finishReason: 'stop'|'tool_calls', content: string|null,
 *       toolCalls: [{id, name, arguments}], usage, model }
 *   throws ProviderError (classified, secrets redacted) on failure.
 *
 * Error classification (MD §11.8): 401/403 → AUTH (never retried), 429 →
 * RATE_LIMITED, 5xx → SERVER, 400 → BAD_REQUEST, 404 → NOT_FOUND,
 * network/timeout → NETWORK/TIMEOUT. Transient codes get bounded internal
 * retries (default 2, exponential backoff) BEFORE the engine sees the error;
 * the engine then decides run-level auto-retry (new attempt) from the same
 * RETRYABLE set.
 *
 * Security: the API key is sent only in the Authorization header, is redacted
 * from every error message, and never logged. Responses are size-capped
 * before JSON.parse (oversize → INVALID_RESPONSE, not a crash).
 */
import {
  PROVIDER_ERROR,
  RETRYABLE_PROVIDER_ERRORS,
  backoffDelay,
  ProviderError,
  safeStringify,
} from '@water-army/shared';

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 2_000_000; // 2MB — a chat completion never needs more
const MAX_TOOL_CALLS = 8;

/** Redact the provider's own API key + common secret patterns from provider messages. */
function redact(text, apiKey) {
  let out = String(text ?? '');
  if (apiKey) out = out.split(apiKey).join('***');
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, 'sk-***');
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}/gi, '$1***');
  return out.slice(0, 500);
}

async function abortableSleep(ms, signal) {
  if (ms <= 0) return;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => {
      cleanup();
      reject(new ProviderError(PROVIDER_ERROR.ABORTED, 'aborted during backoff sleep', { cause: signal?.reason }));
    };
    const cleanup = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description ?? '', parameters: t.parameters },
  }));
}

/**
 * @param {object} opts
 * @param {string} opts.baseUrl e.g. `http://host:8000/v1` (or a full …/chat/completions URL)
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {number} [opts.maxRetries] internal transient retries (default 2)
 * @param {number} [opts.baseDelayMs] backoff base (default 500)
 * @param {number} [opts.maxDelayMs] backoff cap (default 5000)
 * @param {number} [opts.requestTimeoutMs] per-request cap (default 120000)
 * @param {(input: Request) => Promise<Response>} [opts.fetchImpl] injectable for tests
 * @param {object} [opts.log]
 */
export function createOpenAICompatibleProvider({
  baseUrl,
  apiKey,
  model,
  maxRetries = DEFAULT_MAX_RETRIES,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetchImpl,
  log = console,
}) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, 'openai-compatible provider requires baseUrl');
  }
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, 'openai-compatible provider requires apiKey');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, 'openai-compatible provider requires model');
  }
  const fetchFn = fetchImpl ?? globalThis.fetch;
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const url = trimmedBase.endsWith('/chat/completions') ? trimmedBase : `${trimmedBase}/chat/completions`;
  const maxAttempts = 1 + Math.max(0, Math.floor(maxRetries));

  async function attemptOnce({ messages, tools, signal }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('request timeout')), requestTimeoutMs);
    let onAbort = null;
    if (signal) {
      onAbort = () => ctrl.abort(signal.reason ?? new Error('aborted'));
      if (signal.aborted) ctrl.abort(signal.reason ?? new Error('aborted'));
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    let res;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages,
          ...(tools.length > 0 ? { tools: toOpenAITools(tools) } : {}),
          stream: false,
        }),
        signal: ctrl.signal,
      });
    } catch (err) {
      const abortedByCaller = signal?.aborted === true;
      throw new ProviderError(
        abortedByCaller ? PROVIDER_ERROR.ABORTED : PROVIDER_ERROR.NETWORK,
        abortedByCaller
          ? 'request aborted (cancel/timeout)'
          : `network error: ${redact(err?.message, apiKey)}`,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }

    // Size-cap BEFORE parsing (hostile/hung provider must not blow the heap).
    const body = await res.text().catch((err) => {
      throw new ProviderError(PROVIDER_ERROR.NETWORK, `response read failed: ${redact(err?.message, apiKey)}`, { cause: err });
    });
    if (body.length > MAX_RESPONSE_BYTES) {
      throw new ProviderError(PROVIDER_ERROR.INVALID_RESPONSE, `response exceeds ${MAX_RESPONSE_BYTES} bytes, discarded`);
    }

    if (!res.ok) {
      let apiMessage = '';
      try {
        const parsed = JSON.parse(body);
        apiMessage = typeof parsed?.error?.message === 'string' ? parsed.error.message : String(body).slice(0, 200);
      } catch {
        apiMessage = body.slice(0, 200);
      }
      const msg = redact(apiMessage, apiKey);
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError(PROVIDER_ERROR.AUTH, `authentication failed (HTTP ${res.status}): ${msg}`, { statusCode: res.status });
      }
      if (res.status === 429) {
        throw new ProviderError(PROVIDER_ERROR.RATE_LIMITED, `rate limited (HTTP 429): ${msg}`, { statusCode: 429 });
      }
      if (res.status >= 500) {
        throw new ProviderError(PROVIDER_ERROR.SERVER, `provider server error (HTTP ${res.status}): ${msg}`, { statusCode: res.status });
      }
      if (res.status === 404) {
        throw new ProviderError(PROVIDER_ERROR.NOT_FOUND, `not found (HTTP 404): ${msg}`, { statusCode: 404 });
      }
      if (res.status === 400) {
        throw new ProviderError(PROVIDER_ERROR.BAD_REQUEST, `bad request (HTTP 400): ${msg}`, { statusCode: 400 });
      }
      throw new ProviderError(PROVIDER_ERROR.GENERIC, `provider error (HTTP ${res.status}): ${msg}`, { statusCode: res.status });
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new ProviderError(PROVIDER_ERROR.INVALID_RESPONSE, 'provider returned non-JSON body');
    }
    const choice = data?.choices?.[0];
    if (!choice || typeof choice !== 'object' || !choice.message) {
      throw new ProviderError(PROVIDER_ERROR.INVALID_RESPONSE, 'provider response missing choices[0].message');
    }

    const rawToolCalls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [];
    if (rawToolCalls.length > MAX_TOOL_CALLS) {
      throw new ProviderError(PROVIDER_ERROR.INVALID_RESPONSE, `too many tool calls (${rawToolCalls.length}) in one response`);
    }
    const toolCalls = rawToolCalls.map((tc, i) => {
      const name = tc?.function?.name;
      if (typeof name !== 'string' || name.length === 0) {
        throw new ProviderError(PROVIDER_ERROR.INVALID_RESPONSE, `tool_calls[${i}] missing function.name`);
      }
      let args = {};
      const rawArgs = tc.function.arguments;
      if (rawArgs != null && rawArgs !== '') {
        try {
          const parsed = JSON.parse(rawArgs);
          if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('arguments must be a JSON object');
          }
          args = parsed;
        } catch {
          throw new ProviderError(PROVIDER_ERROR.INVALID_RESPONSE, `tool_calls[${i}] (${name}) arguments are not a JSON object`);
        }
      }
      return { id: typeof tc.id === 'string' && tc.id ? tc.id : `call_${i}`, name, arguments: args };
    });

    let content = choice.message.content;
    if (content == null) content = null;
    else if (typeof content !== 'string') content = safeStringify(content);

    return {
      finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
      content,
      toolCalls,
      usage: data.usage
        ? { promptTokens: data.usage.prompt_tokens ?? 0, completionTokens: data.usage.completion_tokens ?? 0 }
        : null,
      model: typeof data.model === 'string' ? data.model : model,
    };
  }

  return {
    name: 'openai-compatible',
    kind: 'openai-compatible',
    model,
    /** One completion round. The agentic tool loop lives in the engine. */
    async chat({ messages, tools = [], signal, onEvent } = {}) {
      let lastErr;
      for (let i = 1; i <= maxAttempts; i += 1) {
        if (signal?.aborted) {
          throw new ProviderError(PROVIDER_ERROR.ABORTED, 'aborted before provider attempt', { cause: signal.reason });
        }
        try {
          const result = await attemptOnce({ messages, tools, signal });
          if (i > 1) log?.debug?.({ attempt: i }, 'provider succeeded after internal retries');
          return result;
        } catch (err) {
          lastErr = err;
          const transient =
            err instanceof ProviderError &&
            RETRYABLE_PROVIDER_ERRORS.has(err.apiCode) &&
            i < maxAttempts;
          if (!transient) throw err;
          const delayMs = backoffDelay(i, { baseMs: baseDelayMs, maxMs: maxDelayMs, jitter: 0.25 });
          log?.warn?.({ code: err.apiCode, attempt: i, delayMs }, 'provider transient error, internal retry');
          onEvent?.({ type: 'provider_retry', code: err.apiCode, attempt: i, delayMs });
          await abortableSleep(delayMs, signal);
        }
      }
      throw lastErr;
    },
  };
}
