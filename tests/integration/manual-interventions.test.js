/**
 * MC P4 (Mobile Console MD Phase 4 / §8.2) — manual-intervention API +
 * production signal wiring, hermetic integration (mock redroid environment,
 * REAL service + route code).
 *
 * Proves the MD contract end-to-end at the HTTP layer:
 *  - RBAC: unauthenticated 401; viewer read-only; operator+ for the state
 *    machine + controlled signal creation (MD §11.2)
 *  - the create contract: device existence (404), task-run scope (409),
 *    episode dedupe (201 then 200 created:false), enum validation (400)
 *  - the full operator lifecycle + history + audit + badge semantics
 *    (ack ≠ resolve; acknowledged drops out of the badge, MD §6.2/§7.1)
 *  - ZERO SECRETS in every response body (MD §6.2/§13)
 *  - the WIRING the P4 plan promises — REAL production paths fire REAL
 *    intervention events:
 *      1. persistNet BLOCKED   → network_state episode (high/paused)
 *      2. persistNet FAILED    → network_state episode (critical,
 *         blocked_pending_review) — via the boot-timeout background path
 *      3. signalBootTimeout    → boot_timeout episode (blocked_pending_review)
 *      4. refreshDevice adb online→offline → adb_health episode (high)
 *  - the device list exposes per-device openInterventions (MD §3.1 flag)
 *
 * The mock exec/adb/docker are deterministic emulators; failure shapes are
 * injected mid-scenario via redroidMock seams. Live real-device validation
 * is the P4 E2E tier (scripts/mobileconsole-p4.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { makeRedroidTestApp, login, SEED_TEMPLATES } from '../helpers/redroid-fakes.js';

const CRED = 'topsecret-passw0rd';
const PROXY_A = `socks5://userA:${CRED}@proxy-a.example:7801`;
const FORBIDDEN = [CRED, 'socks5://', 'proxy-a.example', 'userA', 'hunter2', 'sid=abc123'];

async function makeApp(opts = {}) {
  const { app, db, dataRoot, redroidMock } = await makeRedroidTestApp(opts);
  const admin = await login(app, 'admin');
  const operator = await login(app, 'operator');
  const viewer = await login(app, 'viewer');
  for (const t of SEED_TEMPLATES) {
    const res = await app.inject({ method: 'POST', url: '/api/redroid/templates', headers: { cookie: admin }, payload: t });
    assert.equal(res.statusCode, 201, `seed template: ${res.statusCode} ${res.body}`);
  }
  return {
    app,
    db,
    redroidMock,
    cookies: { admin, operator, viewer },
    close: async () => { await app.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); },
  };
}

async function seedProxyTemplate(app, cookie, name, proxyUrl = PROXY_A) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/redroid/templates',
    headers: { cookie },
    payload: { name, image: 'redroid/redroid:14.0.0', androidVersion: '14', proxyUrl },
  });
  assert.equal(res.statusCode, 201, `seed proxy template: ${res.statusCode} ${res.body}`);
  return res.json().template;
}

async function createDevice(app, cookie, name, templateName, { key } = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/devices/redroid',
    headers: { cookie },
    payload: { name, templateName, idempotencyKey: key ?? `key-${name}` },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().device;
}

async function getDevice(app, cookie, idOrName) {
  const res = await app.inject({ method: 'GET', url: `/api/devices/redroid/${idOrName}`, headers: { cookie } });
  assert.equal(res.statusCode, 200, `get device: ${res.statusCode} ${res.body}`);
  return res.json().device;
}

/** Poll until device.proxy.network.state is one of `want`. */
async function waitNetState(app, cookie, idOrName, want, { timeoutMs = 20_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const device = await getDevice(app, cookie, idOrName);
    const state = device.proxy?.network?.state;
    if (want.includes(state)) return device;
    if (Date.now() > deadline) throw new Error(`network state stuck — wanted one of [${want.join(', ')}], got '${state}'`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Poll a DB predicate directly (for background-provision outcomes). */
async function waitDb(db, predicate, { timeoutMs = 20_000, intervalMs = 50, label = 'db predicate' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = predicate();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting on: ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function interventions(db) {
  return [...db.__state.interventionRows.values()];
}

/** The app-wide error envelope: { error: { code, message, requestId } }. */
function errCode(res) {
  return res.json()?.error?.code;
}

function assertNoSecrets(value, label) {
  const s = JSON.stringify(value);
  for (const frag of FORBIDDEN) {
    assert.ok(!s.includes(frag), `${label}: response leaked a secret fragment: '${frag}'`);
  }
}

const DEV_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RUN_ID = '11111111-2222-4333-8444-555555555555';

// ---------------------------------------------------------------------------
// 1. RBAC matrix (MD §11.2)
// ---------------------------------------------------------------------------

test('p4 rbac: unauthenticated 401; viewer read-only; operator state machine', async (t) => {
  const { app, db, cookies, close } = await makeApp();
  t.after(async () => { await close(); });

  // --- unauthenticated: everything 401 (POST carries a VALID body — body
  //     validation runs before the auth preHandler, so an empty body would be
  //     a 400 before auth is even reached; that is the app-wide contract)
  const unauthBody = { source: 'operator_report', category: 'OTHER', title: 'unauth probe', deviceId: DEV_ID };
  for (const [method, url, body] of [
    ['GET', '/api/manual-interventions'],
    ['GET', `/api/manual-interventions/${DEV_ID}`],
    ['GET', '/api/manual-interventions/needs-attention-count'],
    ['POST', '/api/manual-interventions', unauthBody],
    ['POST', `/api/manual-interventions/${DEV_ID}/acknowledge`, {}],
    ['POST', `/api/manual-interventions/${DEV_ID}/resolve`, { summary: 'x' }],
  ]) {
    const res = await app.inject({ method, url, payload: body });
    assert.equal(res.statusCode, 401, `${method} ${url} must be 401 when unauthenticated`);
  }

  // --- seed a device row so the create/lookup paths have a real device
  await seedProxyTemplate(app, cookies.admin, 'tpl-p4-rbac');
  const dev = await createDevice(app, cookies.operator, 'redroid-p4-rbac', 'redroid-14-swiftshader');
  assert.match(dev.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  const createBody = { source: 'operator_report', category: 'OTHER', title: 'rbac probe', deviceId: dev.id };

  // --- viewer: reads OK, every mutation 403
  const list = await app.inject({ method: 'GET', url: '/api/manual-interventions', headers: { cookie: cookies.viewer } });
  assert.equal(list.statusCode, 200);
  const count = await app.inject({ method: 'GET', url: '/api/manual-interventions/needs-attention-count', headers: { cookie: cookies.viewer } });
  assert.equal(count.statusCode, 200);
  for (const [method, url, body] of [
    ['POST', '/api/manual-interventions', createBody],
    ['POST', `/api/manual-interventions/${DEV_ID}/acknowledge`, {}],
    ['POST', `/api/manual-interventions/${DEV_ID}/assign`, {}],
    ['POST', `/api/manual-interventions/${DEV_ID}/resolve`, { summary: 'x' }],
    ['POST', `/api/manual-interventions/${DEV_ID}/dismiss`, { reason: 'x' }],
    ['POST', `/api/manual-interventions/${DEV_ID}/reopen`, { reason: 'x' }],
  ]) {
    const res = await app.inject({ method, url, headers: { cookie: cookies.viewer }, payload: body });
    assert.equal(res.statusCode, 403, `viewer ${method} ${url} must be 403`);
  }

  // --- operator: the state machine works
  const created = await app.inject({ method: 'POST', url: '/api/manual-interventions', headers: { cookie: cookies.operator }, payload: createBody });
  assert.equal(created.statusCode, 201, created.body);
  assertNoSecrets(created.json(), 'create response');
  const id = created.json().intervention.id;

  const ack = await app.inject({ method: 'POST', url: `/api/manual-interventions/${id}/acknowledge`, headers: { cookie: cookies.operator } });
  assert.equal(ack.statusCode, 200, ack.body);
  assert.equal(ack.json().status, 'acknowledged');
  const resolved = await app.inject({ method: 'POST', url: `/api/manual-interventions/${id}/resolve`, headers: { cookie: cookies.operator }, payload: { summary: 'handled via API' } });
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.equal(resolved.json().status, 'resolved');
  assert.equal(resolved.json().resolutionSummary, 'handled via API');
  assert.ok(resolved.json().resolvedAt, 'resolve stamps resolvedAt');

  // device linkage was authoritative (name snapshot from the live row)
  assert.equal(created.json().intervention.deviceNameSnapshot, 'redroid-p4-rbac');
  // nothing leaked
  assertNoSecrets({ created: created.json(), ack: ack.json(), resolved: resolved.json() }, 'lifecycle responses');
});

// ---------------------------------------------------------------------------
// 2. create contract (MD §6.1/§6.2)
// ---------------------------------------------------------------------------

test('p4 create contract: 404 unknown device, 409 unknown run, enum 400, dedupe 201→200', async (t) => {
  const { app, db, cookies, close } = await makeApp();
  t.after(async () => { await close(); });

  const base = { source: 'qa_signal', category: 'OTHER', title: 'contract probe' };

  // unknown device → 404 INTERVENTION_DEVICE_NOT_FOUND
  const missing = await app.inject({
    method: 'POST', url: '/api/manual-interventions', headers: { cookie: cookies.operator },
    payload: { ...base, deviceId: DEV_ID },
  });
  assert.equal(missing.statusCode, 404, missing.body);
  assert.equal(errCode(missing), 'INTERVENTION_DEVICE_NOT_FOUND');

  // unknown task run → 409 INTERVENTION_TASK_RUN_OUT_OF_SCOPE
  const dev = await createDevice(app, cookies.operator, 'redroid-p4-contract', 'redroid-14-swiftshader');
  const badRun = await app.inject({
    method: 'POST', url: '/api/manual-interventions', headers: { cookie: cookies.operator },
    payload: { ...base, deviceId: dev.id, relatedTaskRunId: RUN_ID },
  });
  assert.equal(badRun.statusCode, 409, badRun.body);
  assert.equal(errCode(badRun), 'INTERVENTION_TASK_RUN_OUT_OF_SCOPE');

  // enum validation → 400 (fastify schema)
  const badEnum = await app.inject({
    method: 'POST', url: '/api/manual-interventions', headers: { cookie: cookies.operator },
    payload: { ...base, source: 'network_state', deviceId: dev.id }, // system source — operator cannot forge it
  });
  assert.equal(badEnum.statusCode, 400, 'a system source posted by an operator must be rejected');
  const badSeverity = await app.inject({
    method: 'POST', url: '/api/manual-interventions', headers: { cookie: cookies.operator },
    payload: { ...base, severity: 'apocalyptic', deviceId: dev.id },
  });
  assert.equal(badSeverity.statusCode, 400);

  // neither deviceId nor deviceNameSnapshot → 400
  const noDevice = await app.inject({
    method: 'POST', url: '/api/manual-interventions', headers: { cookie: cookies.operator },
    payload: base,
  });
  assert.equal(noDevice.statusCode, 400, noDevice.body);

  // dedupe: same device+category+source → one episode, re-escalated
  const c1 = await app.inject({ method: 'POST', url: '/api/manual-interventions', headers: { cookie: cookies.operator }, payload: { ...base, deviceId: dev.id, summary: 'first sight' } });
  assert.equal(c1.statusCode, 201);
  assert.equal(c1.json().created, true);
  const c2 = await app.inject({ method: 'POST', url: '/api/manual-interventions', headers: { cookie: cookies.operator }, payload: { ...base, deviceId: dev.id, summary: 'second sight' } });
  assert.equal(c2.statusCode, 200, 'a re-escalation is a 200, not a 201');
  assert.equal(c2.json().created, false);
  assert.equal(c2.json().intervention.id, c1.json().intervention.id, 'same episode id');
  assert.equal(c2.json().intervention.signalCount, 2);
  const list = await app.inject({ method: 'GET', url: `/api/manual-interventions?deviceId=${dev.id}`, headers: { cookie: cookies.viewer } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().total, 1, 'dedupe must not create a second row');
  assertNoSecrets({ c1: c1.json(), c2: c2.json(), list: list.json() }, 'contract responses');
});

test('p4 create: sensitive evidence is redacted server-side, zero secrets anywhere', async (t) => {
  const { app, db, cookies, close } = await makeApp();
  t.after(async () => { await close(); });
  const dev = await createDevice(app, cookies.operator, 'redroid-p4-secret', 'redroid-14-swiftshader');
  const res = await app.inject({
    method: 'POST',
    url: '/api/manual-interventions',
    headers: { cookie: cookies.operator },
    payload: {
      source: 'operator_report',
      category: 'MANUAL_REVIEW',
      title: 'secret handling probe',
      deviceId: dev.id,
      evidence: {
        password: 'hunter2',
        sessionCookie: 'sid=abc123',
        proxyUrl: PROXY_A,
        errorCode: 'CANARY_TIMEOUT',
      },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  assertNoSecrets(res.json(), 'create response with sensitive evidence');
  // the stored row is redacted too (the fake db is the source of truth here)
  const row = interventions(db).find((r) => r.id === res.json().intervention.id);
  assert.equal(row.evidence.password, '***redacted***');
  assert.equal(row.evidence.sessionCookie, '***redacted***');
  assert.equal(row.evidence.errorCode, 'CANARY_TIMEOUT', 'machine codes stay readable');
  // and the detail endpoint (what the UI renders) carries no raw secret either
  const detail = await app.inject({ method: 'GET', url: `/api/manual-interventions/${res.json().intervention.id}`, headers: { cookie: cookies.viewer } });
  assertNoSecrets(detail.json(), 'detail response');
});

// ---------------------------------------------------------------------------
// 3. lifecycle + history + audit + badge (MD §6.2/§7.1)
// ---------------------------------------------------------------------------

test('p4 lifecycle: ack ≠ resolve; badge tracks open+in_progress; audit + history complete', async (t) => {
  const { app, db, cookies, close } = await makeApp();
  t.after(async () => { await close(); });
  const dev = await createDevice(app, cookies.operator, 'redroid-p4-life', 'redroid-14-swiftshader');

  const count = async () => (await app.inject({ method: 'GET', url: '/api/manual-interventions/needs-attention-count', headers: { cookie: cookies.viewer } })).json().count;
  assert.equal(await count(), 0);

  const created = await app.inject({
    method: 'POST', url: '/api/manual-interventions', headers: { cookie: cookies.operator },
    payload: { source: 'operator_report', category: 'PERMISSION_REQUIRED', severity: 'high', title: 'permission wall', deviceId: dev.id },
  });
  const id = created.json().intervention.id;
  assert.equal(await count(), 1, 'open episode counts in the badge');

  // ack ≠ resolve
  const acked = await app.inject({ method: 'POST', url: `/api/manual-interventions/${id}/acknowledge`, headers: { cookie: cookies.operator } });
  assert.equal(acked.json().status, 'acknowledged');
  assert.equal(acked.json().resolvedAt, null, 'acknowledging must NOT resolve');
  assert.equal(await count(), 0, 'acknowledged drops out of the badge (MD §7.1)');

  // assign → in_progress → back in the badge (no explicit assignee → the
  // requesting operator is assigned by the service default)
  const assigned = await app.inject({
    method: 'POST', url: `/api/manual-interventions/${id}/assign`, headers: { cookie: cookies.operator },
    payload: {},
  });
  assert.equal(assigned.statusCode, 200, assigned.body);
  assert.equal(assigned.json().status, 'in_progress');
  assert.equal(assigned.json().assigneeUserId, 'u-operator');
  assert.equal(await count(), 1, 'in_progress still needs attention');

  // resolve → terminal, out of the badge
  const resolved = await app.inject({
    method: 'POST', url: `/api/manual-interventions/${id}/resolve`, headers: { cookie: cookies.operator },
    payload: { summary: 'granted the permission on-device' },
  });
  assert.equal(resolved.json().status, 'resolved');
  assert.ok(resolved.json().resolvedAt);
  assert.equal(await count(), 0);

  // note required to resolve
  const c2 = await app.inject({
    method: 'POST', url: '/api/manual-interventions', headers: { cookie: cookies.operator },
    payload: { source: 'qa_signal', category: 'OTHER', title: 'note probe', deviceId: dev.id },
  });
  // whitespace-only note: passes the schema minLength but the service trims
  // it → NOTE_REQUIRED (the service is the last line of defense)
  const noNote = await app.inject({
    method: 'POST', url: `/api/manual-interventions/${c2.json().intervention.id}/resolve`, headers: { cookie: cookies.operator },
    payload: { summary: '   ' },
  });
  assert.equal(noNote.statusCode, 400);
  assert.equal(errCode(noNote), 'NOTE_REQUIRED');

  // history: complete ordered trail with attribution
  const detail = await app.inject({ method: 'GET', url: `/api/manual-interventions/${id}`, headers: { cookie: cookies.viewer } });
  const actions = detail.json().history.map((h) => h.action);
  assert.deepEqual(actions, ['created', 'acknowledge', 'assign', 'resolve']);
  assert.equal(detail.json().history[1].actorUserId, 'u-operator');

  // audit trail: every state-machine action audited with the actor
  const auditRows = (db.__state.auditRows ?? []).filter((a) => String(a.action).startsWith('intervention.'));
  const auditActions = auditRows.map((a) => a.action);
  for (const wanted of ['intervention.created', 'intervention.acknowledge', 'intervention.assign', 'intervention.resolve']) {
    assert.ok(auditActions.includes(wanted), `audit must contain ${wanted} — got [${auditActions.join(', ')}]`);
  }
  const ackAudit = auditRows.find((a) => a.action === 'intervention.acknowledge');
  assert.equal(ackAudit.actorUserId, 'u-operator');
  assert.equal(ackAudit.resourceId, id);
});

test('p4 dismiss policy over HTTP: critical admin-only; external_verification never dismissible', async (t) => {
  const { app, cookies, close } = await makeApp();
  t.after(async () => { await close(); });
  const dev = await createDevice(app, cookies.operator, 'redroid-p4-dismiss', 'redroid-14-swiftshader');

  // critical + operator dismiss → 403 DISMISS_NOT_ALLOWED
  const crit = await app.inject({
    method: 'POST', url: '/api/manual-interventions', headers: { cookie: cookies.operator },
    payload: { source: 'operator_report', category: 'NETWORK_BLOCKED', severity: 'critical', title: 'net down', deviceId: dev.id },
  });
  const cid = crit.json().intervention.id;
  const opDismiss = await app.inject({ method: 'POST', url: `/api/manual-interventions/${cid}/dismiss`, headers: { cookie: cookies.operator }, payload: { reason: 'looks fine' } });
  assert.equal(opDismiss.statusCode, 403, opDismiss.body);
  assert.equal(errCode(opDismiss), 'DISMISS_NOT_ALLOWED');
  const adminDismiss = await app.inject({ method: 'POST', url: `/api/manual-interventions/${cid}/dismiss`, headers: { cookie: cookies.admin }, payload: { reason: 'confirmed false positive' } });
  assert.equal(adminDismiss.statusCode, 200, adminDismiss.body);
  assert.equal(adminDismiss.json().status, 'dismissed');

  // external_verification: admin dismiss → 409 (only a human resolve works)
  const ext = await app.inject({
    method: 'POST', url: '/api/manual-interventions', headers: { cookie: cookies.operator },
    payload: { source: 'external_verification', category: 'EXTERNAL_VERIFICATION', severity: 'high', title: 'third-party CAPTCHA', deviceId: dev.id, automationDisposition: 'blocked_pending_review' },
  });
  assert.equal(ext.statusCode, 201, ext.body);
  const eid = ext.json().intervention.id;
  const extDismiss = await app.inject({ method: 'POST', url: `/api/manual-interventions/${eid}/dismiss`, headers: { cookie: cookies.admin }, payload: { reason: 'skip it' } });
  assert.equal(extDismiss.statusCode, 409, extDismiss.body);
  assert.equal(errCode(extDismiss), 'DISMISS_NOT_ALLOWED');
  const extResolve = await app.inject({ method: 'POST', url: `/api/manual-interventions/${eid}/resolve`, headers: { cookie: cookies.admin }, payload: { summary: 'human completed the challenge per service rules' } });
  assert.equal(extResolve.statusCode, 200, extResolve.body);
  assert.equal(extResolve.json().status, 'resolved');

  // reopen a terminal episode (explicit + noted)
  const reopened = await app.inject({ method: 'POST', url: `/api/manual-interventions/${eid}/reopen`, headers: { cookie: cookies.admin }, payload: { reason: 'challenge re-appeared' } });
  assert.equal(reopened.statusCode, 200, reopened.body);
  assert.equal(reopened.json().status, 'open');
});

// ---------------------------------------------------------------------------
// 4. WIRING: persistNet BLOCKED → network_state episode (REAL service path)
// ---------------------------------------------------------------------------

test('p4 wiring: canary fail → DEGRADED → BLOCKED raises a network_state episode; card flag + badge', async (t) => {
  const { app, db, redroidMock, cookies, close } = await makeApp();
  t.after(async () => { await close(); });

  await seedProxyTemplate(app, cookies.admin, 'tpl-p4-blocked');
  const dev = await createDevice(app, cookies.operator, 'redroid-p4-blocked', 'tpl-p4-blocked');

  // healthy first (canary PASS by default)
  const healthy = await waitNetState(app, cookies.viewer, dev.id, ['HEALTHY']);
  assert.equal(healthy.proxy.network.networkReady, true);
  assert.equal(interventions(db).length, 0, 'a HEALTHY device must not raise any intervention');

  // data-plane loss: canary fails → DEGRADED, then BLOCKED at the threshold
  redroidMock.exec.set({ canary: { pass: false, reason: 'timeout' } });
  await app.redroidService.__tickOnceHealth(dev.id); // fail 1 → DEGRADED
  await app.redroidService.__tickOnceHealth(dev.id); // fail 2 → BLOCKED
  const blocked = await getDevice(app, cookies.viewer, dev.id);
  assert.equal(blocked.proxy.network.state, 'BLOCKED');
  assert.equal(blocked.proxy.network.networkReady, false);

  // the REAL persistNet path raised the episode
  const rows = interventions(db).filter((r) => r.deviceId === dev.id);
  assert.equal(rows.length, 1, 'exactly one episode for the blocked device');
  const row = rows[0];
  assert.equal(row.source, 'network_state');
  assert.equal(row.category, 'NETWORK_BLOCKED');
  assert.equal(row.severity, 'high');
  assert.equal(row.automationDisposition, 'paused');
  assert.equal(row.deviceNameSnapshot, 'redroid-p4-blocked');
  assert.ok(row.evidence?.errorCode, 'machine code in evidence (readable, not a secret)');
  assertNoSecrets({ row }, 'stored network_state episode');

  // the badge + the device list flag both see it
  const count = await app.inject({ method: 'GET', url: '/api/manual-interventions/needs-attention-count', headers: { cookie: cookies.viewer } });
  assert.equal(count.json().count, 1);
  const list = await app.inject({ method: 'GET', url: '/api/devices/redroid', headers: { cookie: cookies.viewer } });
  const card = list.json().devices.find((d) => d.id === dev.id);
  assert.equal(card.openInterventions, 1, 'the device list carries the per-device open count (MD §3.1)');

  // operator resolves → flag + badge clear
  const res = await app.inject({ method: 'POST', url: `/api/manual-interventions/${row.id}/resolve`, headers: { cookie: cookies.operator }, payload: { summary: 'proxy restored' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((await app.inject({ method: 'GET', url: '/api/manual-interventions/needs-attention-count', headers: { cookie: cookies.viewer } })).json().count, 0);
  const list2 = await app.inject({ method: 'GET', url: '/api/devices/redroid', headers: { cookie: cookies.viewer } });
  assert.equal(list2.json().devices.find((d) => d.id === dev.id).openInterventions, 0);
});

// ---------------------------------------------------------------------------
// 5. WIRING: boot timeout → boot_timeout + network FAILED episodes (REAL path)
// ---------------------------------------------------------------------------

test('p4 wiring: boot timeout fires boot_timeout + network_state FAILED episodes (background provision)', async (t) => {
  // adb never comes online → the background tunnel provision hits the boot
  // timeout (fast: 400ms). The REAL provision path must raise BOTH the
  // boot_timeout episode (blocked_pending_review by design) and the network
  // FAILED episode (critical) via persistNet.
  const ctx = await makeApp({
    redroidMockOpts: { online: false },
    configOverride: { redroidTunnelBootTimeoutMs: 400, redroidTunnelPollMs: 20 },
  });
  const { app, db, cookies, close } = ctx;
  t.after(async () => { await close(); });

  await seedProxyTemplate(app, cookies.admin, 'tpl-p4-boot');
  const dev = await createDevice(app, cookies.operator, 'redroid-p4-boot', 'tpl-p4-boot');
  assert.equal(dev.proxy?.network?.state, 'STARTING', 'create must not claim a verified state');

  // wait for the background provision to time out (netState → FAILED in DB)
  await waitDb(db, () => {
    const row = db.__state.deviceRows.get(dev.id);
    return row?.netState === 'FAILED' ? row : null;
  }, { label: 'netState FAILED after boot timeout' });

  const rows = interventions(db).filter((r) => r.deviceId === dev.id);
  const bootRow = rows.find((r) => r.source === 'boot_timeout');
  const netRow = rows.find((r) => r.source === 'network_state');
  assert.ok(bootRow, 'the boot_timeout episode must exist — got ' + JSON.stringify(rows.map((r) => r.source)));
  assert.ok(netRow, 'the network_state FAILED episode must exist');
  assert.equal(bootRow.category, 'BOOT_TIMEOUT');
  assert.equal(bootRow.severity, 'high', 'a boot stall is high (device unusable) — critical is reserved for the network FAILED path');
  assert.equal(bootRow.automationDisposition, 'blocked_pending_review', 'a boot stall is NEVER auto-retried without a human (MD §0.6)');
  assert.equal(netRow.category, 'NETWORK_BLOCKED');
  assert.equal(netRow.severity, 'critical');
  assert.equal(netRow.automationDisposition, 'blocked_pending_review', 'a FAILED network is blocked pending review, not silently paused');
  for (const r of rows) assertNoSecrets({ r }, `stored ${r.source} episode`);

  // the card shows TWO open episodes
  const list = await app.inject({ method: 'GET', url: '/api/devices/redroid', headers: { cookie: cookies.viewer } });
  assert.equal(list.json().devices.find((d) => d.id === dev.id).openInterventions, 2);
  const count = await app.inject({ method: 'GET', url: '/api/manual-interventions/needs-attention-count', headers: { cookie: cookies.viewer } });
  assert.equal(count.json().count, 2);
});

// ---------------------------------------------------------------------------
// 6. WIRING: refreshDevice adb online → offline → adb_health episode (REAL path)
// ---------------------------------------------------------------------------

test('p4 wiring: adb online→offline on refresh raises an adb_health episode (and only then)', async (t) => {
  const { app, db, redroidMock, cookies, close } = await makeApp();
  t.after(async () => { await close(); });

  const dev = await createDevice(app, cookies.operator, 'redroid-p4-adb', 'redroid-14-swiftshader');

  // first refresh: adb online (mock default) → adbState 'online', no episode
  const r1 = await app.inject({ method: 'POST', url: `/api/devices/redroid/${dev.id}/refresh`, headers: { cookie: cookies.operator } });
  assert.equal(r1.statusCode, 200, r1.body);
  assert.equal(r1.json().device.adbState, 'online');
  assert.equal(interventions(db).length, 0, 'an online device must not raise an episode');

  // the device stops answering (the R5 recreate-stall shape: confirmed online → adbd silent)
  redroidMock.adb.setOnline(false);
  const r2 = await app.inject({ method: 'POST', url: `/api/devices/redroid/${dev.id}/refresh`, headers: { cookie: cookies.operator } });
  assert.equal(r2.statusCode, 200, r2.body);
  assert.equal(r2.json().device.adbState, 'offline');

  const rows = interventions(db).filter((r) => r.deviceId === dev.id);
  assert.equal(rows.length, 1, 'exactly one adb_health episode');
  const row = rows[0];
  assert.equal(row.source, 'adb_health');
  assert.equal(row.category, 'DEVICE_OFFLINE');
  assert.equal(row.severity, 'high');
  assert.equal(row.automationDisposition, 'paused');
  assertNoSecrets({ row }, 'stored adb_health episode');

  // refreshing again while offline must NOT storm: the transition hook fires
  // once per online→offline edge; the open episode simply stays open.
  const r3 = await app.inject({ method: 'POST', url: `/api/devices/redroid/${dev.id}/refresh`, headers: { cookie: cookies.operator } });
  assert.equal(r3.statusCode, 200, r3.body);
  const rows2 = interventions(db).filter((r) => r.deviceId === dev.id);
  assert.equal(rows2.length, 1, 'repeat offline refreshes must not storm new episodes');
  assert.equal(rows2[0].signalCount, 1, 'no re-signal on a repeated offline observation (one signal per transition edge)');
});
