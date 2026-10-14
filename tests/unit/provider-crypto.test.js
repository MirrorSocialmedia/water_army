/**
 * Provider credential crypto (施工 MD §11.7/§13.2) — AES-256-GCM round-trip,
 * tamper detection, key validation, display masking.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  ProviderCryptoError,
  resolveProviderKey,
  encryptSecret,
  decryptSecret,
  maskSecret,
} from '../../packages/shared/src/provider-crypto.js';

const KEY = crypto.randomBytes(32);
const KEY_HEX = KEY.toString('hex');

test('resolveProviderKey: accepts 64-hex and 44-base64; rejects everything else', () => {
  assert.equal(resolveProviderKey(KEY_HEX).toString('hex'), KEY_HEX);
  assert.equal(resolveProviderKey(KEY.toString('base64')).toString('hex'), KEY_HEX);
  assert.throws(() => resolveProviderKey(''), (e) => e instanceof ProviderCryptoError && e.apiCode === 'CONFIG_MISSING');
  assert.throws(() => resolveProviderKey(undefined), (e) => e.apiCode === 'CONFIG_MISSING');
  assert.throws(() => resolveProviderKey('tooshort'), (e) => e.apiCode === 'CONFIG_INVALID');
  assert.throws(() => resolveProviderKey('z'.repeat(64)), (e) => e.apiCode === 'CONFIG_INVALID', 'non-hex 64 chars rejected');
});

test('encrypt/decrypt round-trip (incl. unicode + empty string)', () => {
  for (const plain of ['sk-abc123', '密钥 test 123', '', 'short']) {
    const tok = encryptSecret(plain, KEY);
    assert.ok(tok.startsWith('v1:'), 'versioned format');
    assert.equal(tok.split(':').length, 4);
    assert.equal(decryptSecret(tok, KEY), plain);
  }
});

test('two encryptions of the same plaintext differ (random IV) but both decrypt', () => {
  const a = encryptSecret('same', KEY);
  const b = encryptSecret('same', KEY);
  assert.notEqual(a, b);
  assert.equal(decryptSecret(b, KEY), 'same');
});

test('tamper detection: flipped ciphertext byte / wrong tag → ProviderCryptoError', () => {
  const tok = encryptSecret('topsecret', KEY);
  const parts = tok.split(':');
  const badCipher = Buffer.from(parts[3], 'base64');
  badCipher[0] ^= 0xff;
  assert.throws(
    () => decryptSecret(`${parts[0]}:${parts[1]}:${parts[2]}:${badCipher.toString('base64')}`, KEY),
    (e) => e instanceof ProviderCryptoError,
  );
  const badTag = Buffer.from(parts[2], 'base64');
  badTag[0] ^= 0x01;
  assert.throws(
    () => decryptSecret(`${parts[0]}:${parts[1]}:${badTag.toString('base64')}:${parts[3]}`, KEY),
    (e) => e instanceof ProviderCryptoError,
  );
});

test('wrong key fails authentication (does not throw generic Error)', () => {
  const tok = encryptSecret('hello', KEY);
  const other = crypto.randomBytes(32);
  assert.throws(() => decryptSecret(tok, other), (e) => e instanceof ProviderCryptoError);
});

test('malformed tokens: unknown version / bad shape / non-base64 all rejected', () => {
  assert.throws(() => decryptSecret('v2:aa:bb:cc', KEY), (e) => e instanceof ProviderCryptoError);
  assert.throws(() => decryptSecret('not-a-token', KEY), (e) => e instanceof ProviderCryptoError);
  assert.throws(() => decryptSecret('v1:!!!:###:$$$', KEY), (e) => e instanceof ProviderCryptoError);
  assert.throws(() => decryptSecret('', KEY), (e) => e instanceof ProviderCryptoError);
  assert.throws(() => decryptSecret(null, KEY), (e) => e instanceof ProviderCryptoError);
});

test('maskSecret: keeps ≤4 trailing chars, never full secret', () => {
  assert.equal(maskSecret('sk-abcdef123456789'), '…6789');
  assert.equal(maskSecret('ab'), '****');
  assert.equal(maskSecret(''), '(empty)');
  assert.ok(!maskSecret('sk-abcdef123456789').includes('abcdef'));
});
