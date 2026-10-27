/**
 * GAcct 段4 unit — HK persona upgrade: bilingual pairing (陳大文 ↔ Daniel
 * Chan), Cantonese romanisation discipline (jyutping document spellings,
 * NOT pinyin), name-echoing gmail prefixes, life-trajectory metadata, and
 * the fail-closed validator matrix for region hk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generatePersona,
  validatePersona,
  generateHkEnrichment,
  HK_SURNAME_POOL,
  HK_GIVEN_POOL,
  HK_TRAVEL_PATTERNS,
  REGION_POOLS,
  PERSONA_SCHEMA_VERSION,
} from '../../packages/shared/src/account-persona.js';
import { POOL_LOCALES, POOL_TIMEZONES } from '../../packages/shared/src/fingerprint-profile.js';

const C32 = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const ids = (n) => Array.from({ length: n }, (_, i) => {
  let s = ''; let x = i + 1;
  for (let k = 0; k < 10; k++) { s += C32[x % 30]; x = Math.floor(x / 30) + k * 7 + 1; }
  return `acct-${s}`;
});

test('hk persona: bilingual pairing is ONE story (zh ↔ latin ↔ email prefix)', () => {
  for (const id of ids(120)) {
    const p = generatePersona(id, { role: 'farm', region: 'hk' });
    assert.deepEqual(validatePersona(p), []);
    assert.equal(p.schemaVersion, PERSONA_SCHEMA_VERSION);
    assert.equal(p.timezone, 'Asia/Hong_Kong');
    assert.match(p.hk.zhName, /^[\u4e00-\u9fff]{2,4}$/);
    assert.equal(p.hk.zhName, p.hk.surname.zh + p.hk.given.zh);
    assert.equal(p.hk.latinName, `${p.name.givenName} ${p.name.familyName}`);
    // Cantonese romanisation: family jyut must be from the jyut pool, and
    // the family must NOT be a pinyin-majority spelling
    assert.ok(HK_SURNAME_POOL.some((s) => s.jyut === p.name.familyName));
    assert.ok(!['Chen', 'Huang', 'Zhang', 'Liu', 'Wu', 'Zeng', 'Xu'].includes(p.name.familyName), `pinyin family leaked: ${p.name.familyName}`);
    // email prefix echoes the person: <en-given-initial><family-jyut><digits>
    const expectHead = (p.hk.given.en[0] + p.hk.surname.jyut).toLowerCase();
    assert.ok(p.gmail.prefix.startsWith(expectHead), `${p.gmail.prefix} does not echo ${expectHead}`);
    assert.ok(p.gmail.entropyBits >= 16);
    assert.equal(p.gender, p.hk.given.gender);
  }
});

test('hk persona: gender + given distribution over a sweep (both genders, ≥10 distinct pairings)', () => {
  const genders = { M: 0, F: 0 };
  const pairings = new Set();
  const travels = new Set();
  for (const id of ids(300)) {
    const p = generatePersona(id, { role: 'farm', region: 'hk' });
    genders[p.gender]++;
    pairings.add(`${p.hk.zhName}|${p.hk.latinName}`);
    travels.add(p.hk.life.travelPattern);
  }
  assert.ok(genders.M > 60 && genders.F > 60, `gender split ${JSON.stringify(genders)}`);
  assert.ok(pairings.size >= 40, `only ${pairings.size} distinct pairings`);
  assert.ok(travels.size >= 3, 'life trajectory should vary across the fleet');
  for (const t of travels) assert.ok(HK_TRAVEL_PATTERNS.includes(t));
});

test('hk persona: deterministic — same id replays deep-equal (incl. hk + life)', () => {
  for (const id of ids(30)) {
    assert.deepEqual(generatePersona(id, { role: 'ops', region: 'hk' }), generatePersona(id, { role: 'ops', region: 'hk' }));
  }
});

test('hk persona: life metadata pools + zero-PII shape (fixed keys only)', () => {
  const h = generateHkEnrichment(ids(7)[0]);
  assert.equal(h.life.currency, 'HKD');
  assert.ok(['weekly', 'monthly', 'quarterly', 'rare'].includes(h.life.crossBorderFrequency));
  assert.deepEqual(Object.keys(h).sort(), ['gender', 'given', 'jyutping', 'latinName', 'life', 'nameOrder', 'surname', 'zhName'].sort());
  assert.deepEqual(Object.keys(h.life).sort(), ['crossBorderFrequency', 'currency', 'hasPlayStorePaymentMethod', 'social', 'spendingStyle', 'travelPattern'].sort());
});

test('hk validator RED matrix: every tamper of the bilingual pairing is caught', () => {
  const base = generatePersona(ids(11)[0], { role: 'farm', region: 'hk' });
  const t = (mut) => { const p = JSON.parse(JSON.stringify(base)); mut(p); return validatePersona(p); };
  assert.ok(t((p) => { p.hk.zhName = '陳大文'; }).length > 0);
  assert.ok(t((p) => { p.hk.latinName = 'Tom Chan'; }).length > 0);
  assert.ok(t((p) => { p.name.givenName = 'Tom'; }).length > 0);
  assert.ok(t((p) => { p.gender = p.gender === 'M' ? 'F' : 'M'; }).length > 0);
  assert.ok(t((p) => { delete p.hk; }).length > 0);
  assert.ok(t((p) => { p.hk.surname.jyut = 'Chen'; }).length > 0); // pinyin swap
  assert.ok(t((p) => { p.hk.life.travelPattern = 'mars-daily'; }).length > 0);
  assert.ok(t((p) => { p.hk.life.social.primaryPlatform = 'wechat'; }).length > 0);
  assert.ok(t((p) => { p.hk.life.hasPlayStorePaymentMethod = 'yes'; }).length > 0);
  assert.ok(t((p) => { p.gender = 'X'; }).length > 0);
  assert.deepEqual(t((p) => p), []); // control: untouched stays valid
});

test('non-hk personas: carry gender, no hk block, stay valid (en-US default untouched)', () => {
  for (const region of ['us', 'gb', 'jp', 'cn']) {
    const p = generatePersona(ids(5)[0], { role: 'ops', region });
    assert.deepEqual(validatePersona(p), []);
    assert.equal(p.hk, undefined);
    assert.ok(['M', 'F'].includes(p.gender));
    assert.equal(p.gender, undefined === p.gender ? undefined : p.gender);
  }
});

test('schema v1 rows stay readable: v1-shaped persona validates (no forced migration)', () => {
  const p = generatePersona(ids(4)[0], { role: 'ops', region: 'us' });
  const v1 = JSON.parse(JSON.stringify(p));
  v1.schemaVersion = 1;
  delete v1.gender;
  delete v1.hk;
  assert.deepEqual(validatePersona(v1), []);
});

test('hk pools ⊆ persona REGION pool membership (validator consistency) + device-layer intersection', () => {
  for (const g of HK_GIVEN_POOL) assert.ok(REGION_POOLS.hk.given.includes(g.en), `given ${g.en} missing from REGION_POOLS.hk`);
  for (const s of HK_SURNAME_POOL) assert.ok(REGION_POOLS.hk.family.includes(s.jyut), `family ${s.jyut} missing from REGION_POOLS.hk`);
  assert.ok(POOL_LOCALES.includes(REGION_POOLS.hk.locale));
  assert.ok(POOL_TIMEZONES.includes(REGION_POOLS.hk.timezone));
});

test('explicit style override wins over hk echo (wordnum stays wordnum)', () => {
  const p = generatePersona(ids(2)[0], { role: 'farm', region: 'hk', style: 'wordnum' });
  assert.equal(p.gmail.style, 'wordnum');
  assert.deepEqual(validatePersona(p), []);
});
