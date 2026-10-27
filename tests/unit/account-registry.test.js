/**
 * Account Registry vault (ADR-034) — gitignored JSON store, sealed
 * passwords (APP_ENCRYPTION_KEY / provider-crypto), T5-matrix lifecycle
 * refs, soft retire, export/import portability, and the account-gen CLI.
 * Everything runs against a tmpdir vault — no DB, no containers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  createAccount,
  listAccounts,
  getAccount,
  revealPassword,
  retireAccount,
  setLifecycleState,
  exportVault,
  importVault,
  loadRegistry,
  REGISTRY_VERSION,
} from '../../apps/api/src/services/account-registry-service.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO, 'apps/api/src/cli/account-gen.js');
const KEY = 'registry-test-key-0123456789abcdef'; // deterministic test material

function tmpVault(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gacct-vault-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'registry.json');
}

test('create: vault file lands sealed — zero plaintext passwords on disk, reveal round-trips', (t) => {
  const storePath = tmpVault(t);
  const made = [];
  for (const role of ['anchor', 'ops', 'farm', 'recovery']) {
    const r = createAccount({ role, encryptionKey: KEY, storePath });
    made.push(r);
    assert.deepEqual(r.record.history, [{ state: 'PREPARING', at: r.record.createdAt, note: 'registry:create' }]);
    assert.equal(r.record.lifecycleState, 'PREPARING');
    assert.ok(!('password' in r.record.persona), 'plaintext must not enter the record');
    assert.ok(r.record.passwordCiphertext.startsWith('v1:'), 'AES-256-GCM sealed shape');
  }
  const raw = fs.readFileSync(storePath, 'utf8');
  for (const { persona } of made) {
    assert.ok(!raw.includes(persona.password), 'vault file leaks a plaintext password');
  }
  // distinct ids + distinct emails (vacuous guard)
  assert.equal(new Set(made.map((m) => m.accountId)).size, 4);
  assert.equal(new Set(made.map((m) => m.record.email)).size, 4);
  // reveal round-trip + wrong key refuses
  for (const m of made) {
    assert.equal(revealPassword(m.accountId, { encryptionKey: KEY, storePath }), m.persona.password);
  }
  assert.throws(() => revealPassword(made[0].accountId, { encryptionKey: 'wrong-key-material-123456', storePath }));
  // mode 0600 on the vault file
  if (process.platform !== 'win32') {
    const m = fs.statSync(storePath).mode;
    assert.equal(m & 0o777, 0o600, `raw mode ${m.toString(8)}`);
  }
});

test('create: role allowlist + encryption key required (fail-closed edges)', (t) => {
  const storePath = tmpVault(t);
  assert.throws(() => createAccount({ role: 'farmer', encryptionKey: KEY, storePath }), /role/i);
  assert.throws(() => createAccount({ role: 'ops', encryptionKey: '', storePath }), /APP_ENCRYPTION_KEY/);
  assert.equal(loadRegistry(storePath).accounts.length, 0, 'failed creates wrote nothing');
});

test('uniqueness: registry never accepts a duplicate gmail; saturating imports conflict', (t) => {
  const storePath = tmpVault(t);
  const emails = new Set();
  for (let i = 0; i < 30; i++) {
    const { record } = createAccount({ role: 'farm', encryptionKey: KEY, storePath });
    assert.ok(!emails.has(record.email), `duplicate gmail issued: ${record.email}`);
    emails.add(record.email);
  }
  // an import carrying an already-registered email conflicts (never shadows)
  const doc = exportVault({ storePath });
  const [victim] = doc.accounts.splice(1, 1);
  const clone = structuredClone(victim);
  clone.id = `acct-${victim.id.slice(5).split('').reverse().join('')}`;
  assert.throws(() => importVault({ version: REGISTRY_VERSION, accounts: [clone] }, { storePath }), /email/);
});

test('retire: soft only — DEAD via T5 matrix, history appended, record survives, idempotent', (t) => {
  const storePath = tmpVault(t);
  const { accountId } = createAccount({ role: 'recovery', encryptionKey: KEY, storePath });
  const r1 = retireAccount(accountId, { note: 'ops:decommission', storePath });
  assert.equal(r1.record.lifecycleState, 'DEAD');
  assert.ok(r1.record.retiredAt);
  assert.equal(r1.alreadyRetired, false);
  assert.deepEqual(r1.record.history.at(-1).note, 'ops:decommission');
  const r2 = retireAccount(accountId, { storePath });
  assert.equal(r2.alreadyRetired, true);
  assert.equal(listAccounts({ storePath }).length, 1, 'hard delete must not exist');
  assert.throws(() => retireAccount('acct-XXXXXXXXXX', { storePath }), /not found/);
});

test('setLifecycleState: T5 matrix enforced (no invented edges, DEAD terminal)', (t) => {
  const storePath = tmpVault(t);
  const { accountId } = createAccount({ role: 'ops', encryptionKey: KEY, storePath });
  assert.equal(setLifecycleState(accountId, 'PROVISIONING', { storePath, note: 'driver:go' }).changed, true);
  assert.equal(setLifecycleState(accountId, 'PROVISIONING', { storePath }).changed, false, 'self = no-op');
  assert.throws(() => setLifecycleState(accountId, 'READY', { storePath }), /illegal/);
  assert.throws(() => setLifecycleState(accountId, 'BOGUS', { storePath }), /unknown/);
  retireAccount(accountId, { storePath });
  assert.throws(() => setLifecycleState(accountId, 'PROVISIONING', { storePath }), /illegal/, 'DEAD is terminal');
});

test('export/import: ciphertext portability, idempotent re-import, divergent conflict', (t) => {
  const storePath = tmpVault(t);
  for (const role of ['anchor', 'farm']) createAccount({ role, encryptionKey: KEY, storePath });
  const backup = exportVault({ storePath });
  assert.ok(!JSON.stringify(backup).includes(revealPassword(backup.accounts[0].id, { encryptionKey: KEY, storePath })), 'export leaks plaintext');

  // fresh vault imports cleanly
  const fresh = tmpVault(t);
  const res = importVault(backup, { storePath: fresh });
  assert.equal(res.added, 2);
  assert.deepEqual(loadRegistry(fresh), loadRegistry(storePath));
  // re-import = 0 added (idempotent)
  assert.equal(importVault(backup, { storePath: fresh }).added, 0);
  // divergent duplicate = conflict
  const diverged = structuredClone(backup);
  diverged.accounts[0].role = 'farm';
  assert.throws(() => importVault(diverged, { storePath: fresh }), /conflict/);
  // garbage shapes
  assert.throws(() => importVault({ version: 99, accounts: [] }, { storePath: fresh }), /shape/);
  assert.throws(() => importVault({ version: REGISTRY_VERSION, accounts: [{ id: 'x' }] }, { storePath: fresh }), /malformed/);
});

test('list/get: role filter + masked projections carry no ciphertext either', (t) => {
  const storePath = tmpVault(t);
  createAccount({ role: 'anchor', encryptionKey: KEY, storePath });
  createAccount({ role: 'farm', encryptionKey: KEY, storePath });
  createAccount({ role: 'farm', encryptionKey: KEY, storePath });
  assert.equal(listAccounts({ storePath }).length, 3);
  assert.equal(listAccounts({ role: 'farm', storePath }).length, 2);
  assert.equal(listAccounts({ role: 'anchor', storePath }).length, 1);
  const rows = listAccounts({ storePath });
  assert.ok(rows.every((r) => r.passwordCiphertext && !('password' in r.persona)));
  assert.equal(getAccount(rows[0].id, { storePath }).id, rows[0].id);
  assert.equal(getAccount('acct-NOPE', { storePath }), null);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function cli(args, { storePath, key = KEY, input } = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, APP_ENCRYPTION_KEY: key, ACCOUNT_REGISTRY_PATH: storePath },
    input,
  });
}

test('CLI: create masks by default, --show reveals; list/retire/export/import round-trip', (t) => {
  const storePath = tmpVault(t);
  const out = cli(['create', '--role', 'ops', '--style', 'wordnum'], { storePath });
  assert.match(out, /acct-\S+\s+\[ops\]/);
  assert.match(out, /\*\*\*@gmail\.com/);
  assert.ok(!out.includes('password:'), 'no password without --show');

  const shown = cli(['create', '--role', 'farm', '--show'], { storePath });
  assert.match(shown, /password: \S{18}/);

  const listed = cli(['list'], { storePath });
  assert.match(listed, /# 2 account\(s\)/);
  assert.match(cli(['list', '--role', 'ops'], { storePath }), /# 1 account\(s\) role=ops/);

  const id = out.trim().split(/\s+/)[0];
  assert.match(cli(['retire', id], { storePath }), /retired \(lifecycleState=DEAD\)/);
  assert.match(cli(['retire', id], { storePath }), /already retired/);

  // export -> file -> fresh vault import (portability), plaintext never present
  const backupFile = path.join(path.dirname(storePath), 'backup.json');
  cli(['export', '--out', backupFile], { storePath });
  const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  const pw = shown.match(/password: (\S+)/)[1];
  assert.ok(!JSON.stringify(backup).includes(pw));
  const fresh = tmpVault(t);
  assert.match(cli(['import', backupFile], { storePath: fresh }), /imported: 2 new, 2 total/);

  // help + error exits
  assert.match(cli([], { storePath }), /usage: account-gen/);
  assert.throws(() => cli(['create'], { storePath }), /requires --role/);
  assert.throws(() => cli(['retire', 'acct-XXXXXXXXXX'], { storePath }), /not found/);
});

test('CLI: trinity bindings via --fp/--eg land on the record', (t) => {
  const storePath = tmpVault(t);
  cli(['create', '--role', 'anchor', '--fp', 'fp-profile-0001', '--eg', 'eg-hk-0007'], { storePath });
  const [rec] = listAccounts({ storePath });
  assert.equal(rec.bindings.fingerprintProfileId, 'fp-profile-0001');
  assert.equal(rec.bindings.egressProfileId, 'eg-hk-0007');
  assert.equal(rec.bindings.deferred, false);
});
