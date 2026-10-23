/**
 * MC P4 (Mobile Console MD Phase 4 / §6) — intervention STATE MACHINE +
 * shared signal writer, hermetic unit tests (fake db, real service code).
 *
 * Proves the MD §6.2/§6.3 contract at the domain layer:
 *  - the operator transition table (ack/assign/resolve/dismiss/reopen) with
 *    single-statement CAS transitions (stale actions → STALE_EVENT 409)
 *  - the role-specific dismiss policy: external_verification (CAPTCHA /
 *    anti-bot / account-integrity) is NEVER dismissible — human resolve only
 *    (MD §0.6 hard constraint); critical events dismiss = admin only
 *  - episode dedupe: one open episode per device+category+source; repeat
 *    signals re-escalate (severity/disposition only go UP, signalCount++)
 *  - a terminal episode is NEVER auto-reopened by a late signal — a new
 *    episode is created instead (MD §6.3)
 *  - concurrent creators: exactly one wins, the loser re-escalates (P2002
 *    fallback) — no oversubscribe, no notification storm
 *  - sensitive evidence keys are redacted before persistence (MD §6.2/§13)
 *  - the needs-attention badge counts only open + in_progress (MD §7.1)
 *  - the unavailable stub fails closed (503) while keeping boot alive
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeFakeDb } from '../helpers/fakes.js';
import {
  createInterventionService,
  createUnavailableIntervention,
} from '../../apps/api/src/services/intervention-service.js';
import {
  INTERVENTION_STATUS,
  INTERVENTION_SOURCE,
  INTERVENTION_CATEGORY,
  INTERVENTION_SEVERITY,
  AUTOMATION_DISPOSITION,
  interventionDedupeKey,
} from '../../packages/shared/src/intervention.js';

const ADMIN = { id: 'u-admin', role: 'admin' };
const OPERATOR = { id: 'u-operator', role: 'operator' };
const VIEWER = { id: 'u-viewer', role: 'viewer' };

function makeSvcs(opts = {}) {
  const db = makeFakeDb({ users: [] });
  const svcs = createInterventionService({ db, log: { warn() {}, error() {} }, audit: async () => {}, ...opts });
  return { db, svc: svcs };
}

async function openEpisode(svc, over = {}) {
  const out = await svc.recordSignal({
    deviceId: over.deviceId ?? 'd-1',
    deviceNameSnapshot: over.deviceNameSnapshot ?? 'dev-1',
    source: over.source ?? INTERVENTION_SOURCE.QA_SIGNAL,
    category: over.category ?? INTERVENTION_CATEGORY.MANUAL_REVIEW,
    severity: over.severity ?? INTERVENTION_SEVERITY.WARNING,
    title: over.title ?? 'unit: needs human',
    summary: over.summary ?? null,
    evidence: over.evidence ?? null,
    automationDisposition: over.automationDisposition ?? AUTOMATION_DISPOSITION.NOT_APPLICABLE,
    heuristic: over.heuristic ?? false,
  });
  assert.ok(out, 'recordSignal must succeed');
  return out;
}

// ---------------------------------------------------------------------------
// dedupe key
// ---------------------------------------------------------------------------

test('p4 dedupe key: device+category+source, orphan-safe', () => {
  assert.equal(interventionDedupeKey('d-1', 'NETWORK_BLOCKED', 'network_state'), 'd-1::NETWORK_BLOCKED::network_state');
  assert.equal(interventionDedupeKey(null, 'OTHER', 'operator_report'), 'orphan::OTHER::operator_report');
  assert.notEqual(
    interventionDedupeKey('d-1', 'DEVICE_OFFLINE', 'adb_health'),
    interventionDedupeKey('d-1', 'DEVICE_OFFLINE', 'container_health'),
    'different sources must never share an episode',
  );
  assert.notEqual(
    interventionDedupeKey('d-1', 'DEVICE_OFFLINE', 'adb_health'),
    interventionDedupeKey('d-2', 'DEVICE_OFFLINE', 'adb_health'),
    'different devices must never share an episode',
  );
});

// ---------------------------------------------------------------------------
// episode creation + re-escalation (MD §6.3)
// ---------------------------------------------------------------------------

test('p4 first signal creates one open episode with history', async () => {
  const { svc } = makeSvcs();
  const out = await openEpisode(svc);
  assert.equal(out.created, true);
  const row = out.intervention;
  assert.equal(row.status, INTERVENTION_STATUS.OPEN);
  assert.equal(row.signalCount, 1);
  assert.equal(row.version, 1);
  const hist = await svc.get(row.id);
  assert.equal(hist.history.length, 1);
  assert.equal(hist.history[0].action, 'created');
  assert.equal(hist.history[0].fromStatus, null);
});

test('p4 repeat signal re-escalates the SAME episode (no storm)', async () => {
  const { svc } = makeSvcs();
  const first = await openEpisode(svc);
  const second = await svc.recordSignal({
    deviceId: 'd-1', deviceNameSnapshot: 'dev-1',
    source: INTERVENTION_SOURCE.QA_SIGNAL, category: INTERVENTION_CATEGORY.MANUAL_REVIEW,
    severity: INTERVENTION_SEVERITY.HIGH, title: 'unit: needs human',
  });
  assert.equal(second.created, false, 'repeat must not create a second episode');
  const row = second.intervention;
  assert.equal(row.id, first.intervention.id, 'same episode id');
  assert.equal(row.signalCount, 2, 'signal counter bumped');
  assert.equal(row.severity, INTERVENTION_SEVERITY.HIGH, 'severity escalated up');
  assert.equal(row.status, INTERVENTION_STATUS.OPEN, 'episode still open');

  // severity only goes UP — a later weaker signal must not downgrade
  const third = await svc.recordSignal({
    deviceId: 'd-1', deviceNameSnapshot: 'dev-1',
    source: INTERVENTION_SOURCE.QA_SIGNAL, category: INTERVENTION_CATEGORY.MANUAL_REVIEW,
    severity: INTERVENTION_SEVERITY.INFO, title: 'unit: needs human',
  });
  assert.equal(third.created, false);
  assert.equal(third.intervention.severity, INTERVENTION_SEVERITY.HIGH, 'severity never downgrades');
  assert.equal(third.intervention.signalCount, 3);
});

test('p4 blocked_pending_review is never downgraded by a later signal (MD §0.6)', async () => {
  const { svc } = makeSvcs();
  // same dedupe key (device+category+source) → re-escalation path
  const base = { deviceId: 'd-1', deviceNameSnapshot: 'dev-1', source: INTERVENTION_SOURCE.QA_SIGNAL, category: INTERVENTION_CATEGORY.EXTERNAL_VERIFICATION, title: 'challenge appeared' };
  await openEpisode(svc, { ...base, automationDisposition: AUTOMATION_DISPOSITION.PAUSED });
  const esc = await svc.recordSignal({ ...base, severity: INTERVENTION_SEVERITY.HIGH, automationDisposition: AUTOMATION_DISPOSITION.BLOCKED_PENDING_REVIEW });
  assert.equal(esc.created, false, 'same key must re-escalate, not create');
  assert.equal(esc.intervention.automationDisposition, AUTOMATION_DISPOSITION.BLOCKED_PENDING_REVIEW);
  const weak = await svc.recordSignal({ ...base, severity: INTERVENTION_SEVERITY.WARNING, automationDisposition: AUTOMATION_DISPOSITION.NOT_APPLICABLE });
  assert.equal(weak.created, false);
  assert.equal(
    weak.intervention.automationDisposition,
    AUTOMATION_DISPOSITION.BLOCKED_PENDING_REVIEW,
    'a blocked episode can never silently relax to not_applicable',
  );
});

test('p4 service forces blocked_pending_review for the external_verification SOURCE (MD §0.6)', async () => {
  const { svc } = makeSvcs();
  const out = await svc.recordSignal({
    deviceId: 'd-ev', deviceNameSnapshot: 'dev-ev',
    source: INTERVENTION_SOURCE.EXTERNAL_VERIFICATION, category: INTERVENTION_CATEGORY.EXTERNAL_VERIFICATION,
    severity: INTERVENTION_SEVERITY.HIGH, title: 'third-party CAPTCHA challenge',
    automationDisposition: AUTOMATION_DISPOSITION.NOT_APPLICABLE, // caller tries to relax it
  });
  assert.ok(out.created);
  assert.equal(out.intervention.automationDisposition, AUTOMATION_DISPOSITION.BLOCKED_PENDING_REVIEW, 'a third-party challenge always blocks pending review');
});

test('p4 terminal episode + new signal = NEW episode (never auto-reopen, MD §6.3)', async () => {
  const { svc } = makeSvcs();
  const first = await openEpisode(svc);
  await svc.resolve(first.intervention.id, { user: OPERATOR, summary: 'handled' });
  const stale = await svc.recordSignal({
    deviceId: 'd-1', deviceNameSnapshot: 'dev-1',
    source: INTERVENTION_SOURCE.QA_SIGNAL, category: INTERVENTION_CATEGORY.MANUAL_REVIEW,
    severity: INTERVENTION_SEVERITY.WARNING, title: 'late duplicate of a handled issue',
  });
  assert.equal(stale.created, true, 'a signal after terminal state opens a FRESH episode');
  assert.notEqual(stale.intervention.id, first.intervention.id);
  const { intervention: oldRow } = await svc.get(first.intervention.id);
  assert.equal(oldRow.status, INTERVENTION_STATUS.RESOLVED, 'the old episode stays terminal — no silent reopen');
});

test('p4 concurrent creators: exactly one wins, loser re-escalates (P2002 fallback)', async () => {
  const { svc } = makeSvcs();
  const results = await Promise.all([
    openEpisode(svc, { title: 'race A' }),
    openEpisode(svc, { title: 'race B' }),
  ]);
  const created = results.filter((r) => r.created).length;
  assert.equal(created, 1, 'exactly one creator may win the partial-unique race');
  const ids = new Set(results.map((r) => r.intervention.id));
  assert.equal(ids.size, 1, 'both must converge on the single episode');
  const winner = results.find((r) => r.created);
  const { intervention } = await svc.get(winner.intervention.id);
  assert.equal(intervention.signalCount, 2, 'the loser must have re-escalated, not dropped the signal');
  const hist = (await svc.get(winner.intervention.id)).history;
  const signals = hist.filter((h) => h.action === 'signal');
  assert.ok(signals.length >= 1, 'the re-escalation is recorded in history');
});

// ---------------------------------------------------------------------------
// operator state machine (MD §6.2)
// ---------------------------------------------------------------------------

test('p4 happy path: open → ack → assign → resolve (timestamps + audit shape)', async () => {
  const { svc } = makeSvcs();
  const { intervention: row } = await openEpisode(svc);
  const acked = await svc.acknowledge(row.id, { user: OPERATOR });
  assert.equal(acked.status, INTERVENTION_STATUS.ACKNOWLEDGED);
  assert.ok(acked.acknowledgedAt instanceof Date, 'acknowledge stamps acknowledgedAt');
  assert.equal(acked.resolvedAt, null, 'ack ≠ resolve (MD §6.2)');

  const assigned = await svc.assign(row.id, { user: OPERATOR });
  assert.equal(assigned.status, INTERVENTION_STATUS.IN_PROGRESS);
  assert.equal(assigned.assigneeUserId, OPERATOR.id);

  const resolved = await svc.resolve(row.id, { user: OPERATOR, summary: 'device rebooted, canary green' });
  assert.equal(resolved.status, INTERVENTION_STATUS.RESOLVED);
  assert.ok(resolved.resolvedAt instanceof Date);
  assert.equal(resolved.resolutionSummary, 'device rebooted, canary green');

  const { history } = await svc.get(row.id);
  const actions = history.map((h) => h.action);
  assert.deepEqual(actions, ['created', 'acknowledge', 'assign', 'resolve']);
  assert.equal(history.length, 4);
  for (const h of history.slice(1)) {
    assert.equal(h.actorUserId, OPERATOR.id, `operator action '${h.action}' is attributed`);
  }
  assert.equal(history[0].actorUserId, null, 'a system/controlled signal has no operator actor');
  assert.equal(history[history.length - 1].note, 'device rebooted, canary green', 'the resolve summary is kept in the trail');
});

test('p4 illegal transitions are rejected with the current state in the error', async () => {
  const { svc } = makeSvcs();
  const { intervention: row } = await openEpisode(svc);

  // ack is only from open
  await svc.acknowledge(row.id, { user: OPERATOR });
  await assert.rejects(
    () => svc.acknowledge(row.id, { user: OPERATOR }),
    (e) => e.apiCode === 'ILLEGAL_TRANSITION' && e.statusCode === 409 && e.details.status === INTERVENTION_STATUS.ACKNOWLEDGED,
  );
  // resolve a terminal twice
  await svc.resolve(row.id, { user: OPERATOR, summary: 'done' });
  await assert.rejects(
    () => svc.resolve(row.id, { user: OPERATOR, summary: 'again' }),
    (e) => e.apiCode === 'ILLEGAL_TRANSITION' && e.statusCode === 409,
  );
});

test('p4 CAS: a concurrent winner bumps the version → stale action gets STALE_EVENT', async () => {
  const { db, svc } = makeSvcs();
  const { intervention: row } = await openEpisode(svc);
  // Simulate a concurrent operator winning the same transition: intercept the
  // transition's CAS updateMany and apply a competing write (version bump +
  // status change) first — exactly the race the single updateMany guards.
  const origUpdateMany = db.manualIntervention.updateMany.bind(db.manualIntervention);
  let intercepted = false;
  db.manualIntervention.updateMany = async (args) => {
    if (!intercepted && args.where?.id === row.id) {
      intercepted = true;
      await origUpdateMany({
        where: { id: row.id, version: row.version },
        data: { status: INTERVENTION_STATUS.ACKNOWLEDGED, acknowledgedAt: new Date(), version: row.version + 1 },
      });
    }
    return origUpdateMany(args);
  };
  await assert.rejects(
    () => svc.acknowledge(row.id, { user: OPERATOR }),
    (e) => e.apiCode === 'STALE_EVENT' && e.statusCode === 409 && e.details.version === row.version + 1,
    'the loser of the CAS race must see the fresh state, never clobber it',
  );
});

test('p4 reopen: explicit, version-guarded, from terminal only', async () => {
  const { svc } = makeSvcs();
  const { intervention: row } = await openEpisode(svc);
  await svc.resolve(row.id, { user: OPERATOR, summary: 'first pass' });
  // reopen is NOT legal from an active status
  const active = await openEpisode(svc, { deviceId: 'd-9', deviceNameSnapshot: 'dev-9', category: INTERVENTION_CATEGORY.OTHER, title: 'other' });
  await assert.rejects(
    () => svc.reopen(active.intervention.id, { user: OPERATOR, reason: 'x' }),
    (e) => e.apiCode === 'ILLEGAL_TRANSITION',
  );
  const reopened = await svc.reopen(row.id, { user: ADMIN, reason: 'canary failed again after the fix' });
  assert.equal(reopened.status, INTERVENTION_STATUS.OPEN);
  const { history } = await svc.get(row.id);
  const last = history[history.length - 1];
  assert.equal(last.action, 'reopen');
  assert.equal(last.note, 'canary failed again after the fix');
});

// ---------------------------------------------------------------------------
// dismiss policy (MD §0.6 hard constraint + critical ⇒ admin)
// ---------------------------------------------------------------------------

test('p4 external_verification is NEVER dismissible — not even by admin (MD §0.6)', async () => {
  const { svc } = makeSvcs();
  // The API path forces blocked_pending_review for external_verification;
  // the service-level writer honors a caller-provided disposition, so pin
  // the category here (the dismiss policy keys off the category, not the
  // disposition — a human can resolve after review, never dismiss).
  const { intervention: row } = await openEpisode(svc, {
    source: INTERVENTION_SOURCE.EXTERNAL_VERIFICATION,
    category: INTERVENTION_CATEGORY.EXTERNAL_VERIFICATION,
    automationDisposition: AUTOMATION_DISPOSITION.BLOCKED_PENDING_REVIEW,
    title: 'third-party CAPTCHA challenge',
  });
  await assert.rejects(
    () => svc.dismiss(row.id, { user: ADMIN, reason: 'operator says ignore it' }),
    (e) => e.apiCode === 'DISMISS_NOT_ALLOWED' && e.statusCode === 409,
    'an admin must not be able to dismiss a third-party challenge — only a human resolve after review',
  );
  // …and it IS resolvable by a human after the review
  const resolved = await svc.resolve(row.id, { user: ADMIN, summary: 'reviewed per service rules; human completed the check on-device' });
  assert.equal(resolved.status, INTERVENTION_STATUS.RESOLVED);
});

test('p4 critical dismiss = admin only; warning dismiss = operator ok', async () => {
  const { svc } = makeSvcs();
  const critical = await openEpisode(svc, { severity: INTERVENTION_SEVERITY.CRITICAL, deviceId: 'd-c', deviceNameSnapshot: 'dev-c', category: INTERVENTION_CATEGORY.NETWORK_BLOCKED, title: 'net down' });
  await assert.rejects(
    () => svc.dismiss(critical.intervention.id, { user: OPERATOR, reason: 'looks fine' }),
    (e) => e.apiCode === 'DISMISS_NOT_ALLOWED' && e.statusCode === 403,
  );
  const dismissed = await svc.dismiss(critical.intervention.id, { user: ADMIN, reason: 'confirmed false positive: canary flake' });
  assert.equal(dismissed.status, INTERVENTION_STATUS.DISMISSED);
  assert.equal(dismissed.resolvedAt instanceof Date, true, 'dismiss stamps the terminal timestamp');

  const warning = await openEpisode(svc, { deviceId: 'd-w', deviceNameSnapshot: 'dev-w', category: INTERVENTION_CATEGORY.OTHER, title: 'minor' });
  const ok = await svc.dismiss(warning.intervention.id, { user: OPERATOR, reason: 'not an issue' });
  assert.equal(ok.status, INTERVENTION_STATUS.DISMISSED);
});

test('p4 note required for resolve/dismiss/reopen; too-long note rejected', async () => {
  const { svc } = makeSvcs();
  const { intervention: row } = await openEpisode(svc);
  await assert.rejects(() => svc.resolve(row.id, { user: OPERATOR, summary: '' }), (e) => e.apiCode === 'NOTE_REQUIRED' && e.statusCode === 400);
  await assert.rejects(() => svc.dismiss(row.id, { user: OPERATOR, reason: '   ' }), (e) => e.apiCode === 'NOTE_REQUIRED');
  await assert.rejects(
    () => svc.resolve(row.id, { user: OPERATOR, summary: 'x'.repeat(2001) }),
    (e) => e.apiCode === 'NOTE_TOO_LONG' && e.statusCode === 400,
  );
});

// ---------------------------------------------------------------------------
// signals via the dedicated production entry points
// ---------------------------------------------------------------------------

test('p4 signalNetwork: BLOCKED=high/paused, FAILED=critical/blocked_pending_review', async () => {
  const { svc } = makeSvcs();
  const dev = { id: 'd-net', name: 'netdev', netRecoveries: 4 };
  const blocked = await svc.signalNetwork(dev, 'BLOCKED', { from: 'DEGRADED', reason: 'canary threshold' });
  assert.ok(blocked.created);
  assert.equal(blocked.intervention.source, INTERVENTION_SOURCE.NETWORK_STATE);
  assert.equal(blocked.intervention.category, INTERVENTION_CATEGORY.NETWORK_BLOCKED);
  assert.equal(blocked.intervention.severity, INTERVENTION_SEVERITY.HIGH);
  assert.equal(blocked.intervention.automationDisposition, AUTOMATION_DISPOSITION.PAUSED);
  const failed = await svc.signalNetwork({ id: 'd-net2', name: 'netdev2' }, 'FAILED', { from: 'BLOCKED', reason: 'recovery exhausted' });
  assert.equal(failed.intervention.severity, INTERVENTION_SEVERITY.CRITICAL);
  assert.equal(failed.intervention.automationDisposition, AUTOMATION_DISPOSITION.BLOCKED_PENDING_REVIEW);
});

test('p4 signalBootTimeout: blocked_pending_review by design', async () => {
  const { svc } = makeSvcs();
  const out = await svc.signalBootTimeout({ id: 'd-boot', name: 'bootdev' }, { reason: 'boot_completed not seen within 15s', errorCode: 'TUNNEL_START_TIMEOUT' });
  assert.equal(out.intervention.source, INTERVENTION_SOURCE.BOOT_TIMEOUT);
  assert.equal(out.intervention.category, INTERVENTION_CATEGORY.BOOT_TIMEOUT);
  assert.equal(out.intervention.automationDisposition, AUTOMATION_DISPOSITION.BLOCKED_PENDING_REVIEW);
});

test('p4 signalAdbOffline: device-side offline = HIGH, engine failure never calls it', async () => {
  const { svc } = makeSvcs();
  const out = await svc.signalAdbOffline({ id: 'd-adb', name: 'adbdev', containerState: 'running' }, { adbError: null, adbNote: 'adb device offline' });
  assert.equal(out.intervention.source, INTERVENTION_SOURCE.ADB_HEALTH);
  assert.equal(out.intervention.category, INTERVENTION_CATEGORY.DEVICE_OFFLINE);
  assert.equal(out.intervention.severity, INTERVENTION_SEVERITY.HIGH);
});

// ---------------------------------------------------------------------------
// redaction (MD §6.2/§13)
// ---------------------------------------------------------------------------

test('p4 sensitive evidence keys are redacted before persistence', async () => {
  const { svc } = makeSvcs();
  const { intervention: row } = await openEpisode(svc, {
    evidence: {
      password: 'hunter2',
      dbPassword: 's3cret',
      sessionCookie: 'sid=abc123',
      api_key: 'sk-live-xyz',
      errorCode: 'CANARY_TIMEOUT', // non-sensitive key stays
      retries: 3, // number under a non-sensitive key stays
    },
    summary: 'device stuck',
  });
  const stored = row.evidence;
  assert.equal(stored.password, '***redacted***');
  assert.equal(stored.dbPassword, '***redacted***');
  assert.equal(stored.sessionCookie, '***redacted***');
  assert.equal(stored.api_key, '***redacted***');
  assert.equal(stored.errorCode, 'CANARY_TIMEOUT', 'machine codes are NOT secrets — they stay readable');
  assert.equal(stored.retries, 3);
  assert.ok(!JSON.stringify(row).includes('hunter2'), 'the raw secret must never reach storage');
  assert.ok(!JSON.stringify(row).includes('s3cret'));
});

// ---------------------------------------------------------------------------
// queries (badge + per-device flags, MD §7.1/§3.1)
// ---------------------------------------------------------------------------

test('p4 badge counts only open + in_progress; per-device flag excludes terminals', async () => {
  const { svc } = makeSvcs();
  const a = await openEpisode(svc, { deviceId: 'd-1', deviceNameSnapshot: 'dev-1', title: 'a' });
  const b = await openEpisode(svc, { deviceId: 'd-2', deviceNameSnapshot: 'dev-2', title: 'b' });
  const c = await openEpisode(svc, { deviceId: 'd-3', deviceNameSnapshot: 'dev-3', title: 'c' });
  assert.equal(await svc.needsAttentionCount(), 3);

  await svc.acknowledge(a.intervention.id, { user: OPERATOR }); // acknowledged ≠ needs attention
  assert.equal(await svc.needsAttentionCount(), 2, 'acknowledged drops out of the badge (MD §7.1)');

  await svc.assign(b.intervention.id, { user: OPERATOR }); // in_progress still needs attention
  assert.equal(await svc.needsAttentionCount(), 2);

  await svc.resolve(c.intervention.id, { user: OPERATOR, summary: 'done' });
  assert.equal(await svc.needsAttentionCount(), 1);

  const byDevice = await svc.unresolvedByDevice();
  assert.deepEqual(byDevice, { 'd-1': 1, 'd-2': 1 }, 'open episodes per device; resolved d-3 excluded');
});

test('p4 list: filters + pagination + ordering (newest first)', async () => {
  // monotonic clock → strictly increasing updatedAt (deterministic ordering)
  let t = Date.now();
  const { svc } = makeSvcs({ now: () => new Date((t += 5)) });
  await openEpisode(svc, { deviceId: 'd-1', deviceNameSnapshot: 'dev-1', category: INTERVENTION_CATEGORY.OTHER, title: 'old' });
  await openEpisode(svc, { deviceId: 'd-2', deviceNameSnapshot: 'dev-2', category: INTERVENTION_CATEGORY.NETWORK_BLOCKED, severity: INTERVENTION_SEVERITY.CRITICAL, title: 'new' });
  const all = await svc.list({});
  assert.equal(all.total, 2);
  assert.equal(all.items[0].category, INTERVENTION_CATEGORY.NETWORK_BLOCKED, 'updatedAt desc ordering');
  const crit = await svc.list({ severity: INTERVENTION_SEVERITY.CRITICAL });
  assert.equal(crit.total, 1);
  const byDevice = await svc.list({ deviceId: 'd-1' });
  assert.equal(byDevice.total, 1);
  assert.equal(byDevice.items[0].deviceId, 'd-1');
  const p1 = await svc.list({ page: 1, pageSize: 1 });
  assert.equal(p1.items.length, 1);
  assert.equal(p1.total, 2);
});

test('p4 get: unknown id → 404 INTERVENTION_NOT_FOUND', async () => {
  const { svc } = makeSvcs();
  await assert.rejects(
    () => svc.get('ffffffff-ffff-4fff-8fff-ffffffffffff'),
    (e) => e.apiCode === 'INTERVENTION_NOT_FOUND' && e.statusCode === 404,
  );
});

// ---------------------------------------------------------------------------
// unavailable stub (partial fakes / pre-migration schemas)
// ---------------------------------------------------------------------------

test('p4 unavailable stub: routes fail closed 503, signals are inert nulls', async () => {
  const stub = createUnavailableIntervention();
  assert.equal(await stub.recordSignal({ deviceId: 'd', source: 's', category: 'c', title: 't' }), null);
  assert.equal(await stub.signalNetwork({ id: 'd', name: 'n' }, 'FAILED', {}), null);
  assert.equal(await stub.needsAttentionCount(), 0);
  assert.deepEqual(await stub.unresolvedByDevice(), {});
  for (const [name, fn] of [
    ['acknowledge', () => stub.acknowledge('id', {})],
    ['assign', () => stub.assign('id', {})],
    ['resolve', () => stub.resolve('id', { summary: 'x' })],
    ['dismiss', () => stub.dismiss('id', { reason: 'x' })],
    ['reopen', () => stub.reopen('id', { reason: 'x' })],
    ['list', () => stub.list({})],
    ['get', () => stub.get('id')],
  ]) {
    await assert.rejects(fn, (e) => e.apiCode === 'INTERVENTION_UNAVAILABLE' && e.statusCode === 503, `${name} must fail closed`);
  }
});
