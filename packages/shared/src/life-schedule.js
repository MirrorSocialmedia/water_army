/**
 * 行為引擎 S1 — life schedule engine (ADR-035).
 *
 * Upgrades accounts from "identity exists" to "life exists": given a persona's
 * life metadata (hk v2 `life` fields + occupation/interest derivation layer),
 * emit a REPLAYABLE, seeded, N-day behaviour plan per account:
 *
 *   { ts, type ∈ {active-window, browse, like, follow, comment, post, travel-silent}, params }
 *
 * Realism disciplines (all seeded via the repo-standard splitmix64 stream):
 *  - HK circadian rhythm: lognormal twin peaks (morning commute coffee / evening
 *    couch scroll), per-account jitter so the fleet never shares a peak minute.
 *  - weekday / weekend / public-holiday distribution (holiday table embedded
 *    2026–2027, date-table discipline — see ADR-035 決策 4).
 *  - travel pattern → silence blocks: generic trips 3–7 days silent, return
 *    day is the first active day again; shenzhen-weekly special-cased to 1–2
 *    days (a weekly crossing with 3–7d silence would mute the account all
 *    month = machine smell of its own kind). Deviation is EXPLICIT, in ADR.
 *  - account-age activity curve: new-account sprint decays to a steady floor.
 *  - cross-account statistical independence: every stream is keyed by
 *    accountId; tests assert non-degenerate spread across accounts.
 *
 * Determinism: same {persona, seed, startMs, days} → byte-equal plan.
 * Time maths is epoch-offset based (tzOffsetMinutes, default +480 HKT) — the
 * host timezone/local settings must never influence a plan.
 */
import { makeRng } from './fingerprint-profile.js';
import { actionDelay, SCHEDULE_TZ_OFFSET_MINUTES } from './account-schedule.js';

/** Closed set — anything else is a contract violation (test-pinned). */
export const LIFE_ACTION_TYPES = Object.freeze([
  'active-window', 'browse', 'like', 'follow', 'comment', 'post', 'travel-silent',
]);

/** Day-kind multipliers on activity intensity (weekend > weekday; holiday
 *  shifts rhythm later but dials engagement slightly below full weekend). */
export const KIND_MULTIPLIER = Object.freeze({ weekday: 1.0, weekend: 1.25, holiday: 1.12 });

/** Posting-cadence (persona hk.life.social.postingCadence) base weights. */
export const CADENCE_WEIGHT = Object.freeze({ lurker: 0.35, light: 0.7, regular: 1.0 });

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// HK statutory public holidays, 2026–2027 (date TABLE, not astronomical
// calendar — dates outside the covered range are REJECTED loudly, never
// silently treated as ordinary days).
// ---------------------------------------------------------------------------
export const HK_HOLIDAYS = Object.freeze({
  // 2026
  '2026-01-01': 'The first day of the year',
  '2026-02-17': 'Lunar New Year (1st day)',
  '2026-02-18': 'Lunar New Year (2nd day)',
  '2026-02-19': 'Lunar New Year (3rd day)',
  '2026-04-03': 'Good Friday',
  '2026-04-04': 'Lunar New Year (4th day)',
  '2026-04-06': 'Ching Ming Festival',
  '2026-04-07': 'Easter Monday',
  '2026-05-01': 'Labour Day',
  '2026-05-25': 'Buddha\'s Birthday',
  '2026-05-28': 'Bun Burning (Tseung Kwan O)',
  '2026-06-19': 'Dragon Boat Festival',
  '2026-07-01': 'HKSAR Establishment Day',
  '2026-09-26': 'Day after Mid-Autumn Festival',
  '2026-10-01': 'National Day',
  '2026-10-18': 'Chung Yeung Festival',
  '2026-12-25': 'Christmas Day',
  '2026-12-26': 'Boxing Day (first day after)',
  // 2027
  '2027-01-01': 'The first day of the year',
  '2027-02-06': 'Lunar New Year (1st day)',
  '2027-02-07': 'Lunar New Year (2nd day)',
  '2027-02-08': 'Lunar New Year (3rd day)',
  '2027-03-26': 'Good Friday',
  '2027-03-27': 'Good Friday (Saturday)',
  '2027-03-29': 'Easter Monday',
  '2027-04-05': 'Ching Ming Festival',
  '2027-05-01': 'Labour Day',
  '2027-05-13': 'Buddha\'s Birthday',
  '2027-06-09': 'Dragon Boat Festival',
  '2027-07-01': 'HKSAR Establishment Day',
  '2027-09-15': 'Day after Mid-Autumn Festival',
  '2027-10-01': 'National Day',
  '2027-10-13': 'Chung Yeung Festival',
  '2027-12-25': 'Christmas Day (Saturday)',
  '2027-12-27': 'Christmas Day (replacement)',
});

/** Holiday lookup for a local (offset-shifted) date string. Throws when the
 *  date lies outside the embedded table coverage (fail-closed, ADR-035). */
export function holidayFor(localDate, { strict = true } = {}) {
  if (localDate < '2026-01-01' || localDate > '2027-12-31') {
    if (strict) throw new RangeError(`holidayFor: '${localDate}' outside embedded HK holiday table (2026-01-01..2027-12-31) — extend HK_HOLIDAYS, never guess`);
    return null;
  }
  return HK_HOLIDAYS[localDate] ?? null;
}

// ---------------------------------------------------------------------------
// Persona derivation layer — occupation / interests / content affinities.
// hk v2 `life` carries travel/spending/social; occupation+interests live HERE
// (behaviour-engine semantics, rng-keyed by accountId → replayable, pool
// values only, zero PII). A persona may override via `life.occupation` /
// `life.interests` (validated against the same pools).
// ---------------------------------------------------------------------------
export const HK_OCCUPATIONS = Object.freeze([
  '医护助理', '食肆服务员', '教师', '社工', '工程师', '的士司机', '文员',
  '设计师', '护士', '物业管理', '自由职业', '网店店主', '健身教练', '会计师',
  '厨师', '地盘工程师', '汽车销售', '药剂师',
]);

export const HK_INTERESTS = Object.freeze([
  '煮嘢食', '行山跑步', '追剧', '亲子育儿', '宠物', '旅游打卡', '中医养生',
  '理财投资', '手账烘焙', '单车', '摄影', '看演唱会', '电磁新品', '羽毛球',
]);

/** topic slug → (occupation|interest keyword) → affinity weight.
 *  Unlisted keys contribute nothing; unknown persona keys are ignored. */
export const TOPIC_AFFINITY = Object.freeze({
  'health-clinic': { 医护助理: 5, 护士: 5, 药剂师: 4, 社工: 2, '中医养生': 5, 健身教练: 3, 亲子育儿: 2 },
  'food-restaurant': { 食肆服务员: 5, 厨师: 5, '煮嘢食': 5, '旅游打卡': 2, 亲子育儿: 1 },
  'family-parenting': { 教师: 4, 社工: 3, 亲子育儿: 5, 医护助理: 2, 护士: 2 },
  travel: { 汽车销售: 2, '旅游打卡': 5, 自由职业: 2, 网店店主: 2, 设计师: 1 },
  shopping: { 网店店主: 4, 设计师: 2, 文员: 2, 理财投资: 2, '电磁新品': 4 },
  leisure: { '行山跑步': 5, 健身教练: 4, 羽毛球: 4, 单车: 4, 摄影: 3, 追剧: 2, 宠物: 2 },
  'community-news': { 物业管理: 4, 文员: 3, 社工: 3, 的士司机: 3, 会计师: 2, 地盘工程师: 2 },
});

/** Every topic gets this floor weight so the pool never collapses to one tag. */
export const TOPIC_BASE_WEIGHT = 1;

/**
 * Deterministic life-profile derivation for behaviour planning. Pure; inputs
 * = accountId + (optional) persona. Output keys are stable, values pool-based.
 */
export function deriveLifeProfile(accountId, persona = null) {
  if (!accountId) throw new Error('deriveLifeProfile: accountId required');
  const rng = makeRng(`wa-life-profile|${accountId}`);
  const life = persona?.hk?.life ?? persona?.life ?? null;
  const occupation = life?.occupation ?? rng.pick(HK_OCCUPATIONS);
  if (!HK_OCCUPATIONS.includes(occupation)) throw new Error(`deriveLifeProfile: occupation '${occupation}' not in pool`);
  const override = Array.isArray(life?.interests) && life.interests.length ? [...new Set(life.interests)] : null;
  if (override) {
    for (const it of override) if (!HK_INTERESTS.includes(it)) throw new Error(`deriveLifeProfile: interest '${it}' not in pool`);
  }
  const interests = override ?? [rng.pick(HK_INTERESTS), rng.pick(HK_INTERESTS)];
  // Per-account peak-phase jitter (minutes) — the fleet must not share a peak.
  const jitter = {
    morning: Math.floor(rng.u32() % 70) - 35, // −35..+34 min
    evening: Math.floor(rng.u32() % 100) - 50, // −50..+49 min
  };
  return { accountId, occupation, interests, jitter, life };
}

/** Weighted topic pick over TOPIC_AFFINITY for a profile (seeded rng). Exported
 *  for S2 content matching — one affinity source for schedule AND pipeline. */
export function pickTopic(profile, rng, topics = Object.keys(TOPIC_AFFINITY)) {
  const weights = topics.map((t) => {
    const aff = TOPIC_AFFINITY[t];
    if (!aff) throw new Error(`pickTopic: unknown topic '${t}'`);
    let w = TOPIC_BASE_WEIGHT;
    if (aff[profile.occupation]) w += aff[profile.occupation];
    for (const it of profile.interests) if (aff[it]) w += aff[it];
    return w;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let x = (rng.u32() / 0xffffffff) * total;
  for (let i = 0; i < topics.length; i++) { x -= weights[i]; if (x <= 0) return topics[i]; }
  return topics[topics.length - 1];
}

// ---------------------------------------------------------------------------
// Plan generation
// ---------------------------------------------------------------------------

/** Travel pattern → {periodDays, span:[min,max]} silence spans (days incl.
 *  return buffer; activity resumes the day AFTER the span). 3–7d discipline
 *  for generic trips; shenzhen crossing is the documented exception
 *  (ADR-035 決策 3). */
export function travelSpec(pattern) {
  switch (pattern) {
    case 'shenzhen-weekly': return { periodDays: 7, span: [1, 2] };
    case 'tw-weekly': return { periodDays: 7, span: [4, 5] };
    case 'jp-quarterly': return { periodDays: 91, span: [5, 7] };
    case 'sea-half-year': return { periodDays: 182, span: [6, 7] };
    case 'none': return null;
    default: throw new Error(`travelSpec: unknown travelPattern '${pattern}'`);
  }
}

const localDate = (epochMs, offMin) => new Date(epochMs + offMin * 60_000).toISOString().slice(0, 10);
const localHourFloat = (epochMs, offMin) => ((((epochMs + offMin * 60_000) % DAY_MS) + DAY_MS) % DAY_MS) / 3_600_000;
const localMidnightUtc = (epochMs, offMin) => {
  const shifted = epochMs + offMin * 60_000;
  return Math.floor(shifted / DAY_MS) * DAY_MS - offMin * 60_000;
};
const localClock = (epochMs, offMin) => new Date(epochMs + offMin * 60_000).toISOString().slice(0, 19).replace('T', ' ');

function dayKind(dayStartMs, offMin) {
  const dow = new Date(dayStartMs + offMin * 60_000).getUTCDay(); // 0=Sun
  const hol = holidayFor(localDate(dayStartMs, offMin), { strict: false });
  if (hol) return { kind: 'holiday', holiday: hol };
  if (dow === 0 || dow === 6) return { kind: 'weekend', holiday: null };
  return { kind: 'weekday', holiday: null };
}

/**
 * Account-age activity envelope. New accounts sprint (a fresh account doing
 * heavy engagement reads as bot-fresh), then settle:
 *   age ≤ sprintDays → linear 1.35 → 1.0
 *   age > sprintDays → slow decay toward floor 0.75 (never below)
 */
export function ageMultiplier(ageDays, sprintDays = 14) {
  if (!(ageDays >= 0)) throw new RangeError('ageMultiplier: ageDays must be >= 0');
  if (ageDays <= sprintDays) return 1.35 - (1.35 - 1.0) * (ageDays / sprintDays);
  return Math.max(0.75, 1.0 - 0.002 * (ageDays - sprintDays));
}

/** Probabilistic rounding of fractional counts (seeded — no Math.random). */
function roundSeeded(x, rng) {
  const floor = Math.floor(x);
  return floor + (rng.u32() / 0xffffffff < x - floor ? 1 : 0);
}

/**
 * Build the N-day behaviour plan for ONE account.
 * @param {object} p
 *  - accountId (required, keys every rng stream)
 *  - persona  (optional; hk v2 persona object — life/social/travel read from here)
 *  - days     (1..90, default 7)
 *  - startMs  (epoch ms of horizon start, default now())
 *  - seed     (required; mixed into every stream alongside accountId)
 *  - accountAgeDays (default 30 — days since account creation)
 *  - tzOffsetMinutes (default +480 HKT)
 *  - contentTopics (default = TOPIC_AFFINITY keys; S2 may narrow the pool)
 * @returns {{accountId, seed, events, days, meta}}
 *  events: {index, ts (ISO), epochMs, local, type, params} sorted by ts.
 */
export function generateLifePlan(opts = {}) {
  const {
    accountId, persona = null, days = 7, startMs = Date.now(), seed,
    accountAgeDays = 30,
    tzOffsetMinutes = SCHEDULE_TZ_OFFSET_MINUTES,
    contentTopics = Object.keys(TOPIC_AFFINITY),
  } = opts;
  if (!accountId) throw new Error('generateLifePlan: accountId required');
  if (seed === undefined || seed === null || seed === '') throw new Error('generateLifePlan: seed required (determinism discipline)');
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new RangeError('generateLifePlan: days must be an integer 1..90');
  if (!Array.isArray(contentTopics) || !contentTopics.length) throw new Error('generateLifePlan: contentTopics must be a non-empty array');

  const profile = deriveLifeProfile(accountId, persona);
  const relaxed = [];
  const travelPattern = profile.life?.travelPattern ?? 'none';
  const cadence = profile.life?.social?.postingCadence ?? 'light';
  const langMix = profile.life?.social?.languageMix ?? 'zh-Hant-dominant';
  if (!(cadence in CADENCE_WEIGHT)) throw new Error(`generateLifePlan: unknown postingCadence '${cadence}'`);
  const spec = travelSpec(travelPattern);
  const start0 = localMidnightUtc(startMs, tzOffsetMinutes);

  // --- travel windows (day indices [fromDay, toDayExclusive) of silence) ----
  // One deterministic trip start per period; a trip whose silence would reach
  // past the horizon simply mutes the remaining days (no partial-credit lie).
  const travelWindows = [];
  if (spec) {
    const trng = makeRng(`wa-life-travel|${accountId}|${seed}|${travelPattern}`);
    for (let p = 0; p * spec.periodDays < days + spec.periodDays; p++) {
      const startOffset = Math.floor((trng.u32() / 0xffffffff) * spec.periodDays);
      const from = p * spec.periodDays + startOffset;
      if (from >= days) break;
      const span = spec.span[0] + Math.floor(trng.u32() % (spec.span[1] - spec.span[0] + 1));
      // trip whose silence would not complete inside the horizon → it departs
      // after the visible window; don't emit a truncated (spec-breaking) span
      if (from + span > days) continue;
      const to = from + span;
      // skip trips nested inside an existing window (e.g. weekly pattern while
      // already mid-trip — physically impossible, don't double-count silence)
      if (travelWindows.some((w) => from >= w.from && from < w.to)) continue;
      travelWindows.push({ from, to });
    }
  }
  const mergedWindows = [];
  for (const w of travelWindows.sort((a, b) => a.from - b.from)) {
    const last = mergedWindows[mergedWindows.length - 1];
    if (last && w.from < last.to) last.to = Math.max(last.to, w.to); // strict overlap only — adjacent windows are distinct trips
    else mergedWindows.push({ ...w });
  }
  const isSilent = (d) => mergedWindows.find((w) => d >= w.from && d < w.to) ?? null;

  const events = [];
  const daySummaries = [];

  const lognormalHour = (rng, peakHour, sigma, minH, maxH) => {
    // RESAMPLE (not clamp) outside the band — clamping piles probability mass
    // on one exact instant, which the fleet would then share (timestamp
    // collisions across accounts = machine rhythm of its own).
    for (let tries = 0; tries < 12; tries++) {
      const u1 = Math.max(1 / 0xffffffff, rng.u32() / 0xffffffff);
      const u2 = rng.u32() / 0xffffffff;
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const h = peakHour * Math.exp(sigma * z);
      if (h >= minH && h <= maxH) return h;
    }
    const u = Math.max(1 / 0xffffffff, rng.u32() / 0xffffffff);
    return minH + u * (maxH - minH); // last resort: uniform inside the band
  };

  for (let d = 0; d < days; d++) {
    const dayStart = start0 + d * DAY_MS;
    const dayRng = makeRng(`wa-life-day|${accountId}|${seed}|${d}`);
    const dk = dayKind(dayStart, tzOffsetMinutes);
    const silentWin = isSilent(d);
    if (silentWin) {
      if (silentWin.from === d) {
        const departureHour = lognormalHour(dayRng, 8.5, 0.18, 6.5, 11.5);
        const depMs = Math.round(dayStart + departureHour * 3_600_000);
        events.push({ epochMs: depMs, type: 'travel-silent', params: {
          pattern: travelPattern,
          until: new Date(start0 + silentWin.to * DAY_MS).toISOString(),
          silentDays: silentWin.to - silentWin.from,
        } });
      }
      daySummaries.push({ day: localDate(dayStart, tzOffsetMinutes), kind: dk.kind, holiday: dk.holiday, silent: true, counts: {} });
      continue;
    }

    // holiday/weekend rhythm shift: peaks move later.
    const shift = dk.kind === 'weekday' ? 0 : dk.kind === 'weekend' ? 0.9 : 1.1;
    const mPeak = 8.1 + shift + profile.jitter.morning / 60;
    const ePeak = 20.2 + shift * 0.6 + profile.jitter.evening / 60;

    // Active windows: lognormal morning + evening peaks; weekend/holiday adds
    // an afternoon window. Each window is an event so the executor knows when
    // the account is plausibly holding the phone.
    const windows = [];
    const nWin = dk.kind === 'weekday' ? 2 : (dayRng.u32() % 4 === 0 ? 3 : 2);
    windows.push({ h: lognormalHour(dayRng, mPeak, 0.16, 6.3, 11.9), label: 'morning' });
    windows.push({ h: lognormalHour(dayRng, ePeak, 0.14, 17.5, 23.4), label: 'evening' });
    if (nWin === 3) windows.push({ h: lognormalHour(dayRng, 14.5, 0.15, 12.5, 17.0), label: 'afternoon' });
    const winStarts = [];
    for (const w of windows) {
      const ms = Math.round(dayStart + w.h * 3_600_000);
      winStarts.push(ms);
      events.push({ epochMs: ms, type: 'active-window', params: { peak: w.label, dayKind: dk.kind, holiday: dk.holiday, durationMin: 25 + Math.floor(dayRng.u32() % 150) } });
    }

    // Intensity = kind × cadence × age curve.
    const intensity = KIND_MULTIPLIER[dk.kind] * CADENCE_WEIGHT[cadence] * ageMultiplier(accountAgeDays);
    // Post cap by cadence (lurkers never post).
    const postCap = cadence === 'lurker' ? 0 : cadence === 'light' ? 2 : 4;
    const plan = [
      ['browse', roundSeeded((3 + dayRng.u32() % 4) * intensity, dayRng)],
      ['like', roundSeeded((1.5 + dayRng.u32() % 3) * intensity, dayRng)],
      ['follow', dayRng.u32() % 100 < Math.round(38 * intensity) ? 1 + (dayRng.u32() % 2) : 0],
      ['comment', roundSeeded(0.9 * intensity + (dayRng.u32() % 2), dayRng)],
      ['post', Math.min(postCap, roundSeeded((cadence === 'regular' ? 0.8 : 0.35) * intensity, dayRng))],
    ];

    const counts = {};
    for (const [type, n] of plan) {
      counts[type] = n;
      for (let i = 0; i < n; i++) {
        // Anchor inside a random active window, offset by a seeded lognormal
        // delay from window start (reuses the 段4 scheduler delay helper).
        const win = winStarts[dayRng.u32() % winStarts.length];
        let offset = actionDelay({ seed: `${accountId}|${seed}|${d}|${type}|${i}`, mu: Math.log(7 * 60_000), sigma: 0.8, minMs: 40_000, maxMs: 55 * 60_000 });
        // never spill past local midnight — snap inside the day (deterministic)
        const dayEnd = dayStart + DAY_MS - 5 * 60_000;
        let at = win + offset;
        if (at > dayEnd) at = dayEnd - (offset % (40 * 60_000));
        const params = {};
        if (type === 'comment' || type === 'post') {
          params.topic = pickTopic(profile, dayRng, contentTopics);
          params.style = pickStyle(langMix, dayRng);
        }
        events.push({ epochMs: at, type, params });
      }
    }
    daySummaries.push({ day: localDate(dayStart, tzOffsetMinutes), kind: dk.kind, holiday: dk.holiday, silent: false, counts, intensity: Number(intensity.toFixed(3)) });
  }

  events.sort((a, b) => a.epochMs - b.epochMs);
  const shaped = events.map((e, index) => ({
    index,
    ts: new Date(e.epochMs).toISOString(),
    epochMs: e.epochMs,
    local: localClock(e.epochMs, tzOffsetMinutes),
    type: e.type,
    params: e.params ?? {},
  }));
  for (const e of shaped) if (!LIFE_ACTION_TYPES.includes(e.type)) throw new Error(`generateLifePlan: internal type '${e.type}' outside closed set`);

  return {
    accountId,
    seed: String(seed),
    events: shaped,
    days: daySummaries,
    meta: {
      travelPattern, cadence, langMix,
      occupation: profile.occupation, interests: profile.interests,
      accountAgeDays, tzOffsetMinutes,
      travelWindows: mergedWindows.map((w) => ({
        from: new Date(start0 + w.from * DAY_MS).toISOString(),
        until: new Date(start0 + w.to * DAY_MS).toISOString(),
        silentDays: w.to - w.from,
      })),
      relaxed,
    },
  };
}

/** Language-style picker shared with S2 (persona languageMix → style mix).
 *  Styles: 'written' (港式書面語) | 'cantonese' (粵語口語) | 'en'. */
export const CONTENT_STYLES = Object.freeze(['written', 'cantonese', 'en']);
const STYLE_MIX = Object.freeze({
  'zh-Hant-dominant': [0.4, 0.5, 0.1],
  bilingual: [0.3, 0.4, 0.3],
  'en-dominant': [0.1, 0.2, 0.7],
});
export function pickStyle(langMix, rng) {
  const mix = STYLE_MIX[langMix];
  if (!mix) throw new Error(`pickStyle: unknown languageMix '${langMix}'`);
  let x = (rng.u32() / 0xffffffff); const total = mix.reduce((a, b) => a + b, 0);
  x *= total;
  for (let i = 0; i < CONTENT_STYLES.length; i++) { x -= mix[i]; if (x <= 0) return CONTENT_STYLES[i]; }
  return CONTENT_STYLES[CONTENT_STYLES.length - 1];
}