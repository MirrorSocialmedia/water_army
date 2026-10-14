/**
 * Mock provider (施工 MD §17 Phase 3) — script resolution (builtin/file/
 * inline JSON), step consumption semantics, scripted errors, abort-aware
 * delays, fail-closed script validation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createMockProvider,
  resolveMockScript,
  MOCK_BUILTIN_SCRIPTS,
} from '../../apps/worker/src/providers/mock.js';
import { ProviderError, PROVIDER_ERROR } from '../../packages/shared/src/index.js';

const silent = { debug() {}, warn() {}, error() {} };

test('default (no script): single stop step, non-empty content', async () => {
  const p = createMockProvider({ log: silent });
  const res = await p.chat({});
  assert.equal(res.finishReason, 'stop');
  assert.ok(res.content.length > 0);
  assert.equal(res.toolCalls.length, 0);
  assert.ok(res.usage);
});

test('builtin scripts: tool-docker-list consumes 2 steps (tool round then answer)', async () => {
  const p = createMockProvider({ scriptName: 'tool-docker-list', log: silent });
  const step1 = await p.chat({});
  assert.equal(step1.finishReason, 'tool_calls');
  assert.equal(step1.toolCalls.length, 1);
  assert.equal(step1.toolCalls[0].name, 'docker.list_managed_containers');
  assert.deepEqual(step1.toolCalls[0].arguments, {});
  assert.ok(step1.toolCalls[0].id, 'tool calls get stable ids');

  const step2 = await p.chat({});
  assert.equal(step2.finishReason, 'stop');
  assert.ok(step2.content.includes('tool result'));

  // exhausted → empty stop, no infinite loop
  const step3 = await p.chat({});
  assert.equal(step3.content, '');
  assert.equal(step3.finishReason, 'stop');
});

test('fail-then-ok: cursor is per-instance — attempt 2 gets the success step', async () => {
  const p = createMockProvider({ scriptName: 'fail-then-ok', log: silent });
  await assert.rejects(
    () => p.chat({}),
    (e) => e instanceof ProviderError && e.apiCode === PROVIDER_ERROR.NETWORK,
  );
  const ok = await p.chat({}); // "attempt 2"
  assert.equal(ok.finishReason, 'stop');
  assert.ok(ok.content.includes('Recovered'));
});

test('scripted errors: AUTH and BAD_REQUEST map to the right codes', async () => {
  const a = createMockProvider({ scriptName: 'fail-auth', log: silent });
  await assert.rejects(() => a.chat({}), (e) => e.apiCode === PROVIDER_ERROR.AUTH);

  const b = createMockProvider({ scriptName: 'fail-bad-request', log: silent });
  await assert.rejects(() => b.chat({}), (e) => e.apiCode === PROVIDER_ERROR.BAD_REQUEST);
});

test('inline JSON script: steps + delayMs + errorMessage; abort during delay → ABORTED', async () => {
  const inline = JSON.stringify({
    steps: [
      { delayMs: 300, content: 'after delay', finishReason: 'stop' },
    ],
  });
  const p = createMockProvider({ scriptName: inline, log: silent });
  const events = [];
  const t0 = Date.now();
  const res = await p.chat({ onEvent: (e) => events.push(e) });
  assert.ok(Date.now() - t0 >= 250, 'delay was honoured');
  assert.equal(res.content, 'after delay');
  assert.ok(events.some((e) => e.type === 'mock_step'));

  // abort mid-delay
  const slow = createMockProvider({
    scriptName: JSON.stringify({ steps: [{ delayMs: 5_000, content: 'never' }] }),
    log: silent,
  });
  const ac = new AbortController();
  const p2 = slow.chat({ signal: ac.signal });
  setTimeout(() => ac.abort(new Error('cancelled')), 30);
  await assert.rejects(p2, (e) => e.apiCode === PROVIDER_ERROR.ABORTED);
});

test('file script: absolute path resolves; relative path resolves against cwd; unreadable file → NOT_CONFIGURED', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-script-'));
  const prevCwd = process.cwd();
  try {
    const file = path.join(dir, 'script.json');
    fs.writeFileSync(file, JSON.stringify({ steps: [{ content: 'from file', finishReason: 'stop' }] }));
    const abs = createMockProvider({ scriptName: file, log: silent });
    assert.equal((await abs.chat({})).content, 'from file');

    process.chdir(dir);
    try {
      const rel = createMockProvider({ scriptName: 'script.json', log: silent });
      assert.equal((await rel.chat({})).content, 'from file');
    } finally {
      process.chdir(prevCwd);
    }

    // Script resolution is eager (fail-fast at construction): bad file → sync throw.
    assert.throws(
      () => createMockProvider({ scriptName: path.join(dir, 'nope.json'), log: silent }),
      (e) => e instanceof ProviderError && e.apiCode === PROVIDER_ERROR.NOT_CONFIGURED,
    );
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('script validation: fail-closed on unknown fields, empty steps, bad toolCalls, bad finishReason, unknown builtin', () => {
  const bad = [
    JSON.stringify({ steps: [{ content: 'x', bogus: 1 }] }),
    JSON.stringify({ steps: [] }),
    JSON.stringify({ steps: 'nope' }),
    JSON.stringify('not an object'),
    JSON.stringify({ steps: [{ content: 'x', finishReason: 'explode' }] }),
    JSON.stringify({ steps: [{ toolCalls: [] }] }),
    JSON.stringify({ steps: [{ toolCalls: [{ name: '' }] }] }),
    JSON.stringify({ steps: [{ toolCalls: [{ name: 't', arguments: [1] }] }] }),
    JSON.stringify({ steps: [{ delayMs: -5 }] }),
    JSON.stringify({ steps: [{ error: 'EXPLODE' }] }),
    'not json at all {',
  ];
  for (const s of bad) {
    assert.throws(
      () => resolveMockScript(s),
      (e) => e instanceof ProviderError && e.apiCode === PROVIDER_ERROR.NOT_CONFIGURED,
      `should reject: ${s}`,
    );
  }
  // unknown builtin that is not JSON/path → NOT_CONFIGURED (no silent default)
  assert.throws(
    () => resolveMockScript('definitely-not-a-builtin'),
    (e) => e.apiCode === PROVIDER_ERROR.NOT_CONFIGURED,
  );
});

test('error aliases: short names (NETWORK/AUTH/...) normalize to PROVIDER_* codes', async () => {
  const p = createMockProvider({
    scriptName: JSON.stringify({ steps: [{ error: 'NETWORK', errorMessage: 'alias net' }, { content: 'after' }] }),
    log: silent,
  });
  await assert.rejects(() => p.chat({}), (e) => e.apiCode === PROVIDER_ERROR.NETWORK && /alias net/.test(e.message));
  const ok = await p.chat({});
  assert.equal(ok.content, 'after');

  const q = createMockProvider({
    scriptName: JSON.stringify({ steps: [{ error: 'RATE_LIMITED' }] }),
    log: silent,
  });
  await assert.rejects(() => q.chat({}), (e) => e.apiCode === PROVIDER_ERROR.RATE_LIMITED && e.statusCode === 429);
});

test('all builtins are pre-validated (regression guard for typos in the table)', () => {
  for (const [name, script] of Object.entries(MOCK_BUILTIN_SCRIPTS)) {
    assert.doesNotThrow(() => resolveMockScript(name), `builtin '${name}' must parse`);
  }
});
