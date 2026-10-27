/**
 * Account Generator (ADR-034) unit — persona generator: determinism,
 * region consistency, prefix rules + entropy, password policy, trinity
 * bindings, and the provision driver contract (human gates only, AUTO-SOLVE
 * forbidden by contract). Pure code — no DB, no containers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCOUNT_ROLES,
  ACCOUNT_ROLE_SEMANTICS,
  REGION_POOLS,
  PERSONA_REGIONS,
  PREFIX_STYLES,
  PASSWORD_POLICY,
  generateGmailPrefix,
  generatePassword,
  validatePasswordAgainstPolicy,
  mintAccountId,
  generatePersona,
  validatePersona,
  personaForStorage,
  summarizePersona,
} from '../../packages/shared/src/account-persona.js';
import { makeRng, POOL_LOCALES, POOL_TIMEZONES } from '../../packages/shared/src/fingerprint-profile.js';
import {
  PROVISION_GATE_INTERVENTION_CATEGORY,
  validateProvisionInput,
  validateProvisionEvent,
  createProvisionDriverStub,
  runProvisionStub,
} from '../../packages/shared/src/account-provision-contract.js';

const acct = (n) => `acct-${String(n).split('').map((d) => '23456789ABCDEFGHJKMNPQRSTVWXYZ'[Number(d) % 10 === 0 ? 0 : Number(d) % 10]).join('').padStart(10, '2').slice(-10)}`;
// distinct valid ids for sweeps (Crockford-subset counter, 10 chars)
const C32 = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const ids = (n) => Array.from({ length: n }, (_, i) => {
  let s = '';
  let x = i;
  for (let k = 0; k < 10; k++) { s += C32[x % 30]; x = Math.floor(x / 30) + k * 7 + 1; }
  return `acct-${s}`;
});

test('generator: deterministic — same accountId replays deep-equal persona (idempotent)', () => {
  for (const id of ids(25)) {
    for (const role of ACCOUNT_ROLES) {
      assert.deepEqual(generatePersona(id, { role }), generatePersona(id, { role }));
    }
  }
  const pws = new Set(ids(25).map((id) => generatePersona(id, { role: 'farm' }).password));
  assert.equal(pws.size, 25, 'distinct ids must not share passwords (vacuous guard)');
});

test('roles: allowlist fail-closed; semantics defined for every role (ADR-034 §1)', () => {
  assert.deepEqual([...ACCOUNT_ROLES], ['anchor', 'ops', 'farm', 'recovery']);
  for (const r of ACCOUNT_ROLES) {
    assert.ok(ACCOUNT_ROLE_SEMANTICS[r]?.length > 10, `semantics missing for ${r}`);
  }
  for (const bad of [undefined, null, '', 'admin', 'ANCHOR', 'farmer']) {
    assert.throws(() => generatePersona(acct(1), { role: bad }), /role/);
  }
});

test('regions: persona internally consistent (name pool ↔ locale ↔ timezone); pools intersect fleet pools', () => {
  for (const [code, pool] of Object.entries(REGION_POOLS)) {
    assert.ok(POOL_LOCALES.includes(pool.locale), `region ${code} locale ${pool.locale} not in fleet POOL_LOCALES`);
    assert.ok(POOL_TIMEZONES.includes(pool.timezone), `region ${code} tz ${pool.timezone} not in fleet POOL_TIMEZONES`);
    assert.ok(pool.given.length >= 8 && pool.family.length >= 8, `region ${code} pools too small`);
  }
  const regions = new Set();
  for (const id of ids(1200)) {
    const p = generatePersona(id, { role: 'farm' });
    assert.deepEqual(validatePersona(p), [], `persona ${id} invalid`);
    assert.equal(p.locale, REGION_POOLS[p.region].locale);
    assert.equal(p.timezone, REGION_POOLS[p.region].timezone);
    regions.add(p.region);
  }
  assert.equal(regions.size, PERSONA_REGIONS.length, `region sweep vacuous: ${regions.size}/${PERSONA_REGIONS.length}`);
});

test('region pin + prefix style pin work and stay valid', () => {
  const all = ids(30);
  let n = 0;
  for (const region of PERSONA_REGIONS) {
    for (const style of PREFIX_STYLES) {
      const p = generatePersona(all[n++ % all.length], { role: 'ops', region, style });
      assert.equal(p.region, region);
      assert.equal(p.gmail.style, style);
      assert.deepEqual(validatePersona(p), []);
    }
  }
  assert.throws(() => generatePersona(acct(1), { role: 'ops', region: 'xx' }), /region/);
  assert.throws(() => generatePersona(acct(1), { role: 'ops', style: 'emoji' }), /style|persona/);
});

test('gmail prefix: local-part rules + entropy recorded + no wa- smell (3 styles x 300)', () => {
  const re = /^[a-z0-9][a-z0-9.]{4,28}[a-z0-9]$/;
  for (const style of PREFIX_STYLES) {
    for (let i = 0; i < 300; i++) {
      const g = generateGmailPrefix(makeRng(`sweep-${style}-${i}`), style);
      assert.match(g.prefix, re, `${style} prefix ${g.prefix}`);
      assert.ok(!g.prefix.includes('..'), 'no consecutive dots');
      assert.ok(!/^wa[-_\d]/i.test(g.prefix), 'no wa- mechanical smell');
      assert.ok(g.entropyBits >= 16, `entropy floor ${style}: ${g.entropyBits}`);
    }
  }
  assert.throws(() => generateGmailPrefix(makeRng('x'), 'bogus'), /style/);
});

test('gmail prefix: 2000-account fleet spread — collision rate small but detectable (registry enforces uniqueness)', () => {
  const seen = new Set();
  let dup = 0;
  for (let i = 0; i < 2000; i++) {
    const p = generatePersona(mintAccountId(), { role: 'farm' });
    if (seen.has(p.gmail.prefix)) dup++;
    seen.add(p.gmail.prefix);
  }
  assert.ok(seen.size >= 1960, `collision burst: ${2000 - seen.size} dups (entropy regression?)`);
  assert.ok(dup < 40, `systemic collision burst (${dup})`);
});

test('password: policy classes enforced, entropy recorded >= floor; determinism + RED shapes', () => {
  const pool = Object.values(PASSWORD_POLICY.classes).join('');
  for (let i = 0; i < 200; i++) {
    const { password, meta } = generatePassword({ seed: `pw-sweep-${i}` });
    assert.deepEqual(validatePasswordAgainstPolicy(password, meta), []);
    assert.equal(password.length, PASSWORD_POLICY.length);
    for (const cls of Object.values(PASSWORD_POLICY.classes)) {
      assert.ok([...cls].some((c) => password.includes(c)), 'every class required');
    }
    assert.ok([...password].every((c) => pool.includes(c)), 'pool-only chars');
    assert.ok(meta.entropyBits >= PASSWORD_POLICY.minEntropyBits);
  }
  assert.equal(generatePassword({ seed: 'abc' }).password, generatePassword({ seed: 'abc' }).password);
  assert.notEqual(generatePassword({ seed: 'abc' }).password, generatePassword({ seed: 'abd' }).password);
  assert.ok(validatePasswordAgainstPolicy('short1!A', { policyId: PASSWORD_POLICY.policyId, entropyBits: 120 }).length > 0);
  assert.ok(validatePasswordAgainstPolicy('aaaaaaaaaaaaaaaaa!', { policyId: PASSWORD_POLICY.policyId, entropyBits: 40 }).length > 0);
  assert.ok(validatePasswordAgainstPolicy('aaaaaaaaaaaaaaaaa!', null).length > 0);
  assert.throws(() => generatePassword({}), /src/);
});

test('bindings (trinity, ADR-034 §4): both ids OR explicit deferral — never silence', () => {
  const bound = generatePersona(acct(31), {
    role: 'anchor',
    bindings: { fingerprintProfileId: 'fp-id-0001', egressProfileId: 'eg-profile-hk-7' },
  });
  assert.deepEqual(validatePersona(bound), []);
  for (const deferred of [false, true]) {
    // half-bound fails closed at GENERATION time (generator self-validates)
    assert.throws(
      () => generatePersona(acct(32), { role: 'farm', bindings: { fingerprintProfileId: 'fp-x-0001', egressProfileId: null, deferred } }),
      /BOTH/,
      `half-bound deferred=${deferred} must fail`,
    );
  }
  const d = generatePersona(acct(34), { role: 'farm' });
  assert.equal(d.bindings.deferred, true);
  assert.deepEqual(validatePersona(d), []);
  const m = structuredClone(bound);
  m.bindings.fingerprintProfileId = 'a!';
  assert.ok(validatePersona(m).length > 0);
});

test('validatePersona RED matrix: every consistency axis bites', () => {
  const base = generatePersona(acct(41), { role: 'ops', region: 'hk', bindings: { fingerprintProfileId: 'fp-0001', egressProfileId: 'eg-0001' } });
  const clone = () => structuredClone(base);
  const bite = (mut, re) => {
    const p = clone();
    mut(p);
    assert.ok(validatePersona(p).some((x) => re.test(x)), `expected problem matching ${re}`);
  };
  bite((p) => { p.locale = 'en-US'; }, /locale/);
  bite((p) => { p.timezone = 'Asia/Tokyo'; }, /timezone/);
  bite((p) => { p.name = { givenName: 'Emily', familyName: 'Smith' }; }, /region pool/);
  bite((p) => { p.birthday = '2019-01-01'; }, /adult window/);
  bite((p) => { p.birthday = '1990-13-01'; }, /YYYY-MM-DD/);
  bite((p) => { p.gmail.prefix = 'wa-1234'; }, /mechanical/);
  bite((p) => { p.gmail.prefix = 'ab1cd'; }, /local-part/);
  bite((p) => { p.role = 'admin'; }, /role/);
  bite((p) => { p.gmail.style = 'leet'; }, /style/);
  bite((p) => { p.gmail.entropyBits = 3; }, /entropy/);
  bite((p) => { delete p.password; }, /password/);
  bite((p) => { p.passwordMeta.entropyBits = 42; }, /entropy/);
  assert.ok(validatePersona(null).length > 0);
  assert.ok(validatePersona([]).length > 0);
});

test('storage/log projections carry zero plaintext passwords', () => {
  const p = generatePersona(mintAccountId(), { role: 'anchor' });
  const stored = personaForStorage(p);
  assert.ok(!('password' in stored), 'plaintext must be stripped for storage');
  assert.equal(stored.hasPassword, true);
  assert.deepEqual(stored.passwordMeta, p.passwordMeta);
  const line = summarizePersona(p);
  assert.ok(!line.includes(p.password), 'summary never leaks the password');
  assert.ok(!line.includes(p.gmail.prefix), 'summary masks the prefix');
  assert.match(line, /acct-\S+ \[anchor\]/);
  assert.match(line, /pw<108\.4 bits>/);
});

test('mintAccountId: shape + 500-way uniqueness (vacuous guard)', () => {
  const s = new Set(Array.from({ length: 500 }, mintAccountId));
  assert.equal(s.size, 500);
  for (const id of s) assert.match(id, /^acct-[2-9A-HJKMNP-TV-Z]{10}$/);
});

// ---------------------------------------------------------------------------
// Driver contract (registration automation — NEXT ticket implements Chrome)
// ---------------------------------------------------------------------------

test('contract: input validation fail-closed', () => {
  const p = generatePersona(acct(51), { role: 'ops' });
  assert.deepEqual(validateProvisionInput({ persona: p, credentials: { email: 'x@gmail.com', password: p.password } }), []);
  assert.ok(validateProvisionInput(null).length > 0);
  assert.ok(validateProvisionInput({ persona: p }).length > 0, 'credentials required');
  assert.ok(validateProvisionInput({ persona: p, credentials: { email: 'nope', password: p.password } }).length > 0);
  assert.ok(validateProvisionInput({ persona: p, credentials: { email: 'x@gmail.com', password: 'sh0rt' } }).length > 0);
  assert.ok(validateProvisionInput({ persona: p, credentials: { email: 'x@gmail.com', password: p.password }, refs: { identityId: 42 } }).length > 0);
});

test('contract: closed event set; AUTO-SOLVE forbidden; gates route to intervention console', () => {
  assert.deepEqual(validateProvisionEvent({ kind: 'STEP_PROGRESS', step: 'fill-profile' }), []);
  assert.ok(validateProvisionEvent({ kind: 'AUTO_SOLVED' }).some((x) => /closed set/.test(x)));
  assert.ok(validateProvisionEvent({ kind: 'HUMAN_GATE', gate: 'CAPTCHA', interventionCategory: PROVISION_GATE_INTERVENTION_CATEGORY, gateCleared: 'auto' }).some((x) => /forbidden/.test(x)));
  assert.ok(validateProvisionEvent({ kind: 'HUMAN_GATE', gate: 'SMS_VERIFICATION', interventionCategory: 'OTHER' }).some((x) => /EXTERNAL_VERIFICATION/.test(x)));
  for (const g of ['CAPTCHA', 'SMS_VERIFICATION', 'TOS_CONFIRMATION', 'RECOVERY_SETUP']) {
    assert.deepEqual(validateProvisionEvent({ kind: 'HUMAN_GATE', gate: g, interventionCategory: PROVISION_GATE_INTERVENTION_CATEGORY }), []);
  }
  assert.ok(validateProvisionEvent({ kind: 'HUMAN_GATE', gate: 'RECAPTCHA_V3_AUTO', interventionCategory: PROVISION_GATE_INTERVENTION_CATEGORY }).length > 0);
  assert.ok(validateProvisionEvent({ kind: 'CREDENTIALS_SEALED', vaultRef: 'vault/1', password: 'hunter2' }).some((x) => /credential shape/.test(x)));
  assert.ok(validateProvisionEvent({ kind: 'CREDENTIALS_SEALED' }).length > 0);
  assert.ok(validateProvisionEvent({ kind: 'TERMINAL_FAILURE' }).length > 0);
  assert.deepEqual(validateProvisionEvent({ kind: 'TERMINAL_FAILURE', failureCode: 'DRIVER_CRASH' }), []);
});

test('contract: STATE_TRANSITION events are T5-matrix-checked (driver cannot invent states)', () => {
  assert.deepEqual(validateProvisionEvent({ kind: 'STATE_TRANSITION', to: 'PROVISIONING' }, { fromState: 'PREPARING' }), []);
  assert.ok(validateProvisionEvent({ kind: 'STATE_TRANSITION', to: 'READY' }, { fromState: 'PREPARING' }).some((x) => /matrix/.test(x)));
  assert.ok(validateProvisionEvent({ kind: 'STATE_TRANSITION', to: 'PREPARING' }, { fromState: 'PREPARING' }).some((x) => /matrix/.test(x)), 'self-transition illegal (T5)');
  assert.ok(validateProvisionEvent({ kind: 'STATE_TRANSITION', to: 'ALMOST_READY' }, { fromState: 'READY' }).some((x) => /ACCOUNT_STATE/.test(x)));
  assert.ok(validateProvisionEvent({ kind: 'STATE_TRANSITION', to: 'DEAD', reasonCode: 'oops lowercase' }).some((x) => /reasonCode/.test(x)));
});

test('contract: stub run = matrix-legal event sequence parking at the human gate', async () => {
  const p = generatePersona(mintAccountId(), { role: 'farm' });
  const input = { persona: p, credentials: { email: `${p.gmail.prefix}@gmail.com`, password: p.password } };
  const r = await runProvisionStub(createProvisionDriverStub(), input);
  assert.deepEqual(r.problems, []);
  assert.equal(r.endState, 'PROVISIONING'); // parked at gate, never auto-cleared
  assert.equal(r.events.length, 4);
  assert.equal(r.events.at(-1).kind, 'HUMAN_GATE');
  assert.equal(r.events.at(-1).interventionCategory, PROVISION_GATE_INTERVENTION_CATEGORY);
  // invalid input refuses to run
  await assert.rejects(() => createProvisionDriverStub().drive({ persona: p }).next(), /invalid input/);
});
