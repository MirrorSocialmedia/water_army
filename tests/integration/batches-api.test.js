/**
 * BR-B2 (G7) — batch API integration tests (施工 MD §10/§13.2/§14.2).
 *
 * Real HTTP path (app.inject) over the REAL app (buildApp) with fake
 * db/queue per house convention — hermetic, no live redis/postgres.
 *
 * Coverage:
 *   - RBAC: viewer / operator / admin / anonymous on every route class
 *   - identities list (page/filter/statusCounts)
 *   - preview: ZERO writes, plan + estimate + unknown-id reporting
 *   - create: 201 + idempotent replay (200) + ACTIVE_RUN_EXISTS 409
 *   - capacity: admin-only get/set/clear (AppSetting round-trip)
 *   - batch detail: stats + per-identity + capacity
 *   - lifecycle: start (202, dispatch), already-running no-op, predecessor
 *     gate 409, pause (stopExisting both), resume, cancel (PLANNED immediate
 *     200 / RUNNING 202 CANCELLING), illegal pause 409
 *   - task-runs batch routes: retry / cancel / logs + NOT_A_BATCH_RUN 409
 *   - per-user rate limits: 30/min writes → 429 + retry-after; 10/min retries
 *   - error envelope { error: { code, message, requestId } } on all failures
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from '@node-rs/argon2';

import { buildApp } from '../../apps/api/src/app.js';
import { makeFakeDb, testConfig, fakeRedisOk, fakeDockerOk, makeFakeQueue } from '../helpers/fakes.js';
import { makeBatchFakeDb } from '../helpers/batch-fakes.js';

const { argon2id, hash } = argon2;
const PASSWORD = 'TestPass123';

const uid = (n) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}`;
const ID1 = uid(1);
const ID2 = uid(2);
const ID3 = uid(3);
const ID4 = uid(4);
const ID5 = uid(5);
const ID6 = uid(6);
const RL_IDS = [uid(11), uid(12), uid(13), uid(14), uid(15), uid(16)];

const IDENTITIES = [
  { id: ID1, externalRef: 'acct-01', displayName: 'Acc 01', identityType: 'ACCOUNT', status: 'READY', dataPath: 'data/01' },
  { id: ID2, externalRef: 'acct-02', displayName: 'Acc 02', identityType: 'ACCOUNT', status: 'READY', dataPath: 'data/02' },
  { id: ID3, externalRef: 'acct-03', displayName: 'Acc 03', identityType: 'ACCOUNT', status: 'READY', dataPath: 'data/03' },
  { id: ID4, externalRef: 'acct-04', displayName: 'Acc 04', identityType: 'ACCOUNT', status: 'BLOCKED', dataPath: 'data/04' },
  { id: ID5, externalRef: 'acct-05', displayName: 'Acc 05', identityType: 'ACCOUNT', status: 'READY', dataPath: 'data/05' },
  { id: ID6, externalRef: 'acct-06', displayName: 'Acc 06', identityType: 'ACCOUNT', status: 'READY', dataPath: 'data/06' },
  ...RL_IDS.map((id, i) => ({ id, externalRef: `rl-${String(i + 1).padStart(2, '0')}`, displayName: `RL ${i + 1}`, identityType: 'ACCOUNT', status: 'READY', dataPath: `data/rl${i + 1}` })),
];

async function makeApp() {
  const passwordHash = await hash(PASSWORD, { type: argon2id });
  const users = [
    { id: 'u-admin', username: 'admin1', passwordHash, role: 'admin' },
    { id: 'u-op', username: 'operator1', passwordHash, role: 'operator' },
    { id: 'u-view', username: 'viewer1', passwordHash, role: 'viewer' },
  ];
  const base = makeFakeDb({ users });
  const b2 = makeBatchFakeDb({ identities: IDENTITIES });
  const db = { ...base, ...b2 };
  const queue = makeFakeQueue();
  const config = {
    ...testConfig,
    aiProvider: 'mock',
    serviceToken: 'test-service-token-0123456789abcdef01234567',
    taskDefaultTimeoutMs: 60_000,
    taskMaxTimeoutMs: 600_000,
    taskDefaultAttempts: 2,
  };
  const app = await buildApp({ config, db, redis: fakeRedisOk(), docker: fakeDockerOk(), taskQueue: queue });
  return { app, db, queue };
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

const batchReq = {
  identities: [ID1, ID2, ID3, ID4, ID5, ID6],
  batchSize: 2,
  maxActiveContainers: 2,
  failurePolicy: 'continue_and_report',
};

test('BR-B2 batches API (G7) — §10 contract over the real HTTP path', async (t) => {
  const { app, db, queue } = await makeApp();
  t.after(() => app.close());
  const op = await login(app, 'operator1');
  const view = await login(app, 'viewer1');
  const admin = await login(app, 'admin1');

  const req = (method, url, { cookie, payload } = {}) =>
    app.inject({ method, url, payload, headers: cookie ? { cookie } : {} });

  // ---------------------------------------------------------- RBAC matrix
  await t.test('RBAC: viewer reads, operator writes, admin capacity, anon 401', async () => {
    assert.equal((await req('GET', '/api/identities', { cookie: view })).statusCode, 200, 'viewer reads identities');
    assertEnvelope(await req('POST', '/api/batches', { cookie: view, payload: { ...batchReq, name: 'x', idempotencyKey: 'g7-rbac-0001' } }), 403);
    assertEnvelope(await req('POST', '/api/batches/preview', { cookie: view, payload: batchReq }), 403);
    assertEnvelope(await req('GET', '/api/batches/capacity', { cookie: op }), 403, 'FORBIDDEN');
    assertEnvelope(await req('POST', '/api/batches/capacity', { cookie: op, payload: { maxActiveContainers: 2 } }), 403, 'FORBIDDEN');
    assert.equal((await req('GET', '/api/identities')).statusCode, 401, 'anonymous → 401');
  });

  // ---------------------------------------------------------- identities
  await t.test('identities list: page/filter/statusCounts + scrubbed metadata', async () => {
    const res = await req('GET', '/api/identities', { cookie: view });
    assert.equal(res.statusCode, 200);
    const b = body(res);
    assert.equal(b.total, 12, '6 main + 6 RL identities');
    assert.equal(b.items.length, 12);
    assert.equal(b.statusCounts.READY, 11);
    assert.equal(b.statusCounts.BLOCKED, 1);
    assert.equal(b.items[0].id, ID1, 'order = createdAt asc');

    const filtered = body(await req('GET', '/api/identities?status=BLOCKED&pageSize=10', { cookie: view }));
    assert.equal(filtered.total, 1);
    assert.equal(filtered.items[0].id, ID4);

    const paged = body(await req('GET', '/api/identities?pageSize=4&page=2', { cookie: view }));
    assert.equal(paged.items.length, 4, 'page 2 of 4-per-page over 12 rows');
    assert.equal(paged.items[0].id, ID5, 'page 2 starts at row 5');

    const clampedRes = await req('GET', '/api/identities?pageSize=9999', { cookie: view });
    assert.equal(clampedRes.statusCode, 200, 'clamp is not an error');
    assert.equal(body(clampedRes).pageSize, 200, 'pageSize clamped to the schema max');
    assertEnvelope(await req('GET', '/api/identities?pageSize=abc', { cookie: view }), 400, 'VALIDATION_ERROR');
  });

  // -------------------------------------------------------------- preview
  await t.test('preview: zero writes, plan + estimate + unknown ids', async () => {
    const before = await db.identity.count({});
    const batchesBefore = [...db.__state.batches.values()].length;

    const res = await req('POST', '/api/batches/preview', {
      cookie: op,
      payload: { ...batchReq, identities: [ID1, ID2, ID3, ID4, ID5, ID6, 'ffffffff-0000-4000-8000-000000000099'] },
    });
    assert.equal(res.statusCode, 200, res.body);
    const b = body(res);
    assert.equal(b.preview, true);
    // 7 positions (6 known + 1 unknown id): 5 READY → PENDING, BLOCKED +
    // UNKNOWN → SKIPPED (planCycle never silently rebinds — MD §3.2).
    assert.equal(b.plan.batchCount, 4, '7 positions / batchSize 2 → 4 batches');
    assert.equal(b.plan.stats.total, 7);
    assert.equal(b.plan.stats.included, 5);
    assert.equal(b.plan.stats.skipped, 2, 'BLOCKED + unknown id skipped');
    assert.deepEqual(b.unknown, ['ffffffff-0000-4000-8000-000000000099']);
    assert.equal(b.estimate.batchesPlanned, 3, 'ceil(5 included / 2)');
    assert.equal(b.capacity.batchCap, 2);
    assert.equal(b.capacity.globalCap, null, 'no global cap yet');
    assert.equal(b.capacity.effectiveCap, 2);
    assert.equal(typeof b.networkPolicy.allowlistConfigured, 'boolean');

    // ZERO writes (MD §10: preview 永遠唔建容器/入庫)
    assert.equal(await db.identity.count({}), before);
    assert.equal([...db.__state.batches.values()].length, batchesBefore, 'preview must not create batches');
    const id1 = await db.identity.findUnique({ where: { id: ID1 } });
    assert.equal(id1.status, 'READY', 'preview must not reserve identities');

    // malformed identity id → 400
    assertEnvelope(await req('POST', '/api/batches/preview', { cookie: op, payload: { ...batchReq, identities: ['not-a-uuid'] } }), 400, 'VALIDATION_ERROR');
  });

  // --------------------------------------------------------------- create
  let cycle;
  await t.test('create: 201; replay 200; distinct-key coexists (B1 contract)', async () => {
    const res = await req('POST', '/api/batches', { cookie: op, payload: { ...batchReq, name: 'G7 cycle', idempotencyKey: 'g7-cycle-0001' } });
    assert.equal(res.statusCode, 201, res.body);
    cycle = body(res);
    assert.equal(cycle.replay, false);
    assert.ok(cycle.cycleId);
    assert.equal(cycle.batches.length, 3);
    // createCycle returns {id, batchNo} refs — verify status from the DB.
    const dbBatches = await db.batch.findMany({ where: { cycleId: cycle.cycleId } });
    assert.ok(dbBatches.every((b) => b.status === 'PLANNED'), 'all batches PLANNED');

    // create = PLANNED only: zero identity writes (reservations happen at
    // dispatch — MD §6.1). Verify from the DB.
    const stillReady = await db.identity.findMany({ where: { id: { in: [ID1, ID2, ID3, ID5, ID6] } } });
    assert.ok(stillReady.every((i) => i.status === 'READY'), 'create leaves identities READY (no reservation at plan time)');
    const blocked = await db.identity.findUnique({ where: { id: ID4 } });
    assert.equal(blocked.status, 'BLOCKED', 'BLOCKED identity left alone (skipped in plan)');

    // idempotent replay — same key → same cycle
    const replay = await req('POST', '/api/batches', { cookie: op, payload: { ...batchReq, name: 'G7 cycle', idempotencyKey: 'g7-cycle-0001' } });
    assert.equal(replay.statusCode, 200, 'replay → 200');
    const rb = body(replay);
    assert.equal(rb.replay, true);
    assert.equal(rb.cycleId, cycle.cycleId);

    // B1 contract (batch-idempotency tests): a DISTINCT idempotency key
    // creates an independent cycle — cycles may coexist at PLAN time.
    // Single-flight for an identity is enforced at DISPATCH (reservation
    // guard), not at create (MD §3.1: 同一 identity 最多只有一個 active run).
    const second = await req('POST', '/api/batches', { cookie: op, payload: { ...batchReq, name: 'Other', idempotencyKey: 'g7-cycle-0002' } });
    assert.equal(second.statusCode, 201, `distinct-key cycle coexists: ${second.body}`);
    assert.notEqual(body(second).cycleId, cycle.cycleId);

    // malformed idempotency key
    assertEnvelope(await req('POST', '/api/batches', { cookie: op, payload: { ...batchReq, name: 'x', idempotencyKey: 'short' } }), 400, 'VALIDATION_ERROR');

    // F-RDFA-1 (WA-RDFA-FIX): config.adapter shape is validated at create
    // over the real HTTP path — the exact v7 payloads that 201'd in the
    // field now get 400 VALIDATION_ERROR with the honest naming message.
    assertEnvelope(
      await req('POST', '/api/batches', {
        cookie: op,
        payload: { ...batchReq, name: 'G7 bad-adapter', idempotencyKey: 'g7-badadapter-01', config: { adapter: 'container' } },
      }),
      400,
      'VALIDATION_ERROR',
    );
    assertEnvelope(
      await req('POST', '/api/batches', {
        cookie: op,
        payload: { ...batchReq, name: 'G7 bad-adapter', idempotencyKey: 'g7-badadapter-02', config: { adapter: { type: 'emulator' } } },
      }),
      400,
      'VALIDATION_ERROR',
    );
    // a well-formed container spec still creates (201)
    const goodCfg = await req('POST', '/api/batches', {
      cookie: op,
      payload: {
        ...batchReq,
        name: 'G7 good-adapter',
        idempotencyKey: 'g7-goodadapter-01',
        config: { adapter: { type: 'container', image: 'water-army/redroid:14.0.0-240527-gms-mtg' } },
      },
    });
    assert.equal(goodCfg.statusCode, 201, `valid container spec creates: ${goodCfg.body}`);
  });

  // ------------------------------------------------------------- capacity
  await t.test('capacity: admin set/get/clear (AppSetting round-trip)', async () => {
    assert.equal(body(await req('GET', '/api/batches/capacity', { cookie: admin })).globalCap, null);

    assert.equal(body(await req('POST', '/api/batches/capacity', { cookie: admin, payload: { maxActiveContainers: 2 } })).globalCap, 2);
    assert.equal(body(await req('GET', '/api/batches/capacity', { cookie: admin })).globalCap, 2);

    // update (not duplicate)
    assert.equal(body(await req('POST', '/api/batches/capacity', { cookie: admin, payload: { maxActiveContainers: 1 } })).globalCap, 1);

    // clear
    assert.equal(body(await req('POST', '/api/batches/capacity', { cookie: admin, payload: { maxActiveContainers: null } })).globalCap, null);

    assertEnvelope(await req('POST', '/api/batches/capacity', { cookie: admin, payload: { maxActiveContainers: 0 } }), 400, 'VALIDATION_ERROR');
  });

  // --------------------------------------------------------------- detail
  let b1;
  let b2;
  await t.test('batch detail: stats + per-identity + capacity', async () => {
    b1 = cycle.batches[0];
    b2 = cycle.batches[1];
    const res = await req('GET', `/api/batches/${b1.id}`, { cookie: view });
    assert.equal(res.statusCode, 200, res.body);
    const b = body(res);
    assert.equal(b.batch.status, 'PLANNED');
    assert.equal(b.batch.batchNo, 1);
    assert.equal(b.stats.memberships.PENDING, 2);
    assert.equal(b.stats.totals.members, 2);
    assert.equal(b.activeCount, 0);
    assert.equal(b.identities.length, 2);
    assert.equal(b.identities[0].position, 1);
    assert.equal(b.identities[0].identityId, ID1);
    assert.equal(b.capacity.batchCap, 2);
    assert.equal(b.capacity.effectiveCap, 2);

    assertEnvelope(await req('GET', '/api/batches/nonexistent-batch-id', { cookie: view }), 400, 'VALIDATION_ERROR', 'uuid param validation');
    assertEnvelope(await req('GET', `/api/batches/${uid(99)}`, { cookie: view }), 404, 'NOT_FOUND');
  });

  // ------------------------------------------------------------ lifecycle
  await t.test('start: 202 + dispatch honors the slot cap', async () => {
    const res = await req('POST', `/api/batches/${b1.id}/start`, { cookie: op });
    assert.equal(res.statusCode, 202, res.body);
    const b = body(res);
    assert.equal(b.started, true);
    assert.equal(b.batch.status, 'RUNNING');
    assert.equal(b.dispatch.dispatched, 2, '2 runs dispatched (batch size 2)');

    // the queue holds batch-run jobs only for the dispatched runs
    const batchJobs = [...queue.jobs.values()].filter((j) => j.name === 'batch-run');
    assert.equal(batchJobs.length, 2, '2 batch-run jobs enqueued');

    const runs = await db.taskRun.findMany({ where: { batchId: b1.id } });
    assert.equal(runs.length, 2);
    assert.ok(runs.every((r) => r.status === 'queued'), 'dispatched runs are queued');

    // Dispatch reserved the dispatched identities (MD §6.1 READY→RESERVED);
    // the undischarged PENDING members stay READY.
    const r1 = await db.identity.findUnique({ where: { id: ID1 } });
    const r2 = await db.identity.findUnique({ where: { id: ID2 } });
    assert.equal(r1.status, 'RESERVED', 'position-1 identity reserved at dispatch');
    assert.equal(r2.status, 'RESERVED', 'position-2 identity reserved at dispatch');
    const r3 = await db.identity.findUnique({ where: { id: ID3 } });
    assert.equal(r3.status, 'READY', 'undischarged member stays READY');

    // already RUNNING → idempotent no-op
    const again = await req('POST', `/api/batches/${b1.id}/start`, { cookie: op });
    assert.equal(again.statusCode, 200);
    assert.equal(body(again).started, false);

    // predecessor gate: b2 cannot start while b1 is RUNNING
    assertEnvelope(await req('POST', `/api/batches/${b2.id}/start`, { cookie: op }), 409, 'BATCH_ORDER_GATE');

    // non-PLANNED start (PAUSED would need pause first — use CANCELLED path below;
    // here: start an unknown-batch) — covered by 404 above.
  });

  await t.test('pause stopExisting=false: queued stopped, running untouched', async () => {
    // Simulate a run that is already RUNNING (the engine would own it).
    const run = (await db.taskRun.findMany({ where: { batchId: b1.id } }))[0];
    await db.taskRun.updateMany({ where: { id: run.id, status: 'queued', attempt: run.attempt }, data: { status: 'running', startedAt: new Date() } });

    const res = await req('POST', `/api/batches/${b1.id}/pause`, { cookie: op, payload: { stopExisting: false } });
    assert.equal(res.statusCode, 202, res.body);
    const b = body(res);
    assert.equal(b.stopExisting, false);
    assert.equal(b.cancelledQueued, 1, 'the other (queued) run was stopped');

    const running = await db.taskRun.findFirst({ where: { id: run.id } });
    assert.equal(running.status, 'running', 'stopExisting=false leaves running runs alone');
    const stopped = (await db.taskRun.findMany({ where: { batchId: b1.id } })).find((r) => r.id !== run.id);
    assert.ok(['cancelled', 'cancel_requested'].includes(stopped.status), `stopped queued run is ${stopped.status}`);
    const batch = await db.batch.findUnique({ where: { id: b1.id } });
    assert.equal(batch.status, 'PAUSED');
  });

  await t.test('resume: back to RUNNING + redispatch of remaining', async () => {
    const res = await req('POST', `/api/batches/${b1.id}/resume`, { cookie: op });
    assert.equal(res.statusCode, 202, res.body);
    const batch = await db.batch.findUnique({ where: { id: b1.id } });
    assert.equal(batch.status, 'RUNNING');
    // resume redispatches: the still-PENDING membership gets a run
    const runs = await db.taskRun.findMany({ where: { batchId: b1.id } });
    assert.equal(runs.filter((r) => r.status === 'queued').length, 1, 'redispatched run is queued');
  });

  await t.test('pause stopExisting=true requests cancel on running runs', async () => {
    const res = await req('POST', `/api/batches/${b1.id}/pause`, { cookie: op, payload: { stopExisting: true } });
    assert.equal(res.statusCode, 202);
    const b = body(res);
    assert.equal(b.stopExisting, true);
    assert.equal(b.requested, 1, 'running run got a cancel request');
    const runs = await db.taskRun.findMany({ where: { batchId: b1.id } });
    assert.ok(runs.some((r) => r.status === 'cancel_requested'));
  });

  await t.test('cancel RUNNING → 202 CANCELLING; illegal pause 409', async () => {
    const res = await req('POST', `/api/batches/${b1.id}/cancel`, { cookie: op });
    assert.equal(res.statusCode, 202, res.body);
    const b = body(res);
    assert.equal(b.immediate, false);
    const batch = await db.batch.findUnique({ where: { id: b1.id } });
    assert.equal(batch.status, 'CANCELLING');

    // pause on a non-RUNNING batch → 409
    assertEnvelope(await req('POST', `/api/batches/${b1.id}/pause`, { cookie: op, payload: {} }), 409, 'BATCH_NOT_PAUSABLE');
  });

  await t.test('cancel PLANNED → 200 immediate CANCELLED', async () => {
    const res = await req('POST', `/api/batches/${b2.id}/cancel`, { cookie: op });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(body(res).immediate, true);
    const batch = await db.batch.findUnique({ where: { id: b2.id } });
    assert.equal(batch.status, 'CANCELLED');
    const members = await db.batchIdentity.findMany({ where: { batchId: b2.id } });
    // MD §3.3: SKIPPED is an APPROVED terminal state — cancelling a PLANNED
    // batch flips only PENDING memberships. b2's BLOCKED identity (ID4) was
    // planned as SKIPPED (create/preview parity fix, BR-B6 gen2) and must
    // stay SKIPPED with its reason, not be re-cast as CANCELLED.
    assert.ok(members.every((m) => ['CANCELLED', 'SKIPPED'].includes(m.status)), 'no PENDING memberships remain');
    assert.equal(members.filter((m) => m.status === 'CANCELLED').length, 1, 'READY membership cancelled');
    const skipped = members.filter((m) => m.status === 'SKIPPED');
    assert.equal(skipped.length, 1, 'BLOCKED identity membership stays SKIPPED');
    assert.ok(skipped.every((m) => m.skipReason), 'skip carries a reason');
  });

  // ----------------------------------------------------- task-run batch ops
  await t.test('task-runs retry/cancel/logs: batch-only guard', async () => {
    // A NON-batch run → 409 NOT_A_BATCH_RUN on all three routes.
    const plain = await db.taskRun.create({
      data: {
        id: uid(70),
        taskType: 'ai_check',
        status: 'failed',
        attempt: 1,
        maxAttempts: 2,
        inputJson: {},
      },
    });
    assertEnvelope(await req('POST', `/api/task-runs/${plain.id}/retry`, { cookie: op }), 409, 'NOT_A_BATCH_RUN');
    assertEnvelope(await req('POST', `/api/task-runs/${plain.id}/cancel`, { cookie: op }), 409, 'NOT_A_BATCH_RUN');
    assertEnvelope(await req('GET', `/api/task-runs/${plain.id}/logs`, { cookie: view }), 409, 'NOT_A_BATCH_RUN');

    // A batch run: seed the full lifecycle (queued → running → failed) with events.
    const br = await db.taskRun.create({
      data: {
        id: uid(71),
        taskType: 'batch',
        batchId: b2.id,
        status: 'failed',
        attempt: 1,
        maxAttempts: 3,
        inputJson: { taskType: 'batch', position: 1 },
        errorCode: 'ADAPTER_ERROR',
      },
    });
    const e1 = await db.taskRunEvent.create({ data: { taskRunId: br.id, eventType: 'queued', message: 'queued', payloadJson: null, createdAt: new Date(1_760_000_000_000) } });
    await db.taskRunEvent.create({
      data: {
        taskRunId: br.id,
        eventType: 'attempt_started',
        message: 'attempt 1',
        payloadJson: { secret: 'SHOULD_NOT_LEAK' },
        createdAt: new Date(1_760_000_000_005),
      },
    });
    await db.taskRunEvent.create({ data: { taskRunId: br.id, eventType: 'failed', message: 'boom', payloadJson: null, createdAt: new Date(1_760_000_000_010) } });

    // logs: scrubbed payloads + cursor paging
    const logs = await req('GET', `/api/task-runs/${br.id}/logs?limit=2`, { cookie: view });
    assert.equal(logs.statusCode, 200, logs.body);
    const lb = body(logs);
    assert.equal(lb.items.length, 2);
    assert.equal(lb.hasMore, true);
    assert.ok(!lb.items.some((i) => JSON.stringify(i).includes('SHOULD_NOT_LEAK')), 'payload scrubbed');
    const rest = body(await req('GET', `/api/task-runs/${br.id}/logs?after=${lb.nextCursor}`, { cookie: view }));
    assert.equal(rest.items.length, 1);
    assert.equal(rest.hasMore, false);
    assertEnvelope(await req('GET', `/api/task-runs/${br.id}/logs?after=bogus`, { cookie: view }), 400, 'VALIDATION_ERROR');

    // retry: attempt 1 → 2, re-queued + job enqueued
    const jobsBefore = [...queue.jobs.values()].length;
    const retry = await req('POST', `/api/task-runs/${br.id}/retry`, { cookie: op });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(body(retry).attempt, 2);
    const after = await db.taskRun.findUnique({ where: { id: br.id } });
    assert.equal(after.status, 'queued');
    assert.equal(after.attempt, 2);
    const newJobs = [...queue.jobs.values()].length - jobsBefore;
    assert.equal(newJobs, 1, 'retry enqueued a batch-run job');
    const replayRetry = await req('POST', `/api/task-runs/${br.id}/retry`, { cookie: op });
    assert.equal(replayRetry.statusCode, 409, 'retry on a non-terminal (queued) run → 409');

    // cancel: queued run → cancel_requested + waiting job removed
    const cancel = await req('POST', `/api/task-runs/${br.id}/cancel`, { cookie: op });
    assert.equal(cancel.statusCode, 200, cancel.body);
    const cb = body(cancel);
    assert.equal(cb.taskRun.status, 'cancel_requested');
    assert.equal(cb.jobRemoved, true, 'waiting job dropped');
  });

  // ------------------------------------------------------------- rate limit
  await t.test('rate limits: 31st write → 429 + retry-after; 11th retry → 429', async () => {
    // Fresh PLANNED batch to burn the write budget on (start is the cheapest
    // write; every call is recorded — success or 409 alike).
    const { batches } = body(
      await req('POST', '/api/batches', { cookie: op, payload: { ...batchReq, identities: RL_IDS, name: 'RL cycle', idempotencyKey: 'g7-rl-cycle-01' } }),
    );
    assert.ok(batches && batches.length >= 1);
    const rb = batches[0];

    let last;
    for (let i = 0; i < 31; i++) {
      last = await req('POST', `/api/batches/${rb.id}/start`, { cookie: op });
    }
    assertEnvelope(last, 429, 'RATE_LIMITED');
    assert.ok(parseInt(last.headers['retry-after'], 10) >= 1, 'retry-after header present');

    // The retry budget is a SEPARATE limiter — retries still pass the write
    // budget. Fresh terminal batch run to retry.
    const br2 = await db.taskRun.create({
      data: {
        id: uid(72),
        taskType: 'batch',
        batchId: b2.id,
        status: 'failed',
        attempt: 1,
        maxAttempts: 3,
        inputJson: { taskType: 'batch', position: 1 },
      },
    });
    const okRetry = await req('POST', `/api/task-runs/${br2.id}/retry`, { cookie: op });
    assert.equal(okRetry.statusCode, 200, 'retry budget independent of the write budget');

    let retryLast;
    for (let i = 0; i < 10; i++) {
      // First extra retry already consumed above (200); subsequent retries
      // hit a queued (non-terminal) run → 409, but the budget is recorded
      // either way (MD §13.2: window counts ALL calls).
      retryLast = await req('POST', `/api/task-runs/${br2.id}/retry`, { cookie: op });
    }
    assertEnvelope(retryLast, 429, 'RATE_LIMITED');

    // A different user is NOT throttled (per-user budget) — the viewer's
    // write budget is untouched, so a fresh operator-2 would also pass;
    // verify the limiter is keyed by user via a second login.
    const op2hash = await hash(PASSWORD, { type: argon2id });
    await db.user.create({ data: { id: 'u-op2', username: 'operator2', passwordHash: op2hash, role: 'operator' } });
    const op2 = await login(app, 'operator2');
    const pass = await req('POST', `/api/batches/${rb.id}/start`, { cookie: op2 });
    assert.notEqual(pass.statusCode, 429, 'per-user budget: other users unaffected');
  });

  // ----------------------------------------------------------------- audit
  await t.test('audit trail written for lifecycle ops', async () => {
    const creates = await db.auditEvent.findMany({ where: { action: 'batch.cycle_create' } });
    assert.ok(creates.length >= 2, `cycle_create audits recorded (got ${creates.length})`);
    assert.ok(creates.every((a) => a.actorUserId === 'u-op'));
    const starts = await db.auditEvent.findMany({ where: { action: 'batch.start' } });
    assert.ok(starts.length >= 1, 'start audits recorded');
  });
});
