/**
 * Secret scrubbing (施工 MD §13.3) — payload_json must never carry
 * authorization headers, API keys, tokens, passwords.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scrubObject } from '../../packages/shared/src/scrub.js';

test('scrubObject: redacts sensitive keys at any depth, keeps shape', () => {
  const input = {
    message: 'hello',
    headers: { authorization: 'Bearer sk-supersecret', 'x-api-key': 'abc' },
    nested: { config: { apiKey: 'sk-123', timeoutMs: 5000 } },
    list: [{ password: 'p@ss', name: 'ok' }],
    plain_token: 'tok-123',
    'api_key': 'k',
  };
  const out = scrubObject(input);
  assert.equal(out.headers.authorization, '***redacted***');
  assert.equal(out.headers['x-api-key'], '***redacted***');
  assert.equal(out.nested.config.apiKey, '***redacted***');
  assert.equal(out.nested.config.timeoutMs, 5000, 'non-sensitive survives');
  assert.equal(out.list[0].password, '***redacted***');
  assert.equal(out.list[0].name, 'ok');
  assert.equal(out.plain_token, '***redacted***');
  assert.equal(out.api_key, '***redacted***');
  assert.equal(out.message, 'hello');
  // input untouched
  assert.equal(input.headers.authorization, 'Bearer sk-supersecret');
});

test('scrubObject: numeric values under sensitive-looking keys are kept (usage counters)', () => {
  // Regression (P3): OpenAI usage `{ promptTokens, completionTokens }` must
  // survive scrubbing — the keys end in 'Tokens' (camel hump) which matches
  // the sensitive pattern, but a number cannot be a secret.
  const out = scrubObject({ usage: { promptTokens: 12, completionTokens: 34, cacheTokens: null }, ok: true });
  assert.equal(out.usage.promptTokens, 12);
  assert.equal(out.usage.completionTokens, 34);
  assert.equal(out.usage.cacheTokens, null);
  assert.equal(out.ok, true);
  // but a STRING under the same key shape is still redacted
  const out2 = scrubObject({ promptTokens: 'sk-string-secret' });
  assert.equal(out2.promptTokens, '***redacted***');
});

test('scrubObject: truncates long strings; bounded depth/nodes (no DoS via hostile payload)', () => {
  const long = { text: 'x'.repeat(10_000) };
  assert.ok(scrubObject(long, 100).text.length < 200);

  // hostile: 100k-level nesting
  let hostile = 'leaf';
  for (let i = 0; i < 100_000; i += 1) hostile = { a: hostile };
  const out = scrubObject(hostile);
  assert.ok(out, 'returns without hanging');

  // arrays + scalars
  assert.deepEqual(scrubObject([1, 'two', { secretKey: 's' }]), [1, 'two', { secretKey: '***redacted***' }]);
  assert.equal(scrubObject(null), null);
  assert.equal(scrubObject(42), 42);
});

test('scrubObject: a URL with embedded userinfo is ALWAYS redacted, regardless of key (MC P4 §6.2)', () => {
  // The proxy URL carries the egress credential — key names like `proxyUrl`
  // slip past the key rules, so the VALUE is the guard (MD §13: proxy URL
  // 永不入 log/DB).
  const proxy = 'socks5://userA:topsecret-passw0rd@proxy-a.example:7801';
  const out = scrubObject({ proxyUrl: proxy, evidence: { dest: proxy }, note: `tunnel via ${proxy} failed`, plain: 'ok' });
  assert.equal(out.proxyUrl, '***redacted***', 'proxyUrl key — redacted by value rule');
  assert.equal(out.evidence.dest, '***redacted***', 'nested value — redacted');
  assert.equal(out.note, '***redacted***', 'embedded in a longer string — the whole value is a secret');
  assert.equal(out.plain, 'ok');

  // plain URLs (no embedded credential) are NOT secrets — they survive
  assert.equal(scrubObject({ page: 'https://example.com/docs' }).page, 'https://example.com/docs');
  assert.equal(scrubObject({ ip: 'http://127.0.0.1:8080/api' }).ip, 'http://127.0.0.1:8080/api');
  assert.equal(scrubObject({ page: 'ftp://files.example.com/x.txt' }).page, 'ftp://files.example.com/x.txt');
});
