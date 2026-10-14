/**
 * OpenAI-compatible provider (施工 MD §11.7/§11.8) — hermetic via injected
 * fetchImpl: success shapes, tool_calls parsing, full HTTP error taxonomy,
 * bounded internal retry on transient codes only, abort propagation,
 * oversize-body guard, secret redaction in error messages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createOpenAICompatibleProvider } from '../../apps/worker/src/providers/openai-compatible.js';
import { ProviderError, PROVIDER_ERROR } from '../../packages/shared/src/index.js';

const API_KEY = 'sk-live-supersecret123456';
const BASE = { baseUrl: 'http://model.test/v1', apiKey: API_KEY, model: 'test-model' };

function makeProvider({ responses, ...rest } = {}) {
  const calls = [];
  const seq = Array.isArray(responses) ? responses : [responses];
  let i = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const r = seq[Math.min(i, seq.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    // Two forms: raw payload object ({choices:...}) or envelope ({status, body|json}).
    const isEnvelope = r != null && typeof r === 'object' && !Array.isArray(r) && ('status' in r || 'body' in r || 'json' in r);
    if (isEnvelope) {
      const { status = 200, body, json } = r;
      const text = json !== undefined ? JSON.stringify(json) : (body ?? '{"error":{"message":"?"}}');
      return new Response(text, { status, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAICompatibleProvider({
    ...BASE,
    baseDelayMs: 1,
    maxDelayMs: 2,
    fetchImpl,
    log: { debug() {}, warn() {} },
    ...rest,
  });
  return { provider, calls };
}

const okJson = (over = {}) => ({
  id: 'chatcmpl-1',
  model: 'test-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
  ...over,
});

test('success: content + usage + model parsed; request body has messages/tools/no stream', async () => {
  const { provider, calls } = makeProvider({ responses: [okJson()] });
  const events = [];
  const res = await provider.chat({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'system.get_health', description: 'x', parameters: { type: 'object' } }],
    onEvent: (e) => events.push(e),
  });
  assert.equal(res.finishReason, 'stop');
  assert.equal(res.content, 'hello');
  assert.deepEqual(res.usage, { promptTokens: 10, completionTokens: 5 });
  assert.equal(res.toolCalls.length, 0);

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'test-model');
  assert.equal(body.messages[0].content, 'hi');
  assert.equal(body.stream, false);
  assert.equal(body.tools[0].function.name, 'system.get_health');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(calls[0].url, 'http://model.test/v1/chat/completions');
  assert.equal(events.length, 0, 'no retry events on clean success');
});

test('success: baseUrl already ending in /chat/completions is not double-suffixed', async () => {
  const { provider, calls } = makeProvider({
    responses: [okJson()],
    baseUrl: 'http://model.test/v1/chat/completions',
  });
  await provider.chat({ messages: [] });
  assert.equal(calls[0].url, 'http://model.test/v1/chat/completions');
});

test('tool_calls: arguments JSON-parsed into objects; ids preserved', async () => {
  const { provider } = makeProvider({
    responses: [
      okJson({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_abc', function: { name: 'docker.list_managed_containers', arguments: '{"q":"api"}' } },
                { id: 'call_def', function: { name: 'docker.get_managed_container_logs', arguments: '' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    ],
  });
  const res = await provider.chat({ messages: [] });
  assert.equal(res.finishReason, 'tool_calls');
  assert.equal(res.content, null);
  assert.equal(res.toolCalls.length, 2);
  assert.deepEqual(res.toolCalls[0], { id: 'call_abc', name: 'docker.list_managed_containers', arguments: { q: 'api' } });
  assert.deepEqual(res.toolCalls[1], { id: 'call_def', name: 'docker.get_managed_container_logs', arguments: {} });
});

test('HTTP taxonomy: 401→AUTH, 403→AUTH, 429→RATE_LIMITED, 500→SERVER, 404→NOT_FOUND, 400→BAD_REQUEST, 418→GENERIC', async () => {
  const cases = [
    [401, PROVIDER_ERROR.AUTH, 401],
    [403, PROVIDER_ERROR.AUTH, 403],
    [429, PROVIDER_ERROR.RATE_LIMITED, 429],
    [500, PROVIDER_ERROR.SERVER, 500],
    [502, PROVIDER_ERROR.SERVER, 502],
    [503, PROVIDER_ERROR.SERVER, 503],
    [404, PROVIDER_ERROR.NOT_FOUND, 404],
    [400, PROVIDER_ERROR.BAD_REQUEST, 400],
    [418, PROVIDER_ERROR.GENERIC, 418],
  ];
  for (const [status, code, expectedStatus] of cases) {
    const { provider, calls } = makeProvider({
      responses: [{ status, json: { error: { message: `boom ${status}` } } }],
      maxRetries: 0, // isolate classification
    });
    await assert.rejects(
      () => provider.chat({ messages: [] }),
      (e) => e instanceof ProviderError && e.apiCode === code && e.statusCode === expectedStatus,
      `status ${status}`,
    );
    assert.equal(calls.length, 1, `${status}: not retried with maxRetries=0`);
  }
});

test('retryability: 429 retried then recovered; 401 never retried; exhausted transients rethrow last error', async () => {
  // 429 → 200 with maxRetries=1
  let { provider, calls } = makeProvider({
    responses: [
      { status: 429, json: { error: { message: 'slow down' } } },
      okJson(),
    ],
    maxRetries: 1,
  });
  const events = [];
  const res = await provider.chat({ messages: [], onEvent: (e) => events.push(e) });
  assert.equal(res.content, 'hello');
  assert.equal(calls.length, 2, 'retried once');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'provider_retry');
  assert.equal(events[0].code, PROVIDER_ERROR.RATE_LIMITED);

  // 401 with maxRetries=3 → still exactly one call
  ({ provider, calls } = makeProvider({
    responses: [{ status: 401, json: { error: { message: 'nope' } } }],
    maxRetries: 3,
  }));
  await assert.rejects(() => provider.chat({ messages: [] }), (e) => e.apiCode === PROVIDER_ERROR.AUTH);
  assert.equal(calls.length, 1, 'AUTH must never be auto-retried');

  // 500 twice then exhausted (maxRetries=1 → 2 attempts)
  ({ provider, calls } = makeProvider({
    responses: [{ status: 500, json: { error: { message: 'broken' } } }],
    maxRetries: 1,
  }));
  await assert.rejects(() => provider.chat({ messages: [] }), (e) => e.apiCode === PROVIDER_ERROR.SERVER);
  assert.equal(calls.length, 2, 'transient retried up to cap then rethrown');
});

test('network errors: fetch throw → NETWORK (retried); DNS-style failure exhausted rethrows NETWORK', async () => {
  let { provider, calls } = makeProvider({ responses: [new Error('fetch failed')] });
  await assert.rejects(() => provider.chat({ messages: [] }), (e) => e.apiCode === PROVIDER_ERROR.NETWORK);
  assert.equal(calls.length, 3, 'default maxRetries=2 → 3 attempts');

  ({ provider, calls } = makeProvider({
    responses: [new Error('fetch failed'), okJson()],
  }));
  const res = await provider.chat({ messages: [] });
  assert.equal(res.content, 'hello');
  assert.equal(calls.length, 2, 'recovered on second attempt');
});

test('abort: pre-aborted signal → ABORTED immediately; mid-flight abort → ABORTED (not NETWORK)', async () => {
  const { provider, calls } = makeProvider({ responses: [okJson()] });
  const pre = new AbortController();
  pre.abort(new Error('cancelled'));
  await assert.rejects(
    () => provider.chat({ messages: [], signal: pre.signal }),
    (e) => e.apiCode === PROVIDER_ERROR.ABORTED,
  );
  assert.equal(calls.length, 0, 'pre-aborted: no fetch at all');

  // mid-flight: fetch hangs until the (caller's) signal aborts it
  const ac = new AbortController();
  const hangFetch = (url, init) =>
    new Promise((resolve, reject) => {
      if (init.signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      init.signal.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        { once: true },
      );
    });
  const midProvider = createOpenAICompatibleProvider({ ...BASE, fetchImpl: hangFetch, log: { debug() {}, warn() {} } });
  const p = midProvider.chat({ messages: [], signal: ac.signal });
  setTimeout(() => ac.abort(new Error('timeout deadline reached')), 10);
  await assert.rejects(p, (e) => e.apiCode === PROVIDER_ERROR.ABORTED);
});

test('oversize body (>2MB) → INVALID_RESPONSE, not a crash', async () => {
  const big = 'x'.repeat(2_100_000);
  const { provider } = makeProvider({ responses: [{ status: 200, body: `{"choices":[${big}]}` }] });
  await assert.rejects(
    () => provider.chat({ messages: [] }),
    (e) => e instanceof ProviderError && e.apiCode === PROVIDER_ERROR.INVALID_RESPONSE,
  );
});

test('malformed responses: non-JSON / missing choices / bad tool args all → INVALID_RESPONSE (no retry)', async () => {
  let { provider, calls } = makeProvider({ responses: [{ status: 200, body: 'not json' }], maxRetries: 2 });
  await assert.rejects(() => provider.chat({ messages: [] }), (e) => e.apiCode === PROVIDER_ERROR.INVALID_RESPONSE);
  assert.equal(calls.length, 1);

  ({ provider, calls } = makeProvider({ responses: [{ status: 200, json: { choices: [] } }], maxRetries: 2 }));
  await assert.rejects(() => provider.chat({ messages: [] }), (e) => e.apiCode === PROVIDER_ERROR.INVALID_RESPONSE);
  assert.equal(calls.length, 1);

  ({ provider, calls } = makeProvider({
    responses: [
      okJson({
        choices: [
          {
            index: 0,
            message: { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 't.x', arguments: '{bad' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    ],
    maxRetries: 2,
  }));
  await assert.rejects(
    () => provider.chat({ messages: [] }),
    (e) => e.apiCode === PROVIDER_ERROR.INVALID_RESPONSE && /arguments/.test(e.message),
  );
  assert.equal(calls.length, 1);
});

test('redaction: provider API key never appears in error messages', async () => {
  const { provider } = makeProvider({
    responses: [{ status: 401, json: { error: { message: `bad key ${API_KEY} rejected` } } }],
  });
  await assert.rejects(
    () => provider.chat({ messages: [] }),
    (e) => {
      assert.equal(e.apiCode, PROVIDER_ERROR.AUTH);
      assert.ok(!e.message.includes(API_KEY), `key leaked: ${e.message}`);
      return true;
    },
  );
});

test('config: missing baseUrl/apiKey/model → ProviderError NOT_CONFIGURED at construction', () => {
  for (const missing of [['baseUrl'], ['apiKey'], ['model']]) {
    const opts = { ...BASE };
    for (const k of missing) delete opts[k];
    assert.throws(
      () => createOpenAICompatibleProvider({ ...opts, fetchImpl: async () => new Response('x') }),
      (e) => e instanceof ProviderError && e.apiCode === PROVIDER_ERROR.NOT_CONFIGURED,
      `missing ${missing.join(',')}`,
    );
  }
});
