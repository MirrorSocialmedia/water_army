#!/usr/bin/env node
/**
 * 行為引擎 S2 CLI — content pipeline operator entry (ADR-035 決策 5).
 *
 *   content-cli.js generate --accounts a1,a2 --per 4 --seed batch-1 [--mode llm]
 *                           [--ledger <path>] [--pool <approved-ledger>]
 *   content-cli.js review  list   [--ledger <path>] [--status pending]
 *   content-cli.js review  approve <id> [--ledger <path>]
 *   content-cli.js review  reject  <id> [--ledger <path>]
 *   content-cli.js stats   [--ledger <path>]
 *
 * --accounts accepts vault ids (comma-separated); personas are regenerated
 * deterministically when available in the vault (registry.json), otherwise the
 * derivation layer runs on accountId alone (same streams, ADR-035 決策 2).
 * LLM mode needs CONTENT_LLM_ENDPOINT + CONTENT_LLM_MODEL in env (injected —
 * never hardcoded); missing env or LLM failure falls back to offline templates
 * and prints RELAXED lines (loud, never silent).
 *
 * Ledger default: .dev/content/ledger.jsonl (gitignored, zero PII rows).
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { generatePersona } from '@water-army/shared';
import {
  buildContentPool, appendCandidates, readLedger, decideReview, makeLlmClient,
} from './content-pipeline.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const DEFAULT_LEDGER = process.env.CONTENT_LEDGER || path.join(ROOT, '.dev/content/ledger.jsonl');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
    else args._.push(a);
  }
  return args;
}

function loadVaultPersonas() {
  const p = process.env.ACCOUNT_REGISTRY || path.join(ROOT, '.dev/accounts/registry.json');
  try {
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    const map = new Map();
    for (const row of doc.accounts ?? []) map.set(row.id, row.persona);
    return map;
  } catch { return new Map(); }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const ledger = args.ledger || DEFAULT_LEDGER;

  if (cmd === 'generate') {
    const ids = String(args.accounts ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) throw new Error('generate: --accounts <id,id,...> required');
    if (!args.seed) throw new Error('generate: --seed required (determinism discipline)');
    const mode = args.mode === 'llm' ? 'llm' : 'template';
    const vault = loadVaultPersonas();
    const accounts = ids.map((accountId) => {
      let persona = vault.get(accountId);
      if (!persona && vault.size === 0 && /^acct-[2-9A-HJKMNP-TV-Z]{10}$/.test(accountId)) {
        // dev convenience: registry absent → deterministic hk persona for the id
        persona = generatePersona(accountId, { role: 'farm', region: 'hk', bindings: { deferred: true } });
      }
      return { accountId, persona };
    });
    let existingTexts = [];
    if (args.pool) existingTexts = readLedger(args.pool).filter((r) => r.status === 'approved').map((r) => r.text);
    const llmClient = mode === 'llm' ? makeLlmClient() : undefined;
    const res = await buildContentPool({
      accounts, perAccount: Number(args.per ?? 4), seed: String(args.seed), mode,
      existingTexts, llmClient,
      simThreshold: args.sim ? Number(args.sim) : undefined,
    });
    const added = appendCandidates(ledger, res.candidates);
    for (const c of res.candidates) process.stdout.write(`${c.id}  [${c.style}/${c.topic}] ${c.text.slice(0, 72)}\n`);
    process.stdout.write(`\nledger: ${ledger}  (+${added.added}, total ${added.total})\n`);
    process.stdout.write(`mode=${res.meta.mode} accepted=${res.meta.accepted} dup-rejected=${res.meta.duplicatesRejected}\n`);
    if (res.meta.llmFallback && res.meta.llmFallback.length) {
      process.stdout.write(`RELAXED: LLM fell back to templates ${res.meta.llmFallback.length}× (first reason: ${res.meta.llmFallback[0].reason})\n`);
    }
    return;
  }

  if (cmd === 'review') {
    const sub = args._[0];
    if (sub === 'list') {
      const want = args.status ?? 'pending';
      const rows = readLedger(ledger).filter((r) => (want === 'all' ? true : r.status === want));
      for (const r of rows) process.stdout.write(`${r.id}  ${r.status.padEnd(8)} [${r.style}/${r.topic}] ${r.text.slice(0, 72)}\n`);
      process.stdout.write(`(${rows.length} shown, ledger=${ledger})\n`);
      return;
    }
    if (sub === 'approve' || sub === 'reject') {
      const id = args._[1];
      if (!id) throw new Error(`review ${sub}: <id> required`);
      const row = decideReview(ledger, id, sub === 'approve' ? 'approved' : 'rejected');
      process.stdout.write(`${id} → ${row.status}\n`);
      return;
    }
    throw new Error('review: subcommand list|approve|reject required');
  }

  if (cmd === 'stats') {
    const rows = readLedger(ledger);
    const by = (f) => rows.reduce((m, r) => (m[f(r)] = (m[f(r)] ?? 0) + 1, m), {});
    process.stdout.write(`ledger=${ledger}\ntotal=${rows.length}\nstatus=${JSON.stringify(by((r) => r.status))}\ntopic=${JSON.stringify(by((r) => r.topic))}\nstyle=${JSON.stringify(by((r) => r.style))}\n`);
    const uniq = new Set(rows.map((r) => r.text)).size;
    process.stdout.write(`unique-texts=${uniq}/${rows.length}\n`);
    return;
  }

  process.stdout.write('usage: content-cli.js generate|review|stats … (-h for flags via source header)\n');
  if (!cmd) process.exitCode = 1;
}

main().catch((e) => { console.error(`content-cli: ${e.message}`); process.exitCode = 1; });
