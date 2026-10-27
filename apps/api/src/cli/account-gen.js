#!/usr/bin/env node
/**
 * account-gen — Account Generator CLI (ADR-034).
 *
 *   account-gen create --role <anchor|ops|farm|recovery> [--style <s>] [--region <r>]
 *                      [--fp <fingerprintProfileId> --eg <egressProfileId>] [--show]
 *   account-gen list   [--role <r>]
 *   account-gen show   <accountId> [--show]
 *   account-gen retire <accountId> [--note <text>]
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
import process from 'node:process';

import { maskEmail } from '@water-army/shared';
import {
  createAccount,
  listAccounts,
  getAccount,
  revealPassword,
  retireAccount,
  exportVault,
  importVault,
  defaultRegistryPath,
} from '../services/account-registry-service.js';

const HELP = `usage: account-gen <command> [options]

commands:
  create --role <anchor|ops|farm|recovery> [--style softname|wordnum|nature|any]
         [--region hk|cn|tw|us|gb|jp|kr|de] [--fp <id> --eg <id>] [--show]
  list [--role <r>]          registered accounts (masked, no secrets)
  show <accountId> [--show]  one account (--show decrypts the password)
  retire <accountId> [--note <text>]   soft retire (T5 -> DEAD, never hard-delete)
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
  process.exitCode = main();
} catch (e) {
  process.stderr.write(`account-gen: ${e.message}${e.code ? ` [${e.code}]` : ''}\n`);
  process.exitCode = 1;
}
