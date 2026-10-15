/**
 * P6 — task-utils: the `skipped` status (P4 overlap / P6 concurrency_key)
 * must render as terminal + non-cancellable + non-retryable, with a warn tone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TASK_TERMINAL,
  TASK_STATUSES,
  isTerminalStatus,
  canCancel,
  canRetry,
  taskBadgeClass,
  flowSteps,
} from '../../apps/web/src/components/task-utils.js';

test('skipped is a terminal status in the UI model', () => {
  assert.ok(TASK_TERMINAL.includes('skipped'));
  assert.ok(TASK_STATUSES.includes('skipped'), 'appears in the filter dropdown');
  assert.equal(isTerminalStatus('skipped'), true);
});

test('skipped: cannot cancel, cannot retry (consistent with state machine)', () => {
  assert.equal(canCancel('skipped'), false);
  assert.equal(canRetry('skipped'), false);
  // other terminals unchanged
  assert.equal(canRetry('failed'), true);
  assert.equal(canCancel('queued'), true);
});

test('skipped renders with a warn tone (not error)', () => {
  assert.equal(taskBadgeClass('skipped'), 'task-warn');
  const steps = flowSteps('skipped');
  const last = steps[steps.length - 1];
  assert.equal(last.label, 'skipped');
  assert.equal(last.tone, 'warn');
  // queued/running marked done — the run never started
  assert.equal(steps[0].state, 'done');
});
