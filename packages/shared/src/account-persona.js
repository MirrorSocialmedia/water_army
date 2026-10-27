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
    // GAcct 段4: superset = legacy romanised given names + the bilingual
    // pool's English given names (HK_DANIEL-style pairing lives in
    // HK_GIVEN_POOL; validatePersona checks membership against this array).
    given: ['Wai Ming', 'Ka Yee', 'Lai Kwan', 'Chi Ho', 'Man Tung', 'Sze Wing', 'Pok Man', 'Hei Tung', 'Ling Yuet', 'Tsz Fung', 'Kin Hai', 'Wing Sum',
      'Daniel', 'Grace', 'Jimmy', 'Felix', 'Kathy', 'Ken', 'Sharon', 'Wendy', 'Howard', 'Anita', 'Keith', 'Cindy', 'Jason', 'Carmen', 'Warren', 'Elaine', 'Vincent', 'Vivian', 'Oliver', 'Chloe'],
    family: ['Chan', 'Wong', 'Lee', 'Cheung', 'Lau', 'Ng', 'Ho', 'Tam', 'Cheng', 'Fung', 'Tsang', 'Mak',
      'Lam', 'Leung', 'Choi', 'Hui', 'Chow', 'Yu', 'Yip', 'Kwok'],
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

// ---------------------------------------------------------------------------
// HK upgrade (GAcct 段4) — 港人 profile: bilingual identity pairs
// ---------------------------------------------------------------------------

/**
 * Cantonese-first bilingual pool: ONE entry = 中文姓 ↔ jyutping romanisation
 * (the CANONICAL Hong Kong document spelling — Chan/Wong/Cheung, NOT pinyin
 * Chen/Huang/Zhang), and for given names the triple 中文名 ↔ jyutping ↔
 * English given name an HK bearer actually pairs (陳大文 ↔ Dai Man ↔ Daniel).
 * `jyut` doubles as the gmail-prefix echo source (ADR-034 §7: email prefix
 * reflects the person). Gender tags the given-name pool so the birthday/
 * gender/name axes stay ONE deterministic story.
 */
export const HK_SURNAME_POOL = Object.freeze([
  { zh: '陳', jyut: 'Chan' }, { zh: '黃', jyut: 'Wong' }, { zh: '李', jyut: 'Lee' },
  { zh: '張', jyut: 'Cheung' }, { zh: '劉', jyut: 'Lau' }, { zh: '吳', jyut: 'Ng' },
  { zh: '林', jyut: 'Lam' }, { zh: '梁', jyut: 'Leung' }, { zh: '何', jyut: 'Ho' },
  { zh: '鄭', jyut: 'Cheng' }, { zh: '蔡', jyut: 'Choi' }, { zh: '許', jyut: 'Hui' },
  { zh: '曾', jyut: 'Tsang' }, { zh: '周', jyut: 'Chow' }, { zh: '譚', jyut: 'Tam' },
  { zh: '余', jyut: 'Yu' }, { zh: '葉', jyut: 'Yip' }, { zh: '郭', jyut: 'Kwok' },
  { zh: '麥', jyut: 'Mak' }, { zh: '馮', jyut: 'Fung' },
]);

export const HK_GIVEN_POOL = Object.freeze([
  { zh: '大文', jyut: 'Dai Man', en: 'Daniel', gender: 'M' },
  { zh: '嘉欣', jyut: 'Ga Yan', en: 'Grace', gender: 'F' },
  { zh: '志明', jyut: 'Chi Ming', en: 'Jimmy', gender: 'M' },
  { zh: '曉峰', jyut: 'Hiu Fung', en: 'Felix', gender: 'M' },
  { zh: '嘉儀', jyut: 'Ga Yee', en: 'Kathy', gender: 'F' },
  { zh: '偉強', jyut: 'Wai Keung', en: 'Ken', gender: 'M' },
  { zh: '淑嫻', jyut: 'Suk Han', en: 'Sharon', gender: 'F' },
  { zh: '慧琪', jyut: 'Wai Kei', en: 'Wendy', gender: 'F' },
  { zh: '家豪', jyut: 'Gaa Hou', en: 'Howard', gender: 'M' },
  { zh: '雅婷', jyut: 'Ngaa Ting', en: 'Anita', gender: 'F' },
  { zh: '文杰', jyut: 'Man Kit', en: 'Keith', gender: 'M' },
  { zh: '詩琪', jyut: 'Si Kei', en: 'Cindy', gender: 'F' },
  { zh: '嘉俊', jyut: 'Ga Jun', en: 'Jason', gender: 'M' },
  { zh: '凱彤', jyut: 'Hoi Tung', en: 'Carmen', gender: 'F' },
  { zh: '建邦', jyut: 'Kin Bong', en: 'Warren', gender: 'M' },
  { zh: '思穎', jyut: 'Sai Wing', en: 'Elaine', gender: 'F' },
  { zh: '梓謙', jyut: 'Ji Him', en: 'Vincent', gender: 'M' },
  { zh: '雨桐', jyut: 'Jyu Tung', en: 'Vivian', gender: 'F' },
  { zh: '浩然', jyut: 'Hou Jin', en: 'Oliver', gender: 'M' },
  { zh: '語彤', jyut: 'Jyu Tung', en: 'Chloe', gender: 'F' },
]);

/** Life-trajectory axes (profile-surface metadata ONLY — feeds future
 *  human-likeness simulation; ZERO PII, synthetic pool values only). */
export const HK_TRAVEL_PATTERNS = Object.freeze(['shenzhen-weekly', 'tw-weekly', 'jp-quarterly', 'sea-half-year', 'none']);
export const HK_SPENDING_STYLES = Object.freeze(['casual', 'value', 'experience']);
export const HK_SOCIAL_PLATFORMS = Object.freeze(['instagram', 'facebook', 'threads', 'xiaohongshu', 'youtube']);
export const HK_SOCIAL_LANG_MIX = Object.freeze(['zh-Hant-dominant', 'bilingual', 'en-dominant']);
export const HK_SOCIAL_CADENCE = Object.freeze(['lurker', 'light', 'regular']);

/**
 * Deterministic HK enrichment from the accountId (own stream so non-hk
 * personas stay bit-identical across versions): the bilingual pairing +
 * life-trajectory metadata. `gender` is REPEATED at top level for cross-
 * region uniform access. Pure function; exported for tests.
 */
export function generateHkEnrichment(accountId, base = {}) {
  const rng = makeRng(`wa-acct-hk|${accountId}`);
  const surname = rng.pick(HK_SURNAME_POOL);
  const given = rng.pick(HK_GIVEN_POOL);
  const zhName = `${surname.zh}${given.zh}`;
  const latinName = `${given.en} ${surname.jyut}`;
  const jyutping = `${given.jyut} ${surname.jyut}`;
  return {
    zhName, latinName, jyutping,
    surname: { ...surname }, given: { ...given },
    gender: given.gender,
    nameOrder: 'zh-surname-first',
    life: {
      travelPattern: rng.pick(HK_TRAVEL_PATTERNS),
      crossBorderFrequency: rng.pick(['weekly', 'monthly', 'quarterly', 'rare']),
      spendingStyle: rng.pick(HK_SPENDING_STYLES),
      hasPlayStorePaymentMethod: rng.u32() % 10 < 4,
      currency: 'HKD',
      social: {
        primaryPlatform: rng.pick(HK_SOCIAL_PLATFORMS),
        languageMix: rng.pick(HK_SOCIAL_LANG_MIX),
        postingCadence: rng.pick(HK_SOCIAL_CADENCE),
      },
    },
    ...(base.languageHint ? { languageHint: base.languageHint } : {}),
  };
}


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
export function generateGmailPrefix(rng, style = 'any', hint = null) {
  const picked = style === 'any'
    ? PREFIX_STYLES[rng.u32() % PREFIX_STYLES.length]
    : style;
  if (!PREFIX_STYLES.includes(picked)) {
    throw new Error(`generateGmailPrefix: unknown style '${picked}' (allowed: ${PREFIX_STYLE_INPUTS.join('|')})`);
  }
  let digits = 2 + (rng.u32() % 3); // 2..4
  let num = String(rng.u32() % 10 ** digits).padStart(digits, '0');
  let prefix;
  let roots; // distinct root-space feeding this prefix (conservative entropy base)
  if (picked === 'softname') {
    // human-shaped: first initial + family + digits (e.g. "jchan884").
    // Gmail local-part is 6–30 chars — short families ('Ng') get a 3rd digit.
    // `hint` {given, family} (hk bilingual pairing) makes the prefix ECHO the
    // persona's actual name (ADR-034 §7 email-prefix discipline).
    let fam; let given;
    if (hint && typeof hint.family === 'string' && typeof hint.given === 'string') {
      fam = asciiFold(hint.family);
      given = String(hint.given).trim();
      // name is FIXED by the persona → entropy lives in the digits only;
      // floor at 3 digits so the recorded entropy stays ≥16 bits honest.
      if (digits < 3) { digits = 3; num = String(rng.u32() % 1000).padStart(3, '0'); }
      roots = 300; // conservative (initial × jyutping-family space is ~520)
    } else {
      const region = rng.pick(Object.values(REGION_POOLS));
      fam = asciiFold(rng.pick(region.family));
      given = String(rng.pick(region.given)).trim();
      roots = 1600; // ~24 plausible initials × ~70 distinct families across pools (conservative)
    }
    const initial = asciiFold(given[0]);
    prefix = `${initial}${fam}${num}`;
    if (prefix.length < 6) prefix += String(rng.u32() % 10);
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

export const PERSONA_SCHEMA_VERSION = 2;
const PERSONA_SCHEMA_VERSIONS_ACCEPTED = Object.freeze([1, 2]); // v1 rows stay readable (no forced migration)

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
    throw new Error("generatePersona: accountId must be mintAccountId() shape ^acct-[2-9A-HJKMNP-TV-Z]{10}$ (got " + String(accountId).slice(0, 40) + ')');
  }
  if (!ACCOUNT_ROLES.includes(role)) {
    throw new Error(`generatePersona: role must be one of ${ACCOUNT_ROLES.join('|')}`);
  }
  const rng = makeRng(`wa-acct-persona|${accountId}`);
  const regionCode = region ?? PERSONA_REGIONS[rng.u32() % PERSONA_REGIONS.length];
  const pool = REGION_POOLS[regionCode];
  if (!pool) throw new Error(`generatePersona: unknown region '${regionCode}'`);
  // GAcct 段4 — hk upgrade: the bilingual pairing drives the LATINE name too
  // (name.givenName = English given, name.familyName = jyutping romanisation),
  // so the whole persona is ONE story: 陳大文 ↔ Daniel Chan ↔ dchan88@gmail.
  const hk = regionCode === 'hk' ? generateHkEnrichment(accountId) : null;
  const givenName = hk ? hk.given.en : rng.pick(pool.given);
  const familyName = hk ? hk.surname.jyut : rng.pick(pool.family);
  const gender = hk ? hk.gender : (rng.u32() % 2 === 0 ? 'M' : 'F');
  const year = BIRTH_MIN_YEAR + (rng.u32() % (BIRTH_MAX_YEAR - BIRTH_MIN_YEAR + 1));
  const month = 1 + (rng.u32() % 12);
  const dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  const day = 1 + (rng.u32() % dim);
  const gmail = generateGmailPrefix(rng, hk && style === 'any' ? 'softname' : style, hk ? { given: hk.given.en, family: hk.surname.jyut } : null);
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
    gender,
    ...(hk ? { hk } : {}),
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
  if (!PERSONA_SCHEMA_VERSIONS_ACCEPTED.includes(p.schemaVersion)) problems.push(`schemaVersion must be one of ${PERSONA_SCHEMA_VERSIONS_ACCEPTED.join('|')}`);
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
  if (p.gender !== undefined && p.gender !== 'M' && p.gender !== 'F') problems.push("gender must be 'M' | 'F' when present");
  if (p.region === 'hk' && p.schemaVersion >= 2) {
    // hk v2 personas carry the bilingual pairing — consistency is fail-closed.
    const h = p.hk;
    if (!h || typeof h !== 'object') problems.push('hk persona must carry the hk enrichment (zhName/latinName/gender/life)');
    else {
      if (h.gender !== p.gender) problems.push('hk.gender inconsistent with persona.gender');
      if (p.name && h.given && h.surname
        && (p.name.givenName !== h.given.en || p.name.familyName !== h.surname.jyut)) {
        problems.push('hk persona name must equal the bilingual pairing (en given + jyutping family)');
      }
      if (h.zhName !== `${h.surname?.zh ?? ''}${h.given?.zh ?? ''}`) problems.push('hk.zhName must be surname+given (zh)');
      if (h.latinName !== `${h.given?.en ?? ''} ${h.surname?.jyut ?? ''}`) problems.push('hk.latinName must be "<en given> <jyutping family>"');
      if (!HK_SURNAME_POOL.some((s) => s.zh === h.surname?.zh && s.jyut === h.surname?.jyut)) problems.push('hk.surname not from HK_SURNAME_POOL');
      if (!HK_GIVEN_POOL.some((g) => g.zh === h.given?.zh && g.jyut === h.given?.jyut && g.en === h.given?.en && g.gender === h.given?.gender)) problems.push('hk.given not from HK_GIVEN_POOL');
      const life = h.life;
      if (!life || typeof life !== 'object') problems.push('hk.life metadata required (travel/spending/social)');
      else {
        if (!HK_TRAVEL_PATTERNS.includes(life.travelPattern)) problems.push('hk.life.travelPattern not in pool');
        if (!HK_SPENDING_STYLES.includes(life.spendingStyle)) problems.push('hk.life.spendingStyle not in pool');
        if (!HK_SOCIAL_PLATFORMS.includes(life.social?.primaryPlatform)) problems.push('hk.life.social.primaryPlatform not in pool');
        if (!HK_SOCIAL_LANG_MIX.includes(life.social?.languageMix)) problems.push('hk.life.social.languageMix not in pool');
        if (!HK_SOCIAL_CADENCE.includes(life.social?.postingCadence)) problems.push('hk.life.social.postingCadence not in pool');
        if (typeof life.hasPlayStorePaymentMethod !== 'boolean') problems.push('hk.life.hasPlayStorePaymentMethod must be boolean');
      }
    }
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
