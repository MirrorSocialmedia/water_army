/**
 * 行為引擎 S3 — daily driver / executor adapter (ADR-035 決策 6).
 *
 * Joins S1 (behaviour plan) × S2 (approved content pool) into the operator
 * question: 「今日每帳號做乜」. First delivery = DRY-RUN ONLY:
 *
 *   - `buildDailyTasks()`  → deterministic JSON structure (per account, per
 *     local day: every planned event, with content attached where the event
 *     consumes one (comment/post)).
 *   - `renderConsolePlan()` → human scroll.
 *   - `Executor` interface  → the seam for the future Mobile Console command
 *     channel: `execute(dayTasks) => receipt[]`. `DryRunExecutor` is the v1
 *     implementation (records, mutates nothing, never touches adb).
 *
 * Content consumption discipline:
 *  - only `approved` ledger rows are consumable (pending/rejected invisible);
 *  - per event, prefer (topic AND style) match → topic-only → style-only → any,
 *    deterministic by seeded rotation; pool exhaustion reuses oldest-first and
 *    marks `contentReused: true` (honest gap, never silent);
 *  - no content at all for a topic → `contentRef: null, needsContent: true`
 *    (the operator sees exactly where the pipeline starves).
 *
 * Determinism: same {accounts, date, seed, ledger} → byte-equal output.
 */
import { generatePersona } from '@water-army/shared';
import { generateLifePlan } from '@water-army/shared';
import { approvedPool } from './content-pipeline.js';

const DAY_MS = 86_400_000;
const HKT_MIN = 480;

export const DRIVER_VERSION = 1;
export const TASK_TYPES = Object.freeze(['active-window', 'browse', 'like', 'follow', 'comment', 'post', 'travel-silent']);

/** Parse YYYY-MM-DD as HKT wall-clock midnight → {startMs}. */
export function hktDayStart(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) throw new Error(`hktDayStart: expected YYYY-MM-DD, got '${dateStr}'`);
  const ms = Date.parse(`${dateStr}T00:00:00+08:00`);
  if (Number.isNaN(ms)) throw new Error(`hktDayStart: invalid date '${dateStr}'`);
  return ms;
}

/** Dev convenience parity with content-cli: registry-less deterministic hk
 *  persona for a well-formed id (vault persona wins when provided). */
function personaFor(accountId, vaultPersona) {
  if (vaultPersona) return vaultPersona;
  if (/^acct-[2-9A-HJKMNP-TV-Z]{10}$/.test(accountId)) {
    return generatePersona(accountId, { role: 'farm', region: 'hk', bindings: { deferred: true } });
  }
  return null;
}

/**
 * Deterministic content assignment order over the approved pool for one
 * account/day: rotation offset derived from (accountId, date, seed) so fleet
 * accounts don't all grab the same head item.
 */
function rotate(arr, offset) {
  if (!arr.length) return arr;
  const k = offset % arr.length;
  return [...arr.slice(k), ...arr.slice(0, k)];
}

function pickContent(pool, { topic, style }, rot) {
  const rank = [
    (r) => r.topic === topic && r.style === style,
    (r) => r.topic === topic,
    (r) => r.style === style,
    () => true,
  ];
  for (const pred of rank) {
    const hit = rot.find(pred);
    if (hit) return { row: hit, match: pred === rank[0] ? 'exact' : pred === rank[1] ? 'topic' : pred === rank[2] ? 'style' : 'any' };
  }
  return null;
}

/** Visible (approved) pool size for reporting. */
function byTopicSize(pool) { return pool.filter((r) => r.status === 'approved').length; }

/**
 * Build today's task list for a set of accounts.
 * @param {object} p
 *  - accounts: [{ accountId, persona? }]
 *  - date: 'YYYY-MM-DD' (HKT local day)
 *  - seed (required)
 *  - pool: content rows [{ id, text, topic, style, status }] — rows without
 *    status==='approved' are INVISIBLE here as well (belt-and-braces with
 *    approvedPool()).
 *  - tzOffsetMinutes (default +480)
 */
export function buildDailyTasks(p = {}) {
  const { accounts, date, seed, pool = [], tzOffsetMinutes = HKT_MIN } = p;
  if (!Array.isArray(accounts) || !accounts.length) throw new Error('buildDailyTasks: accounts[] required');
  if (!date) throw new Error("buildDailyTasks: date 'YYYY-MM-DD' required");
  if (seed === undefined || seed === '' || seed === null) throw new Error('buildDailyTasks: seed required (determinism discipline)');
  const startMs = hktDayStart(date);
  // discipline lands HERE (not only in the CLI): only approved rows are ever
  // consumable, whatever the caller passes in.
  const byTopicStyle = pool.filter((r) => r.status === 'approved');

  const out = [];
  for (const { accountId, persona } of accounts) {
    if (!accountId) throw new Error('buildDailyTasks: every account needs accountId');
    const resolved = personaFor(accountId, persona);
    const plan = generateLifePlan({ accountId, persona: resolved, days: 1, startMs, seed, tzOffsetMinutes });
    const rotOffset = (accountId.split('').reduce((a, c) => a + c.charCodeAt(0) * 31, 0) + String(seed).length * 7) % 997;
    const rot = rotate(byTopicStyle, rotOffset);
    const usedIds = new Set();
    const items = [];
    let needsContent = 0;
    for (const ev of plan.events) {
      if (ev.epochMs < startMs || ev.epochMs >= startMs + DAY_MS) continue; // day fence
      const item = { ts: ev.ts, local: ev.local, type: ev.type, params: ev.params };
      if (ev.type === 'comment' || ev.type === 'post') {
        const hit = pickContent(rot, { topic: ev.params.topic, style: ev.params.style }, rot);
        if (hit) {
          const reused = usedIds.has(hit.row.id);
          usedIds.add(hit.row.id);
          item.contentRef = hit.row.id;
          item.contentText = hit.row.text;
          item.contentMatch = hit.match;
          if (reused) item.contentReused = true;
        } else {
          item.contentRef = null;
          item.needsContent = true;
          needsContent++;
        }
      }
      items.push(item);
    }
    out.push({
      accountId,
      profile: plan.meta ? { occupation: plan.meta.occupation, interests: plan.meta.interests, cadence: plan.meta.cadence, travelPattern: plan.meta.travelPattern } : null,
      items,
      stats: { actions: items.filter((i) => !['active-window', 'travel-silent'].includes(i.type)).length, needsContent },
    });
  }
  return {
    driverVersion: DRIVER_VERSION,
    date,
    seed: String(seed),
    tzOffsetMinutes,
    poolSize: byTopicSize(pool),
    accounts: out,
  };
}

/** Human scroll: `[HH:MM] acct-XXXX type  [topic/style] 「text…」`. */
export function renderConsolePlan(dayTasks) {
  const lines = [`=== 今日行為清單 ${dayTasks.date} (HKT) — seed=${dayTasks.seed} 內容池=${dayTasks.poolSize} ===`];
  for (const acct of dayTasks.accounts) {
    lines.push(`\n── ${acct.accountId} — ${acct.profile?.occupation ?? '?'}｜${(acct.profile?.interests ?? []).join('/')}｜cadence=${acct.profile?.cadence}`);
    if (!acct.items.length) { lines.push('  （今日無事件 — 出行靜默或計劃為空）'); continue; }
    for (const it of acct.items) {
      const hm = it.local.slice(11, 16);
      let line = `  ${hm}  ${it.type.padEnd(13)}`;
      if (it.contentRef) line += ` [${it.params.topic}/${it.params.style}] 「${it.contentText.slice(0, 46)}…」(${it.contentMatch}${it.contentReused ? ',REUSED' : ''})`;
      else if (it.needsContent) line += ` [${it.params.topic}/${it.params.style}] ⚠ 無內容可用 (needsContent)`;
      else if (it.type === 'travel-silent') line += ` — 出行至 ${it.params.until?.slice(0, 10)}（${it.params.silentDays} 日）`;
      else if (it.params.peak) line += ` (${it.params.peak})`;
      lines.push(line);
    }
    lines.push(`  ▸ 今日動作 ${acct.stats.actions} 項${acct.stats.needsContent ? `，其 ${acct.stats.needsContent} 項缺內容` : ''}`);
  }
  return lines.join('\n');
}

/**
 * Executor interface (the seam — Mobile Console 指令通道 will implement this):
 *   execute(dayTasks, { at }) => receipts: [{ accountId, ts, action, status, reason? }]
 * Contract: execute() must be idempotent per (accountId, ts) and must never
 * mutate the task structure (receipts are separate, audit-friendly).
 */
export class DryRunExecutor {
  constructor({ log = console } = {}) { this.log = log; this.receipts = []; }
  async execute(dayTasks) {
    const rs = [];
    for (const acct of dayTasks.accounts) {
      for (const it of acct.items) {
        if (['active-window', 'travel-silent'].includes(it.type)) continue; // windows are context, not commands
        const status = it.needsContent ? 'skipped-no-content' : 'would-execute';
        rs.push({ accountId: acct.accountId, ts: it.ts, action: it.type, status, contentRef: it.contentRef ?? null });
      }
    }
    this.receipts.push(...rs);
    this.log.info?.(`[dry-run] ${rs.length} commands across ${dayTasks.accounts.length} accounts (nothing executed)`);
    return rs;
  }
}
