/**
 * BR-B5 S4 — unit tests for the Batch Rotation UI pure logic (batch-ui.js).
 * The pages are thin renderers; all decisions (RBAC, pill mapping, plan
 * summary, host health, formatting) live here and are covered hermetically.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  can,
  summarizePlan,
  taskFlags,
  hostHealth,
  fmtBytes,
  fmtDuration,
  fmtAge,
  fmtTime,
  shortId,
  cycleExportable,
  pillClass,
  BATCH_STATUS_PILL,
  RUN_STATUS_PILL,
  IDENTITY_PILL,
  CYCLE_STATUS_PILL,
  alertClass,
  REPORT_FORMATS,
} from '../../apps/web/src/lib/batch-ui.js';

// ------------------------------------------------------------------- RBAC ---
test('RBAC capability matrix (MD §12)', () => {
  // viewer: read only
  assert.equal(can('viewer', 'view'), true);
  for (const a of ['pause', 'resume', 'cancel', 'start', 'retry', 'create', 'export']) assert.equal(can('viewer', a), false, `viewer ${a}`);
  // operator: control + export, no policy
  for (const a of ['view', 'pause', 'resume', 'cancel', 'start', 'retry', 'create', 'export']) assert.equal(can('operator', a), true, `operator ${a}`);
  // admin: everything on these pages
  for (const a of ['view', 'pause', 'resume', 'cancel', 'start', 'retry', 'create', 'export']) assert.equal(can('admin', a), true, `admin ${a}`);
  // unknown role / action → false
  assert.equal(can('nobody', 'view'), false);
  assert.equal(can('admin', 'purge'), false);
});

// ---------------------------------------------------------------- planner ---
function idents(list) {
  return list.map(([id, status]) => ({ id, status }));
}

test('summarizePlan: 200 identities / batch 50 → 4 full batches', () => {
  const ids = idents(Array.from({ length: 200 }, (_, i) => [`id${i}`, 'READY']));
  const p = summarizePlan(ids, { batchSize: 50, maxActiveContainers: 10 });
  assert.equal(p.ok, true);
  assert.equal(p.total, 200);
  assert.equal(p.batchCount, 4);
  assert.deepEqual(p.perBatch, [50, 50, 50, 50]);
  assert.equal(p.ready, 200);
  assert.equal(p.skippedDisabled, 0);
  assert.equal(p.estimatedContainers, 200);
  // capped peak = min(cap, max batch size) = min(10,50) = 10
  assert.equal(p.peakConcurrent, 10);
});

test('summarizePlan: 201 identities / batch 50 → last partial batch of 1, none dropped', () => {
  const ids = idents(Array.from({ length: 201 }, (_, i) => [`id${i}`, 'READY']));
  const p = summarizePlan(ids, { batchSize: 50, maxActiveContainers: 8 });
  assert.equal(p.batchCount, 5);
  assert.deepEqual(p.perBatch, [50, 50, 50, 50, 1]);
  assert.equal(p.ready, 201);
  assert.equal(p.estimatedContainers, 201); // 201 = sum(perBatch), nothing lost
});

test('summarizePlan: disabled + non-ready identities are skipped and counted', () => {
  const ids = idents([
    ['a', 'READY'],
    ['b', 'DISABLED'],
    ['c', 'FAILED_FINAL'], // non-ready, non-disabled
    ['d', 'READY'],
    ['e', 'COMPLETED'],
  ]);
  const p = summarizePlan(ids, { batchSize: 2, maxActiveContainers: 4 });
  assert.equal(p.ok, true);
  assert.equal(p.total, 5);
  assert.equal(p.ready, 2); // a, d
  assert.equal(p.skippedDisabled, 1); // b
  assert.equal(p.skippedOther, 2); // c, e
  assert.equal(p.estimatedContainers, 2);
});

test('summarizePlan: invalid batch size → ok:false with message (never throws to UI)', () => {
  assert.equal(summarizePlan([], { batchSize: 0, maxActiveContainers: 4 }).ok, false);
  assert.equal(summarizePlan([], { batchSize: 2.5, maxActiveContainers: 4 }).ok, false);
  assert.equal(summarizePlan([], { batchSize: 'x', maxActiveContainers: 4 }).ok, false);
  // null/undefined identity list degrades to an empty plan, not a crash
  const p = summarizePlan(null, { batchSize: 10, maxActiveContainers: 4 });
  assert.equal(p.ok, true);
  assert.equal(p.total, 0);
  assert.equal(p.batchCount, 0);
});

test('summarizePlan: no global cap → peak falls back to largest batch size', () => {
  const ids = idents(Array.from({ length: 12 }, (_, i) => [`id${i}`, 'READY']));
  const p = summarizePlan(ids, { batchSize: 5, maxActiveContainers: null });
  assert.deepEqual(p.perBatch, [5, 5, 2]);
  assert.equal(p.peakConcurrent, 5);
});

// ---------------------------------------------------------------- monitor ---
test('taskFlags: stuck / unknown / failed derivation', () => {
  assert.deepEqual(taskFlags({ stuck: true, unknown: false, status: 'running' }), { stuck: true, unknown: false, failed: false });
  assert.deepEqual(taskFlags({ stuck: false, unknown: true, status: 'unknown' }), { stuck: false, unknown: true, failed: false });
  assert.deepEqual(taskFlags({ status: 'failed' }), { stuck: false, unknown: false, failed: true });
  assert.deepEqual(taskFlags({ status: 'timed_out' }), { stuck: false, unknown: false, failed: true });
  assert.deepEqual(taskFlags(null), { stuck: false, unknown: false, failed: false });
});

test('hostHealth: low thresholds + null-safe degradation', () => {
  const low = 1024 * 1024 * 1024; // 1 GiB
  assert.deepEqual(hostHealth(null, low), { memory: 'unknown', disk: 'unknown' });
  assert.equal(hostHealth({ memoryAvailableBytes: 5e9, memoryTotalBytes: 16e9, diskAvailableBytes: 5e9 }, low).memory, 'ok');
  assert.equal(hostHealth({ memoryAvailableBytes: 5e9, memoryTotalBytes: 16e9, diskAvailableBytes: 5e9 }, low).disk, 'ok');
  // <10% memory
  assert.equal(hostHealth({ memoryAvailableBytes: 1e9, memoryTotalBytes: 16e9 }, low).memory, 'low');
  // below disk floor
  assert.equal(hostHealth({ diskAvailableBytes: low - 1 }, low).disk, 'low');
  // null subfields stay unknown, do not throw
  assert.deepEqual(hostHealth({ memoryAvailableBytes: null, diskAvailableBytes: null }, low), { memory: 'unknown', disk: 'unknown' });
});

test('alertClass: critical vs warning banner', () => {
  assert.equal(alertClass({ severity: 'critical' }), 'alert-banner critical');
  assert.equal(alertClass({ severity: 'warning' }), 'alert-banner warning');
  assert.equal(alertClass(null), 'alert-banner warning');
});

// ----------------------------------------------------------------- report ---
test('cycleExportable: only terminal cycles export', () => {
  assert.equal(cycleExportable({ status: 'COMPLETED' }), true);
  assert.equal(cycleExportable({ status: 'COMPLETED_WITH_ERRORS' }), true);
  assert.equal(cycleExportable({ status: 'CANCELLED' }), true);
  assert.equal(cycleExportable({ status: 'RUNNING' }), false);
  assert.equal(cycleExportable({ status: 'PAUSED' }), false);
  assert.equal(cycleExportable(null), false);
  assert.deepEqual(REPORT_FORMATS.map((f) => f.id), ['json', 'csv']);
});

// ----------------------------------------------------------------- format ---
test('fmtBytes: units + null-safe', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(1023), '1023 B');
  assert.equal(fmtBytes(1024), '1 KB');
  assert.equal(fmtBytes(5 * 1024 * 1024), '5 MB');
  assert.equal(fmtBytes(3 * 1024 ** 3), '3 GB');
  assert.equal(fmtBytes(null), '—');
  assert.equal(fmtBytes(NaN), '—');
});

test('fmtDuration: seconds/minutes/hours + null-safe', () => {
  assert.equal(fmtDuration(5000), '5s');
  assert.equal(fmtDuration(90 * 1000), '1m 30s');
  assert.equal(fmtDuration(4 * 3600 * 1000 + 15 * 60 * 1000), '4h 15m');
  assert.equal(fmtDuration(null), '—');
  assert.equal(fmtDuration(-5), '—');
});

test('fmtAge: relative + null-safe', () => {
  const now = 1_700_000_000_000;
  assert.equal(fmtAge(new Date(now - 5 * 1000).toISOString(), now), 'just now');
  assert.equal(fmtAge(new Date(now - 45 * 1000).toISOString(), now), '45s ago');
  assert.equal(fmtAge(new Date(now - 5 * 60 * 1000).toISOString(), now), '5m ago');
  assert.equal(fmtAge(new Date(now - 3 * 3600 * 1000).toISOString(), now), '3h ago');
  assert.equal(fmtAge(new Date(now - 3 * 86400 * 1000).toISOString(), now), '3d ago');
  assert.equal(fmtAge(null, now), '—');
});

test('fmtTime / shortId: null-safe display', () => {
  assert.equal(fmtTime(null), '—');
  assert.equal(fmtTime('not-a-date'), '—');
  assert.equal(fmtTime(new Date(2026, 9, 21, 8, 5, 3).toISOString()).length, 8); // HH:MM:SS
  assert.equal(shortId(null), '—');
  assert.equal(shortId('0123456789abcdef'), '01234567');
  assert.equal(shortId('abcdef', 3), 'abc');
});

// ------------------------------------------------------------------ pills ---
test('pill maps: known statuses map, unknown → pill-disabled', () => {
  assert.equal(pillClass(BATCH_STATUS_PILL, 'RUNNING'), 'pill-up');
  assert.equal(pillClass(BATCH_STATUS_PILL, 'COMPLETED_WITH_ERRORS'), 'pill-down');
  assert.equal(pillClass(RUN_STATUS_PILL, 'succeeded'), 'pill-up');
  assert.equal(pillClass(RUN_STATUS_PILL, 'failed'), 'pill-down');
  assert.equal(pillClass(IDENTITY_PILL, 'READY'), 'pill-up');
  assert.equal(pillClass(IDENTITY_PILL, 'FAILED_FINAL'), 'pill-down');
  assert.equal(pillClass(CYCLE_STATUS_PILL, 'COMPLETED'), 'pill-up');
  // unknown statuses never crash, render as disabled
  assert.equal(pillClass(BATCH_STATUS_PILL, 'WHATEVER'), 'pill-disabled');
  assert.equal(pillClass(RUN_STATUS_PILL, null), 'pill-disabled');
});
