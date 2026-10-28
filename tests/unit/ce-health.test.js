/**
 * GAcct 段4 CE-health unit (kx71 forensics hardening).
 * Hermetic: zero adb, zero devices — parse/verify over captured buffers.
 * The broken fixture replicates the real forensic fingerprint measured on
 * rdev-f1 2026-10-28: half-created schema (accounts/authtokens/extras only),
 * 0-byte accounts_ce.db-journal, `Accounts: 0`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CE_DB_PATH, CE_DB_DIR, CE_REQUIRED_TABLES,
  parseCeHealth, runCeHealthProbe, verifyCePersistence, formatCeHealthRemediation,
} from '../../packages/shared/src/ce-health.js';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

/** Fake db page-1 + sqlite_master text area with the given table names. */
function fakeCeDb(tables) {
  const out = Buffer.alloc(4096, 0);
  SQLITE_MAGIC.copy(out, 0);
  Buffer.from(`c${tables.join('\0')}`, 'latin1').copy(out, 100);
  return out;
}
const HEALTHY_DB = fakeCeDb(CE_REQUIRED_TABLES);
const BROKEN_DB = fakeCeDb(['accounts', 'authtokens', 'extras']); // f1 fingerprint

test('healthy CE db: ok, account count parsed', () => {
  const r = parseCeHealth({
    lsOut: 'accounts_ce.db\nappsearch\nbackup\n',
    dbBytes: HEALTHY_DB,
    dumpsysOut: 'User UserInfo{0:Owner:c13n}:\n  Accounts: 1\n',
  });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.accounts, 1);
});

test('kx71 forensic fingerprint: half schema + stale journal + Accounts 0', () => {
  const r = parseCeHealth({
    lsOut: 'accounts_ce.db\naccounts_ce.db-journal\nappsearch\n',
    dbBytes: BROKEN_DB,
    dumpsysOut: '  Accounts: 0\n',
  });
  assert.equal(r.ok, false);
  const joined = r.problems.join('\n');
  assert.match(joined, /stale journal\/wal.*accounts_ce\.db-journal/s);
  for (const t of ['grants', 'history', 'ringtones']) {
    assert.match(joined, new RegExp(`missing table "${t}"`));
  }
  assert.equal(r.accounts, 0);
});

test('missing journal file alone with healthy schema = ok (count is not parseCeHealth\'s job)', () => {
  const r = parseCeHealth({
    lsOut: 'accounts_ce.db\n',
    dbBytes: HEALTHY_DB,
    dumpsysOut: '  Accounts: 0\n',
  });
  assert.equal(r.ok, true);
  assert.equal(r.accounts, 0);
});

test('truncated / non-sqlite bytes fail loudly', () => {
  const r = parseCeHealth({ dbBytes: Buffer.from('not a db at all, padded'.repeat(200)) });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /not a SQLite database/);
});

test('wal/shm strays are flagged too', () => {
  const r = parseCeHealth({
    lsOut: 'accounts_ce.db\naccounts_ce.db-wal\naccounts_ce.db-shm\n',
    dbBytes: HEALTHY_DB,
  });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /accounts_ce\.db-wal/);
});

test('runCeHealthProbe orchestrates injected adb primitives', async () => {
  const calls = [];
  const io = {
    runShell: async (cmd) => {
      calls.push(cmd);
      if (cmd.startsWith('ls ')) return `accounts_ce.db\n${'x'.repeat(10)}\n`;
      if (cmd === 'dumpsys account') return '  Accounts: 1\n';
      throw new Error(`unexpected shell cmd ${cmd}`);
    },
    readBinary: async (cmd) => { calls.push(cmd); return HEALTHY_DB; },
  };
  const r = await runCeHealthProbe(io);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.ok(calls.includes(`ls ${CE_DB_DIR}`));
  assert.ok(calls.includes(`cat ${CE_DB_PATH}`));
});

test('runCeHealthProbe: unreadable db surfaces as a problem (fail closed)', async () => {
  const r = await runCeHealthProbe({
    runShell: async (cmd) => (cmd.startsWith('ls') ? 'accounts_ce.db\n' : '  Accounts: 1\n'),
    readBinary: async () => { throw new Error('cat: No such file'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /unreadable/);
});

test('verifyCePersistence PASS: 1 account survives restart', async () => {
  const states = [1, 1];
  let n = 0;
  const r = await verifyCePersistence({
    probe: async () => ({ ok: true, accounts: states[n++], problems: [] }),
    restart: async () => {},
  });
  assert.equal(r.ok, true);
  assert.deepEqual([r.before, r.after], [1, 1]);
});

test('verifyCePersistence FAIL: RAM-only login evaporates after restart (kx71 case)', async () => {
  const states = [1, 0];
  let n = 0;
  let restarted = false;
  const r = await verifyCePersistence({
    probe: async () => ({ ok: true, accounts: states[n++], problems: [] }),
    restart: async () => { restarted = true; },
  });
  assert.equal(r.ok, false);
  assert.ok(restarted);
  assert.match(r.problems.join('\n'), /post-restart account count 0 != 1/);
});

test('verifyCePersistence FAIL: pre-restart count already wrong skips nothing, still restarts', async () => {
  let n = 0;
  const r = await verifyCePersistence({
    probe: async () => ({ ok: true, accounts: n++ === 0 ? 0 : 0, problems: [] }),
    restart: async () => {},
  });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /pre-restart account count 0 != 1/);
});

test('remediation guidance mentions graceful stop + docker-run cleanup', () => {
  const t = formatCeHealthRemediation({ serial: '127.0.0.1:16512', container: 'rdev-f1' });
  assert.match(t, /docker stop/);
  assert.match(t, /NEVER docker rm -f/);
  assert.match(t, /debian:bookworm-slim/);
  assert.match(t, /rdev-f1/);
});
