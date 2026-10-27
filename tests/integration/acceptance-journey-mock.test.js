/**
 * T6 acceptance dry-run (mock) — J1 / J5 / J7 state journeys on the fake device
 * adapter, CI-grade (no real device, no docker, no sidecar).
 *
 * Purpose (docs/acceptance-runbook.md 附 A): prove the acceptance journey's
 * CODE CONTRACTS never drift. This does NOT grant any J segment a real
 * `passed` verdict — honesty discipline: mock evidence = implemented-unverified
 * until the real-device stage runs the J script.
 *
 * Journeys:
 *   J1 — provision 10 acceptance identities: batch create → full replay
 *        (idempotent), fingerprint auto-ensure (deterministic), login axis
 *        starts PENDING_LOGIN for every identity.
 *   J3 — anchor state machine live-shape: PENDING→CONFIRMED operator
 *        transition + audit row; self-transition 409; credential-shaped
 *        evidence 400 (zero-secrets contract).
 *   J5 — task-day primitives: device lifecycle (create→start→stop→restart),
 *        task run create + cancel on the mock provider lane, manual
 *        intervention closed loop (acknowledge→assign→resolve) + signal
 *        dedupe (created:false, signalCount++).
 *   J7 — recycle/rebuild retention three paths (ADR-029 claim contract):
 *        delete keeps data+claim → same-identity re-claim allowed → foreign
 *        identity 409 → removeData=true releases both.
 *
 * Stream lease (J5 console lane) is NOT in this fake env (needs sidecar +
 * lease tables — covered by stream-ticket-idempotent + MC suites); honestly
 * noted, not silently skipped at the runbook level.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { makeRedroidTestApp, login } from '../helpers/redroid-fakes.js';

const NAMES = Array.from({ length: 10 }, (_, i) => `redroid-acc-${String(i + 1).padStart(2, '0')}`);

const CANARY_PROXY = 'socks5://wa-acc-user:acc-canary-s3cr3t@accproxy.mock:7803'; // fake, zero secrets discipline

async function makeAcceptanceApp() {
  // T2-style env: egress binding ON (claims + per-identity egress activate on
  // this switch), template carries the canary proxy (naked-defaults fail-closed
  // while ON). The mock never connects — deterministic. Egress IP journey is
  // J6's lane (t2/W3 suites); this dry-run sticks to J1/J3/J5/J7 state flows.
  const env = await makeRedroidTestApp({
    configOverride: { aiProvider: 'mock', egressBindingEnabled: true, egressEchoHost: 'echo.mock', egressEchoPort: 20287, egressProbeTimeoutMs: 1000 },
  });
  const admin = await login(env.app, 'admin');
  const operator = await login(env.app, 'operator');
  const tpl = await env.app.inject({
    method: 'POST', url: '/api/redroid/templates', headers: { cookie: admin },
    payload: { name: 'redroid-acc-tpl', image: 'redroid/redroid:14.0.0', androidVersion: '14', proxyUrl: CANARY_PROXY },
  });
  if (tpl.statusCode !== 201) throw new Error(`seed acc template: ${tpl.statusCode} ${tpl.body}`);
  return { ...env, admin, operator, templateName: 'redroid-acc-tpl', close: env.close };
}

/** Bind an identity to a pinned TEST-NET egress IP (per-identity proxy, W3). */
async function bindIdentity(app, adminCookie, identityId, ip) {
  const put = await app.inject({
    method: 'PUT', url: `/api/identities/${identityId}/egress`, headers: { cookie: adminCookie },
    payload: { proxyUrl: CANARY_PROXY, expectedEgressIp: ip },
  });
  assert.equal(put.statusCode, 200, put.body);
}

test('acceptance J1 mock — provision 10 identities, idempotent replay, fingerprints, PENDING_LOGIN', async (t) => {
  const { app, admin, close } = await makeAcceptanceApp();
  t.after(close);

  const r1 = await app.inject({ method: 'POST', url: '/api/identities/provision', headers: { cookie: admin }, payload: { names: NAMES, identityType: 'qa_device' } });
  assert.equal(r1.statusCode, 200, r1.body);
  const b1 = r1.json();
  assert.equal(b1.created, 10);
  assert.equal(b1.replayed, 0);
  assert.equal(b1.items.length, 10);

  // second run = pure replay (idempotency proof the j1 script re-enacts live)
  const r2 = await app.inject({ method: 'POST', url: '/api/identities/provision', headers: { cookie: admin }, payload: { names: NAMES, identityType: 'qa_device' } });
  const b2 = r2.json();
  assert.equal(b2.created, 0, 'replay must not create rows');
  assert.equal(b2.replayed, 10);

  for (const item of b2.items) {
    assert.equal(item.suggestedDeviceName, item.name); // pool 1:1 derivable contract
    const fp = await app.inject({ method: 'GET', url: `/api/identities/${item.identityId}/fingerprint`, headers: { cookie: admin } });
    assert.equal(fp.statusCode, 200);
    assert.ok(fp.json().profile, `fingerprint auto-ensured for ${item.name}`);
    const loginState = await app.inject({ method: 'GET', url: `/api/identities/${item.identityId}/login`, headers: { cookie: admin } });
    assert.equal(loginState.json().login.loginState, 'PENDING_LOGIN', item.name);
  }
});

test('acceptance J3 mock — Gmail anchor login machine: transition+audit, self 409, secret-evidence 400', async (t) => {
  const { app, admin, operator, close } = await makeAcceptanceApp();
  t.after(close);
  const prov = (await app.inject({ method: 'POST', url: '/api/identities/provision', headers: { cookie: admin }, payload: { names: [NAMES[0]] } })).json();
  const id = prov.items[0].identityId;

  const ok = await app.inject({
    method: 'POST', url: `/api/identities/${id}/login/transition`, headers: { cookie: operator },
    payload: { to: 'CONFIRMED_LOGGED_IN', evidence: 'J3 Gmail app manual login confirmed' },
  });
  assert.equal(ok.statusCode, 200, ok.body);

  const self = await app.inject({ method: 'POST', url: `/api/identities/${id}/login/transition`, headers: { cookie: operator }, payload: { to: 'CONFIRMED_LOGGED_IN' } });
  assert.equal(self.statusCode, 409);
  assert.equal(self.json().error.code, 'INVALID_LOGIN_TRANSITION');

  const secret = await app.inject({ method: 'POST', url: `/api/identities/${id}/login/transition`, headers: { cookie: operator }, payload: { to: 'LOGGED_OUT', evidence: 'entered password hunter2token' } });
  assert.equal(secret.statusCode, 400, 'credential-shaped evidence rejected (zero secrets)');

  const audit = (await app.inject({ method: 'GET', url: `/api/identities/${id}/login/audit`, headers: { cookie: admin } })).json();
  const row = audit.items.find((a) => a.toState === 'CONFIRMED_LOGGED_IN');
  assert.ok(row && row.fromState === 'PENDING_LOGIN' && row.actorUserId, 'audit row with actor exists');
});

test('acceptance J5 mock — device lifecycle + task run + manual intervention closed loop', async (t) => {
  const { app, admin, operator, close } = await makeAcceptanceApp();
  t.after(close);

  // device lane: create → start → stop → restart (P2 action protocol, mock adapter)
  const dev = await app.inject({
    method: 'POST', url: '/api/devices/redroid', headers: { cookie: operator },
    payload: { name: 'redroid-acc-j5', templateName: 'redroid-acc-tpl', idempotencyKey: 'j5-mock-dev-v1' },
  });
  assert.equal(dev.statusCode, 201, dev.body);
  const devId = dev.json().device.id;
  for (const action of ['start', 'stop', 'start']) {
    const r = await app.inject({ method: 'POST', url: `/api/devices/redroid/redroid-acc-j5/${action}`, headers: { cookie: operator } });
    assert.equal(r.statusCode, 200, `${action}: ${r.body}`);
  }
  const after = (await app.inject({ method: 'GET', url: `/api/devices/redroid/${devId}`, headers: { cookie: admin } })).json().device;
  assert.equal(after.containerState, 'running');

  // task lane (mock provider): create + cancel
  const run = await app.inject({
    method: 'POST', url: '/api/tasks/runs', headers: { cookie: operator },
    payload: { prompt: 'acceptance J5 mock task day', idempotencyKey: 'j5-mock-run-v1' },
  });
  assert.equal(run.statusCode, 202, run.body);
  const runId = run.json().taskRun.id;
  const cancel = await app.inject({ method: 'POST', url: `/api/tasks/runs/${runId}/cancel`, headers: { cookie: operator } });
  assert.equal(cancel.statusCode, 200, cancel.body);

  // intervention lane: open → ack → assign → resolve + dedupe signal
  const miBody = { source: 'operator_report', category: 'MANUAL_REVIEW', title: 'J5 mock drill', deviceId: devId, evidence: { note: 'drill note' } };
  const mi1 = await app.inject({ method: 'POST', url: '/api/manual-interventions', headers: { cookie: operator }, payload: miBody });
  assert.equal(mi1.statusCode, 201, mi1.body);
  const miId = mi1.json().intervention.id;
  const dup = await app.inject({ method: 'POST', url: '/api/manual-interventions', headers: { cookie: operator }, payload: miBody });
  assert.equal(dup.statusCode, 200);
  assert.equal(dup.json().created, false, 'dedupe: repeat signal does not create');
  assert.equal(dup.json().intervention.id, miId, 'dedupe: same open signal coalesces to the same intervention');
  for (const [path, payload] of [['acknowledge', { summary: 'seen — J5 drill' }], ['assign', {}], ['resolve', { summary: 'J5 mock drill closed' }]]) {
    const r = await app.inject({ method: 'POST', url: `/api/manual-interventions/${miId}/${path}`, headers: { cookie: operator }, payload });
    assert.equal(r.statusCode, 200, `${path}: ${r.body}`);
  }
  const fin = (await app.inject({ method: 'GET', url: `/api/manual-interventions/${miId}`, headers: { cookie: admin } })).json();
  assert.equal((fin.intervention ?? fin).status, 'resolved');
});

test('acceptance J7 mock — recycle/rebuild retention three paths (ADR-029 claim contract)', async (t) => {
  const { app, admin, close } = await makeAcceptanceApp();
  t.after(close);
  const prov = (await app.inject({ method: 'POST', url: '/api/identities/provision', headers: { cookie: admin }, payload: { names: [NAMES[1], NAMES[2]] } })).json();
  const idA = prov.items[0].identityId;
  const idB = prov.items[1].identityId;
  // W3 while ON: an identity-bound device requires the identity's egress binding
  await bindIdentity(app, admin, idA, '203.0.113.71');
  await bindIdentity(app, admin, idB, '203.0.113.72');

  const create = (name, identityId, key) => app.inject({
    method: 'POST', url: '/api/devices/redroid', headers: { cookie: admin },
    payload: { name, templateName: 'redroid-acc-tpl', idempotencyKey: key, identityId },
  });

  // A: bound create → default delete keeps data + claim
  const d1 = await create('redroid-acc-j7a', idA, 'j7-mock-a-1');
  assert.equal(d1.statusCode, 201, d1.body);
  const dataDir = d1.json().device.dataDir;
  assert.ok(fs.existsSync(dataDir), 'data dir created');
  const del = await app.inject({ method: 'DELETE', url: '/api/devices/redroid/redroid-acc-j7a', headers: { cookie: admin }, payload: { confirm: 'redroid-acc-j7a' } });
  assert.equal(del.statusCode, 200, del.body);
  assert.equal(del.json().dataRemoved, false, 'default delete keeps data');
  assert.equal(del.json().claimReleased, false, 'default delete keeps claim');
  assert.ok(fs.existsSync(dataDir), 'data survives delete (login-state asset retention basis)');

  // B: foreign identity on the claimed dir → 409 (fail-closed contamination guard)
  const foreign = await create('redroid-acc-j7a', idB, 'j7-mock-b-foreign');
  assert.equal(foreign.statusCode, 409, foreign.body);
  assert.equal(foreign.json().error.code, 'DATA_DIR_CLAIM_CONFLICT');

  // A: same-identity re-claim allowed (stop→remove→rebuild keeping /data = contract use)
  const again = await create('redroid-acc-j7a', idA, 'j7-mock-a-2');
  assert.equal(again.statusCode, 201, again.body);

  // C: removeData=true → data + claim released; fresh environment afterwards
  const delHard = await app.inject({
    method: 'DELETE', url: '/api/devices/redroid/redroid-acc-j7a', headers: { cookie: admin },
    payload: { confirm: 'redroid-acc-j7a', removeData: true },
  });
  assert.equal(delHard.statusCode, 200, delHard.body);
  assert.equal(delHard.json().dataRemoved, true, 'removeData removes data');
  assert.equal(delHard.json().claimReleased, true, 'removeData releases claim');
  assert.ok(!fs.existsSync(dataDir), 'data dir gone (fresh-env basis for J7-C human not-logged-in check)');

  // after release, identity B can take the same device name (no orphan claim)
  const byB = await create('redroid-acc-j7a', idB, 'j7-mock-c-after');
  assert.equal(byB.statusCode, 201, byB.body);
});
