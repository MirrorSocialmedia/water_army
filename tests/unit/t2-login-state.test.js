/**
 * T2 (ADR-029) — login-state machine UNIT tests.
 *
 * The transition matrix is fail-closed by contract: EVERY pair not listed in
 * LOGIN_TRANSITIONS must be rejected 409 (including all self-transitions).
 * This test enumerates the full 4×4 matrix so a future matrix edit can only
 * land as an intentional, reviewed change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { LOGIN_STATES, LOGIN_TRANSITIONS, isLegalLoginTransition, createLoginStateService } from '../../apps/api/src/services/login-state-service.js';
import { makeFakeDb } from '../helpers/fakes.js';

const LEGAL = new Set([
  'PENDING_LOGIN→CONFIRMED_LOGGED_IN',
  'PENDING_LOGIN→LOGGED_OUT',
  'CONFIRMED_LOGGED_IN→RELOGIN_REQUIRED',
  'CONFIRMED_LOGGED_IN→LOGGED_OUT',
  'RELOGIN_REQUIRED→CONFIRMED_LOGGED_IN',
  'RELOGIN_REQUIRED→PENDING_LOGIN',
  'RELOGIN_REQUIRED→LOGGED_OUT',
  'LOGGED_OUT→PENDING_LOGIN',
]);

test('matrix: full 4×4 enumeration matches the reviewed legal set exactly', () => {
  const seen = new Set();
  for (const from of LOGIN_STATES) {
    for (const to of LOGIN_STATES) {
      const key = `${from}→${to}`;
      seen.add(key);
      assert.equal(isLegalLoginTransition(from, to), LEGAL.has(key), `${key} legality mismatch — matrix edited without updating this test`);
    }
  }
  assert.equal(seen.size, 16);
  // The operator's three mandated semantics are reachable:
  assert.ok(LEGAL.has('PENDING_LOGIN→CONFIRMED_LOGGED_IN')); // 待登入 → 已確認登入
  assert.ok(LEGAL.has('CONFIRMED_LOGGED_IN→RELOGIN_REQUIRED')); // → 需重新驗證
  assert.ok(LEGAL.has('RELOGIN_REQUIRED→CONFIRMED_LOGGED_IN')); // → 重新登入確認
  // CONFIRMED_LOGGED_IN has NO auto-edge in either direction beyond human ones:
  assert.deepEqual([...LOGIN_TRANSITIONS.CONFIRMED_LOGGED_IN], ['RELOGIN_REQUIRED', 'LOGGED_OUT']);
});

test('matrix: no self-transition is legal (repeat click = 409, not a no-op)', () => {
  for (const s of LOGIN_STATES) assert.equal(isLegalLoginTransition(s, s), false, `${s} self-transition must be rejected`);
});

async function svcWithIdentity(overrides = {}) {
  const db = makeFakeDb();
  const ident = await db.identity.create({ data: { displayName: 't2-unit', dataPath: '/data/wa/t2-unit', ...overrides } });
  return { db, id: ident.id, svc: createLoginStateService({ db }) };
}

test('service: happy path PENDING → CONFIRMED → RELOGIN → CONFIRMED writes audit rows', async () => {
  const { db, id, svc } = await svcWithIdentity();
  const view = await svc.getLoginState(id);
  assert.equal(view.loginState, 'PENDING_LOGIN');
  assert.equal(view.loginStateSince, null);

  const t1 = await svc.transition(id, 'CONFIRMED_LOGGED_IN', { actorUserId: 'user-1', evidence: 'scan QR + verification code ok' });
  assert.equal(t1.loginState, 'CONFIRMED_LOGGED_IN');
  const t2 = await svc.transition(id, 'RELOGIN_REQUIRED', { actorUserId: 'user-2', evidence: 'app asked to re-verify' });
  assert.equal(t2.loginState, 'RELOGIN_REQUIRED');
  await svc.transition(id, 'CONFIRMED_LOGGED_IN', { actorUserId: 'user-2' });

  const audit = await db.identityLoginAudit.findMany({ where: { identityId: id } });
  assert.equal(audit.length, 3);
  assert.deepEqual(audit.map((a) => [a.fromState, a.toState]), [
    ['PENDING_LOGIN', 'CONFIRMED_LOGGED_IN'],
    ['CONFIRMED_LOGGED_IN', 'RELOGIN_REQUIRED'],
    ['RELOGIN_REQUIRED', 'CONFIRMED_LOGGED_IN'],
  ]);
  assert.equal(audit[0].actorUserId, 'user-1');
  assert.equal(audit[0].evidenceJson.note, 'scan QR + verification code ok');
  // audit view is newest-first
  const listed = await svc.listAudit(id);
  assert.equal(listed.items[0].toState, 'CONFIRMED_LOGGED_IN');
  assert.equal(listed.items[0].fromState, 'RELOGIN_REQUIRED');
});

test('service: illegal transition → 409 INVALID_LOGIN_TRANSITION, zero writes', async () => {
  const { db, id, svc } = await svcWithIdentity();
  await svc.transition(id, 'CONFIRMED_LOGGED_IN', { actorUserId: 'u' });
  const e2 = await svc.transition(id, 'CONFIRMED_LOGGED_IN', { actorUserId: 'u' }).then(() => null, (e) => e);
  assert.equal(e2.apiCode, 'INVALID_LOGIN_TRANSITION');
  assert.equal(e2.httpStatus, 409);
  const e3 = await svc.transition(id, 'PENDING_LOGIN', { actorUserId: 'u' }).then(() => null, (e) => e);
  assert.equal(e3.apiCode, 'INVALID_LOGIN_TRANSITION'); // CONFIRMED→PENDING not in matrix
  // exactly ONE successful transition happened → one audit row, state unchanged
  const audit = await db.identityLoginAudit.findMany({ where: { identityId: id } });
  assert.equal(audit.length, 1);
  const view = await svc.getLoginState(id);
  assert.equal(view.loginState, 'CONFIRMED_LOGGED_IN');
});

test('service: unknown state 400 / unknown identity 404 / credential evidence 400', async () => {
  const { id, svc } = await svcWithIdentity();
  const e1 = await svc.transition(id, 'LOGGED_IN_FOREVER', { actorUserId: 'u' }).then(() => null, (e) => e);
  assert.equal(e1.httpStatus, 400);
  const e2 = await svc.transition('00000000-0000-4000-8000-000000000000', 'CONFIRMED_LOGGED_IN', {}).then(() => null, (e) => e);
  assert.equal(e2.apiCode, 'IDENTITY_NOT_FOUND');
  assert.equal(e2.httpStatus, 404);
  const e3 = await svc.transition(id, 'CONFIRMED_LOGGED_IN', { evidence: 'saved my password=hunter2 here' }).then(() => null, (e) => e);
  assert.equal(e3.httpStatus, 400); // credential-shaped value scrub rule
});

test('service: evidence length-capped, missing actor allowed as null (route always supplies one)', async () => {
  const { id, svc } = await svcWithIdentity();
  const t = await svc.transition(id, 'CONFIRMED_LOGGED_IN', { evidence: 'x'.repeat(900) });
  const listed = await svc.listAudit(id);
  assert.ok(listed.items[0].evidence.note.length <= 500);
  assert.ok(t.auditId);
});
