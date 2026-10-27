/**
 * T2 (ADR-029) — identity login-state + provisioning + dataDir contract:
 * mock-integration tests (full stack: buildApp + fake db + mock redroid env).
 *
 * Scenarios:
 *   1. login-state routes: viewer read; RBAC on the only write surface
 *      (unauth 401 / viewer 403 / operator 200); audit via API; fail-closed
 *      codes (illegal 409 / unknown state 400 / unknown identity 404).
 *   2. provisioning: admin-only; batch create; IDEMPOTENT replay; dryRun;
 *      name validation; egress-IP pre-check fail-closed (zero writes);
 *      deterministic fingerprint ensure.
 *   3. identity↔dataDir claim across the device lifecycle: stamp → default
 *      delete KEEPS → same-identity rebuild re-inherits → other identity 409
 *      → one-identity-one-home 409 → removeData=true releases → adopt OK;
 *      unbound devices never touch claims.
 *
 * LIVE /data retention (real Android state) NOT VERIFIED here — mock env.
 * See ADR-029 real-device TODO.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { makeRedroidTestApp, login } from '../helpers/redroid-fakes.js';

const CANARY_PROXY = 'socks5://wa-canary-user:wa-canary-s3cr3t-t2@t2proxy.example:7803';
const IP_A = '203.0.113.31'; // TEST-NET-3
const IP_B = '203.0.113.32';

async function makeT2App() {
  const { app, db, dataRoot } = await makeRedroidTestApp({
    configOverride: {
      egressBindingEnabled: true,
      egressEchoHost: 'echo.mock',
      egressEchoPort: 20283,
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
    payload: { name: 'redroid-tpl-t2', image: 'redroid/redroid:14.0.0', androidVersion: '14', proxyUrl: CANARY_PROXY },
  });
  assert.equal(tpl.statusCode, 201, tpl.body);
  return {
    app, db, dataRoot, admin, operator, viewer,
    templateName: tpl.json().template.name,
    close: async () => { await app.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); },
  };
}

let seq = 0;
const next = (p) => `${p}-${(++seq).toString(16).padStart(4, '0')}`;

async function makeBoundIdentity(env, ip = IP_A) {
  seq += 1;
  const row = await env.db.identity.create({ data: { displayName: `t2-${seq}`, dataPath: `/data/wa/t2-${seq}` } });
  const put = await env.app.inject({
    method: 'PUT',
    url: `/api/identities/${row.id}/egress`,
    headers: { cookie: env.admin },
    payload: { proxyUrl: CANARY_PROXY, expectedEgressIp: ip },
  });
  assert.equal(put.statusCode, 200, put.body);
  return row.id;
}

const inject = (env, method, url, cookie, payload) =>
  env.app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload ? { payload } : {}) });

// ---------------------------------------------------------------- scenario 1
test('login-state routes: read (viewer+), manual transition (operator+), audit, fail-closed codes', async () => {
  const env = await makeT2App();
  try {
    const id = await makeBoundIdentity(env);
    assert.equal((await inject(env, 'GET', `/api/identities/${id}/login`)).statusCode, 401);
    const r = await inject(env, 'GET', `/api/identities/${id}/login`, env.viewer);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().login.loginState, 'PENDING_LOGIN');

    assert.equal((await inject(env, 'POST', `/api/identities/${id}/login/transition`, undefined, { to: 'CONFIRMED_LOGGED_IN' })).statusCode, 401);
    const denied = await inject(env, 'POST', `/api/identities/${id}/login/transition`, env.viewer, { to: 'CONFIRMED_LOGGED_IN' });
    assert.equal(denied.statusCode, 403, denied.body);
    const missing = await inject(env, 'POST', '/api/identities/00000000-0000-4000-8000-0000000000ff/login/transition', env.operator, { to: 'CONFIRMED_LOGGED_IN' });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'IDENTITY_NOT_FOUND');
    assert.equal((await inject(env, 'POST', `/api/identities/${id}/login/transition`, env.operator, { to: 'LOGGED_IN_FOREVER' })).statusCode, 400);

    // operator = the human who CLICKS (manual-only by construction).
    const t1 = await inject(env, 'POST', `/api/identities/${id}/login/transition`, env.operator, { to: 'CONFIRMED_LOGGED_IN', evidence: 'scanned QR, inbox code ok' });
    assert.equal(t1.statusCode, 200, t1.body);
    assert.equal(t1.json().loginState, 'CONFIRMED_LOGGED_IN');
    const again = await inject(env, 'POST', `/api/identities/${id}/login/transition`, env.operator, { to: 'CONFIRMED_LOGGED_IN' });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error.code, 'INVALID_LOGIN_TRANSITION');
    assert.equal((await inject(env, 'POST', `/api/identities/${id}/login/transition`, env.operator, { to: 'RELOGIN_REQUIRED', evidence: 'app re-verify prompt seen' })).statusCode, 200);
    assert.equal((await inject(env, 'POST', `/api/identities/${id}/login/transition`, env.operator, { to: 'CONFIRMED_LOGGED_IN' })).statusCode, 200);
    assert.equal((await inject(env, 'POST', `/api/identities/${id}/login/transition`, env.admin, { to: 'LOGGED_OUT', evidence: 'signed out of app' })).statusCode, 200);

    const audit = await inject(env, 'GET', `/api/identities/${id}/login/audit`, env.viewer);
    assert.equal(audit.statusCode, 200);
    const states = audit.json().items.map((a) => `${a.fromState}->${a.toState}`);
    assert.deepEqual([...states].reverse(), [
      'PENDING_LOGIN->CONFIRMED_LOGGED_IN',
      'CONFIRMED_LOGGED_IN->RELOGIN_REQUIRED',
      'RELOGIN_REQUIRED->CONFIRMED_LOGGED_IN',
      'CONFIRMED_LOGGED_IN->LOGGED_OUT',
    ]);
    assert.ok(audit.json().items[0].actorUserId);
    assert.ok(audit.json().items.every((a) => a.createdAt));

    // credential-shaped evidence rejected at the API edge (zero persistence)
    const leaky = await inject(env, 'POST', `/api/identities/${id}/login/transition`, env.operator, { to: 'PENDING_LOGIN', evidence: 'password=hunter2 reset' });
    assert.equal(leaky.statusCode, 400);
    const after = await inject(env, 'GET', `/api/identities/${id}/login/audit`, env.viewer);
    assert.ok(!JSON.stringify(after.json()).includes('hunter2'));
    assert.equal(after.json().items.length, 4);
  } finally { await env.close(); }
});

// ---------------------------------------------------------------- scenario 2
test('provisioning: admin-only, batch + idempotent replay + dryRun + egress pre-check (zero writes)', async () => {
  const env = await makeT2App();
  try {
    const names = ['redroid-qa-tk-001', 'redroid-qa-tk-002', 'redroid-qa-tk-003'];
    assert.equal((await inject(env, 'POST', '/api/identities/provision', env.viewer, { names })).statusCode, 403);
    assert.equal((await inject(env, 'POST', '/api/identities/provision', env.operator, { names })).statusCode, 403);
    assert.equal((await inject(env, 'POST', '/api/identities/provision', env.admin, { names: ['QA BAD NAME'] })).statusCode, 400);

    const dry = await inject(env, 'POST', '/api/identities/provision', env.admin, { names, dryRun: true, egressIps: [IP_A, IP_B, null] });
    assert.equal(dry.statusCode, 200, dry.body);
    assert.deepEqual(dry.json().items.map((i) => i.action), ['would_create', 'would_create', 'would_create']);
    assert.equal((await env.db.identity.findMany()).length, 0);

    // pre-existing fleet IP → collision → 409 whole batch, zero writes
    await makeBoundIdentity(env, IP_A);
    const clash = await inject(env, 'POST', '/api/identities/provision', env.admin, { names: ['redroid-qa-tk-001'], egressIps: [IP_A] });
    assert.equal(clash.statusCode, 409, clash.body);
    assert.equal(clash.json().error.code, 'EGRESS_IP_PRECHECK_FAILED');
    assert.equal((await env.db.identity.findMany()).length, 1);
    // duplicate WITHIN batch also fails closed
    const dupBatch = await inject(env, 'POST', '/api/identities/provision', env.admin, { names: ['redroid-qa-tk-001', 'redroid-qa-tk-002'], egressIps: [IP_B, IP_B] });
    assert.equal(dupBatch.statusCode, 409, dupBatch.body);
    assert.equal((await env.db.identity.findMany()).length, 1);

    const batch = await inject(env, 'POST', '/api/identities/provision', env.admin, { names, egressIps: [IP_B, null, null] });
    assert.equal(batch.statusCode, 200, batch.body);
    const j = batch.json();
    assert.equal(j.created, 3);
    assert.equal(j.replayed, 0);
    for (const [i, item] of j.items.entries()) {
      assert.equal(item.name, names[i]);
      assert.equal(item.suggestedDeviceName, names[i]);
      assert.ok(item.dataPath.endsWith(`/${names[i]}`), item.dataPath);
      assert.equal(item.fingerprint, 'ensured');
    }
    const fpRows = await env.db.identityFingerprint.findMany();
    assert.equal(fpRows.filter((r) => j.items.some((i) => i.identityId === r.identityId)).length, 3);

    // IDEMPOTENT replay → created=0/replayed=3, ids stable, zero new rows
    const ids = j.items.map((i) => i.identityId).sort();
    const replay = await inject(env, 'POST', '/api/identities/provision', env.admin, { names });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().created, 0);
    assert.equal(replay.json().replayed, 3);
    assert.deepEqual(replay.json().items.map((i) => i.identityId).sort(), ids);
    assert.equal((await env.db.identity.findMany()).length, 4);

    // fresh identities start at 待登入
    const st = await inject(env, 'GET', `/api/identities/${j.items[0].identityId}/login`, env.viewer);
    assert.equal(st.json().login.loginState, 'PENDING_LOGIN');
  } finally { await env.close(); }
});

// ---------------------------------------------------------------- scenario 3
test('identity<->dataDir claim: stamp → delete keeps → same-identity rebuild → other identity 409 → removeData releases', async () => {
  const env = await makeT2App();
  try {
    const idA = await makeBoundIdentity(env, IP_A);
    const idB = await makeBoundIdentity(env, IP_B);
    const name = 'redroid-t2-data-001';
    const dataDir = `${env.dataRoot}/${name}`;

    const c1 = await inject(env, 'POST', '/api/devices/redroid', env.operator, { name, templateName: env.templateName, identityId: idA, idempotencyKey: next('t2-idem') });
    assert.equal(c1.statusCode, 201, c1.body);
    let claim = await env.db.identityDataDirClaim.findUnique({ where: { dataDir } });
    assert.ok(claim && claim.identityId === idA);

    // DEFAULT delete → data + claim SURVIVE (pre-T2 behaviour, now owned)
    const d1 = await env.app.inject({ method: 'DELETE', url: `/api/devices/redroid/${name}`, headers: { cookie: env.admin }, payload: { confirm: name } });
    assert.equal(d1.statusCode, 200, d1.body);
    assert.equal(d1.json().claimReleased, false);
    assert.ok(await env.db.identityDataDirClaim.findUnique({ where: { dataDir } }), 'claim survives data-retaining delete');

    // DIFFERENT identity adopting same name (= same dir) → 409 fail-closed
    const adopt = await inject(env, 'POST', '/api/devices/redroid', env.operator, { name, templateName: env.templateName, identityId: idB, idempotencyKey: next('t2-idem') });
    assert.equal(adopt.statusCode, 409, adopt.body);
    assert.equal(adopt.json().error.code, 'DATA_DIR_CLAIM_CONFLICT');

    // SAME identity rebuild → allowed (stop→remove→recreate keeps /data — the flow the boss runs)
    const rebuild = await inject(env, 'POST', '/api/devices/redroid', env.operator, { name, templateName: env.templateName, identityId: idA, idempotencyKey: next('t2-idem') });
    assert.equal(rebuild.statusCode, 201, rebuild.body);
    claim = await env.db.identityDataDirClaim.findUnique({ where: { dataDir } });
    assert.equal(claim.identityId, idA);

    // one identity, ONE data home (split-brain rename fails closed)
    const second = await inject(env, 'POST', '/api/devices/redroid', env.operator, { name: 'redroid-t2-data-002', templateName: env.templateName, identityId: idA, idempotencyKey: next('t2-idem') });
    assert.equal(second.statusCode, 409, second.body);
    assert.equal(second.json().error.code, 'DATA_DIR_CLAIM_CONFLICT');

    // removeData=true + successful removal → claim RELEASED → B may adopt
    const d2 = await env.app.inject({ method: 'DELETE', url: `/api/devices/redroid/${name}`, headers: { cookie: env.admin }, payload: { confirm: name, removeData: true } });
    assert.equal(d2.statusCode, 200, d2.body);
    assert.equal(d2.json().dataRemoved, true, d2.body);
    assert.equal(d2.json().claimReleased, true);
    assert.equal(await env.db.identityDataDirClaim.findUnique({ where: { dataDir } }), null);
    const adoptB = await inject(env, 'POST', '/api/devices/redroid', env.operator, { name, templateName: env.templateName, identityId: idB, idempotencyKey: next('t2-idem') });
    assert.equal(adoptB.statusCode, 201, adoptB.body);

    // unbound devices never touch claims
    const unbound = await inject(env, 'POST', '/api/devices/redroid', env.operator, { name: 'redroid-t2-unbound-1', templateName: env.templateName, idempotencyKey: next('t2-idem') });
    assert.equal(unbound.statusCode, 201, unbound.body);
    assert.equal(await env.db.identityDataDirClaim.findUnique({ where: { dataDir: `${env.dataRoot}/t2-unbound-1` } }), null);
  } finally { await env.close(); }
});
