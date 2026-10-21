/**
 * BR-B3 gen2 (S3) — batch container lifecycle ROUTES (MD Phase 3 item 4;
 * MD §10/§12/§13.2).
 *
 * Real HTTP path (app.inject) over the REAL app (buildApp) with the REAL
 * lifecycle service (S2) on a fake batch DB + an engine-faithful fake
 * docker client + real fs against a tmp data root + a canned ADB health
 * probe (the test seam gen1 added to buildApp). Hermetic, no live
 * redis/postgres/docker.
 *
 * Coverage:
 *   - RBAC matrix: anonymous 401 / viewer 403 / operator writes /
 *     admin+human purge / service-token (worker lane) operator surface —
 *     the worker NEVER has admin rights; purge + reconcile-fix are
 *     unreachable for it (MD §4.2/§12)
 *   - start contract: labelled + 127.0.0.1-bound + /data-mounted, DB
 *     bound, port leased, audited; 400 non-uuid runId; 404 unknown run
 *   - health: app-layer probe result, unbound/gone honesty
 *   - stop: reversible (container stays, volume stays, lease released,
 *     audited); idempotent
 *   - remove: container gone, volume KEPT, audited; idempotent no-op
 *   - purge: admin+human only; in-use guard 409; dry-run preview changes
 *     NOTHING; confirm must equal the identity id; the real wipe removes
 *     containers + data + audits; 404 unknown identity
 *   - reconcile: ok/orphan/stale_running/mismatch classification;
 *     fix=false never acts; fix=true admin-only; fix stops+removes the
 *     orphan and stops the stale — and NEVER creates anything
 *     (no double-start, MD Phase 3 item 5)
 *   - error envelope {error:{code,message,requestId}} on every failure
 *   - per-actor write budget: 21st start → 429 + retry-after (MD §13.2)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import argon2 from '@node-rs/argon2';

import {
  APP_SETTING_BATCH_CONTAINER_IMAGE_ALLOWLIST,
  CONTAINER_LABELS,
  buildContainerLabels,
  SERVICE_USER_ID,
} from '@water-army/shared';

import { buildApp } from '../../apps/api/src/app.js';
import { makeFakeDb, testConfig, fakeRedisOk, makeFakeQueue } from '../helpers/fakes.js';
import { makeBatchFakeDb } from '../helpers/batch-fakes.js';
import { makeFakeDockerWrapper } from '../helpers/fake-docker-client.js';

const { argon2id, hash } = argon2;
const PASSWORD = 'TestPass123';
const SERVICE_TOKEN = 'test-service-token-0123456789abcdef0123456789';
const IMG = 'water-army/redroid:14.0.0-240527-matrixa-r3';

const uid = (n) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}`;
const ID1 = uid(1);
const ID2 = uid(2);
const BATCH1 = uid(11);
const RUN1 = uid(21); // ID1 — the happy-path run
const RUN2 = uid(22); // ID2 — stays active (purge in-use guard)
const RUN_STALE = uid(23); // ID2 — run row whose lease expired (worker crash)
const RUN_ORPHAN = uid(24); // label points at a run row that no longer exists

const NOW = new Date();
const FUTURE = new Date(NOW.getTime() + 3_600_000);
const PAST = new Date(NOW.getTime() - 3_600_000);

const B3_CONFIG = {
  batchContainerAllowedImages: [],
  batchAdbHostPortRange: '16370-16419',
  batchPortLeaseTtlMs: 3_600_000,
  batchContainerStopTimeoutSec: 1,
  batchContainerNamePrefix: 'br-b3-',
  batchContainerHealthTimeoutMs: 2_000,
  batchContainerHealthPollMs: 10,
  batchContainerHealthProbeTimeoutMs: 1_000,
};

async function makeApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-br3-routes-'));
  const dataPath = (id) => path.join(root, id, 'data');
  const identities = [
    { id: ID1, externalRef: 'acct-01', displayName: 'Acc 01', identityType: 'ACCOUNT', status: 'RUNNING', dataPath: dataPath(ID1) },
    { id: ID2, externalRef: 'acct-02', displayName: 'Acc 02', identityType: 'ACCOUNT', status: 'RUNNING', dataPath: dataPath(ID2) },
  ];
  const batches = [
    {
      id: BATCH1, name: 'br-b3 routes batch', cycleId: 'cycle-r1', batchNo: 1,
      status: 'RUNNING', batchSize: 2, maxActiveContainers: 2, failurePolicy: 'CONTINUE',
      configJson: { adapter: { type: 'container', image: IMG } }, idempotencyKey: 'ik-r1',
    },
  ];
  const taskRuns = [
    {
      id: RUN1, taskType: 'batch', batchId: BATCH1, identityId: ID1, status: 'running',
      attempt: 1, maxAttempts: 3, leaseExpiresAt: FUTURE, createdAt: NOW,
      inputJson: { taskType: 'batch', adapter: { type: 'container', image: IMG } },
    },
    {
      id: RUN2, taskType: 'batch', batchId: BATCH1, identityId: ID2, status: 'running',
      attempt: 1, maxAttempts: 3, leaseExpiresAt: FUTURE, createdAt: NOW,
      inputJson: { taskType: 'batch', adapter: { type: 'container', image: IMG } },
    },
    {
      id: RUN_STALE, taskType: 'batch', batchId: BATCH1, identityId: ID2, status: 'running',
      attempt: 1, maxAttempts: 3, leaseExpiresAt: PAST, createdAt: NOW,
      inputJson: { taskType: 'batch', adapter: { type: 'container', image: IMG } },
    },
  ];
  const passwordHash = await hash(PASSWORD, { type: argon2id });
  const users = [
    { id: 'u-admin', username: 'admin1', passwordHash, role: 'admin' },
    { id: 'u-op', username: 'operator1', passwordHash, role: 'operator' },
    { id: 'u-view', username: 'viewer1', passwordHash, role: 'viewer' },
  ];
  const db = {
    ...makeFakeDb({ users }),
    ...makeBatchFakeDb({ identities, batches, taskRuns }),
  };
  db.__state.appSettings.set(APP_SETTING_BATCH_CONTAINER_IMAGE_ALLOWLIST, {
    key: APP_SETTING_BATCH_CONTAINER_IMAGE_ALLOWLIST,
    valueJson: [IMG],
    updatedBy: 'test',
    createdAt: NOW,
    updatedAt: NOW,
  });
  const config = {
    ...testConfig,
    serviceToken: SERVICE_TOKEN,
    taskDefaultTimeoutMs: 60_000,
    taskMaxTimeoutMs: 600_000,
    taskDefaultAttempts: 2,
    ...B3_CONFIG,
    batchContainerDataRoot: root,
  };
  // Canned app-layer probe: the handshake "answers" — the route tests are
  // about RBAC/contract/audit, not the wire protocol (unit-tested in S1/S2).
  const app = await buildApp({
    config,
    db,
    redis: fakeRedisOk(),
    docker: makeFakeDockerWrapper(),
    taskQueue: makeFakeQueue(),
    batchLifecycleHealthProbe: async () => ({ healthy: true, detail: null, version: 'br3-test-probe' }),
  });
  return { app, db, root, dataPath };
}

async function login(app, username, password = PASSWORD) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  assert.equal(res.statusCode, 200, `login should succeed: ${res.body}`);
  return res.headers['set-cookie'].split(';')[0];
}

const body = (res) => JSON.parse(res.body);

/** Every non-2xx must ride the centralized envelope (MD §10). */
function assertEnvelope(res, expectStatus, expectCode) {
  const b = body(res);
  assert.ok(b.error, `expected error envelope, got: ${res.body}`);
  assert.equal(typeof b.error.code, 'string', 'error.code missing');
  assert.equal(typeof b.error.message, 'string', 'error.message missing');
  assert.ok(b.error.requestId, 'error.requestId missing');
  if (expectStatus) assert.equal(res.statusCode, expectStatus, `status ${res.statusCode} != ${expectStatus} (${res.body})`);
  if (expectCode) assert.equal(b.error.code, expectCode, `code ${b.error.code} != ${expectCode}`);
}

test('BR-B3 gen2 S3 — container lifecycle routes over the real HTTP path', async (t) => {
  const { app, db, root, dataPath } = await makeApp();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    return app.close();
  });
  const op = await login(app, 'operator1');
  const view = await login(app, 'viewer1');
  const admin = await login(app, 'admin1');
  const docker = app.docker.client;

  const req = (method, url, { cookie, token, payload } = {}) =>
    app.inject({
      method,
      url,
      payload: payload === undefined ? undefined : JSON.stringify(payload),
      headers: {
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
        ...(token ? { 'x-wa-service-token': token } : {}),
      },
    });

  let startedContainerId = null;

  // ---------------------------------------------------------- RBAC matrix
  await t.test('RBAC: anon 401, viewer 403, operator writes, admin+human purge', async () => {
    // anonymous — every route
    assertEnvelope(await req('GET', '/api/batch-containers'), 401, 'UNAUTHORIZED');
    assertEnvelope(await req('GET', `/api/task-runs/${RUN1}/containers/health`), 401);
    assertEnvelope(await req('POST', `/api/task-runs/${RUN1}/containers/start`), 401);
    assertEnvelope(await req('POST', `/api/task-runs/${RUN1}/containers/stop`), 401);
    assertEnvelope(await req('POST', `/api/task-runs/${RUN1}/containers/remove`), 401);
    assertEnvelope(await req('POST', '/api/batch-containers/reconcile', { payload: {} }), 401);
    assertEnvelope(await req('POST', `/api/identities/${ID1}/purge`, { payload: { dryRun: true } }), 401);

    // viewer — read of the container surface is operator-gated too (least
    // privilege; the B5/B6 monitors run on operator+ sessions)
    assertEnvelope(await req('GET', '/api/batch-containers', { cookie: view }), 403, 'FORBIDDEN');
    assertEnvelope(await req('GET', `/api/task-runs/${RUN1}/containers/health`, { cookie: view }), 403);
    assertEnvelope(await req('POST', `/api/task-runs/${RUN1}/containers/start`, { cookie: view }), 403);
    assertEnvelope(await req('POST', `/api/task-runs/${RUN1}/containers/stop`, { cookie: view }), 403);
    assertEnvelope(await req('POST', '/api/batch-containers/reconcile', { cookie: view, payload: {} }), 403);
    assertEnvelope(await req('POST', `/api/identities/${ID1}/purge`, { cookie: view, payload: { dryRun: true } }), 403);

    // operator — the whole worker surface is reachable; purge is not
    assert.equal((await req('GET', '/api/batch-containers', { cookie: op })).statusCode, 200);
    assertEnvelope(await req('POST', `/api/identities/${ID1}/purge`, { cookie: op, payload: { dryRun: true } }), 403, 'FORBIDDEN', 'operator cannot purge (admin+human)');

    // service token = operator identity: the worker lane works, and the
    // admin+human gates stay closed (MD §4.2/§12)
    assert.equal((await req('GET', '/api/batch-containers', { token: SERVICE_TOKEN })).statusCode, 200);
    assertEnvelope(await req('POST', '/api/batch-containers/reconcile', { token: SERVICE_TOKEN, payload: { fix: true } }), 403, 'FORBIDDEN', 'service identity cannot reconcile-fix');
    assertEnvelope(await req('POST', `/api/identities/${ID1}/purge`, { token: SERVICE_TOKEN, payload: { dryRun: true } }), 403, 'FORBIDDEN', 'service identity cannot purge');
    // a wrong token is not "an anonymous visitor with a header" — 401
    assertEnvelope(await req('GET', '/api/batch-containers', { token: 'wrong-token-0123456789abcdef0123456789' }), 401, 'UNAUTHORIZED');
  });

  // --------------------------------------------------------------- start
  await t.test('start: contract (labels, 127.0.0.1 bind, /data mount, DB bind, lease, audit)', async () => {
    const res = await req('POST', `/api/task-runs/${RUN1}/containers/start`, { cookie: op, payload: {} });
    assert.equal(res.statusCode, 200, res.body);
    const b = body(res);
    assert.ok(b.containerId, 'container id returned');
    assert.equal(b.hostPort, 16370, 'first free port of the pool');
    assert.ok(String(b.name).startsWith('br-b3-'), 'name prefix from config');
    assert.equal(b.healthy, true, 'canned probe healthy');
    assert.equal(b.adopted, false, 'fresh create, not an adoption');
    startedContainerId = b.containerId;

    // the container itself: labels (ownership half), 127.0.0.1-only port, /data volume
    const info = await docker.getContainer(b.containerId).inspect();
    const L = info.Config.Labels;
    assert.equal(L[CONTAINER_LABELS.MANAGED], 'true');
    assert.equal(L[CONTAINER_LABELS.IDENTITY_ID], ID1);
    assert.equal(L[CONTAINER_LABELS.BATCH_ID], BATCH1);
    assert.equal(L[CONTAINER_LABELS.TASK_RUN_ID], RUN1);
    assert.equal(L[CONTAINER_LABELS.CREATED_BY], 'operator1', 'provenance = authenticated actor');
    assert.deepEqual(info.HostConfig.PortBindings['5555/tcp'], [{ HostIp: '127.0.0.1', HostPort: '16370' }], 'ADB bound to loopback only');
    const mount = info.Mounts.find((m) => m.Destination === '/data');
    assert.ok(mount, '/data mount present');
    assert.equal(mount.Source, dataPath(ID1), 'the identity data dir');
    assert.equal(mount.RW, true);

    // DB half of the double check + the port lease
    const run = await db.taskRun.findUnique({ where: { id: RUN1 } });
    assert.equal(run.containerId, b.containerId, 'DB bind landed');
    const lease = await db.resourceLease.findUnique({ where: { resourceType_resourceKey: { resourceType: 'port', resourceKey: 'port:16370' } } });
    assert.ok(lease, 'port lease held');
    assert.equal(lease.ownerRunId, RUN1);

    // audit (MD Phase 3: 每個操作落 audit)
    const audits = await db.auditEvent.findMany({ where: { action: 'batch_container.started' } });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].status, 'ok');
    assert.equal(audits[0].resourceId, b.containerId);

    // the list endpoint sees it with lineage + port + lease liveness
    const list = body(await req('GET', '/api/batch-containers', { cookie: op }));
    assert.equal(list.count, 1);
    assert.equal(list.containers[0].runId, RUN1);
    assert.equal(list.containers[0].identityId, ID1);
    assert.equal(list.containers[0].leaseAlive, true);
    assert.equal(list.containers[0].hostPorts['5555/tcp'], 16370);

    // validation: non-uuid runId → 400 (house style, B2 parity); unknown
    // uuid → 404 RUN_NOT_FOUND (envelope, not a 500)
    assertEnvelope(await req('POST', '/api/task-runs/not-a-uuid/containers/start', { cookie: op, payload: {} }), 400, 'VALIDATION_ERROR');
    assertEnvelope(await req('POST', `/api/task-runs/${uid(99)}/containers/start`, { cookie: op, payload: {} }), 404, 'RUN_NOT_FOUND');
  });

  // -------------------------------------------------------------- health
  await t.test('health: app-layer probe result + honest unbound state', async () => {
    const res = await req('GET', `/api/task-runs/${RUN1}/containers/health`, { cookie: op });
    assert.equal(res.statusCode, 200, res.body);
    const b = body(res);
    assert.equal(b.healthy, true, 'canned ADB handshake answered');
    assert.equal(b.state, 'running');
    assert.equal(b.version, 'br3-test-probe', 'the probe version is surfaced');
    assert.equal(b.hostPort, 16370);

    // RUN2 never started: honest 'unbound' (never claims healthy)
    const un = body(await req('GET', `/api/task-runs/${RUN2}/containers/health`, { cookie: op }));
    assert.equal(un.healthy, false);
    assert.equal(un.state, 'unbound');

    assertEnvelope(await req('GET', `/api/task-runs/${uid(98)}/containers/health`, { cookie: op }), 404, 'RUN_NOT_FOUND');
  });

  // ---------------------------------------------------------- stop (keep)
  await t.test('stop: reversible — container exits, VOLUME + data stay, lease released, audited', async () => {
    const marker = path.join(dataPath(ID1), 'survivor.json');
    fs.writeFileSync(marker, JSON.stringify({ identity: ID1, note: 'must survive stop+remove' }));

    const res = await req('POST', `/api/task-runs/${RUN1}/containers/stop`, { cookie: op, payload: {} });
    assert.equal(res.statusCode, 200, res.body);
    const b = body(res);
    assert.equal(b.stopped, true);
    assert.equal(b.wasRunning, true);
    assert.equal(b.volumeRetained, true, 'stop must promise volume retention');

    const info = await docker.getContainer(startedContainerId).inspect();
    assert.equal(info.State.Status, 'exited', 'container stopped, NOT removed');
    assert.ok(fs.existsSync(marker), 'identity data intact after stop');

    // the port lease is released (MD §8.3 step 7)
    const lease = await db.resourceLease.findUnique({ where: { resourceType_resourceKey: { resourceType: 'port', resourceKey: 'port:16370' } } });
    assert.equal(lease, null, 'port lease released on stop');

    const audits = await db.auditEvent.findMany({ where: { action: 'batch_container.stopped' } });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].detailsJson.volumeRetained, true);
    assert.equal(audits[0].detailsJson.by, 'operator1');

    // idempotent: stopping again is an honest no-op (not an error)
    const again = body(await req('POST', `/api/task-runs/${RUN1}/containers/stop`, { cookie: op, payload: {} }));
    assert.equal(again.stopped, true);
    assert.equal(again.wasRunning, false);
  });

  // --------------------------------------------------------- remove (keep)
  await t.test('remove: container gone, VOLUME KEPT, audited; idempotent no-op', async () => {
    const marker = path.join(dataPath(ID1), 'survivor.json');
    const res = await req('POST', `/api/task-runs/${RUN1}/containers/remove`, { cookie: op, payload: {} });
    assert.equal(res.statusCode, 200, res.body);
    const b = body(res);
    assert.equal(b.removed, true);
    assert.equal(b.volumeRetained, true, 'remove keeps the volume (only purge may wipe)');
    assert.equal(b.dataPath, dataPath(ID1));

    await assert.rejects(
      docker.getContainer(startedContainerId).inspect(),
      /No such container/,
      'the container is actually gone from docker',
    );
    assert.ok(fs.existsSync(marker), 'identity data STILL intact after remove');

    const audits = await db.auditEvent.findMany({ where: { action: 'batch_container.removed' } });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].detailsJson.volumeRetained, true);

    // idempotent: no container left → honest no-op, no 500
    const again = await req('POST', `/api/task-runs/${RUN1}/containers/remove`, { cookie: op, payload: {} });
    assert.equal(again.statusCode, 200);
    assert.equal(body(again).removed, false);

    // health now reports the recorded container as gone (not healthy)
    const h = body(await req('GET', `/api/task-runs/${RUN1}/containers/health`, { cookie: op }));
    assert.equal(h.healthy, false);
    assert.equal(h.state, 'gone');
  });

  // --------------------------------------------------------------- purge
  await t.test('purge: the only data-wipe path (admin+human, dry-run, confirm, in-use guard)', async () => {
    // Simulate the engine having terminalized RUN1 (the real flow does this
    // before any human considers a purge) so ID1 is purgable…
    await db.taskRun.update({ where: { id: RUN1 }, data: { status: 'succeeded' } });
    // …while ID2's RUN2 is still active → the in-use guard must fire first.
    const inUse = await req('POST', `/api/identities/${ID2}/purge`, { cookie: admin, payload: { dryRun: true } });
    assertEnvelope(inUse, 409, 'RUN_STATE_INVALID', 'an identity with an active run cannot be purged');

    // dry-run: a full preview, and NOTHING changes (MD Phase 3: dry-run 預覽)
    const marker = path.join(dataPath(ID1), 'survivor.json');
    const dry = await req('POST', `/api/identities/${ID1}/purge`, { cookie: admin, payload: { dryRun: true } });
    assert.equal(dry.statusCode, 200, dry.body);
    const db2 = body(dry);
    assert.equal(db2.dryRun, true);
    assert.equal(db2.dataExists, true);
    assert.equal(db2.dataInsideRoot, true);
    assert.equal(db2.fileCount, 1, 'the marker file is counted');
    assert.ok(db2.sizeBytes > 0);
    assert.deepEqual(db2.containers, [], 'no live container left for ID1 (removed above)');
    assert.match(db2.willDo, /rm -rf/);
    assert.ok(fs.existsSync(marker), 'dry-run must not touch the data');

    // confirm contract: confirm must EQUAL the identity id (typo-proof)
    const wrong = await req('POST', `/api/identities/${ID1}/purge`, { cookie: admin, payload: { confirm: 'not-the-identity-id' } });
    assertEnvelope(wrong, 400, 'PURGE_CONFIRM_REQUIRED');
    const noConfirm = await req('POST', `/api/identities/${ID1}/purge`, { cookie: admin, payload: {} });
    assertEnvelope(noConfirm, 400, 'PURGE_CONFIRM_REQUIRED');
    assert.ok(fs.existsSync(marker), 'a refused purge leaves everything untouched');

    // the real wipe
    const real = await req('POST', `/api/identities/${ID1}/purge`, { cookie: admin, payload: { confirm: ID1 } });
    assert.equal(real.statusCode, 200, real.body);
    const rb = body(real);
    assert.equal(rb.dryRun, false);
    assert.equal(rb.removed, true);
    assert.equal(rb.fileCount, 1);
    assert.ok(!fs.existsSync(marker), 'the data dir is gone');
    assert.ok(!fs.existsSync(dataPath(ID1)), 'the identity data dir itself is removed');

    const audits = await db.auditEvent.findMany({ where: { action: 'batch_identity.purged' } });
    assert.equal(audits.length, 1, 'the wipe is audited (actor + what was removed)');
    assert.equal(audits[0].actorUserId, 'u-admin', 'the HUMAN actor is on the audit row');
    assert.equal(audits[0].status, 'ok');

    // hygiene: unknown identity 404, malformed id 400
    assertEnvelope(await req('POST', `/api/identities/${uid(77)}/purge`, { cookie: admin, payload: { dryRun: true } }), 404, 'IDENTITY_INVALID');
    assertEnvelope(await req('POST', '/api/identities/not-a-uuid/purge', { cookie: admin, payload: { dryRun: true } }), 400, 'VALIDATION_ERROR');
  });

  // ----------------------------------------------------------- reconcile
  await t.test('reconcile: classify ok/orphan/stale/mismatch; fix=admin only; NEVER starts', async () => {
    // Seed the four divergent containers dynamically (mid-test fixtures):
    //   terminal-orphan — run row TERMINAL, container still running (S2
    //                      definition of orphan; fix = stopped+removed)
    //   missing-run     — label points at a run row that no longer exists:
    //                      classified orphan, but the fix is REFUSED
    //                      (fail-closed — ownership cannot be re-proven;
    //                      audited as batch_reconcile.fix_refused, human
    //                      investigates; the container is never touched)
    //   stale           — run row exists but its execution lease expired (worker crash)
    //   mismatch— label disagrees with the run row (identity drift)
    const RUN_ORPHAN_T = uid(31); // terminal run whose container outlived it
    await db.taskRun.create({
      data: {
        id: RUN_ORPHAN_T, taskType: 'batch', batchId: BATCH1, identityId: ID1, status: 'succeeded',
        attempt: 1, maxAttempts: 3, leaseExpiresAt: null, createdAt: NOW,
        inputJson: { taskType: 'batch', adapter: { type: 'container', image: IMG } },
      },
    });
    const orphanTId = docker.__register({
      name: 'br-b3-orphan-t', state: 'running',
      labels: buildContainerLabels({ identityId: ID1, batchId: BATCH1, taskRunId: RUN_ORPHAN_T, createdBy: 'test' }),
    });
    await db.taskRun.update({ where: { id: RUN_ORPHAN_T }, data: { containerId: orphanTId } });
    const orphanId = docker.__register({
      name: 'br-b3-orphan-missing', state: 'running',
      labels: buildContainerLabels({ identityId: ID1, batchId: BATCH1, taskRunId: RUN_ORPHAN, createdBy: 'test' }),
    });
    const staleId = docker.__register({
      name: 'br-b3-stale', state: 'running',
      labels: buildContainerLabels({ identityId: ID2, batchId: BATCH1, taskRunId: RUN_STALE, createdBy: 'test' }),
    });
    const mismatchId = docker.__register({
      name: 'br-b3-mismatch', state: 'running',
      labels: {
        ...buildContainerLabels({ identityId: ID1, batchId: BATCH1, taskRunId: RUN2, createdBy: 'test' }),
        [CONTAINER_LABELS.IDENTITY_ID]: ID1, // run RUN2 belongs to ID2 — drift
      },
    });

    // classify-only (operator): nothing is touched
    const scan = await req('POST', '/api/batch-containers/reconcile', { cookie: op, payload: {} });
    assert.equal(scan.statusCode, 200, scan.body);
    const sb = body(scan);
    assert.equal(sb.scanned, 4);
    assert.equal(sb.counts.orphan, 2, 'terminal-run orphan + missing-row orphan');
    assert.equal(sb.counts.stale_running, 1);
    assert.equal(sb.counts.mismatch, 1);
    assert.ok(sb.items.every((i) => i.fixed === false), 'fix=false never acts');
    const ms = sb.items.find((i) => i.runId === RUN2);
    assert.equal(ms.state, 'mismatch', 'label/DB drift is classified, never fixable');
    assert.equal(ms.fixable, false);

    // fix=true is admin+human only (operator AND the service token are refused)
    assertEnvelope(await req('POST', '/api/batch-containers/reconcile', { cookie: op, payload: { fix: true } }), 403, 'FORBIDDEN');
    assertEnvelope(await req('POST', '/api/batch-containers/reconcile', { token: SERVICE_TOKEN, payload: { fix: true } }), 403, 'FORBIDDEN');

    // admin fix: terminal-orphan stopped+removed, stale stopped (kept —
    // re-dispatch owns the re-run), missing-row REFUSED (fail-closed),
    // mismatch REFUSED — and NO container is created by a reconcile.
    const callsBefore = docker.__calls.filter((c) => c.method === 'createContainer').length;
    const fix = await req('POST', '/api/batch-containers/reconcile', { cookie: admin, payload: { fix: true } });
    assert.equal(fix.statusCode, 200, fix.body);
    const fb = body(fix);
    assert.equal(fb.scanned, 4);
    const fOrT = fb.items.find((i) => i.runId === RUN_ORPHAN_T);
    assert.equal(fOrT.fixed, true, 'terminal-run orphan is fixed');
    assert.equal(fOrT.fixedDetail, 'stopped+removed');
    const fOrM = fb.items.find((i) => i.runId === RUN_ORPHAN);
    assert.equal(fOrM.fixed, false, 'a missing run row can never be re-verified → fail-closed refusal');
    assert.equal(fOrM.state, 'mismatch', 're-graded at fix time (TOCTOU)');
    assert.match(fOrM.reason, /re-check at fix time/);
    const fSt = fb.items.find((i) => i.runId === RUN_STALE);
    assert.equal(fSt.fixed, true);
    assert.equal(fSt.fixedDetail, 'stopped', 'stale is stopped, not removed');
    const fMs = fb.items.find((i) => i.runId === RUN2);
    assert.equal(fMs.fixed, false, 'a mismatch is never auto-fixed');

    const callsAfter = docker.__calls.filter((c) => c.method === 'createContainer').length;
    assert.equal(callsAfter, callsBefore, 'reconcile never creates a container (no double-start)');

    // docker state afterwards: terminal-orphan gone, missing-row + mismatch
    // STILL running (a refusal must never touch the container), stale exited
    await assert.rejects(docker.getContainer(orphanTId).inspect(), /No such container/);
    assert.equal((await docker.getContainer(orphanId).inspect()).State.Status, 'running', 'refused fix leaves the container untouched');
    assert.equal((await docker.getContainer(staleId).inspect()).State.Status, 'exited');
    assert.equal((await docker.getContainer(mismatchId).inspect()).State.Status, 'running');

    // audit: the scan, each fix AND the refusal are recorded
    const scans = await db.auditEvent.findMany({ where: { action: 'batch_reconcile.scanned' } });
    assert.ok(scans.length >= 2, 'every reconcile scan is audited');
    const fixes = await db.auditEvent.findMany({ where: { action: 'batch_reconcile.fixed' } });
    assert.equal(fixes.length, 2, 'terminal-orphan + stale fixes audited');
    assert.ok(fixes.every((f) => f.actorUserId === 'u-admin'), 'the human admin is the fix actor');
    const refusals = await db.auditEvent.findMany({ where: { action: 'batch_reconcile.fix_refused' } });
    assert.equal(refusals.length, 1, 'the missing-row refusal is audited for the human');
    assert.equal(refusals[0].status, 'refused');
  });

  // ------------------------------------------------------- error envelope
  await t.test('envelope: every failure carries {code, message, requestId}', async () => {
    const cases = [
      await req('POST', `/api/task-runs/${uid(66)}/containers/stop`, { cookie: op, payload: {} }), // 404
      await req('POST', '/api/batch-containers/reconcile', { cookie: op, payload: { fix: 'yes' } }), // 400
    ];
    for (const res of cases) {
      assert.ok(res.statusCode >= 400, `expected failure, got ${res.statusCode}`);
      const b = body(res);
      assert.ok(b.error && typeof b.error.code === 'string' && b.error.requestId, `bad envelope: ${res.body}`);
    }
  });
});

test('BR-B3 gen2 S3 — per-actor write budget: 21st start → 429 + retry-after (MD §13.2)', async (t) => {
  const { app, db, root } = await makeApp();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    return app.close();
  });
  const op = await login(app, 'operator1');

  const req = (method, url, opts = {}) =>
    app.inject({
      method,
      url,
      payload: opts.payload === undefined ? undefined : JSON.stringify(opts.payload),
      headers: opts.payload === undefined ? { cookie: op } : { cookie: op, 'content-type': 'application/json' },
    });

  let last;
  for (let i = 0; i < 20; i += 1) {
    last = await req('POST', `/api/task-runs/${RUN1}/containers/start`, { payload: {} });
    // first create, then adoptions of the same container — all 200
    assert.equal(last.statusCode, 200, `start #${i + 1} should pass: ${last.body}`);
  }
  last = await req('POST', `/api/task-runs/${RUN1}/containers/start`, { payload: {} });
  assertEnvelope(last, 429, 'RATE_LIMITED');
  assert.ok(parseInt(last.headers['retry-after'], 10) >= 1, 'retry-after present');

  // adoption evidence: the 20 starts produced exactly ONE container (the
  // crash-window adoption path, not 20 containers — no double-start)
  const rows = db.__state.taskRuns.filter((r) => r.id === RUN1);
  assert.equal(rows.length, 1);
  const docker = app.docker.client;
  const created = docker.__calls.filter((c) => c.method === 'createContainer').length;
  assert.equal(created, 1, 'repeated starts adopt, never re-create');

  // a different actor keeps its own budget (per-actor, MD §13.2)
  const admin = await login(app, 'admin1');
  const other = await app.inject({ method: 'POST', url: `/api/task-runs/${RUN2}/containers/start`, payload: JSON.stringify({}), headers: { cookie: admin, 'content-type': 'application/json' } });
  assert.equal(other.statusCode, 200, `a different actor is not throttled: ${other.body}`);
});
