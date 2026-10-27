#!/usr/bin/env node
/**
 * 行為引擎 S3 CLI — daily dry-run driver (ADR-035 決策 6).
 *
 *   daily-cli.js today --accounts id,id [--date YYYY-MM-DD] --seed S
 *                      [--ledger <content ledger>] [--json <out.json>]
 *                      [--quiet]
 *
 * Default date = today (HKT). Console output = 「今日每帳號做乜」;
 * --json exports the deterministic task structure (what a future Mobile
 * Console executor will receive). Dry-run only: touches no adb, no DB.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { buildDailyTasks, renderConsolePlan, DryRunExecutor } from './daily-driver.js';
import { approvedPool } from './content-pipeline.js';

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

const todayHkt = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (cmd !== 'today') {
    process.stdout.write('usage: daily-cli.js today --accounts id,id --seed S [--date YYYY-MM-DD] [--ledger f] [--json f] [--quiet]\n');
    process.exitCode = cmd ? 1 : 0;
    return;
  }
  const ids = String(args.accounts ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new Error('--accounts <id,id,...> required');
  if (!args.seed) throw new Error('--seed required (determinism discipline)');
  const vault = loadVaultPersonas();
  const ledgerPath = args.ledger ?? DEFAULT_LEDGER;
  const pool = fs.existsSync(ledgerPath) ? approvedPool(ledgerPath) : [];
  if (!pool.length) process.stderr.write(`daily-cli: WARN approved content pool empty (${ledgerPath}) — comment/post 項將標記 needsContent\n`);
  const tasks = buildDailyTasks({
    accounts: ids.map((accountId) => ({ accountId, persona: vault.get(accountId) })),
    date: args.date ?? todayHkt(),
    seed: String(args.seed),
    pool,
  });
  if (!args.quiet) process.stdout.write(renderConsolePlan(tasks) + '\n');
  if (args.json) {
    fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    fs.writeFileSync(args.json, JSON.stringify(tasks, null, 2) + '\n');
    process.stderr.write(`daily-cli: json → ${args.json}\n`);
  }
  const ex = new DryRunExecutor({ log: args.quiet ? { info() {} } : console });
  const receipts = await ex.execute(tasks);
  const skipped = receipts.filter((r) => r.status === 'skipped-no-content').length;
  process.stdout.write(`\nDRY-RUN: ${receipts.length} 指令會執行（${skipped} 項缺內容跳過）— 無任何真執行（Mobile Console executor = 後續單）\n`);
}

main().catch((e) => { console.error(`daily-cli: ${e.message}`); process.exitCode = 1; });
