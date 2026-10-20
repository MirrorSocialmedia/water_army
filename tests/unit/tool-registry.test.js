/**
 * Tool Registry (施工 MD §11.4/§11.5) — safety-class fail-closed behaviour,
 * arg schema validation, and "unapproved tool must not execute" guards.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_REGISTRY,
  findTool,
  isToolClassEnabled,
  validateToolArgs,
  truncateText,
} from '../../packages/shared/src/tool-registry.js';
import { TOOL_SAFETY_CLASS } from '../../packages/shared/src/task-constants.js';

test('registry: P3 exposes exactly the readonly + one approval_required tools; no shell/raw tools', () => {
  const names = TOOL_REGISTRY.map((t) => t.name);
  assert.deepEqual(names.sort(), [
    'docker.get_managed_container_logs',
    'docker.get_managed_container_status',
    'docker.list_managed_containers',
    'docker.restart_managed',
    'redroid.get_device_status', // R4 MD §6.3 — worker fail-closed gate (readonly GET)
    'system.get_health',
  ]);
  for (const t of TOOL_REGISTRY) {
    assert.ok([TOOL_SAFETY_CLASS.READONLY, TOOL_SAFETY_CLASS.APPROVAL_REQUIRED].includes(t.safetyClass));
    assert.ok(t.parameters.type === 'object', `${t.name}: parameters must be an object schema`);
  }
  // MD §11.4: no shell.exec / docker.raw_api / arbitrary ADB — ever
  assert.equal(names.some((n) => /shell|exec|raw|adb/i.test(n)), false);
});

test('findTool: unknown names → null (fail-closed); non-string → null', () => {
  assert.equal(findTool('docker.list_managed_containers'), TOOL_REGISTRY[1]);
  assert.equal(findTool('shell.exec'), null);
  assert.equal(findTool('docker.raw_api'), null);
  assert.equal(findTool(undefined), null);
  assert.equal(findTool(42), null);
  assert.equal(findTool(''), null);
});

test('safety-class gate: only readonly + approval_required enabled (fail-closed on future classes)', () => {
  assert.equal(isToolClassEnabled(TOOL_SAFETY_CLASS.READONLY), true);
  assert.equal(isToolClassEnabled(TOOL_SAFETY_CLASS.APPROVAL_REQUIRED), true);
  assert.equal(isToolClassEnabled(TOOL_SAFETY_CLASS.DISABLED), false);
  assert.equal(isToolClassEnabled('stateful_medium_risk'), false, 'unknown class must be disabled');
  assert.equal(isToolClassEnabled(undefined), false);
});

test('validateToolArgs: valid args pass; defaults applied; input never mutated', () => {
  const t = findTool('docker.get_managed_container_logs');
  const args = { container: 'abc123' };
  const r = validateToolArgs(t.parameters, args);
  assert.equal(r.ok, true);
  assert.equal(r.value.container, 'abc123');
  assert.equal(r.value.tail, 100, 'default applied');
  assert.equal(args.tail, undefined, 'input not mutated');

  const health = findTool('system.get_health');
  assert.equal(validateToolArgs(health.parameters, {}).ok, true);
});

test('validateToolArgs: rejects unknown properties (additionalProperties:false)', () => {
  const t = findTool('docker.list_managed_containers');
  const r = validateToolArgs(t.parameters, { q: 'api', evil: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /unknown property/);
});

test('validateToolArgs: rejects wrong types / missing required / out-of-range / bad string', () => {
  const statusTool = findTool('docker.get_managed_container_status');
  const logsTool = findTool('docker.get_managed_container_logs');

  let r = validateToolArgs(statusTool.parameters, {});
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /missing required property 'container'/);

  r = validateToolArgs(statusTool.parameters, { container: 12345 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /expected string/);

  r = validateToolArgs(logsTool.parameters, { container: 'x', tail: 3 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /below minimum/);

  r = validateToolArgs(logsTool.parameters, { container: 'x', tail: 501 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /above maximum/);

  r = validateToolArgs(logsTool.parameters, { container: 'x', tail: 'not-a-number' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /expected integer/);

  r = validateToolArgs(statusTool.parameters, { container: 'x'.repeat(192) });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /longer than maxLength/);
});

test('validateToolArgs: nested/garbage objects fail closed; arrays rejected where object expected', () => {
  const t = findTool('system.get_health');
  assert.equal(validateToolArgs(t.parameters, ['array-not-object']).ok, false);
  assert.equal(validateToolArgs({ type: 'object', properties: { a: { type: 'string' } } }, { a: { deep: 1 } }).ok, false);
  // unsupported type keyword = authoring bug → fail closed
  assert.equal(validateToolArgs({ type: 'weird' }, 'x').ok, false);
});

test('truncateText: caps long output and keeps short output intact', () => {
  const short = 'ok';
  assert.equal(truncateText(short, 100), 'ok');
  const long = 'a'.repeat(1000);
  const out = truncateText(long, 10);
  assert.ok(out.startsWith('aaaaaaaaaa'));
  assert.match(out, /truncated 990 chars/);
  const obj = truncateText({ x: 1 }, 100);
  assert.equal(obj, '{"x":1}');
});
