/**
 * GAcct 段4 CE-health integration — the restart step (docker stop/start in
 * production) is exercised end-to-end against a FAKE adb: a real child
 * process speaking the adb CLI shape, with the account count driven by a
 * state file the fake "restart" flips. Two scenarios:
 *   1. kx71 regression: RAM shows 1, cold boot shows 0 → FAIL + remediation.
 *   2. healthy datadir: 1 survives the fake restart → PASS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

import {
  CE_DB_PATH, CE_DB_DIR, CE_REQUIRED_TABLES,
  runCeHealthProbe, verifyCePersistence,
} from '../../packages/shared/src/ce-health.js';

const FAKE_ADB = `#!/usr/bin/env bash
# args: -s <serial> shell|exec-out sh -c "<cmd>"
state="\${FAKE_ADB_STATE}"
case "$4" in
  ls\\ ${CE_DB_DIR}*)
    if [ "$(cat \${state}/journal)" = 1 ]; then echo accounts_ce.db-journal; fi
    echo accounts_ce.db ;;
  cat\\ ${CE_DB_PATH}*)
    cat "\${FAKE_ADB_DB}" ;;
  dumpsys\\ account*)
    echo "  Accounts: $(cat \${state}/count)" ;;
  getprop\\ sys.boot_completed*) echo 1 ;;
  *) echo "fake-adb: unhandled: $*" >&2; exit 9 ;;
esac
`;

function fakeCeDb() {
  const out = Buffer.alloc(4096, 0);
  Buffer.from('SQLite format 3\0', 'latin1').copy(out, 0);
  Buffer.from(`c${CE_REQUIRED_TABLES.join('\0')}`, 'latin1').copy(out, 100);
  return out;
}

async function setup({ journal, counts }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-e2e-'));
  const adb = path.join(dir, 'adb');
  fs.writeFileSync(adb, FAKE_ADB, { mode: 0o755 });
  const state = path.join(dir, 'state');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'count'), String(counts[0]));
  fs.writeFileSync(path.join(state, 'journal'), journal ? '1' : '0');
  const dbFile = path.join(dir, 'ce.db');
  fs.writeFileSync(dbFile, fakeCeDb());
  fs.writeFileSync(path.join(dir, 'counts.txt'), counts.join('\n'));

  const env = { ...process.env, FAKE_ADB_STATE: state, FAKE_ADB_DB: dbFile };
  const io = {
    runShell: async (cmd) => { const { stdout } = await execFileAsync(adb, ['-s', 'fake:5555', 'shell', cmd], { env }); return stdout; },
    readBinary: async (cmd) => { const { stdout } = await execFileAsync(adb, ['-s', 'fake:5555', 'exec-out', cmd], { env, encoding: 'buffer', maxBuffer: 1 << 24 }); return stdout; },
  };
  let idx = 0;
  const restart = async () => {
    idx += 1;
    fs.writeFileSync(path.join(state, 'count'), String(counts[idx] ?? counts[counts.length - 1]));
  };
  return { io, restart, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('E2E kx71 regression: login visible pre-restart, gone after fake cold boot → FAIL', async () => {
  const { io, restart, cleanup } = await setup({ journal: false, counts: [1, 0] });
  try {
    const r = await verifyCePersistence({ probe: () => runCeHealthProbe(io), restart });
    assert.equal(r.ok, false);
    assert.equal(r.before, 1);
    assert.equal(r.after, 0);
    assert.match(r.problems.join('\n'), /did NOT survive restart/);
  } finally { cleanup(); }
});

test('E2E healthy: account survives fake cold boot → PASS', async () => {
  const { io, restart, cleanup } = await setup({ journal: false, counts: [1, 1] });
  try {
    const r = await verifyCePersistence({ probe: () => runCeHealthProbe(io), restart });
    assert.equal(r.ok, true, JSON.stringify(r.problems));
    assert.equal(r.after, 1);
  } finally { cleanup(); }
});

test('E2E forensic fingerprint via fake-adb: stale journal → probe FAIL before restart', async () => {
  const { io, restart, cleanup } = await setup({ journal: true, counts: [1, 1] });
  try {
    const h = await runCeHealthProbe(io);
    assert.equal(h.ok, false);
    assert.match(h.problems.join('\n'), /accounts_ce\.db-journal/);
    const r = await verifyCePersistence({ probe: () => runCeHealthProbe(io), restart });
    // count survives but the disk fingerprint still fails the probe
    assert.equal(r.ok, false);
  } finally { cleanup(); }
});
