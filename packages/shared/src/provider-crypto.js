/**
 * Provider credential encryption (施工 MD §11.7/§13.2) — AES-256-GCM.
 *
 * Pure functions (no env access): the key material is a caller-supplied
 * 32-byte Buffer, resolved by each app from PROVIDER_ENCRYPTION_KEY
 * (hex, 64 chars). Format: `v1:<iv b64>:<authTag b64>:<cipher b64>`.
 *
 * GCM gives us tamper detection (auth tag) + confidentiality. We never
 * log ciphertext or keys; decrypt failures are thrown as CryptoError so
 * callers map them to a clean 502/400 (MD §13.3).
 */
import crypto from 'node:crypto';

const ALG = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12;

export class ProviderCryptoError extends Error {
  constructor(message, apiCode = 'PROVIDER_KEY_INVALID') {
    super(message);
    this.name = 'ProviderCryptoError';
    this.apiCode = apiCode;
    this.statusCode = 400;
  }
}

/**
 * Resolve a 32-byte key from env material.
 * Accepts: 64 hex chars → direct; 44 base64 chars → direct; anything else →
 * SHA-256 derivation (so an existing high-entropy secret like the
 * openssl-rand-hex-32 APP_ENCRYPTION_KEY works as-is). Deterministic.
 * @param {string|Buffer|undefined} raw
 */
export function resolveProviderKey(raw) {
  if (raw == null || raw === '') {
    throw new ProviderCryptoError('APP_ENCRYPTION_KEY is not set', 'CONFIG_MISSING');
  }
  const text = String(raw).trim();
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(text)) {
    key = Buffer.from(text, 'hex');
  } else if (/^[A-Za-z0-9+/]{43}=$/.test(text)) {
    key = Buffer.from(text, 'base64');
  } else if (text.length >= 16) {
    key = crypto.createHash('sha256').update(text, 'utf8').digest();
  } else {
    throw new ProviderCryptoError('encryption key material must be at least 16 characters', 'CONFIG_INVALID');
  }
  if (key.length !== 32) {
    throw new ProviderCryptoError('derived encryption key must be 32 bytes', 'CONFIG_INVALID');
  }
  return key;
}

/**
 * Encrypt a secret string.
 * @returns {string} `v1:<iv>:<tag>:<cipher>` (all base64)
 */
export function encryptSecret(plaintext, key) {
  if (typeof plaintext !== 'string') throw new ProviderCryptoError('plaintext must be a string');
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALG, key, iv, { authTagLength: 16 });
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/**
 * Decrypt a token produced by encryptSecret. Throws ProviderCryptoError on
 * any tamper/parse failure (GCM auth-tag check included).
 * @returns {string}
 */
export function decryptSecret(token, key) {
  if (typeof token !== 'string' || token === '') {
    throw new ProviderCryptoError('ciphertext is empty');
  }
  const parts = token.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new ProviderCryptoError('ciphertext has unknown version or shape');
  }
  let iv;
  let tag;
  let enc;
  try {
    iv = Buffer.from(parts[1], 'base64');
    tag = Buffer.from(parts[2], 'base64');
    enc = Buffer.from(parts[3], 'base64');
  } catch {
    throw new ProviderCryptoError('ciphertext is not valid base64');
  }
  if (iv.length !== IV_BYTES || tag.length !== 16) {
    throw new ProviderCryptoError('ciphertext field lengths are invalid');
  }
  const decipher = crypto.createDecipheriv(ALG, key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  try {
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    throw new ProviderCryptoError('ciphertext failed authentication (wrong key or tampered)');
  }
}

/**
 * Mask a secret for display/audit: `sk-…abcd` (keep ≤4 trailing chars).
 */
export function maskSecret(plain) {
  if (typeof plain !== 'string' || plain.length === 0) return '(empty)';
  if (plain.length <= 4) return '****';
  return `…${plain.slice(-4)}`;
}
