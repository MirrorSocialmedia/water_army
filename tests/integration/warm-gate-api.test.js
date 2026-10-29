/**
 * WA-WARMING s1 — warm-gate + warm-state API (hermetic).
 *
 * Covers the AC matrix:
 *   - 業務閘: cold/warming identity business create => 409 WARM_GATE_BLOCKED;
 *     warm / matured-warming / threshold-override => 201; warming-purpose
 *     batches bypass (business vs 養號 task distinction).
 *   - override: operator => 403, admin without reason => 400, admin+reason
 *     => 201 + audited (reason + released identities).
 *   - warm routes: RBAC, start/reset/force transitions, force reason rule,
 *     derived progress, threshold GET/PUT (AppSetting round-trip + audit).
 *   - preview: informational warm.blocked, never blocks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from '@node-rs/argon2';

import { buildApp } from '../../apps/api/src/app.js';
import { makeBatchApiDb } from '../helpers/batch-api-fakes.js';
import { testConfig, fakeRedisOk, makeFakeQueue } from '../helpers/fakes.js';
import { makeFakeDockerWrapper } from '../helpers/fake-docker-client.js';

const { argon2id, hash } = argon2;
const PASSWORD = 'TestPass123';
const DAY = 86_400_000;

const uid = (n) => `eeeeeeee-ffff-4aaa-8bbb-${String(n).padStart(12, '0')}`;
const mkId = (n, extra = {}) => ({
  id: uid(n),
  externalRef: `warm-${n}`,
  displayName: `warm-${n}`,
  identityType: 'ACCOUNT',
  status: 'READY',
  dataPath: `/data/warm-${n}`,
  createdAt: new Date(Date.now() - 2 * DAY),
  ...extra,
});

async function makeApp({ identities = [] } = {}) {
  const passwordHash = await hash(PASSWORD, { type: argon2id });
  const db = makeBatchApiDb({
    users: [
      { id: 'u-admin', username: 'admin1', passwordHash, role: 'admin' },
      { id: 'u-op', username: 'operator1', passwordHash, role: 'operator' },
      { id: 'u-view', username: 'viewer1', passwordHash, role: 'viewer' },
    ],
    batch: { identities },
  });
  const app = await buildApp({
    config: { ...testConfig, aiProvider: 'mock' },
    db,
    redis: fakeRedisOk(),
    docker: makeFakeDockerWrapper({ containers: [] }),
    taskQueue: makeFakeQueue(),
  });
  await app.ready();
  return { app, db };
}

async function login(app, username) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD } });
  assert.equal(res.statusCode, 200, res.body);
  return res.headers['set-cookie'].split(';')[0];
}

let seq = 100;
const createBody = (identities, extra = {}) => ({
  name: `warm-cycle-${++seq}`,
  idempotencyKey: `warmkey${seq}abcdef`,
  identities,
  batchSize: 5,
  maxActiveContainers: 2,
  failurePolicy: 'continue_and_report',
  ...extra,
});

test('business gate matrix: cold/warming 409, warm + matured + override-0 pass, warming purpose bypasses, grandfathered pass', async () => {
  const ago = (d) => new Date(Date.now() - d * DAY);
  const cold = mkId(1, { warmState: 'cold' });
  const warming = mkId(2, { warmState: 'warming', warmStartedAt: ago(3) });
  const matured = mkId(3, { warmState: 'warming', warmStartedAt: ago(15) });
  const warm = mkId(4, { warmState: 'warm', warmReadyAt: ago(1) });
  const fastLane = mkId(5, { warmState: 'warming', warmStartedAt: ago(1), metadataJson: { warmThresholdDays: 0 } });
  const legacy = mkId(6); // no warmState column value = grandfathered warm
  const { app } = await makeApp({ identities: [cold, warming, matured, warm, fastLane, legacy] });
  const op = await login(app, 'operator1');

  // 409 matrix — cold & warming block the business cycle, with detail.
  for (const idy of [cold, warming]) {
    const res = await app.inject({ method: 'POST', url: '/api/batches', headers: { cookie: op }, payload: createBody([idy.id]) });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error.code, 'WARM_GATE_BLOCKED');
    assert.equal(res.json().error.blocked.length, 1);
    assert.equal(res.json().error.blocked[0].identityId, idy.id);
  }
  // Mixed cycle: one cold poisons the business create (honest batch refusal).
  const mixed = await app.inject({ method: 'POST', url: '/api/batches', headers: { cookie: op }, payload: createBody([warm.id, cold.id, warming.id]) });
  assert.equal(mixed.statusCode, 409);
  assert.equal(mixed.json().error.blocked.length, 2, 'both not-warm identities reported');

  // 201 matrix — warm, matured (derived), per-identity threshold 0, grandfathered.
  for (const idy of [warm, matured, fastLane, legacy]) {
    const res = await app.inject({ method: 'POST', url: '/api/batches', headers: { cookie: op }, payload: createBody([idy.id]) });
    assert.equal(res.statusCode, 201, `${idy.externalRef}: ${res.body}`);
  }

  // warming-purpose BYPASSES the gate — cold accounts are exactly who warming runs serve.
  const warmRun = await app.inject({
    method: 'POST', url: '/api/batches', headers: { cookie: op },
    payload: createBody([cold.id, warming.id], { config: { purpose: 'warming', warmingTemplate: 'search' } }),
  });
  assert.equal(warmRun.statusCode, 201, warmRun.body);

  // preview reports the refusal WITHOUT blocking (preview schema: no name/idempotencyKey).
  const prev = await app.inject({
    method: 'POST', url: '/api/batches/preview', headers: { cookie: op },
    payload: { identities: [cold.id, warm.id], batchSize: 5, maxActiveContainers: 2, failurePolicy: 'continue_and_report' },
  });
  assert.equal(prev.statusCode, 200);
  assert.equal(prev.json().warm.blocked.length, 1);
  assert.equal(prev.json().warm.blocked[0].identityId, cold.id);
});

test('override discipline: operator 403, admin needs reason, admin+reason 201 + audit', async () => {
  const cold = mkId(11, { warmState: 'cold' });
  const { app, db } = await makeApp({ identities: [cold] });
  const op = await login(app, 'operator1');
  const admin = await login(app, 'admin1');

  const opOverride = await app.inject({
    method: 'POST', url: '/api/batches', headers: { cookie: op },
    payload: createBody([cold.id], { warmOverride: true, warmOverrideReason: 'operator cannot do this' }),
  });
  assert.equal(opOverride.statusCode, 403);
  assert.equal(opOverride.json().error.code, 'WARM_OVERRIDE_ADMIN_ONLY');

  const noReason = await app.inject({
    method: 'POST', url: '/api/batches', headers: { cookie: admin },
    payload: createBody([cold.id], { warmOverride: true }),
  });
  assert.equal(noReason.statusCode, 400, 'reason REQUIRED for admin override');

  const ok = await app.inject({
    method: 'POST', url: '/api/batches', headers: { cookie: admin },
    payload: createBody([cold.id], { warmOverride: true, warmOverrideReason: 'campaign deadline, boss approved' }),
  });
  assert.equal(ok.statusCode, 201, ok.body);

  const audits = db.__state.auditRows;
  const createAudit = audits.filter((a) => a.action === 'batch.cycle_create').at(-1);
  assert.ok(createAudit, 'cycle create audited');
  const details = createAudit.detailsJson ?? createAudit.details;
  assert.equal(details.warmOverride.reason, 'campaign deadline, boss approved');
  assert.deepEqual(details.warmOverride.released, [{ identityId: cold.id, state: 'cold' }]);
  assert.equal(details.purpose, 'business');
});

test('warm routes: RBAC + lifecycle + force reason + progress shape', async () => {
  const cold = mkId(21, { warmState: 'cold' });
  const warming = mkId(22, { warmState: 'warming', warmStartedAt: new Date(Date.now() - 4 * DAY) });
  const { app } = await makeApp({ identities: [cold, warming] });
  const op = await login(app, 'operator1');
  const admin = await login(app, 'admin1');
  const viewer = await login(app, 'viewer1');

  // RBAC
  assert.equal((await app.inject({ method: 'GET', url: `/api/identities/${cold.id}/warm` })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: `/api/identities/${cold.id}/warm/start`, headers: { cookie: viewer }, payload: {} })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `/api/identities/${cold.id}/warm/force`, headers: { cookie: op }, payload: { reason: 'not admin enough' } })).statusCode, 403);

  // progress view (viewer+)
  const p = await app.inject({ method: 'GET', url: `/api/identities/${warming.id}/warm`, headers: { cookie: viewer } });
  assert.equal(p.statusCode, 200);
  const w = p.json().warm;
  assert.equal(w.storedState, 'warming');
  assert.equal(w.thresholdDays, 14);
  assert.equal(w.daysRemaining, 10);
  assert.ok(w.readyAt, 'readyAt surfaced for UI countdown');

  // lifecycle: cold -> start -> warming; illegal second start; force needs reason
  const start = await app.inject({ method: 'POST', url: `/api/identities/${cold.id}/warm/start`, headers: { cookie: op }, payload: {} });
  assert.equal(start.statusCode, 200, start.body);
  assert.equal(start.json().warm.storedState, 'warming');
  const again = await app.inject({ method: 'POST', url: `/api/identities/${cold.id}/warm/start`, headers: { cookie: op }, payload: {} });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error.code, 'WARM_TRANSITION_INVALID');

  const forceNoReason = await app.inject({ method: 'POST', url: `/api/identities/${cold.id}/warm/force`, headers: { cookie: admin }, payload: {} });
  assert.equal(forceNoReason.statusCode, 400, 'force reason required');
  const forced = await app.inject({ method: 'POST', url: `/api/identities/${cold.id}/warm/force`, headers: { cookie: admin }, payload: { reason: 'ops escalation 2026-10-29' } });
  assert.equal(forced.statusCode, 200, forced.body);
  assert.equal(forced.json().warm.storedState, 'warm');

  // after force, business dispatch flows for the (now warm) identity.
  const cycle = await app.inject({ method: 'POST', url: '/api/batches', headers: { cookie: op }, payload: createBody([cold.id]) });
  assert.equal(cycle.statusCode, 201, cycle.body);

  // 404 unknown identity
  assert.equal((await app.inject({ method: 'GET', url: `/api/identities/${uid(999)}/warm`, headers: { cookie: viewer } })).statusCode, 404);
});

test('threshold knob: viewer GET default, admin PUT round-trip + audit, gate honours new threshold', async () => {
  const warming = mkId(31, { warmState: 'warming', warmStartedAt: new Date(Date.now() - 4 * DAY) });
  const { app, db } = await makeApp({ identities: [warming] });
  const op = await login(app, 'operator1');
  const admin = await login(app, 'admin1');
  const viewer = await login(app, 'viewer1');

  const before = await app.inject({ method: 'GET', url: '/api/warm/threshold', headers: { cookie: viewer } });
  assert.equal(before.statusCode, 200);
  assert.deepEqual({ days: before.json().thresholdDays, source: before.json().source }, { days: 14, source: 'default' });

  assert.equal((await app.inject({ method: 'PUT', url: '/api/warm/threshold', headers: { cookie: op }, payload: { days: 3 } })).statusCode, 403, 'admin only');
  assert.equal((await app.inject({ method: 'PUT', url: '/api/warm/threshold', headers: { cookie: admin }, payload: { days: 3.5 } })).statusCode, 400);

  const set = await app.inject({ method: 'PUT', url: '/api/warm/threshold', headers: { cookie: admin }, payload: { days: 3 } });
  assert.equal(set.statusCode, 200, set.body);
  assert.equal(set.json().thresholdDays, 3);
  const row = await db.appSetting.findUnique({ where: { key: 'warm.threshold_days' } });
  assert.equal(row.valueJson.value, 3, 'AppSetting persisted under warm.threshold_days');
  assert.ok(db.__state.auditRows.some((a) => a.action === 'warm.threshold_set' && (a.detailsJson ?? a.details).days === 3), 'threshold change audited');

  // gate now honours 3d: the 4d-warming identity passes WITHOUT any identity-level change.
  const cycle = await app.inject({ method: 'POST', url: '/api/batches', headers: { cookie: op }, payload: createBody([warming.id]) });
  assert.equal(cycle.statusCode, 201, cycle.body);
});
