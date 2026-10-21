/**
 * BR-B1 — identity data-path isolation (施工 MD §4.1/§9.1 + §14.1):
 *   - canonical layout: <root>/<identityId>/data + /artifacts
 *   - path validation: traversal, prefix escape, non-root, type errors
 *   - duplicate mount-source detection (B3 container mount preflight)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  identityDataPaths,
  validateIdentityDataPath,
  findDuplicateMountSources,
  IDENTITY_DATA_ROOT_DEFAULT,
} from '@water-army/shared';

const ID1 = '018f6a2e-3b1c-4d2e-9f30-0a1b2c3d4e5f';
const ID2 = '018f6a2e-3b1c-4d2e-9f30-0a1b2c3d4e60';

test('identityDataPaths: canonical two-path layout under the root', () => {
  const paths = identityDataPaths(ID1);
  assert.equal(paths.data, `${IDENTITY_DATA_ROOT_DEFAULT}/${ID1}/data`);
  assert.equal(paths.artifacts, `${IDENTITY_DATA_ROOT_DEFAULT}/${ID1}/artifacts`);
});

test('identityDataPaths honours a custom root (trailing slash normalised)', () => {
  const paths = identityDataPaths(ID1, '/mnt/vol/identities/');
  assert.equal(paths.data, '/mnt/vol/identities/018f6a2e-3b1c-4d2e-9f30-0a1b2c3d4e5f/data');
});

test('identityDataPaths: non-uuid id → TypeError (uuid is the isolation unit)', () => {
  assert.throws(() => identityDataPaths('not-a-uuid'), TypeError);
  assert.throws(() => identityDataPaths(''), TypeError);
});

test('validateIdentityDataPath: a valid path under the root is accepted and canonicalized', () => {
  const ok = validateIdentityDataPath(IDENTITY_DATA_ROOT_DEFAULT, `${IDENTITY_DATA_ROOT_DEFAULT}/${ID1}/data`);
  assert.equal(ok.ok, true);
  assert.equal(ok.canonical, `${IDENTITY_DATA_ROOT_DEFAULT}/${ID1}/data`);
});

test('validateIdentityDataPath: the root ITSELF is a valid canonical point (ok, no escape)', () => {
  const res = validateIdentityDataPath(IDENTITY_DATA_ROOT_DEFAULT, IDENTITY_DATA_ROOT_DEFAULT);
  assert.equal(res.ok, true);
  assert.equal(res.canonical, IDENTITY_DATA_ROOT_DEFAULT);
});

test('validateIdentityDataPath: a path OUTSIDE the root is rejected (isolation boundary)', () => {
  const bad = validateIdentityDataPath(IDENTITY_DATA_ROOT_DEFAULT, '/data/water_army/other/x/data');
  assert.equal(bad.ok, false);
  assert.ok(bad.reason);
});

test('validateIdentityDataPath: dot-segment traversal is rejected (no /../../ escape)', () => {
  const bad = validateIdentityDataPath(IDENTITY_DATA_ROOT_DEFAULT, `${IDENTITY_DATA_ROOT_DEFAULT}/${ID1}/../../etc/passwd`);
  assert.equal(bad.ok, false, `reason: ${bad.reason}`);
});

test('validateIdentityDataPath: prefix-escape (identities-evil) is rejected, not treated as the root prefix', () => {
  const bad = validateIdentityDataPath(IDENTITY_DATA_ROOT_DEFAULT, '/data/water_army/identities-evil/abc');
  assert.equal(bad.ok, false, `reason: ${bad.reason}`);
});

test('validateIdentityDataPath: relative paths, NUL bytes, whitespace padding → rejected', () => {
  assert.equal(validateIdentityDataPath(IDENTITY_DATA_ROOT_DEFAULT, 'relative/data').ok, false);
  assert.equal(validateIdentityDataPath(IDENTITY_DATA_ROOT_DEFAULT, `/a\0b`).ok, false);
  assert.equal(validateIdentityDataPath(IDENTITY_DATA_ROOT_DEFAULT, ` ${IDENTITY_DATA_ROOT_DEFAULT}/${ID1}/data`).ok, false);
  assert.equal(validateIdentityDataPath(IDENTITY_DATA_ROOT_DEFAULT, `${IDENTITY_DATA_ROOT_DEFAULT}//${ID1}/data`).ok, false, 'duplicate slash = malformed');
});

test('validateIdentityDataPath: type garbage is rejected, not thrown', () => {
  assert.equal(validateIdentityDataPath(IDENTITY_DATA_ROOT_DEFAULT, null).ok, false);
  assert.equal(validateIdentityDataPath(IDENTITY_DATA_ROOT_DEFAULT, 42).ok, false);
  assert.equal(validateIdentityDataPath(IDENTITY_DATA_ROOT_DEFAULT, '').ok, false);
  assert.equal(validateIdentityDataPath('relative-root', `${IDENTITY_DATA_ROOT_DEFAULT}/${ID1}/data`).ok, false, 'root must be absolute');
});

test('findDuplicateMountSources: a shared dataPath across identities is flagged (the B3 preflight input)', () => {
  const mounts = [
    { id: ID1, dataPath: '/data/water_army/identities/shared' },
    { id: ID2, dataPath: '/data/water_army/identities/shared' },
    { id: ID1, dataPath: `${IDENTITY_DATA_ROOT_DEFAULT}/${ID1}/data` },
    { id: ID2, dataPath: `${IDENTITY_DATA_ROOT_DEFAULT}/${ID2}/data` },
  ];
  assert.deepEqual(findDuplicateMountSources(mounts), ['/data/water_army/identities/shared']);
});

test('findDuplicateMountSources: distinct per-identity paths → no duplicates', () => {
  const mounts = [
    { id: ID1, dataPath: `${IDENTITY_DATA_ROOT_DEFAULT}/${ID1}/data` },
    { id: ID2, dataPath: `${IDENTITY_DATA_ROOT_DEFAULT}/${ID2}/data` },
  ];
  assert.deepEqual(findDuplicateMountSources(mounts), []);
});

test('findDuplicateMountSources: empty / non-array / malformed rows → []', () => {
  assert.deepEqual(findDuplicateMountSources([]), []);
  assert.deepEqual(findDuplicateMountSources(null), []);
  assert.deepEqual(findDuplicateMountSources([{ id: ID1 }, { id: ID2, dataPath: '' }]), []);
});
