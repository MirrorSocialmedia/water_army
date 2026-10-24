/**
 * BR-B5 cycle report (MD §11.4) — builder + CSV + zero-secrets gate tests.
 *
 * The zero-secrets contract is the critical one: identity metadata that was
 * smuggled past the boundary (should not happen — createIdentity refuses it,
 * but reports are defence in depth), failure messages, and run payloads must
 * all come out clean. `assertNoSecrets` must catch a trip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCycleReport, renderCycleReportCsv, assertNoSecrets, maskCredentialShapedValues, REPORT_SCHEMA } from '@water-army/shared';

const T0 = Date.parse('2026-10-21T00:00:00Z');
const at = (min) => new Date(T0 + min * 60_000);

function makeCycle({ identityStatus = {}, failures = {}, skipped = {} } = {}) {
  // 3 identities across 2 batches (batch 1: 2, batch 2: 1)
  const batches = [
    { id: 'batch-1', batchNo: 1, name: 'Cycle #1', status: 'COMPLETED', batchSize: 2, maxActiveContainers: 50, failurePolicy: 'continue_and_report', startedAt: at(0), finishedAt: at(100) },
    { id: 'batch-2', batchNo: 2, name: 'Cycle #2', status: 'COMPLETED_WITH_ERRORS', batchSize: 1, maxActiveContainers: 50, failurePolicy: 'continue_and_report', startedAt: at(110), finishedAt: at(200) },
  ];
  const memberships = [
    { batchId: 'batch-1', identityId: 'id-1', position: 1, status: 'COMPLETED', skipReason: null },
    { batchId: 'batch-1', identityId: 'id-2', position: 2, status: 'FAILED_FINAL', skipReason: null },
    { batchId: 'batch-2', identityId: 'id-3', position: 1, status: 'SKIPPED', skipReason: 'identity disabled' },
  ];
  const identities = [
    { id: 'id-1', externalRef: 'qa-001', displayName: 'QA 1', identityType: 'qa_device', status: identityStatus['id-1'] ?? 'COMPLETED', dataPath: '/data/water_army/identities/id-1/data' },
    { id: 'id-2', externalRef: 'qa-002', displayName: 'QA 2', identityType: 'qa_device', status: identityStatus['id-2'] ?? 'FAILED_FINAL', dataPath: '/data/water_army/identities/id-2/data' },
    { id: 'id-3', externalRef: 'qa-003', displayName: 'QA 3', identityType: 'staging_user', status: identityStatus['id-3'] ?? 'SKIPPED', dataPath: '/data/water_army/identities/id-3/data' },
  ];
  const runs = [
    { id: 'run-1', batchId: 'batch-1', identityId: 'id-1', status: 'succeeded', attempt: 1, maxAttempts: 3, startedAt: at(1), finishedAt: at(5), durationMs: 240_000, errorCode: null, errorMessage: null, containerId: 'c0ffee00000011111111' },
    { id: 'run-2a', batchId: 'batch-1', identityId: 'id-2', status: 'succeeded', attempt: 1, maxAttempts: 3, startedAt: at(2), finishedAt: at(3), durationMs: 60_000, errorCode: null, errorMessage: null, containerId: 'deadbeef000000000001' },
    { id: 'run-2b', batchId: 'batch-1', identityId: 'id-2', status: 'failed', attempt: 2, maxAttempts: 3, startedAt: at(4), finishedAt: at(6), durationMs: 120_000, errorCode: failures['id-2']?.code ?? 'NETWORK_TARGET_DENIED', errorMessage: failures['id-2']?.message ?? 'network gate: target not on allowlist', containerId: 'deadbeef000000000002' },
    { id: 'run-3', batchId: 'batch-2', identityId: 'id-3', status: 'skipped', attempt: 1, maxAttempts: 3, startedAt: null, finishedAt: null, durationMs: null, errorCode: null, errorMessage: null, containerId: null },
  ];
  return { cycleId: 'cycle-abc', batches, memberships, identities, runs, now: at(210), skipped };
}

test('report shape: totals, per-batch stats, per-identity terminal rows', () => {
  const report = buildCycleReport(makeCycle());
  assert.equal(report.schema, REPORT_SCHEMA);
  assert.equal(report.cycleId, 'cycle-abc');
  assert.equal(report.timeRange.startedAt, at(0).toISOString());
  assert.equal(report.timeRange.finishedAt, at(200).toISOString());

  assert.equal(report.totals.identities, 3);
  assert.equal(report.totals.completed, 1);
  assert.equal(report.totals.failedFinal, 1);
  assert.equal(report.totals.skipped, 1);
  assert.equal(report.totals.nonTerminal, 0);
  assert.equal(report.totals.successRate, 0.33);
  assert.equal(report.totals.retries, 1); // id-2 needed attempt 2
  assert.equal(report.totals.totalRunAttempts, 4);

  const b1 = report.batches.find((b) => b.batchNo === 1);
  assert.equal(b1.stats.members, 2);
  assert.equal(b1.stats.completed, 1);
  assert.equal(b1.stats.failedFinal, 1);
  assert.equal(b1.stats.retries, 1);
  // id-1 [1..5] and id-2 [2..3] overlap → peak 2
  assert.equal(b1.stats.peakActiveContainers, 2);

  const m2 = b1.members.find((m) => m.identityId === 'id-2');
  assert.equal(m2.finalStatus, 'FAILED_FINAL');
  assert.equal(m2.attempts, 2);
  assert.equal(m2.failure.code, 'NETWORK_TARGET_DENIED');
  assert.equal(m2.failure.summary, 'network gate: target not on allowlist');
  assert.equal(m2.containerId, 'deadbeef0000'); // 12-char short id

  const m3 = report.batches.find((b) => b.batchNo === 2).members[0];
  assert.equal(m3.finalStatus, 'SKIPPED');
  assert.equal(m3.skipReason, 'identity disabled');
  assert.equal(m3.attempts, 1); // the skip run row itself
  assert.equal(m3.startedAt, null);
});

test('report: cycle filter — other cycles’ memberships/runs are excluded', () => {
  const cycle = makeCycle();
  cycle.memberships.push({ batchId: 'other-batch', identityId: 'id-9', position: 1, status: 'COMPLETED', skipReason: null });
  cycle.runs.push({ id: 'run-9', batchId: 'other-batch', identityId: 'id-9', status: 'succeeded', attempt: 1, startedAt: at(1), finishedAt: at(2) });
  cycle.identities.push({ id: 'id-9', externalRef: 'qa-999', displayName: 'Other', identityType: 'qa_device', status: 'COMPLETED', dataPath: '/x' });
  const report = buildCycleReport(cycle);
  assert.equal(report.totals.identities, 3);
  assert.ok(!JSON.stringify(report).includes('id-9'));
});

test('report: zero secrets — credential-shaped metadata is dropped, never leaked', () => {
  const cycle = makeCycle();
  // hostile metadata that somehow bypassed the boundary (defence in depth)
  cycle.identities.forEach((i) => {
    i.metadataJson = {
      password: 'hunter2-secret-value',
      accessToken: 'tok-abc-123456789',
      api_key: 'sk-live-0123456789abcdef',
      sessionCookie: 'sid=xyz123abc',
      notes: 'benign metadata should survive',
    };
  });
  const report = buildCycleReport(cycle);
  const json = JSON.stringify(report);
  assert.ok(!json.includes('hunter2-secret-value'));
  assert.ok(!json.includes('tok-abc-123456789'));
  assert.ok(!json.includes('sk-live-0123456789abcdef'));
  assert.ok(!json.includes('sid=xyz123abc'));
  assert.ok(!/password|accessToken|api_key|sessionCookie/i.test(json));
});

test('report: failure message containing a credential-shaped value is scrubbed by the hard gate (500 path)', () => {
  const cycle = makeCycle({
    // P5: `password=...` free text is now caught EARLIER (layer 1 —
    // scrubObject BARE_SECRET redacts the whole string), so this gate-layer
    // regression uses a value shape that survives scrub: a raw JWT.
    failures: { 'id-2': { code: 'PROVIDER_ERROR', message: 'upstream replied: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123456def' } },
  });
  // the value pattern trips assertNoSecrets → buildCycleReport throws
  assert.throws(() => buildCycleReport(cycle), /credential-shaped value/);
});

test('assertNoSecrets: key + value patterns caught, clean report passes', () => {
  assert.doesNotThrow(() => assertNoSecrets({ a: 1, b: [1, 2], c: { d: 'ok text' } }));
  assert.throws(() => assertNoSecrets({ dbPassword: 'x' }), /sensitive key/);
  assert.throws(() => assertNoSecrets({ 'api-key': 'x' }), /sensitive key/);
  assert.throws(() => assertNoSecrets({ note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123456def' }), /credential-shaped value/);
  assert.throws(() => assertNoSecrets({ note: 'token: abcdef123456' }), /credential-shaped value/);
  // over-masking is acceptable, under-masking is not — camelCase humps hit
  assert.throws(() => assertNoSecrets({ mySecretValue: 'x' }), /sensitive key/);
});

test('csv: RFC-4180 escaping + one row per membership + header', () => {
  const cycle = makeCycle();
  // inject a displayName with comma + quote to exercise escaping
  cycle.identities[0].displayName = 'QA, 1 "alpha"';
  const report = buildCycleReport(cycle);
  const csv = renderCycleReportCsv(report);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 4); // header + 3 members
  assert.ok(lines[0].startsWith('cycle_id,batch_no,batch_id,position,identity_id'));
  assert.ok(lines[1].includes('"QA, 1 ""alpha"""'));
  assert.ok(csv.endsWith('\n'));
  // no secret values in the CSV
  const cycle2 = makeCycle();
  cycle2.identities.forEach((i) => { i.metadataJson = { password: 'csv-leak-test-value' }; });
  const csv2 = renderCycleReportCsv(buildCycleReport(cycle2));
  assert.ok(!csv2.includes('csv-leak-test-value'));
});

test('csv: null/undefined fields render empty', () => {
  const report = buildCycleReport(makeCycle());
  const skippedLine = renderCycleReportCsv(report).trim().split('\n').find((l) => l.includes('id-3'));
  const cells = skippedLine.split(',');
  assert.equal(cells[12], ''); // container_id empty for skipped
});

test('report: rejects empty cycle + missing cycleId', () => {
  assert.throws(() => buildCycleReport({ cycleId: '', batches: [] }), TypeError);
  assert.throws(() => buildCycleReport({ cycleId: 'c', batches: [], memberships: [], identities: [], runs: [] }), /no batches/);
});

test('report: non-terminal cycle reports nonTerminal count (no fake success)', () => {
  const cycle = makeCycle({ identityStatus: { 'id-2': 'RUNNING' } });
  const report = buildCycleReport(cycle);
  assert.equal(report.totals.nonTerminal, 1);
  const m2 = report.batches.find((b) => b.batchNo === 1).members.find((m) => m.identityId === 'id-2');
  assert.equal(m2.finalStatus, 'RUNNING');
});

// ---------------------------------------------------------------------------
// maskCredentialShapedValues (MD §12 — value-level masking for free text)
// ---------------------------------------------------------------------------

test('mask: credential-shaped label=value assignments are erased, label kept', () => {
  assert.equal(maskCredentialShapedValues('docker login failed: password=hunter2-s3cret-value'), 'docker login failed: password=***');
  const bearer = maskCredentialShapedValues('header Authorization: Bearer abcdef1234567890');
  assert.ok(!bearer.includes('abcdef1234567890'), `bearer token must be gone: ${bearer}`);
  assert.ok(bearer.includes('***'));
  assert.equal(maskCredentialShapedValues('token :  abcdef1234567890'), 'token :  ***');
  assert.equal(maskCredentialShapedValues('api_key=short'), 'api_key=short', 'values < 6 chars are not credential-shaped');
});

test('mask: JWT + PEM shapes are redacted', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const masked = maskCredentialShapedValues(`session=${jwt}`);
  assert.ok(!masked.includes('eyJhbGciOiJIUzI1NiJ9'), 'jwt payload gone');
  assert.ok(masked.includes('***redacted-jwt***'));
  assert.equal(maskCredentialShapedValues('cert: -----BEGIN RSA PRIVATE KEY-----MIIEpAIB'), 'cert: ***redacted-pem***');
});

test('mask: redacted output never re-trips the hard gate (marker too short)', () => {
  const masked = maskCredentialShapedValues('docker login failed: password=hunter2-s3cret-value');
  assert.doesNotThrow(() => assertNoSecrets({ failure: { summary: masked } }), 'gate must accept the redacted marker');
  assert.doesNotThrow(() => assertNoSecrets(maskCredentialShapedValues('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')));
});

test('mask: non-string values pass through untouched', () => {
  assert.equal(maskCredentialShapedValues(42), 42);
  assert.equal(maskCredentialShapedValues(null), null);
  assert.deepEqual(maskCredentialShapedValues({ a: 1 }), { a: 1 });
});
