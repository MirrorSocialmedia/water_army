/**
 * Account Generator (ADR-034) — persona generator for account ASSETS.
 *
 * One persona per account: a REGION-CONSISTENT identity story (name pool ↔
 * language ↔ timezone), a collision-resistant gmail prefix candidate
 * (word-root + digit entropy — deliberately NOT `wa-xxxx` machine-speak),
 * a policy-checked password with its entropy recorded, a ROLE
 * (anchor | ops | farm | recovery — the boss's "記錄每個帳號角色" ask), and
 * the W3 trinity bindings (account ↔ device-identity ↔ egress, stamped
 * BEFORE creation, fail-closed unless explicitly deferred).
 *
 * Determinism discipline (same splitmix64 stream as W1/W1b/T5 generators):
 * `generatePersona(accountId)` replays deep-equal for a fixed accountId.
 * The CLI mints a random accountId ONCE, then the persona is a pure function
 * of it — regeneration is idempotent and the fleet can never drift.
 *
 * Secrets rule (ADR-030 §vault continues): the generator RETURNS the password
 * once (transient); callers must route it into the encrypted vault. Personas
 * that carry `password` must NEVER be persisted or logged unmasked —
 * `personaForStorage()` strips it. Entropy METADATA (bits, policy) is safe
 * to store and IS stored: it is the audit trail of the password policy.
 */
import { randomBytes } from 'node:crypto';

import { makeRng } from './fingerprint-profile.js';

// ---------------------------------------------------------------------------
// Roles (ADR-034 §1 — semantics are normative; console + ADR follow this file)
// ---------------------------------------------------------------------------

export const ACCOUNT_ROLES = Object.freeze(['anchor', 'ops', 'farm', 'recovery']);

/** Normative role semantics (ADR-034 §1): what an account is FOR. */
export const ACCOUNT_ROLE_SEMANTICS = Object.freeze({
  // Google-platform SSO anchor: the long-lived login (ADR-030 補錄 — Gmail
  // App = 長期登入錨點). Small population, highest survival bar, never farmed.
  anchor: 'Google 平台 SSO 錨點帳號 — 長期登入資產，不量產、不做高風險操作',
  // day-to-day operation surface account (Chrome/作業面, ADR-030 補錄).
  ops: '作業帳號 — 日常操作面（瀏覽器/UI 流程），可替換',
  // mass-produced farming population.
  farm: '量產帳號 — 農場流水線產出，損失可預期',
  // standby reserve for attrition replacement.
  recovery: '預備帳號 — 後備替補，未投入前保持低活動',
});

// ---------------------------------------------------------------------------
// Region pools — the consistency contract lives here
// ---------------------------------------------------------------------------

/**
 * Region = ONE atomic story: language (locale) + timezone + name pools that
 * actually belong together (Cantonese romanisation for HK, pinyin for CN,
 * romanised Mandarin for TW, native romanisation elsewhere). locale/timezone
 * are INTERSECTION-tested against the fleet pools (POOL_LOCALES /
 * POOL_TIMEZONES) in the unit test — the persona layer and the device-fp
 * layer can never diverge onto a region nobody ships.
 */
export const REGION_POOLS = Object.freeze({
  'hk': {
    locale: 'zh-HK', timezone: 'Asia/Hong_Kong',
    given: ['Wai Ming', 'Ka Yee', 'Lai Kwan', 'Chi Ho', 'Man Tung', 'Sze Wing', 'Pok Man', 'Hei Tung', 'Ling Yuet', 'Tsz Fung', 'Kin Hai', 'Wing Sum'],
    family: ['Chan', 'Wong', 'Lee', 'Cheung', 'Lau', 'Ng', 'Ho', 'Tam', 'Cheng', 'Fung', 'Tsang', 'Mak'],
  },
  'cn': {
    locale: 'zh-CN', timezone: 'Asia/Shanghai',
    given: ['Xiu Lan', 'Jian Guo', 'Li Hua', 'Yan Ping', 'Xiao Dong', 'Mei Ling', 'Zhi Qiang', 'Su Yin', 'Wei Dong', 'Fang Min'],
    family: ['Zhang', 'Wang', 'Li', 'Chen', 'Yang', 'Zhao', 'Huang', 'Zhou', 'Wu', 'Xu'],
  },
  'tw': {
    locale: 'zh-TW', timezone: 'Asia/Taipei',
    given: ['Chia Ling', 'Hsiao Yun', 'Mei Hui', 'Chun Hsien', 'Ya Ting', 'Tzu Yu', 'Wei Lin', 'Shu Fen', 'Chih Ming', 'I Chen'],
    family: ['Chang', 'Wang', 'Li', 'Chen', 'Liu', 'Huang', 'Lin', 'Ko', 'Hsu', 'Tsai'],
  },
  'us': {
    locale: 'en-US', timezone: 'America/New_York',
    given: ['Emily', 'Brandon', 'Madison', 'Tyler', 'Kayla', 'Austin', 'Megan', 'Dylan', 'Rachel', 'Cody'],
    family: ['Smith', 'Johnson', 'Miller', 'Davis', 'Wilson', 'Moore', 'Taylor', 'Anderson', 'Thomas', 'Jackson'],
  },
  'gb': {
    locale: 'en-GB', timezone: 'Europe/London',
    given: ['Olivia', 'Harry', 'Charlotte', 'Oliver', 'Amelia', 'Freya', 'Alfie', 'Ruby', 'Archie', 'Maeve'],
    family: ['Taylor', 'Walker', 'Wright', 'Hughes', 'Green', 'Ward', 'Bell', 'Cooper', 'Richardson', 'Brooks'],
  },
  'jp': {
    locale: 'ja-JP', timezone: 'Asia/Tokyo',
    given: ['Haruto', 'Sakura', 'Ren', 'Aoi', 'Sota', 'Hina', 'Yuto', 'Miyu', 'Kaito', 'Yui'],
    family: ['Sato', 'Suzuki', 'Takahashi', 'Tanaka', 'Watanabe', 'Ito', 'Nakamura', 'Kobayashi', 'Kato', 'Yoshida'],
  },
  'kr': {
    locale: 'ko-KR', timezone: 'Asia/Seoul',
    given: ['Min Jun', 'Seo Yeon', 'Ji Woo', 'Ha Eun', 'Do Hyun', 'Ye Eun', 'Hyun Woo', 'Da Eun', 'Jun Seo', 'So Yoon'],
    family: ['Kim', 'Lee', 'Park', 'Choi', 'Jung', 'Kang', 'Cho', 'Yoon', 'Jang', 'Lim'],
  },
  'de': {
    locale: 'de-DE', timezone: 'Europe/Berlin',
    given: ['Lukas', 'Emma', 'Leon', 'Mia', 'Paul', 'Hannah', 'Jonas', 'Lena', 'Felix', 'Marie'],
    family: ['Mueller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Bauer', 'Schulz', 'Hoffmann'],
  },
});

export const PERSONA_REGIONS = Object.freeze(Object.keys(REGION_POOLS));

/** Adult birth-year window (2026 baseline): ~22–57 years old. Per-region uniform. */
const BIRTH_MIN_YEAR = 1968;
const BIRTH_MAX_YEAR = 2004;

// ---------------------------------------------------------------------------
// Gmail prefix styles — word roots + digit entropy, no machine-speak
// ---------------------------------------------------------------------------

/**
 * Anti-collision strategy (ADR-034 §3): prefix = 1–2 word roots (ASCII,
 * lowercase) + 2–4 digits. Collision space per prefix =
 *   root-combinations × 10^digits — entropy is COMPUTED per generated prefix
 *   and stored (`entropyBits`), never assumed. `wa-`-prefixed and other
 *   mechanical shapes are rejected by the validator (boss 01:11: avoid the
 *   wa-xxxx machine smell).
 * Style `any` picks a style deterministically from the seed stream.
 */
export const PREFIX_STYLES = Object.freeze(['softname', 'wordnum', 'nature']);
export const PREFIX_STYLE_INPUTS = Object.freeze(['any', ...PREFIX_STYLES]);

const ADJECTIVES = Object.freeze([
  'amber', 'quiet', 'brisk', 'mellow', 'crisp', 'gentle', 'swift', 'noble',
  'velvet', 'ivory', 'copper', 'willow', 'autumn', 'winter', 'silver', 'golden',
  'hollow', 'hidden', 'wandering', 'patient', 'clever', 'lucky', 'sunny', 'misty',
  'northern', 'coastal', 'rural', 'urban', 'vintage', 'modern', 'simple', 'curious',
]);
const NOUNS = Object.freeze([
  'harbour', 'meadow', 'lantern', 'compass', 'orchard', 'beacon', 'cedar', 'pillow',
  'marble', 'walnut', 'pepper', 'ginger', 'noodle', 'teacup', 'kettle', 'pantry',
  'thistle', 'bramble', 'ferry', 'market', 'temple', 'terrace', 'parlour', 'garden',
  'falcon', 'otter', 'heron', 'badger', 'cricket', 'sparrow', 'walrus', 'pigeon',
]);
const VERBS = Object.freeze([
  'bake', 'hike', 'raft', 'knit', 'roam', 'brew', 'sketch', 'climb', 'row', 'cycle',
  'wander', 'forage', 'paint', 'mend', 'trail', 'drift',
]);

/** ASCII-fold diacritics our name pools carry (Mueller-style spellings). */
function asciiFold(s) {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/**
 * Generate a gmail prefix candidate in the given style.
 * @param {object} rng makeRng stream
 * @param {string} [style] any|softname|wordnum|nature
 * @returns {{prefix:string, style:string, entropyBits:number}}
 */
export function generateGmailPrefix(rng, style = 'any') {
  const picked = style === 'any'
    ? PREFIX_STYLES[rng.u32() % PREFIX_STYLES.length]
    : style;
  if (!PREFIX_STYLES.includes(picked)) {
    throw new Error(`generateGmailPrefix: unknown style '${picked}' (allowed: ${PREFIX_STYLE_INPUTS.join('|')})`);
  }
  const digits = 2 + (rng.u32() % 3); // 2..4
  const num = String(rng.u32() % 10 ** digits).padStart(digits, '0');
  let prefix;
  let roots; // distinct root-space feeding this prefix (conservative entropy base)
  if (picked === 'softname') {
    // human-shaped: first initial + family + digits (e.g. "jchan884").
    // Gmail local-part is 6–30 chars — short families ('Ng') get a 3rd digit.
    const region = rng.pick(Object.values(REGION_POOLS));
    const fam = asciiFold(rng.pick(region.family));
    const given = String(rng.pick(region.given)).trim();
    const initial = asciiFold(given[0]);
    prefix = `${initial}${fam}${num}`;
    if (prefix.length < 6) prefix += String(rng.u32() % 10);
    roots = 1600; // ~24 plausible initials × ~70 distinct families across pools (conservative)
  } else if (picked === 'wordnum') {
    prefix = `${rng.pick(ADJECTIVES)}${rng.pick(NOUNS)}${num}`;
    roots = ADJECTIVES.length * NOUNS.length;
  } else { // nature: (verb|adjective) + [dot] + noun + digits
    const a = rng.u32() % 2 === 0 ? rng.pick(VERBS) : rng.pick(ADJECTIVES);
    const dotted = rng.u32() % 3 === 0;
    prefix = `${a}${dotted ? '.' : ''}${rng.pick(NOUNS)}${num}`;
    roots = (VERBS.length + ADJECTIVES.length) * NOUNS.length * 2;
  }
  const space = roots * 10 ** digits;
  const entropyBits = Math.round(Math.log2(space) * 100) / 100;
  return { prefix, style: picked, entropyBits };
}

// ---------------------------------------------------------------------------
// Password policy + generator (entropy RECORDED, not assumed)
// ---------------------------------------------------------------------------

export const PASSWORD_POLICY = Object.freeze({
  policyId: 'wa-acct-v1',
  length: 18,
  minEntropyBits: 100,
  // disjoint character classes; pool size = sum. Every class is REQUIRED
  // (positional placement guarantees inclusion deterministically).
  classes: Object.freeze({
    lower: 'abcdefghijkmnopqrstuvwxyz', // no 'l' — autofill ambiguity
    upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ', // no 'I'/'O' — same
    digit: '23456789',                 // no 0/1 — same
    symbol: '!@#$%?-_',
  }),
});

/**
 * Password per PASSWORD_POLICY from a deterministic seed OR an injected rand.
 * @param {{seed?:string, rng?:object, rand?:() => number}} src
 * @returns {{password:string, meta:{policyId:string,length:number,poolSize:number,entropyBits:number}}}
 */
export function generatePassword(src = {}) {
  const policy = PASSWORD_POLICY;
  const classes = Object.values(policy.classes);
  const pool = classes.join('');
  const rng = src.rng ?? (src.seed != null ? makeRng(`wa-acct-pw|${src.seed}`) : null);
  let password;
  if (rng) {
    const chars = Array.from({ length: policy.length }, () => pool[rng.u32() % pool.length]);
    // class inclusion at spread positions (1,6,11,16)
    classes.forEach((cls, c) => { chars[(c * 5 + 1) % policy.length] = cls[rng.u32() % cls.length]; });
    password = chars.join('');
  } else if (typeof src.rand === 'function') {
    const chars = Array.from({ length: policy.length }, () => pool[Math.min(pool.length - 1, Math.floor(src.rand() * pool.length))]);
    classes.forEach((cls, c) => { chars[(c * 5 + 1) % policy.length] = cls[Math.min(cls.length - 1, Math.floor(src.rand() * cls.length))]; });
    password = chars.join('');
  } else {
    throw new TypeError('generatePassword: src must carry {seed} | {rng} | {rand}');
  }
  const entropyBits = Math.round(policy.length * Math.log2(pool.length) * 100) / 100;
  return {
    password,
    meta: { policyId: policy.policyId, length: policy.length, poolSize: pool.length, entropyBits },
  };
}

/** Validate a plaintext password + meta against the policy (fail-closed). */
export function validatePasswordAgainstPolicy(password, meta) {
  const problems = [];
  const p = PASSWORD_POLICY;
  if (typeof password !== 'string' || password.length !== p.length) {
    problems.push(`password must be exactly ${p.length} chars`);
  } else {
    const pool = Object.values(p.classes).join('');
    for (const [name, cls] of Object.entries(p.classes)) {
      if (![...cls].some((ch) => password.includes(ch))) problems.push(`password missing class '${name}'`);
    }
    if ([...password].some((ch) => !pool.includes(ch))) problems.push('password uses chars outside the policy pool');
  }
  if (!meta || typeof meta !== 'object') problems.push('password meta required');
  else {
    if (meta.policyId !== p.policyId) problems.push(`password meta policyId must be ${p.policyId}`);
    if (!(typeof meta.entropyBits === 'number' && meta.entropyBits >= p.minEntropyBits)) {
      problems.push(`password entropy ${meta.entropyBits} below policy minimum ${p.minEntropyBits}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Account ids
// ---------------------------------------------------------------------------

/**
 * Mint a random accountId: `acct-` + Crockford base32 × 10 (32^10 ≈ 2^50).
 * Shape-compatible with the W1 identity-id contract (^[A-Za-z0-9_-]{8,64}$)
 * so the same rng/determinism machinery applies.
 */
export function mintAccountId() {
  const B32 = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = randomBytes(10);
  let out = 'acct-';
  for (const b of bytes) out += B32[b % B32.length]; // length-safe (30-symbol Crockford subset, same pool as fingerprint BASE32)
  return out;
}

// ---------------------------------------------------------------------------
// Bindings (W3 trinity: account ↔ device-identity ↔ egress — stamped BEFORE
// creation; ADR-034 §4)
// ---------------------------------------------------------------------------

/** Opaque id shape for binding references (fingerprint/egress profile ids). */
const BINDING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;

export const BINDING_PENDING = Object.freeze({ fingerprintProfileId: null, egressProfileId: null });

// ---------------------------------------------------------------------------
// Persona generator
// ---------------------------------------------------------------------------

export const PERSONA_SCHEMA_VERSION = 1;

/**
 * Generate the persona for one accountId. DETERMINISTIC: deep-equal replay
 * for the same accountId (idempotent regeneration, same discipline as
 * generateFingerprintProfile). The password rides the SAME seed — replaying
 * reproduces it (the vault, not the persona blob, is where it must live;
 * personaForStorage() strips it).
 *
 * @param {string} accountId `acct-` + 10 base32 (mintAccountId output)
 * @param {object} opts
 * @param {'anchor'|'ops'|'farm'|'recovery'} opts.role
 * @param {string} [opts.region] pin a region (default: deterministic pick)
 * @param {string} [opts.style]  gmail prefix style (any|softname|wordnum|nature)
 * @param {{fingerprintProfileId:string|null, egressProfileId:string|null, deferred?:boolean}} [opts.bindings]
 *        trinity bindings; either BOTH ids present, or `deferred:true`
 *        (explicit — e.g. farm pre-generation before proxy allocation).
 *        Absent bindings without deferred = fail-closed at validation.
 * @returns {object} persona (carries transient `password` plaintext)
 */
export function generatePersona(accountId, { role, region, style = 'any', bindings } = {}) {
  if (typeof accountId !== 'string' || !/^acct-[0-9A-HJKMNP-TV-Z]{10}$/.test(accountId)) {
    throw new Error("generatePersona: accountId must be mintAccountId() shape ^acct-[2-9A-HJKMNP-TV-Z]{11}$-ish (got " + String(accountId).slice(0, 40) + ')');
  }
  if (!ACCOUNT_ROLES.includes(role)) {
    throw new Error(`generatePersona: role must be one of ${ACCOUNT_ROLES.join('|')}`);
  }
  const rng = makeRng(`wa-acct-persona|${accountId}`);
  const regionCode = region ?? PERSONA_REGIONS[rng.u32() % PERSONA_REGIONS.length];
  const pool = REGION_POOLS[regionCode];
  if (!pool) throw new Error(`generatePersona: unknown region '${regionCode}'`);
  const givenName = rng.pick(pool.given);
  const familyName = rng.pick(pool.family);
  const year = BIRTH_MIN_YEAR + (rng.u32() % (BIRTH_MAX_YEAR - BIRTH_MIN_YEAR + 1));
  const month = 1 + (rng.u32() % 12);
  const dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  const day = 1 + (rng.u32() % dim);
  const gmail = generateGmailPrefix(rng, style);
  const pw = generatePassword({ rng: makeRng(`wa-acct-pw|${accountId}`) });
  const b = bindings ?? { fingerprintProfileId: null, egressProfileId: null, deferred: true };
  const persona = {
    schemaVersion: PERSONA_SCHEMA_VERSION,
    accountId,
    role,
    region: regionCode,
    locale: pool.locale,
    timezone: pool.timezone,
    name: { givenName, familyName },
    birthday: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    gmail: { prefix: gmail.prefix, style: gmail.style, entropyBits: gmail.entropyBits },
    password: pw.password,
    passwordMeta: pw.meta,
    bindings: {
      fingerprintProfileId: b.fingerprintProfileId ?? null,
      egressProfileId: b.egressProfileId ?? null,
      deferred: Boolean(b.deferred) || (b.fingerprintProfileId == null && b.egressProfileId == null),
    },
  };
  const problems = validatePersona(persona);
  if (problems.length) {
    throw new Error(`generatePersona: internal generator produced invalid persona: ${problems.join('; ')}`);
  }
  return persona;
}

// ---------------------------------------------------------------------------
// Validator (fail-closed)
// ---------------------------------------------------------------------------

/** Gmail local-part rules (letters/digits/dots, 6–30, dot not leading/trailing/consecutive). */
const GMAIL_PREFIX_RE = /^[a-z0-9][a-z0-9.]{4,28}[a-z0-9]$/;
const NAME_RE = /^[A-Z][A-Za-z]*( [A-Z][A-Za-z]*){0,2}$/;
const BIRTHDAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * @returns {string[]} problems (empty = valid). Structural + consistency:
 * role allowlist, region↔locale↔timezone atomicity, name pool membership,
 * birthday window, gmail prefix rules + mechanical-shape ban, password
 * policy, trinity binding rule (both ids OR explicit deferred).
 */
export function validatePersona(persona) {
  const problems = [];
  if (!persona || typeof persona !== 'object' || Array.isArray(persona)) return ['persona must be a plain object'];
  const p = persona;
  if (p.schemaVersion !== PERSONA_SCHEMA_VERSION) problems.push(`schemaVersion must be ${PERSONA_SCHEMA_VERSION}`);
  if (typeof p.accountId !== 'string' || !/^acct-[2-9A-HJKMNP-TV-Z]{10}$/.test(p.accountId)) problems.push('accountId shape invalid');
  if (!ACCOUNT_ROLES.includes(p.role)) problems.push(`role must be one of ${ACCOUNT_ROLES.join('|')}`);
  const pool = REGION_POOLS[p.region];
  if (!pool) problems.push(`unknown region '${p.region}'`);
  else {
    if (p.locale !== pool.locale) problems.push(`locale '${p.locale}' inconsistent with region '${p.region}'`);
    if (p.timezone !== pool.timezone) problems.push(`timezone '${p.timezone}' inconsistent with region '${p.region}'`);
    if (p.name && !(pool.given.includes(p.name.givenName) && pool.family.includes(p.name.familyName))) {
      problems.push('name not from the region pool (consistency violation)');
    }
  }
  if (!p.name || typeof p.name.givenName !== 'string' || typeof p.name.familyName !== 'string'
    || !NAME_RE.test(p.name.givenName) || !NAME_RE.test(p.name.familyName)) {
    problems.push('name.givenName/name.familyName must be Capitalised romanisation');
  }
  if (typeof p.birthday !== 'string' || !BIRTHDAY_RE.test(p.birthday)) problems.push('birthday must be YYYY-MM-DD');
  else {
    const y = Number(p.birthday.slice(0, 4));
    if (y < BIRTH_MIN_YEAR || y > BIRTH_MAX_YEAR) problems.push(`birthday year outside adult window ${BIRTH_MIN_YEAR}–${BIRTH_MAX_YEAR}`);
  }
  if (!p.gmail || typeof p.gmail.prefix !== 'string') problems.push('gmail.prefix required');
  else {
    const g = p.gmail;
    if (!GMAIL_PREFIX_RE.test(g.prefix)) problems.push(`gmail prefix '${g.prefix.slice(0, 40)}' violates gmail local-part rules`);
    if (g.prefix.includes('..')) problems.push('gmail prefix must not contain consecutive dots');
    if (/^wa[-_0-9]/i.test(g.prefix) || /^wa\d/i.test(g.prefix)) problems.push('gmail prefix must not be wa-style mechanical (ADR-034 §3)');
    if (!PREFIX_STYLES.includes(g.style)) problems.push(`gmail.style must be one of ${PREFIX_STYLES.join('|')}`);
    if (!(typeof g.entropyBits === 'number' && g.entropyBits >= 16)) problems.push('gmail prefix entropyBits must be a number >= 16');
  }
  problems.push(...validatePasswordAgainstPolicy(p.password, p.passwordMeta));
  // trinity bindings (ADR-034 §4): both ids, or explicit deferral — never silence.
  const b = p.bindings;
  if (!b || typeof b !== 'object') problems.push('bindings required (trinity — bind before creation)');
  else {
    const fpOk = typeof b.fingerprintProfileId === 'string' && BINDING_ID_RE.test(b.fingerprintProfileId);
    const egOk = typeof b.egressProfileId === 'string' && BINDING_ID_RE.test(b.egressProfileId);
    if (b.deferred) {
      if (fpOk !== egOk) problems.push('deferred bindings must be BOTH pending or BOTH bound');
    } else if (!fpOk || !egOk) {
      problems.push('bindings must carry BOTH fingerprintProfileId and egressProfileId (or set bindings.deferred = true explicitly)');
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Storage/log projections (zero secrets)
// ---------------------------------------------------------------------------

/**
 * Strip the transient plaintext password → the shape safe for the (encrypted
 * or gitignored) registry. The vault holds the ciphertext; the registry row
 * carries meta + a pointer, never the secret.
 */
export function personaForStorage(persona) {
  const { password, ...rest } = persona;
  return { ...rest, hasPassword: typeof password === 'string' && password.length > 0 };
}

/**
 * One-line masked summary for logs/console (never the full prefix,
 * never the password): `acct-XXXX [ops] am***2@... region hk`.
 */
export function summarizePersona(persona) {
  const g = persona?.gmail?.prefix ?? '***';
  const masked = g.length <= 4 ? `${g.slice(0, 1)}***` : `${g.slice(0, 2)}***${g.slice(-1)}`;
  return `${persona?.accountId ?? '?'} [${persona?.role ?? '?'}] ${masked}@gmail.com region=${persona?.region ?? '?'} pw<${persona?.passwordMeta?.entropyBits ?? '?'} bits>`;
}
