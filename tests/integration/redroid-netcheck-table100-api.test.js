/**
 * T102 (BR-Acceptance C3-S2a follow-up) — API-level regression for the
 * netcheck table-100 EXACT-match fix.
 *
 * Pipeline under test (all REAL service code, hermetic):
 *   buildT2sNetcheckScript()  →  REAL script executed under POSIX sh with
 *   stubbed `ip`/`ps` emitting the C-item capture fixtures  →
 *   parseNetcheckOutput()  →  injected as the mock exec's NETCHECK line  →
 *   redroidService verify tick  →  API device payload + diagnostics zone 5
 *   + persisted netLastChecks.
 *
 * Proves (a) the `effective`-derived fields the API exposes are CORRECT in
 * both tunnel-alive and tunnel-dead states after the fix, (b) the verdict
 * (state machine) is INDEPENDENT of the fixed field — BLOCKED comes from
 * iface/route, not from `effective` (verdict invariance), and (c) the admin
 * UI derives its display from the SAME payload (netStateBadge/netCheckBadge
 * are pure functions over buildNetPayload output — no second source, no
 * duplicated matcher logic; the raw `effective` is NOT in the main payload,
 * it surfaces via diagnostics + the persisted breakdown only).
 *
 * The UI has no separate test runner (apps/web = Vite, no test script) —
 * the established repo pattern for UI logic is pure-function unit tests
 * (cf. tests/unit/web-batch-ui.test.js), which is what (c) does here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { makeRedroidTestApp, login } from '../helpers/redroid-fakes.js';
import { buildT2sNetcheckScript, parseNetcheckOutput, NET_PAYLOAD_KEYS, NET_CHECK_KEYS } from '../../apps/api/src/services/redroid-health.js';
import { runNetcheckScript } from '../helpers/netcheck-script-runner.js';
import * as FX from '../fixtures/netcheck-route-get-fixtures.js';
import { netStateBadge, netCheckBadge } from '../../apps/web/src/components/redroid-utils.js';

const PROXY_A = 'socks5://userA:topsecret-passw0rd@proxy-a.example:7801';
const FORBIDDEN = ['topsecret-passw0rd', 'socks5://', 'proxy-a.example', 'userA', 'proxyUrl'];

function assertNoSecrets(value, label) {
  const s = JSON.stringify(value);
  for (const frag of FORBIDDEN) {
    assert.ok(!s.includes(frag), `${label}: response leaked a secret fragment: '${frag}'`);
  }
}

async function makeApp() {
  const { app, db, dataRoot, redroidMock } = await makeRedroidTestApp();
  const admin = await login(app, 'admin');
  const operator = await login(app, 'operator');
  const tpl = await app.inject({
    method: 'POST',
    url: '/api/redroid/templates',
    headers: { cookie: admin },
    payload: { name: 'tpl-t102', image: 'redroid/redroid:14.0.0', androidVersion: '14', proxyUrl: PROXY_A },
  });
  assert.equal(tpl.statusCode, 201, tpl.body);
  return {
    app, db, redroidMock,
    cookie: operator,
    templateName: tpl.json().template.name,
    close: async () => { await app.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); },
  };
}

async function createDevice(env, name, key) {
  const res = await env.app.inject({
    method: 'POST',
    url: '/api/devices/redroid',
    headers: { cookie: env.cookie },
    payload: { name, templateName: env.templateName, idempotencyKey: key },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().device;
}

async function waitHealthy(env, id) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const res = await env.app.inject({ method: 'GET', url: `/api/devices/redroid/${id}`, headers: { cookie: env.cookie } });
    const state = res.json().device.proxy?.network?.state;
    if (state === 'HEALTHY') return res.json().device;
    if (Date.now() > deadline) throw new Error(`stuck at ${state}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Run the REAL generated netcheck script on fixture netns state → the parsed
 * object the service would derive (script + parser under test). */
function realParsed(stubs) {
  const { stdout } = runNetcheckScript(buildT2sNetcheckScript(), stubs);
  const p = parseNetcheckOutput(stdout);
  assert.equal(p.ok, true, `NETCHECK line must parse: ${JSON.stringify(stdout)}`);
  return p;
}

async function getNet(env, id) {
  const res = await env.app.inject({ method: 'GET', url: `/api/devices/redroid/${id}`, headers: { cookie: env.cookie } });
  assert.equal(res.statusCode, 200);
  return res.json().device.proxy.network;
}

async function diagNet(env, id) {
  const res = await env.app.inject({ method: 'POST', url: `/api/devices/redroid/${id}/diagnostics`, headers: { cookie: env.cookie } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().diagnostics.network;
}

// ---------------------------------------------------------------------------
// 1. Tunnel ALIVE — real script (verbatim R2 device capture) → API fields
// ---------------------------------------------------------------------------

test('t102 api: tunnel alive → effective=tunnel through the whole pipeline; UI badge consistent; zero secrets', async (t) => {
  const env = await makeApp();
  t.after(async () => { await env.close(); });
  const dev = await createDevice(env, 'redroid-t102-alive', 'key-t102-alive-1');
  await waitHealthy(env, dev.id);

  // REAL script on the verbatim tunnel-alive capture → the service's object
  const alive = realParsed({
    psLine: FX.PS_TUN2SOCKS_ALIVE,
    linkTun0: FX.IP_LINK_TUN0_UP,
    routeTable100: FX.TABLE_100_ROUTES_ALIVE,
    ruleShow: FX.IP_RULES_REAL_DEVICE,
    routeGet: FX.TUNNEL_ALIVE_ROUTE_GET,
  });
  assert.equal(alive.effective, 'tunnel', 'script-level: table-100 token present ⇒ tunnel');

  env.redroidMock.exec.set({ netcheck: alive });
  await env.app.redroidService.__tickOnceHealth(dev.id);
  const net = await getNet(env, dev.id);

  // state + consumer gate
  assert.equal(net.state, 'HEALTHY');
  assert.equal(net.networkReady, true);
  assert.equal(net.stale, false);
  // the five MD §6.2 checks — all PASS in the alive state
  assert.deepEqual(net.checks, { binary: 'PASS', process: 'PASS', interface: 'PASS', routePolicy: 'PASS', tcpCanary: 'PASS' });
  // payload contract: the raw `effective` is NOT part of the main payload
  assert.deepEqual(Object.keys(net).sort(), [...NET_PAYLOAD_KEYS].sort(), 'main payload = exactly the pinned contract keys (no raw effective leak)');
  assert.deepEqual(Object.keys(net.checks).sort(), [...NET_CHECK_KEYS].sort(), 'checks = exactly the five MD keys');

  // persisted breakdown — the field the fix corrects
  const row = env.db.__state.deviceRows.get(dev.id);
  assert.equal(row.netLastChecks.effectiveRoute, 'tunnel', 'DB netLastChecks.effectiveRoute = tunnel (alive)');
  assert.equal(row.netLastChecks.routePolicy, 'enforced');
  assert.equal(row.netLastChecks.interface, 'up');

  // diagnostics zone 5 — authoritative raw field, consistent with the DB
  const dnet = await diagNet(env, dev.id);
  assert.equal(dnet.state, 'HEALTHY');
  assert.equal(dnet.checks.netcheck.effective, 'tunnel', 'diagnostics expose the fixed field: tunnel');
  assert.equal(dnet.checks.netcheck.effective, row.netLastChecks.effectiveRoute, 'diagnostics and persisted breakdown are the SAME value (one source)');

  // admin UI (c): the badge renders from the SAME payload object the API
  // returns — no second derivation, so the UI cannot disagree with the fix
  const badge = netStateBadge(net);
  assert.equal(badge.state, 'HEALTHY');
  assert.equal(badge.label, 'HEALTHY (network verified)');
  assert.equal(badge.dispatch, 'ALLOWED');
  assert.deepEqual(netCheckBadge(net.checks.routePolicy), { label: 'PASS', cls: 'pill-up' });

  assertNoSecrets(net, 'device network payload');
  assertNoSecrets(dnet, 'diagnostics');
});

// ---------------------------------------------------------------------------
// 2. Tunnel DEAD + per-net table 1002 (the C3-S2a false positive) —
//    the regression case: field must say direct; verdict must stay BLOCKED
// ---------------------------------------------------------------------------

test('t102 api: tunnel dead + per-net 1002 → effective=direct (honest) AND verdict BLOCKED (invariant)', async (t) => {
  const env = await makeApp();
  t.after(async () => { await env.close(); });
  const dev = await createDevice(env, 'redroid-t102-dead1002', 'key-t102-dead1002-1');
  await waitHealthy(env, dev.id);

  // REAL script on the C3-S2a shape (tun0 freed, table-100 routes gone,
  // rule persists, fallback resolves via docker per-net table 1002,
  // harness zombie still ps-matches, canary dead)
  const dead = realParsed({
    psLine: FX.PS_TUN2SOCKS_ZOMBIE_HARNESS,
    linkTun0: FX.IP_LINK_TUN0_MISSING,
    routeTable100: FX.TABLE_100_ROUTES_DEAD,
    ruleShow: FX.IP_RULES_REAL_DEVICE,
    routeGet: FX.TUNNEL_DEAD_PERNET_1002_ROUTE_GET,
  });
  assert.equal(dead.effective, 'direct', 'script-level: "table 1002" is NOT the tunnel table (the fix)');
  assert.equal(dead.iface, 'missing');
  assert.equal(dead.route, 'missing');

  env.redroidMock.exec.set({ netcheck: dead, canary: { pass: false, reason: 'connect-failed' } });
  await env.app.redroidService.__tickOnceHealth(dev.id);
  const net = await getNet(env, dev.id);

  // VERDICT (invariant): definite protection loss → BLOCKED immediately,
  // via iface missing — NOT via the (fixed) effective field
  assert.equal(net.state, 'BLOCKED', 'verdict unchanged: BLOCKED on definite loss');
  assert.equal(net.lastErrorCode, 'TUNNEL_IFACE_MISSING');
  assert.equal(net.networkReady, false);
  assert.equal(net.checks.process, 'PASS', 'zombie ps artifact: still reads alive (documented harness shape)');
  assert.equal(net.checks.interface, 'FAIL');
  assert.equal(net.checks.routePolicy, 'FAIL');
  assert.equal(net.checks.tcpCanary, 'FAIL');

  // THE FIXED FIELD, end to end
  const row = env.db.__state.deviceRows.get(dev.id);
  assert.equal(row.netLastChecks.effectiveRoute, 'direct', 'DB: effectiveRoute=direct — pre-fix this was the misleading "tunnel"');
  const dnet = await diagNet(env, dev.id);
  assert.equal(dnet.checks.netcheck.effective, 'direct', 'diagnostics: honest direct');
  assert.equal(dnet.state, 'BLOCKED');
  assert.equal(dnet.checks.netcheck.effective, row.netLastChecks.effectiveRoute, 'one source: diagnostics === persisted');

  // admin UI (c): renders from the same BLOCKED payload
  const badge = netStateBadge(net);
  assert.equal(badge.state, 'BLOCKED');
  assert.equal(badge.label, 'BLOCKED (hard failure — fail-closed)');
  assert.equal(badge.cls, 'pill-down');
  assert.equal(badge.dispatch, 'BLOCKED');
  assert.deepEqual(netCheckBadge(net.checks.interface), { label: 'FAIL', cls: 'pill-down' });

  assertNoSecrets(net, 'device network payload (dead)');
  assertNoSecrets(dnet, 'diagnostics (dead)');
});

// ---------------------------------------------------------------------------
// 3. Tunnel DEAD on an INTERNAL net (FIB unreachable → effective=unknown) —
//    same verdict invariance, third field value
// ---------------------------------------------------------------------------

test('t102 api: tunnel dead, internal net → effective=unknown; verdict still BLOCKED via iface', async (t) => {
  const env = await makeApp();
  t.after(async () => { await env.close(); });
  const dev = await createDevice(env, 'redroid-t102-deadint', 'key-t102-deadint-1');
  await waitHealthy(env, dev.id);

  const dead = realParsed({
    psLine: FX.PS_TUN2SOCKS_ZOMBIE_HARNESS,
    linkTun0: FX.IP_LINK_TUN0_MISSING,
    routeTable100: FX.TABLE_100_ROUTES_DEAD,
    ruleShow: FX.IP_RULES_REAL_DEVICE,
    routeGet: FX.TUNNEL_DEAD_INTERNAL_ROUTE_GET, // C4-S2: RTNETLINK unreachable → empty stdout
  });
  assert.equal(dead.effective, 'unknown', 'script-level: nothing resolved ⇒ unknown (the C4-S2 live observation)');

  env.redroidMock.exec.set({ netcheck: dead, canary: { pass: false, reason: 'connect-failed' } });
  await env.app.redroidService.__tickOnceHealth(dev.id);
  const net = await getNet(env, dev.id);
  assert.equal(net.state, 'BLOCKED', 'verdict invariant: iface missing ⇒ definite ⇒ BLOCKED (not dependent on effective)');
  assert.equal(net.lastErrorCode, 'TUNNEL_IFACE_MISSING');

  const row = env.db.__state.deviceRows.get(dev.id);
  assert.equal(row.netLastChecks.effectiveRoute, 'unknown');
  const dnet = await diagNet(env, dev.id);
  assert.equal(dnet.checks.netcheck.effective, 'unknown');
  assert.deepEqual(netStateBadge(net), { label: 'BLOCKED (hard failure — fail-closed)', cls: 'pill-down', dispatch: 'BLOCKED', state: 'BLOCKED' });
});
