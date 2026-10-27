/**
 * T5 (ADR-030) mock-integration — Gmail provisioning pipeline.
 *
 * Scenarios (工單验收口径):
 *   1. happy path through the human gate: fresh start → CAPTCHA gate pauses
 *      (EXTERNAL_VERIFICATION ticket, blocked_pending_review) → resume is
 *      409 until an operator RESOLVES the ticket → READY; vault encrypted,
 *      masked shapes only; CANARY: zero secret fragments on any API response,
 *      db row, or audit surface.
 *   2. CAPTCHA gate deadline breach (ticket still open) → DEAD (terminal).
 *   3. recovery pool missing → fail-closed 503 BEFORE consuming quota.
 *   4. throttle: IP daily cap → 429; identity counter consumed once; global
 *      randomized-interval window → 429 THROTTLE_INTERVAL.
 *   5. manual overrides + RBAC + fail-closed codes + driver-disabled 503;
 *      login_state (T2 axis) never touched by the pipeline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { makeRedroidTestApp, login } from '../helpers/redroid-fakes.js';
import { decryptSecret, resolveProviderKey } from '../../packages/shared/src/provider-crypto.js';

const RECOVERY_POOL = ['wa-t5canaryrec@proton.example', 'wa-t5canaryrec2@proton.example'];
const CANARY_FRAGS = ['wa-t5canaryrec', 't5canaryrec', 'acct.'];

const BASE_GMAIL = {
  gmailProvisionEnabled: true,
  gmailRecoveryPool: RECOVERY_POOL,
  gmailPerIpDaily: 10,
  gmailPerIdentityDaily: 10,
  gmailMinIntervalMs: 0,
  gmailMaxIntervalMs: 0,
  gmailCaptchaTimeoutMs: 3_600_000,
};

async function makeT5App(gmail = {}) {
  const env = await makeRedroidTestApp({ configOverride: { ...BASE_GMAIL, ...gmail } });
  const admin = await login(env.app, 'admin');
  const operator = await login(env.app, 'operator');
  const viewer = await login(env.app, 'viewer');
  return {
    ...env, admin, operator, viewer,
    close: async () => { await env.app.close(); fs.rmSync(env.dataRoot, { recursive: true, force: true }); },
  };
}

let seq = 0;
async function makeIdentity(env) {
  seq += 1;
  const row = await env.db.identity.create({
    data: { displayName: `t5-${seq}`, externalRef: `rdev-t5-${seq}`, dataPath: `/data/wa/t5-${seq}` },
  });
  return row.id;
}
const inject = (env, method, url, cookie, payload) =>
  env.app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload ? { payload } : {}) });

function assertNoLeaks(label, value, extra = []) {
  const s = JSON.stringify(value) ?? '';
  for (const f of [...CANARY_FRAGS, ...extra]) {
    assert.ok(!s.includes(f), `${label}: leaked canary fragment '${f}'`);
  }
}

// ---------------------------------------------------------------- scenario 1
test('happy path: fresh start → CAPTCHA human gate (ticket) → resolve → resume → READY; vault encrypted + zero-secret surfaces', async () => {
  const env = await makeT5App();
  const bodies = [];
  try {
    const id = await makeIdentity(env);
    assert.equal((await inject(env, 'POST', `/api/identities/${id}/account/provision`, undefined)).statusCode, 401);
    assert.equal((await inject(env, 'POST', `/api/identities/${id}/account/provision`, env.viewer)).statusCode, 403);

    const fresh = await inject(env, 'POST', `/api/identities/${id}/account/provision`, env.operator);
    bodies.push(['fresh', fresh.body]);
    assert.equal(fresh.statusCode, 200, fresh.body);
    const p1 = fresh.json();
    assert.equal(p1.state, 'AWAITING_HUMAN');
    assert.ok(p1.interventionId);
    assert.ok(p1.awaitingDeadlineAt);

    // The ticket is a real P4 intervention: EXTERNAL_VERIFICATION, blocked.
    const ticket = await env.db.manualIntervention.findUnique({ where: { id: p1.interventionId } });
    assert.equal(ticket.category, 'EXTERNAL_VERIFICATION');
    assert.equal(ticket.source, 'external_verification');
    assert.equal(ticket.automationDisposition, 'blocked_pending_review');
    assert.equal(ticket.status, 'open');

    // Resume before the human acts → 409 (state preserved).
    const early = await inject(env, 'POST', `/api/identities/${id}/account/provision`, env.operator);
    bodies.push(['early', early.body]);
    assert.equal(early.statusCode, 409);
    assert.equal(early.json().error.code, 'AWAITING_HUMAN');

    // login_state (T2 axis) untouched by the pipeline — sibling boundary:
    const loginView = await inject(env, 'GET', `/api/identities/${id}/login`, env.viewer);
    assert.equal(loginView.json().login.loginState, 'PENDING_LOGIN');

    // Human resolves the CAPTCHA ticket → resume advances to READY.
    const resolved = await inject(env, 'POST', `/api/manual-interventions/${p1.interventionId}/resolve`, env.operator, { summary: 'captcha completed on device' });
    assert.equal(resolved.statusCode, 200, resolved.body);
    const done = await inject(env, 'POST', `/api/identities/${id}/account/provision`, env.operator);
    bodies.push(['done', done.body]);
    assert.equal(done.statusCode, 200, done.body);
    const p2 = done.json();
    assert.equal(p2.state, 'READY');
    assert.match(p2.emailMasked, /^..\*\*\*@gmail\.com$/);
    assert.match(p2.recoveryEmailMasked, /^..\*\*\*@proton\.example$/);

    // Vault: ciphertexts decrypt to sane plaintexts; only masked shapes.
    const vault = await env.db.gmailAccount.findUnique({ where: { identityId: id } });
    const key = resolveProviderKey('b'.repeat(48));
    const email = decryptSecret(vault.emailCipher, key);
    const password = decryptSecret(vault.passwordCipher, key);
    const recovery = decryptSecret(vault.recoveryEmailCipher, key);
    assert.match(email, /^acct\.[0-9a-f]{10}@gmail\.com$/);
    assert.ok(password.length >= 16 && /[A-Z]/.test(password) && /[0-9]/.test(password));
    assert.ok(RECOVERY_POOL.includes(recovery));
    assert.equal(vault.emailMasked, `${email.slice(0, 2)}***@gmail.com`);
    assert.equal(vault.recoveryEmailMasked, `${recovery.slice(0, 2)}***@proton.example`);
    assert.ok(vault.profileJson.givenName && vault.profileJson.birthday, 'realism profile stored');

    // GET account: masked summary only (ciphertext never leaves the vault).
    const view = await inject(env, 'GET', `/api/identities/${id}/account`, env.viewer);
    bodies.push(['view', view.body]);
    assert.equal(view.statusCode, 200);
    const acct = view.json();
    assert.equal(acct.account.state, 'READY');
    assert.equal(acct.vault.emailMasked, vault.emailMasked);
    assert.equal(acct.vault.hasPassword, true);
    assert.ok(!('emailCipher' in acct.vault) && !('passwordCipher' in acct.vault));

    // Audit trail: the full pipeline chain, system actors, scrubbed details.
    const audit = await inject(env, 'GET', `/api/identities/${id}/account/audit`, env.viewer);
    bodies.push(['audit', audit.body]);
    const chain = audit.json().items.map((r) => `${r.fromState}>${r.toState}`).reverse();
    assert.deepEqual(chain, [
      'PREPARING>PROVISIONING', 'PROVISIONING>AWAITING_HUMAN', 'AWAITING_HUMAN>PROVISIONING',
      'PROVISIONING>CREATED', 'CREATED>RECOVERY_SETUP', 'RECOVERY_SETUP>READY',
    ]);
    assert.ok(audit.json().items.every((r) => r.actorKind === 'system'));

    // CANARY: no secret-shaped fragment on ANY surface (responses + rows).
    const plaintexts = [email, password, recovery];
    for (const [label, body] of bodies) assertNoLeaks(label, body, plaintexts);
    assertNoLeaks('vault-row', { ...vault, emailCipher: 1, passwordCipher: 1, recoveryEmailCipher: 1 }, plaintexts);
    assertNoLeaks('lifecycle-row', await env.db.accountLifecycle.findUnique({ where: { identityId: id } }), plaintexts);
    assertNoLeaks('lifecycle-audits', await env.db.accountLifecycleAudit.findMany({}), plaintexts);

    // Re-provision a READY account → 409 (no silent re-run).
    const again = await inject(env, 'POST', `/api/identities/${id}/account/provision`, env.operator);
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error.code, 'ACCOUNT_ALREADY_READY');
  } finally { await env.close(); }
});

// ---------------------------------------------------------------- scenario 2
test('CAPTCHA deadline breach with the ticket still open → DEAD (terminal, failureCode audited)', async () => {
  const env = await makeT5App({ gmailCaptchaTimeoutMs: 40 });
  try {
    const id = await makeIdentity(env);
    const p1 = (await inject(env, 'POST', `/api/identities/${id}/account/provision`, env.operator)).json();
    assert.equal(p1.state, 'AWAITING_HUMAN');
    await new Promise((r) => setTimeout(r, 80));
    const dead = await inject(env, 'POST', `/api/identities/${id}/account/provision`, env.operator);
    assert.equal(dead.statusCode, 200, dead.body);
    assert.equal(dead.json().state, 'DEAD');
    assert.equal(dead.json().failureCode, 'CAPTCHA_TIMEOUT');
    const after = await inject(env, 'POST', `/api/identities/${id}/account/provision`, env.operator);
    assert.equal(after.statusCode, 409);
    assert.equal(after.json().error.code, 'ACCOUNT_DEAD');
    const audits = await env.db.accountLifecycleAudit.findMany({});
    assert.ok(audits.some((r) => r.toState === 'DEAD' && r.reasonCode === 'CAPTCHA_TIMEOUT'));
  } finally { await env.close(); }
});

// ---------------------------------------------------------------- scenario 3
test('missing recovery pool → fail-closed 503 BEFORE any quota/state move; configured pool provisions', async () => {
  const env = await makeT5App({ gmailRecoveryPool: [] });
  try {
    const id = await makeIdentity(env);
    const res = await inject(env, 'POST', `/api/identities/${id}/account/provision`, env.operator);
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, 'ACCOUNT_INPUT_MISSING');
    const lc = await env.db.accountLifecycle.findUnique({ where: { identityId: id } });
    assert.equal(lc.state, 'PREPARING', 'fail-closed: no state move');
    assert.equal((await env.db.gmailProvisionCounter.findMany({})).length, 0, 'no quota consumed');
    // a properly-configured deployment provisions fine (control):
    const env2 = await makeT5App();
    try {
      const id2 = await makeIdentity(env2);
      const ok = await inject(env2, 'POST', `/api/identities/${id2}/account/provision`, env2.operator);
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal(ok.json().state, 'AWAITING_HUMAN');
    } finally { await env2.close(); }
  } finally { await env.close(); }
});

// ---------------------------------------------------------------- scenario 4
test('throttle: IP daily cap → 429; identity counter consumed exactly once per fresh start; interval window → 429', async () => {
  // IP cap: pre-seed today's IP counter at the cap, bound identity to that IP.
  const env = await makeT5App({ gmailPerIpDaily: 1 });
  try {
    const id = await makeIdentity(env);
    await env.db.identityEgress.create({ data: { identityId: id, proxyUrlEncrypted: 'x', proxyUrlHash: 'h', expectedEgressIp: '203.0.113.61' } });
    const day = new Date().toISOString().slice(0, 10);
    await env.db.gmailProvisionCounter.create({ data: { id: 'ctr-ipseed', scopeKey: 'ip:203.0.113.61', day, count: 1 } });
    const res = await inject(env, 'POST', `/api/identities/${id}/account/provision`, env.operator);
    assert.equal(res.statusCode, 429);
    assert.equal(res.json().error.code, 'THROTTLE_IP_DAILY_LIMIT');
    const idRow = (await env.db.gmailProvisionCounter.findMany({})).find((r) => r.scopeKey === `id:${id}`);
    assert.ok(!idRow, 'throttled start consumes no identity quota');
  } finally { await env.close(); }

  // identity scope counter: exactly one increment per fresh start.
  const env2 = await makeT5App({ gmailPerIdentityDaily: 1 });
  try {
    const idA = await makeIdentity(env2);
    const a1 = await inject(env2, 'POST', `/api/identities/${idA}/account/provision`, env2.operator);
    assert.equal(a1.statusCode, 200, a1.body);
    const rows = await env2.db.gmailProvisionCounter.findMany({});
    const idRow = rows.find((r) => r.scopeKey === `id:${idA}`);
    assert.equal(idRow.count, 1, 'identity scope counter consumed exactly one fresh start');
  } finally { await env2.close(); }

  // global randomized interval (fixed 60s window here): second fresh start denied.
  const env3 = await makeT5App({ gmailMinIntervalMs: 60_000, gmailMaxIntervalMs: 60_000 });
  try {
    const idA = await makeIdentity(env3);
    const a = await inject(env3, 'POST', `/api/identities/${idA}/account/provision`, env3.operator);
    assert.equal(a.statusCode, 200, a.body);
    const idB = await makeIdentity(env3);
    const b = await inject(env3, 'POST', `/api/identities/${idB}/account/provision`, env3.operator);
    assert.equal(b.statusCode, 429);
    const err = b.json().error;
    assert.equal(err.code, 'THROTTLE_INTERVAL');
    assert.ok(err.details.retryAfterMs > 0);
  } finally { await env3.close(); }
});

// ---------------------------------------------------------------- scenario 5
test('manual override + RBAC + fail-closed codes + driver-disabled 503; login axis untouched', async () => {
  const env = await makeT5App();
  try {
    const id = await makeIdentity(env);
    assert.equal((await inject(env, 'GET', `/api/identities/${id}/account`)).statusCode, 401);
    const read = await inject(env, 'GET', `/api/identities/${id}/account`, env.viewer);
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().account.state, 'PREPARING');

    assert.equal((await inject(env, 'POST', `/api/identities/${id}/account/transition`, env.viewer, { to: 'DEAD' })).statusCode, 403);
    const bad = await inject(env, 'POST', `/api/identities/${id}/account/transition`, env.operator, { to: 'READY' });
    assert.equal(bad.statusCode, 409);
    assert.equal(bad.json().error.code, 'INVALID_ACCOUNT_TRANSITION');
    const unknown = await inject(env, 'POST', `/api/identities/${id}/account/transition`, env.operator, { to: 'BANNED' });
    assert.equal(unknown.statusCode, 400);
    const noIdent = await inject(env, 'GET', '/api/identities/deadbeef-0000-4000-8000-000000000000/account', env.viewer);
    assert.equal(noIdent.statusCode, 404);
    assert.equal(noIdent.json().error.code, 'IDENTITY_NOT_FOUND');

    // operator override PREPARING → DEAD is legal and audited as human.
    const killed = await inject(env, 'POST', `/api/identities/${id}/account/transition`, env.operator, { to: 'DEAD', reasonCode: 'OPERATOR_OVERRIDE' });
    assert.equal(killed.statusCode, 200, killed.body);
    assert.equal(killed.json().state, 'DEAD');
    const audits = (await inject(env, 'GET', `/api/identities/${id}/account/audit`, env.viewer)).json().items;
    assert.equal(audits[0].actorKind, 'human');
    assert.equal(audits[0].reasonCode, 'OPERATOR_OVERRIDE');
    // DEAD identity: driver refuses (identity retirement is a lifecycle fact,
    // login_state on the T2 axis is untouched either way):
    const provision = await inject(env, 'POST', `/api/identities/${id}/account/provision`, env.operator);
    assert.equal(provision.statusCode, 409);
    assert.equal(provision.json().error.code, 'ACCOUNT_DEAD');
    const loginView = await inject(env, 'GET', `/api/identities/${id}/login`, env.viewer);
    assert.equal(loginView.json().login.loginState, 'PENDING_LOGIN');
  } finally { await env.close(); }

  // driver-disabled (default OFF) → lifecycle reads work, provision 503s.
  const off = await makeT5App({ gmailProvisionEnabled: false });
  try {
    const id = await makeIdentity(off);
    assert.equal((await inject(off, 'GET', `/api/identities/${id}/account`, off.viewer)).json().account.state, 'PREPARING');
    const res = await inject(off, 'POST', `/api/identities/${id}/account/provision`, off.operator);
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, 'GMAIL_PROVISION_DISABLED');
  } finally { await off.close(); }
});
