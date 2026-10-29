/**
 * WA-WARMING (S2) — warming-session plan: task templates + deterministic
 * daily schedule ("每日 1–2 短 session、隨機時間窗").
 *
 * Design notes:
 * - DETERMINISM FIRST (WA-IPGROUP lineage): every random choice derives from
 *   fnv1a32(identityId|date) via mulberry32 — replicas and restarts produce
 *   the SAME plan for the same day, so the idempotency keys below are exact
 *   and a restarted worker cannot double-book a warming session.
 * - One warming session = one single-identity cycle batch with
 *   config.purpose === 'warming' (the s1 gate contract: purpose is the
 *   business-vs-養號 discriminator) + config.warmingTemplate + the mock
 *   step script the driver replays. Egress serialization / stagger from
 *   WA-IPGROUP applies unchanged — warming runs share the identity's egress
 *   group, so 養號 and business runs on one exit IP stay mutually exclusive.
 * - Random WINDOW (default HK 09:00–21:00, sessions clamped inside, never
 *   overlapping): real accounts do not browse at 03:07 sharp on the dot
 *   every day; the per-day seed gives exactly that texture.
 * - The scheduler is ENV-GATED OFF (WA_WARMING_SCHEDULE_ENABLED) — real-
 *   device behaviour ships with WA-ADVERSARIAL-FINAL (NOT VERIFIED here).
 * - Mock steps only (工單: 「真機行為併 final 單」). The step shapes mirror
 *   what the daily-driver adapter will replay; unknown template = fail-safe
 *   to 'browse' (a warming run on the wrong template is harmless, a crash
 *   loop is not).
 */
import { fnv1a32 } from './egress-group.js';
import { BATCH_PURPOSE } from './warm-state.js';

/** AppSetting key — shape { value: { sessions_min, sessions_max, window_start_hour, window_end_hour } } (HK wall-clock hours). */
export const APP_SETTING_WARM_SCHEDULE = 'warm.schedule';

export const WARMING_SCHEDULE_DEFAULTS = Object.freeze({
  sessionsMin: 1,
  sessionsMax: 2,
  windowStartHour: 9, // HK wall clock
  windowEndHour: 21,
});
/** Session length pool (minutes) — "短 session": nothing here looks like a marathon bot. */
export const WARMING_SESSION_MINUTES = Object.freeze({ min: 6, max: 15 });
/** A due session may still be dispatched this long after its window start (catch-up on a restarted worker); beyond that it is honestly missed. */
export const WARMING_CATCHUP_GRACE_MS = 90 * 60_000;
/** HK = UTC+8 year-round (no DST) — the window math stays whole-hour arithmetic. */
const HK_OFFSET_MS = 8 * 3_600_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Warming templates — mock step scripts (搜尋 / 睇片 / 瀏覽). Each step:
 * { action, note } with human-readable intent; timing hints ride on the step
 * so the future driver never needs to invent behaviour (真機併 final 單).
 */
export const WARMING_TEMPLATES = Object.freeze({
  search: Object.freeze({
    label: '搜尋瀏覽',
    steps: Object.freeze([
      Object.freeze({ action: 'launch_app', note: '冷啟動 App，等人機互動延遲' }),
      Object.freeze({ action: 'idle_random', minMs: 4000, maxMs: 15000, note: '開場滑動 feed（隨機）' }),
      Object.freeze({ action: 'open_search', note: '進入搜尋框' }),
      Object.freeze({ action: 'type_query', from: 'QUERY_POOL', note: '輸入關鍵字（每日 seeded，非固定腳本句）' }),
      Object.freeze({ action: 'scroll_results', seconds: [8, 30], note: '慢慢睇結果頁' }),
      Object.freeze({ action: 'open_result', dwellSeconds: [20, 90], note: '点开一條結果，睇實文' }),
      Object.freeze({ action: 'back_to_results', note: '返回，再隨機掃兩眼' }),
      Object.freeze({ action: 'idle_random', minMs: 5000, maxMs: 20000, note: '收尾閒逛' }),
      Object.freeze({ action: 'exit_app', note: '退出（唔好每次都殺進程）' }),
    ]),
  }),
  video: Object.freeze({
    label: '睇片',
    steps: Object.freeze([
      Object.freeze({ action: 'launch_app', note: '冷啟動' }),
      Object.freeze({ action: 'open_feed', note: '入短片/推薦 feed' }),
      Object.freeze({ action: 'watch_video', seconds: [25, 120], note: '睇完整或大半條片' }),
      Object.freeze({ action: 'maybe_like', probability: 0.3, note: '随机点赞（seeded，唔好條條都赞）' }),
      Object.freeze({ action: 'watch_video', seconds: [15, 90], note: '第二條' }),
      Object.freeze({ action: 'scroll_feed', seconds: [5, 20], note: '掃 feed' }),
      Object.freeze({ action: 'idle_random', minMs: 3000, maxMs: 12000, note: '自然收尾' }),
      Object.freeze({ action: 'exit_app', note: '退出' }),
    ]),
  }),
  browse: Object.freeze({
    label: '瀏覽瀏覽',
    steps: Object.freeze([
      Object.freeze({ action: 'launch_app', note: '冷啟動' }),
      Object.freeze({ action: 'scroll_home', seconds: [10, 40], note: '首页/動態慢慢睇' }),
      Object.freeze({ action: 'open_post', dwellSeconds: [15, 60], note: '睇一篇 post' }),
      Object.freeze({ action: 'maybe_comment_view', probability: 0.4, note: '睇下留言（唔必發言）' }),
      Object.freeze({ action: 'open_profile', dwellSeconds: [10, 40], note: '睇人 page（模擬真人興趣）' }),
      Object.freeze({ action: 'idle_random', minMs: 4000, maxMs: 15000, note: '自然收尾' }),
      Object.freeze({ action: 'exit_app', note: '退出' }),
    ]),
  }),
});
export const WARMING_TEMPLATE_NAMES = Object.freeze(Object.keys(WARMING_TEMPLATES));
export const WARMING_TEMPLATE_FALLBACK = 'browse';

/** Query seeds for type_query — picked deterministically per session (a bot that searches the same sentence daily is a bot). */
export const WARMING_QUERY_POOL = Object.freeze([
  '週末 好去處', 'pet friendly café', 'cat cafe HK', '行山路線 入門',
  '食譜 快手 晚餐', 'night market HK', 'cat meme', 'dim sum recipe',
  'travel deals jp', '街貓 日記',
]);

/** mulberry32 — tiny deterministic PRNG; one draw chain per (identity, date). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function intIn(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * Fail-safe schedule knob (readEgressGroupJitter discipline): each field is
 * validated independently; bad fields fall back to their default. sessions
 * min>max is an honest admin typo → swap + flag (never disable staggering).
 * @returns {{sessionsMin:number,sessionsMax:number,windowStartHour:number,windowEndHour:number,source:'default'|'appsetting'}}
 */
export async function readWarmingSchedule(db, { log } = {}) {
  try {
    const row = await db.appSetting.findUnique({ where: { key: APP_SETTING_WARM_SCHEDULE } });
    const v = row?.valueJson?.value;
    if (!v || typeof v !== 'object') return { ...WARMING_SCHEDULE_DEFAULTS, source: 'default' };
    const d = WARMING_SCHEDULE_DEFAULTS;
    const hourOk = (x) => Number.isInteger(x) && x >= 0 && x <= 23;
    const sessOk = (x) => Number.isInteger(x) && x >= 0 && x <= 12;
    let { sessionsMin, sessionsMax, windowStartHour, windowEndHour } = d;
    let touched = false;
    if (sessOk(v.sessions_min)) { sessionsMin = v.sessions_min; touched = true; }
    if (sessOk(v.sessions_max)) { sessionsMax = v.sessions_max; touched = true; }
    if (hourOk(v.window_start_hour)) { windowStartHour = v.window_start_hour; touched = true; }
    if (hourOk(v.window_end_hour)) { windowEndHour = v.window_end_hour; touched = true; }
    if (!touched) return { ...d, source: 'default' };
    if (sessionsMin > sessionsMax) {
      log?.warn?.({ sessionsMin, sessionsMax }, 'warm schedule AppSetting sessions min>max — swapped');
      [sessionsMin, sessionsMax] = [sessionsMax, sessionsMin];
    }
    if (windowStartHour >= windowEndHour) {
      // A zero/negative window would starve the plan — honest warn, clamp one hour at start.
      log?.warn?.({ windowStartHour, windowEndHour }, 'warm schedule AppSetting window start>=end — clamped end to start+1');
      windowEndHour = Math.min(23, windowStartHour + 1);
    }
    return { sessionsMin, sessionsMax, windowStartHour, windowEndHour, source: 'appsetting' };
  } catch {
    return { ...WARMING_SCHEDULE_DEFAULTS, source: 'default' };
  }
}

/**
 * HK date string ('YYYY-MM-DD') for an instant — the plan DAY unit follows
 * HK wall clock (the accounts live in HK time).
 */
export function hkDateString(now = new Date()) {
  return new Date(now.getTime() + HK_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Idempotency key for one warming session — matches the cycle contract
 * ^[A-Za-z0-9_-]{8,64}$ (cuid identity ids keep it well under 64).
 */
export function warmingIdempotencyKey(identityId, date, sessionIndex) {
  return `warm-${identityId}-${date.replace(/-/g, '')}-${sessionIndex}`;
}

/**
 * Deterministic day plan for ONE identity.
 * @param {object} p
 * @param {string} p.identityId
 * @param {string} p.date 'YYYY-MM-DD' (HK day)
 * @param {object} [p.schedule] readWarmingSchedule() output
 * @param {Date}   [p.now]
 * @param {string} [p.template] force one template (else seeded pick per session)
 * @returns {{identityId:string,date:string,sessions:Array<object>}}
 */
export function planWarmingDay({ identityId, date, schedule = WARMING_SCHEDULE_DEFAULTS, now = new Date(), template = null }) {
  if (typeof identityId !== 'string' || !identityId) throw new Error('planWarmingDay: identityId required');
  if (!DATE_RE.test(String(date))) throw new Error(`planWarmingDay: date must be YYYY-MM-DD, got ${date}`);
  const s = { ...WARMING_SCHEDULE_DEFAULTS, ...(schedule ?? {}) };
  // The seed excludes `now`: the PLAN is a pure function of (identity, date).
  // Re-running the tick later in the day must NOT re-derive different session
  // windows (that would double-book sessions whose keys already dispatched).
  const rng = mulberry32(fnv1a32(`warm|${identityId}|${date}`));
  const count = intIn(rng, Math.max(0, s.sessionsMin), Math.max(s.sessionsMin, s.sessionsMax));
  const [y, m, d] = date.split('-').map(Number);
  const windowOpenMin = s.windowStartHour * 60;
  const windowCloseMin = s.windowEndHour * 60; // exclusive
  const raw = [];
  for (let i = 0; i < count; i += 1) {
    const duration = intIn(rng, WARMING_SESSION_MINUTES.min, WARMING_SESSION_MINUTES.max);
    const latestStart = windowCloseMin - duration;
    const startMin = latestStart > windowOpenMin
      ? intIn(rng, windowOpenMin, latestStart)
      : windowOpenMin;
    raw.push({ startMin, duration });
  }
  raw.sort((a, b) => a.startMin - b.startMin);
  // no-overlap pass: shift a colliding session to prev end + small gap,
  // clamped to the window (deterministic — same seed, same shift).
  let prevEnd = -1;
  const sessions = [];
  for (const { startMin, duration } of raw) {
    let start = startMin;
    if (start < prevEnd) start = Math.min(prevEnd + intIn(rng, 10, 45), Math.max(windowOpenMin, windowCloseMin - duration));
    if (start <= prevEnd) continue; // window genuinely full — honest drop, never overlap
    prevEnd = start + duration;
    const tpl = template && WARMING_TEMPLATES[template] ? template : WARMING_TEMPLATE_NAMES[Math.floor(rng() * WARMING_TEMPLATE_NAMES.length)] ?? WARMING_TEMPLATE_FALLBACK;
    const startAt = new Date(Date.UTC(y, m - 1, d, 0, startMin) - HK_OFFSET_MS);
    const idx = sessions.length + 1;
    const templateDef = WARMING_TEMPLATES[tpl] ?? WARMING_TEMPLATES[WARMING_TEMPLATE_FALLBACK];
    const query = WARMING_QUERY_POOL[Math.floor(rng() * WARMING_QUERY_POOL.length)];
    const status = startAt.getTime() > now.getTime()
      ? 'future'
      : startAt.getTime() + WARMING_CATCHUP_GRACE_MS <= now.getTime()
        ? 'missed'
        : 'due';
    sessions.push({
      index: idx,
      template: tpl,
      templateLabel: templateDef.label,
      query,
      startAt: startAt.toISOString(),
      durationMinutes: duration,
      idempotencyKey: warmingIdempotencyKey(identityId, date, idx),
      status,
      // mock step script the (future) driver replays verbatim — the step with
      // a QUERY_POOL placeholder resolves to the seeded query.
      steps: templateDef.steps.map((st) => (st.from === 'QUERY_POOL' ? { ...st, query } : st)),
    });
  }
  return { identityId, date, sessions };
}

/**
 * Cycle-batch spec for one warming session — the input of
 * batchService.createCycle (single identity; the s1 purpose contract stamps
 * it past the business gate).
 */
export function warmingBatchSpec({ identityId, session, name = null }) {
  return {
    name: (name ?? `warm ${identityId.slice(-6)} ${session.template} ${session.startAt.slice(0, 16)}`).slice(0, 128),
    idempotencyKey: session.idempotencyKey,
    identities: [{ id: identityId, status: 'READY' }],
    batchSize: 1,
    maxActiveContainers: 1,
    failurePolicy: 'continue_and_report',
    config: {
      purpose: BATCH_PURPOSE.WARMING,
      warmingTemplate: session.template,
      warmingQuery: session.query,
      warmingSessionIndex: session.index,
      warmingPlannedStartAt: session.startAt,
      source: 'wa-warming-scheduler',
      steps: session.steps,
    },
  };
}

/**
 * The worker-side scheduler (env-gated OFF by the caller — worker.js).
 * tick() never lets one poisoned account stop the farm: per-identity errors
 * are collected, the loop continues.
 *
 * @param {object} w
 * @param {object} w.db                 prisma-shaped client
 * @param {object} w.batchService       createBatchService() instance (createCycle)
 * @param {object} [w.warmStateService] createWarmStateService() — when given,
 *   matured identities are promoted (lazily) BEFORE planning, so a finished
 *   account never gets a fresh warming session
 * @param {()=>Date} [w.now]
 * @param {object} [w.log]
 */
export function createWarmingScheduler({ db, batchService, warmStateService = null, now = () => new Date(), log = console }) {
  async function tick({ date = hkDateString(now()) } = {}) {
    const schedule = await readWarmingSchedule(db, { log });
    const rows = await db.identity.findMany({ where: { warmState: 'warming' } });
    const summary = { date, considered: rows.length, promoted: 0, dispatched: [], replayed: [], future: 0, missed: 0, errors: [] };
    for (const row of rows) {
      try {
        // Lazy promotion first: yesterday-matured accounts exit the pool now.
        if (warmStateService) {
          const p = await warmStateService.promoteIfReady(row, { now: now() });
          if (p?.effectiveState === 'warm') {
            summary.promoted += 1;
            continue;
          }
        }
        const plan = planWarmingDay({ identityId: row.id, date, schedule, now: now() });
        for (const session of plan.sessions) {
          if (session.status === 'future') { summary.future += 1; continue; }
          if (session.status === 'missed') { summary.missed += 1; continue; }
          const res = await batchService.createCycle(warmingBatchSpec({ identityId: row.id, session }), { id: null, username: 'system' });
          if (res?.replay) summary.replayed.push(session.idempotencyKey);
          else summary.dispatched.push(session.idempotencyKey);
        }
      } catch (err) {
        // BatchError (gate/validation) or DB hiccup — log, keep going.
        summary.errors.push({ identityId: row.id, code: err?.apiCode ?? err?.code ?? 'WARM_TICK_ERROR', message: err?.message?.slice(0, 200) });
      }
    }
    if (summary.dispatched.length || summary.promoted) {
      log.info?.({ date, dispatched: summary.dispatched.length, promoted: summary.promoted, replayed: summary.replayed.length }, 'warming scheduler: pass');
    }
    return summary;
  }

  let timer = null;
  function start({ intervalMs = 5 * 60_000 } = {}) {
    if (timer) return;
    const run = async () => {
      try { await tick(); } catch (err) {
        log.error?.({ error: err.message }, 'warming scheduler: tick failed (next pass retries)');
      }
    };
    void run();
    timer = setInterval(() => void run(), intervalMs);
    timer.unref?.();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }
  return { tick, start, stop };
}
