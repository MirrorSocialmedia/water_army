/**
 * W3 (ADR-027) — identity egress binding: pure-logic unit tests.
 *
 * Covers the verification core (all REAL production code, no mocks):
 *   - IP validation (strict canonical dotted-quad, no leading zeros)
 *   - the egress state machine (legal/illegal edges, no blind VERIFIED)
 *   - the in-device probe script (generation + injection safety) and its
 *     parser/classifier/decision engine
 *   - the freshness gate (egressStale/egressReady → networkReady)
 *   - expectation resolution (NO_PROXY / UNBOUND / BOUND — presence flags
 *     only, never a decrypted URL)
 *   - credential masking
 *
 * Plus one REAL-`sh` execution of the generated probe script with a stubbed
 * `nc` (the T102 pattern: POSIX dash = the toybox-sh compatibility check),
 * exercising every script branch (OK + all six FAIL reasons) on the exact
 * bytes the device would produce.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EGRESS_STATES,
  EGRESS_TRANSITIONS,
  EGRESS_PAYLOAD_KEYS,
  EGRESS_ERRORS,
  T2S_EGRESS_MARKER,
  IllegalEgressTransition,
  canEnterEgressState,
  isEgressMatchEvidence,
  assertEgressTransition,
  validateEgressIp,
  buildT2sEgressScript,
  parseEgressOutput,
  classifyEgressProbe,
  generateEgressNonce,
  computeEgressDecision,
  egressStale,
  egressReady,
  buildEgressPayload,
  resolveEgressExpectation,
  maskProxyUrl,
} from '../../apps/api/src/services/redroid-health.js';

// ===========================================================================
// validateEgressIp — strict canonical dotted-quad
// ===========================================================================
test('validateEgressIp: canonical IPv4 accepted', () => {
  for (const ip of ['1.2.3.4', '203.0.113.10', '198.51.100.254', '0.0.0.0', '255.255.255.255']) {
    assert.equal(validateEgressIp(ip).ok, true, ip);
  }
});

test('validateEgressIp: malformed / non-canonical rejected', () => {
  const bad = [
    '256.1.1.1',            // octet > 255
    '1.2.3',                // 3 octets
    '1.2.3.4.5',            // 5 octets
    '01.2.3.4',             // leading zero (ambiguous octal)
    '1.2.3.04',             // leading zero
    '1.2.3.4 ',             // trailing space
    ' 1.2.3.4',             // leading space
    '1.2.3.4\n',            // newline
    '1.2.3.0x1',            // junk
    'abcdef',               // hex form
    '::1',                  // IPv6
    '10.8.0.1/32',          // CIDR
    '',                     // empty
    '0x1.2.3.4',            // hex prefix
  ];
  for (const ip of bad) {
    assert.equal(validateEgressIp(ip).ok, false, `should reject ${JSON.stringify(ip)}`);
  }
  assert.equal(validateEgressIp(undefined).ok, false);
  assert.equal(validateEgressIp(null).ok, false);
  assert.equal(validateEgressIp(1234).ok, false);
});

// ===========================================================================
// state machine — legal edges, illegal edges, no blind VERIFIED
// ===========================================================================
test('egress states: the six-state vocabulary is frozen', () => {
  assert.deepEqual([...EGRESS_STATES].sort(), ['DRIFTED', 'NO_PROXY', 'UNCHECKED', 'UNBOUND', 'UNREACHABLE', 'VERIFIED'].sort());
  assert.throws(() => { EGRESS_STATES.push('X'); }, 'vocabulary must be frozen');
});

test('egress transitions: legal edges accepted', () => {
  const legal = [
    ['UNCHECKED', 'VERIFIED'], ['UNCHECKED', 'DRIFTED'], ['UNCHECKED', 'UNREACHABLE'],
    ['UNCHECKED', 'NO_PROXY'], ['UNCHECKED', 'UNBOUND'],
    ['VERIFIED', 'DRIFTED'], ['VERIFIED', 'UNREACHABLE'],
    ['DRIFTED', 'VERIFIED'], ['DRIFTED', 'UNREACHABLE'],
    ['UNREACHABLE', 'VERIFIED'], ['UNREACHABLE', 'DRIFTED'],
    ['VERIFIED', 'UNCHECKED'], ['DRIFTED', 'UNCHECKED'], ['UNREACHABLE', 'UNCHECKED'],
    ['NO_PROXY', 'UNCHECKED'], ['UNBOUND', 'UNCHECKED'],
  ];
  const M = Date.now();
  const match = { observedIp: '1.2.3.4', expectedIp: '1.2.3.4', at: M };
  for (const [from, to] of legal) {
    const ev = to === 'VERIFIED' ? { match } : {};
    assert.doesNotThrow(() => assertEgressTransition(from, to, ev), `${from} -> ${to} must be legal`);
  }
});

test('egress transitions: config states only leave via UNCHECKED reset', () => {
  assert.equal(canEnterEgressState('NO_PROXY', 'VERIFIED'), false);
  assert.equal(canEnterEgressState('NO_PROXY', 'DRIFTED'), false);
  assert.equal(canEnterEgressState('UNBOUND', 'VERIFIED'), false);
  assert.equal(canEnterEgressState('NO_PROXY', 'NO_PROXY'), false); // self is not an edge
});

test('egress transitions: unknown states rejected', () => {
  assert.equal(canEnterEgressState('BROKEN', 'VERIFIED'), false);
  assert.equal(canEnterEgressState('UNCHECKED', 'BROKEN'), false);
  assert.throws(() => assertEgressTransition('BROKEN', 'VERIFIED', { match: { observedIp: '1.1.1.1', expectedIp: '1.1.1.1', at: Date.now() } }), IllegalEgressTransition);
});

test('egress transitions: self-transition is not an event', () => {
  assert.throws(() => assertEgressTransition('VERIFIED', 'VERIFIED', { match: { observedIp: '1.1.1.1', expectedIp: '1.1.1.1', at: Date.now() } }), IllegalEgressTransition);
});

test('egress transitions: VERIFIED requires fresh match evidence (no blind VERIFIED)', () => {
  const now = Date.now();
  assert.throws(() => assertEgressTransition('UNCHECKED', 'VERIFIED', {}), IllegalEgressTransition, 'no evidence');
  assert.throws(() => assertEgressTransition('UNCHECKED', 'VERIFIED', { match: null }), IllegalEgressTransition);
  assert.throws(() => assertEgressTransition('UNCHECKED', 'VERIFIED', { match: { observedIp: '1.1.1.1', expectedIp: '2.2.2.2', at: now } }), IllegalEgressTransition, 'observed != expected');
  assert.throws(() => assertEgressTransition('UNCHECKED', 'VERIFIED', { match: { observedIp: '1.1.1.1', expectedIp: '1.1.1.1' } }), IllegalEgressTransition, 'missing at');
  assert.throws(() => assertEgressTransition('UNCHECKED', 'VERIFIED', { match: { observedIp: '1.1.1.1 ', expectedIp: '1.1.1.1 ', at: now } }), IllegalEgressTransition, 'non-canonical');
  assert.doesNotThrow(() => assertEgressTransition('UNCHECKED', 'VERIFIED', { match: { observedIp: '1.1.1.1', expectedIp: '1.1.1.1', at: now } }));
});

test('isEgressMatchEvidence: strict shape', () => {
  const now = Date.now();
  assert.equal(isEgressMatchEvidence(null), false);
  assert.equal(isEgressMatchEvidence({ observedIp: '1.1.1.1', expectedIp: '1.1.1.1', at: now }), true);
  assert.equal(isEgressMatchEvidence({ observedIp: '1.1.1.1', expectedIp: '1.1.1.2', at: now }), false);
  assert.equal(isEgressMatchEvidence({ observedIp: '1.1.1.1', expectedIp: '1.1.1.1', at: 'x' }), false);
  assert.equal(isEgressMatchEvidence({ observedIp: '999.1.1.1', expectedIp: '999.1.1.1', at: now }), false, 'must be valid IPs');
});

// ===========================================================================
// the probe script — generation + injection safety
// ===========================================================================
test('egress script: carries marker, nonce, host, port, timeout', () => {
  const s = buildT2sEgressScript({ host: 'echo.internal', port: 8443, timeoutMs: 5000, nonce: 'abcdef0123456789' });
  assert.ok(s.includes(T2S_EGRESS_MARKER), 'marker line');
  assert.ok(s.includes('HOST=echo.internal'));
  assert.ok(s.includes('PORT=8443'));
  assert.ok(s.includes('NONCE=abcdef0123456789'));
  assert.ok(s.includes('TO=5'));
  assert.ok(s.includes('GET /ip?nonce=$NONCE'));
});

test('egress script: rejects host/nonce/timeout that could inject', () => {
  assert.throws(() => buildT2sEgressScript({ host: 'a b', port: 1, timeoutMs: 1000, nonce: 'aaaaaaaa' }), /host/);
  assert.throws(() => buildT2sEgressScript({ host: 'a;rm -rf x', port: 1, timeoutMs: 1000, nonce: 'aaaaaaaa' }), /host/);
  assert.throws(() => buildT2sEgressScript({ host: 'a$b', port: 1, timeoutMs: 1000, nonce: 'aaaaaaaa' }), /host/);
  assert.throws(() => buildT2sEgressScript({ host: 'a`id`', port: 1, timeoutMs: 1000, nonce: 'aaaaaaaa' }), /host/);
  assert.throws(() => buildT2sEgressScript({ host: 'echo.internal', port: 0, timeoutMs: 1000, nonce: 'aaaaaaaa' }), /port/);
  assert.throws(() => buildT2sEgressScript({ host: 'echo.internal', port: 70000, timeoutMs: 1000, nonce: 'aaaaaaaa' }), /port/);
  assert.throws(() => buildT2sEgressScript({ host: 'echo.internal', port: 1, timeoutMs: 500, nonce: 'aaaaaaaa' }), /timeout/);
  assert.throws(() => buildT2sEgressScript({ host: 'echo.internal', port: 1, timeoutMs: 1000, nonce: 'ABC' }), /nonce/);
  assert.throws(() => buildT2sEgressScript({ host: 'echo.internal', port: 1, timeoutMs: 1000, nonce: 'aaaaaaaaa' + 'b'.repeat(64) }), /nonce/);
});

test('generateEgressNonce: 8..64 lowercase hex, unique-ish', () => {
  const a = generateEgressNonce();
  const b = generateEgressNonce();
  assert.match(a, /^[a-f0-9]{8,64}$/);
  assert.notEqual(a, b, 'two calls should differ (128-bit space)');
});

// ===========================================================================
// parse + classify
// ===========================================================================
test('parseEgressOutput: OK / FAIL / ERROR', () => {
  assert.deepEqual(parseEgressOutput('EGRESS=OK nonce=abcdef12 ip=203.0.113.10\n'), { result: 'OK', nonce: 'abcdef12', ip: '203.0.113.10' });
  assert.deepEqual(parseEgressOutput('EGRESS=FAIL nonce=abcdef12 reason=timeout\n'), { result: 'FAIL', nonce: 'abcdef12', reason: 'timeout' });
  assert.deepEqual(parseEgressOutput('garbage'), { result: 'ERROR', reason: 'no-marker' });
  assert.deepEqual(parseEgressOutput(''), { result: 'ERROR', reason: 'no-marker' });
  assert.deepEqual(parseEgressOutput(null), { result: 'ERROR', reason: 'no-marker' });
});

test('classifyEgressProbe: MATCH / DRIFT / PROBE_FAIL', () => {
  assert.deepEqual(classifyEgressProbe({ result: 'OK', nonce: 'n', ip: '1.2.3.4' }, '1.2.3.4'), { verdict: 'MATCH', observedIp: '1.2.3.4', expectedIp: null, code: null });
  const drift = classifyEgressProbe({ result: 'OK', nonce: 'n', ip: '9.9.9.9' }, '1.2.3.4');
  assert.equal(drift.verdict, 'DRIFT');
  assert.equal(drift.observedIp, '9.9.9.9');
  assert.equal(drift.expectedIp, '1.2.3.4');
  assert.equal(drift.code, EGRESS_ERRORS.IP_DRIFT);
  const t = classifyEgressProbe({ result: 'FAIL', nonce: 'n', reason: 'timeout' }, '1.2.3.4');
  assert.equal(t.verdict, 'PROBE_FAIL');
  assert.equal(t.code, EGRESS_ERRORS.PROBE_TIMEOUT);
  const cf = classifyEgressProbe({ result: 'FAIL', nonce: 'n', reason: 'connect-failed' }, '1.2.3.4');
  assert.equal(cf.code, EGRESS_ERRORS.PROBE_FAILED);
  const nm = classifyEgressProbe({ result: 'ERROR', reason: 'no-marker' }, '1.2.3.4');
  assert.equal(nm.code, EGRESS_ERRORS.PROBE_FAILED);
  // an OK line with an INVALID ip (the script is best-effort; the service is
  // strict — 999.1.1.1 never becomes evidence) = PROBE_FAIL, not MATCH
  const badIp = classifyEgressProbe({ result: 'OK', nonce: 'n', ip: '999.1.1.1' }, '999.1.1.1');
  assert.equal(badIp.verdict, 'PROBE_FAIL');
});

// ===========================================================================
// the decision engine — targets, counters, event timing
// ===========================================================================
test('computeEgressDecision: MATCH → VERIFIED, counter reset', () => {
  const d = computeEgressDecision({ state: 'DRIFTED', probe: { verdict: 'MATCH', observedIp: '1.2.3.4' }, consecutiveFailures: 5 });
  assert.equal(d.target, 'VERIFIED');
  assert.equal(d.consecutiveFailures, 0);
  assert.equal(d.event, null);
});

test('computeEgressDecision: DRIFT → DRIFTED; event only on transition INTO drifted', () => {
  const drift = { verdict: 'DRIFT', observedIp: '9.9.9.9', expectedIp: '1.2.3.4', code: EGRESS_ERRORS.IP_DRIFT };
  const into = computeEgressDecision({ state: 'VERIFIED', probe: drift, consecutiveFailures: 0 });
  assert.equal(into.target, 'DRIFTED');
  assert.ok(into.event && into.event.kind === 'drift' && into.event.severity === 'critical', 'transition-in event');
  const already = computeEgressDecision({ state: 'DRIFTED', probe: drift, consecutiveFailures: 0 });
  assert.equal(already.target, 'DRIFTED');
  assert.equal(already.event, null, 'steady drift: no repeated event (dedupe)');
});

test('computeEgressDecision: PROBE_FAIL → UNREACHABLE; event exactly at the threshold crossing', () => {
  const pf = { verdict: 'PROBE_FAIL', observedIp: null, expectedIp: '1.2.3.4', code: EGRESS_ERRORS.PROBE_TIMEOUT };
  const f1 = computeEgressDecision({ state: 'VERIFIED', probe: pf, consecutiveFailures: 0, failThreshold: 2 });
  assert.equal(f1.target, 'UNREACHABLE');
  assert.equal(f1.consecutiveFailures, 1);
  assert.equal(f1.event, null, 'cf=1 < 2: no event yet (noise control)');
  const f2 = computeEgressDecision({ state: 'UNREACHABLE', probe: pf, consecutiveFailures: 1, failThreshold: 2 });
  assert.equal(f2.consecutiveFailures, 2);
  assert.ok(f2.event && f2.event.kind === 'unreachable' && f2.event.severity === 'high', 'threshold crossing: event');
  const f3 = computeEgressDecision({ state: 'UNREACHABLE', probe: pf, consecutiveFailures: 2, failThreshold: 2 });
  assert.equal(f3.consecutiveFailures, 3);
  assert.equal(f3.event, null, 'past threshold: no repeated event');
  // threshold 1 = escalate on the first failure
  const t1 = computeEgressDecision({ state: 'VERIFIED', probe: pf, consecutiveFailures: 0, failThreshold: 1 });
  assert.ok(t1.event, 'threshold 1 fires on the first failure');
});

// ===========================================================================
// freshness — egressStale / egressReady / payload contract
// ===========================================================================
test('egressStale: only VERIFIED can be stale; no match anchor = stale', () => {
  const now = 1_000_000;
  assert.equal(egressStale('VERIFIED', now - 1000, null, now, 90_000), false, 'fresh match');
  assert.equal(egressStale('VERIFIED', now - 100_000, null, now, 90_000), true, 'match older than TTL');
  assert.equal(egressStale('VERIFIED', null, now - 1000, now, 90_000), false, 'checkedAt anchor (no match yet)');
  assert.equal(egressStale('VERIFIED', null, now - 100_000, now, 90_000), true, 'checkedAt anchor stale');
  assert.equal(egressStale('VERIFIED', null, null, now, 90_000), true, 'no anchor at all = stale (never verified)');
  assert.equal(egressStale('DRIFTED', now - 1000, null, now, 90_000), false, 'non-VERIFIED never "stale" (it is bad, not stale)');
});

test('egressReady: gate off = always true; gate on = fresh VERIFIED only', () => {
  const now = 1_000_000;
  const row = (egressState, lastMatchAt) => ({ egressState, egressLastMatchAt: lastMatchAt ? new Date(lastMatchAt) : null, egressCheckedAt: null });
  assert.equal(egressReady(row('DRIFTED', null), { gateActive: false }), true, 'gate off: neutral');
  assert.equal(egressReady(row('VERIFIED', now - 1000), { gateActive: true, now, staleTtlMs: 90_000 }), true);
  assert.equal(egressReady(row('VERIFIED', now - 100_000), { gateActive: true, now, staleTtlMs: 90_000 }), false, 'stale VERIFIED = not ready');
  assert.equal(egressReady(row('UNCHECKED', null), { gateActive: true, now, staleTtlMs: 90_000 }), false);
  assert.equal(egressReady(row('DRIFTED', null), { gateActive: true, now, staleTtlMs: 90_000 }), false);
  assert.equal(egressReady(row('UNREACHABLE', null), { gateActive: true, now, staleTtlMs: 90_000 }), false);
  assert.equal(egressReady(row('NO_PROXY', null), { gateActive: true, now, staleTtlMs: 90_000 }), false);
  assert.equal(egressReady(row('UNBOUND', null), { gateActive: true, now, staleTtlMs: 90_000 }), false);
});

test('buildEgressPayload: pinned key contract + zero credential surface', () => {
  const row = {
    egressState: 'DRIFTED',
    egressCheckedAt: new Date(1_000_000),
    egressLastMatchAt: null,
    egressConsecutiveFailures: 3,
    egressLastErrorCode: EGRESS_ERRORS.IP_DRIFT,
    egressLastObservedIp: '9.9.9.9',
  };
  const p = buildEgressPayload(row, { now: 1_000_000, staleTtlMs: 90_000 });
  assert.deepEqual(Object.keys(p).sort(), [...EGRESS_PAYLOAD_KEYS].sort(), 'key pin');
  assert.equal(p.state, 'DRIFTED');
  assert.equal(p.ready, false);
  assert.equal(p.stale, false, 'stale applies to VERIFIED only');
  assert.equal(p.consecutiveFailures, 3);
  assert.equal(p.lastErrorCode, EGRESS_ERRORS.IP_DRIFT);
  assert.equal(p.lastObservedIp, '9.9.9.9');
  assert.equal(p.checkedAt, new Date(1_000_000).toISOString());
  const s = JSON.stringify(p);
  assert.ok(!/socks5|proxy|user|pass|@/.test(s), 'no credential-shaped surface');
});

test('buildEgressPayload: null row → inert UNCHECKED view', () => {
  const p = buildEgressPayload(null, { now: 1_000_000 });
  assert.equal(p.state, 'UNCHECKED');
  assert.equal(p.ready, false);
  assert.equal(p.consecutiveFailures, 0);
});

// ===========================================================================
// expectation resolution — presence flags only (never a decrypted URL)
// ===========================================================================
test('resolveEgressExpectation: NO_PROXY beats everything', () => {
  assert.deepEqual(resolveEgressExpectation({ hasDeviceProxy: false, hasTemplateProxy: false, hasIdentityId: true, binding: { expectedEgressIp: '1.2.3.4' } }), { status: 'NO_PROXY' });
});

test('resolveEgressExpectation: UNBOUND variants', () => {
  assert.deepEqual(resolveEgressExpectation({ hasDeviceProxy: true, hasTemplateProxy: false, hasIdentityId: false, binding: null }), { status: 'UNBOUND', reason: 'device-not-bound-to-identity' });
  assert.deepEqual(resolveEgressExpectation({ hasDeviceProxy: false, hasTemplateProxy: true, hasIdentityId: true, binding: null }), { status: 'UNBOUND', reason: 'identity-egress-binding-missing' });
  assert.deepEqual(resolveEgressExpectation({ hasDeviceProxy: true, hasTemplateProxy: false, hasIdentityId: true, binding: { expectedEgressIp: 'not-an-ip' } }), { status: 'UNBOUND', reason: 'identity-egress-binding-missing' });
});

test('resolveEgressExpectation: BOUND = proxy + identity + valid binding', () => {
  assert.deepEqual(resolveEgressExpectation({ hasDeviceProxy: true, hasTemplateProxy: false, hasIdentityId: true, binding: { expectedEgressIp: '1.2.3.4' } }), { status: 'BOUND', expectedIp: '1.2.3.4' });
  assert.deepEqual(resolveEgressExpectation({ hasDeviceProxy: false, hasTemplateProxy: true, hasIdentityId: true, binding: { expectedEgressIp: '2.3.4.5' } }), { status: 'BOUND', expectedIp: '2.3.4.5' });
});

// ===========================================================================
// credential masking
// ===========================================================================
test('maskProxyUrl: credentials redacted, host kept', () => {
  assert.equal(maskProxyUrl('socks5://user:secret@proxy.example:7801'), 'socks5://***:***@proxy.example:7801');
  assert.equal(maskProxyUrl('socks5://proxy.example:7801'), 'socks5://proxy.example:7801');
  assert.equal(maskProxyUrl('socks5://user:secret@proxy.example:7801/path'), 'socks5://***:***@proxy.example:7801/path');
  assert.equal(maskProxyUrl(''), '');
});

// ===========================================================================
// REAL `sh` execution of the generated probe (the T102 pattern)
// ===========================================================================
/**
 * Run the REAL buildT2sEgressScript() under POSIX sh (dash here = the
 * toybox-sh compatibility check — no bashism survives) with `nc` replaced by
 * a stub that plays the admin IP-echo endpoint per a behavior file:
 *   ok | timeout | refuse | no-status | no-marker | bad-ip | nonce-mismatch
 * The stub parses the nonce out of the REAL request the script writes to the
 * FIFO and echoes it back — so the nonce round-trip is genuinely exercised.
 */
function runEgressScript({ script, behavior = 'ok', ip = '203.0.113.10' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-w3-egress-'));
  const bin = path.join(dir, 'bin');
  const fx = path.join(dir, 'fx');
  fs.mkdirSync(bin);
  fs.mkdirSync(fx);
  fs.writeFileSync(path.join(fx, 'behavior'), behavior);
  fs.writeFileSync(path.join(fx, 'ip'), ip);

  const fakeNc = [
    '#!/bin/sh',
    '# stub nc: -w <to> <host> <port>; reads the request from stdin',
    'REQ=$(cat 2>/dev/null || true)',
    `BEH=$(cat "${path.join(fx, 'behavior')}")`,
    `IP=$(cat "${path.join(fx, 'ip')}")`,
    'case "$BEH" in',
    '  timeout) sleep 30 ;;',
    '  refuse) exit 1 ;;',
    '  no-status) printf "hello\\n"; exit 0 ;;',
    '  no-marker) printf "HTTP/1.1 200 OK\\r\\n\\r\\nprobe=OK\\n"; exit 0 ;;',
    '  bad-ip) printf "HTTP/1.1 200 OK\\r\\n\\r\\nprobe=OK client_ip=123\\n"; exit 0 ;;',
    '  nonce-mismatch) printf "HTTP/1.1 200 OK\\r\\n\\r\\nprobe=OK nonce=deadbeef99 client_ip=%s\\n" "$IP"; exit 0 ;;',
    '  ok|*)',
    '    NONCE=$(printf "%s" "$REQ" | grep -o "nonce=[a-f0-9]*" | head -n1 | cut -d= -f2)',
    '    printf "HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\nprobe=OK nonce=%s client_ip=%s\\n" "$NONCE" "$IP"',
    '    exit 0 ;;',
    'esac',
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'nc'), fakeNc);
  fs.chmodSync(path.join(bin, 'nc'), 0o755);

  const scriptPath = path.join(dir, 'egress.sh');
  fs.writeFileSync(scriptPath, script);
  try {
    const stdout = execFileSync('sh', [scriptPath], {
      env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: dir },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return { stdout: String(err.stdout ?? ''), exitCode: err.status ?? 1 };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('egress script under real sh: OK path (nonce round-trip + ip echo)', () => {
  const nonce = generateEgressNonce();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-w3-egress-real-'));
  const { stdout, exitCode } = runEgressScript({ script: buildT2sEgressScript({ host: 'echo.internal', port: 8443, timeoutMs: 4000, nonce, tmpDir: dir }), behavior: 'ok', ip: '203.0.113.10' });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(exitCode, 0, `stdout=${stdout}`);
  const p = parseEgressOutput(stdout);
  assert.deepEqual(p, { result: 'OK', nonce, ip: '203.0.113.10' }, 'the nonce the SERVICE generated round-tripped through the device request');
  const c = classifyEgressProbe(p, '203.0.113.10');
  assert.equal(c.verdict, 'MATCH');
});

test('egress script under real sh: every FAIL branch', () => {
  const nonce = generateEgressNonce();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-w3-egress-fail-'));
  const mk = () => buildT2sEgressScript({ host: 'echo.internal', port: 8443, timeoutMs: 1000, nonce, tmpDir: dir });
  const cases = [
    ['timeout', 'timeout', 1],
    ['refuse', 'connect-failed', 1],
    ['no-status', 'no-status', 1],
    ['no-marker', 'no-marker', 1],
    ['bad-ip', 'bad-ip', 1],
    ['nonce-mismatch', 'nonce-mismatch', 1],
  ];
  for (const [beh, wantReason, wantExit] of cases) {
    const { stdout, exitCode } = runEgressScript({ script: mk(), behavior: beh, ip: '203.0.113.10' });
    assert.equal(exitCode, wantExit, `${beh}: exitCode\n${stdout}`);
    const p = parseEgressOutput(stdout);
    assert.equal(p.result, 'FAIL', `${beh}: ${stdout}`);
    assert.equal(p.reason, wantReason, `${beh}: ${stdout}`);
    assert.equal(p.nonce, nonce, `${beh}: nonce must be present`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
test('egress script: tmpDir injection is validated (absolute, no metacharacters)', () => {
  assert.doesNotThrow(() => buildT2sEgressScript({ host: 'h', port: 1, timeoutMs: 1000, nonce: 'aaaaaaaa', tmpDir: '/tmp/w3' }));
  assert.throws(() => buildT2sEgressScript({ host: 'h', port: 1, timeoutMs: 1000, nonce: 'aaaaaaaa', tmpDir: 'tmp/w3' }), /tmpDir/);
  assert.throws(() => buildT2sEgressScript({ host: 'h', port: 1, timeoutMs: 1000, nonce: 'aaaaaaaa', tmpDir: '/tmp/a b' }), /tmpDir/);
  assert.throws(() => buildT2sEgressScript({ host: 'h', port: 1, timeoutMs: 1000, nonce: 'aaaaaaaa', tmpDir: '/tmp/$(x)' }), /tmpDir/);
});

test('egress script: production default tmpDir is the Android device path', () => {
  const s2 = buildT2sEgressScript({ host: 'h', port: 1, timeoutMs: 1000, nonce: 'aaaaaaaa' });
  assert.ok(s2.includes('TMPD=/data/local/tmp'), 'default must be the redroid device path');
});
