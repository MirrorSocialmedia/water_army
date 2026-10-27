#!/usr/bin/env node
/**
 * 行為引擎 — acceptance dry-run stats (S4 驗收).
 * 10 accounts × 7 days, seeded → three markdown tables (activity distribution,
 * silence days, content diversity). Pure code, zero boot, replayable:
 *   node scripts/behavior/dryrun-stats.mjs [seed]
 */
import { generatePersona } from '@water-army/shared';
import { generateLifePlan, pickTopic, deriveLifeProfile } from '@water-army/shared';
import { buildContentPool } from '../../apps/worker/src/content-pipeline.js';
import { makeRng } from '@water-army/shared';

const seed = process.argv[2] ?? 'behave-accept-1';
const START = Date.parse('2026-11-08T16:00:00Z'); // Mon 2026-11-09 00:00 HKT
const DAYS = 7;

const ids = Array.from({ length: 10 }, (_, i) => `acct-${makeRng(`dryrun|${seed}|${i}`).code(10)}`);
const personas = ids.map((id) => generatePersona(id, { role: 'farm', region: 'hk', bindings: { deferred: true } }));

// —— Table 1: activity distribution ——
const TYPES = ['browse', 'like', 'follow', 'comment', 'post'];
const perAcct = personas.map((p) => {
  const plan = generateLifePlan({ accountId: p.accountId, persona: p, days: DAYS, startMs: START, seed });
  const counts = Object.fromEntries(TYPES.map((t) => [t, 0]));
  const hours = new Array(24).fill(0);
  for (const e of plan.events) {
    if (e.type in counts) { counts[e.type]++; hours[Number(e.local.slice(11, 13))]++; }
    if (e.type === 'active-window') hours[Number(e.local.slice(11, 13))] += 0.001;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { p, plan, counts, hours, total };
});
console.log(`### 表一：活躍分佈（10 帳號 × ${DAYS} 日，seed=${seed}，窗口 ${new Date(START).toISOString().slice(0, 10)} HKT 起）\n`);
console.log('| account | cadence | travel | ' + TYPES.join(' | ') + ' | 動作總數 |');
console.log('|---|---|---|' + TYPES.map(() => '---:').join('|') + '|---:|');
for (const r of perAcct) {
  const m = r.plan.meta;
  console.log(`| ${r.p.accountId} | ${m.cadence} | ${m.travelPattern} | ` + TYPES.map((t) => r.counts[t]).join(' | ') + ` | ${r.total} |`);
}
const all = perAcct.flatMap((r) => r.hours);
const inHour = (h) => all.reduce((a, v, idx) => a + (idx % 24 === h ? v : 0), 0);
const buckets = [['06–09 早峰', 6, 9], ['10–13 午前', 10, 13], ['14–17 午後', 14, 17], ['18–21 晚峰', 18, 21], ['22–05 其他', 22, 29]];
const totAll = all.reduce((a, b) => a + b, 0);
console.log('\n時段分佈（全部帳號動作計數）：');
for (const [label, lo, hi] of buckets) {
  let n = 0;
  for (let h = lo; h <= hi; h++) n += inHour(h % 24);
  console.log(`- ${label}: ${(n / totAll * 100).toFixed(1)}%`);
}
const totals = perAcct.map((r) => r.total);
const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
const sd = Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / totals.length);
console.log(`帳號間離散度：mean=${mean.toFixed(1)} sd=${sd.toFixed(1)} min=${Math.min(...totals)} max=${Math.max(...totals)}（sd/mean=${(sd / mean).toFixed(2)} — 非簡併證明）`);

// —— Table 2: silence days ——
console.log('\n### 表二：沉默日（出行 silence；同 seed 重放不變）\n');
console.log('| account | travelPattern | 7日內沉默日 | 出行窗（至返港日） |');
console.log('|---|---|---:|---|');
let silentTotal = 0;
for (const r of perAcct) {
  const m = r.plan.meta;
  const sd2 = r.plan.days.filter((d) => d.silent).length;
  silentTotal += sd2;
  console.log(`| ${r.p.accountId} | ${m.travelPattern} | ${sd2} | ${m.travelWindows.map((w) => `${w.from.slice(0, 10)}→${w.until.slice(0, 10)}(${w.silentDays}d)`).join(', ') || '—'} |`);
}
const silentAccts = perAcct.filter((r) => r.plan.days.some((d) => d.silent)).length;
console.log(`\n本窗口 ${silentTotal} 個帳號日處於沉默，涉及 ${silentAccts}/10 帳號（shenzhen 1–2d / 一般行程 3–7d 紀律見 ADR-035 決策 3）。`);

// —— Table 3: content diversity ——
const pool = await buildContentPool({ accounts: personas.map((p) => ({ accountId: p.accountId, persona: p })), perAccount: 6, seed });
const uniq = new Set(pool.candidates.map((c) => c.text));
const topics = {}; const styles = {};
for (const c of pool.candidates) { topics[c.topic] = (topics[c.topic] ?? 0) + 1; styles[c.style] = (styles[c.style] ?? 0) + 1; }
const H = (dist) => { const tot = Object.values(dist).reduce((a, b) => a + b, 0); return -Object.values(dist).reduce((a, n) => a + (n / tot) * Math.log2(n / tot), 0); };
console.log('\n### 表三：內容多樣性（template 模式、seeded、人審前候選池）\n');
console.log(`- 生成請求 ${pool.meta.requested}，接納 ${pool.meta.accepted}，防重拒收 ${pool.meta.duplicatesRejected}（trigram-jaccard ≥ 0.55）`);
console.log(`- 唯一文本 ${uniq.size}/${pool.candidates.length}`);
console.log(`- 話題分布：${JSON.stringify(topics)}`);
console.log(`- 風格分布：${JSON.stringify(styles)}`);
console.log(`- 話題熵 ${H(topics).toFixed(2)} bits（上限 ${Math.log2(7).toFixed(2)}），風格熵 ${H(styles).toFixed(2)} bits（上限 ${Math.log2(3).toFixed(2)}）`);
const sample = pool.candidates.slice(0, 3).map((c) => c.text);
console.log(`- 樣本：\n  1. ${sample[0]}\n  2. ${sample[1]}\n  3. ${sample[2]}`);
