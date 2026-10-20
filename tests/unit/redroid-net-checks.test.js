/**
 * R3 — canary probe, control-plane netcheck, and recovery-policy tests.
 *
 *  - canary script: builder validation (host/port/nonce/timeout), marker,
 *    and the parser/classifier over every output shape (PASS / each FAIL
 *    reason / no-marker)
 *  - netcheck script: read-only contract (no mutation commands), parser,
 *    and the fail-closed classification (definite vs inconclusive),
 *    including the FAIL-OPEN detection (effective=direct)
 *  - backoff + computeRecoveryDecision: full decision surface, including
 *    the gVisor-stall special budget (R2 L6h: re-provision is useless →
 *    one auto attempt, then FAILED + manual intervention)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NET_STATES,
  NET_ERRORS,
  T2S_NETCHECK_MARKER,
  T2S_CANARY_MARKER,
  buildT2sNetcheckScript,
  parseNetcheckOutput,
  classifyNetcheck,
  buildT2sCanaryScript,
  parseCanaryOutput,
  classifyCanary,
  generateCanaryNonce,
  backoffMs,
  isStallSignature,
  computeRecoveryDecision,
  RECOVERY_DEFAULTS,
  buildNetPayload,
} from '../../apps/api/src/services/redroid-health.js';

const NONCE = 'a1b2c3d4e5f60718';

// ---------------------------------------------------------------------------
// netcheck (control plane)
// ---------------------------------------------------------------------------

test('r3 netcheck: builder is read-only (no mutation, bracket trick, one machine line)', () => {
  const s = buildT2sNetcheckScript();
  assert.ok(s.includes(T2S_NETCHECK_MARKER));
  // no state mutation of any kind
  assert.ok(!/pkill|pgrep|ip link (add|del|set)|ip route (add|del|flush)|ip rule (add|del)|chmod|rm /.test(s));
  // the ps grep must use the bracket trick (runner cmdline safety)
  assert.ok(s.includes('grep [t]un2socks'));
  assert.ok(!s.includes('grep tun2socks'));
});

test('r3 netcheck: parser handles the happy line and rejects garbage', () => {
  const good = parseNetcheckOutput('NETCHECK process=alive pid=4444 iface=up route=present rule=present effective=tunnel\n');
  assert.deepEqual(good, { ok: true, process: 'alive', pid: '4444', iface: 'up', route: 'present', rule: 'present', effective: 'tunnel' });
  const dead = parseNetcheckOutput('NETCHECK process=dead pid=none iface=missing route=missing rule=present effective=direct\n');
  assert.equal(dead.process, 'dead');
  assert.equal(dead.effective, 'direct');
  for (const bad of ['', 'NETCHECK process=weird pid=1 iface=up route=present rule=present effective=tunnel', 'NETCHECK process=alive pid=1', 'noise']) {
    const r = parseNetcheckOutput(bad);
    assert.equal(r.ok, false, `must not parse: ${JSON.stringify(bad)}`);
    assert.equal(r.code, NET_ERRORS.TUNNEL_CHECK_ERROR);
  }
});

test('r3 netcheck: classification — definite protection loss vs inconclusive vs intact', () => {
  const base = { ok: true, process: 'alive', pid: '1', iface: 'up', route: 'present', rule: 'present', effective: 'tunnel' };
  assert.equal(classifyNetcheck(base), null, 'intact control plane -> null');
  // every definite flavor
  assert.deepEqual(classifyNetcheck({ ...base, process: 'dead' }), { severity: 'definite', code: NET_ERRORS.TUNNEL_PROCESS_DEAD });
  assert.deepEqual(classifyNetcheck({ ...base, iface: 'missing' }), { severity: 'definite', code: NET_ERRORS.TUNNEL_IFACE_MISSING });
  assert.deepEqual(classifyNetcheck({ ...base, iface: 'down' }), { severity: 'definite', code: NET_ERRORS.TUNNEL_IFACE_DOWN });
  assert.deepEqual(classifyNetcheck({ ...base, route: 'missing' }), { severity: 'definite', code: NET_ERRORS.TUNNEL_ROUTE_UNCERTAIN });
  assert.deepEqual(classifyNetcheck({ ...base, rule: 'missing' }), { severity: 'definite', code: NET_ERRORS.TUNNEL_ROUTE_UNCERTAIN });
  // FAIL-OPEN: tun0/t2s gone, Android silently reverts to the eth0 default
  // route (R0 §10 / R2 L8c live-verified) — that is a security event, definite.
  assert.deepEqual(classifyNetcheck({ ...base, route: 'missing', effective: 'direct' }), { severity: 'definite', code: NET_ERRORS.TUNNEL_ROUTE_UNCERTAIN });
  // inconclusive: the check could not determine the protection state
  assert.equal(classifyNetcheck({ ...base, effective: 'unknown' }).severity, 'inconclusive');
  assert.equal(classifyNetcheck({ ok: false, code: NET_ERRORS.TUNNEL_CHECK_ERROR }).severity, 'inconclusive');
  assert.equal(classifyNetcheck(null).severity, 'inconclusive');
});

test('r3 netcheck: process=dead outranks route state (specific cause first)', () => {
  const r = classifyNetcheck({ ok: true, process: 'dead', pid: 'none', iface: 'missing', route: 'missing', rule: 'present', effective: 'direct' });
  assert.equal(r.code, NET_ERRORS.TUNNEL_PROCESS_DEAD);
});

// ---------------------------------------------------------------------------
// canary (data plane)
// ---------------------------------------------------------------------------

test('r3 canary: builder validates inputs strictly (no injection, no secrets)', () => {
  const s = buildT2sCanaryScript({ host: '93.184.216.34', port: 20271, timeoutMs: 10_000, nonce: NONCE });
  assert.ok(s.includes(T2S_CANARY_MARKER));
  assert.ok(s.includes(`HOST=93.184.216.34`));
  assert.ok(s.includes(`PORT=20271`));
  assert.ok(s.includes(`NONCE=${NONCE}`));
  assert.ok(s.includes('TO=10'));
  // bidirectional contract is in the script
  assert.ok(s.includes('X-Nonce: $NONCE'));
  assert.ok(s.includes('req_sha256=$REQSHA'));
  assert.ok(s.includes('HTTP/1.1 200'));
  // timeout wiring: sub-second configs clamp to >= 1s; below the minimum is rejected
  assert.ok(buildT2sCanaryScript({ host: 'h', port: 1, timeoutMs: 1000, nonce: NONCE }).includes('TO=1'));
  assert.ok(buildT2sCanaryScript({ host: 'h', port: 1, timeoutMs: 1500, nonce: NONCE }).includes('TO=2'));
  for (const bad of [
    { host: 'h rm -rf /', port: 1, timeoutMs: 1000, nonce: NONCE },
    { host: 'socks5://u:p@h:1', port: 1, timeoutMs: 1000, nonce: NONCE }, // credentials must never appear
    { host: 'h\nHOST=evil', port: 1, timeoutMs: 1000, nonce: NONCE },
    { host: 'h', port: 0, timeoutMs: 1000, nonce: NONCE },
    { host: 'h', port: 65536, timeoutMs: 1000, nonce: NONCE },
    { host: 'h', port: 1, timeoutMs: 10, nonce: NONCE },
    { host: 'h', port: 1, timeoutMs: 1000, nonce: 'short' },
    { host: 'h', port: 1, timeoutMs: 1000, nonce: 'A1B2C3D4E5F60718' },
  ]) {
    assert.throws(() => buildT2sCanaryScript(bad), `must reject: ${JSON.stringify(bad)}`);
  }
});

test('r3 canary: generateCanaryNonce is 16 hex and unique', () => {
  const a = generateCanaryNonce();
  const b = generateCanaryNonce();
  assert.match(a, /^[a-f0-9]{16}$/);
  assert.notEqual(a, b);
});

test('r3 canary: parser + classifier over every output shape', () => {
  const pass = parseCanaryOutput(`CANARY=PASS nonce=${NONCE} ms=432 reqsha=${'ab'.repeat(32)}\n`);
  assert.deepEqual(pass, { result: 'PASS', nonce: NONCE, ms: 432, reqsha: 'ab'.repeat(32) });
  assert.deepEqual(classifyCanary(pass), { pass: true, code: null });

  for (const [line, reason, code] of [
    [`CANARY=FAIL nonce=${NONCE} reason=timeout`, 'timeout', NET_ERRORS.CANARY_TIMEOUT],
    [`CANARY=FAIL nonce=${NONCE} reason=no-status`, 'no-status', NET_ERRORS.CANARY_FAIL],
    [`CANARY=FAIL nonce=${NONCE} reason=sha-mismatch`, 'sha-mismatch', NET_ERRORS.CANARY_FAIL],
    [`CANARY=FAIL nonce=${NONCE} reason=nonce-mismatch`, 'nonce-mismatch', NET_ERRORS.CANARY_FAIL],
    [`CANARY=FAIL nonce=${NONCE} reason=no-marker`, 'no-marker', NET_ERRORS.CANARY_FAIL],
    [`CANARY=FAIL nonce=${NONCE} reason=connect-failed rc=1`, 'connect-failed', NET_ERRORS.CANARY_FAIL],
    [`CANARY=FAIL nonce=${NONCE} reason=exec-error`, 'exec-error', NET_ERRORS.CANARY_FAIL],
  ]) {
    const p = parseCanaryOutput(line + '\n');
    assert.equal(p.result, 'FAIL');
    assert.equal(p.reason, reason);
    const c = classifyCanary(p);
    assert.equal(c.pass, false);
    assert.equal(c.code, code);
  }
  // garbage → ERROR (exec-seam failure class), classified as CANARY_FAIL
  const err = parseCanaryOutput('random noise\n');
  assert.equal(err.result, 'ERROR');
  assert.equal(classifyCanary(err).code, NET_ERRORS.CANARY_FAIL);
});

// ---------------------------------------------------------------------------
// backoff + recovery decision
// ---------------------------------------------------------------------------

const SMALL = { backoffBaseMs: 1000, backoffMaxMs: 8000, maxRetries: 3, stallMaxRetries: 1 };

test('r3 recovery: backoff is exponential and capped (overflow-safe)', () => {
  assert.equal(backoffMs(1, SMALL), 1000);
  assert.equal(backoffMs(2, SMALL), 2000);
  assert.equal(backoffMs(3, SMALL), 4000);
  assert.equal(backoffMs(4, SMALL), 8000);
  assert.equal(backoffMs(5, SMALL), 8000); // capped
  assert.equal(backoffMs(100, SMALL), 8000); // no 2**n overflow
  // defaults: 15s base, 10min cap
  assert.equal(backoffMs(1), RECOVERY_DEFAULTS.backoffBaseMs);
  assert.equal(backoffMs(10), RECOVERY_DEFAULTS.backoffMaxMs);
});

test('r3 recovery: decision — skip when not recoverable', () => {
  for (const state of NET_STATES) {
    if (state === 'DEGRADED' || state === 'BLOCKED') continue;
    assert.equal(computeRecoveryDecision({ netState: state, now: 1e12 }, SMALL).action, 'skip', `${state} must skip`);
  }
});

test('r3 recovery: decision — every attempt (incl. #1) waits for the persisted backoff anchor', () => {
  const now = 1_000_000;
  // anchor not armed (0) → recover immediately (manual-retry path resets it)
  assert.deepEqual(computeRecoveryDecision({ netState: 'BLOCKED', recoveries: 0, nextRecoveryAt: 0, now }, SMALL), { action: 'recover', attempt: 1 });
  // anchor armed in the future → wait (the state stays observable as BLOCKED/DEGRADED — no racing STARTING)
  const armedAt = now + 1000;
  const dWait = computeRecoveryDecision({ netState: 'DEGRADED', recoveries: 0, nextRecoveryAt: armedAt, now: now + 999 }, SMALL);
  assert.equal(dWait.action, 'wait');
  assert.equal(dWait.retryAt, armedAt);
  // anchor elapsed → the attempt the service armed for (recoveries+1)
  assert.deepEqual(computeRecoveryDecision({ netState: 'DEGRADED', recoveries: 0, nextRecoveryAt: armedAt, now: armedAt }, SMALL), { action: 'recover', attempt: 1 });
  assert.deepEqual(computeRecoveryDecision({ netState: 'BLOCKED', recoveries: 2, nextRecoveryAt: now, now }, SMALL), { action: 'recover', attempt: 3 });
  // anchor is crash-safe by construction: it is a plain persisted timestamp —
  // restarting the API with the same row yields the same wait/recover decision
  const restarted = computeRecoveryDecision({ netState: 'BLOCKED', recoveries: 1, nextRecoveryAt: now + 4000, now: now + 1 }, SMALL);
  assert.equal(restarted.action, 'wait');
  assert.equal(restarted.retryAt, now + 4000);
});

test('r3 recovery: decision — lock contention is a WAIT, never a second recovery', () => {
  const d = computeRecoveryDecision({ netState: 'BLOCKED', recoveries: 0, nextRecoveryAt: 0, lockHeldBy: 'other-owner', now: 1e12 }, SMALL);
  assert.deepEqual(d, { action: 'locked' });
});

test('r3 recovery: decision — max retries → FAILED (manual intervention)', () => {
  const d = computeRecoveryDecision({ netState: 'BLOCKED', recoveries: SMALL.maxRetries, nextRecoveryAt: 0, now: 1e12 }, SMALL);
  assert.equal(d.action, 'manual-fail');
  assert.equal(d.code, NET_ERRORS.RECOVERY_EXHAUSTED);
  // budget check outranks the anchor: an exhausted episode never spins on 'wait'
  const d2 = computeRecoveryDecision({ netState: 'BLOCKED', recoveries: SMALL.maxRetries, nextRecoveryAt: 2e12, now: 1e12 }, SMALL);
  assert.equal(d2.action, 'manual-fail');
});

test('r3 recovery: decision — gVisor stall signature gets the small budget (R2 L6h: re-provision useless)', () => {
  // canary dead + process alive = the stall. After ONE auto re-provision that
  // did not restore the data plane, stop and require a human.
  const stall = (recoveries) => computeRecoveryDecision(
    { netState: 'BLOCKED', recoveries, nextRecoveryAt: 0, lastErrorCode: NET_ERRORS.CANARY_TIMEOUT, now: 1e12 },
    SMALL,
  );
  assert.deepEqual(stall(0), { action: 'recover', attempt: 1 });
  const d2 = stall(1);
  assert.equal(d2.action, 'manual-fail');
  assert.equal(d2.code, NET_ERRORS.STALL_REPROVISION_USELESS);
  assert.equal(isStallSignature(NET_ERRORS.CANARY_FAIL), true);
  assert.equal(isStallSignature(NET_ERRORS.CANARY_TIMEOUT), true);
  assert.equal(isStallSignature(NET_ERRORS.TUNNEL_PROCESS_DEAD), false, 'process death is NOT the stall signature');
});

test('r3 recovery: decision — non-stall failures use the full budget', () => {
  const d = computeRecoveryDecision(
    { netState: 'BLOCKED', recoveries: 1, nextRecoveryAt: 0, lastErrorCode: NET_ERRORS.TUNNEL_PROCESS_DEAD, now: 1e12 },
    SMALL,
  );
  assert.deepEqual(d, { action: 'recover', attempt: 2 }, 'process-death failures keep the full retry budget');
});

// ---------------------------------------------------------------------------
// net payload (MD §6.2 shape) + stale-health rule (MD §5.5)
// ---------------------------------------------------------------------------

function row(partial) {
  return {
    netState: 'HEALTHY',
    netStateSince: new Date(1_000_000_000_000),
    netCheckedAt: new Date(1_000_000_060_000),
    netLastSuccessAt: new Date(1_000_000_060_000),
    netConsecutiveFailures: 0,
    netLastErrorCode: null,
    netLastErrorDetail: null,
    netRecoveries: 0,
    netManualIntervention: false,
    netLastCanary: 'CANARY=PASS nonce=a1b2c3d4e5f60718 ms=42',
    ...partial,
  };
}

test('r3 netpayload: fresh HEALTHY is ready; shape matches MD §6.2 semantics', () => {
  const p = buildNetPayload(row({}), { now: 1_000_000_061_000, staleTtlMs: 60_000, canaryConfigured: true });
  assert.equal(p.state, 'HEALTHY');
  assert.equal(p.networkReady, true);
  assert.equal(p.stale, false);
  assert.equal(p.consecutiveFailures, 0);
  assert.equal(p.lastCanary.result, 'PASS');
  assert.equal(p.lastCanary.latencyMs, 42);
  assert.equal(p.lastSuccessAt, new Date(1_000_000_060_000).toISOString());
  assert.equal(p.lastError, null);
  // zero-secret contract: no proxy material in the payload keys
  const keys = Object.keys(p).join(',');
  assert.ok(!/proxyUrl|url|token|password|credential/i.test(keys));
});

test('r3 netpayload: STALE HEALTHY is treated as unhealthy (MD §5.5 — 健康狀態過期時按不健康處理)', () => {
  const fresh = buildNetPayload(row({}), { now: 1_000_000_060_000 + 59_000, staleTtlMs: 60_000 });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.networkReady, true);
  const stale = buildNetPayload(row({}), { now: 1_000_000_060_000 + 61_000, staleTtlMs: 60_000 });
  assert.equal(stale.state, 'HEALTHY', 'the stored state is still reported as stored (honest)');
  assert.equal(stale.stale, true);
  assert.equal(stale.networkReady, false, 'stale HEALTHY must NOT gate network work as ready');
  // never checked at all
  const never = buildNetPayload(row({ netCheckedAt: null }), { now: 2e12 });
  assert.equal(never.stale, true);
  assert.equal(never.networkReady, false);
});

test('r3 netpayload: DEGRADED/BLOCKED/FAILED never report networkReady', () => {
  for (const s of ['DEGRADED', 'BLOCKED', 'FAILED']) {
    const p = buildNetPayload(row({ netState: s, netLastErrorCode: 'CANARY_FAIL', netLastErrorDetail: 'canary FAIL:timeout' }), { now: 1e12 });
    assert.equal(p.networkReady, false, s);
    assert.equal(p.lastError.code, 'CANARY_FAIL');
  }
});

test('r3 netpayload: corrupt/missing rows degrade to safe defaults', () => {
  const p = buildNetPayload(undefined, { now: 1e12 });
  assert.equal(p.state, 'STOPPED');
  assert.equal(p.networkReady, false);
  const q = buildNetPayload({ netState: 'SOMETHING_ELSE' }, { now: 1e12 });
  assert.equal(q.state, 'STOPPED');
});
