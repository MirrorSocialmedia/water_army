/**
 * CE (credential-encrypted) storage health for the account creation flow
 * (GAcct 段4 hardening, CEO 2026-10-28 forensics case kx71).
 *
 * Failure mode proven by forensics (logs/waterarmy-account-forensics-progress.md):
 * if the FIRST boot of a fresh redroid datadir is SIGKILLed mid-transaction
 * inside /data/system_ce/0/accounts_ce.db, the db is left half-created
 * (schema missing grants/history/ringtones) with a 0-byte `-journal`
 * orphan; every later AccountManagerService write silently fails, so a
 * successful-looking login lives ONLY in that boot's RAM and evaporates on
 * the next restart. `dumpsys account` cannot see this (it shows the RAM
 * state), so we probe the DISK directly.
 *
 * Design constraints:
 *  - NEVER rely on the in-container sqlite3 CLI: on MTG images it SEGVs on
 *    every database (2026-10-28 measured). We read the raw file bytes and
 *    scan for the sqlite_master table rows (plain text in leaf pages).
 *  - Pure parsing here; I/O is injected (adb shell / exec-out cat).
 */

export const CE_DB_PATH = '/data/system_ce/0/accounts_ce.db';
export const CE_DB_DIR = '/data/system_ce/0';

/** Table set AccountManagerService creates in accounts_ce.db on A14. */
export const CE_REQUIRED_TABLES = Object.freeze([
  'accounts', 'authtokens', 'extras', 'grants', 'history', 'ringtones',
]);

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

/**
 * Parse the three raw probe outputs into a verdict. Pure.
 * @param {object} raw
 * @param {string|null} [raw.lsOut]      `adb shell ls <CE_DB_DIR>` stdout
 * @param {Buffer|null} [raw.dbBytes]    raw accounts_ce.db content
 * @param {string|null} [raw.dumpsysOut] `adb shell dumpsys account` stdout
 * @returns {{ok: boolean, problems: string[], accounts: number|null}}
 */
export function parseCeHealth({ lsOut = null, dbBytes = null, dumpsysOut = null } = {}) {
  const problems = [];
  let accounts = null;

  if (lsOut) {
    const journals = lsOut.split(/\r?\n/).map((l) => l.trim())
      .filter((l) => l.endsWith('.db-journal') || l.endsWith('.db-wal') || l.endsWith('.db-shm'));
    if (journals.length) {
      problems.push(`stale journal/wal in ${CE_DB_DIR}: ${journals.join(', ')} (SIGKILL mid-transaction fingerprint)`);
    }
  }

  if (dbBytes) {
    if (dbBytes.length < 4096 || !dbBytes.subarray(0, 15).equals(SQLITE_MAGIC.subarray(0, 15))) {
      problems.push('accounts_ce.db is not a SQLite database (header mismatch or truncated)');
    } else {
      for (const table of CE_REQUIRED_TABLES) {
        if (!dbBytes.includes(Buffer.from(table, 'latin1'))) {
          problems.push(`accounts_ce.db schema missing table "${table}" (half-created db — onCreate was interrupted)`);
        }
      }
    }
  }

  if (dumpsysOut) {
    const m = dumpsysOut.match(/Accounts:\s*(\d+)/);
    if (m) accounts = Number(m[1]);
    else problems.push('dumpsys account output has no "Accounts:" line (unreadable)');
  }

  return { ok: problems.length === 0, problems, accounts };
}

/**
 * Run the three on-device reads through injected I/O primitives.
 * @param {object} io
 * @param {(cmd: string) => Promise<string>} io.runShell    adb shell one-shot
 * @param {(cmd: string) => Promise<Buffer>} [io.readBinary] adb exec-out one-shot (raw bytes)
 * @returns {Promise<ReturnType<typeof parseCeHealth> & {raw: object}>}
 */
export async function runCeHealthProbe({ runShell, readBinary }) {
  let lsOut = null; let dbBytes = null; let dumpsysOut = null;
  try { lsOut = String(await runShell(`ls ${CE_DB_DIR}`)); } catch { /* missing surfaces as a problem below */ }
  if (readBinary) {
    try { dbBytes = await readBinary(`cat ${CE_DB_PATH}`); } catch { dbBytes = null; }
  }
  try { dumpsysOut = String(await runShell('dumpsys account')); } catch { /* unreadable -> problem */ }
  const parsed = parseCeHealth({ lsOut, dbBytes, dumpsysOut });
  if (readBinary && !dbBytes) parsed.problems.unshift('accounts_ce.db unreadable via exec-out cat');
  if (!lsOut) parsed.problems.unshift(`${CE_DB_DIR} not listable via adb shell`);
  if (parsed.ok && readBinary && parsed.accounts === null) parsed.problems.push('no account count available');
  return { ...parsed, ok: parsed.problems.length === 0, raw: { lsOut, dbBytes, dumpsysOut } };
}

/**
 * Persistence verification: after a successful login (RAM state = 1 account),
 * restart the container and demand the SAME account count from a cold boot.
 * @param {object} opts
 * @param {() => Promise<{ok:boolean, accounts:number|null, problems:string[]}>} opts.probe
 * @param {() => Promise<void>} opts.restart                 e.g. docker stop+start+boot wait
 * @param {number} [opts.expectAccounts]                     expected count after restart (default 1)
 * @returns {Promise<{ok: boolean, before: number|null, after: number|null, problems: string[]}>}
 */
export async function verifyCePersistence({ probe, restart, expectAccounts = 1 }) {
  const before = await probe();
  const problems = [...before.problems];
  if (before.accounts !== expectAccounts) {
    problems.push(`pre-restart account count ${before.accounts} != ${expectAccounts}`);
  }
  await restart();
  const after = await probe();
  problems.push(...after.problems);
  if (after.accounts !== expectAccounts) {
    problems.push(`post-restart account count ${after.accounts} != ${expectAccounts} (login state did NOT survive restart — CE write dead)`);
  }
  return { ok: problems.length === 0, before: before.accounts, after: after.accounts, problems };
}

/**
 * Loud operator guidance for a failed probe (datadir teardown + recreate).
 * Never deletes anything itself — the caller (human or CI gate) does.
 */
export function formatCeHealthRemediation({ serial, container = null } = {}) {
  const lines = [
    'CE HEALTH FAILED — accounts_ce.db is unusable; any login made on this',
    'datadir is RAM-only and WILL evaporate on the next restart.',
    'Remediation (in order, NEVER docker rm -f on a running device):',
    '  1. docker stop <container>          # graceful only',
    '  2. Clean the datadir through docker (files are root-owned):',
    '     docker run --rm -v <dataDir>:/x --entrypoint rm debian:bookworm-slim -rf /x',
    '  3. Recreate the device through the product route (fresh datadir).',
    '  4. Re-run registration + login, then re-run this health probe.',
    'Reference: logs/waterarmy-account-forensics-progress.md (case kx71).',
  ];
  if (serial) lines.push(`(serial=${serial})`);
  if (container) lines.push(`(container=${container})`);
  return lines.join('\n');
}
