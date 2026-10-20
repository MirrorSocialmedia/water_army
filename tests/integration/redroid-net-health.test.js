/**
 * R3 (repair MD Phase 3) — network health state machine + fail-closed
 * watchdog, hermetic integration (mock redroid environment, real service).
 *
 * Proves the MD §5 requirements against the REAL service code path:
 *  - HEALTHY is reachable ONLY through VERIFYING + a fresh data-plane
 *    canary PASS (process existence never earns HEALTHY — R2 L6h)
 *  - fail-closed triggers: canary fail → DEGRADED → BLOCKED; tunnel death /
 *    fail-open (effective=direct) → BLOCKED immediately; container stop by
 *    operator → STOPPED (never read as a crash)
 *  - recovery: lock + backoff + max retries + the gVisor-stall small budget
 *    (one auto re-provision, then FAILED + manual intervention)
 *  - stale HEALTHY: an aged last-check is reported stale + networkReady=false
 *  - manual retry endpoint (the FAILED exit door) + invalid-state 409s
 *  - diagnostics zone 5 (network) — authoritative, machine-readable
 *  - ZERO SECRETS: no proxy URL/credential in ANY response body
 *
 * The mock exec/proxy probe are deterministic emulators; failure shapes are
 * injected MID-SCENARIO via redroidMock.exec.set / proxyReachable.set — the
 * service-side logic (state machine, watchdog, recovery policy) is the REAL
 * production code. Live real-container validation is a separate tier
 * (tests/tools/r3-live-validation.mjs, redroid-matrix-r3-* prefix).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { makeRedroidTestApp, login, SEED_TEMPLATES } from '../helpers/redroid-fakes.js';

const CRED = 'topsecret-passw0rd';
const PROXY_A = `socks5://userA:${CRED}@proxy-a.example:7801`;
const FORBIDDEN = [CRED, 'socks5://', 'proxy-a.example', 'userA', 'proxyUrl'];

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

async function createProxiedDevice(app, cookie, name, templateName = 'tpl-r3-proxy', key = `key-${name}`) {
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

/** Poll until device.proxy.network.state is one of `want` (or timeout). Records every observed state. */
async function waitNetState(app, cookie, idOrName, want, { timeoutMs = 20_000, intervalMs = 50, observed = [] } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = await getDevice(app, cookie, idOrName);
    const state = body.device.proxy?.network?.state;
    observed.push(state);
    if (want.includes(state)) return body.device;
    if (Date.now() > deadline) throw new Error(`network state stuck — observed [${[...new Set(observed)].join(', ')}], wanted one of [${want.join(', ')}]`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Drive explicit watchdog ticks until a predicate on the DB row holds. */
async function tickUntil(app, idOrName, predicate, { timeoutMs = 25_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await app.redroidService.__tickOnceHealth(idOrName);
    const fakeRow = app.db.__state?.deviceRows?.get(idOrName) ?? null;
    if (fakeRow && predicate(fakeRow)) return fakeRow;
    if (Date.now() > deadline) throw new Error(`tickUntil timeout — row: ${JSON.stringify(fakeRow ? { netState: fakeRow.netState, netRecoveries: fakeRow.netRecoveries, netConsecutiveFailures: fakeRow.netConsecutiveFailures, netLastErrorCode: fakeRow.netLastErrorCode } : null)}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function auditActions(db, action) {
  return (db.__state.auditRows ?? []).filter((a) => a.action === action);
}

/** Recursively scan a JSON-serializable value for forbidden secret fragments. */
function assertNoSecrets(value, label) {
  const s = JSON.stringify(value);
  for (const frag of FORBIDDEN) {
    assert.ok(!s.includes(frag), `${label}: response leaked a secret fragment: '${frag}'`);
  }
}

const DEAD_NETCHECK = { process: 'dead', pid: 'none', iface: 'down', route: 'missing', rule: 'missing', effective: 'direct' };

// ---------------------------------------------------------------------------
// 1. Provisioning → HEALTHY only via the data-plane canary
// ---------------------------------------------------------------------------

test('r3 happy path: proxied device reaches HEALTHY via canary PASS; view + DB + audit consistent; zero secrets', async (t) => {
  const { app, db, cookies, close } = await makeApp();
  const H = { cookie: cookies.operator };
  t.after(async () => { await close(); }); // guaranteed cleanup (failure path included)
  const tpl = await seedProxyTemplate(app, cookies.admin, 'tpl-r3-happy');
  const created = await createProxiedDevice(app, H.cookie, 'redroid-r3-happy', tpl.name, 'key-r3-happy-1');
  const H2 = { cookie: cookies.viewer };

  // The create-time netState must be STARTING (never blind running/HEALTHY)
  assert.equal(created.proxy.network.state, 'STARTING', 'create response must not claim a verified state');
  assert.equal(created.proxy.state, 'provisioning', 'legacy projection of STARTING');

  const device = await waitNetState(app, H2.cookie, created.id, ['HEALTHY']);
  const net = device.proxy.network;
  assert.equal(net.state, 'HEALTHY');
  assert.equal(net.networkReady, true);
  assert.equal(net.stale, false);
  assert.equal(net.consecutiveFailures, 0);
  assert.equal(net.recoveries, 0);
  assert.equal(net.canaryConfigured, true);
  assert.equal(net.lastCanary.result, 'PASS');
  assert.match(net.lastCanary.nonce, /^[a-f0-9]{16}$/);
  assert.ok(net.checkedAt && net.lastSuccessAt && net.stateSince);
  // legacy projection
  assert.equal(device.proxy.state, 'running');

  // DB row — the authoritative store
  const row = db.__state.deviceRows.get(created.id);
  assert.equal(row.netState, 'HEALTHY');
  assert.equal(row.proxyState, 'running');
  assert.equal(row.netConsecutiveFailures, 0);
  assert.equal(row.netRecoveries, 0);
  assert.equal(row.netManualIntervention, false);
  assert.match(row.netLastCanary, /^CANARY=PASS nonce=[a-f0-9]{16} ms=\d+$/);

  // audit trail: provision begin → tunnel up → verified healthy
  const transitions = auditActions(db, 'redroid.device.net_transition').map((a) => a.detailsJson);
  const to = (f, t) => transitions.filter((x) => x.from === f && x.to === t);
  assert.ok(to('STOPPED', 'STARTING').length >= 1, 'STOPPED→STARTING audited');
  assert.ok(to('STARTING', 'VERIFYING').length >= 1, 'STARTING→VERIFYING audited (tunnel process up)');
  const healthy = to('VERIFYING', 'HEALTHY');
  assert.equal(healthy.length, 1, 'exactly one VERIFYING→HEALTHY transition');
  assert.ok(['verification-passed', 'recovery-verification-passed'].includes(healthy[0].reason), 'HEALTHY entered with a verification reason');

  // zero secrets in every response we produced
  assertNoSecrets(created, 'create response');
  assertNoSecrets(device, 'device view');
});

// ---------------------------------------------------------------------------
// 2. Canary NOT configured → the data plane is unverifiable → never HEALTHY
// ---------------------------------------------------------------------------

test('r3 fail-closed: no canary target configured → device can never reach HEALTHY; ends FAILED + manual intervention', async (t) => {
  const { app, db, cookies, close } = await makeApp({
    configOverride: { redroidCanaryHost: '', redroidCanaryPort: 0 },
  });
  t.after(async () => { await close(); }); // guaranteed cleanup (failure path included)
  const H = { cookie: cookies.operator };
  const tpl = await seedProxyTemplate(app, cookies.admin, 'tpl-r3-nocanary');
  const created = await createProxiedDevice(app, H.cookie, 'redroid-r3-nocanary', tpl.name, 'key-r3-noc-1');

  // terminal: FAILED (auto recovery exhausts — the data plane is unverifiable)
  const row = await tickUntil(app, created.id, (r) => ['FAILED', 'STOPPED'].includes(r.netState));
  assert.equal(row.netState, 'FAILED');
  assert.equal(row.netManualIntervention, true, 'FAILED must carry the manual-intervention flag');
  assert.equal(row.netLastErrorCode, 'RECOVERY_EXHAUSTED', 'terminal code = the decision; the root cause is preserved below');
  assert.match(String(row.netLastErrorDetail), /CANARY_NOT_CONFIGURED/);
  assert.equal(row.proxyState, 'error', 'legacy projection of FAILED');

  // and it NEVER said HEALTHY — the root-cause code was audited on the transitions
  const all = db.__state.auditRows.filter((a) => a.action === 'redroid.device.net_transition');
  assert.ok(all.every((a) => a.detailsJson.to !== 'HEALTHY'), 'no HEALTHY transition may ever occur without a canary PASS');
  assert.ok(all.some((a) => a.detailsJson.errorCode === 'CANARY_NOT_CONFIGURED'), 'root cause (canary unconfigured) is audited');
});

// ---------------------------------------------------------------------------
// 3. Soft failure (inconclusive netcheck) → DEGRADED → BLOCKED via recovery
//    re-verification → the full 3-attempt budget (non-stall code) → FAILED
// ---------------------------------------------------------------------------

test('r3 soft failure path: HEALTHY → DEGRADED (1 fail) → BLOCKED (threshold) → 3 recovery attempts → FAILED + manual', async (t) => {
  const { app, db, redroidMock, cookies, close } = await makeApp();
  const H = { cookie: cookies.operator };
  t.after(async () => { await close(); }); // guaranteed cleanup (failure path included)
  const tpl = await seedProxyTemplate(app, cookies.admin, 'tpl-r3-softfail');
  const created = await createProxiedDevice(app, H.cookie, 'redroid-r3-softfail', tpl.name, 'key-r3-soft-1');
  await waitNetState(app, H.cookie, created.id, ['HEALTHY']);

  // inconclusive control plane (effective route unknown) — a SOFT failure:
  // not definite loss, so the first one only degrades the device
  redroidMock.exec.set({ netcheck: { process: 'alive', pid: '4444', iface: 'up', route: 'present', rule: 'present', effective: 'unknown' } });

  // first failing tick → DEGRADED (one consecutive failure)
  await app.redroidService.__tickOnceHealth(created.id);
  const body = await getDevice(app, H.cookie, created.id);
  assert.equal(body.device.proxy.network.state, 'DEGRADED');
  assert.equal(body.device.proxy.network.consecutiveFailures, 1);
  assert.equal(body.device.proxy.network.networkReady, false);
  assert.equal(body.device.proxy.state, 'stopped', 'legacy DEGRADED projection must not be running');
  assert.equal(body.device.proxy.network.lastError.code, 'TUNNEL_CHECK_ERROR');

  // the episode: recovery re-verification escalates DEGRADED→BLOCKED at the
  // threshold; TUNNEL_CHECK_ERROR is NOT the stall signature, so the full
  // maxRetries budget (3) is spent, then FAILED + manual intervention.
  const row = await tickUntil(app, created.id, (r) => r.netState === 'FAILED');
  assert.equal(row.netManualIntervention, true);
  assert.equal(row.netLastErrorCode, 'RECOVERY_EXHAUSTED');
  assert.equal(row.proxyState, 'error', 'legacy FAILED projection');

  const recs = auditActions(db, 'redroid.device.net_recovery').map((a) => a.detailsJson.attempt);
  assert.deepEqual(recs.sort(), [1, 2, 3], 'non-stall failures spend the full maxRetries budget, no spin');
  const transitions = auditActions(db, 'redroid.device.net_transition').map((a) => a.detailsJson);
  assert.ok(transitions.some((x) => x.from === 'HEALTHY' && x.to === 'DEGRADED'), 'HEALTHY→DEGRADED on the first soft failure');
  assert.ok(transitions.some((x) => x.from === 'DEGRADED' && x.to === 'BLOCKED'), 'DEGRADED→BLOCKED escalation at the threshold');
  // it NEVER returned to HEALTHY while the check was failing
  assert.ok(!transitions.some((x) => x.to === 'HEALTHY' && x.reason?.startsWith('recovery')));
});

// ---------------------------------------------------------------------------
// 4. Control-plane death / fail-open → BLOCKED immediately (definite loss)
// ---------------------------------------------------------------------------

test('r3 definite loss: kill t2s (process dead + fail-open effective=direct) → BLOCKED on the very next tick', async (t) => {
  const { app, db, redroidMock, cookies, close } = await makeApp();
  const H = { cookie: cookies.operator };
  t.after(async () => { await close(); }); // guaranteed cleanup (failure path included)
  const tpl = await seedProxyTemplate(app, cookies.admin, 'tpl-r3-kill');
  const created = await createProxiedDevice(app, H.cookie, 'redroid-r3-kill', tpl.name, 'key-r3-kill-1');
  await waitNetState(app, H.cookie, created.id, ['HEALTHY']);

  // kill the tunnel: process gone, tun0 down, route gone, traffic direct (R2 L8c fail-open shape)
  redroidMock.exec.set({ netcheck: DEAD_NETCHECK, canary: { pass: false, reason: 'connect-failed' } });
  const res = await app.redroidService.__tickOnceHealth(created.id);
  assert.ok(res, 'tick returned');

  const body = await getDevice(app, H.cookie, created.id);
  const net = body.device.proxy.network;
  assert.equal(net.state, 'BLOCKED', 'definite protection loss must BLOCK on the first observation — never a silent HEALTHY');
  assert.equal(net.networkReady, false);
  assert.equal(net.lastError.code, 'TUNNEL_PROCESS_DEAD');
  assert.equal(body.device.proxy.state, 'error', 'legacy BLOCKED projection');

  // diagnostics after the kill must report the failure authoritatively
  const diag = await app.inject({ method: 'POST', url: `/api/devices/redroid/${created.id}/diagnostics`, headers: H });
  assert.equal(diag.statusCode, 200, diag.body);
  const dnet = diag.json().diagnostics.network;
  assert.equal(dnet.executed, true);
  assert.equal(dnet.status, 'fail');
  assert.equal(dnet.state, 'BLOCKED');
  assert.ok(dnet.checks.netcheck && dnet.checks.container !== undefined && dnet.checks.proxy !== undefined, 'diagnostics expose control+data plane checks');
  assert.ok(dnet.lastError, 'diagnostics expose the failure reason (machine-readable)');
  assertNoSecrets(diag.json(), 'diagnostics (post-kill)');
});

// ---------------------------------------------------------------------------
// 5. gVisor stall signature: process alive + canary dead → ONE auto
//    re-provision max, then FAILED + manual intervention (R2 L6h: re-provision
//    does not restore the data plane — do not spin)
// ---------------------------------------------------------------------------

test('r3 gVisor stall budget: process alive + canary dead → exactly ONE auto re-provision, then FAILED + manual flag', async (t) => {
  const { app, db, redroidMock, cookies, close } = await makeApp();
  const H = { cookie: cookies.operator };
  t.after(async () => { await close(); }); // guaranteed cleanup (failure path included)
  const tpl = await seedProxyTemplate(app, cookies.admin, 'tpl-r3-stall');
  const created = await createProxiedDevice(app, H.cookie, 'redroid-r3-stall', tpl.name, 'key-r3-stall-1');
  await waitNetState(app, H.cookie, created.id, ['HEALTHY']);

  // the L6h shape: tun2socks process alive, tun0 up, route/rule present —
  // but the TCP forward direction is dead (canary timeout). Re-provisioning
  // restarts the same stuck runtime: useless.
  redroidMock.exec.set({ canary: { pass: false, reason: 'timeout' } });

  const row = await tickUntil(app, created.id, (r) => r.netState === 'FAILED');
  assert.equal(row.netManualIntervention, true, 'stall episode must end in manual intervention');
  assert.equal(row.netRecoveries, 1, 'exactly ONE auto re-provision for the stall signature (small budget)');
  assert.equal(row.netLastErrorCode, 'STALL_REPROVISION_USELESS');

  const recs = auditActions(db, 'redroid.device.net_recovery').map((a) => a.detailsJson.attempt);
  assert.deepEqual(recs, [1], 'no spin: exactly one recovery attempt was started');

  // manual retry (the FAILED exit door) → episode reset + forced attempt
  redroidMock.exec.set({}); // the stall clears
  const retry = await app.inject({ method: 'POST', url: `/api/devices/redroid/${created.id}/proxy/retry`, headers: H });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().triggered, true);

  const healed = await waitNetState(app, H.cookie, created.id, ['HEALTHY'], { timeoutMs: 15_000 });
  assert.equal(healed.proxy.network.networkReady, true);
  const row2 = db.__state.deviceRows.get(created.id);
  assert.equal(row2.netRecoveries, 0, 'HEALTHY resets the recovery episode counter');
  assert.equal(row2.netManualIntervention, false, 'manual-intervention flag clears on verified HEALTHY');
});

// ---------------------------------------------------------------------------
// 6. Recovery lock: a held lease blocks a second trigger (no double provision)
// ---------------------------------------------------------------------------

test('r3 recovery lock: while a lease is held by another holder, ticks do NOT start a second recovery', async (t) => {
  const { app, db, redroidMock, cookies, close } = await makeApp();
  const H = { cookie: cookies.operator };
  t.after(async () => { await close(); }); // guaranteed cleanup (failure path included)
  const tpl = await seedProxyTemplate(app, cookies.admin, 'tpl-r3-lock');
  const created = await createProxiedDevice(app, H.cookie, 'redroid-r3-lock', tpl.name, 'key-r3-lock-1');
  await waitNetState(app, H.cookie, created.id, ['HEALTHY']);

  // a persistent failure keeps the device unhealthy across ticks (so the
  // tick does not self-heal before the lock check), + another instance holds
  // the recovery lease
  redroidMock.exec.set({ canary: { pass: false, reason: 'timeout' } });
  const row = db.__state.deviceRows.get(created.id);
  row.netState = 'DEGRADED';
  row.proxyState = 'stopped';
  row.netConsecutiveFailures = 1;
  row.netLastErrorCode = 'CANARY_TIMEOUT';
  row.netRecoveryLockOwner = 'other-api-instance';
  row.netRecoveryLockUntil = new Date(Date.now() + 60_000);

  const res = await app.redroidService.__tickOnceHealth(created.id);
  assert.deepEqual(res, { recovery: 'locked' }, 'a held lease must block the recovery trigger');
  assert.equal(auditActions(db, 'redroid.device.net_recovery').length, 0, 'no recovery may start under a held lease');
  // the verify still ran (the device got the failure bookkeeping) but the
  // episode belongs to the other holder — state escalated, not touched by us
  assert.equal(db.__state.deviceRows.get(created.id).netState, 'BLOCKED', 'soft-fail threshold (2) escalates DEGRADED→BLOCKED during the check');
  assert.equal(db.__state.deviceRows.get(created.id).netRecoveryLockOwner, 'other-api-instance', 'the foreign lease is never stolen');
});

// ---------------------------------------------------------------------------
// 7. Stale HEALTHY: an aged last-check is reported stale (dead-watchdog rule)
// ---------------------------------------------------------------------------

test('r3 stale health: HEALTHY whose last check is older than the TTL → stale=true, networkReady=false; a fresh tick cures it', async (t) => {
  const { app, db, cookies, close } = await makeApp();
  const H = { cookie: cookies.operator };
  t.after(async () => { await close(); }); // guaranteed cleanup (failure path included)
  const tpl = await seedProxyTemplate(app, cookies.admin, 'tpl-r3-stale');
  const created = await createProxiedDevice(app, H.cookie, 'redroid-r3-stale', tpl.name, 'key-r3-stale-1');
  await waitNetState(app, H.cookie, created.id, ['HEALTHY']);

  // age the last check (simulates a dead watchdog / API restart with stale persistence)
  const row = db.__state.deviceRows.get(created.id);
  row.netCheckedAt = new Date(Date.now() - 120_000);
  row.netLastSuccessAt = new Date(Date.now() - 120_000);

  let body = await getDevice(app, H.cookie, created.id);
  assert.equal(body.device.proxy.network.state, 'HEALTHY', 'the stored state is still HEALTHY…');
  assert.equal(body.device.proxy.network.stale, true, '…but an aged check must be reported STALE');
  assert.equal(body.device.proxy.network.networkReady, false, 'stale HEALTHY must NOT gate network work open');

  // a fresh verification pass restores trust
  await app.redroidService.__tickOnceHealth(created.id);
  body = await getDevice(app, H.cookie, created.id);
  assert.equal(body.device.proxy.network.stale, false);
  assert.equal(body.device.proxy.network.networkReady, true);
});

// ---------------------------------------------------------------------------
// 8. Operator stop → STOPPED (never read as a crash; no recovery spin)
// ---------------------------------------------------------------------------

test('r3 operator stop: HEALTHY → STOPPED pre-claim; legacy stopped; NO recovery trigger; restart re-provisions to HEALTHY', async (t) => {
  const { app, db, cookies, close } = await makeApp();
  const H = { cookie: cookies.operator };
  t.after(async () => { await close(); }); // guaranteed cleanup (failure path included)
  const tpl = await seedProxyTemplate(app, cookies.admin, 'tpl-r3-stop');
  const created = await createProxiedDevice(app, H.cookie, 'redroid-r3-stop', tpl.name, 'key-r3-stop-1');
  await waitNetState(app, H.cookie, created.id, ['HEALTHY']);

  const stop = await app.inject({ method: 'POST', url: `/api/devices/redroid/${created.id}/stop`, headers: H });
  assert.equal(stop.statusCode, 200, stop.body);
  const row = db.__state.deviceRows.get(created.id);
  assert.equal(row.netState, 'STOPPED', 'an operator stop must land in STOPPED — not DEGRADED/BLOCKED/FAILED');
  assert.equal(row.proxyState, 'stopped');
  assert.equal(auditActions(db, 'redroid.device.net_recovery').length, 0, 'an operator stop must never trigger recovery');

  // restart → full re-provision → canary → HEALTHY again
  const start = await app.inject({ method: 'POST', url: `/api/devices/redroid/${created.id}/start`, headers: H });
  assert.equal(start.statusCode, 200, start.body);
  const healed = await waitNetState(app, H.cookie, created.id, ['HEALTHY'], { timeoutMs: 15_000 });
  assert.equal(healed.proxy.network.state, 'HEALTHY');
});

// ---------------------------------------------------------------------------
// 9. Proxy leg unreachable (gost listener down) with canary dead → BLOCKED
// ---------------------------------------------------------------------------

test('r3 proxy leg: gost listener unreachable + canary dead → BLOCKED with PROXY_UNREACHABLE (a canary PASS would excuse a probe artifact)', async (t) => {
  const { app, db, redroidMock, cookies, close } = await makeApp();
  const H = { cookie: cookies.operator };
  t.after(async () => { await close(); }); // guaranteed cleanup (failure path included)
  const tpl = await seedProxyTemplate(app, cookies.admin, 'tpl-r3-gost');
  const created = await createProxiedDevice(app, H.cookie, 'redroid-r3-gost', tpl.name, 'key-r3-gost-1');
  await waitNetState(app, H.cookie, created.id, ['HEALTHY']);

  redroidMock.proxyReachable.set({ ok: false, error: 'gost listener not accepting on 172.17.0.1:20082 (connect ECONNREFUSED)' });
  redroidMock.exec.set({ canary: { pass: false, reason: 'connect-failed' } });
  await app.redroidService.__tickOnceHealth(created.id);

  const body = await getDevice(app, H.cookie, created.id);
  assert.equal(body.device.proxy.network.state, 'BLOCKED');
  assert.equal(body.device.proxy.network.lastError.code, 'PROXY_UNREACHABLE');
  assert.equal(body.device.proxy.state, 'error');

  // counterfactual: if the data plane still verified (canary PASS), a flaky
  // listener probe is a PROBE ARTIFACT, not protection loss → not definite
  redroidMock.proxyReachable.set({ ok: false, error: 'probe artifact' });
  redroidMock.exec.set({}); // canary passes again
  const row = await tickUntil(app, created.id, (r) => r.netState === 'HEALTHY');
  assert.equal(row.netState, 'HEALTHY', 'a verified data plane outranks a failed listener probe (probe artifact tolerance)');
});

// ---------------------------------------------------------------------------
// 10. Manual retry endpoint — state guards
// ---------------------------------------------------------------------------

test('r3 retry guards: HEALTHY → 409 invalid state; non-proxied device → 409 no proxy', async (t) => {
  const { app, cookies, close } = await makeApp();
  const H = { cookie: cookies.operator };
  t.after(async () => { await close(); }); // guaranteed cleanup (failure path included)
  const tpl = await seedProxyTemplate(app, cookies.admin, 'tpl-r3-guard');
  const created = await createProxiedDevice(app, H.cookie, 'redroid-r3-guard', tpl.name, 'key-r3-guard-1');
  await waitNetState(app, H.cookie, created.id, ['HEALTHY']);

  const ok = await app.inject({ method: 'POST', url: `/api/devices/redroid/${created.id}/proxy/retry`, headers: H });
  assert.equal(ok.statusCode, 409, 'HEALTHY must reject a manual retry');
  assert.match(ok.json().error.message, /does not accept a manual retry/);

  // non-proxied device
  const noProxy = await app.inject({
    method: 'POST',
    url: '/api/devices/redroid',
    headers: H,
    payload: { name: 'redroid-r3-nopx', templateName: 'redroid-14-swiftshader', idempotencyKey: 'key-r3-nopx-1' },
  });
  assert.equal(noProxy.statusCode, 201, noProxy.body);
  const rej = await app.inject({ method: 'POST', url: `/api/devices/redroid/${noProxy.json().device.id}/proxy/retry`, headers: H });
  assert.equal(rej.statusCode, 409);
  assert.match(rej.json().error.message, /no proxy binding/);
});

// ---------------------------------------------------------------------------
// 11. Diagnostics zone 5 (proxied device) + zero-secret scan across endpoints
// ---------------------------------------------------------------------------

test('r3 diagnostics zone 5: proxied healthy device → executed+pass with check breakdown; zero secrets on every endpoint', async (t) => {
  const { app, cookies, close } = await makeApp();
  const H = { cookie: cookies.operator };
  t.after(async () => { await close(); }); // guaranteed cleanup (failure path included)
  const V = { cookie: cookies.viewer };
  const tpl = await seedProxyTemplate(app, cookies.admin, 'tpl-r3-diag');
  const created = await createProxiedDevice(app, H.cookie, 'redroid-r3-diag', tpl.name, 'key-r3-diag-1');
  await waitNetState(app, V.cookie, created.id, ['HEALTHY']);

  const diag = await app.inject({ method: 'POST', url: `/api/devices/redroid/${created.id}/diagnostics`, headers: H });
  assert.equal(diag.statusCode, 200, diag.body);
  const dnet = diag.json().diagnostics.network;
  assert.equal(dnet.executed, true);
  assert.equal(dnet.status, 'pass');
  assert.equal(dnet.state, 'HEALTHY');
  assert.equal(dnet.canary.result, 'PASS');
  assert.equal(dnet.checks.netcheck.process, 'alive');
  assert.equal(dnet.checks.proxy, 'PASS');
  assert.equal(dnet.checks.container, 'PASS');

  // zero-secret scan: create/list/get/refresh/diagnostics bodies
  const list = await app.inject({ method: 'GET', url: '/api/devices/redroid', headers: V });
  const one = await app.inject({ method: 'GET', url: `/api/devices/redroid/${created.id}`, headers: V });
  const refresh = await app.inject({ method: 'POST', url: `/api/devices/redroid/${created.id}/refresh`, headers: H });
  for (const [label, r] of [['create', { json: () => created }], ['list', list], ['get', one], ['refresh', refresh], ['diagnostics', diag]]) {
    assertNoSecrets(label === 'create' ? created : r.json(), label);
  }
  assert.equal(refresh.json().network.networkReady, true, 'refresh response carries the recomputed network payload');
});
