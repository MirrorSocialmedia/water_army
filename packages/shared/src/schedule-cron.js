/**
 * Schedule cron/timezone utilities (施工 MD §12.2: 時區與 Cron).
 *
 * Uses the SAME `cron-parser` library BullMQ uses internally for
 * `upsertJobScheduler({ pattern, tz })` — so the next-run preview computed
 * here and the actual BullMQ fire time are semantically identical (DST
 * included: MD §12.2 「DST 相關行為要依指定時區與排程函式庫定義」).
 *
 * Zero own dependencies (cron-parser ships with bullmq and is resolvable from
 * this package — verified at P4 step 0).
 */
import { CronExpressionParser } from 'cron-parser';

/** IANA timezone check via Intl (no deps; Node 24 full ICU). */
export function isIanaTimezone(tz) {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a 5-field cron expression (BullMQ/cron-parser semantics:
 * `minute hour day-of-month month day-of-week`).
 * @returns {{ok:boolean, error?:string}}
 */
export function validateCronExpression(expression) {
  if (typeof expression !== 'string' || expression.trim().length === 0) {
    return { ok: false, error: 'cronExpression is required (5-field cron)' };
  }
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { ok: false, error: `cronExpression must have 5 fields (minute hour dom month dow), got ${fields.length}` };
  }
  try {
    // Parsing against a fixed date only validates the expression grammar.
    CronExpressionParser.parse(expression.trim(), { currentDate: new Date('2026-01-01T00:00:00Z') });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `invalid cronExpression: ${err.message}` };
  }
}

/**
 * Next run strictly after `after`, in the schedule's own IANA timezone.
 * @param {string} expression valid 5-field cron
 * @param {string} tz IANA timezone (e.g. 'Asia/Taipei')
 * @param {Date} [after]
 * @returns {Date|null} null when the expression never matches (e.g. Feb 30)
 */
export function nextCronRun(expression, tz, after = new Date()) {
  const interval = CronExpressionParser.parse(expression, {
    tz: isIanaTimezone(tz) ? tz : 'UTC',
    currentDate: after,
  });
  const next = interval.next();
  return next ? next : null;
}

/**
 * Human-readable cron description (MD §6.6: Cron 人可讀描述). Covers the
 * common ops patterns; anything exotic falls back to the raw expression.
 * NOT a full cron translator — the raw expression is always shown alongside.
 */
export function describeCron(expression) {
  if (typeof expression !== 'string') return null;
  const f = expression.trim().split(/\s+/);
  if (f.length !== 5) return expression;
  const [min, hour, dom, mon, dow] = f;
  const star = (s) => s === '*';
  const every = (s) => /^\/\d+$/.test(s) ? Number(s.slice(1)) : null;
  const num = (s) => (/^\d+$/.test(s) ? Number(s) : null);

  // */N * * * *
  if (every(min) !== null && star(hour) && star(dom) && star(mon) && star(dow)) {
    return `every ${every(min)} minute(s)`;
  }
  // N * * * *
  const m = num(min);
  if (m !== null && star(hour) && star(dom) && star(mon) && star(dow)) {
    return `every hour at minute ${m}`;
  }
  // * N * * *
  const h = num(hour);
  if (star(min) && h !== null && star(dom) && star(mon) && star(dow)) {
    return `hourly at ${pad(h)}:00`;
  }
  // N H * * *
  if (m !== null && h !== null && star(dom) && star(mon) && star(dow)) {
    return `daily at ${pad(h)}:${pad(m)}`;
  }
  // N H * * D (weekday)
  const d = num(dow);
  if (m !== null && h !== null && star(dom) && star(mon) && d !== null) {
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const label = d >= 0 && d <= 6 ? names[d] : `dow ${d}`;
    return `weekly on ${label} at ${pad(h)}:${pad(m)}`;
  }
  // N H D * * (fixed date)
  const domN = num(dom);
  if (m !== null && h !== null && domN !== null && star(mon) && star(dow)) {
    return `monthly on day ${domN} at ${pad(h)}:${pad(m)}`;
  }
  return null;
}

/** Compact "every 30s / 5m / 2h" for interval schedules. */
export function describeInterval(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 1000) return null;
  const sec = Math.round(n / 1000);
  if (sec < 60) return `every ${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `every ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `every ${hr}h`;
  return `every ${Math.round(hr / 24)}d`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}
