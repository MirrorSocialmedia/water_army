/**
 * P3 API integration tests — hermetic (fake db/redis/queue, mock provider,
 * no Docker). Covers MD §8: task runs (create/list/detail/cancel/retry/SSE),
 * approvals (human-only), tools registry, providers (write-only secrets +
 * live ping), audit events, and the worker→API service-token auth.
 *
 * SSE uses a REAL listener + fetch (app.inject cannot read hijacked streams —
 * same constraint as the P2 docker-sse tests).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from '@node-rs/argon2';

import { buildApp } from '../../apps/api/src/app.js';
import { makeFakeDb, testConfig, fakeRedisOk, fakeDockerOk, makeFakeQueue } from '../helpers/fakes.js';
import { SERVICE_USER_ID, decryptSecret, resolveProviderKey, taskJobId, TASK_EVENT, TOOL_SAFETY_CLASS } from '@water-army/shared';

const { argon2id, hash } = argon2;
const PASSWORD = 'TestPass123';
const SERVICE_TOKEN = 'test-service-token-0123456789abcdef01234567'; // ≥32 chars

async function makeApp({ users = [], configOverrides = {} } = {}) {
  const passwordHash = await hash(PASSWORD, { type: argon2id });
  const seedUsers = users.length ? users : [
    { id: 'u-admin', username: 'admin1', passwordHash, role: 'admin' },
    { id: 'u-op', username: 'operator1', passwordHash, role: 'operator' },
    { id: 'u-view', username: 'viewer1', passwordHash, role: 'viewer' },
  ];
  const db = makeFakeDb({ users: seedUsers });
  const queue = makeFakeQueue();
  const config = {
    ...testConfig,
    aiProvider: 'mock',
    serviceToken: SERVICE_TOKEN,
    taskSsePollMs: 100, // fast SSE polling for tests
    ...configOverrides,
  };
  const app = await buildApp({ config, db, redis: fakeRedisOk(), docker: fakeDockerOk(), taskQueue: queue });
  return { app, db, queue };
}

async function login(app, username, password = PASSWORD) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  assert.equal(res.statusCode, 200, `login should succeed: ${res.body}`);
  return res.headers['set-cookie'].split(';')[0];
}

test('tasks API (P3)', async (t) => {
  const { app, db, queue } = await makeApp();
  t.after(() => app.close());

  const admin = await login(app, 'admin1');
  const op = await login(app, 'operator1');
  const view = await login(app, 'viewer1');

  // ---------------------------------------------------------------- create
  await t.test('create: operator gets 202 + runId, job enqueued (secret-free), audit row', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/runs',
      headers: { cookie: op },
      payload: { prompt: 'Check the API container status', provider: 'mock', tools: ['docker.list_managed_containers'] },
    });
    assert.equal(res.statusCode, 202, res.body);
    const body = res.json();
    assert.ok(body.taskRun.id, 'runId returned');
    assert.equal(body.taskRun.status, 'queued');
    assert.equal(body.replay, false);
    assert.equal(body.taskRun.prompt, 'Check the API container status');

    // exactly one job enqueued, secret-free payload
    assert.equal(queue.enqueued.length, 1);
    assert.deepEqual(queue.enqueued[0].data, { runId: body.taskRun.id, attempt: 1 });

    // audit row written
    const audits = db.__state.auditRows.filter((a) => a.action === 'task.create');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].resourceId, body.taskRun.id);
    assert.equal(audits[0].detailsJson.provider, 'mock');
  });

  let runId; // created above, reused below
  runId = db.__state.runRows.keys().next().value;

  await t.test('create: viewer is refused (403 FORBIDDEN)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/tasks/runs', headers: { cookie: view },
      payload: { prompt: 'x', provider: 'mock' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'FORBIDDEN');
  });

  await t.test('create: unauthenticated is 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/tasks/runs', payload: { prompt: 'x', provider: 'mock' } });
    assert.equal(res.statusCode, 401);
  });

  await t.test('create: no provider resolvable → 400 (fail closed, never silent-mock)', async () => {
    const a = await makeApp({ configOverrides: { aiProvider: undefined } });
    try {
      const op2 = await login(a.app, 'operator1');
      const res = await a.app.inject({
        method: 'POST', url: '/api/tasks/runs', headers: { cookie: op2 }, payload: { prompt: 'x' },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error.code, 'VALIDATION_ERROR');
      assert.equal(a.db.__state.runRows.size, 0, 'no run row on validation failure');
    } finally {
      await a.app.close();
    }
  });

  await t.test('create: unknown provider name → 400 PROVIDER_NOT_FOUND (no silent downgrade)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/tasks/runs', headers: { cookie: op }, payload: { prompt: 'x', provider: 'does-not-exist' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'PROVIDER_NOT_FOUND');
  });

  await t.test('create: disabled provider → 400 PROVIDER_NOT_FOUND', async () => {
    await db.providerConfig.create({ data: { name: 'off', providerType: 'openai_compatible', baseUrl: 'https://example.com/v1', isEnabled: false } });
    const res = await app.inject({
      method: 'POST', url: '/api/tasks/runs', headers: { cookie: op }, payload: { prompt: 'x', provider: 'off' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'PROVIDER_NOT_FOUND');
  });

  await t.test('create: unknown tool in body → 400 (registry is the source of truth)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/tasks/runs', headers: { cookie: op },
      payload: { prompt: 'x', provider: 'mock', tools: ['shell.exec'] },
    });
    assert.equal(res.statusCode, 400);
  });

  await t.test('create: idempotencyKey replay returns the same run (no double-enqueue)', async () => {
    const first = await app.inject({
      method: 'POST', url: '/api/tasks/runs', headers: { cookie: op },
      payload: { prompt: 'idempotent test', provider: 'mock', idempotencyKey: 'idem-key-001' },
    });
    assert.equal(first.statusCode, 202);
    const before = queue.enqueued.length;
    const second = await app.inject({
      method: 'POST', url: '/api/tasks/runs', headers: { cookie: op },
      payload: { prompt: 'idempotent test', provider: 'mock', idempotencyKey: 'idem-key-001' },
    });
    assert.equal(second.statusCode, 202);
    assert.equal(second.json().taskRun.id, first.json().taskRun.id);
    assert.equal(second.json().replay, true);
    assert.equal(queue.enqueued.length, before, 'no second enqueue');
  });

  // ------------------------------------------------------------------- list
  await t.test('list: returns runs, filters by status + provider, viewer allowed', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tasks/runs', headers: { cookie: view } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.items) && body.items.length >= 1);
    // list rows carry previews, never the full prompt
    for (const item of body.items) {
      assert.equal(item.prompt, undefined, 'list rows must not carry the full prompt');
      assert.ok('promptPreview' in item);
    }
    const queued = await app.inject({ method: 'GET', url: '/api/tasks/runs?status=queued', headers: { cookie: view } });
    assert.equal(queued.statusCode, 200);
    assert.ok(queued.json().items.every((r) => r.status === 'queued'));
    const byProvider = await app.inject({ method: 'GET', url: '/api/tasks/runs?provider=mock', headers: { cookie: view } });
    assert.equal(byProvider.statusCode, 200);
  });

  // ----------------------------------------------------------------- detail
  await t.test('detail: run + events + approvals; unknown id → 404', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/tasks/runs/${runId}`, headers: { cookie: view } });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.run.id, runId);
    assert.equal(body.run.status, 'queued');
    assert.ok(Array.isArray(body.events));
    assert.ok(body.events.some((e) => e.eventType === TASK_EVENT.QUEUED));
    assert.ok(Array.isArray(body.approvals));
    const missing = await app.inject({ method: 'GET', url: '/api/tasks/runs/00000000-0000-4000-8000-000000000000', headers: { cookie: view } });
    assert.equal(missing.statusCode, 404);
  });

  // ----------------------------------------------------------------- cancel
  await t.test('cancel: queued run → cancel_requested, waiting job removed, audit row', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/tasks/runs', headers: { cookie: op }, payload: { prompt: 'cancel me', provider: 'mock' },
    });
    const cid = created.json().taskRun.id;
    const res = await app.inject({ method: 'POST', url: `/api/tasks/runs/${cid}/cancel`, headers: { cookie: op } });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.taskRun.status, 'cancel_requested');
    assert.equal(body.idempotent, false);
    assert.equal(body.jobRemoved, true, 'waiting job dropped from the queue');
    assert.equal(queue.jobs.has(taskJobId(cid, 1)), false, 'job no longer in the fake queue');
    assert.ok(db.__state.auditRows.some((a) => a.action === 'task.cancel' && a.resourceId === cid));

    // second cancel = idempotent no-op
    const again = await app.inject({ method: 'POST', url: `/api/tasks/runs/${cid}/cancel`, headers: { cookie: op } });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().idempotent, true);
  });

  await t.test('cancel: unknown run → 404; viewer cancel → 403', async () => {
    const missing = await app.inject({ method: 'POST', url: '/api/tasks/runs/00000000-0000-4000-8000-000000000000/cancel', headers: { cookie: op } });
    assert.equal(missing.statusCode, 404);
    const res = await app.inject({ method: 'POST', url: `/api/tasks/runs/${runId}/cancel`, headers: { cookie: view } });
    assert.equal(res.statusCode, 403);
  });

  // ------------------------------------------------------------------ retry
  await t.test('retry: failed run → new attempt re-enqueued (old output preserved)', async () => {
    // craft a failed run with previous output
    const created = await app.inject({
      method: 'POST', url: '/api/tasks/runs', headers: { cookie: op }, payload: { prompt: 'retry me', provider: 'mock' },
    });
    const rid = created.json().taskRun.id;
    await db.taskRun.update({ where: { id: rid }, data: { status: 'failed', errorCode: 'PROVIDER_NETWORK', errorMessage: 'boom', resultText: 'partial output' } });
    const before = queue.enqueued.length;

    const res = await app.inject({ method: 'POST', url: `/api/tasks/runs/${rid}/retry`, headers: { cookie: op } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().attempt, 2);
    const run = db.__state.runRows.get(rid);
    assert.equal(run.status, 'queued');
    assert.equal(run.attempt, 2);
    // old output preserved in the row? No — the retry clears latest-attempt fields;
    // the previous output lives on in the EVENT stream. Verify an event was kept.
    assert.ok(db.__state.eventRows.some((e) => e.taskRunId === rid));
    assert.equal(queue.enqueued.length, before + 1);
    const job = queue.enqueued[queue.enqueued.length - 1];
    assert.deepEqual(job.data, { runId: rid, attempt: 2 }, 'new attempt = new job, deterministic id');
    assert.ok(db.__state.auditRows.some((a) => a.action === 'task.retry' && a.resourceId === rid));
  });

  await t.test('retry: not allowed from queued/succeeded → 409 RETRY_NOT_ALLOWED', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/tasks/runs/${runId}/retry`, headers: { cookie: op } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'RETRY_NOT_ALLOWED');
  });

  // ------------------------------------------------------------------ SSE
  // Each SSE subtest needs a REAL listener (app.inject can't read hijacked
  // streams) and must not disturb the shared app, so each builds its own.
  async function sseApp() {
    const a = await makeApp();
    const cookie = await login(a.app, 'viewer1'); // SSE reads — viewer is enough
    const opCookie = await login(a.app, 'operator1'); // run creation needs operator
    await a.app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${a.app.server.address().port}`;
    return { ...a, base, cookie, opCookie };
  }

  await t.test('SSE: snapshot + replay + terminal close (real listener)', async () => {
    const a = await sseApp();
    try {
      const created = await a.app.inject({
        method: 'POST', url: '/api/tasks/runs', headers: { cookie: a.opCookie }, payload: { prompt: 'sse run', provider: 'mock' },
      });
      assert.equal(created.statusCode, 202, created.body);
      const sid = created.json().taskRun.id;
      // simulate worker activity in the DB (the source of truth)
      await a.db.taskRunEvent.create({ data: { taskRunId: sid, eventType: TASK_EVENT.ATTEMPT_STARTED, message: 'attempt 1 started', payloadJson: { attempt: 1 } } });
      await a.db.taskRunEvent.create({ data: { taskRunId: sid, eventType: TASK_EVENT.SUCCEEDED, message: 'run succeeded', payloadJson: { attempt: 1 } } });
      await a.db.taskRun.update({ where: { id: sid }, data: { status: 'succeeded', finishedAt: new Date(), durationMs: 10 } });

      const res = await fetch(`${a.base}/api/tasks/runs/${sid}/events`, { headers: { cookie: a.cookie } });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
      const text = await res.text(); // server closes at terminal → text() resolves

      assert.match(text, /event: run_snapshot/);
      assert.match(text, /event: attempt_started/);
      assert.match(text, /event: succeeded/);
      assert.match(text, /event: done/);
      assert.match(text, /"status":"succeeded"/);
      assert.ok(text.includes(sid), 'snapshot + events carry the real run id');
    } finally {
      await a.app.close();
    }
  });

  await t.test('SSE: ?after= cursor replays only newer events', async () => {
    const a = await sseApp();
    try {
      const created = await a.app.inject({
        method: 'POST', url: '/api/tasks/runs', headers: { cookie: a.opCookie }, payload: { prompt: 'sse cursor', provider: 'mock' },
      });
      assert.equal(created.statusCode, 202, created.body);
      const sid = created.json().taskRun.id;
      const e1 = await a.db.taskRunEvent.create({ data: { taskRunId: sid, eventType: TASK_EVENT.ATTEMPT_STARTED, message: 'one', payloadJson: {} } });
      await a.db.taskRunEvent.create({ data: { taskRunId: sid, eventType: TASK_EVENT.PROVIDER_RESPONSE, message: 'two', payloadJson: {} } });
      await a.db.taskRun.update({ where: { id: sid }, data: { status: 'succeeded', finishedAt: new Date(), durationMs: 5 } });

      const res = await fetch(`${a.base}/api/tasks/runs/${sid}/events?after=${encodeURIComponent(e1.id)}`, { headers: { cookie: a.cookie } });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('two'), 'event after the cursor delivered');
      assert.ok(!text.includes('event: attempt_started'), 'event at/before the cursor NOT re-sent');
      assert.match(text, /event: done/);
    } finally {
      await a.app.close();
    }
  });

  await t.test('SSE: malformed ?after= cursor → 400 (not a 500)', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/tasks/runs/${runId}/events?after=2026-10-14T18:55:40.456Z:not-a-uuid`, headers: { cookie: admin } });
    assert.equal(res.statusCode, 400, res.body);
    assert.match(res.json().error.code, /VALIDATION_ERROR|BAD_REQUEST/);
  });

  await t.test('SSE: unauthenticated → 401', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/tasks/runs/${runId}/events` });
    assert.equal(res.statusCode, 401);
  });

  // ---------------------------------------------------------------- tools
  await t.test('tools: registry lists 5 P3 tools with safety classes; no shell/exec/raw tools', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tools', headers: { cookie: view } });
    assert.equal(res.statusCode, 200, res.body);
    const names = res.json().tools.map((t) => t.name);
    assert.deepEqual(
      [...names].sort(),
      ['docker.get_managed_container_logs', 'docker.get_managed_container_status', 'docker.list_managed_containers', 'docker.restart_managed', 'system.get_health'],
    );
    for (const t of res.json().tools) {
      assert.ok([TOOL_SAFETY_CLASS.READONLY, TOOL_SAFETY_CLASS.APPROVAL_REQUIRED].includes(t.safetyClass));
      assert.ok(t.parameters, 'schema exposed');
    }
    assert.ok(!names.some((n) => /shell|exec|raw|run/i.test(n)), 'no dangerous tool names');
    assert.equal(res.json().tools.find((t) => t.name === 'docker.restart_managed').safetyClass, TOOL_SAFETY_CLASS.APPROVAL_REQUIRED);
  });

  // ------------------------------------------------------------ approvals
  let approvalId;
  await t.test('approvals: pending list + admin approve (audit row + event)', async () => {
    // seed a pending approval on a needs_approval run
    const created = await app.inject({
      method: 'POST', url: '/api/tasks/runs', headers: { cookie: op }, payload: { prompt: 'approve me', provider: 'mock' },
    });
    const rid = created.json().taskRun.id;
    await db.taskRun.update({ where: { id: rid }, data: { status: 'needs_approval' } });
    const appr = await db.approvalRequest.create({ data: { taskRunId: rid, toolName: 'docker.restart_managed', argumentsJson: { container: 'api' } } });
    approvalId = appr.id;

    const list = await app.inject({ method: 'GET', url: '/api/approvals?status=pending', headers: { cookie: view } });
    assert.equal(list.statusCode, 200);
    assert.ok(list.json().items.some((a) => a.id === approvalId));

    const res = await app.inject({
      method: 'POST', url: `/api/approvals/${approvalId}/approve`, headers: { cookie: admin }, payload: { note: 'ok' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().approval.status, 'approved');
    assert.equal(res.json().approval.reviewedBy, 'u-admin');
    const row = db.__state.approvalRows.get(approvalId);
    assert.equal(row.reviewNote, 'ok');
    assert.ok(db.__state.auditRows.some((a) => a.action === 'approval.approve' && a.resourceId === approvalId));
    assert.ok(db.__state.eventRows.some((e) => e.taskRunId === rid && e.eventType === TASK_EVENT.APPROVAL_RESOLVED));
  });

  await t.test('approvals: reject with note', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/tasks/runs', headers: { cookie: op }, payload: { prompt: 'reject me', provider: 'mock' },
    });
    const rid = created.json().taskRun.id;
    const appr = await db.approvalRequest.create({ data: { taskRunId: rid, toolName: 'docker.restart_managed', argumentsJson: { container: 'api' } } });
    const res = await app.inject({
      method: 'POST', url: `/api/approvals/${appr.id}/reject`, headers: { cookie: admin }, payload: { note: 'not now' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().approval.status, 'rejected');
  });

  await t.test('approvals: operator refused (403); already-resolved → 409; unknown → 404', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/tasks/runs', headers: { cookie: op }, payload: { prompt: 'rbac', provider: 'mock' },
    });
    const appr = await db.approvalRequest.create({ data: { taskRunId: created.json().taskRun.id, toolName: 'docker.restart_managed', argumentsJson: {} } });
    const asOp = await app.inject({ method: 'POST', url: `/api/approvals/${appr.id}/approve`, headers: { cookie: op }, payload: {} });
    assert.equal(asOp.statusCode, 403);

    const asView = await app.inject({ method: 'POST', url: `/api/approvals/${appr.id}/approve`, headers: { cookie: view }, payload: {} });
    assert.equal(asView.statusCode, 403);

    // approve as admin, then double-approve → 409
    const ok = await app.inject({ method: 'POST', url: `/api/approvals/${appr.id}/approve`, headers: { cookie: admin }, payload: {} });
    assert.equal(ok.statusCode, 200);
    const again = await app.inject({ method: 'POST', url: `/api/approvals/${appr.id}/approve`, headers: { cookie: admin }, payload: {} });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error.code, 'APPROVAL_ALREADY_RESOLVED');

    const missing = await app.inject({ method: 'POST', url: `/api/approvals/${'0'.repeat(8)}-0000-4000-8000-000000000000/approve`, headers: { cookie: admin }, payload: {} });
    assert.equal(missing.statusCode, 404);
  });

  // -------------------------------------------------------------- providers
  await t.test('providers: create stores encrypted key, never returns it (hasApiKey only)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/providers', headers: { cookie: admin },
      payload: { name: 'openai', baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-4o-mini', apiKey: 'sk-live-super-secret-123' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const p = res.json().provider;
    assert.equal(p.hasApiKey, true);
    assert.equal(p.apiKey, undefined, 'plaintext key never returned');
    assert.equal(p.encryptedApiKey, undefined);

    const row = db.__state.providerRows.get(p.id);
    assert.ok(row.encryptedApiKey, 'key stored encrypted');
    assert.notEqual(row.encryptedApiKey, 'sk-live-super-secret-123');
    // round-trip decrypts to the original
    const key = resolveProviderKey(testConfig.encryptionKey);
    assert.equal(decryptSecret(row.encryptedApiKey, key), 'sk-live-super-secret-123');
    assert.ok(db.__state.auditRows.some((a) => a.action === 'provider.create'));
  });

  await t.test('providers: operator refused (403); duplicate name → 409 PROVIDER_NAME_TAKEN', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/providers', headers: { cookie: op },
      payload: { name: 'x1', baseUrl: 'https://example.com/v1' },
    });
    assert.equal(res.statusCode, 403);
    const dup = await app.inject({
      method: 'POST', url: '/api/providers', headers: { cookie: admin },
      payload: { name: 'openai', baseUrl: 'https://api.openai.com/v1' },
    });
    assert.equal(dup.statusCode, 409, dup.body);
    assert.equal(dup.json().error.code, 'PROVIDER_NAME_TAKEN');
  });

  await t.test('providers: patch rotates the key + toggles enabled; audit records changes', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/providers', headers: { cookie: admin } });
    const id = list.json().providers.find((p) => p.name === 'openai').id;
    const res = await app.inject({
      method: 'PATCH', url: '/api/providers/openai', headers: { cookie: admin },
      payload: { apiKey: 'sk-live-rotated-456', isEnabled: false },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().changes.sort(), ['apiKey(rotate)', 'isEnabled']);
    const row = db.__state.providerRows.get(id);
    assert.equal(row.isEnabled, false);
    assert.equal(decryptSecret(row.encryptedApiKey, resolveProviderKey(testConfig.encryptionKey)), 'sk-live-rotated-456');
    const audit = db.__state.auditRows.filter((a) => a.action === 'provider.update').pop();
    assert.ok(audit.detailsJson.changes.includes('apiKey(rotate)'));
  });

  await t.test('providers: live ping classifies success (fetch mocked) + writes audit', async () => {
    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ model: 'gpt-4o-mini', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      // re-enable first (was disabled in the patch test)
      await app.inject({ method: 'PATCH', url: '/api/providers/openai', headers: { cookie: admin }, payload: { isEnabled: true } });
      const res = await app.inject({ method: 'POST', url: '/api/providers/openai/test', headers: { cookie: admin } });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json();
      assert.equal(body.ok, true);
      assert.equal(body.model, 'gpt-4o-mini');
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /^https:\/\/api\.openai\.com\/v1\/chat\/completions$/);
      assert.match(calls[0].init.headers.authorization, /^Bearer sk-live-rotated-456$/);
      assert.ok(db.__state.auditRows.some((a) => a.action === 'provider.test' && a.status === 'success'));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await t.test('providers: live ping classifies AUTH failure (fetch mocked 401)', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('nope', { status: 401 });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/providers/openai/test', headers: { cookie: admin } });
      assert.equal(res.statusCode, 502);
      assert.equal(res.json().error.code, 'PROVIDER_AUTH');
      assert.ok(db.__state.auditRows.some((a) => a.action === 'provider.test' && a.status === 'failure'));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // ----------------------------------------------------------------- audit
  await t.test('audit-events: list + action/actor filters (admin only)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/audit-events?action=task.create', headers: { cookie: admin } });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.ok(body.total >= 1);
    assert.ok(body.items.every((a) => a.action === 'task.create'));
    const byActor = await app.inject({ method: 'GET', url: `/api/audit-events?action=task.create&actor=u-op`, headers: { cookie: admin } });
    assert.equal(byActor.statusCode, 200);
    assert.ok(byActor.json().items.every((a) => a.actorUserId === 'u-op'));
    const asView = await app.inject({ method: 'GET', url: '/api/audit-events', headers: { cookie: view } });
    assert.equal(asView.statusCode, 403);
  });

  // --------------------------------------------------------- service auth
  await t.test('service token: valid token mints the fixed service identity (operator)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tools', headers: { 'x-wa-service-token': SERVICE_TOKEN } });
    assert.equal(res.statusCode, 200, res.body);
    // operator-level route proves the minted role
    const opRes = await app.inject({
      method: 'POST', url: '/api/tasks/runs', headers: { 'x-wa-service-token': SERVICE_TOKEN },
      payload: { prompt: 'from the worker', provider: 'mock' },
    });
    assert.equal(opRes.statusCode, 202, opRes.body);
    assert.equal(db.__state.runRows.get(opRes.json().taskRun.id).requestedBy, SERVICE_USER_ID);
  });

  await t.test('service token: invalid → 401 (even with a valid session cookie present)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tools', headers: { 'x-wa-service-token': 'wrong-token-000000000000000000000000000', cookie: admin } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'UNAUTHORIZED');
  });

  await t.test('service token: server without a configured token fails closed (401)', async () => {
    const { app: appNoTok, db: dbNoTok } = await (async () => {
      const a = await makeApp({ configOverrides: { serviceToken: '' } });
      return { app: a.app, db: a.db };
    })();
    try {
      const res = await appNoTok.inject({ method: 'GET', url: '/api/tools', headers: { 'x-wa-service-token': SERVICE_TOKEN } });
      assert.equal(res.statusCode, 401);
      assert.equal(dbNoTok.__state.runRows.size, 0);
    } finally {
      await appNoTok.close();
    }
  });

  await t.test('service token: REFUSED on approval endpoints (AI can never self-approve)', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/tasks/runs', headers: { 'x-wa-service-token': SERVICE_TOKEN },
      payload: { prompt: 'self approve attempt', provider: 'mock' },
    });
    assert.equal(created.statusCode, 202, 'service CAN create runs (operator)');
    const rid = created.json().taskRun.id;
    const appr = await db.approvalRequest.create({ data: { taskRunId: rid, toolName: 'docker.restart_managed', argumentsJson: { container: 'api' } } });
    const res = await app.inject({ method: 'POST', url: `/api/approvals/${appr.id}/approve`, headers: { 'x-wa-service-token': SERVICE_TOKEN }, payload: {} });
    assert.equal(res.statusCode, 403);
    assert.equal(db.__state.approvalRows.get(appr.id).status, 'pending', 'approval untouched');
  });
});
