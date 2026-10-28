/**
 * 行為引擎 — 對抗式測試輪 (adversarial hardening, 2026-10-28).
 *
 * 立場切換：唔再係「自己驗自己」嘅紀律測試，而係假設一個 Google/社交平台
 * 風控分析員主動攻擊：naive distinguisher、同 persona 壓力、邊界轟炸、
 * 內容注入。所有隨機性皆 seeded (repo splitmix64) → 斷言確定、零 flaky。
 *
 * 配套源碼修復（本輪發現即修）：
 *  - FIX-1  life-schedule dayKind: holidayFor 改 strict — 長窗跨出 2026–2027
 *           假期表盡頭時 loud fail（之前 strict:false 靜默當普通日：
 *           2028-01-01 新年會被當普通星期六 = 無聲爛掉）。
 *  - FIX-2  content-pipeline: LLM 輸出消毒（超長/控制字元/零寬注入 → 剝除+
 *           截斷；消毒後過短 → loud fallback 記 meta.llmFallback）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeRng } from '../../packages/shared/src/fingerprint-profile.js';
import {
  generateLifePlan, holidayFor, HK_HOLIDAYS,
} from '../../packages/shared/src/life-schedule.js';
import { buildContentPool, renderTemplate } from '../../apps/worker/src/content-pipeline.js';
import { buildDailyTasks } from '../../apps/worker/src/daily-driver.js';

const DAY_MS = 86_400_000;
const HKT_OFFSET = 480;
const START = Date.UTC(2026, 10, 8, 16); // 2026-11-09 00:00 HKT (Mon)
const acctId = (tag) => `acct-${makeRng(`wa-adv|${tag}`).code(10)}`;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const localHour = (ms) => new Date(ms + HKT_OFFSET * 60_000).getUTCHours();

/** Action events only (windows/travel markers are context, not behaviour). */
const actions = (plan) => plan.events.filter((e) => !['active-window', 'travel-silent'].includes(e.type));

/** Per-account action ts lists for a seeded travelless fleet. */
function oursFleet(n, days, seedTag, life) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = acctId(`fleet-${seedTag}-${i}`);
    const persona = life ? { hk: { life } } : null;
    const p = generateLifePlan({ accountId: id, persona, days, startMs: START, seed: `${seedTag}-${i}` });
    out.push(actions(p).map((e) => e.epochMs));
  }
  return out;
}

// --- baselines: SAME horizon & same per-account event budget ----------------
/** Metronome: identical period; optional per-account phase (clock-heartbeat bot). */
function metronomeFleet(n, perAccount, horizonMs, jitteredPhase = true) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const rng = makeRng(`wa-adv-metro|${i}`);
    const phase = jitteredPhase ? Math.floor((rng.u32() / 0xffffffff) * perAccount) : 0;
    const step = horizonMs / perAccount;
    const ev = [];
    // cyclic placement: exactly `perAccount` events, all gaps = step (a pure
    // clock heartbeat, phase-shifted per account)
    for (let k = 0; k < perAccount; k++) ev.push(Math.round(START + (((phase + k) % perAccount) * step)));
    out.push(ev.sort((a, b) => a - b));
  }
  return out;
}
/** Uniform random: same budget, uniform over horizon (Poisson-like gaps). */
function uniformFleet(n, perAccount, horizonMs) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const rng = makeRng(`wa-adv-unif|${i}`);
    const ev = [];
    for (let k = 0; k < perAccount; k++) ev.push(START + Math.floor((rng.u32() / 0xffffffff) * horizonMs));
    out.push(ev.sort((a, b) => a - b));
  }
  return out;
}

// --- naive distinguisher features -------------------------------------------
/** Gap CV per account: metronome ≈ 0, uniform random ≈ 1, human bursty > 1. */
function gapCV(events) {
  const g = [];
  for (let i = 1; i < events.length; i++) g.push(events[i] - events[i - 1]);
  return g.length > 2 ? std(g) / mean(g) : 1;
}
/** Per-account chi-square (24 hourly bins) against the uniform hour law. */
function hourChi2(events) {
  const h = new Array(24).fill(0);
  for (const t of events) h[localHour(t)]++;
  const e = events.length / 24;
  if (e === 0) return 0;
  return h.reduce((a, o) => a + ((o - e) ** 2) / e, 0);
}
/** Cross-account identical-minute collision rate (shared-cron bot signature). */
function minuteCollisionRate(fleet) {
  const min = fleet.map((ev) => new Set(ev.map((t) => Math.floor(t / 60_000))));
  let hits = 0, pairs = 0;
  for (let i = 0; i < min.length; i++) {
    for (let j = i + 1; j < min.length; j++) {
      pairs++;
      const [a, b] = min[i].size <= min[j].size ? [min[i], min[j]] : [min[j], min[i]];
      let shared = 0;
      for (const m of a) if (b.has(m)) shared++;
      if (shared / Math.max(1, a.size) > 0.1) hits++;
    }
  }
  return hits / Math.max(1, pairs);
}
/**
 * NAIVE machine-likeness score in [0,2]:
 *   term A (rhythm): 1 − min(1, meanGapCV/0.5)  — dead-regular gaps light up
 *   term B (hour law): 1 − min(1, meanChi2/36)  — flat hourly profile lights up
 * A naive analyst threshold (score ≥ 1 ⇒ bot) must flag the metronome and
 * MUST NOT flag our fleet; ours must sit at/below the uniform-random score
 * (i.e. cluster WITH random, never WITH the metronome).
 */
function naiveScore(fleet) {
  const cv = mean(fleet.map(gapCV));
  const chi = mean(fleet.map(hourChi2));
  return (1 - Math.min(1, cv / 0.5)) + (1 - Math.min(1, chi / 36));
}

// ===========================================================================
// A. 探測者測試（distinguisher）
// ===========================================================================
test('A1 distinguisher: metronome flagged, ours clusters with random — never with metronome', () => {
  const N = 20, DAYS = 21;
  const ours = oursFleet(N, DAYS, 'dist');
  const budget = Math.round(mean(ours.map((e) => e.length)));
  const horizon = DAYS * DAY_MS;
  const metro = metronomeFleet(N, budget, horizon);
  const unif = uniformFleet(N, budget, horizon);

  const s = { ours: naiveScore(ours), metro: naiveScore(metro), unif: naiveScore(unif) };
  const cv = { ours: mean(ours.map(gapCV)), metro: mean(metro.map(gapCV)), unif: mean(unif.map(gapCV)) };
  const chi = { ours: mean(ours.map(hourChi2)), metro: mean(metro.map(hourChi2)), unif: mean(unif.map(hourChi2)) };
  console.log(`[A1] naiveScore ours=${s.ours.toFixed(3)} metro=${s.metro.toFixed(3)} unif=${s.unif.toFixed(3)} | gapCV ours=${cv.ours.toFixed(2)} metro=${cv.metro.toFixed(3)} unif=${cv.unif.toFixed(2)} | chi2 ours=${chi.ours.toFixed(0)} metro=${chi.metro.toFixed(0)} unif=${chi.unif.toFixed(0)} | budget/acct=${budget}`);

  // naive threshold classifier (≥1 ⇒ bot): flags metronome ONLY
  const flag = (x) => x >= 1;
  assert.ok(flag(s.metro), 'metronome MUST be caught by the naive distinguisher');
  assert.ok(!flag(s.ours), `ours must NOT be flagged (score ${s.ours.toFixed(3)})`);
  assert.ok(!flag(s.unif), 'uniform random must not be flagged either');
  // clustering: ours is much closer to random than to metronome
  assert.ok(Math.abs(s.ours - s.unif) < Math.abs(s.metro - s.ours), 'ours must cluster with random, not metronome');
  // structural sanity: real rhythm signature separation
  assert.ok(cv.metro < 0.05, 'metronome gap CV ~0');
  assert.ok(cv.ours > 1, `bursty fleet gap CV should exceed random (~1), got ${cv.ours.toFixed(2)}`);
  assert.ok(chi.ours > 3 * chi.unif, `ours must show non-flat (circadian) hour law: ours=${chi.ours.toFixed(0)} unif=${chi.unif.toFixed(0)}`);
});

test('A1b shared-cron collision detector sanity: synced metronome collides, ours/uniform do not', () => {
  const N = 12, DAYS = 14, budget = 120;
  const ours = oursFleet(N, DAYS, 'coll');
  const metroSync = metronomeFleet(N, budget, DAYS * DAY_MS, false); // same phase = shared cron
  const unif = uniformFleet(N, budget, DAYS * DAY_MS);
  const r = { ours: minuteCollisionRate(ours), metro: minuteCollisionRate(metroSync), unif: minuteCollisionRate(unif) };
  console.log(`[A1b] minute-collision pair-rate ours=${r.ours.toFixed(2)} metroSync=${r.metro.toFixed(2)} unif=${r.unif.toFixed(2)}`);
  assert.ok(r.metro > 0.9, 'synced metronome fleet must collide on minutes');
  assert.ok(r.ours < 0.1, `ours must not share minutes across accounts (got ${r.ours.toFixed(2)})`);
  assert.ok(r.unif < 0.1);
});

test('A2 anti-brag: engine HAS human-like burstiness + circadian day autocorrelation (loud metrics)', () => {
  const N = 12, DAYS = 21;
  const fleet = oursFleet(N, DAYS, 'burst');
  const unif = uniformFleet(N, Math.round(mean(fleet.map((e) => e.length))), DAYS * DAY_MS);
  // burstiness: fraction of consecutive pairs < 5 min apart
  const burstFrac = (ev) => {
    let n = 0, b = 0;
    for (let i = 1; i < ev.length; i++) { n++; if (ev[i] - ev[i - 1] < 5 * 60_000) b++; }
    return n ? b / n : 0;
  };
  const bOurs = mean(fleet.map(burstFrac));
  const bUnif = mean(unif.map(burstFrac));
  // circadian autocorrelation: hourly-count vectors, lag 24h, per account
  const autoc = (ev) => {
    const byDay = new Map();
    for (const t of ev) {
      const d = Math.floor((t + HKT_OFFSET * 60_000) / DAY_MS);
      const h = localHour(t);
      if (!byDay.has(d)) byDay.set(d, new Array(24).fill(0));
      byDay.get(d)[h]++;
    }
    const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
    const cors = [];
    for (let i = 1; i < days.length; i++) {
      const [x, y] = [days[i - 1][1], days[i][1]];
      const mx = mean(x), my = mean(y);
      const num = x.reduce((a, v, k) => a + (v - mx) * (y[k] - my), 0);
      const den = Math.sqrt(x.reduce((a, v) => a + (v - mx) ** 2, 0) * y.reduce((a, v) => a + (v - my) ** 2, 0));
      if (den > 0) cors.push(num / den);
    }
    return cors.length ? mean(cors) : 0;
  };
  const aOurs = mean(fleet.map(autoc));
  const aUnif = mean(unif.map(autoc));
  console.log(`[A2] burstFrac(<5min) ours=${bOurs.toFixed(3)} unif=${bUnif.toFixed(3)} | lag24h autocorr ours=${aOurs.toFixed(3)} unif=${aUnif.toFixed(3)}`);
  // LOUD RECORD: these are the "human texture" features a perfect-random
  // generator would LACK. If they ever regress to random-level, this screams.
  assert.ok(bOurs > 5 * Math.max(bUnif, 0.005), `burstiness lost: ours=${bOurs.toFixed(3)} vs uniform=${bUnif.toFixed(3)}`);
  assert.ok(aOurs > 0.05, `circadian autocorrelation lost: ${aOurs.toFixed(3)}`);
});

// ===========================================================================
// B. 同 persona 壓力
// ===========================================================================
test('B1: 100 IDENTICAL personas + identical seed → streams still pairwise distinct', () => {
  const life = {
    travelPattern: 'none',
    occupation: '护士',
    interests: ['煮嘢食', '追剧'],
    social: { primaryPlatform: 'x', languageMix: 'zh-Hant-dominant', postingCadence: 'regular' },
  };
  const fleet = [];
  const digests = new Set();
  const firstEventMinutes = new Set();
  const firstEventMinutesAll = [];
  for (let i = 0; i < 100; i++) {
    const p = generateLifePlan({ accountId: acctId(`sameperson-${i}`), persona: { hk: { life } }, days: 7, startMs: START, seed: 'SAME' });
    digests.add(p.events.map((e) => `${e.epochMs}:${e.type}`).join('|'));
    const fm = Math.floor(p.events[0].epochMs / 60_000);
    firstEventMinutes.add(fm);
    firstEventMinutesAll.push(fm);
    assert.equal(p.meta.occupation, '护士'); // persona override honoured for all
    fleet.push(actions(p).map((e) => e.epochMs));
  }
  // birthday-collision math: morning jitter band is ~70 min, so ~13% of 100
  // accounts legitimately land on a shared minute — what must NOT happen is a
  // fat shared minute (peak sync). Assert max share of any single minute ≤ 5%.
  const shareHist = new Map();
  for (const m of firstEventMinutesAll) shareHist.set(m, (shareHist.get(m) ?? 0) + 1);
  const maxShare = Math.max(...shareHist.values());
  console.log(`[B1] identical-persona fleet: unique streams ${digests.size}/100, distinct first-event minutes ${firstEventMinutes.size}/100, busiest minute ${maxShare} accounts`);
  assert.equal(digests.size, 100, 'same persona+seed must NOT clone the stream (accountId keys the rng)');
  assert.ok(firstEventMinutes.size >= 70, `fleet must not share peak minutes (got ${firstEventMinutes.size}/100)`);
  assert.ok(maxShare <= 5, `no minute may carry a crowd (busiest=${maxShare})`);
  // same BEHAVIOUR CLASS though (that is the point of same persona): the
  // hour-law intensity must not split into clusters
  const chi = fleet.map(hourChi2);
  assert.ok(std(chi) / mean(chi) < 0.5, `same-persona hour-law spread should be modest, got cv=${(std(chi) / mean(chi)).toFixed(2)}`);
});

test('B2 seed sensitivity: ±1 seed moves the plan hard; seed space does not cluster', () => {
  const id = acctId('seed-sweep');
  const digests = new Set();
  let overlapSum = 0, trials = 0;
  for (let s = 1; s <= 30; s++) {
    const a = generateLifePlan({ accountId: id, days: 7, startMs: START, seed: `run-${s}` });
    const b = generateLifePlan({ accountId: id, days: 7, startMs: START, seed: `run-${s + 1}` });
    digests.add(a.events.map((e) => `${e.epochMs}:${e.type}`).join('|'));
    const ta = new Set(a.events.map((e) => e.epochMs));
    const tb = new Set(b.events.map((e) => e.epochMs));
    const inter = [...ta].filter((t) => tb.has(t)).length;
    overlapSum += inter / Math.max(1, Math.max(ta.size, tb.size));
    trials++;
  }
  digests.add('sentinel'); // seed 31 digest joins below via recount
  const overlap = overlapSum / trials;
  console.log(`[B2] seed±1 event-timestamp overlap = ${(overlap * 100).toFixed(1)}% ; unique digests ${digests.size - 1}/30`);
  assert.ok(overlap < 0.15, `adjacent seeds must almost fully re-plan (overlap ${(overlap * 100).toFixed(1)}% > 15% = seed-space clustering)`);
  assert.equal(digests.size - 1, 30, '30 adjacent seeds → 30 distinct plans (no seed collisions)');
  // numeric seeds behave the same way, incl. 0 / negative / huge
  const z = generateLifePlan({ accountId: id, days: 3, startMs: START, seed: 0 });
  assert.ok(z.events.length > 0);
  assert.deepEqual(z.events.map((e) => e.epochMs), generateLifePlan({ accountId: id, days: 3, startMs: START, seed: 0 }).events.map((e) => e.epochMs));
  const neg = generateLifePlan({ accountId: id, days: 3, startMs: START, seed: -99999 });
  const big = generateLifePlan({ accountId: id, days: 3, startMs: START, seed: Number.MAX_SAFE_INTEGER });
  assert.notDeepEqual(neg.events.map((e) => e.epochMs), big.events.map((e) => e.epochMs));
  assert.deepEqual(neg.events.map((e) => e.epochMs), generateLifePlan({ accountId: id, days: 3, startMs: START, seed: -99999 }).events.map((e) => e.epochMs));
});

// ===========================================================================
// C. 邊界攻擊
// ===========================================================================
test('C1 day-window edges: days=0/91 rejected, days=1 works, days=90 works', () => {
  const id = acctId('edge-days');
  assert.throws(() => generateLifePlan({ accountId: id, days: 0, startMs: START, seed: 'e' }), RangeError);
  assert.throws(() => generateLifePlan({ accountId: id, days: 91, startMs: START, seed: 'e' }), RangeError);
  const one = generateLifePlan({ accountId: id, days: 1, startMs: START, seed: 'e' });
  assert.equal(one.days.length, 1);
  assert.equal(one.days[0].day, '2026-11-09');
  assert.ok(one.events.every((e) => e.epochMs >= START && e.epochMs < START + DAY_MS), 'days=1: every event inside the single-day fence');
  const long = generateLifePlan({ accountId: id, days: 90, startMs: START, seed: 'e' });
  assert.equal(long.days.length, 90);
  assert.ok(long.events.length > 300);
});

test('C2 90d travel straddle discipline: no truncated spans, silence honoured, resume after return', () => {
  // sweep many seeds so head/tail-straddling trips are definitely produced
  let straddlesSkipped = 0, windowsSeen = 0;
  for (let i = 0; i < 40; i++) {
    const id = acctId(`straddle-${i}`);
    const persona = { hk: { life: { travelPattern: i % 2 ? 'jp-quarterly' : 'tw-weekly' } } };
    const plan = generateLifePlan({ accountId: id, persona, days: 90, startMs: START, seed: `str-${i}` });
    const horizonEnd = START + 90 * DAY_MS;
    for (const w of plan.meta.travelWindows) {
      windowsSeen++;
      const from = Date.parse(w.from);
      const until = Date.parse(w.until);
      const [lo, hi] = i % 2 ? [3, 7] : [3, 7]; // both patterns are 3–7d class
      assert.ok(w.silentDays >= lo && w.silentDays <= hi, `span ${w.silentDays} outside 3..7`);
      assert.ok(until <= horizonEnd, `window ${w.from}..${w.until} truncated past horizon`);
      // zero non-marker events inside the silence
      for (const e of plan.events) {
        if (e.epochMs >= from && e.epochMs < until) assert.equal(e.type, 'travel-silent', 'event leaked into silence');
      }
    }
    // resume discipline: the day AFTER a window's until is never silent unless
    // a DIFFERENT window legitimately covers it
    const silentDays = new Set(plan.days.filter((d) => d.silent).map((d) => d.day));
    for (const w of plan.meta.travelWindows) {
      const nextMidnight = Date.parse(w.until); // HKT midnight epoch of return day
      const coveredByOther = plan.meta.travelWindows.some((x) => x !== w && Date.parse(x.from) <= nextMidnight && nextMidnight < Date.parse(x.until));
      if (coveredByOther) continue;
      const nextDay = new Date(nextMidnight + HKT_OFFSET * 60_000).toISOString().slice(0, 10);
      assert.ok(!silentDays.has(nextDay), `${id}: ${nextDay} still silent after return`);
    }
    if (plan.meta.travelWindows.length === 0) straddlesSkipped++;
  }
  console.log(`[C2] 90d sweep: ${windowsSeen} travel windows verified (0 truncated past horizon), ${straddlesSkipped}/40 fleets untravelled`);
  assert.ok(windowsSeen > 10, 'sweep must produce travel windows to be meaningful');
});

test('C3 cross-year fail-closed (FIX-1): horizon touching 2028 LOUD fails, 2027-12-31 edge OK', () => {
  const id = acctId('crossyear');
  // 2027-12-27 → 2028-01-05 window: days 2028-01-01..05 are OUTSIDE the
  // embedded holiday table → engine must refuse, not pretend New Year is a
  // plain Saturday (regression: dayKind used strict:false before FIX-1).
  const start = Date.UTC(2027, 11, 26, 16); // 2027-12-27 00:00 HKT
  assert.throws(() => generateLifePlan({ accountId: id, days: 10, startMs: start, seed: 'xy' }),
    (e) => e instanceof RangeError && /2028-01-01/.test(e.message));
  // exactly inside the table (ends 2027-12-31): fine
  const ok = generateLifePlan({ accountId: id, days: 5, startMs: Date.UTC(2027, 11, 26, 16), seed: 'xy' });
  assert.equal(ok.days.at(-1).day, '2027-12-31');
  // pre-table start also loud
  assert.throws(() => generateLifePlan({ accountId: id, days: 3, startMs: Date.UTC(2025, 11, 30, 16), seed: 'xy' }), RangeError);
  // holiday semantics preserved at the far edge
  assert.equal(HK_HOLIDAYS['2027-12-27'], 'Christmas Day (replacement)');
  assert.equal(holidayFor('2027-12-31'), null);
  assert.throws(() => holidayFor('2028-01-01'), RangeError);
});

test('C4 scale: 1000 accounts × 7d in <5s with sane memory', () => {
  const ids = Array.from({ length: 1000 }, (_, i) => acctId(`scale-${i}`));
  const before = process.memoryUsage().heapUsed;
  const t0 = Date.now();
  let events = 0;
  for (const id of ids) events += generateLifePlan({ accountId: id, days: 7, startMs: START, seed: 'scale-1' }).events.length;
  const ms = Date.now() - t0;
  const grewMB = (process.memoryUsage().heapUsed - before) / 1048576;
  console.log(`[C4] 1000 accts x 7d: ${ms}ms, ${events} events, heap delta ${grewMB.toFixed(0)}MB`);
  assert.ok(ms < 5000, `1000-account plan took ${ms}ms (budget 5000)`);
  assert.ok(events > 40_000, 'sanity: fleet produced a plausible event volume');
  assert.ok(grewMB < 400, `heap delta ${grewMB.toFixed(0)}MB looks leaky for 7d×1000`);
});

// ===========================================================================
// D. 內容對抗
// ===========================================================================
test('D1 starved pool honesty: all-pending/rejected pool is INVISIBLE — needsContent everywhere, never stale text', () => {
  const id = acctId('starve');
  const persona = { hk: { life: { travelPattern: 'none', social: { primaryPlatform: 'x', languageMix: 'zh-Hant-dominant', postingCadence: 'regular' } } } };
  const pool = [
    { id: 'cc-pending01', text: '未審嘅文', topic: 'leisure', style: 'cantonese', status: 'pending' },
    { id: 'cc-rejected1', text: '被否決嘅文', topic: 'travel', style: 'written', status: 'rejected' },
    { id: 'cc-nostatus0', text: '無狀態嘅文', topic: 'shopping', style: 'en' }, // missing status = not approved
  ];
  let contentItems = 0;
  for (let d = 0; d < 7 && contentItems === 0; d++) {
    const date = new Date(START + d * DAY_MS).toISOString().slice(0, 10);
    const tasks = buildDailyTasks({ accounts: [{ accountId: id, persona }], date, seed: 'starve', pool });
    assert.equal(tasks.poolSize, 0, 'non-approved rows must not show in visible pool');
    for (const acct of tasks.accounts) {
      for (const it of acct.items) {
        if (it.type === 'comment' || it.type === 'post') {
          contentItems++;
          assert.equal(it.contentRef ?? null, null, 'starved pipeline must not attach any text');
          assert.equal(it.needsContent, true);
          assert.equal(it.contentText, undefined, 'no stale text may leak');
        }
      }
    }
  }
  assert.ok(contentItems > 0, 'sweep must produce comment/post events to be meaningful');
  console.log(`[D1] starved pool: ${contentItems} content events all honestly needsContent=true`);
});

test('D1b reuse is loud: repeats within a day are always flagged (never silent)', () => {
  const id = acctId('reuse');
  const persona = { hk: { life: { travelPattern: 'none', social: { primaryPlatform: 'x', languageMix: 'zh-Hant-dominant', postingCadence: 'regular' } } } };
  const pool = [{ id: 'cc-onlyrow', text: '全池唯一得呢句', topic: 'leisure', style: 'cantonese', status: 'approved' }];
  let content = 0, reused = 0;
  for (let d = 0; d < 7; d++) {
    const date = new Date(START + d * DAY_MS).toISOString().slice(0, 10);
    const tasks = buildDailyTasks({ accounts: [{ accountId: id, persona }], date, seed: 'reuse', pool });
    const dayUses = new Map();
    for (const it of tasks.accounts[0].items) {
      if (it.type === 'comment' || it.type === 'post') {
        if (it.contentRef) {
          content++;
          dayUses.set(it.contentRef, (dayUses.get(it.contentRef) ?? 0) + 1);
          if (dayUses.get(it.contentRef) > 1) { reused++; assert.equal(it.contentReused, true, 'silent reuse — must be flagged'); }
          else assert.notEqual(it.contentReused, true, 'first use must not claim reuse');
        } else assert.equal(it.needsContent, true);
      }
    }
  }
  console.log(`[D1b] single-row pool: ${content} attached, ${reused} in-day repeats, all flagged`);
});

test('D2 persona injection: adversarial life fields fail loud or render safe — never corrupt', async () => {
  const id = acctId('inject');
  const LONG = '哈'.repeat(100_000);
  // out-of-pool injection → loud throw (fail-closed contract, never silence)
  assert.throws(() => generateLifePlan({ accountId: id, persona: { hk: { life: { occupation: LONG } } }, days: 2, startMs: START, seed: 'i' }), /not in pool/);
  assert.throws(() => generateLifePlan({ accountId: id, persona: { hk: { life: { interests: ['🎉🎉'] } } }, days: 2, startMs: START, seed: 'i' }), /not in pool/);
  assert.throws(() => generateLifePlan({ accountId: id, persona: { hk: { life: { social: { postingCadence: '🚀' } } } }, days: 2, startMs: START, seed: 'i' }), /unknown postingCadence/);
  // adversarial SEED content (emoji/braces/very long) → deterministic, no crash
  const ok = generateLifePlan({ accountId: id, days: 2, startMs: START, seed: '🎉' });
  assert.deepEqual(ok.events.map((e) => e.epochMs), generateLifePlan({ accountId: id, days: 2, startMs: START, seed: '🎉' }).events.map((e) => e.epochMs));
  assert.throws(() => generateLifePlan({ accountId: id, days: 2, startMs: START, seed: '' }), /seed required/); // '' stays rejected (contract)
  for (const s of ['{a:{b}}', '   ', '🎉'.repeat(5000), LONG]) {
    const r1 = renderTemplate({ topic: 'travel', style: 'cantonese', seed: s });
    const r2 = renderTemplate({ topic: 'travel', style: 'cantonese', seed: s });
    assert.equal(r1.text, r2.text);          // deterministic under junk seed
    assert.ok(!/\{\w+\}/.test(r1.text));     // fully rendered
  }
  // empty/unknown topic name → loud error, no half-render
  assert.throws(() => renderTemplate({ topic: '', style: 'cantonese', seed: 's' }), /no templates/);
  // buildPrompt with hostile persona strings → still a string, no crash, no undefined
  const { buildPrompt } = await import('../../apps/worker/src/content-pipeline.js');
  const prompt = buildPrompt({ topic: 'travel', style: 'en', profile: { occupation: LONG, interests: ['🎉'.repeat(2000), ''] } });
  assert.equal(typeof prompt, 'string');
  assert.ok(!prompt.includes('undefined'));
});

test('D3 llm mode: always-throwing client → LOUD fallback, production continues (template fills)', async () => {
  const accounts = [0, 1, 2].map((i) => ({ accountId: acctId(`llmboom-${i}`) }));
  const boom = async () => { throw new Error('LLM DEAD'); };
  const res = await buildContentPool({ accounts, perAccount: 3, seed: 'boom', mode: 'llm', llmClient: boom });
  assert.equal(res.meta.llmFallback.length, 9, 'every attempt must report the fallback — never silent');
  assert.ok(res.meta.llmFallback.every((f) => f.reason.includes('LLM DEAD')));
  assert.ok(res.candidates.length > 0, 'candidate supply continues via template');
  assert.ok(res.candidates.every((c) => c.mode === 'template'));
});

test('D4 (FIX-2) hostile LLM output: control chars / zero-width / mega-length sanitized; garbage → loud fallback', async () => {
  const accounts = [{ accountId: acctId('llmhostile') }];
  const mega = '超'.repeat(50_000);
  const zeroWidth = '經\u200b驗{detail}分\u0001享，唔好撈水。';
  const blankInvisible = '\u200b\u200e\n\ufeff  ';
  const hostile = async (prompt) => {
    if (prompt.includes('health-clinic')) return mega;
    if (prompt.includes('food-restaurant')) return zeroWidth;
    if (prompt.includes('travel')) return blankInvisible;   // sanitizer eats everything
    return '正常少少注入 {cat} 測試';
  };
  const res = await buildContentPool({ accounts, perAccount: 8, seed: 'hostile', mode: 'llm', llmClient: hostile });
  for (const c of res.candidates) {
    assert.ok(c.text.length <= 320, `text must be capped, got ${c.text.length}`);
    assert.ok(!/[\u200b\u200e\ufeff\u0001]/.test(c.text), 'zero-width/control chars must be stripped');
    assert.ok(c.text.trim().length >= 4, 'no invisible-only candidate may ship');
  }
  // the all-invisible reply must surface as a loud fallback (→ template), not a whitespace candidate
  assert.ok(res.meta.llmFallback.length >= 1, 'invisible-only LLM text must be reported in llmFallback');
  assert.ok(res.meta.llmFallback.some((f) => /sanitiz|too-short|empty/i.test(f.reason)));
  console.log(`[D4] hostile LLM outputs: ${res.candidates.length} accepted (sanitized), ${res.meta.llmFallback.length} loud fallbacks`);
});
