/**
 * Account Registry (ADR-034) — the credential vault for generated accounts.
 *
 * Storage: a gitignored JSON file (default `.dev/accounts/registry.json`),
 * atomic tmp+rename writes. This is the ACCOUNT ASSET ledger (boss-side
 * backup source of truth); the per-run state machine rows stay in Postgres
 * (T5 AccountLifecycle). Passwords are AES-256-GCM sealed with the SAME
 * APP_ENCRYPTION_KEY discipline as provider secrets (provider-crypto) —
 * plaintext exists only transiently in memory, never in this file, the
 * repo, or logs.
 *
 * Rules encoded here:
 *  - gmail address uniqueness across the whole fleet (Google-side truth);
 *    a collision regenerates under a fresh accountId, never overwrites;
 *  - soft retire only: lifecycle ref moves per the T5 matrix (DEATH is
 *    always legal), records are never hard-deleted;
 *  - export carries ciphertext; import refuses divergent duplicate ids.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  ACCOUNT_ROLES,
  generatePersona,
  validatePersona,
  personaForStorage,
  mintAccountId,
} from '@water-army/shared';
import { isLegalAccountTransition, ACCOUNT_STATES } from '@water-army/shared';
import { encryptSecret, decryptSecret, resolveProviderKey } from '@water-army/shared';

export const REGISTRY_VERSION = 1;
const MAX_CREATE_ATTEMPTS = 25;

/** Default vault path: repo `.dev/` (gitignored), overridable for tests/ops. */
export function defaultRegistryPath() {
  return process.env.ACCOUNT_REGISTRY_PATH
    || path.resolve(process.cwd(), '.dev/accounts/registry.json');
}

function fail(message, code = 'REGISTRY_INVALID') {
  const err = new Error(message);
  err.code = code;
  throw err;
}

export function loadRegistry(storePath) {
  const file = storePath || defaultRegistryPath();
  if (!fs.existsSync(file)) return { version: REGISTRY_VERSION, accounts: [] };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`registry file unreadable (${file}): ${e.message}`, 'REGISTRY_UNREADABLE');
  }
  if (doc?.version !== REGISTRY_VERSION || !Array.isArray(doc.accounts)) {
    fail(`registry file has unknown shape (${file})`, 'REGISTRY_UNREADABLE');
  }
  return doc;
}

export function saveRegistry(doc, storePath) {
  const file = storePath || defaultRegistryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.chmodSync(tmp, 0o600); // sealed vault: owner-only, regardless of umask
  fs.renameSync(tmp, file); // atomic replace
}

function emailTaken(doc, email) {
  return doc.accounts.some((r) => r.email === email);
}

/**
 * Create + persist one account. Returns { accountId, record, persona } —
 * `persona.password` (plaintext) is transient; `record` is what lands in
 * the vault (password as ciphertext only).
 */
export function createAccount({
  role,
  region,
  style,
  bindings,
  encryptionKey,
  storePath,
  now = () => new Date().toISOString(),
} = {}) {
  if (!ACCOUNT_ROLES.includes(role)) fail(`unknown role: ${role}`, 'ROLE_INVALID');
  const key = resolveProviderKey(encryptionKey ?? process.env.APP_ENCRYPTION_KEY);
  const doc = loadRegistry(storePath);

  let persona = null;
  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
    const candidate = generatePersona(mintAccountId(), { role, region, style, bindings });
    if (!emailTaken(doc, `${candidate.gmail.prefix}@gmail.com`)) {
      persona = candidate;
      break;
    }
  }
  if (!persona) fail(`gmail prefix space saturated after ${MAX_CREATE_ATTEMPTS} attempts`, 'PREFIX_SATURATED');

  const problems = validatePersona(persona);
  if (problems.length) fail(`persona invalid: ${problems.join('; ')}`);

  const ts = now();
  const record = {
    id: persona.accountId,
    role: persona.role,
    lifecycleState: 'PREPARING', // T5 machine ref; transitions go through retire()/driver
    email: `${persona.gmail.prefix}@gmail.com`,
    bindings: persona.bindings,
    persona: personaForStorage(persona),
    passwordCiphertext: encryptSecret(persona.password, key),
    passwordPolicyId: persona.passwordMeta.policyId,
    passwordEntropyBits: persona.passwordMeta.entropyBits,
    createdAt: ts,
    updatedAt: ts,
    retiredAt: null,
    history: [{ state: 'PREPARING', at: ts, note: 'registry:create' }],
  };
  doc.accounts.push(record);
  saveRegistry(doc, storePath);
  return { accountId: record.id, record, persona };
}

export function listAccounts({ role, storePath } = {}) {
  const doc = loadRegistry(storePath);
  const rows = role ? doc.accounts.filter((r) => r.role === role) : doc.accounts;
  return rows.map((r) => ({ ...r, persona: { ...r.persona }, history: [...r.history] }));
}

export function getAccount(id, { storePath } = {}) {
  const doc = loadRegistry(storePath);
  return doc.accounts.find((r) => r.id === id) || null;
}

/** Plaintext password ONLY for interactive use (`--show`); never logged. */
export function revealPassword(record, { encryptionKey, storePath } = {}) {
  const rec = typeof record === 'string' ? getAccount(record, { storePath }) : record;
  if (!rec) fail('account not found', 'ACCOUNT_NOT_FOUND');
  const key = resolveProviderKey(encryptionKey ?? process.env.APP_ENCRYPTION_KEY);
  return decryptSecret(rec.passwordCiphertext, key);
}

/**
 * Soft retire = move the T5 lifecycle ref to DEAD (always legal) and stamp
 * retiredAt. Hard delete does not exist here — the ledger keeps every asset.
 */
export function retireAccount(id, { note = 'registry:retire', storePath, now = () => new Date().toISOString() } = {}) {
  const file = storePath || defaultRegistryPath();
  const doc = loadRegistry(file);
  const rec = doc.accounts.find((r) => r.id === id);
  if (!rec) fail('account not found', 'ACCOUNT_NOT_FOUND');
  if (rec.lifecycleState === 'DEAD') return { record: rec, alreadyRetired: true };
  if (!isLegalAccountTransition(rec.lifecycleState, 'DEAD')) {
    fail(`illegal transition ${rec.lifecycleState} -> DEAD`, 'TRANSITION_ILLEGAL');
  }
  const ts = now();
  rec.lifecycleState = 'DEAD';
  rec.retiredAt = ts;
  rec.updatedAt = ts;
  rec.history.push({ state: 'DEAD', at: ts, note });
  saveRegistry(doc, file);
  return { record: rec, alreadyRetired: false };
}

/** Driver/state-machine hook: advance the lifecycle ref along T5 edges. */
export function setLifecycleState(id, to, { note = '', storePath, now = () => new Date().toISOString() } = {}) {
  if (!ACCOUNT_STATES.includes(to)) fail(`unknown lifecycle state: ${to}`, 'STATE_INVALID');
  const doc = loadRegistry(storePath);
  const rec = doc.accounts.find((r) => r.id === id);
  if (!rec) fail('account not found', 'ACCOUNT_NOT_FOUND');
  if (rec.lifecycleState === to) return { record: rec, changed: false };
  if (!isLegalAccountTransition(rec.lifecycleState, to)) {
    fail(`illegal transition ${rec.lifecycleState} -> ${to}`, 'TRANSITION_ILLEGAL');
  }
  const ts = now();
  rec.lifecycleState = to;
  rec.updatedAt = ts;
  rec.history.push({ state: to, at: ts, note });
  if (to === 'DEAD') rec.retiredAt = ts;
  saveRegistry(doc, storePath);
  return { record: rec, changed: true };
}

/** Vault export = full portability, ciphertext-only (safe to hand to ops). */
export function exportVault({ storePath } = {}) {
  const doc = loadRegistry(storePath);
  return JSON.parse(JSON.stringify(doc));
}

/**
 * Import merges a backup into the live vault. A duplicate id is accepted
 * only when the record is byte-identical (idempotent re-import); a
 * divergent duplicate is a hard conflict.
 */
export function importVault(doc, { storePath } = {}) {
  if (doc?.version !== REGISTRY_VERSION || !Array.isArray(doc.accounts)) {
    fail('import document has unknown shape/version', 'IMPORT_SHAPE');
  }
  const live = loadRegistry(storePath);
  let added = 0;
  for (const rec of doc.accounts) {
    if (!rec?.id || !Array.isArray(rec?.history) || !rec.passwordCiphertext) {
      fail(`import record malformed: ${rec?.id ?? '?'}`, 'IMPORT_SHAPE');
    }
    if (!ACCOUNT_ROLES.includes(rec.role)) fail(`import record bad role: ${rec.id}`, 'IMPORT_SHAPE');
    const existing = live.accounts.find((r) => r.id === rec.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(rec)) {
        fail(`import conflict: ${rec.id} exists with different content`, 'IMPORT_CONFLICT');
      }
      continue;
    }
    if (emailTaken(live, rec.email)) fail(`import conflict: email ${rec.email} already registered`, 'IMPORT_CONFLICT');
    live.accounts.push(rec);
    added++;
  }
  saveRegistry(live, storePath);
  return { added, total: live.accounts.length };
}
