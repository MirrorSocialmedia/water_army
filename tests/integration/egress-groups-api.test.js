/**
 * WA-IPGROUP s2 — GET /api/egress-groups (鐵律 2 observability).
 * Hermetic: unified API fake db + fake docker/redis/queue. Covers RBAC
 * (401 / viewer 200), the W3 switch (503 inert), the payload contract
 * (待行數 + 下次放行估計, singleton silence, secret-free).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from '@node-rs/argon2';

import { buildApp } from '../../apps/api/src/app.js';
import { makeBatchApiDb } from '../helpers/batch-api-fakes.js';
import { testConfig, fakeRedisOk, makeFakeQueue } from '../helpers/fakes.js';
import { makeFakeDockerWrapper } from '../helpers/fake-docker-client.js';
import { deterministicJitterMs } from '@water-army/shared';

const { argon2id, hash } = argon2;
const PASSWORD = 'TestPass123';

async function makeApp({ egressEnabled = true } = {}) {
  const passwordHash = await hash(PASSWORD, { type: argon2id });
  const db = makeBatchApiDb({
    users: [
      { id: 'u-admin', username: 'admin1', passwordHash, role: 'admin' },
      { id: 'u-view', username: 'viewer1', passwordHash, role: 'viewer' },
    ],
  });
  const app = await buildApp({
    config: { ...testConfig, aiProvider: 'mock', egressBindingEnabled: egressEnabled },
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

test('GET /api/egress-groups: RBAC + W3 switch + payload contract (secret-free)', async () => {
  const { app, db } = await makeApp();
  const viewer = await login(app, 'viewer1');

  // RBAC: 401 without a session.
  const anon = await app.inject({ method: 'GET', url: '/api/egress-groups' });
  assert.equal(anon.statusCode, 401);

  // Empty fleet → empty groups (no singleton noise).
  const empty = await app.inject({ method: 'GET', url: '/api/egress-groups', headers: { cookie: viewer } });
  assert.equal(empty.statusCode, 200, empty.body);
  assert.deepEqual(empty.json().groups, [], 'no groups = [] (singletons excluded from the payload by design)');

  // Seed: group gapi with a RUNNING member + a PENDING member; one
  // binding-derived group (ip:…); one unlabelled singleton.
  const i1 = await db.identity.create({ data: { email: 'g1@e.com', username: 'g1', status: 'RUNNING', metadataJson: { egressGroup: 'gapi' } } });
  const i2 = await db.identity.create({ data: { email: 'g2@e.com', username: 'g2', status: 'READY', metadataJson: { egressGroup: 'gapi' } } });
  const i3 = await db.identity.create({ data: { email: 'g3@e.com', username: 'g3', status: 'READY' } });
  const i4 = await db.identity.create({ data: { email: 'g4@e.com', username: 'g4', status: 'READY' } });
  await db.identityEgress.create({ data: { identityId: i3.id, expectedEgressIp: '203.0.113.7', proxyUrlHash: 'h1' } });
  const batch = await db.batch.create({ data: { cycleId: 'c-eg-api', batchNo: 1, name: 'eg-api', status: 'RUNNING', configJson: {}, statsJson: {} } });
  await db.batchIdentity.create({ data: { batchId: batch.id, identityId: i1.id, position: 0, status: 'RUNNING' } });
  await db.batchIdentity.create({ data: { batchId: batch.id, identityId: i2.id, position: 1, status: 'PENDING' } });
  const run = await db.taskRun.create({ data: { identityId: i1.id, batchId: batch.id, status: 'running', attempt: 0, queuedAt: new Date(), startedAt: new Date() } });

  const res = await app.inject({ method: 'GET', url: '/api/egress-groups', headers: { cookie: viewer } });
  assert.equal(res.statusCode, 200, res.body);
  const groups = res.json().groups;
  const g = groups.find((x) => x.groupKey === 'grp:gapi');
  assert.ok(g, 'label group surfaced');
  assert.equal(g.activeRunId, run.id, 'active run (busy exit) surfaced');
  assert.equal(g.pendingMemberCount, 1, '待行數: the PENDING member counts');
  assert.deepEqual(g.jitterWindowMs, { minMs: 60_000, maxMs: 300_000 }, 'default stagger window reported');
  const gIp = groups.find((x) => x.groupKey === 'ip:203.0.113.7');
  assert.ok(gIp && gIp.memberIds.length === 1, 'binding-derived group (layer 2) surfaced');
  assert.ok(!groups.some((x) => x.groupKey.startsWith('identity:')), 'singleton stays silent (i4 not in the payload)');
  assert.ok(!JSON.stringify(res.json()).match(/password|proxyUrl"/i), 'secret-free payload');

  // Terminal → 下次放行估計 = finishedAt + deterministic draw.
  await db.taskRun.update({ where: { id: run.id }, data: { status: 'succeeded', finishedAt: new Date() } });
  const res2 = await app.inject({ method: 'GET', url: '/api/egress-groups', headers: { cookie: viewer } });
  const g2 = res2.json().groups.find((x) => x.groupKey === 'grp:gapi');
  assert.equal(g2.activeRunId, null);
  assert.equal(
    new Date(g2.nextEligibleAt).getTime(),
    new Date((await db.taskRun.findUnique({ where: { id: run.id } })).finishedAt).getTime() + deterministicJitterMs('grp:gapi', run.id, 60_000, 300_000),
    'next-eligible estimate = last terminal + draw',
  );

  // Zero-secret canary survives serialisation end-to-end.
  const body = await app.inject({ method: 'GET', url: '/api/egress-groups', headers: { cookie: viewer } });
  assert.equal(body.statusCode, 200);
  await app.close();
});

test('GET /api/egress-groups: W3 switch OFF → 503 EGRESS_BINDING_DISABLED (inert surface)', async () => {
  const { app } = await makeApp({ egressEnabled: false });
  const viewer = await login(app, 'viewer1');
  const res = await app.inject({ method: 'GET', url: '/api/egress-groups', headers: { cookie: viewer } });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, 'EGRESS_BINDING_DISABLED');
  await app.close();
});

test('PUT /api/egress-groups/jitter: admin-only, swap-normalised, feeds the scheduler window + status payload (W3-independent)', async () => {
  const { app, db } = await makeApp({ egressEnabled: false }); // W3 OFF on purpose: the jitter surface stands alone
  const viewer = await login(app, 'viewer1');
  const admin = await login(app, 'admin1');

  const denied = await app.inject({ method: 'PUT', url: '/api/egress-groups/jitter', headers: { cookie: viewer }, payload: { minMs: 5_000, maxMs: 9_000 } });
  assert.equal(denied.statusCode, 403, 'viewer cannot tune the stagger');

  // min>max typo → stored swapped (matches the scheduler read semantics).
  const put = await app.inject({ method: 'PUT', url: '/api/egress-groups/jitter', headers: { cookie: admin }, payload: { minMs: 9_000, maxMs: 5_000 } });
  assert.equal(put.statusCode, 200, put.body);
  assert.deepEqual(put.json().jitterWindowMs, { minMs: 5_000, maxMs: 9_000 });
  const row = await db.appSetting.findUnique({ where: { key: 'egress.group_jitter_ms' } });
  assert.deepEqual(row.valueJson, { value: { minMs: 5_000, maxMs: 9_000 } }, 'stored self-consistent');

  // The scheduler-side read follows the new window (module is the single
  // source — route writes, gate reads, no second spelling).
  const { readEgressGroupJitter } = await import('@water-army/shared');
  assert.deepEqual(await readEgressGroupJitter(db), { minMs: 5_000, maxMs: 9_000, source: 'appsetting' });

  // Schema bounds: 400 outside 0..3_600_000 / non-integer.
  const bad = await app.inject({ method: 'PUT', url: '/api/egress-groups/jitter', headers: { cookie: admin }, payload: { minMs: 0, maxMs: 4_000_000 } });
  assert.equal(bad.statusCode, 400);
  await app.close();
});
