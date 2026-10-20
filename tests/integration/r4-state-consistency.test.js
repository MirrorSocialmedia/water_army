/**
 * R4 (repair MD §6.4) — the five MANDATORY state-consistency scenarios,
 * hermetic (mock redroid environment, REAL service code path — the same
 * harness/style as tests/integration/redroid-net-health.test.js).
 *
 *  §6.4-1  process ALIVE + TCP canary FAIL  → never HEALTHY
 *  §6.4-2  DNS success + TCP fail           → never HEALTHY (name resolution
 *                                             alone is not data-plane proof)
 *  §6.4-3  lastSuccessfulCheckAt expired    → not permanently healthy
 *                                             (stale ⇒ networkReady=false ⇒
 *                                             UI STALE, worker BLOCKED)
 *  §6.4-4  API / worker / UI read ONE schema (the live API GET view matches
 *                                             the contract key set the unit
 *                                             file pins on buildNetPayload)
 *  §6.4-5  duplicate / late events + restart → a persisted BLOCKED row is
 *                                             NEVER overwritten to HEALTHY;
 *                                             every audited transition is a
 *                                             legal edge
 *
 * Plus the R3-found idempotency replay regression: delete a device, then
 * re-create with the SAME idempotency key within the TTL → a FRESH device
 * (no phantom view: create 201, GET 200, new id).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { canEnterNetState, NET_CHECK_KEYS, NET_PAYLOAD_KEYS } from '../../apps/api/src/services/redroid-health.js';
import { makeRedroidTestApp, login, seedRedroidTemplates, SEED_TEMPLATES } from '../helpers/redroid-fakes.js';
import { netStateBadge } from '../../apps/web/src/components/redroid-utils.js';

const CRED = 'topsecret-passw0rd';
const PROXY_A = `socks5://userA:${CRED}@proxy-a.example:7801`;
const FORBIDDEN = [CRED, 'socks5://', 'proxy-a.example', 'userA', 'proxyUrl'];

async function makeApp(opts = {}) {
  const { app, db, dataRoot, redroidMock } = await makeRedroidTestApp(opts);
  const admin = await login(app, 'admin');
  const operator = await login(app, 'operator');
  const viewer = await login(app, 'viewer');
  await seedRedroidTemplates(app, admin);
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

async function createProxiedDevice(app, cookie, name, templateName = 'tpl-r4-proxy', key = `key-${name}`) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/devices/redroid',
    headers: { cookie },
    payload: { name, templateName, idempotencyKey: key },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().device;
}

async function getDevice(app, cookie, idOrName) {
  const res = await app.inject({ method: 'GET', url: `/api/devices/redroid/${idOrName}`, headers: { cookie } });
  assert.equal(res.statusCode, 200, `get device: ${res.statusCode} ${res.body}`);
  return res.json();
}

async function waitNetState(app, cookie, idOrName, want, { timeoutMs = 30_000, intervalMs = 50, observed = [] } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = await getDevice(app, cookie, idOrName);
    const state = body.device.proxy?.network?.state;
    observed.push(state);
    if (want.includes(state)) return { body: body.device, observed };
    if (Date.now() > deadline) throw new Error(`network state stuck — observed [${[...new Set(observed)].join(', ')}], wanted one of [${want.join(', ')}]`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function tickUntil(app, idOrName, predicate, { timeoutMs = 30_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await app.redroidService.__tickOnceHealth(idOrName);
    const row = app.db.__state?.deviceRows?.get(idOrName) ?? null;
    if (row && predicate(row)) return row;
    if (Date.now() > deadline) throw new Error(`tickUntil timeout — row: ${JSON.stringify(row ? { netState: row.netState, netRecoveries: row.netRecoveries, netConsecutiveFailures: row.netConsecutiveFailures, netLastErrorCode: row.netLastErrorCode } : null)}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function auditActions(db, action) {
  return (db.__state.auditRows ?? []).filter((a) => a.action === action);
}

function assertNoSecrets(value, label) {
  const s = JSON.stringify(value);
  for (const frag of FORBIDDEN) {
    assert.ok(!s.includes(frag), `${label}: response leaked a secret fragment: '${frag}'`);
  }
}

const HEALTHY = 'HEALTHY';
const BLOCKED = 'BLOCKED';
const DEGRADED = 'DEGRADED';
const FAILED = 'FAILED';
const VERIFYING = 'VERIFYING';

// ---------------------------------------------------------------------------
// §6.4-1: process ALIVE + TCP canary FAIL → never HEALTHY
// ---------------------------------------------------------------------------

test('§6.4-1: process alive + TCP canary FAIL → DEGRADED then BLOCKED, never HEALTHY; checks{process=PASS, tcpCanary=FAIL} persisted', async (t) => {
  const { app, db, redroidMock, cookies, close } = await makeApp();
  const H = { cookie: cookies.operator };
  t.after(async () => { await close(); });
  await seedProxyTemplate(app, cookies.admin, 'tpl-r4-c1');
  const created = await createProxiedDevice(app, H.cookie, 'redroid-r4-c1', 'tpl-r4-c1', 'key-r4-c1');
  await waitNetState(app, H.cookie, created.id, [HEALTHY]);

  // The gVisor-stall shape: control plane INTACT (process alive, tun0 up,
  // routes enforced) but the TCP data plane is dead.
  redroidMock.exec.set({ canary: { pass: false, reason: 'tcp-connect-failed' } });

  await app.redroidService.__tickOnceHealth(created.id);
  let body = await getDevice(app, H.cookie, created.id);
  let net = body.device.proxy.network;
  assert.equal(net.state, DEGRADED, 'a live process with a dead data plane is DEGRADED, never HEALTHY');
  assert.equal(net.networkReady, false);
  assert.equal(net.checks.process, 'PASS', 'the process check IS passing — and it still is not healthy');
  assert.equal(net.checks.tcpCanary, 'FAIL', 'the failed TCP canary is persisted in the breakdown');
  assert.equal(net.checks.interface, 'PASS');
  assert.equal(net.checks.routePolicy, 'PASS');
  assert.equal(net.lastErrorCode, 'CANARY_FAIL');
  assertNoSecrets(net, 'degraded view');

  await app.redroidService.__tickOnceHealth(created.id); // threshold (2)
  body = await getDevice(app, H.cookie, created.id);
  net = body.device.proxy.network;
  assert.equal(net.state, BLOCKED, 'at the fail threshold the device is BLOCKED (fail-closed)');
  assert.equal(net.networkReady, false);
  assert.equal(body.device.proxy.state, 'error', 'legacy projection of BLOCKED is never running');

  // exactly ONE VERIFYING→HEALTHY exists (the initial provisioning) — no
  // transition re-entered HEALTHY while the canary was failing
  const toHealthy = auditActions(db, 'redroid.device.net_transition').filter((a) => a.detailsJson.to === HEALTHY);
  assert.equal(toHealthy.length, 1, 'HEALTHY was entered exactly once (provisioning), never again after the TCP failure');
});

// ---------------------------------------------------------------------------
// §6.4-2: DNS success + TCP fail → never HEALTHY
// ---------------------------------------------------------------------------

test('§6.4-2: DNS resolves + TCP connect fails (from provisioning) → the device never becomes HEALTHY', async (t) => {
  const { app, db, redroidMock, cookies, close } = await makeApp();
  const H = { cookie: cookies.operator };
  t.after(async () => { await close(); });

  // Inject BEFORE create: the canary target name "resolves" (the mock DNS
  // succeeds) but the TCP leg dies — DNS success alone must not earn trust.
  redroidMock.exec.set({ canary: { pass: false, reason: 'dns-ok-tcp-fail' } });
  await seedProxyTemplate(app, cookies.admin, 'tpl-r4-c2');
  const created = await createProxiedDevice(app, H.cookie, 'redroid-r4-c2', 'tpl-r4-c2', 'key-r4-c2');

  // Provisioning already ran the first verification and it FAILED the TCP
  // leg: the row is born DEGRADED (consec 1, under the threshold of 2) with
  // the original reason stored. Assert that BEFORE any tick — the watchdog
  // episode (recovery attempts + stall rule) escalates to FAILED on the
  // first tick-driven pass, so DEGRADED must be observed on the fresh row.
  const degradedRow = db.__state.deviceRows.get(created.id);
  assert.equal(degradedRow.netState, DEGRADED, `born state: ${degradedRow.netState}`);
  assert.equal(degradedRow.netConsecutiveFailures, 1, 'first failure: consecutive=1');
  // The ORIGINAL data-plane failure — DNS resolved, TCP connect died — is
  // recorded with its reason on the first failure (DNS success alone is not
  // a pass): the reason string must be findable in the stored row/audit.
  assert.match(String(degradedRow.netLastErrorDetail), /dns-ok-tcp-fail/, 'the TCP failure reason is recorded (DNS success is not a pass)');
  const toDegraded = auditActions(db, 'redroid.device.net_transition').find((a) => a.detailsJson.to === DEGRADED);
  assert.equal(toDegraded?.detailsJson.errorCode, 'CANARY_FAIL', 'the root-cause code of the episode is the canary (TCP) failure');

  // The failure episode is WATCHDOG-DRIVEN (recovery attempts + stall rule),
  // so drive ticks explicitly to the terminal verdict.
  const row = await tickUntil(app, created.id, (r) => r.netState === FAILED, { timeoutMs: 30_000 });
  assert.equal(row.netManualIntervention, true, 'terminal state demands human intervention');
  assert.ok(['STALL_REPROVISION_USELESS', 'RECOVERY_EXHAUSTED'].includes(row.netLastErrorCode), `terminal code: ${row.netLastErrorCode}`);
  const all = auditActions(db, 'redroid.device.net_transition');
  assert.ok(all.every((a) => a.detailsJson.to !== HEALTHY), 'no HEALTHY transition may occur on a TCP failure');
});

// ---------------------------------------------------------------------------
// §6.4-3: lastSuccessfulCheckAt expired → not permanently healthy
// ---------------------------------------------------------------------------

test('§6.4-3: stale HEALTHY (aged last check, nobody re-verified) → stale=true + networkReady=false → UI shows STALE; the watchdog tick then degrades it', async (t) => {
  const { app, db, redroidMock, cookies, close } = await makeApp({
    configOverride: { redroidHealthStaleMs: 150 }, // tiny TTL for the test
  });
  const H = { cookie: cookies.operator };
  t.after(async () => { await close(); });
  await seedProxyTemplate(app, cookies.admin, 'tpl-r4-c3');
  const created = await createProxiedDevice(app, H.cookie, 'redroid-r4-c3', 'tpl-r4-c3', 'key-r4-c3');
  await waitNetState(app, H.cookie, created.id, [HEALTHY]);

  // The canary is now dead — but deliberately NO tick: the stored row still
  // says HEALTHY. The VIEW must not keep reporting it as usable.
  redroidMock.exec.set({ canary: { pass: false, reason: 'went-away' } });
  await new Promise((r) => setTimeout(r, 250)); // outlive the 150ms TTL

  const body = await getDevice(app, H.cookie, created.id);
  const net = body.device.proxy.network;
  assert.equal(net.state, HEALTHY, 'the persisted state is still reported (transparency)');
  assert.equal(net.stale, true, 'MD §6.4-3: an expired lastSuccess ⇒ stale');
  assert.equal(net.networkReady, false, 'stale ⇒ NOT usable (fail-closed) — never permanently healthy');
  const badge = netStateBadge(net);
  assert.match(badge.label, /^STALE/, 'the UI badge shows the STALE text, never the old green badge');
  assert.equal(badge.cls, 'pill-down', 'STALE renders as unhealthy (red), not green');
  assert.equal(badge.dispatch, 'BLOCKED', 'the UI dispatch text matches the worker gate');

  // The watchdog (its next tick) then catches up: state degrades.
  await app.redroidService.__tickOnceHealth(created.id);
  const row = db.__state.deviceRows.get(created.id);
  assert.equal(row.netState, DEGRADED, 'the state machine confirms the stale observation');
  assert.equal(row.netConsecutiveFailures, 1);
});

// ---------------------------------------------------------------------------
// §6.4-4: API / worker / UI — one schema (fixture 對拍)
// ---------------------------------------------------------------------------

test('§6.4-4: the LIVE API view carries exactly the contract key set; worker + UI badge agree with it; zero secrets', async (t) => {
  const { app, cookies, close } = await makeApp();
  const H = { cookie: cookies.operator };
  t.after(async () => { await close(); });
  await seedProxyTemplate(app, cookies.admin, 'tpl-r4-c4');
  const created = await createProxiedDevice(app, H.cookie, 'redroid-r4-c4', 'tpl-r4-c4', 'key-r4-c4');
  await waitNetState(app, H.cookie, created.id, [HEALTHY]);

  const body = await getDevice(app, cookies.viewer, created.id);
  const net = body.device.proxy.network;
  // Same key set the unit file pins on buildNetPayload (the single computation).
  assert.deepEqual(Object.keys(net).sort(), [...NET_PAYLOAD_KEYS].sort(), 'API GET view = the MD §6.2 contract (no drift on any boundary)');
  assert.deepEqual(Object.keys(net.checks).sort(), [...NET_CHECK_KEYS].sort());
  for (const v of Object.values(net.checks)) assert.ok(['PASS', 'FAIL', 'UNKNOWN'].includes(v));

  // The worker boundary (the exact handler the task engine runs) on THIS
  // live API object:
  const { createToolHandlers } = await import('../../apps/worker/src/tool-helpers.js');
  const handlers = createToolHandlers({ api: { redroidDeviceStatus: async () => body } });
  const wr = await handlers['redroid.get_device_status']({ device: created.name });
  assert.equal(wr.result.network.dispatch, 'ALLOWED', 'HEALTHY+fresh ⇒ worker gate ALLOWED');
  assert.equal(wr.result.network.state, net.state);

  // The UI boundary on THIS live API object:
  const badge = netStateBadge(net);
  assert.match(badge.label, /^HEALTHY/);
  assert.equal(badge.dispatch, 'ALLOWED', 'UI dispatch text === worker gate === networkReady');

  // Audit contract (MD §6.3): deviceId + from + to + reason + time +
  // trigger source + related task id.
  const trs = auditActions(app.db, 'redroid.device.net_transition');
  assert.ok(trs.length >= 3, 'provisioning audited');
  const last = trs[trs.length - 1];
  assert.ok(last.resourceId, 'audit row carries the deviceId (resourceId)');
  assert.ok(last.createdAt instanceof Date, 'audit row carries the time (createdAt)');
  assert.ok(['from', 'to', 'reason', 'source', 'relatedTaskId'].every((k) => k in last.detailsJson), 'from/to/reason/trigger-source/relatedTaskId all present');
  assert.equal(last.detailsJson.relatedTaskId, null, 'device-level network events have no associated task (honest null)');

  assertNoSecrets(body, 'device view (R4)');
  assertNoSecrets(wr, 'worker result (R4)');
});

// ---------------------------------------------------------------------------
// §6.4-5: duplicate / late events + restart → BLOCKED never overwritten to
// HEALTHY; every audited transition is a legal edge
// ---------------------------------------------------------------------------

test('§6.4-5: duplicate/late events + a restarted process cannot push BLOCKED→HEALTHY; all audited transitions are legal', async (t) => {
  const { app, db, redroidMock, cookies, close } = await makeApp();
  const H = { cookie: cookies.operator };
  t.after(async () => { await close(); });
  await seedProxyTemplate(app, cookies.admin, 'tpl-r4-c5');
  const created = await createProxiedDevice(app, H.cookie, 'redroid-r4-c5', 'tpl-r4-c5', 'key-r4-c5');
  await waitNetState(app, H.cookie, created.id, [HEALTHY]);

  // Fail the data plane → DEGRADED → BLOCKED.
  redroidMock.exec.set({ canary: { pass: false, reason: 'dup-late' } });
  await app.redroidService.__tickOnceHealth(created.id);
  await app.redroidService.__tickOnceHealth(created.id);
  let row = db.__state.deviceRows.get(created.id);
  assert.equal(row.netState, BLOCKED);

  // (a) DUPLICATE events: extra ticks with the failure still present must
  // only ever walk the legal recovery path — never an illegal jump to
  // HEALTHY, and a terminal FAILED sink absorbs duplicates silently.
  await tickUntil(app, created.id, (r) => r.netState === FAILED, { timeoutMs: 30_000 });
  const transitionsAtFailed = auditActions(db, 'redroid.device.net_transition').length;
  for (let i = 0; i < 3; i++) await app.redroidService.__tickOnceHealth(created.id); // duplicate events on the sink
  row = db.__state.deviceRows.get(created.id);
  assert.equal(row.netState, FAILED, 'duplicate ticks on the FAILED sink change nothing');
  assert.equal(auditActions(db, 'redroid.device.net_transition').length, transitionsAtFailed, 'duplicate events on the sink emit NO new transitions');

  // Every audited transition so far is a legal edge (the guard held).
  for (const a of auditActions(db, 'redroid.device.net_transition')) {
    assert.ok(canEnterNetState(a.detailsJson.from, a.detailsJson.to), `illegal transition audited: ${a.detailsJson.from} -> ${a.detailsJson.to}`);
  }

  // (b) RESTART (a new process = a new service instance reading the SAME
  // persisted rows): a BLOCKED row restored from storage must still be
  // BLOCKED + fail-closed, and a late canary-PASS event can only re-enter
  // HEALTHY through VERIFYING with a fresh check — never a direct overwrite.
  const blockedRow = { ...row, netState: BLOCKED, netManualIntervention: false, netRecoveries: 0, netConsecutiveFailures: 2, netNextRecoveryAt: null, netRecoveryLockOwner: null, netRecoveryLockUntil: null };
  const app2 = await makeApp();
  t.after(async () => { await app2.close(); });
  app2.db.__state.deviceRows.set(created.id, blockedRow);
  // A real API restart shares the SAME host docker daemon: the device
  // container is still there. Mirror it into app2's mock docker (a fresh
  // mock would 404 the container → a spurious CONTAINER_NOT_RUNNING that a
  // real restart would never see).
  const rec = redroidMock.docker.client.__byId.get(row.containerId);
  if (rec) {
    app2.redroidMock.docker.client.__byId.set(rec.inspect.Id, JSON.parse(JSON.stringify(rec)));
    app2.redroidMock.docker.client.__byName.set(row.containerName, rec.inspect.Id);
  }

  // A LATE canary PASS arrives at the restarted process (the event is old —
  // it must be RE-VERIFIED, not believed). The designed path is the fresh
  // re-verification gate: BLOCKED → VERIFYING → (fresh canary PASS from THIS
  // pass) → HEALTHY. A direct BLOCKED→HEALTHY overwrite is impossible by the
  // transition table, and HEALTHY without the fresh-check evidence is
  // rejected by the guard.
  app2.redroidMock.exec.set({ canary: { pass: true, ms: 40 } });
  // recovery runs async inside the tick — wait for a terminal verdict
  // (HEALTHY via the fresh pass, or FAILED if the mock misbehaved).
  await tickUntil(app2.app, created.id, (r) => r.netState === HEALTHY || r.netState === FAILED, { timeoutMs: 30_000 });
  const seq = auditActions(app2.db, 'redroid.device.net_transition').map((a) => `${a.detailsJson.from}->${a.detailsJson.to}`);
  assert.ok(!seq.includes('BLOCKED->HEALTHY'), 'no direct BLOCKED→HEALTHY overwrite, even for a late PASS event');
  assert.ok(seq.includes('BLOCKED->VERIFYING'), 'the late PASS re-enters through the VERIFYING re-verification gate — never a blind overwrite');
  const healthy = auditActions(app2.db, 'redroid.device.net_transition').find((a) => a.detailsJson.to === HEALTHY);
  assert.ok(healthy, 'the late PASS eventually re-verified → HEALTHY via VERIFYING');
  assert.equal(healthy.detailsJson.from, VERIFYING, 'HEALTHY is entered ONLY from VERIFYING (the fresh-check path)');
  assert.equal(healthy.detailsJson.reason, 'recovery-verification-passed', 'the HEALTHY entry carries the re-verification reason');
  const row2 = app2.db.__state.deviceRows.get(created.id);
  assert.equal(row2.netState, HEALTHY);
  assert.equal(row2.netConsecutiveFailures, 0, 'the episode resets on the fresh pass');
});

// ---------------------------------------------------------------------------
// Idempotency replay regression (R3 live-found): delete → re-create with the
// same key within the TTL must NOT replay the deleted (phantom) device.
// ---------------------------------------------------------------------------

test('idempotency: delete then re-create with the SAME key → fresh device (201, new id, GET 200) — no phantom view', async (t) => {
  const { app, db, cookies, close } = await makeApp();
  const H = { cookie: cookies.operator };
  t.after(async () => { await close(); });
  await seedProxyTemplate(app, cookies.admin, 'tpl-r4-idem');

  const first = await createProxiedDevice(app, H.cookie, 'redroid-r4-idem', 'tpl-r4-idem', 'key-r4-idem-same');
  // A true replay while the device exists is still idempotent (same id).
  const replay = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: { cookie: H.cookie }, payload: { name: 'redroid-r4-idem', templateName: 'tpl-r4-idem', idempotencyKey: 'key-r4-idem-same' } });
  assert.ok([200, 201].includes(replay.statusCode), `in-flight replay: ${replay.statusCode} ${replay.body}`);
  assert.equal(replay.json().device.id, first.id, 'live replay returns the SAME device (true idempotency)');

  // Delete it (admin).
  const del = await app.inject({ method: 'DELETE', url: `/api/devices/redroid/${first.id}`, headers: { cookie: cookies.admin }, payload: { confirm: 'redroid-r4-idem' } });
  assert.ok([200, 204].includes(del.statusCode), `delete: ${del.statusCode} ${del.body}`);

  // Re-create with the SAME key within the TTL: the R3 footgun returned the
  // cached (deleted) view — create 200, GET 404. Now: a FRESH device.
  const second = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: { cookie: H.cookie }, payload: { name: 'redroid-r4-idem', templateName: 'tpl-r4-idem', idempotencyKey: 'key-r4-idem-same' } });
  assert.equal(second.statusCode, 201, `post-delete re-create must be a fresh create: ${second.statusCode} ${second.body}`);
  const dev2 = second.json().device;
  assert.notEqual(dev2.id, first.id, 'the re-created device is a NEW row — not the phantom cached view');
  const got = await getDevice(app, H.cookie, dev2.id);
  assert.equal(got.device.id, dev2.id, 'GET on the re-created device works (the phantom 404 is gone)');
  // The old id is really gone:
  const old = await app.inject({ method: 'GET', url: `/api/devices/redroid/${first.id}`, headers: { cookie: H.cookie } });
  assert.equal(old.statusCode, 404);
});
