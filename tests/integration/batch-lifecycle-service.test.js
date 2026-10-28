/**
 * BR-B3 — batch container lifecycle service (MD Phase 3 items 1–5).
 *
 * Hermetic: fake batch DB (B1 rows), fake docker client (engine-faithful
 * state machine + call log), REAL lease service over the fake DB, real fs
 * against a tmp data root (symlink escapes are REAL symlinks), injectable
 * ADB health probe. The one place wall clock enters is the boot-health
 * wait, which is driven with a 10ms poll.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

import {
  APP_SETTING_BATCH_CONTAINER_IMAGE_ALLOWLIST,
  CONTAINER_LABELS,
  buildContainerLabels,
  createLeaseService,
  DOCKER_ERROR,
  buildAdbCnxnPacket,
  parseAdbPacket,
  A_CNXN,
  A_AUTH,
  A_STLS,
  adbMagic,
} from '@water-army/shared';

import { createBatchLifecycleService } from '../../apps/api/src/services/batch-lifecycle-service.js';
import { makeBatchFakeDb } from '../helpers/batch-fakes.js';
import { makeFakeDockerWrapper } from '../helpers/fake-docker-client.js';

// ---------------------------------------------------------------- fixtures
const uid = (n) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}`;
const ID1 = uid(1);
const ID2 = uid(2);
const BATCH1 = uid(11);
const RUN1 = uid(21);
const RUN2 = uid(22);
const IMG = 'water-army/redroid:14.0.0-240527-matrixa-r3';
const NOW = new Date('2026-10-21T12:00:00Z');
const LATER = new Date(NOW.getTime() + 3_600_000);
const ROOTS = []; // every per-env tmp root — cleaned in test.after

/**
 * Per-env fixture: a FRESH tmp data root per test so identity data dirs
 * never accumulate across tests (purge size assertions are exact).
 */
function makeFixtureRoot() {
  const envRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-br3-lifecycle-'));
  ROOTS.push(envRoot);
  const envDataPath = (id) => path.join(envRoot, id, 'data');
  const envIdentities = [
    { id: ID1, externalRef: 'acct-01', displayName: 'Acc 01', identityType: 'ACCOUNT', status: 'READY', dataPath: envDataPath(ID1) },
    { id: ID2, externalRef: 'acct-02', displayName: 'Acc 02', identityType: 'ACCOUNT', status: 'READY', dataPath: envDataPath(ID2) },
  ];
  return { root: envRoot, dataPath: envDataPath, identities: envIdentities };
}

/**
 * Advancing virtual clock: starts exactly at NOW (seeded lease-expiry
 * comparisons stay deterministic) but ticks at real-time speed (time-based
 * deadlines like the boot-health wait actually elapse).
 */
function makeAdvancingClock(base = NOW) {
  const t0 = Date.now();
  const baseMs = base.getTime();
  return () => new Date(baseMs + (Date.now() - t0));
}

function runRow(over = {}) {
  return {
    id: RUN1,
    batchId: BATCH1,
    identityId: ID1,
    status: 'running',
    attempt: 1,
    maxAttempts: 3,
    leaseExpiresAt: LATER,
    createdAt: NOW,
    ...over,
  };
}

const BATCHES = [
  {
    id: BATCH1,
    name: 'br-b3 batch',
    cycleId: 'cycle-1',
    batchNo: 1,
    status: 'RUNNING',
    batchSize: 1,
    maxActiveContainers: 1,
    failurePolicy: 'CONTINUE',
    configJson: { adapter: { type: 'container', image: IMG } },
    idempotencyKey: 'ik-b1',
  },
];

function healthyProbe() {
  return async () => ({ healthy: true, detail: null, version: '0.0.1' });
}
function sickProbe() {
  return async () => ({ healthy: false, detail: 'no handshake', version: null });
}

function makeEnv(opts = {}) {
  const {
    dockerOpts = {},
    probe = healthyProbe(),
    allowlist = [IMG],
    portRange = '16370-16419',
    healthTimeoutMs = 2_000,
    healthPollMs = 10,
    identities,
    fixture,
    batches = BATCHES,
    taskRuns = [runRow()],
    leases = [],
    containerSeeds = [],
  } = opts;
  const fx = fixture ?? makeFixtureRoot();
  const db = makeBatchFakeDb({
    identities: identities ?? fx.identities,
    batches,
    taskRuns,
    leases,
  });
  if (allowlist.length > 0) {
    // the fake doesn't seed appSettings — set the row directly (same shape)
    db.__state.appSettings.set(APP_SETTING_BATCH_CONTAINER_IMAGE_ALLOWLIST, {
      key: APP_SETTING_BATCH_CONTAINER_IMAGE_ALLOWLIST,
      valueJson: allowlist,
      updatedBy: 'test',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  const clock = makeAdvancingClock();
  const docker = makeFakeDockerWrapper({ ...dockerOpts, containers: containerSeeds });
  const lease = createLeaseService({ db, now: clock });
  const audits = [];
  const config = {
    batchContainerDataRoot: fx.root,
    batchContainerAllowedImages: [],
    batchAdbHostPortRange: portRange,
    batchPortLeaseTtlMs: 3_600_000,
    batchContainerStopTimeoutSec: 1,
    batchContainerNamePrefix: 'br-b3-',
    batchContainerHealthTimeoutMs: healthTimeoutMs,
    batchContainerHealthPollMs: healthPollMs,
    batchContainerHealthProbeTimeoutMs: 1_000,
  };
  const svc = createBatchLifecycleService({
    db,
    docker,
    config,
    lease,
    audit: async (e) => { audits.push(e); },
    log: { info() {}, warn() {}, error() {} },
    clock,
    healthProbe: probe,
  });
  return { db, docker, svc, audits, lease, clock, root: fx.root, dataPath: fx.dataPath, identities: identities ?? fx.identities };
}


// ---------------------------------------------------------------- 1. happy path
test('start: creates a labelled, port-leased, volume-mounted container and binds the DB', async () => {
  const env = makeEnv();
  const res = await env.svc.startForRun(RUN1, { label: 'worker-1' });

  assert.ok(res.containerId);
  assert.equal(res.healthy, true);
  assert.equal(res.hostPort, 16370, 'first free port of the pool');

  // labels — the ownership half on the container side
  const info = await env.docker.client.getContainer(res.containerId).inspect();
  const L = info.Config.Labels;
  assert.equal(L[CONTAINER_LABELS.MANAGED], 'true');
  assert.equal(L[CONTAINER_LABELS.IDENTITY_ID], ID1);
  assert.equal(L[CONTAINER_LABELS.BATCH_ID], BATCH1);
  assert.equal(L[CONTAINER_LABELS.TASK_RUN_ID], RUN1);
  assert.equal(L[CONTAINER_LABELS.CREATED_BY], 'worker-1');
  assert.equal(info.Config.Image, IMG);

  // network — 127.0.0.1-only binding on the leased port
  const bind = info.HostConfig.PortBindings['5555/tcp'];
  assert.deepEqual(bind, [{ HostIp: '127.0.0.1', HostPort: '16370' }]);

  // volume — the identity data dir, resolved + inside the root
  const mount = info.Mounts.find((m) => m.Destination === '/data');
  assert.ok(mount, 'a /data bind mount exists');
  assert.equal(mount.Source, env.dataPath(ID1));
  assert.equal(mount.RW, true);
  assert.ok(fs.statSync(env.dataPath(ID1)).isDirectory(), 'data dir created on demand');

  // DB half of the double check
  const run = await env.db.taskRun.findUnique({ where: { id: RUN1 } });
  assert.equal(run.containerId, res.containerId);

  // port lease exists, owned by the run
  const leaseRow = await env.db.resourceLease.findUnique({ where: { resourceType_resourceKey: { resourceType: 'port', resourceKey: 'port:16370' } } });
  assert.ok(leaseRow, 'port lease acquired');
  assert.equal(leaseRow.ownerRunId, RUN1);

  // audit trail
  assert.ok(env.audits.some((a) => a.action === 'batch_container.started' && a.status === 'ok'));
});

test('start: privileged only via allowlist entry (+reason); resources honored', async () => {
  const env = makeEnv({ allowlist: [{ image: IMG, privileged: true, reason: 'redroid needs kvm-less privileged boot (matrixa-r3)', memoryBytes: 1024 * 1024 * 1024, nanoCpus: 2 }] });
  const res = await env.svc.startForRun(RUN1);
  const info = await env.docker.client.getContainer(res.containerId).inspect();
  assert.equal(info.HostConfig.Privileged, true);
  assert.equal(info.HostConfig.Memory, 1024 * 1024 * 1024);
  assert.equal(info.HostConfig.NanoCpus, 2e9);
});

test('start: allowlist entry with privileged but no reason is refused (MD §12)', async () => {
  const env = makeEnv({ allowlist: [{ image: IMG, privileged: true }] });
  await assert.rejects(env.svc.startForRun(RUN1), (e) => e.apiCode === 'IMAGE_NOT_ALLOWLISTED' && /reason/.test(e.message));
});

// ---------------------------------------------------------------- 2. allowlist fail-closed
test('start: no allowlist anywhere → IMAGE_ALLOWLIST_UNAVAILABLE (fail closed, 503)', async () => {
  const env = makeEnv({ allowlist: [] });
  await assert.rejects(env.svc.startForRun(RUN1), (e) => e.apiCode === 'IMAGE_ALLOWLIST_UNAVAILABLE' && e.statusCode === 503);
  assert.equal(env.docker.client.__calls.some((c) => c.method === 'createContainer'), false, 'nothing was created');
});

test('start: image not on the allowlist → IMAGE_NOT_ALLOWLISTED (403, never guessed)', async () => {
  const env = makeEnv({ allowlist: ['other/image:9.9.9'] });
  await assert.rejects(env.svc.startForRun(RUN1), (e) => e.apiCode === 'IMAGE_NOT_ALLOWLISTED' && e.statusCode === 403);
});

// ---------------------------------------------------------------- 3. volume safety
test('start: dataPath with .. traversal → VOLUME_PATH_INVALID (DB row treated as hostile)', async () => {
  const fx = makeFixtureRoot();
  const evil = { ...fx.identities[0], dataPath: path.join(fx.root, '../evil') };
  const env = makeEnv({ fixture: fx, identities: [evil] });
  await assert.rejects(env.svc.startForRun(RUN1), (e) => e.apiCode === 'VOLUME_PATH_INVALID');
});

test('start: dataPath outside the root → VOLUME_PATH_INVALID', async () => {
  const fx = makeFixtureRoot();
  const evil = { ...fx.identities[0], dataPath: '/tmp/somewhere-else/data' };
  const env = makeEnv({ fixture: fx, identities: [evil] });
  await assert.rejects(env.svc.startForRun(RUN1), (e) => e.apiCode === 'VOLUME_PATH_INVALID');
});

test('start: SYMLINK ESCAPE mid-path → VOLUME_SYMLINK_ESCAPE + security audit', async () => {
  // <root>/<id1>/link → /etc  (classic escape)
  const fx = makeFixtureRoot();
  const linkParent = path.join(fx.root, ID1);
  fs.mkdirSync(linkParent, { recursive: true });
  fs.symlinkSync('/etc', path.join(linkParent, 'link'));
  const sneaky = { ...fx.identities[0], dataPath: path.join(fx.root, ID1, 'link', 'data') };
  const env = makeEnv({ fixture: fx, identities: [sneaky] });
  await assert.rejects(env.svc.startForRun(RUN1), (e) => e.apiCode === 'VOLUME_SYMLINK_ESCAPE' && e.statusCode === 500);
  assert.ok(env.audits.some((a) => a.action === 'batch_volume.symlink_escape_blocked' && a.status === 'blocked'));
});

test('start: LEAF symlink pointing outside the root → VOLUME_SYMLINK_ESCAPE', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-br3-outside-'));
  const fx = makeFixtureRoot();
  fs.mkdirSync(path.join(fx.root, ID2), { recursive: true });
  fs.symlinkSync(outside, path.join(fx.root, ID2, 'data'));
  const env = makeEnv({ fixture: fx, taskRuns: [runRow({ identityId: ID2 })] }); // run bound to ID2 → its dataPath is the symlink
  await assert.rejects(env.svc.startForRun(RUN1), (e) => e.apiCode === 'VOLUME_SYMLINK_ESCAPE');
  fs.rmSync(outside, { recursive: true, force: true });
});

test('start: another identity already mounting the same writable source → MOUNT_SOURCE_CONFLICT', async () => {
  // ID2 has a live container mounting ID1's data dir (cross-identity aliasing).
  const fx = makeFixtureRoot();
  const foreignLabels = buildContainerLabels({ identityId: ID2, batchId: BATCH1, taskRunId: RUN2, createdBy: 'other' });
  const env = makeEnv({
    fixture: fx,
    containerSeeds: [{ name: 'br-b3-foreign', state: 'running', labels: foreignLabels, mounts: [{ Type: 'bind', Source: fx.dataPath(ID1), Target: '/data', RW: true }] }],
    taskRuns: [runRow(), runRow({ id: RUN2, identityId: ID2, status: 'running' })],
  });
  await assert.rejects(env.svc.startForRun(RUN1), (e) => e.apiCode === 'MOUNT_SOURCE_CONFLICT' && e.statusCode === 409);
  assert.equal(env.docker.client.__calls.some((c) => c.method === 'createContainer'), false);
});

// ---------------------------------------------------------------- 4. daemon fail-closed
test('start: daemon down → 503 DOCKER_DAEMON_UNAVAILABLE, nothing claimed, no lease, no bind', async () => {
  const env = makeEnv({ dockerOpts: { mode: 'daemon-down' } });
  await assert.rejects(
    env.svc.startForRun(RUN1),
    (e) => e.apiCode === 'CONTAINER_OP_FAILED' && e.statusCode === 503 && e.details.dockerCode === DOCKER_ERROR.DAEMON_UNAVAILABLE && e.details.retryable === true,
  );
  const run = await env.db.taskRun.findUnique({ where: { id: RUN1 } });
  assert.equal(run.containerId ?? null, null, 'no DB bind on a failed create');
  const leases = await env.db.resourceLease.findMany({ where: { resourceType: 'port' } });
  assert.equal(leases.length, 0, 'port lease released (or never granted) on daemon failure');
  assert.equal(env.audits.some((a) => a.action === 'batch_container.started'), false, 'no fake success audited');
});

test('start: permission denied on the socket → 502, fail closed', async () => {
  const env = makeEnv({ dockerOpts: { mode: 'permission-denied' } });
  await assert.rejects(env.svc.startForRun(RUN1), (e) => e.statusCode === 502 && e.details.dockerCode === DOCKER_ERROR.PERMISSION_DENIED);
});

// ---------------------------------------------------------------- 5. bad image
test('start: image missing on host → 404 IMAGE_NOT_FOUND, NON-retryable, lease released', async () => {
  const docker = makeFakeDockerWrapper();
  const realCreate = docker.client.createContainer.bind(docker.client);
  docker.client.createContainer = async (cfg) => {
    const err = new Error('(HTTP code 404) no such container - No such image: ' + (cfg?._body?.Image ?? '?'));
    err.statusCode = 404;
    throw err;
  };
  void realCreate;
  const env = makeEnv({ dockerOpts: {} });
  // swap in the image-missing client
  const db = env.db;
  const lease = createLeaseService({ db, now: env.clock });
  const config = {
    batchContainerDataRoot: env.root, batchContainerAllowedImages: [], batchAdbHostPortRange: '16370-16419',
    batchPortLeaseTtlMs: 3_600_000, batchContainerStopTimeoutSec: 1, batchContainerNamePrefix: 'br-b3-',
    batchContainerHealthTimeoutMs: 1_000, batchContainerHealthPollMs: 10, batchContainerHealthProbeTimeoutMs: 1_000,
  };
  const svc = createBatchLifecycleService({ db, docker, config, lease, audit: async () => {}, log: { info() {}, warn() {}, error() {} }, clock: env.clock, healthProbe: healthyProbe() });
  await assert.rejects(svc.startForRun(RUN1), (e) => e.statusCode === 404 && e.details.dockerCode === DOCKER_ERROR.IMAGE_NOT_FOUND && e.details.retryable === false);
  const leases = await db.resourceLease.findMany({ where: { resourceType: 'port' } });
  assert.equal(leases.length, 0, 'lease released after the image failure');
  const run = await db.taskRun.findUnique({ where: { id: RUN1 } });
  assert.equal(run.containerId ?? null, null);
});

// ---------------------------------------------------------------- 6. ports
test('start: entire pool already leased → PORT_POOL_EXHAUSTED (503)', async () => {
  // lease every port in a tiny pool for a foreign run
  const leases = [];
  const foreignRun = uid(99);
  for (let p = 16370; p <= 16372; p += 1) {
    leases.push({ id: `lease-${p}`, resourceType: 'port', resourceKey: `port:${p}`, ownerRunId: foreignRun, leaseExpiresAt: LATER });
  }
  const env = makeEnv({ portRange: '16370-16372', leases });
  await assert.rejects(env.svc.startForRun(RUN1), (e) => e.apiCode === 'PORT_POOL_EXHAUSTED' && e.statusCode === 503);
});

test('start: engine-level port collision → re-roll to the next port, first lease released', async () => {
  const docker = makeFakeDockerWrapper();
  let firstCall = true;
  const realCreate = docker.client.createContainer.bind(docker.client);
  docker.client.createContainer = async (cfg) => {
    if (firstCall) {
      firstCall = false;
      const err = new Error('Driver failed to port dial: port is already allocated');
      err.statusCode = 500;
      throw err;
    }
    return realCreate(cfg);
  };
  const env = makeEnv({ dockerOpts: {} });
  const db = env.db;
  const lease = createLeaseService({ db, now: env.clock });
  const config = {
    batchContainerDataRoot: env.root, batchContainerAllowedImages: [], batchAdbHostPortRange: '16370-16419',
    batchPortLeaseTtlMs: 3_600_000, batchContainerStopTimeoutSec: 1, batchContainerNamePrefix: 'br-b3-',
    batchContainerHealthTimeoutMs: 1_000, batchContainerHealthPollMs: 10, batchContainerHealthProbeTimeoutMs: 1_000,
  };
  const svc = createBatchLifecycleService({ db, docker, config, lease, audit: async () => {}, log: { info() {}, warn() {}, error() {} }, clock: env.clock, healthProbe: healthyProbe() });
  const res = await svc.startForRun(RUN1);
  assert.equal(res.hostPort, 16371, 'the collided port is re-rolled, not retried');
  const leases = await db.resourceLease.findMany({ where: { resourceType: 'port' } });
  assert.equal(leases.length, 1);
  assert.equal(leases[0].resourceKey, 'port:16371', 'only the surviving port stays leased');
  const calls = docker.client.__calls.filter((c) => c.method === 'createContainer');
  const name = calls[calls.length - 1].opts?._query?.name;
  const info = await docker.client.getContainer(name).inspect();
  assert.equal(info.HostConfig.PortBindings['5555/tcp'][0].HostPort, '16371');
});

test('start: engine port collision on EVERY pool port → PORT_POOL_EXHAUSTED (bounded, no loop)', async () => {
  const docker = makeFakeDockerWrapper();
  docker.client.createContainer = async (cfg) => {
    const err = new Error('Driver failed to port dial: port is already allocated');
    err.statusCode = 500;
    throw err;
  };
  const env = makeEnv({ portRange: '16370-16371' });
  const db = env.db;
  const lease = createLeaseService({ db, now: env.clock });
  const config = {
    batchContainerDataRoot: env.root, batchContainerAllowedImages: [], batchAdbHostPortRange: '16370-16371',
    batchPortLeaseTtlMs: 3_600_000, batchContainerStopTimeoutSec: 1, batchContainerNamePrefix: 'br-b3-',
    batchContainerHealthTimeoutMs: 1_000, batchContainerHealthPollMs: 10, batchContainerHealthProbeTimeoutMs: 1_000,
  };
  const svc = createBatchLifecycleService({ db, docker, config, lease, audit: async () => {}, log: { info() {}, warn() {}, error() {} }, clock: env.clock, healthProbe: healthyProbe() });
  await assert.rejects(svc.startForRun(RUN1), (e) => e.apiCode === 'PORT_POOL_EXHAUSTED');
  const leases = await db.resourceLease.findMany({ where: { resourceType: 'port' } });
  assert.equal(leases.length, 0, 'every leased port was released after the bounded re-roll');
});

// ---------------------------------------------------------------- 7. crash window: adopt, no double-start
test('start: crash window (container created, DB bind never landed) → ADOPT, no second create', async () => {
  const labels = buildContainerLabels({ identityId: ID1, batchId: BATCH1, taskRunId: RUN1, createdBy: 'worker-1' });
  const fx = makeFixtureRoot();
  const env = makeEnv({
    fixture: fx,
    containerSeeds: [{ name: 'br-b3-' + RUN1 + '-a1', state: 'created', labels, mounts: [{ Type: 'bind', Source: fx.dataPath(ID1), Target: '/data', RW: true }], portBindings: { '5555/tcp': [{ HostIp: '127.0.0.1', HostPort: '16380' }] }, networks: { 'water-army-devices': '127.0.0.1' } }],
  });
  const res = await env.svc.startForRun(RUN1);
  const creates = env.docker.client.__calls.filter((c) => c.method === 'createContainer');
  assert.equal(creates.length, 0, 'the crashed-attempt container is adopted, not re-created (no double-start)');
  const run = await env.db.taskRun.findUnique({ where: { id: RUN1 } });
  assert.ok(run.containerId, 'the DB bind is completed for the adopted container');
  assert.ok(res.containerId, 'the adopted container is the returned one');
  // and it was started (created → running)
  const info = await env.docker.client.getContainer(run.containerId).inspect();
  assert.equal(info.State.Status, 'running');
});

test('start: prior-attempt container (running, bound) → adopted too (safe reuse, still no double-start)', async () => {
  const labels = buildContainerLabels({ identityId: ID1, batchId: BATCH1, taskRunId: RUN1, createdBy: 'worker-1' });
  const fx = makeFixtureRoot();
  const env = makeEnv({
    fixture: fx,
    containerSeeds: [{ name: 'br-b3-' + RUN1 + '-a1', state: 'running', labels, mounts: [{ Type: 'bind', Source: fx.dataPath(ID1), Target: '/data', RW: true }], portBindings: { '5555/tcp': [{ HostIp: '127.0.0.1', HostPort: '16381' }] }, networks: { 'water-army-devices': '127.0.0.1' } }],
    taskRuns: [runRow({ containerId: 'preseed' + '0'.repeat(57) })],
  });
  // point the run's containerId at the seeded container's real id
  const seededId = [...env.docker.client.__byId.keys()][0];
  await env.db.taskRun.update({ where: { id: RUN1 }, data: { containerId: seededId } });
  const res = await env.svc.startForRun(RUN1);
  assert.equal(res.containerId, seededId);
  assert.equal(env.docker.client.__calls.filter((c) => c.method === 'createContainer').length, 0);
});

test('start: TWO live containers claiming one run → ABORT (human reconcile required)', async () => {
  const labels = buildContainerLabels({ identityId: ID1, batchId: BATCH1, taskRunId: RUN1, createdBy: 'w' });
  const env = makeEnv({
    containerSeeds: [
      { name: 'br-b3-dup1', state: 'running', labels },
      { name: 'br-b3-dup2', state: 'running', labels },
    ],
  });
  await assert.rejects(env.svc.startForRun(RUN1), (e) => e.apiCode === 'CONTAINER_OWNERSHIP_MISMATCH' && /2 live containers/.test(e.message));
});

// ---------------------------------------------------------------- 8. ownership double check
test('stop: label tampered (identity drift) → REFUSED + audited, container untouched', async () => {
  const labels = buildContainerLabels({ identityId: ID2, batchId: BATCH1, taskRunId: RUN1, createdBy: 'evil' }); // ID2 ≠ run.identityId
  const env = makeEnv({
    containerSeeds: [{ name: 'br-b3-tampered', state: 'running', labels, portBindings: { '5555/tcp': [{ HostIp: '127.0.0.1', HostPort: '16382' }] } }],
  });
  const seededId = [...env.docker.client.__byId.keys()][0];
  await env.db.taskRun.update({ where: { id: RUN1 }, data: { containerId: seededId } });
  await assert.rejects(env.svc.stopForRun(RUN1), (e) => e.apiCode === 'CONTAINER_OWNERSHIP_MISMATCH');
  const info = await env.docker.client.getContainer(seededId).inspect();
  assert.equal(info.State.Status, 'running', 'a refused op must never touch the container');
  assert.ok(env.audits.some((a) => a.action === 'batch_container.ownership_mismatch' && a.status === 'refused'));
});

test('stop: run bound to a DIFFERENT container than the inspected one → REFUSED', async () => {
  const labels = buildContainerLabels({ identityId: ID1, batchId: BATCH1, taskRunId: RUN1, createdBy: 'w' });
  const env = makeEnv({
    containerSeeds: [{ name: 'br-b3-other', state: 'running', labels, portBindings: { '5555/tcp': [{ HostIp: '127.0.0.1', HostPort: '16383' }] } }],
  });
  const seededId = [...env.docker.client.__byId.keys()][0];
  await env.db.taskRun.update({ where: { id: RUN1 }, data: { containerId: 'not-' + seededId.slice(4) } }); // DB points elsewhere
  await assert.rejects(env.svc.stopForRun(RUN1), (e) => e.apiCode === 'CONTAINER_OWNERSHIP_MISMATCH');
});

// ---------------------------------------------------------------- 9. stop / remove / volume retention
test('stop: reversible — container stays (exited), volume + data intact, port lease released', async () => {
  const env = makeEnv();
  const start = await env.svc.startForRun(RUN1);
  // write identity data
  fs.writeFileSync(path.join(env.dataPath(ID1), 'secret.dat'), 'identity-state');
  const stop = await env.svc.stopForRun(RUN1);
  assert.equal(stop.wasRunning, true);
  assert.equal(stop.volumeRetained, true);
  const info = await env.docker.client.getContainer(start.containerId).inspect();
  assert.equal(info.State.Status, 'exited', 'stopped, NOT removed');
  assert.equal(fs.readFileSync(path.join(env.dataPath(ID1), 'secret.dat'), 'utf8'), 'identity-state', 'volume survived the stop');
  const leases = await env.db.resourceLease.findMany({ where: { resourceType: 'port' } });
  assert.equal(leases.length, 0, 'port lease released on stop');
});

test('remove: container gone, VOLUME RETAINED (data still on disk) — only purge may clear it', async () => {
  const env = makeEnv();
  const start = await env.svc.startForRun(RUN1);
  fs.writeFileSync(path.join(env.dataPath(ID1), 'keep-me.dat'), 'survives');
  const rm = await env.svc.removeForRun(RUN1);
  assert.equal(rm.removed, true);
  assert.equal(rm.volumeRetained, true);
  await assert.rejects(env.docker.client.getContainer(start.containerId).inspect(), /No such container/);
  assert.ok(fs.existsSync(path.join(env.dataPath(ID1), 'keep-me.dat')), 'the data dir is untouched by remove (MD §4.2)');
  assert.equal(fs.readFileSync(path.join(env.dataPath(ID1), 'keep-me.dat'), 'utf8'), 'survives');
  const leases = await env.db.resourceLease.findMany({ where: { resourceType: 'port' } });
  assert.equal(leases.length, 0);
});

test('remove: already-gone container → honest no-op (idempotent finally)', async () => {
  const env = makeEnv();
  const r = await env.svc.removeForRun(RUN1);
  assert.equal(r.removed, false);
});

// ---------------------------------------------------------------- 10. purge (dry-run + confirm + audit)
// purge's in-use guard forbids wiping an identity with ACTIVE runs — the
// realistic flow is: run finishes (terminal) → container/volume linger → admin purges.
const completeRun = async (env, runId = RUN1) => {
  await env.db.taskRun.update({ where: { id: runId }, data: { status: 'succeeded' } });
};

test('purge: dry-run previews (size/files/containers) and changes NOTHING', async () => {
  const env = makeEnv();
  const start = await env.svc.startForRun(RUN1);
  fs.writeFileSync(path.join(env.dataPath(ID1), 'a.bin'), 'x'.repeat(100));
  fs.mkdirSync(path.join(env.dataPath(ID1), 'sub'));
  fs.writeFileSync(path.join(env.dataPath(ID1), 'sub', 'b.bin'), 'y'.repeat(50));
  await completeRun(env);

  const preview = await env.svc.purgeIdentity(ID1, { dryRun: true, actor: { userId: 'u-admin', label: 'admin' } });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.sizeBytes, 150);
  assert.equal(preview.fileCount, 2);
  assert.equal(preview.containers.length, 1);
  // nothing happened
  const info = await env.docker.client.getContainer(start.containerId).inspect();
  assert.equal(info.State.Status, 'running');
  assert.ok(fs.existsSync(path.join(env.dataPath(ID1), 'a.bin')));
  assert.equal(env.audits.some((a) => a.action === 'batch_identity.purged'), false, 'dry-run must not write the purge audit');
});

test('purge: without confirm === identityId → PURGE_CONFIRM_REQUIRED (400)', async () => {
  const env = makeEnv();
  await env.svc.startForRun(RUN1);
  await completeRun(env);
  await assert.rejects(
    env.svc.purgeIdentity(ID1, { dryRun: false, confirm: 'wrong-id', actor: { userId: 'u-admin' } }),
    (e) => e.apiCode === 'PURGE_CONFIRM_REQUIRED' && e.statusCode === 400,
  );
});

test('purge: executed — containers stopped+removed AND data wiped, audited', async () => {
  const env = makeEnv();
  const start = await env.svc.startForRun(RUN1);
  fs.writeFileSync(path.join(env.dataPath(ID1), 'a.bin'), 'zz');
  await completeRun(env);
  const res = await env.svc.purgeIdentity(ID1, { dryRun: false, confirm: ID1, actor: { userId: 'u-admin', label: 'admin' } });
  assert.equal(res.removed, true);
  assert.equal(res.sizeBytes, 2);
  assert.equal(res.fileCount, 1);
  assert.deepEqual(res.containers, [start.containerId]);
  await assert.rejects(env.docker.client.getContainer(start.containerId).inspect(), /No such container/);
  assert.ok(!fs.existsSync(env.dataPath(ID1)), 'the data dir is gone — purge is the ONLY wipe path');
  const a = env.audits.find((x) => x.action === 'batch_identity.purged');
  assert.ok(a, 'purge audit entry written');
  assert.equal(a.status, 'ok');
  assert.equal(a.actorUserId, 'u-admin');
  assert.equal(a.details.removed, true);
});

test('purge: identity with an ACTIVE run → 409 (never wipe live state)', async () => {
  const env = makeEnv();
  await assert.rejects(
    env.svc.purgeIdentity(ID1, { dryRun: true, actor: { userId: 'u-admin' } }),
    (e) => e.apiCode === 'RUN_STATE_INVALID' && e.statusCode === 409,
  );
});

test('purge: container whose run row vanished → ownership-gated refusal, never touched', async () => {
  const labels = buildContainerLabels({ identityId: ID1, batchId: BATCH1, taskRunId: uid(77), createdBy: 'ghost' });
  const env = makeEnv({ containerSeeds: [{ name: 'br-b3-ghost', state: 'running', labels }] });
  await completeRun(env); // the seeded RUN1 must not trip the in-use guard
  await assert.rejects(
    env.svc.purgeIdentity(ID1, { dryRun: false, confirm: ID1, actor: { userId: 'u-admin' } }),
    (e) => e.apiCode === 'CONTAINER_OWNERSHIP_MISMATCH',
  );
});

// ---------------------------------------------------------------- 11. boot health (MD §8.2)
test('start: container dies mid-boot → fast fail (no waiting out the timeout)', async () => {
  const env = makeEnv({ probe: sickProbe(), healthTimeoutMs: 5_000 });
  // wrap: after the engine start, mark the container exited (simulates a
  // boot crash — the health loop must catch the state flip, not just the
  // failing probe, and bail fast).
  const client = env.docker.client;
  const origGet = client.getContainer.bind(client);
  client.getContainer = (idOrName) => {
    const c = origGet(idOrName);
    return {
      ...c,
      start: async (...a) => {
        await c.start(...a);
        const rec = client.__byId.get(idOrName) ?? client.__byId.get(client.__byName.get(idOrName));
        if (rec) { rec.inspect.State.Status = 'exited'; rec.inspect.State.Running = false; rec.inspect.State.ExitCode = 137; }
      },
    };
  };
  const t0 = Date.now();
  await assert.rejects(env.svc.startForRun(RUN1), (e) => e.apiCode === 'CONTAINER_OP_FAILED' && e.details.dockerCode === 'HEALTH_TIMEOUT' && e.details.retryable === true);
  assert.ok(Date.now() - t0 < 1_500, 'the dead container is detected fast, not waited out');
  // the DB row kept the containerId (cleanup path can find + verify it) and the lease is released
  const run = await env.db.taskRun.findUnique({ where: { id: RUN1 } });
  assert.ok(run.containerId, 'containerId kept for the cleanup path');
  const leases = await env.db.resourceLease.findMany({ where: { resourceType: 'port' } });
  assert.equal(leases.length, 0, 'lease released on the failed boot');
  // the container was LEFT (not force-removed) — the finally/reconcile owns it
  await assert.doesNotReject(env.docker.client.getContainer(run.containerId).inspect());
});

test('start: health probe never answers while container runs → bounded timeout, container left for cleanup', async () => {
  const env = makeEnv({ probe: sickProbe(), healthTimeoutMs: 300, healthPollMs: 10 });
  const t0 = Date.now();
  await assert.rejects(env.svc.startForRun(RUN1), (e) => e.details.dockerCode === 'HEALTH_TIMEOUT');
  assert.ok(Date.now() - t0 < 2_000);
  const run = await env.db.taskRun.findUnique({ where: { id: RUN1 } });
  assert.ok(run.containerId);
  const leases = await env.db.resourceLease.findMany({ where: { resourceType: 'port' } });
  assert.equal(leases.length, 0);
});

test('health: single probe on a running+bound container reports app-layer state', async () => {
  const env = makeEnv();
  const start = await env.svc.startForRun(RUN1);
  const h = await env.svc.healthForRun(RUN1);
  assert.equal(h.healthy, true);
  assert.equal(h.state, 'running');
  assert.equal(h.version, '0.0.1');
  assert.equal(h.hostPort, start.hostPort);
});

test('health: stopped container → healthy:false with the docker state', async () => {
  const env = makeEnv();
  await env.svc.startForRun(RUN1);
  await env.svc.stopForRun(RUN1);
  const h = await env.svc.healthForRun(RUN1);
  assert.equal(h.healthy, false);
  assert.equal(h.state, 'exited');
});

test('health: container gone out-of-band → state "gone" (DB is stale, honest)', async () => {
  const env = makeEnv();
  const start = await env.svc.startForRun(RUN1);
  await env.docker.client.getContainer(start.containerId).remove({ force: true });
  const h = await env.svc.healthForRun(RUN1);
  assert.equal(h.healthy, false);
  assert.equal(h.state, 'gone');
});

// ---------------------------------------------------------------- 12. reconcile (MD item 3/5)
test('reconcile: classifies ok / orphan / stale_running / db_only / unbound / mismatch', async () => {
  // fixture:
  //  R1: running run, live lease, its container running            → ok
  //  R3: TERMINAL run, its container still running                 → orphan (fixable)
  //  R4: running run, EXPIRED lease, its container running         → stale_running (fixable)
  //  R5: running run, containerId → container docker doesn't know  → db_only
  //  R6: running run, no containerId                                → unbound
  //  R7: container whose labels disagree with its run row           → mismatch
  const R3 = uid(33);
  const R4 = uid(34);
  const R5 = uid(35);
  const R6 = uid(36);
  const R7 = uid(37);
  const L3 = buildContainerLabels({ identityId: ID1, batchId: BATCH1, taskRunId: R3, createdBy: 'w' });
  const L4 = buildContainerLabels({ identityId: ID1, batchId: BATCH1, taskRunId: R4, createdBy: 'w' });
  const L7 = buildContainerLabels({ identityId: ID2, batchId: BATCH1, taskRunId: R7, createdBy: 'w' }); // identity drift
  const env = makeEnv({
    taskRuns: [
      runRow(),
      runRow({ id: R3, status: 'succeeded', containerId: 'x' }),
      runRow({ id: R4, status: 'running', leaseExpiresAt: new Date(NOW.getTime() - 1_000), containerId: 'x' }),
      runRow({ id: R5, status: 'running', containerId: 'vanished' + '0'.repeat(56) }),
      runRow({ id: R6, status: 'running', containerId: null }),
      runRow({ id: R7, status: 'running', identityId: ID1, containerId: 'x' }),
    ],
    containerSeeds: [
      { name: 'br-b3-r1', state: 'running', labels: buildContainerLabels({ identityId: ID1, batchId: BATCH1, taskRunId: RUN1, createdBy: 'w' }) },
      { name: 'br-b3-r3', state: 'running', labels: L3 },
      { name: 'br-b3-r4', state: 'running', labels: L4 },
      { name: 'br-b3-r7', state: 'running', labels: L7 },
    ],
  });
  // bind the real seeded ids into the run rows (the fake doesn't auto-match)
  const byName = env.docker.client.__byName;
  await env.db.taskRun.update({ where: { id: R3 }, data: { containerId: byName.get('br-b3-r3') } });
  await env.db.taskRun.update({ where: { id: R4 }, data: { containerId: byName.get('br-b3-r4') } });
  await env.db.taskRun.update({ where: { id: R7 }, data: { containerId: byName.get('br-b3-r7') } });

  const r = await env.svc.reconcile({});
  const byState = Object.fromEntries(r.items.map((i) => [i.runId, i.state]));
  assert.equal(byState[RUN1], 'ok');
  assert.equal(byState[R3], 'orphan');
  assert.equal(byState[R4], 'stale_running');
  assert.equal(byState[R5], 'db_only');
  assert.equal(byState[R6], 'unbound');
  assert.equal(byState[R7], 'mismatch');
  assert.equal(r.counts.ok, 1);
  assert.equal(r.counts.orphan, 1);
  assert.equal(r.counts.stale_running, 1);
  assert.equal(r.counts.db_only, 1);
  assert.equal(r.counts.unbound, 1);
  assert.equal(r.counts.mismatch, 1);
  // no-fix mode touches nothing
  for (const n of ['br-b3-r1', 'br-b3-r3', 'br-b3-r4', 'br-b3-r7']) {
    assert.equal((await env.docker.client.getContainer(n).inspect()).State.Status, 'running');
  }
});

test('reconcile fix (admin): orphan → stopped+removed; stale → stopped; mismatch → NEVER touched', async () => {
  const R3 = uid(43);
  const R4 = uid(44);
  const R7 = uid(45);
  const env = makeEnv({
    taskRuns: [
      runRow({ id: R3, status: 'succeeded' }),
      runRow({ id: R4, status: 'running', leaseExpiresAt: new Date(NOW.getTime() - 1_000) }),
      runRow({ id: R7, status: 'running', identityId: ID1 }),
    ],
    containerSeeds: [
      { name: 'br-b3-f-r3', state: 'running', labels: buildContainerLabels({ identityId: ID1, batchId: BATCH1, taskRunId: R3, createdBy: 'w' }) },
      { name: 'br-b3-f-r4', state: 'running', labels: buildContainerLabels({ identityId: ID1, batchId: BATCH1, taskRunId: R4, createdBy: 'w' }) },
      { name: 'br-b3-f-r7', state: 'running', labels: buildContainerLabels({ identityId: ID2, batchId: BATCH1, taskRunId: R7, createdBy: 'w' }) },
    ],
  });
  const byName = env.docker.client.__byName;
  await env.db.taskRun.update({ where: { id: R3 }, data: { containerId: byName.get('br-b3-f-r3') } });
  await env.db.taskRun.update({ where: { id: R4 }, data: { containerId: byName.get('br-b3-f-r4') } });
  await env.db.taskRun.update({ where: { id: R7 }, data: { containerId: byName.get('br-b3-f-r7') } });

  const r = await env.svc.reconcile({ fix: true, actor: { userId: 'u-admin', label: 'reconcile-admin' } });
  const item = (id) => r.items.find((i) => i.runId === id);
  assert.equal(item(R3).fixed, true);
  assert.equal(item(R3).fixedDetail, 'stopped+removed');
  assert.equal(item(R4).fixed, true);
  assert.equal(item(R4).fixedDetail, 'stopped');
  assert.equal(item(R7).fixed, false, 'a mismatch is never fixed by automation');
  assert.equal(item(R7).state, 'mismatch');

  // docker-side truth
  await assert.rejects(env.docker.client.getContainer('br-b3-f-r3').inspect(), /No such container/, 'orphan removed');
  assert.equal((await env.docker.client.getContainer('br-b3-f-r4').inspect()).State.Status, 'exited', 'stale stopped (re-dispatch may re-run the run)');
  assert.equal((await env.docker.client.getContainer('br-b3-f-r7').inspect()).State.Status, 'running', 'mismatch untouched');
  assert.ok(env.audits.some((a) => a.action === 'batch_reconcile.fixed' && a.details.runId === R3));
  assert.ok(env.audits.some((a) => a.action === 'batch_reconcile.scanned'));
});

test('reconcile fix: stopping a managed container releases its ADB port lease (E2E run-4 leak)', async () => {
  // E2E run-4 P5: ports=6 — the sweep stopped the residual containers
  // directly (docker client) but never released their port leases (the
  // stopForRun/removeForRun paths do; the bypass didn't), pinning pool
  // ports until the 30-min TTL. Every stop path must free its port.
  const R3 = uid(53);
  const R4 = uid(54);
  const env = makeEnv({
    taskRuns: [
      // terminal run, container still running (the P4 shape: final attempt
      // failed, the container was left; the sweep must stop it AND free the port)
      runRow({ id: R3, status: 'succeeded' }),
      // running run, EXPIRED lease (stale_running fixable), container running
      runRow({ id: R4, status: 'running', leaseExpiresAt: new Date(NOW.getTime() - 1_000) }),
    ],
    leases: [
      { resourceType: 'port', resourceKey: 'port:16370', ownerRunId: R3, ownerLabel: 'batch-lifecycle', leaseExpiresAt: LATER },
      { resourceType: 'port', resourceKey: 'port:16371', ownerRunId: R4, ownerLabel: 'batch-lifecycle', leaseExpiresAt: LATER },
    ],
    containerSeeds: [
      { name: 'br-b3-leak-r3', state: 'running', labels: buildContainerLabels({ identityId: ID1, batchId: BATCH1, taskRunId: R3, createdBy: 'w' }), portBindings: { '5555/tcp': [{ HostIp: '127.0.0.1', HostPort: '16370' }] } },
      { name: 'br-b3-leak-r4', state: 'running', labels: buildContainerLabels({ identityId: ID1, batchId: BATCH1, taskRunId: R4, createdBy: 'w' }), portBindings: { '5555/tcp': [{ HostIp: '127.0.0.1', HostPort: '16371' }] } },
    ],
  });
  const byName = env.docker.client.__byName;
  await env.db.taskRun.update({ where: { id: R3 }, data: { containerId: byName.get('br-b3-leak-r3') } });
  await env.db.taskRun.update({ where: { id: R4 }, data: { containerId: byName.get('br-b3-leak-r4') } });

  assert.equal(await env.db.resourceLease.count({ where: { resourceType: 'port', leaseExpiresAt: { gt: NOW } } }), 2);

  const r = await env.svc.reconcile({ fix: true, actor: { userId: 'u-admin', label: 'reconcile-admin' } });
  const item = (id) => r.items.find((i) => i.runId === id);
  assert.equal(item(R3).fixedDetail, 'stopped+removed');
  assert.equal(item(R4).fixedDetail, 'stopped');

  assert.equal(
    await env.db.resourceLease.count({ where: { resourceType: 'port', leaseExpiresAt: { gt: NOW } } }),
    0,
    'fix-stopped containers release their ADB port leases (no TTL-dependent pool pinning)',
  );
});

// ---------------------------------------------------------------- 13. engine start failure
test('start: engine start failure → container removed, DB bind cleared, retryable error', async () => {
  const docker = makeFakeDockerWrapper();
  const origGet = docker.client.getContainer.bind(docker.client);
  docker.client.getContainer = (idOrName) => {
    const c = origGet(idOrName);
    return { ...c, start: async () => { const e = new Error('OCI runtime start failed: exit status 1'); e.statusCode = 500; throw e; } };
  };
  const env = makeEnv({ dockerOpts: {} });
  const db = env.db;
  const lease = createLeaseService({ db, now: env.clock });
  const config = {
    batchContainerDataRoot: env.root, batchContainerAllowedImages: [], batchAdbHostPortRange: '16370-16419',
    batchPortLeaseTtlMs: 3_600_000, batchContainerStopTimeoutSec: 1, batchContainerNamePrefix: 'br-b3-',
    batchContainerHealthTimeoutMs: 1_000, batchContainerHealthPollMs: 10, batchContainerHealthProbeTimeoutMs: 1_000,
  };
  const svc = createBatchLifecycleService({ db, docker, config, lease, audit: async () => {}, log: { info() {}, warn() {}, error() {} }, clock: env.clock, healthProbe: healthyProbe() });
  await assert.rejects(svc.startForRun(RUN1), (e) => e.apiCode === 'CONTAINER_OP_FAILED' && /engine start failed/.test(e.message));
  const run = await db.taskRun.findUnique({ where: { id: RUN1 } });
  assert.equal(run.containerId ?? null, null, 'the DB bind is rolled back');
  const leases = await db.resourceLease.findMany({ where: { resourceType: 'port' } });
  assert.equal(leases.length, 0, 'port lease released');
  // the failed container was removed (no half-bound residue)
  const creates = docker.client.__calls.filter((c) => c.method === 'createContainer');
  assert.equal(creates.length, 1);
});

// ---------------------------------------------------------------- 14. real ADB CNXN probe (node:net path)
// F-RDFA-2: the default probe is now a genuine ADB CNXN handshake over the
// device-network IP (not the old bare host:version at 127.0.0.1). This test
// stands up a fake adbd that only answers a VALID CNXN, and places the fake
// container's device-network endpoint on 127.0.0.1 so the real node:net probe
// reaches it.
function makeFakeAdbd({ banner = 'device::ro.product.name=faux-device;ro.product.model=faux;ro.product.device=faux;features=cmd,shell_v2' } = {}) {
  return net.createServer((s) => {
    let buf = Buffer.alloc(0);
    s.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 24) return;
      const p = parseAdbPacket(buf);
      // Real adbd ignores anything before a valid CNXN (p2-55 EXP A/B).
      if (p.state !== 'ok' || p.command !== A_CNXN || !p.magicValid) return;
      const payload = Buffer.from(banner, 'utf8');
      const header = buildAdbCnxnPacket(banner).header;
      s.end(Buffer.concat([header, payload]));
    });
  });
}
test('default probe: a real local ADB-style server passes; closed port fails (node:net path)', async () => {
  const server = makeFakeAdbd();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;

  const clock = makeAdvancingClock();
  const fx = makeFixtureRoot();
  // the adapter spec's health.port selects the CONTAINER-side port the
  // probe dials (here the fake adbd's port — a real redroid always 5555)
  const batches = [{ ...BATCHES[0], configJson: { adapter: { type: 'container', image: IMG, health: { kind: 'adb-tcp', port } } } }];
  const db = makeBatchFakeDb({ identities: fx.identities, batches, taskRuns: [runRow()] });
  const lease = createLeaseService({ db, now: clock });
  const config = {
    batchContainerDataRoot: fx.root, batchContainerAllowedImages: [], batchAdbHostPortRange: '16370-16419',
    batchPortLeaseTtlMs: 3_600_000, batchContainerStopTimeoutSec: 1, batchContainerNamePrefix: 'br-b3-',
    batchContainerHealthTimeoutMs: 2_000, batchContainerHealthPollMs: 10, batchContainerHealthProbeTimeoutMs: 1_000,
  };
  const mkSvc = (docker) => createBatchLifecycleService({ db, docker, config, lease, audit: async () => {}, log: { info() {}, warn() {}, error() {} }, clock });

  // bind the run to a container that "publishes" our test port AND sits on
  // the device network at 127.0.0.1 (where the fake adbd listens)
  const labels = buildContainerLabels({ identityId: ID1, batchId: BATCH1, taskRunId: RUN1, createdBy: 'w' });
  const fake = makeFakeDockerWrapper({ containers: [{ name: 'br-b3-probe', state: 'running', labels, portBindings: { [`${port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(port) }] }, networks: { 'water-army-devices': '127.0.0.1' } }] });
  const id = fake.client.__byName.get('br-b3-probe');
  await db.taskRun.update({ where: { id: RUN1 }, data: { containerId: id } });

  const svc = mkSvc(fake);
  const h = await svc.healthForRun(RUN1);
  assert.equal(h.healthy, true, 'a genuine ADB CNXN handshake is accepted as app-layer health');
  assert.equal(h.version, 'adb-device@0x1000001');
  await server.close();

  // closed port → unhealthy (never throws, reports the detail)
  const h2 = await svc.healthForRun(RUN1);
  assert.equal(h2.healthy, false);
});

test('health: running container with NO device-network endpoint → fast fail (no L2 probe possible)', async () => {
  const fx = makeFixtureRoot();
  const labels = buildContainerLabels({ identityId: ID1, batchId: BATCH1, taskRunId: RUN1, createdBy: 'w' });
  // pre-G2 shaped container: running + port bound but never joined the
  // device network — the L2 probe is structurally impossible, so the
  // service must report that explicitly instead of polling the timeout.
  const fake = makeFakeDockerWrapper({ containers: [{ name: 'br-b3-nonet', state: 'running', labels, portBindings: { '5555/tcp': [{ HostIp: '127.0.0.1', HostPort: '16382' }] } }] });
  const id = fake.client.__byName.get('br-b3-nonet');
  const clock = makeAdvancingClock();
  const db = makeBatchFakeDb({ identities: fx.identities, batches: BATCHES, taskRuns: [runRow()] });
  const lease = createLeaseService({ db, now: clock });
  const config = {
    batchContainerDataRoot: fx.root, batchContainerAllowedImages: [], batchAdbHostPortRange: '16370-16419',
    batchPortLeaseTtlMs: 3_600_000, batchContainerStopTimeoutSec: 1, batchContainerNamePrefix: 'br-b3-',
    batchContainerHealthTimeoutMs: 2_000, batchContainerHealthPollMs: 10, batchContainerHealthProbeTimeoutMs: 1_000,
  };
  const svc = createBatchLifecycleService({ db, docker: fake, config, lease, audit: async () => {}, log: { info() {}, warn() {}, error() {} }, clock });
  await db.taskRun.update({ where: { id: RUN1 }, data: { containerId: id } });
  const t0 = Date.now();
  const h = await svc.healthForRun(RUN1);
  assert.ok(Date.now() - t0 < 1_000, 'fast fail — no timeout polling');
  assert.equal(h.healthy, false);
  assert.match(h.detail ?? '', /no endpoint on 'water-army-devices'/);
});

// ---------------------------------------------------------------- 15. list
test('list: returns the managed batch containers with their run lineage', async () => {
  const env = makeEnv();
  await env.svc.startForRun(RUN1);
  const rows = await env.svc.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runId, RUN1);
  assert.equal(rows[0].identityId, ID1);
  assert.equal(rows[0].batchId, BATCH1);
  assert.equal(rows[0].runStatus, 'running');
  assert.equal(rows[0].leaseAlive, true);
  assert.equal(rows[0].hostPorts['5555/tcp'], 16370);
});

test.after(() => {
  for (const r of ROOTS) fs.rmSync(r, { recursive: true, force: true });
});
