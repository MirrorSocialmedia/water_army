/**
 * R3 — network health state machine: exhaustive transition-table tests.
 *
 * MD Phase 3 §5.2: every state must have precise entry conditions, legal
 * transitions must be ENFORCED in code (illegal = rejected), and NO code
 * path may set HEALTHY without a fresh bidirectional-TCP-canary PASS.
 *
 * These tests enumerate the FULL 7×7 matrix — both the legal edges and
 * every illegal pair — so a future table edit cannot silently widen the
 * surface.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NET_STATES,
  NET_TRANSITIONS,
  NET_TO_LEGACY_PROXY,
  assertNetTransition,
  canEnterNetState,
  isCanaryPassEvidence,
  IllegalNetTransition,
} from '../../apps/api/src/services/redroid-health.js';
import { PROXY_STATES } from '../../apps/api/src/services/redroid-service.js';

const CANARY_PASS = { canary: { result: 'PASS', nonce: 'a1b2c3d4e5f60718', at: 1_760_000_000_000 } };

test('r3 statemachine: the state set matches the MD exactly (7 states)', () => {
  assert.deepEqual([...NET_STATES].sort(), [
    'BLOCKED', 'DEGRADED', 'FAILED', 'HEALTHY', 'STARTING', 'STOPPED', 'VERIFYING',
  ]);
});

test('r3 statemachine: HEALTHY is reachable ONLY from VERIFYING (no blind HEALTHY)', () => {
  for (const from of NET_STATES) {
    const legal = canEnterNetState(from, 'HEALTHY');
    if (from === 'VERIFYING') assert.equal(legal, true, 'VERIFYING -> HEALTHY must be legal');
    else assert.equal(legal, false, `${from} -> HEALTHY must be illegal (HEALTHY only via VERIFYING + canary evidence)`);
  }
});

test('r3 statemachine: full legal matrix — every edge in the table is accepted, every other pair is rejected', () => {
  for (const from of NET_STATES) {
    for (const to of NET_STATES) {
      const expected = NET_TRANSITIONS[from].includes(to);
      const can = canEnterNetState(from, to);
      assert.equal(can, expected, `canEnterNetState(${from} -> ${to}) should be ${expected}`);
      if (from === to) {
        // self-transitions are not events
        assert.throws(() => assertNetTransition(from, to, CANARY_PASS), IllegalNetTransition);
        continue;
      }
      if (expected) {
        const ev = to === 'HEALTHY' ? CANARY_PASS : {};
        assert.doesNotThrow(() => assertNetTransition(from, to, ev), `${from} -> ${to} must be accepted`);
      } else {
        assert.throws(() => assertNetTransition(from, to, to === 'HEALTHY' ? CANARY_PASS : {}), IllegalNetTransition);
      }
    }
  }
});

test('r3 statemachine: unknown states are rejected on both sides', () => {
  assert.equal(canEnterNetState('RUNNING', 'HEALTHY'), false);
  assert.equal(canEnterNetState('HEALTHY', 'running'), false);
  assert.throws(() => assertNetTransition('NOPE', 'HEALTHY', CANARY_PASS), IllegalNetTransition);
  assert.throws(() => assertNetTransition('VERIFYING', 'healthy', CANARY_PASS), IllegalNetTransition);
});

test('r3 statemachine: VERIFYING -> HEALTHY requires fresh canary-pass EVIDENCE', () => {
  assert.doesNotThrow(() => assertNetTransition('VERIFYING', 'HEALTHY', CANARY_PASS));
  const badEvidence = [
    {},                                        // no evidence at all (the "blind set" attempt)
    { canary: null },
    { canary: { result: 'FAIL', nonce: 'a1b2c3d4e5f60718', at: 1 } },
    { canary: { result: 'PASS', nonce: 'SHORT', at: 1 } },          // nonce too short
    { canary: { result: 'PASS', nonce: 'A1B2C3D4E5F60718', at: 1 } }, // uppercase not allowed
    { canary: { result: 'PASS', nonce: 'a1b2c3d4e5f60718' } },       // missing timestamp
    { canary: { result: 'PASS', nonce: 'a1b2c3d4e5f60718', at: NaN } }, // stale/unparseable timestamp
    { canary: { result: 'PASS', nonce: 'a1b2c3d4e5f6071g', at: 1 } }, // non-hex nonce
  ];
  for (const ev of badEvidence) {
    assert.throws(() => assertNetTransition('VERIFYING', 'HEALTHY', ev), IllegalNetTransition, `evidence ${JSON.stringify(ev)} must be rejected`);
  }
});

test('r3 statemachine: isCanaryPassEvidence is a strict contract', () => {
  assert.equal(isCanaryPassEvidence(CANARY_PASS.canary), true);
  assert.equal(isCanaryPassEvidence(undefined), false);
  assert.equal(isCanaryPassEvidence({}), false);
  assert.equal(isCanaryPassEvidence({ result: 'PASS' }), false);
});

test('r3 statemachine: STOPPED is the universal sink (every state may stop)', () => {
  for (const from of NET_STATES) {
    assert.equal(canEnterNetState(from, 'STOPPED'), true, `${from} -> STOPPED must be legal`);
  }
});

test('r3 statemachine: FAILED is a manual-intervention sink (only STARTING or STOPPED leaves it)', () => {
  for (const to of NET_STATES) {
    const legal = canEnterNetState('FAILED', to);
    assert.equal(legal, to === 'STARTING' || to === 'STOPPED', `FAILED -> ${to} should be legal=${to === 'STARTING' || to === 'STOPPED'}`);
  }
  // and every state that can fail may enter FAILED
  for (const from of ['STARTING', 'VERIFYING', 'HEALTHY', 'DEGRADED', 'BLOCKED', 'STOPPED']) {
    assert.equal(canEnterNetState(from, 'FAILED'), true, `${from} -> FAILED must be legal`);
  }
});

test('r3 statemachine: the MD §5.2 example journeys are all legal', () => {
  const journeys = [
    ['STOPPED', 'STARTING', 'VERIFYING', 'HEALTHY'],
    ['HEALTHY', 'DEGRADED', 'BLOCKED', 'STARTING', 'VERIFYING', 'HEALTHY'],
    ['BLOCKED', 'FAILED'],
  ];
  for (const j of journeys) {
    for (let i = 1; i < j.length; i += 1) {
      assert.equal(canEnterNetState(j[i - 1], j[i]), true, `journey ${j.join(' -> ')}: ${j[i - 1]} -> ${j[i]}`);
    }
  }
});

test('r3 statemachine: legacy proxyState projection is conservative (never "running" when unhealthy)', () => {
  for (const [net, legacy] of Object.entries(NET_TO_LEGACY_PROXY)) {
    assert.ok(NET_STATES.includes(net));
    assert.ok(PROXY_STATES.includes(legacy), `legacy value '${legacy}' must exist in the pre-R4 vocabulary`);
  }
  assert.equal(NET_TO_LEGACY_PROXY.HEALTHY, 'running');
  assert.equal(NET_TO_LEGACY_PROXY.STOPPED, 'stopped');
  for (const net of ['DEGRADED', 'BLOCKED', 'FAILED']) {
    assert.notEqual(NET_TO_LEGACY_PROXY[net], 'running', `${net} must never project as legacy 'running' (fail-closed)`);
  }
});
