#!/usr/bin/env node
/**
 * account-gen — Account Generator CLI (ADR-034).
 *
 *   account-gen create --role <anchor|ops|farm|recovery> [--style <s>] [--region <r>]
 *                      [--fp <fingerprintProfileId> --eg <egressProfileId>] [--show]
 *   account-gen list   [--role <r>]
 *   account-gen show   <accountId> [--show]
 *   account-gen retire <accountId> [--note <text>]
 *   account-gen signup <accountId> --serial <adb-serial> [--dry-run]
 *                      [--resume-from <step>] [--evidence-dir <dir>]
 *   account-gen export [--out <file>]
 *   account-gen import <file>
 *
 * Secrets discipline: the password is printed ONLY with --show (and only to
 * stdout — redirect at your own risk); everything else is a masked summary
 * plus a vault pointer. APP_ENCRYPTION_KEY (or --key-env) is required for
 * create/show/export-decrypt paths, exactly like provider secrets.
 * Vault file: $ACCOUNT_REGISTRY_PATH or .dev/accounts/registry.json (gitignored).
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

import { maskEmail } from '@water-army/shared';
import { CREATE_ACCOUNT_STEPS, createSignupDriver, deriveSignupValues, planRegistrationSchedule, SIGNUP_COORD_BASE } from '@water-army/shared';
import {
  createAccount,
  listAccounts,
  getAccount,
  revealPassword,
  retireAccount,
  exportVault,
  importVault,
  setLifecycleState,
  defaultRegistryPath,
} from '../services/account-registry-service.js';

const HELP = `usage: account-gen <command> [options]

commands:
  create --role <anchor|ops|farm|recovery> [--style softname|wordnum|nature|any]
         [--region hk|cn|tw|us|gb|jp|kr|de] [--fp <id> --eg <id>] [--show]
  list [--role <r>]          registered accounts (masked, no secrets)
  show <accountId> [--show]  one account (--show decrypts the password)
  retire <accountId> [--note <text>]   soft retire (T5 -> DEAD, never hard-delete)
  signup <accountId> --serial <adb-serial> [--dry-run] [--resume-from <step>]
                     [--evidence-dir <dir>]  drive the MinuteMaid create-account
                     step table (ADR-034 §7); writes lifecycle back to vault.
                     --show prints typed values (password!) — masked otherwise.
  schedule --count <n> [--window 24h] [--seed <s>] [--start <ISO>]
                     [--min-gap <min>] [--allow-night]
                     randomised registration plan (seeded, deterministic;
                     avoids local 00:00-07:00 unless --allow-night)
  export [--out <file>]      vault JSON (ciphertext only) to stdout/file
  import <file>              merge a backup (idempotent; conflicts hard-fail)
`;

function parseArgs(argv) {
  const [command = '', ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--show') flags.show = true;
    else if (a === '--dry-run') flags['dry-run'] = true;
    else if (a === '--allow-night') flags['allow-night'] = true;
    else if (a.startsWith('--')) flags[a.slice(2)] = rest[++i];
    else positional.push(a);
  }
  return { command, flags, positional };
}

function summarizeLine(r) {
  const p = r.persona;
  return `${r.id}  [${r.role}]  ${maskEmail(r.email)}  region=${p.region}  ${p.name.givenName} ${p.name.familyName}`
    + `  ${r.lifecycleState}  pw<${r.passwordEntropyBits} bits>  vault:${defaultRegistryPath()}#${r.id}`;
}

/**
 * account-gen signup — drive the create-account step table for a vaulted
 * account. --dry-run prints the resolved adb plan (password masked unless
 * --show); live mode runs adb via spawnFile (argv arrays, no shell), keeps
 * per-step screencap evidence, and mirrors lifecycle transitions into the
 * vault (registry is the ledger; the driver never touches it directly).
 */
async function signupCommand({ flags, positional }) {
  const id = positional[0];
  if (!id) throw new Error('signup requires <accountId>');
  const rec = getAccount(id, { storePath: flags.path });
  if (!rec) throw new Error(`account not found: ${id}`);
  const isDry = Boolean(flags['dry-run']);
  // live mode decrypts the vault password for typing regardless of --show
  // (masking is a DISPLAY concern only); dry-run keeps the '<vault>' stub.
  const livePassword = !isDry && rec.persona.hasPassword
    ? revealPassword(rec, { storePath: flags.path }) : '<vault>';
  const persona = { ...rec.persona, password: livePassword };
  const values = deriveSignupValues({ ...persona, birthday: rec.persona.birthday });
  const serial = flags.serial;
  if (!serial && !flags['dry-run']) throw new Error('signup requires --serial <adb-serial> (or --dry-run)');
  const evidDir = flags['evidence-dir'] || path.resolve(process.cwd(), `.dev/signup-evidence/${id}-${new Date().toISOString().replace(/[:.]/g, '')}`);

  const plan = CREATE_ACCOUNT_STEPS.map((s) => {
    const a = s.action;
    const at = `[${a.at.join(',')}]`;
    const kind = a.kind === 'type' ? `type(${(s.fields ?? []).join('+')})` : a.kind;
    return `${s.id.padEnd(22)} ${kind.padEnd(28)} @${at}${s.hardDiscipline ? `  HARD:${s.hardDiscipline}` : ''}${s.retries ? `  retries:${s.retries}` : ''}`;
  });

  if (flags['dry-run']) {
    process.stdout.write(`# signup plan for ${id} (${rec.email}) — coords @${SIGNUP_COORD_BASE.w}x${SIGNUP_COORD_BASE.h} baseline, stepsVersion plan-length ${plan.length}\n`);
    for (const line of plan) process.stdout.write(`# ${line}\n`);
    process.stdout.write(`# values: username=${values.username} name=${values.givenName} ${values.familyName} birthday=${rec.persona.birthday} password=${flags.show ? '<shown:typed-at-runtime>' : '<vault>'}\n`);
    process.stdout.write(`# evidence dir: ${evidDir}\n`);
    if (flags['resume-from']) process.stdout.write(`# resume-after step: ${flags['resume-from']}\n`);
    return 0;
  }

  const adbBin = process.env.ADB_BIN || `${process.env.HOME}/.local/share/platform-tools/adb`;
  fs.mkdirSync(evidDir, { recursive: true });
  const adbRun = async (kindArgs, { binary = false } = {}) => {
    const { stdout } = await execFileAsync(adbBin, ['-s', serial, ...kindArgs], { encoding: binary ? 'buffer' : 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  };
  // screen size probe (fallback = coordinate baseline)
  let screen = SIGNUP_COORD_BASE;
  try {
    const sz = String(await adbRun(['shell', 'wm', 'size'])).match(/(\d+)x(\d+)/g);
    if (sz) { const [w, h] = sz[sz.length - 1].split('x').map(Number); screen = { w, h }; }
  } catch { /* baseline stands */ }

  const driver = createSignupDriver({
    runAdb: (args) => adbRun(['shell', ...args]),
    screencap: async () => Buffer.from(await adbRun(['exec-out', 'screencap', '-p'], { binary: true })),
    screen,
    writeEvidence: async (name, buf) => { fs.writeFileSync(path.join(evidDir, name), buf); },
    handoff: async (record) => {
      const f = path.join(evidDir, 'handoff-blocked_pending_review.json');
      fs.writeFileSync(f, `${JSON.stringify(record, null, 2)}\n`);
      process.stdout.write(`# BLOCKED_PENDING_REVIEW handoff: ${f}\n`);
      return f;
    },
  });

  const input = { persona, credentials: { email: rec.email, password: persona.password }, refs: { serial } };
  let last = rec.lifecycleState;
  let exit = 0;
  for await (const ev of driver.drive(input, { resumeFromStep: flags['resume-from'] ?? null })) {
    process.stdout.write(`[signup] ${ev.kind}${ev.step ? ` step=${ev.step}` : ''}${ev.to ? ` -> ${ev.to}` : ''}${ev.gate ? ` gate=${ev.gate}` : ''}${ev.failureCode ? ` failure=${ev.failureCode}` : ''}\n`);
    if (ev.kind === 'STATE_TRANSITION' && ev.to !== last) {
      setLifecycleState(id, ev.to, { note: `signup-driver:${ev.reasonCode ?? 'transition'}`, storePath: flags.path });
      last = ev.to;
    }
    if (ev.kind === 'TERMINAL_FAILURE') exit = 1;
    if (ev.kind === 'HUMAN_GATE') exit = 3;
  }
  process.stdout.write(`# ${id} lifecycleState=${last} evidence=${evidDir}\n`);
  return exit;
}

function main() {
  const { command, flags, positional } = parseArgs(process.argv.slice(2));
  const storePath = flags.path;

  switch (command) {
    case 'create': {
      if (!flags.role) throw new Error('create requires --role');
      const bindings = flags.fp || flags.eg
        ? { fingerprintProfileId: flags.fp ?? null, egressProfileId: flags.eg ?? null, deferred: false }
        : undefined;
      const { accountId, record, persona } = createAccount({
        role: flags.role, region: flags.region, style: flags.style, bindings, storePath,
      });
      process.stdout.write(`${summarizeLine(record)}\n`);
      if (flags.show) process.stdout.write(`password: ${persona.password}\n`);
      return 0;
    }
    case 'list': {
      const rows = listAccounts({ role: flags.role, storePath });
      for (const r of rows) process.stdout.write(`${summarizeLine(r)}\n`);
      process.stdout.write(`# ${rows.length} account(s)${flags.role ? ` role=${flags.role}` : ''}\n`);
      return 0;
    }
    case 'show': {
      const rec = getAccount(positional[0], { storePath });
      if (!rec) throw new Error(`account not found: ${positional[0]}`);
      process.stdout.write(`${summarizeLine(rec)}\n`);
      if (flags.show) process.stdout.write(`password: ${revealPassword(rec, { storePath })}\n`);
      return 0;
    }
    case 'retire': {
      const { record, alreadyRetired } = retireAccount(positional[0], { note: flags.note, storePath });
      process.stdout.write(`${record.id} retired (lifecycleState=DEAD${alreadyRetired ? ', already retired — no change' : ''})\n`);
      return 0;
    }
    case 'signup':
      return signupCommand({ flags, positional });
    case 'schedule': {
      const count = Number(flags.count ?? positional[0]);
      if (!Number.isInteger(count)) throw new Error('schedule requires --count <n>');
      const seed = flags.seed ?? `sched-${Date.now()}`;
      const { events, meta } = planRegistrationSchedule({
        count,
        window: flags.window ?? '24h',
        seed,
        start: flags.start ? new Date(flags.start).getTime() : Date.now(),
        minGapMinutes: flags['min-gap'] !== undefined ? Number(flags['min-gap']) : undefined,
        avoidNight: !flags['allow-night'],
      });
      const hkt = (iso) => new Date(new Date(iso).getTime() + 8 * 3600_000).toISOString().replace('Z', '+08:00');
      process.stdout.write(`# schedule: ${count} events in ${flags.window ?? '24h'} seed=${seed} minGap=${meta.minGapMinutes}m avoidNight=${meta.avoidNight}${meta.relaxed.length ? ` RELAXED: ${meta.relaxed.join(' | ')}` : ''}\n`);
      for (const ev of events) process.stdout.write(`${String(ev.index).padStart(4)}  ${ev.at}  ${hkt(ev.at)}\n`);
      return 0;
    }
    case 'export': {
      const json = `${JSON.stringify(exportVault({ storePath }), null, 2)}\n`;
      if (flags.out) fs.writeFileSync(flags.out, json, { mode: 0o600 });
      else process.stdout.write(json);
      return 0;
    }
    case 'import': {
      const file = positional[0];
      if (!file) throw new Error('import requires a backup file');
      const res = importVault(JSON.parse(fs.readFileSync(file, 'utf8')), { storePath });
      process.stdout.write(`imported: ${res.added} new, ${res.total} total\n`);
      return 0;
    }
    default:
      process.stdout.write(HELP);
      return command ? 2 : 0;
  }
}

try {
  Promise.resolve(main()).then((code) => { process.exitCode = code; })
    .catch((e) => {
      process.stderr.write(`account-gen: ${e.message}${e.code ? ` [${e.code}]` : ''}\n`);
      process.exitCode = 1;
    });
} catch (e) {
  process.stderr.write(`account-gen: ${e.message}${e.code ? ` [${e.code}]` : ''}\n`);
  process.exitCode = 1;
}
