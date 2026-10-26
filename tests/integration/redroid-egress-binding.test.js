/**
 * W3 (ADR-027) — identity egress binding: mock-integration tests.
 *
 * Full-stack, hermetic: buildApp + fake db + mock redroid env (REDROID_ADAPTER=
 * mock). Every W3 path runs REAL service code; only the device exec + docker +
 * redis are mocked. The in-device egress probe is emulated by the mock exec's
 * egress branch (behavior.egress = { ip } | { reason }).
 *
 * Timing note: at create, tunnel provisioning (and therefore the boot-time
 * egress verification) runs in the BACKGROUND (pre-existing contract — the
 * create response does not wait for boot). Tests therefore POLL the device
 * view until the egress/net state settles (mock provisioning is fast).
 *
 * Scenarios:
 *   1. switch OFF → surface 503 + byte-inert device behaviour (zero change)
 *   2. binding CRUD + RBAC + validation (400/404/409) + zero-credential view
 *   3. boot verify MATCH → VERIFIED + dispatch ALLOWED + binding verified-at
 *   4. boot verify DRIFT → fail-closed (BLOCKED) + intervention
 *      blocked_pending_review + ZERO side effects (no teardown)
 *   5. drift → recovery → VERIFIED again (intervention stays human-owned)
 *   6. unreachable → threshold → intervention; recovery
 *   7. NO_PROXY explicit state (sweep) + create-time EGRESS_PROXY_REQUIRED
 *   8. UNBOUND (proxy without identity; binding deleted mid-life)
 *   9. binding change → bound devices reset to UNCHECKED (fail-closed)
 *  10. device stop → egress UNCHECKED (fresh boot = fresh verification)
 *  11. echo not configured → can never be VERIFIED (fail-closed)
 *  12. CANARY: fake credentials → ZERO occurrence in API/audit/interventions/exec
 *  13. create gate: identity without binding → 409; unknown identity → 404
 *
 * LIVE EGRESS: NOT VERIFIED (NV4) — the mock emulates the probe; the
 * real-device matrix lives in the ADR-027 real-device TODO.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { makeRedroidTestApp, login } from '../helpers/redroid-fakes.js';

// CANARY proxy (fake credentials — must appear NOWHERE in any surfaced text).
const CANARY_PROXY = 'socks5://wa-canary-user:wa-canary-s3cr3t-w3@w3proxy.example:7801';
const CANARY_FRAGS = ['wa-canary-user', 'wa-canary-s3cr3t-w3', 'socks5://', 'w3proxy.example'];
const IP_A = '203.0.113.10'; // TEST-NET-3 (RFC 5737)
const IP_B = '198.51.100.20'; // TEST-NET-2
const IP_DRIFT = '203.0.113.99';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertNoCanary(value, label) {
  const s = JSON.stringify(value ?? '');
  for (const frag of CANARY_FRAGS) {
    assert.ok(!s.includes(frag), `${label}: leaked canary fragment '${frag}'`);
  }
}

async function makeEgressApp() {
  const { app, db, dataRoot, redroidMock } = await makeRedroidTestApp({
    configOverride: {
      egressBindingEnabled: true,
      egressEchoHost: 'echo.mock',
      egressEchoPort: 20282,
      egressProbeTimeoutMs: 1000,
      egressFailThreshold: 2,
    },
  });
  const admin = await login(app, 'admin');
  const operator = await login(app, 'operator');
  const viewer = await login(app, 'viewer');
  const tpl = await app.inject({
    method: 'POST',
    url: '/api/redroid/templates',
    headers: { cookie: admin },
    payload: { name: 'redroid-tpl-w3', image: 'redroid/redroid:14.0.0', androidVersion: '14', proxyUrl: CANARY_PROXY },
  });
  assert.equal(tpl.statusCode, 201, tpl.body);
  return {
    app, db, redroidMock,
    admin, operator, viewer,
    templateName: tpl.json().template.name,
    close: async () => { await app.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); },
  };
}

let seq = 0;
const next = (p) => `${p}-${(++seq).toString(16).padStart(4, '0')}`;

async function makeIdentity(db, tag) {
  seq += 1;
  const row = await db.identity.create({
    data: { displayName: `w3-${tag}-${seq}`, dataPath: `/data/wa/w3-${tag}-${seq}` },
  });
  return row.id;
}

async function putBinding(env, identityId, { proxyUrl = CANARY_PROXY, expectedEgressIp = IP_A } = {}, cookie) {
  return env.app.inject({
    method: 'PUT',
    url: `/api/identities/${identityId}/egress`,
    headers: { cookie: cookie ?? env.admin },
    payload: { proxyUrl, expectedEgressIp },
  });
}

async function createDevice(env, { name, identityId = null, cookie = env.operator, templateName } = {}) {
  return env.app.inject({
    method: 'POST',
    url: '/api/devices/redroid',
    headers: { cookie },
    payload: {
      name,
      templateName: templateName ?? env.templateName,
      idempotencyKey: next(`idem-${name}`),
      ...(identityId ? { identityId } : {}),
    },
  });
}

async function getDevice(env, idOrName, cookie = env.operator) {
  const res = await env.app.inject({ method: 'GET', url: `/api/devices/redroid/${idOrName}`, headers: { cookie } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().device;
}

/** Poll the device view until pred(view) is true (provisioning is async at create). */
async function waitDevice(env, idOrName, pred, { timeoutMs = 8000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await getDevice(env, idOrName);
    if (pred(last)) return last;
    if (Date.now() > deadline) return last;
    await sleep(intervalMs);
  }
}
const waitEgress = (env, id, states) => waitDevice(env, id, (d) => states.includes(d.egress?.state));
const waitNet = (env, id, states) => waitDevice(env, id, (d) => states.includes(d.proxy?.network?.state));

async function tick(env, id) {
  return env.app.redroidService.__tickOnceHealth(id);
}

// ===========================================================================
// 1. switch OFF — zero behaviour change
// ===========================================================================
test('W3 switch OFF: egress routes fail closed 503; device behaviour byte-inert', async (t) => {
  const { app, db, redroidMock, close } = await makeRedroidTestApp({});
  const admin = await login(app, 'admin');
  const operator = await login(app, 'operator');
  const tpl = await app.inject({
    method: 'POST', url: '/api/redroid/templates', headers: { cookie: admin },
    payload: { name: 'redroid-tpl-w3off', image: 'redroid/redroid:14.0.0', androidVersion: '14', proxyUrl: CANARY_PROXY },
  });
  assert.equal(tpl.statusCode, 201, tpl.body);
  const templateName = tpl.json().template.name;

  // routes: 503 EGRESS_BINDING_DISABLED (all verbs, all routes)
  for (const [method, url] of [
    ['GET', '/api/identities/egress'],
    ['GET', '/api/identities/00000000-0000-4000-8000-000000000001/egress'],
    ['PUT', '/api/identities/00000000-0000-4000-8000-000000000001/egress'],
    ['DELETE', '/api/identities/00000000-0000-4000-8000-000000000001/egress'],
  ]) {
    const r = await app.inject({ method, url, headers: { cookie: admin }, payload: method === 'PUT' ? { proxyUrl: CANARY_PROXY, expectedEgressIp: IP_A } : undefined });
    assert.equal(r.statusCode, 503, `${method} ${url}: ${r.body}`);
    assert.equal(r.json().error.code, 'EGRESS_BINDING_DISABLED');
  }

  // device create + lifecycle: identical to pre-W3 (proxy device reaches HEALTHY;
  // egress surfaces are null; networkReady driven by the net axis only)
  redroidMock.exec.set({ egress: { ip: IP_A } }); // irrelevant while off — proves inertness
  const dev = await app.inject({
    method: 'POST', url: '/api/devices/redroid', headers: { cookie: operator },
    payload: { name: 'redroid-w3off-dev', templateName, idempotencyKey: next('off') },
  });
  assert.equal(dev.statusCode, 201, dev.body);
  const d0 = dev.json().device;
  assert.equal(d0.egress, null, 'top-level egress is null while the switch is off');
  assert.equal(d0.proxy.network.egress, null, 'network.egress is null while the switch is off');

  const envShim = { app, db, operator };
  const d = await waitNet(envShim, d0.id, ['HEALTHY', 'FAILED']);
  assert.equal(d.proxy.network.state, 'HEALTHY');
  assert.equal(d.egress, null, 'still null after boot (switch off)');
  assert.equal(d.proxy.network.egress, null, 'still null after boot (switch off)');
  assert.equal(d.proxy.network.networkReady, true, 'net-axis readiness unchanged (egress gate inert)');
  const row = await db.device.findUnique({ where: { name: 'redroid-w3off-dev' } });
  assert.equal(row.egressState, 'UNCHECKED', 'device egress column stays at its inert default');
  assert.equal(row.egressCheckedAt, null, 'egress never probed while the switch is off');

  await close();
});

// ===========================================================================
// 2. binding CRUD + RBAC + validation
// ===========================================================================
test('W3 bindings: CRUD + RBAC + validation matrix', async (t) => {
  const env = await makeEgressApp();
  const { app, db, admin, operator, viewer, close } = env;
  const id = await makeIdentity(db, 'crud');

  // RBAC
  assert.equal((await putBinding(env, id, {}, operator)).statusCode, 403, 'operator cannot write');
  assert.equal((await putBinding(env, id, {}, viewer)).statusCode, 403, 'viewer cannot write');
  assert.equal((await app.inject({ method: 'GET', url: `/api/identities/${id}/egress`, headers: { cookie: operator } })).statusCode, 200, 'operator can read (viewer+)');
  assert.equal((await app.inject({ method: 'GET', url: `/api/identities/${id}/egress`, headers: { cookie: viewer } })).statusCode, 200, 'viewer can read');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/identities/${id}/egress`, headers: { cookie: operator } })).statusCode, 403);

  // validation
  assert.equal((await putBinding(env, '00000000-0000-4000-8000-000000000000', { proxyUrl: CANARY_PROXY, expectedEgressIp: IP_A })).json().error.code, 'IDENTITY_NOT_FOUND');
  assert.equal((await putBinding(env, id, { proxyUrl: CANARY_PROXY, expectedEgressIp: '1.2.3' })).statusCode, 400);
  assert.equal((await putBinding(env, id, { proxyUrl: CANARY_PROXY, expectedEgressIp: '256.1.1.1' })).json().error.code, 'EGRESS_IP_INVALID');
  assert.equal((await putBinding(env, id, { proxyUrl: CANARY_PROXY, expectedEgressIp: '01.2.3.4' })).json().error.code, 'EGRESS_IP_INVALID', 'leading zero rejected');
  assert.equal((await putBinding(env, id, { proxyUrl: 'http://x', expectedEgressIp: IP_A })).json().error.code, 'EGRESS_PROXY_INVALID');
  assert.equal((await putBinding(env, id, { proxyUrl: 'socks5://user:pw@host;id', expectedEgressIp: IP_A })).json().error.code, 'EGRESS_PROXY_INVALID');

  // happy path
  const put = await putBinding(env, id, { expectedEgressIp: IP_A });
  assert.equal(put.statusCode, 200, put.body);
  const b = put.json().binding;
  assert.equal(b.expectedEgressIp, IP_A);
  assert.ok(b.proxyHashShort && b.proxyHashShort.length === 16, 'hash short present');
  assert.equal(b.boundDevices, 0);
  assertNoCanary(put.json(), 'binding PUT response');
  assertNoCanary(b, 'binding view');

  // idempotent re-PUT
  const put2 = await putBinding(env, id, { expectedEgressIp: IP_A });
  assert.equal(put2.statusCode, 200);
  assert.equal(put2.json().binding.proxyHashShort, b.proxyHashShort);

  // conflict: another identity cannot take the same exit IP
  const id2 = await makeIdentity(db, 'crud2');
  const clash = await putBinding(env, id2, { expectedEgressIp: IP_A });
  assert.equal(clash.statusCode, 409);
  assert.equal(clash.json().error.code, 'EGRESS_IP_CONFLICT');

  // list
  const list = await app.inject({ method: 'GET', url: '/api/identities/egress', headers: { cookie: viewer } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().bindings.length, 1);
  assertNoCanary(list.json(), 'bindings list');

  // delete
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/identities/${id}/egress`, headers: { cookie: admin } })).json().deleted, true);
  assert.equal((await app.inject({ method: 'GET', url: `/api/identities/${id}/egress`, headers: { cookie: viewer } })).json().binding, null);
  // delete is idempotent
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/identities/${id}/egress`, headers: { cookie: admin } })).json().deleted, false);

  // audit rows: create + delete audited (the idempotent re-PUT is a no-op by
  // design — no state change, no audit). Zero canary in ANY audit details.
  const bindingAudits = db.__state.auditRows.filter((a) => String(a.action).startsWith('identity.egress_binding'));
  assert.ok(bindingAudits.some((a) => a.action === 'identity.egress_binding_create'), 'binding create audited');
  assert.ok(bindingAudits.some((a) => a.action === 'identity.egress_binding_delete'), 'binding delete audited');
  for (const a of bindingAudits) assertNoCanary(a, `audit ${a.action}`);

  await close();
});

// ===========================================================================
// 3. boot verify MATCH → VERIFIED + dispatch ALLOWED
// ===========================================================================
test('W3 boot verify: MATCH → VERIFIED, dispatch ALLOWED, binding verified-at stamped', async (t) => {
  const env = await makeEgressApp();
  const { app, db, close } = env;
  const id = await makeIdentity(db, 'match');
  assert.equal((await putBinding(env, id, { expectedEgressIp: IP_A })).statusCode, 200);
  env.redroidMock.exec.set({ egress: { ip: IP_A } }); // the exit IP matches

  const res = await createDevice(env, { name: 'redroid-w3-match', identityId: id });
  assert.equal(res.statusCode, 201, res.body);
  const d0 = res.json().device;

  const d = await waitEgress(env, d0.id, ['VERIFIED', 'DRIFTED', 'UNREACHABLE']);
  assert.equal(d.proxy.network.state, 'HEALTHY');
  assert.equal(d.egress.state, 'VERIFIED');
  assert.equal(d.egress.ready, true);
  assert.equal(d.egress.stale, false);
  assert.equal(d.egress.lastObservedIp, IP_A);
  assert.equal(d.proxy.network.egress.state, 'VERIFIED', 'network.egress mirrors the device egress');
  assert.equal(d.proxy.network.networkReady, true, 'fresh VERIFIED → dispatch ALLOWED');

  // persisted + binding stamped
  const row = await db.device.findUnique({ where: { name: 'redroid-w3-match' } });
  assert.equal(row.egressState, 'VERIFIED');
  assert.ok(row.egressCheckedAt, 'checkedAt stamped');
  assert.ok(row.egressLastMatchAt, 'lastMatchAt stamped');
  assert.equal(row.egressConsecutiveFailures, 0);
  const binding = await db.identityEgress.findUnique({ where: { identityId: id } });
  assert.ok(binding.firstVerifiedAt, 'binding firstVerifiedAt stamped');
  assert.ok(binding.lastVerifiedAt, 'binding lastVerifiedAt stamped');

  // audit: the UNCHECKED→VERIFIED transition is audited (IP metadata, no secrets)
  const tr = db.__state.auditRows.filter((a) => a.action === 'redroid.device.egress_transition');
  assert.ok(tr.some((a) => a.detailsJson.from === 'UNCHECKED' && a.detailsJson.to === 'VERIFIED' && a.detailsJson.expectedIp === IP_A), 'transition audited with IP metadata');
  for (const a of tr) assertNoCanary(a, 'egress transition audit');

  await close();
});

// ===========================================================================
// 4. boot verify DRIFT → fail-closed + intervention + zero side effects
// ===========================================================================
test('W3 boot verify: DRIFT → fail-closed (BLOCKED), intervention blocked_pending_review, zero side effects', async (t) => {
  const env = await makeEgressApp();
  const { app, db, close } = env;
  const id = await makeIdentity(db, 'drift');
  assert.equal((await putBinding(env, id, { expectedEgressIp: IP_A })).statusCode, 200);
  env.redroidMock.exec.set({ egress: { ip: IP_DRIFT } }); // WRONG exit IP

  const res = await createDevice(env, { name: 'redroid-w3-drift', identityId: id });
  assert.equal(res.statusCode, 201, res.body, 'the device EXISTS (fail-closed = excluded from the pool, not refused)');
  const d0 = res.json().device;

  const d = await waitEgress(env, d0.id, ['VERIFIED', 'DRIFTED', 'UNREACHABLE']);
  // fail-closed: out of the usable pool
  assert.equal(d.egress.state, 'DRIFTED');
  assert.equal(d.egress.ready, false);
  assert.equal(d.egress.lastObservedIp, IP_DRIFT, 'the OBSERVED wrong IP is surfaced (egress metadata)');
  assert.equal(d.proxy.network.egress.ready, false);
  assert.equal(d.proxy.network.networkReady, false, 'egress drift forces the dispatch gate closed');

  // ZERO side effects: the device is untouched (no teardown, net axis healthy)
  assert.equal(d.containerState, 'running', 'device NOT torn down on drift');
  assert.equal(d.proxy.network.state, 'HEALTHY', 'net axis independent — tunnel is fine, exit IP is wrong');

  // intervention: open, critical, blocked_pending_review
  const iv = await db.manualIntervention.findFirst({ where: { deviceId: d0.id } });
  assert.ok(iv, 'intervention created on boot drift');
  assert.equal(iv.category, 'NETWORK_BLOCKED');
  assert.equal(iv.severity, 'critical');
  assert.equal(iv.automationDisposition, 'blocked_pending_review');
  assert.equal(iv.status, 'open');
  assert.ok(String(iv.title).includes('DRIFT'), 'drift title');
  assertNoCanary(iv, 'intervention row');
  assertNoCanary(iv.evidence, 'intervention evidence');
  assert.equal(iv.evidence.observedIp, IP_DRIFT);
  assert.equal(iv.evidence.expectedIp, IP_A);

  // audit
  const tr = db.__state.auditRows.filter((a) => a.action === 'redroid.device.egress_transition');
  assert.ok(tr.some((a) => a.detailsJson.from === 'UNCHECKED' && a.detailsJson.to === 'DRIFTED' && a.detailsJson.observedIp === IP_DRIFT));
  for (const a of db.__state.auditRows) assertNoCanary(a, 'audit row');

  await close();
});

// ===========================================================================
// 5. drift → recovery (VERIFIED again; intervention stays human-owned)
// ===========================================================================
test('W3 drift: recovery path → VERIFIED again; the intervention is NOT auto-resolved', async (t) => {
  const env = await makeEgressApp();
  const { app, db, close } = env;
  const id = await makeIdentity(db, 'recover');
  assert.equal((await putBinding(env, id, { expectedEgressIp: IP_A })).statusCode, 200);
  env.redroidMock.exec.set({ egress: { ip: IP_DRIFT } });
  const res = await createDevice(env, { name: 'redroid-w3-recover', identityId: id });
  assert.equal(res.statusCode, 201, res.body);
  const d0 = res.json().device;
  const d = await waitEgress(env, d0.id, ['DRIFTED', 'VERIFIED']);
  assert.equal(d.egress.state, 'DRIFTED');

  // the proxy heals: the exit IP now matches
  env.redroidMock.exec.set({ egress: { ip: IP_A } });
  await tick(env, d0.id);
  const d2 = await getDevice(env, d0.id);
  assert.equal(d2.egress.state, 'VERIFIED', 'drift cleared by a fresh match');
  assert.equal(d2.egress.ready, true);
  assert.equal(d2.proxy.network.networkReady, true, 'dispatch re-allowed once egress is fresh-VERIFIED');

  // the drift intervention is still OPEN — only a human closes it
  const iv = await db.manualIntervention.findFirst({ where: { deviceId: d0.id } });
  assert.equal(iv.status, 'open', 'egress intervention is human-owned (no auto-resolve)');
  assert.equal(iv.automationDisposition, 'blocked_pending_review');

  // no second episode for the same open drift (dedupe)
  const count = await db.manualIntervention.count({ where: { deviceId: d0.id } });
  assert.equal(count, 1, 'single open episode (dedupe)');

  await close();
});

// ===========================================================================
// 6. unreachable → threshold → intervention; recovery
// ===========================================================================
test('W3 unreachable: threshold-gated intervention + recovery', async (t) => {
  const env = await makeEgressApp();
  const { app, db, close } = env;
  const id = await makeIdentity(db, 'unreach');
  assert.equal((await putBinding(env, id, { expectedEgressIp: IP_A })).statusCode, 200);
  env.redroidMock.exec.set({ egress: { ip: IP_A } });
  const res = await createDevice(env, { name: 'redroid-w3-unreach', identityId: id });
  assert.equal(res.statusCode, 201, res.body);
  const d0 = res.json().device;
  const d = await waitEgress(env, d0.id, ['VERIFIED', 'DRIFTED']);
  assert.equal(d.egress.state, 'VERIFIED');

  // proxy silently dies: every probe fails
  env.redroidMock.exec.set({ egress: { reason: 'timeout' } });
  const r1 = await tick(env, d0.id);
  assert.equal(r1.egress, 'UNREACHABLE');
  let ivs = await db.manualIntervention.findMany({ where: { deviceId: d0.id } });
  assert.equal(ivs.length, 0, 'cf=1 (< threshold 2): no intervention yet (noise control)');
  let d1 = await getDevice(env, d0.id);
  assert.equal(d1.egress.consecutiveFailures, 1);
  assert.equal(d1.proxy.network.networkReady, false, 'single probe failure already closes the gate (fail-closed)');

  await tick(env, d0.id);
  ivs = await db.manualIntervention.findMany({ where: { deviceId: d0.id } });
  assert.equal(ivs.length, 1, 'cf=2 (threshold): intervention fires');
  assert.equal(ivs[0].severity, 'high');
  assert.equal(ivs[0].automationDisposition, 'blocked_pending_review');
  assert.equal(ivs[0].evidence.errorCode, 'EGRESS_PROBE_TIMEOUT');

  await tick(env, d0.id); // cf=3 — no repeat episode
  ivs = await db.manualIntervention.findMany({ where: { deviceId: d0.id } });
  assert.equal(ivs.length, 1, 'no repeated intervention past the threshold');

  // the proxy comes back
  env.redroidMock.exec.set({ egress: { ip: IP_A } });
  await tick(env, d0.id);
  const d2 = await getDevice(env, d0.id);
  assert.equal(d2.egress.state, 'VERIFIED');
  assert.equal(d2.egress.consecutiveFailures, 0, 'counter reset on match');
  assert.equal(d2.proxy.network.networkReady, true);

  await close();
});

// ===========================================================================
// 7. NO_PROXY — explicit state, never naked by default
// ===========================================================================
test('W3 NO_PROXY: sweep stamps explicit state; create gate refuses naked devices', async (t) => {
  const env = await makeEgressApp();
  const { app, db, close } = env;

  // (a) create-time gate: switch ON + a template WITHOUT a proxy = 409
  const tplNoProxy = await app.inject({
    method: 'POST', url: '/api/redroid/templates', headers: { cookie: env.admin },
    payload: { name: 'redroid-tpl-w3-noproxy', image: 'redroid/redroid:14.0.0', androidVersion: '14' },
  });
  assert.equal(tplNoProxy.statusCode, 201, tplNoProxy.body);
  const c = await createDevice(env, { name: 'redroid-w3-naked', templateName: tplNoProxy.json().template.name });
  assert.equal(c.statusCode, 409);
  assert.equal(c.json().error.code, 'EGRESS_PROXY_REQUIRED');
  // zero side effects of the refusal
  assert.equal(await db.device.count({ where: { name: 'redroid-w3-naked' } }), 0);

  // (b) a pre-existing proxy-less device (e.g. created before the switch
  //     flipped on) gets an EXPLICIT NO_PROXY stamp from the sweep
  seq += 1;
  await db.device.create({
    data: {
      name: `redroid-w3-legacy-naked-${seq}`, templateId: null, adbPort: 15099,
      dataDir: `/tmp/w3-naked-${seq}`, containerName: 'x', image: 'redroid/redroid:14.0.0',
      androidVersion: '14', width: 1080, height: 1920, dpi: 440, fps: 30, gpuMode: 'host',
      containerState: 'running', netState: 'STOPPED',
    },
  });
  const legacyName = `redroid-w3-legacy-naked-${seq}`;
  await env.app.redroidService.__tickOnceHealth(); // full sweep
  const row = await db.device.findUnique({ where: { name: legacyName } });
  assert.equal(row.egressState, 'NO_PROXY', 'explicit NO_PROXY stamp (never naked by default)');
  assert.equal(row.egressConsecutiveFailures, 0);

  // second sweep: steady-state no-op (no churn)
  const since = row.egressStateSince;
  await env.app.redroidService.__tickOnceHealth();
  const row2 = await db.device.findUnique({ where: { name: legacyName } });
  assert.equal(row2.egressState, 'NO_PROXY');
  assert.ok(row2.egressStateSince.getTime() - since.getTime() < 50, 'no state churn in steady state');

  await close();
});

// ===========================================================================
// 8. UNBOUND — proxy present but nothing to pin against
// ===========================================================================
test('W3 UNBOUND: proxy without identity; and a binding deleted mid-life', async (t) => {
  const env = await makeEgressApp();
  const { app, db, close } = env;

  // (a) device with a proxy but no identity (allowed at create; UNBOUND at boot)
  const res = await createDevice(env, { name: 'redroid-w3-unbound' });
  assert.equal(res.statusCode, 201, res.body);
  const d0 = res.json().device;
  const d = await waitEgress(env, d0.id, ['UNBOUND', 'VERIFIED', 'DRIFTED']);
  assert.equal(d.egress.state, 'UNBOUND', 'proxy without an identity = UNBOUND (fail-closed, never dispatch-ready)');
  assert.equal(d.proxy.network.networkReady, false);

  // (b) binding deleted mid-life → the bound device loses its anchor
  const id = await makeIdentity(db, 'unbound2');
  assert.equal((await putBinding(env, id, { expectedEgressIp: IP_B })).statusCode, 200);
  env.redroidMock.exec.set({ egress: { ip: IP_B } });
  const res2 = await createDevice(env, { name: 'redroid-w3-unbound2', identityId: id });
  assert.equal(res2.statusCode, 201, res2.body);
  const d20 = res2.json().device;
  const d2a = await waitEgress(env, d20.id, ['VERIFIED', 'UNBOUND']);
  assert.equal(d2a.egress.state, 'VERIFIED');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/identities/${id}/egress`, headers: { cookie: env.admin } })).json().deleted, true);

  // the delete reset the device to UNCHECKED; the next tick re-resolves → UNBOUND
  const rowAfterDelete = await db.device.findUnique({ where: { name: 'redroid-w3-unbound2' } });
  assert.equal(rowAfterDelete.egressState, 'UNCHECKED', 'binding delete → bound devices reset (old evidence void)');
  await tick(env, d20.id);
  const d2 = await getDevice(env, d20.id);
  assert.equal(d2.egress.state, 'UNBOUND', 'no binding left to pin against');
  assert.equal(d2.proxy.network.networkReady, false);

  await close();
});

// ===========================================================================
// 9. binding change → devices reset to UNCHECKED (old evidence void)
// ===========================================================================
test('W3 binding change: expected IP change → VERIFIED device reset to UNCHECKED, re-verifies on the new IP', async (t) => {
  const env = await makeEgressApp();
  const { app, db, close } = env;
  const id = await makeIdentity(db, 'change');
  assert.equal((await putBinding(env, id, { expectedEgressIp: IP_A })).statusCode, 200);
  env.redroidMock.exec.set({ egress: { ip: IP_A } });
  const res = await createDevice(env, { name: 'redroid-w3-change', identityId: id });
  assert.equal(res.statusCode, 201, res.body);
  const d0 = res.json().device;
  const d = await waitEgress(env, d0.id, ['VERIFIED', 'UNBOUND']);
  assert.equal(d.egress.state, 'VERIFIED');

  // operator rotates the exit IP (proxy rotation)
  const upd = await putBinding(env, id, { expectedEgressIp: IP_B });
  assert.equal(upd.statusCode, 200, upd.body);
  assert.equal(upd.json().binding.expectedEgressIp, IP_B);
  assert.ok(upd.json().binding.proxyHashShort !== undefined);

  // the old VERIFIED evidence is void: device reset + gate closed
  const row = await db.device.findUnique({ where: { name: 'redroid-w3-change' } });
  assert.equal(row.egressState, 'UNCHECKED', 'change → UNCHECKED (never trusted against the old IP)');
  const d1 = await getDevice(env, d0.id);
  assert.equal(d1.proxy.network.networkReady, false, 'gate closed until re-verified');

  // the proxy now exits from the NEW pinned IP → re-verified
  env.redroidMock.exec.set({ egress: { ip: IP_B } });
  await tick(env, d0.id);
  const d2 = await getDevice(env, d0.id);
  assert.equal(d2.egress.state, 'VERIFIED', 're-verified against the new expectation');
  assert.equal(d2.proxy.network.networkReady, true);

  // audit: the update event records the previous IP + reset count (no secrets)
  const updAudit = db.__state.auditRows.find((a) => a.action === 'identity.egress_binding_update');
  assert.ok(updAudit, 'binding update audited');
  assert.equal(updAudit.detailsJson.previousEgressIp, IP_A);
  assertNoCanary(updAudit, 'binding update audit');

  await close();
});

// ===========================================================================
// 10. device stop → egress UNCHECKED (fresh boot = fresh verification)
// ===========================================================================
test('W3 device stop: egress returns to UNCHECKED (the next boot re-verifies)', async (t) => {
  const env = await makeEgressApp();
  const { app, db, close } = env;
  const id = await makeIdentity(db, 'stop');
  assert.equal((await putBinding(env, id, { expectedEgressIp: IP_A })).statusCode, 200);
  env.redroidMock.exec.set({ egress: { ip: IP_A } });
  const res = await createDevice(env, { name: 'redroid-w3-stop', identityId: id });
  assert.equal(res.statusCode, 201, res.body);
  const d0 = res.json().device;
  const d = await waitEgress(env, d0.id, ['VERIFIED', 'UNBOUND']);
  assert.equal(d.egress.state, 'VERIFIED');

  const stop = await app.inject({ method: 'POST', url: `/api/devices/redroid/${d0.id}/stop`, headers: { cookie: env.operator } });
  assert.ok([200, 202].includes(stop.statusCode), stop.body);
  const row = await db.device.findUnique({ where: { name: 'redroid-w3-stop' } });
  assert.equal(row.egressState, 'UNCHECKED', 'stop → UNCHECKED (no stale VERIFIED across a stop)');
  assert.equal(row.netState, 'STOPPED');

  await close();
});

// ===========================================================================
// 11. W3 ON but no echo endpoint → can NEVER be VERIFIED (fail-closed)
// ===========================================================================
test('W3 ON + echo not configured: the device can never be VERIFIED (never naked, never trusted)', async (t) => {
  const { app, db, dataRoot, redroidMock, close } = await makeRedroidTestApp({
    configOverride: { egressBindingEnabled: true, egressEchoHost: '', egressEchoPort: 0, egressFailThreshold: 2 },
  });
  const admin = await login(app, 'admin');
  const operator = await login(app, 'operator');
  const tpl = await app.inject({
    method: 'POST', url: '/api/redroid/templates', headers: { cookie: admin },
    payload: { name: 'redroid-tpl-w3-echo', image: 'redroid/redroid:14.0.0', androidVersion: '14', proxyUrl: CANARY_PROXY },
  });
  assert.equal(tpl.statusCode, 201, tpl.body);
  const id = (await db.identity.create({ data: { displayName: 'w3-noecho', dataPath: `/data/wa/w3-noecho-${++seq}` } })).id;
  const put = await app.inject({
    method: 'PUT', url: `/api/identities/${id}/egress`, headers: { cookie: admin },
    payload: { proxyUrl: CANARY_PROXY, expectedEgressIp: IP_A },
  });
  assert.equal(put.statusCode, 200, put.body);
  redroidMock.exec.set({ egress: { ip: IP_A } }); // even a "matching" probe is unverifiable without the echo

  const res = await app.inject({
    method: 'POST', url: '/api/devices/redroid', headers: { cookie: operator },
    payload: { name: 'redroid-w3-noecho', templateName: tpl.json().template.name, idempotencyKey: next('noecho'), identityId: id },
  });
  assert.equal(res.statusCode, 201, res.body);
  const d0 = res.json().device;
  const envShim = { app, db, redroidMock, operator, viewer: await login(app, 'viewer'), admin, templateName: tpl.json().template.name };
  const d = await waitEgress(envShim, d0.id, ['UNREACHABLE', 'VERIFIED', 'DRIFTED']);
  assert.equal(d.egress.state, 'UNREACHABLE', 'unverifiable = UNREACHABLE (fail-closed)');
  assert.equal(d.egress.lastErrorCode, 'EGRESS_ECHO_NOT_CONFIGURED');
  assert.notEqual(d.egress.state, 'VERIFIED');
  assert.equal(d.proxy.network.networkReady, false, 'never enters the pool');
  assert.equal(d.containerState, 'running', 'and the device itself is left running (no side effects)');

  await close();
});

// ===========================================================================
// 12. CANARY — zero credential occurrence, system-wide (the core W3 invariant)
// ===========================================================================
test('W3 CANARY: fake proxy credentials appear NOWHERE (API/audit/interventions/exec)', async (t) => {
  const env = await makeEgressApp();
  const { app, db, redroidMock, close } = env;
  const id = await makeIdentity(db, 'canary');
  assert.equal((await putBinding(env, id, { expectedEgressIp: IP_A })).statusCode, 200);

  // drive the full lifecycle with the canary proxy in play:
  // boot match → drift → unreachable → recovery → binding change → stop
  env.redroidMock.exec.set({ egress: { ip: IP_A } });
  const res = await createDevice(env, { name: 'redroid-w3-canary', identityId: id });
  assert.equal(res.statusCode, 201, res.body);
  const d0 = res.json().device;
  const d = await waitEgress(env, d0.id, ['VERIFIED', 'DRIFTED']);
  assert.equal(d.egress.state, 'VERIFIED');

  env.redroidMock.exec.set({ egress: { ip: IP_DRIFT } });
  await tick(env, d0.id); // DRIFTED + intervention
  env.redroidMock.exec.set({ egress: { reason: 'timeout' } });
  await tick(env, d0.id); // UNREACHABLE cf=1
  await tick(env, d0.id); // UNREACHABLE cf=2 + intervention
  env.redroidMock.exec.set({ egress: { ip: IP_A } });
  await tick(env, d0.id); // VERIFIED
  await putBinding(env, id, { expectedEgressIp: IP_B }); // reset
  await app.inject({ method: 'POST', url: `/api/devices/redroid/${d0.id}/stop`, headers: { cookie: env.operator } });

  // (a) EVERY mock exec script (netcheck, canary, egress, stage, run, check)
  for (const call of redroidMock.exec.calls) {
    assertNoCanary(call.script, `mock exec script #${call.containerId}`);
    assertNoCanary(call, 'mock exec call record');
  }
  // the egress script specifically: it addresses the ECHO endpoint, never the proxy
  const egressScripts = redroidMock.exec.calls.filter((c) => c.script.includes('wa-egress-v1'));
  assert.ok(egressScripts.length >= 5, 'several egress probes ran');
  for (const c of egressScripts) {
    assert.ok(c.script.includes('HOST=echo.mock'), 'egress probe addresses the echo endpoint');
    assert.ok(!c.script.includes('w3proxy.example'), 'egress probe never sees the proxy host');
  }

  // (b) EVERY API response surface: device list + each device view + binding views
  const list = await app.inject({ method: 'GET', url: '/api/devices/redroid', headers: { cookie: env.operator } });
  assertNoCanary(list.json(), 'device list');
  const single = await app.inject({ method: 'GET', url: `/api/devices/redroid/${d0.id}`, headers: { cookie: env.operator } });
  assertNoCanary(single.json(), 'device single view');
  const blist = await app.inject({ method: 'GET', url: '/api/identities/egress', headers: { cookie: env.viewer } });
  assertNoCanary(blist.json(), 'binding list');
  const b1 = await app.inject({ method: 'GET', url: `/api/identities/${id}/egress`, headers: { cookie: env.viewer } });
  assertNoCanary(b1.json(), 'binding single');
  // template surface (the proxy lives on the template too): the list view
  const tv = await app.inject({ method: 'GET', url: '/api/redroid/templates', headers: { cookie: env.operator } });
  assertNoCanary(tv.json(), 'template list view');

  // (c) EVERY audit row
  assert.ok(db.__state.auditRows.length > 0, 'audit trail exists');
  for (const a of db.__state.auditRows) assertNoCanary(a, `audit ${a.action}`);

  // (d) EVERY intervention row + history row. NOTE: drift and unreachable
  //     share the dedupe key (device + category + source) → ONE open episode
  //     re-escalated by both (signalCount >= 2) — the dedupe contract.
  const ivs = await db.manualIntervention.findMany({});
  assert.equal(ivs.length, 1, 'one deduped open episode (drift + unreachable)');
  assert.ok(ivs[0].signalCount >= 2, `both signals landed on the episode (signalCount=${ivs[0].signalCount})`);
  for (const iv of ivs) {
    assertNoCanary(iv, `intervention ${iv.id}`);
    assertNoCanary(iv.evidence, `intervention evidence ${iv.id}`);
  }
  const hist = db.__state.historyRows;
  for (const h of [...hist.values()]) assertNoCanary(h, 'intervention history');

  // (e) the DB rows themselves: device columns hold IPs/codes, never URLs
  const row = await db.device.findUnique({ where: { name: 'redroid-w3-canary' } });
  assertNoCanary(row, 'device DB row');
  const binding = await db.identityEgress.findUnique({ where: { identityId: id } });
  assert.ok(binding.proxyUrlEncrypted, 'binding stores the proxy ENCRYPTED');
  assert.ok(!binding.proxyUrlEncrypted.includes('wa-canary'), 'stored proxy is ciphertext, not plaintext');
  assert.ok(/^[a-f0-9]{64}$/.test(binding.proxyUrlHash), 'hash is sha256 hex');
  assertNoCanary({ ...binding, proxyUrlEncrypted: '<redacted>' }, 'binding view fields (ip/hash/timestamps)');

  await close();
});

// ===========================================================================
// 13. create-time gate: identity without a binding / unknown identity
// ===========================================================================
test('W3 create gate: identityId without a binding → 409; unknown identity → 404', async (t) => {
  const env = await makeEgressApp();
  const { app, db, close } = env;
  const id = await makeIdentity(db, 'nogate');
  // identity exists but has NO egress binding
  const r1 = await createDevice(env, { name: 'redroid-w3-nobinding', identityId: id });
  assert.equal(r1.statusCode, 409);
  assert.equal(r1.json().error.code, 'EGRESS_BINDING_REQUIRED');
  assert.equal(await db.device.count({ where: { name: 'redroid-w3-nobinding' } }), 0, 'zero side effects');

  const r2 = await createDevice(env, { name: 'redroid-w3-noidentity', identityId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(r2.statusCode, 404);
  assert.equal(r2.json().error.code, 'IDENTITY_NOT_FOUND');

  await close();
});
