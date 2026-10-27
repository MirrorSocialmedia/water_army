/**
 * T5 (ADR-030) — Gmail account lifecycle: states, transition matrix,
 * provisioning throttle, and the deterministic realism profile.
 *
 * WHY A SIBLING MACHINE (ADR-030 amends the ADR-029 §3 reservation):
 * the login-state machine (ADR-029) is a HUMAN-ONLY truth surface — no
 * machine caller may ever write it. The account-creation pipeline below is
 * driven BY the machine (provisioning driver) with operator overrides.
 * Merging the two into one column would force the driver to write the same
 * field the ADR-029 manual-only guarantee protects. They are two orthogonal
 * axes on the same identity:
 *   login_state        "is the app logged in on this device" (human truth)
 *   account lifecycle  "where is this Gmail account's creation/health"
 * Bridge rules live in ADR-030. Three-way sync discipline (ADR-029 §3) is
 * honoured: THIS matrix is authoritative; the web mirror
 * (batch-ui.js ACCOUNT_TRANSITIONS_UI) and the matrix unit test must match.
 *
 * States (工單語義):
 *   PREPARING        準備中   — record created, inputs validated, not started
 *   PROVISIONING     開號驅動中 — the UI-flow driver is executing steps
 *   AWAITING_HUMAN   待人工驗證 — CAPTCHA/human gate hit; an EXTERNAL_VERIFICATION
 *                              intervention ticket is open; NO auto-solve ever
 *   CREATED          建立成功 — account verified created, credentials vaulted
 *   RECOVERY_SETUP   恢復設置中 — recovery-email step running (fail-closed:
 *                              no recovery pool ⇒ can never enter READY)
 *   READY            就緒     — recovery configured; account ready for farming
 *   DEAD             死亡     — terminal (timeout / banned / abandoned / hard fail)
 */
import { makeRng } from './fingerprint-profile.js';

export const ACCOUNT_STATES = Object.freeze([
  'PREPARING', 'PROVISIONING', 'AWAITING_HUMAN', 'CREATED', 'RECOVERY_SETUP', 'READY', 'DEAD',
]);

/** Fail-closed transition matrix: from → allowed tos. Anything else = 4xx. */
export const ACCOUNT_TRANSITIONS = Object.freeze({
  PREPARING: Object.freeze(['PROVISIONING', 'DEAD']),
  PROVISIONING: Object.freeze(['AWAITING_HUMAN', 'CREATED', 'DEAD']),
  AWAITING_HUMAN: Object.freeze(['PROVISIONING', 'DEAD']),
  CREATED: Object.freeze(['RECOVERY_SETUP', 'DEAD']),
  RECOVERY_SETUP: Object.freeze(['READY', 'DEAD']),
  READY: Object.freeze(['DEAD']), // banned / lost later — death is always legal
  DEAD: Object.freeze([]),        // terminal
});

export function isLegalAccountTransition(from, to) {
  return Boolean(ACCOUNT_TRANSITIONS[from]?.includes(to));
}

/** Resume-eligible states for the driver entry (everything but READY/DEAD). */
export const ACCOUNT_RESUMABLE = Object.freeze([
  'PREPARING', 'PROVISIONING', 'AWAITING_HUMAN', 'CREATED', 'RECOVERY_SETUP',
]);

// --------------------------------------------------------------------------
// Deterministic realism profile (工單：profile 模板庫 — 決定性真實感資料：名/生日)
// --------------------------------------------------------------------------

/** Name pool — mixed realistic Latin/Cantonese-romanised identities. Synthetic
 * data only (zero real-person linkage); the pool is the template library. */
export const GIVEN_NAMES = Object.freeze([
  'Wai Ming', 'Ka Yee', 'Lai Kwan', 'Chi Ho', 'Man Tung', 'Sze Wing', 'Pok Man',
  'Hei Tung', 'Ling Yuet', 'Tsz Fung', 'Kin Hai', 'Wing Sum', 'Ho Yan', 'Chun Yu',
  'Fai', 'Nok Hin', 'Sing Yi', 'Da Yiu', 'Zhi Wen', 'Mei Ling', 'Jun Jie',
  'Xiao Yun', 'Hiu Lam', 'Bondy', 'Fung Shek', 'Lok Shek', 'Yuk Fun', 'Dai Ming',
  'Siu Fong', 'Ah So', 'Ka Fai', 'Man Man', 'Hei Man', 'Ting Ting', 'Wai Kit',
  'Ching Lau', 'Ngai Ka', 'Balpreet', 'Harpreet', 'Aarav',
]);

export const FAMILY_NAMES = Object.freeze([
  'Chan', 'Wong', 'Lee', 'Cheung', 'Lau', 'Ng', 'Ho', 'Tam', 'Cheng', 'Wu',
  'Tang', 'Kam', 'Tsang', 'Mak', 'Fung', 'Ko', 'Sze', 'Luk', 'Pang', 'Yau',
  'Ip', 'Dai', 'Yuen', 'So', 'Au Yeung', 'Szeto', 'Tong', 'Or', 'Bhullar', 'Sharma',
]);

const BIRTH_MIN_YEAR = 1985;
const BIRTH_MAX_YEAR = 2002;

/**
 * Deterministic account profile from the identity id (same splitmix64 stream
 * discipline as W1/W1b generators — regeneration is idempotent).
 * @returns {{givenName:string,familyName:string,birthday:string,gender:string}}
 */
export function deriveAccountProfile(identityId) {
  if (typeof identityId !== 'string' || identityId.length < 8) {
    throw new TypeError('deriveAccountProfile: identityId must be a string (uuid)');
  }
  const rng = makeRng(`wa-t5-profile|${identityId}`);
  const given = rng.pick(GIVEN_NAMES).trim();
  const family = rng.pick(FAMILY_NAMES);
  const year = BIRTH_MIN_YEAR + (rng.u32() % (BIRTH_MAX_YEAR - BIRTH_MIN_YEAR + 1));
  const month = 1 + (rng.u32() % 12);
  // day capped per month (leap: Feb capped 28 — realistic enough, deterministic)
  const dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  const day = 1 + (rng.u32() % dim);
  const gender = rng.u32() % 2 === 0 ? 'female' : 'male';
  return {
    givenName: given,
    familyName: family,
    birthday: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    gender,
  };
}

// --------------------------------------------------------------------------
// Masking (zero-secrets: masked forms are the ONLY storable/loggable shape)
// --------------------------------------------------------------------------

/** Mask an email to `ab***@domain` — local part is the secret-shaped part. */
export function maskEmail(email) {
  if (typeof email !== 'string') return '***';
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}***@${email.slice(at + 1)}`;
}

// --------------------------------------------------------------------------
// Throttle (每 identity/IP 每日計數 + 隨機間隔) — pure evaluator
// --------------------------------------------------------------------------

/** UTC day key (throttle day boundary; stable across deployments). */
export function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Evaluate whether a provisioning attempt may start NOW. Pure: the caller
 * loads the counter rows; this decides. Fail-closed: unknown scope or missing
 * row data never invents headroom beyond limits.
 *
 * @param {object} p
 * @param {number} p.perIpDaily        daily cap per egress IP (0 = deny all)
 * @param {number} p.perIdentityDaily  daily cap per identity
 * @param {number} p.minIntervalMs     minimum gap between ANY two attempts
 * @param {number} p.maxIntervalMs     jitter upper bound for that gap
 * @param {string|null} p.ip           bound egress IP (null → skip IP scope)
 * @param {string} p.identityId
 * @param {Map<string,{count:number}>} p.counters  keyed by scopeKey
 * @param {Date|null} p.lastStartedAt  global last attempt start
 * @param {Date} p.now
 * @param {() => number} p.rand        [0,1) jitter source (injectable)
 * @returns {{ok:true}|{ok:false, code:string, retryAfterMs?:number}}
 */
export function evaluateThrottle({
  perIpDaily, perIdentityDaily, minIntervalMs, maxIntervalMs,
  ip, identityId, counters, lastStartedAt, now, rand = Math.random,
}) {
  if (ip) {
    const row = counters.get(`ip:${ip}`);
    if ((row?.count ?? 0) >= perIpDaily) return { ok: false, code: 'THROTTLE_IP_DAILY_LIMIT' };
  }
  const idRow = counters.get(`id:${identityId}`);
  if ((idRow?.count ?? 0) >= perIdentityDaily) return { ok: false, code: 'THROTTLE_IDENTITY_DAILY_LIMIT' };
  if (lastStartedAt) {
    const lo = Math.max(0, Number(minIntervalMs) || 0);
    const hi = Math.max(lo, Number(maxIntervalMs) || lo);
    const gap = lo + (hi > lo ? rand() * (hi - lo) : 0);
    const elapsed = now - new Date(lastStartedAt);
    if (elapsed < gap) return { ok: false, code: 'THROTTLE_INTERVAL', retryAfterMs: Math.ceil(gap - elapsed) };
  }
  return { ok: true };
}

/** Scope keys for one attempt's counter writes. */
export function throttleScopeKeys(identityId, ip) {
  const keys = [`id:${identityId}`];
  if (ip) keys.push(`ip:${ip}`);
  return keys;
}

/**
 * Pick a recovery email from the configured pool, deterministically per
 * identity (stable across retries; two identities spread across the pool).
 * Empty pool → null (caller fail-closes: 冇恢復郵箱 = 唔准入「就緒」).
 */
export function pickRecoveryEmail(identityId, pool) {
  const list = Array.isArray(pool) ? pool.filter((x) => typeof x === 'string' && x.includes('@')) : [];
  if (list.length === 0) return null;
  const rng = makeRng(`wa-t5-recovery|${identityId}`);
  return list[rng.u32() % list.length];
}
