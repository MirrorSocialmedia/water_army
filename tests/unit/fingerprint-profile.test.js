/**
 * W1 (ADR-025) unit — fingerprint profile module: deterministic generator
 * (idempotency), fail-closed validator, pairwise collision checker, and the
 * androidboot carrier builder. Code-level guarantees ONLY — real-device
 * consumption of these props is V3 (NOT VERIFIED, see ADR-025).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateFingerprintProfile,
  validateFingerprintProfile,
  findProfileCollisions,
  profileToRoOverrides,
  validateRoOverridesMap,
  mergeRoOverrides,
  buildRoCmdArgs,
  propToAndroidbootKey,
  PROFILE_FIELDS,
  PROFILE_PROP_MAP,
  UNIQUE_PROFILE_FIELDS,
} from '../../packages/shared/src/fingerprint-profile.js';

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
function fleetIds(n) {
  return Array.from({ length: n }, (_, i) => `w1-unit-identity-${String(i).padStart(4, '0')}`);
}

test('generator: deterministic — same identityId replays a deep-equal profile (idempotent regeneration)', () => {
  for (const id of fleetIds(10)) {
    const a = generateFingerprintProfile(id);
    const b = generateFingerprintProfile(id);
    assert.deepEqual(a, b, `profile for ${id} must replay exactly`);
  }
  // and distinct identities produce distinct unique fields
  const p1 = generateFingerprintProfile('w1-unit-identity-0001');
  const p2 = generateFingerprintProfile('w1-unit-identity-0002');
  assert.notEqual(p1.fingerprint, p2.fingerprint);
  assert.notEqual(p1.serial, p2.serial);
});

test('generator: rejects malformed identityIds (fail-closed input edge)', () => {
  for (const bad of [undefined, null, '', 'short', 'x'.repeat(65), 'has space', 'semi;colon']) {
    assert.throws(() => generateFingerprintProfile(bad), /identityId/, `must reject ${String(bad)}`);
  }
});

test('generator: 200-identity fleet — every profile valid, ZERO collisions on unique fields', () => {
  const ids = fleetIds(200);
  const entries = ids.map((identityId) => ({ identityId, profile: generateFingerprintProfile(identityId) }));
  for (const { identityId, profile } of entries) {
    assert.deepEqual(validateFingerprintProfile(profile), [], `profile ${identityId} must validate`);
    assert.ok(ID_RE.test(identityId));
  }
  const report = findProfileCollisions(entries); // ALL fields pairwise
  const blocking = report.collisions.filter((c) => c.uniqueField);
  assert.equal(blocking.length, 0, `unique-field collisions must be 0, got ${JSON.stringify(blocking.slice(0, 3))}`);
  // unique fields fully distinct across the fleet
  for (const field of UNIQUE_PROFILE_FIELDS) {
    const values = new Set(entries.map((e) => e.profile[field]));
    assert.equal(values.size, 200, `${field} must be unique across all 200 identities`);
  }
});

test('generator: 2000-identity margin — unique fields stay distinct (no flake: deterministic seeds)', () => {
  const entries = fleetIds(2000).map((identityId) => ({ identityId, profile: generateFingerprintProfile(identityId) }));
  const report = findProfileCollisions(entries, UNIQUE_PROFILE_FIELDS);
  assert.equal(report.blocking, false, `collisions at 2000: ${JSON.stringify(report.collisions.slice(0, 3))}`);
});

test('validator: fail-closed on unsafe values, missing fields, unknown keys, inconsistent fingerprint', () => {
  const good = generateFingerprintProfile('w1-unit-identity-0001');
  assert.deepEqual(validateFingerprintProfile(good), []);

  // space / '=' / quotes are kernel-cmdline killers (checked on a CARRIER field;
  // W1b: model itself may contain spaces — "Pixel 8 Pro" — it is %20-encoded for
  // the carrier, see ADR-028 / templateProfileToRoOverrides)
  for (const bad of ['has space', 'has=equals', 'has"quote', "has'quote", 'back\\slash', 'has\nnewline', '']) {
    const p = { ...good, brand: bad };
    assert.ok(validateFingerprintProfile(p).length > 0, `must reject brand="${bad}"`);
  }
  // W1b: model accepts real-world spaces but NOT '=' / quotes / % (reserved)
  assert.deepEqual(validateFingerprintProfile({ ...good, model: 'Pixel 8 Pro' }), []);
  for (const bad of ['has=equals', 'has"quote', 'pct%20sign']) {
    const p = { ...good, model: bad };
    assert.ok(validateFingerprintProfile(p).length > 0, `must reject model="${bad}"`);
  }
  // missing field
  const missing = { ...good };
  delete missing.serial;
  assert.ok(validateFingerprintProfile(missing).some((m) => /serial/.test(m)));
  // unknown field
  assert.ok(validateFingerprintProfile({ ...good, roguProp: 'x' }).some((m) => /unknown profile field/.test(m)));
  // fingerprint must reference brand/device (platform cross-check)
  assert.ok(validateFingerprintProfile({ ...good, fingerprint: `htc/${good.device}/x:15/A/1:userdebug/dev-keys` }).some((m) => /AOSP cross-check/.test(m)));
  // malformed mcc
  assert.ok(validateFingerprintProfile({ ...good, carrierMcc: 'HK1' }).some((m) => /carrierMcc/.test(m)));
  // non-object shapes
  for (const bad of [null, undefined, 'str', 42, []]) {
    assert.ok(validateFingerprintProfile(bad).length > 0, `must reject ${String(bad)}`);
  }
  // per-field length caps
  assert.ok(validateFingerprintProfile({ ...good, fingerprint: `a/${good.device}/${'z'.repeat(130)}:15/A/1:userdebug/dev-keys`, brand: 'a', device: 'b' }).length > 0);
});

test('validator: securityPatch is the only tolerated extra key', () => {
  const good = generateFingerprintProfile('w1-unit-identity-0001');
  assert.deepEqual(validateFingerprintProfile({ ...good, securityPatch: '2025-05-14' }), []);
});

test('collision checker: detects planted pairwise collisions; blocking only on unique fields', () => {
  const a = generateFingerprintProfile('w1-unit-identity-0001');
  const b = generateFingerprintProfile('w1-unit-identity-0002');
  // unique-field collision → blocking
  const r1 = findProfileCollisions([
    { identityId: 'id-a', profile: a },
    { identityId: 'id-b', profile: { ...b, fingerprint: a.fingerprint } },
  ]);
  assert.equal(r1.blocking, true);
  assert.ok(r1.collisions.some((c) => c.field === 'fingerprint' && c.uniqueField && c.identityIds.length === 2));
  // non-unique repeat (same model — two users, same phone) → informational only
  const r2 = findProfileCollisions([
    { identityId: 'id-a', profile: a },
    { identityId: 'id-b', profile: { ...b, model: a.model, brand: a.brand } },
  ]);
  assert.equal(r2.blocking, false);
  assert.ok(r2.collisions.some((c) => c.field === 'model' && !c.uniqueField));
  // clean pair
  const r3 = findProfileCollisions([
    { identityId: 'id-a', profile: a },
    { identityId: 'id-b', profile: b },
  ]);
  assert.equal(r3.collisions.filter((c) => c.uniqueField).length, 0);
});

test('carrier: propToAndroidbootKey namespacing + encoding', () => {
  assert.equal(propToAndroidbootKey('ro.build.fingerprint'), 'androidboot.oem_ro_build_fingerprint');
  assert.throws(() => propToAndroidbootKey('Bad Prop'), /invalid prop/);
  assert.throws(() => propToAndroidbootKey(''), /invalid prop/);
});

test('carrier: profileToRoOverrides maps exactly the registered props', () => {
  const p = generateFingerprintProfile('w1-unit-identity-0001');
  const map = profileToRoOverrides(p);
  assert.deepEqual(Object.keys(map).sort(), Object.values(PROFILE_PROP_MAP).sort());
  assert.equal(map['ro.build.fingerprint'], p.fingerprint);
  assert.equal(map['ro.product.model'], p.model);
  assert.equal(map['ro.serialno'], p.serial);
  // locale/timezone/carrier have NO ro.* carrier (settings-side, later phase)
  assert.ok(!Object.keys(map).some((k) => /locale|timezone|carrier/i.test(k)));
});

test('carrier: validateRoOverridesMap + mergeRoOverrides fail-closed', () => {
  assert.deepEqual(validateRoOverridesMap({}), []);
  assert.deepEqual(validateRoOverridesMap({ 'ro.product.model': 'Pixel7KQ' }), []);
  assert.ok(validateRoOverridesMap({ 'not.a.prop': 'x' }).length > 0);
  assert.ok(validateRoOverridesMap({ 'data.root': 'x' }).length > 0);
  assert.ok(validateRoOverridesMap({ 'ro.x': 'has space' }).length > 0);
  assert.ok(validateRoOverridesMap({ 'ro.x': 'has=eq' }).length > 0);
  assert.ok(validateRoOverridesMap(null).length > 0);
  const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`ro.p${i}`, 'v']));
  assert.ok(validateRoOverridesMap(tooMany).length > 0);

  const merged = mergeRoOverrides([{ 'ro.product.model': 'A' }, { 'ro.product.model': 'B', 'ro.serialno': 'S' }]);
  assert.deepEqual(merged.problems, []);
  assert.deepEqual(merged.overrides, { 'ro.product.model': 'B', 'ro.serialno': 'S' });
  const bad = mergeRoOverrides([{ 'ro.ok': 'fine' }, { 'ro.bad': 'no good' }]);
  assert.ok(bad.problems.length > 0);
});

test('carrier: buildRoCmdArgs deterministic order + throws on invalid (never partial)', () => {
  const args = buildRoCmdArgs({ 'ro.serialno': 'S1', 'ro.build.fingerprint': 'a/b/c:15/A/1:userdebug/dev-keys' });
  assert.deepEqual(args, [
    'androidboot.oem_ro_build_fingerprint=a/b/c:15/A/1:userdebug/dev-keys',
    'androidboot.oem_ro_serialno=S1',
  ]);
  assert.deepEqual(buildRoCmdArgs({}), []);
  assert.throws(() => buildRoCmdArgs({ 'ro.bad': 'has space' }), /invalid roOverrides/);
});

test('PROFILE_FIELDS registry matches the validator surface (drift guard)', () => {
  assert.equal(PROFILE_FIELDS.length, 15);
  assert.deepEqual(UNIQUE_PROFILE_FIELDS, ['fingerprint', 'serial', 'displayId']);
});
