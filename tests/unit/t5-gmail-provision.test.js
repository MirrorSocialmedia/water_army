/**
 * T5 (ADR-030) unit — account lifecycle matrix + throttle evaluator +
 * realism profile + masking (+ ADR-029 §3 three-way mirror sync).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCOUNT_STATES,
  ACCOUNT_TRANSITIONS,
  isLegalAccountTransition,
  evaluateThrottle,
  throttleScopeKeys,
  dayKey,
  deriveAccountProfile,
  pickRecoveryEmail,
  maskEmail,
} from '../../packages/shared/src/gmail-provision.js';

import {
  ACCOUNT_TRANSITIONS_UI,
  LOGIN_TRANSITIONS_UI,
} from '../../apps/web/src/lib/batch-ui.js';

import {
  ACCOUNT_STATES as STATES_VIA_INDEX,
} from '../../packages/shared/src/index.js';

// ------------------------------------------------------------------- matrix
test('account matrix: every listed row legal, everything else (incl. self) illegal', () => {
  for (const from of ACCOUNT_STATES) {
    assert.ok(Array.isArray(ACCOUNT_TRANSITIONS[from]), `row missing for ${from}`);
    for (const to of ACCOUNT_STATES) {
      const expected = ACCOUNT_TRANSITIONS[from].includes(to);
      assert.equal(isLegalAccountTransition(from, to), expected, `${from}→${to}`);
      assert.equal(isLegalAccountTransition(from, from), false, `self-transition ${from} must be illegal`);
    }
  }
  // Semantic pins (工單語義):
  assert.deepEqual(ACCOUNT_TRANSITIONS.PREPARING, ['PROVISIONING', 'DEAD']);
  assert.deepEqual(ACCOUNT_TRANSITIONS.DEAD, [], 'DEAD is terminal');
  assert.ok(ACCOUNT_STATES.every((s) => s === 'DEAD' || ACCOUNT_TRANSITIONS[s].includes('DEAD') || s === 'DEAD'), 'death reachable from every non-terminal state');
  assert.ok(ACCOUNT_TRANSITIONS.AWAITING_HUMAN.includes('PROVISIONING'), 'gate resume returns to the driver loop');
  assert.ok(!ACCOUNT_TRANSITIONS.READY.includes('PROVISIONING'), 'READY never re-provisions');
  assert.ok(!ACCOUNT_STATES.includes('BANNED'), 'T2 four login states untouched on the login axis; ban lands as lifecycle DEAD');
});

test('three-way sync (ADR-029 §3): shared matrix === web mirror', () => {
  assert.deepEqual(Object.keys(ACCOUNT_TRANSITIONS_UI).sort(), [...ACCOUNT_STATES].sort());
  for (const from of ACCOUNT_STATES) {
    assert.deepEqual([...ACCOUNT_TRANSITIONS_UI[from]].sort(), [...ACCOUNT_TRANSITIONS[from]].sort(), `mirror drift on ${from}`);
  }
  // login matrix stays the T2 four states (sibling split changed nothing):
  assert.deepEqual(Object.keys(LOGIN_TRANSITIONS_UI).sort(), ['CONFIRMED_LOGGED_IN', 'LOGGED_OUT', 'PENDING_LOGIN', 'RELOGIN_REQUIRED']);
});

test('shared index re-exports the matrix (single source)', () => {
  assert.deepEqual([...STATES_VIA_INDEX].sort(), [...ACCOUNT_STATES].sort());
});

// ------------------------------------------------------------------ throttle
const T0 = new Date('2026-10-27T04:00:00.000Z');
const ctr = (m) => new Map(Object.entries(m));

test('throttle: IP daily cap fail-closed; identity cap; interval jitter', () => {
  const base = {
    perIpDaily: 2, perIdentityDaily: 1, minIntervalMs: 60_000, maxIntervalMs: 60_000,
    ip: '203.0.113.9', identityId: 'idn-a', counters: ctr({ 'ip:203.0.113.9': { count: 2 }, 'id:idn-a': { count: 0 } }),
    lastStartedAt: null, now: T0, rand: () => 0,
  };
  assert.deepEqual(evaluateThrottle(base), { ok: false, code: 'THROTTLE_IP_DAILY_LIMIT' });
  assert.deepEqual(evaluateThrottle({ ...base, counters: ctr({ 'ip:203.0.113.9': { count: 1 }, 'id:idn-a': { count: 1 } }) }), { ok: false, code: 'THROTTLE_IDENTITY_DAILY_LIMIT' });
  assert.deepEqual(evaluateThrottle({ ...base, counters: ctr({}) }), { ok: true });
  // interval: last start 30s ago, fixed 60s gap → deny with retry hint
  const v = evaluateThrottle({ ...base, counters: ctr({}), lastStartedAt: new Date(T0 - 30_000) });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'THROTTLE_INTERVAL');
  assert.ok(v.retryAfterMs > 29_000 && v.retryAfterMs <= 30_000, `retryAfterMs=${v.retryAfterMs}`);
  // jitter: rand=1 widens the gap to max (90s > 60s elapsed → still deny)
  const j = evaluateThrottle({
    ...base, minIntervalMs: 30_000, maxIntervalMs: 90_000, rand: () => 1,
    counters: ctr({}), lastStartedAt: new Date(T0 - 60_000),
  });
  assert.equal(j.code, 'THROTTLE_INTERVAL');
  // no bound IP → IP scope skipped entirely
  assert.deepEqual(evaluateThrottle({ ...base, ip: null, counters: ctr({ 'id:idn-a': { count: 5 } }) }).code ?? 'ok', 'THROTTLE_IDENTITY_DAILY_LIMIT');
});

test('throttle scope keys + UTC day key', () => {
  assert.deepEqual(throttleScopeKeys('abc', null), ['id:abc']);
  assert.deepEqual(throttleScopeKeys('abc', '1.2.3.4'), ['id:abc', 'ip:1.2.3.4']);
  assert.equal(dayKey(new Date('2026-10-27T23:59:59Z')), '2026-10-27');
});

// ------------------------------------------------------------------ profile
test('realism profile: deterministic per identity, sane shapes', () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const p1 = deriveAccountProfile(id);
  const p2 = deriveAccountProfile(id);
  assert.deepEqual(p1, p2, 'idempotent regeneration');
  assert.match(p1.birthday, /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
  const year = Number(p1.birthday.slice(0, 4));
  assert.ok(year >= 1985 && year <= 2002);
  assert.ok(p1.givenName.length > 0 && p1.familyName.length > 0);
  assert.ok(['male', 'female'].includes(p1.gender));
  const other = deriveAccountProfile('ffffffff-1111-4222-8333-444444444444');
  assert.notDeepEqual(p1, other, 'two identities get different profiles (anti-correlation)');
});

test('recovery pick: deterministic, empty pool → null (fail-closed input)', () => {
  const pool = ['r1@example.com', 'r2@example.org', 'not-an-email'];
  const a = pickRecoveryEmail('idn-a', pool);
  assert.equal(a, pickRecoveryEmail('idn-a', pool));
  assert.ok(pool.includes(a));
  assert.equal(pickRecoveryEmail('idn-a', []), null);
  assert.equal(pickRecoveryEmail('idn-a', undefined), null);
});

// ------------------------------------------------------------------ masking
test('maskEmail keeps domain, hides local part', () => {
  assert.equal(maskEmail('wa-canary-local@gmail.com'), 'wa***@gmail.com');
  assert.equal(maskEmail('x@gmail.com'), 'x***@gmail.com');
  assert.equal(maskEmail('garbage'), '***');
});
