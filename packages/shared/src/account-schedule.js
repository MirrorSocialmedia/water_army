/**
 * GAcct 段4 — randomised registration scheduler (fleet realism, ADR-034 §7).
 *
 * Registers must NOT arrive in a metronome pattern: N registration events are
 * scattered across a time window with (a) a configurable MINIMUM gap, (b)
 * optional weighting that avoids the 00:00–07:00 dead-of-night hours in the
 * fleet timezone (+08:00 default, Asia/Hong_Kong), and (c) full seed
 * determinism — the same {seed, count, window, start} replays byte-equal, so
 * a plan can be reviewed before execution and audited after.
 *
 * Determinism uses the repo-standard splitmix64 stream (makeRng). The
 * `actionDelay` helper (lognormal via Box–Muller, seeded) is for future
 * human-likeness actions ("comment on that post ~47 min later").
 *
 * Fail-closed inputs; relaxation of constraints is NEVER silent — it is
 * reported in `meta.relaxed` (an operator must see when realism gave way to
 * arithmetic).
 */
import { makeRng } from './fingerprint-profile.js';

/** Fleet wall-clock offset (minutes ahead of UTC) — Asia/Hong_Kong. */
export const SCHEDULE_TZ_OFFSET_MINUTES = 480;
/** Night band (local hours) avoided by default: [0, 7). */
export const NIGHT_HOURS = Object.freeze([0, 7]);
export const DEFAULT_MIN_GAP_MINUTES = 15;

/** Parse '24h' | '90m' | '3600s' | '1d' | plain seconds → seconds. */
export function parseWindow(input) {
  if (typeof input === 'number' && Number.isFinite(input) && input > 0) return input;
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d)?$/.exec(String(input).trim());
  if (!m) throw new Error(`parseWindow: unsupported window '${input}' (use e.g. 24h/90m/3600s)`);
  const n = Number(m[1]);
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2] ?? 's'];
  if (!(n > 0)) throw new Error('parseWindow: window must be > 0');
  return n * mult;
}

function localMinutesOfDay(epochMs, tzOffsetMinutes) {
  return Math.floor(((epochMs + tzOffsetMinutes * 60_000) % 86400_000) / 60_000);
}

/**
 * Plan `count` registration events inside [start, start+window).
 * @param {object} opts
 *  - count (1..2000), window ('24h'|seconds), seed (string|number)
 *  - start (epoch ms, default now()), minGapMinutes (default 15; 0 = none)
 *  - avoidNight (default true — reject local hour ∈ [0,7))
 *  - tzOffsetMinutes (default +480 HKT)
 * @returns {{events: Array<{index:number, at:string, epochMs:number}>, meta: object}}
 */
export function planRegistrationSchedule(opts = {}) {
  const {
    count, window = '24h', seed, start = Date.now(),
    minGapMinutes = DEFAULT_MIN_GAP_MINUTES,
    avoidNight = true,
    tzOffsetMinutes = SCHEDULE_TZ_OFFSET_MINUTES,
  } = opts;
  if (!Number.isInteger(count) || count < 1 || count > 2000) throw new RangeError('planRegistrationSchedule: count must be an integer 1..2000');
  if (seed === undefined || seed === null || seed === '') throw new Error('planRegistrationSchedule: seed required (determinism discipline)');
  const windowSec = parseWindow(window);
  if (!(minGapMinutes >= 0)) throw new RangeError('planRegistrationSchedule: minGapMinutes must be >= 0');
  const rng = makeRng(`wa-acct-sched|${seed}|${count}|${windowSec}|${Math.floor(start)}|${minGapMinutes}|${avoidNight ? 'day' : 'free'}|${tzOffsetMinutes}`);

  const windowMs = windowSec * 1000;
  const minGapMs = minGapMinutes * 60_000;
  const relaxed = [];
  let dropNight = avoidNight;
  let gapMs = minGapMs;
  const accepted = []; // epoch ms, kept sorted

  const tryOnce = (hard) => {
    for (let i = 0; i < 400; i++) {
      const t = start + Math.floor(rng.u32() / 0xffffffff * windowMs);
      if (dropNight) {
        const h = Math.floor(localMinutesOfDay(t, tzOffsetMinutes) / 60);
        if (h >= NIGHT_HOURS[0] && h < NIGHT_HOURS[1]) continue;
      }
      if (gapMs > 0) {
        // binary-ish gap check (linear is fine at fleet scale ≤2000)
        let ok = true;
        for (const a of accepted) { if (Math.abs(a - t) < gapMs) { ok = false; break; } }
        if (!ok) continue;
      }
      accepted.push(t);
      return true;
    }
    if (hard) return false;
    // graded relaxation — NEVER silent
    if (dropNight) { dropNight = false; relaxed.push('avoidNight dropped (window/starved sampling could not satisfy it)'); return true; }
    if (gapMs > 0 && minGapMs > 0) {
      gapMs = Math.floor(gapMs / 2);
      relaxed.push(`minGap halved to ${Math.round(gapMs / 60000)}min (sampling starved)`);
      return true;
    }
    return false;
  };

  for (let n = 0; n < count;) {
    const hard = n === count - 1; // last event: single decisive pass before failure
    if (!tryOnce(hard)) {
      // final resort: gap-free, night-free-as-possible single slot
      const t = start + Math.floor(rng.u32() / 0xffffffff * windowMs);
      if (dropNight) {
        const h = Math.floor(localMinutesOfDay(t, tzOffsetMinutes) / 60);
        if (h >= NIGHT_HOURS[0] && h < NIGHT_HOURS[1] && tryOnce(true)) continue;
      }
      accepted.push(t);
      relaxed.push(`minGap violated for event ${n} (window capacity)`);
    }
    n = accepted.length;
  }
  accepted.sort((a, b) => a - b);
  const events = accepted.map((epochMs, index) => ({ index, at: new Date(epochMs).toISOString(), epochMs }));
  return {
    events,
    meta: {
      count: events.length, windowSec, seed: String(seed),
      start: new Date(start).toISOString(),
      minGapMinutes, effectiveMinGapMs: gapMs,
      avoidNight, nightDropped: !dropNight && avoidNight,
      tzOffsetMinutes, relaxed,
    },
  };
}

/**
 * Lognormal action delay (future human-likeness actions). z via Box–Muller
 * from the seeded stream; clamped to [minMs, maxMs]. Deterministic per seed.
 * @returns {number} delay in ms
 */
export function actionDelay({ seed, mu = Math.log(90_000), sigma = 0.7, minMs = 30_000, maxMs = 6 * 3600_000 } = {}) {
  if (seed === undefined || seed === null || seed === '') throw new Error('actionDelay: seed required');
  const rng = makeRng(`wa-acct-delay|${seed}`);
  const u1 = Math.max(1 / 0xffffffff, rng.u32() / 0xffffffff);
  const u2 = rng.u32() / 0xffffffff;
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const raw = Math.exp(mu + sigma * z);
  return Math.round(Math.min(maxMs, Math.max(minMs, raw)));
}
