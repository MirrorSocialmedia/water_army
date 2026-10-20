/**
 * R4 (repair MD §6.3) — network state badge contract for the UI.
 *
 * The UI's honesty rules under test:
 *  - every state renders a TEXT label (the state name), not just a colour
 *  - stale HEALTHY → STALE, treated as unhealthy (never the old green badge)
 *  - VERIFYING/DEGRADED = recovering/degraded text, never green
 *  - dispatch mirrors the worker gate (networkReady) — console and
 *    dispatcher can never disagree
 *  - per-check values render only PASS/FAIL/UNKNOWN (fail-closed on junk)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { netStateBadge, netCheckBadge } from '../../apps/web/src/components/redroid-utils.js';

function net(over = {}) {
  return {
    state: 'HEALTHY',
    stale: false,
    networkReady: true,
    checkedAt: '2026-10-20T10:00:00.000Z',
    lastSuccessAt: '2026-10-20T10:00:00.000Z',
    consecutiveFailures: 0,
    recoveries: 0,
    manualIntervention: false,
    canaryConfigured: true,
    lastErrorCode: null,
    nextRecoveryAt: null,
    recoveryLock: null,
    lastError: null,
    checks: { binary: 'PASS', process: 'PASS', interface: 'PASS', routePolicy: 'PASS', tcpCanary: 'PASS' },
    ...over,
  };
}

test('netStateBadge: fresh HEALTHY → green + text + dispatch ALLOWED', () => {
  const b = netStateBadge(net());
  assert.equal(b.label, 'HEALTHY (network verified)');
  assert.equal(b.cls, 'pill-up');
  assert.equal(b.dispatch, 'ALLOWED');
  assert.equal(b.state, 'HEALTHY');
});

test('netStateBadge: stale HEALTHY → STALE + down + BLOCKED (MD §6.3 過期=STALE 或按不健康)', () => {
  const b = netStateBadge(net({ stale: true }));
  assert.match(b.label, /^STALE/);
  assert.equal(b.cls, 'pill-down', 'stale must never be green');
  assert.equal(b.dispatch, 'BLOCKED');
  assert.equal(b.state, 'HEALTHY', 'the stored state is still reported (transparency)');
});

test('netStateBadge: every state has its own text label (MD §6.3 文字, 唔單止顏色)', () => {
  const cases = {
    DEGRADED: ['DEGRADED', 'pill-disabled', 'BLOCKED'],
    BLOCKED: ['BLOCKED', 'pill-down', 'BLOCKED'],
    FAILED: ['FAILED', 'pill-down', 'BLOCKED'],
    VERIFYING: ['VERIFYING', 'pill-disabled', 'BLOCKED'],
    STARTING: ['STARTING', 'pill', 'BLOCKED'],
    STOPPED: ['STOPPED', 'pill', 'BLOCKED'],
  };
  for (const [state, [labelPart, cls, dispatch]] of Object.entries(cases)) {
    const b = netStateBadge(net({ state, networkReady: false }));
    assert.match(b.label, new RegExp(`^${labelPart}`), `${state}: label must start with the state name`);
    assert.equal(b.cls, cls, `${state}: class`);
    assert.equal(b.dispatch, dispatch, `${state}: dispatch`);
  }
});

test('netStateBadge: VERIFYING is the "recovering" text — never the old green badge', () => {
  const b = netStateBadge(net({ state: 'VERIFYING', networkReady: false }));
  assert.match(b.label, /recovering/i);
  assert.notEqual(b.cls, 'pill-up');
});

test('netStateBadge: networkReady=true but stale → dispatch BLOCKED (gate consistency)', () => {
  const b = netStateBadge(net({ stale: true, networkReady: true }));
  assert.equal(b.dispatch, 'BLOCKED', 'the display gate must be as fail-closed as the worker gate');
});

test('netStateBadge: no proxy (null) → explicit text, BLOCKED', () => {
  const b = netStateBadge(null);
  assert.equal(b.label, 'no egress proxy');
  assert.equal(b.dispatch, 'BLOCKED');
});

test('netStateBadge: unknown/garbage state → UNKNOWN text, BLOCKED (fail-closed)', () => {
  const b = netStateBadge(net({ state: 'WARP_DRIVE', networkReady: false }));
  assert.match(b.label, /^UNKNOWN/);
  assert.equal(b.dispatch, 'BLOCKED');
});

test('netCheckBadge: only PASS/FAIL/UNKNOWN render (fail-closed on junk)', () => {
  assert.deepEqual(netCheckBadge('PASS'), { label: 'PASS', cls: 'pill-up' });
  assert.deepEqual(netCheckBadge('FAIL'), { label: 'FAIL', cls: 'pill-down' });
  assert.deepEqual(netCheckBadge('UNKNOWN'), { label: 'UNKNOWN', cls: 'pill' });
  assert.deepEqual(netCheckBadge(null), { label: 'UNKNOWN', cls: 'pill' });
  assert.deepEqual(netCheckBadge(undefined), { label: 'UNKNOWN', cls: 'pill' });
  assert.deepEqual(netCheckBadge('PASS; DROP TABLE devices'), { label: 'UNKNOWN', cls: 'pill' }, 'garbage never renders as PASS');
  assert.deepEqual(netCheckBadge('pass'), { label: 'PASS', cls: 'pill-up' }, 'case-insensitive');
});
