/**
 * 行為引擎 S2 — content pipeline (ADR-035 決策 5).
 *
 * Produces the CONTENT side of "a life": topic pool (boss business scenarios:
 * health/clinic, restaurants, family, travel … + everyday life) × language
 * style (港式書面語 / 粵語口語 / English) × persona occupation/interest match
 * (affinity lives in S1 — single source: TOPIC_AFFINITY / pickTopic / pickStyle).
 *
 * Two generation modes:
 *  - `template` (offline, ZERO deps, fully seeded): slot-filled hand-written
 *    templates per topic×style. Always available; the test & dry-run path.
 *  - `llm`: OpenAI-compatible chat endpoint injected via ENV
 *    (`CONTENT_LLM_ENDPOINT` + `CONTENT_LLM_MODEL`) — NO hardcoded host/port/
 *    model names in code (worker policy). Any failure (missing env, network,
 *    bad shape) degrades to template mode and is REPORTED in meta.llmFallback
 *    (machines never silently break discipline).
 *
 * Duplication discipline: character-trigram Jaccard against the existing pool;
 * near-duplicates are rejected loudly (counted, kept for audit).
 *
 * Human review queue (人審佇列): candidates land as `pending` in a JSONL
 * ledger; `review approve|reject` flips status; the APPROVED subset is the
 * consumable pool for S3. Sampling discipline (抽樣回庫) is documented in
 * docs/user-manual-gacct.md §9 — approving everything without sampling is
 * how a content pool rots.
 *
 * Zero PII: texts are synthetic; personas contribute only (occupation,
 * interests, languageMix) — pool values, never names.
 */
import fs from 'node:fs';
import path from 'node:path';

import { makeRng } from '@water-army/shared';
import { deriveLifeProfile, pickTopic, pickStyle } from '@water-army/shared';

export const CONTENT_PIPELINE_VERSION = 1;
export const CONTENT_MODES = Object.freeze(['template', 'llm']);
export const REVIEW_STATUS = Object.freeze(['pending', 'approved', 'rejected']);
/** Default trigram-Jaccard near-duplicate threshold (0..1). */
export const DEFAULT_SIM_THRESHOLD = 0.55;

// ---------------------------------------------------------------------------
// Topic pool — slots per topic (synthetic, zero PII). Boss scenarios first.
// ---------------------------------------------------------------------------
export const TOPIC_SLOTS = Object.freeze({
  'health-clinic': {
    cat: ['中醫診所', '物理治療中心', '跌打館', '牙科診所', '體檢中心', '小兒推拿'],
    catEn: ['TCM clinic', 'physio centre', 'dental clinic', 'check-up centre'],
    area: ['觀塘', '旺角', '沙田', '屯門', '荃灣', '元朗', '銅鑼灣', '深水埗'],
    areaEn: ['Kwun Tong', 'Mong Kok', 'Sha Tin', 'Tuen Mun', 'Tsuen Wan', 'Yuen Long', 'Causeway Bay'],
    detail: ['等半個鐘就見到醫生', '成個流程好清晰', '職員跟進得很仔細', '收費公開當眼展示', '治療師手法純熟', '環境乾淨整齊'],
    detailEn: ['seen within half an hour', 'the whole process was clear', 'staff followed up properly', 'prices posted openly'],
  },
  'food-restaurant': {
    cat: ['茶餐廳', '火鍋店', '日料', '甜品店', '咖啡廳', '粥麵店'],
    catEn: ['cha chaan teng', 'hotpot place', 'Japanese place', 'dessert shop', 'cafe'],
    area: ['油麻地', '西環', '將軍澳', '大埔', '荃灣', '北角', '佐敦'],
    areaEn: ['Yau Ma Tei', 'Sai Ying Pun', 'Tseung Kwan O', 'Tai Po', 'Tsim Sha Tsui'],
    detail: ['湯底鮮甜', '飯足料', '性價比高', '要輪候半粒鐘但值得', '細價飯質素 keep 得唔錯'],
    detailEn: ['stock was freshly sweet', 'portion generous', 'great value', '30-min queue but worth it'],
  },
  'family-parenting': {
    cat: ['兒科診所', '言語治療', '課外活動班', '疫苗接種', '幼稚園面試'],
    catEn: ['paediatric clinic', 'speech therapy', 'after-school class', 'vaccination'],
    area: ['沙田', '大圍', '天水圍', '將軍澳', '青衣', '馬鞍山'],
    areaEn: ['Sha Tin', 'Tseung Kwan O', 'Tsing Yi', 'Ma On Shan'],
    detail: ['個女唔捨得行出來', '老師意見仔細', '等成個鐘但安排有序', '價錢合理'],
    detailEn: ['my daughter did not want to leave', 'the teacher gave detailed feedback', 'a long wait but well organised'],
  },
  travel: {
    cat: ['沖繩', '台北', '泰國', '日本', '韓國', '深圳', '澳門'],
    catEn: ['Okinawa', 'Taipei', 'Thailand', 'Japan', 'Korea', 'Shenzhen', 'Macau'],
    area: ['機場', '落馬洲', '深圳北', '中港城'],
    areaEn: ['the airport', 'Luomas crossing', 'Shenzhen North'],
    detail: ['機票平到喊', '人冇想像中多', '過關十幾分鐘搞掂', '酒店位置方便', '適合一家大細'],
    detailEn: ['flights absurdly cheap', 'far fewer crowds than expected', 'crossed the border in minutes', 'hotel location was perfect'],
  },
  shopping: {
    cat: ['數碼產品', '家電', '超市', '波鞋', '化妝品', '寵物用品'],
    catEn: ['gadgets', 'appliances', 'groceries', 'sneakers', 'skincare', 'pet supplies'],
    area: ['觀塘', '旺角', '沙田', '上水', '屯門'],
    areaEn: ['Kwun Tong', 'Mong Kok', 'Sheung Shui', 'Tuen Mun'],
    detail: ['比水貨仲平', '店員畀到意見唔係sell完就算', '送貨快第二日到', '售後企得硬'],
    detailEn: ['cheaper than parallel imports', 'staff actually advised, not pushed', 'delivered next day', 'solid after-sales'],
  },
  leisure: {
    cat: ['行山', '跑步', '打羽毛球', '游水', '睇展', '睇戲', '踩單車'],
    catEn: ['hiking', 'a run', 'badminton', 'swimming', 'an exhibition', 'a movie', 'cycling'],
    area: ['西貢', '麥理浩徑', '維園', '荔枝角公園', '大埔海濱'],
    areaEn: ['Sai Kung', 'MacLeHose Trail', 'Victoria Park', 'Lai Chi Kok Park'],
    detail: ['朝早六點已經好多人', '場地要早訂', '風景療癒', '成個週末充實咗'],
    detailEn: ['packed by 6am', 'book the court early', 'the view heals', 'weekend well spent'],
  },
  'community-news': {
    cat: ['小巴路線', '街市翻新', '屋苑管理', '公屋申請', '公園改善工程'],
    catEn: ['minibus routes', 'market renovation', 'estate management', 'public housing applications'],
    area: ['觀塘', '屯門', '荃灣', '黃大仙', '元朗', '北區'],
    areaEn: ['Kwun Tong', 'Tuen Mun', 'Wong Tai Sin', 'Yuen Long'],
    detail: ['跟進進度令人着急', '預計三個月完成', '居民意見要早過數', '希望下次做啲啱'],
    detailEn: ['progress is painfully slow', 'works slated for three months', 'residents should speak up early'],
  },
});

/** Offline templates per topic×style. `{slot}` fills from TOPIC_SLOTS. */
export const CONTENT_TEMPLATES = Object.freeze({
  'health-clinic': {
    written: [
      '在{area}一間{cat}的就诊經歷：{detail}，供大家參考。',
      '陪家人到{area}的{cat}，{detail}，整體印象不俗。',
    ],
    cantonese: [
      '帶阿媽去{area}睇{cat}，{detail}，要搵類似服務嘅可以考慮。',
      '{area}嗰間{cat}真係唔錯，{detail}，下次繼續返去。',
      '有無人去過{area}嗰間{cat}？我個人體驗{detail}。',
    ],
    en: [
      'Visited a {catEn} in {areaEn} with family — {detailEn}. Sharing for anyone looking around.',
      'Anybody tried the {catEn} near {areaEn}? {detailEn} — would go back.',
    ],
  },
  'food-restaurant': {
    written: [
      '實試{area}新開{cat}：{detail}，性價比值得肯定。',
      '平日午市到{area}一間{cat}光顧，{detail}。',
    ],
    cantonese: [
      '同同事去{area}嗰間{cat}食飯，{detail}，推薦！',
      '{area}間{cat}排隊都有道理，{detail}。',
      '發現{area}一間隱世{cat}，{detail}，唔介意細鋪可以試。',
    ],
    en: [
      'Tried a {catEn} over in {areaEn} — {detailEn}.',
      'Weekday lunch at a {catEn} in {areaEn}: {detailEn}.',
    ],
  },
  'family-parenting': {
    written: [
      '帶小孩到{area}的{cat}，{detail}，寫低供各位家長參考。',
      '{area}區{cat}選擇不多，這間{detail}，總算安心。',
    ],
    cantonese: [
      '帶仔去{area}做{cat}，{detail}，各位爸爸媽媽有無推薦？',
      '{area}呢間{cat}幫到手，{detail}，分享俾同樣掙扎嘅家長。',
    ],
    en: [
      'Took the kids for {catEn} in {areaEn} — {detailEn}. Any other parents been?',
    ],
  },
  travel: {
    written: [
      '剛訂了去{cat}的機票，{detail}，有同行者可交流。',
      '{cat}之行心得：{detail}，適合一家大小。',
    ],
    cantonese: [
      '同屋企人請假去{cat}，{detail}，有無ching去過畀啲建議？',
      '{cat}呢度真係幾好玩，{detail}，下次仲想去。',
    ],
    en: [
      'Booked a family trip to {catEn} — {detailEn}. Tips welcome!',
    ],
  },
  shopping: {
    written: [
      '到{area}比較{cat}價錢，這間{detail}，記錄供大家參考。',
      '{area}購買{cat}經歷：{detail}。',
    ],
    cantonese: [
      '去{area}睇{cat}，呢間{detail}，最後喺度買咗。',
      '求{cat}推薦！{area}嗰間話{detail}，係真定假？',
    ],
    en: [
      'Price-checked {catEn} around {areaEn} — {detailEn}.',
    ],
  },
  leisure: {
    written: [
      '週末到{area}活動（{cat}），{detail}，推薦給同好。',
      '{area}的{cat}體驗：{detail}。',
    ],
    cantonese: [
      '成日同班friend去{area}玩，{detail}，約波約run都可以找我。',
      '第一次去{area}玩{cat}，{detail}，仲有無其他地方推薦？',
    ],
    en: [
      'Weekend {catEn} session at {areaEn} — {detailEn}.',
    ],
  },
  'community-news': {
    written: [
      '關於{area}{cat}的處理，{detail}，作為區內居民記錄一下。',
      '{area}居民關注：{cat}最新情況，{detail}。',
    ],
    cantonese: [
      '{area}呢單{cat}搞咗好耐，{detail}，街坊點睇？',
      '住{area}多年，{cat}件事{detail}，真的要有人跟。',
    ],
    en: [
      'On {catEn} in {areaEn}: {detailEn}. As a resident, noting this down.',
    ],
  },
});

// ---------------------------------------------------------------------------
// Similarity gate — character trigram Jaccard (CJK-safe, no tokenizer needed)
// ---------------------------------------------------------------------------

/** Normalise for similarity: lowercase, strip whitespace/punct, keep alnum+CJK. */
export function normalizeForSim(text) {
  return String(text).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}
export function trigrams(text) {
  const s = normalizeForSim(text);
  const set = new Set();
  if (s.length <= 2) { if (s) set.add(s); return set; }
  for (let i = 0; i + 3 <= s.length; i++) set.add(s.slice(i, i + 3));
  return set;
}
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) if (large.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}
/** Max similarity of `text` against `poolTexts`. Returns {max, at}. */
export function maxSimilarity(text, poolTexts) {
  const t = trigrams(text);
  let max = 0, at = -1;
  poolTexts.forEach((p, i) => { const s = jaccard(t, trigrams(p)); if (s > max) { max = s; at = i; } });
  return { max, at };
}

// ---------------------------------------------------------------------------
// Template generation (offline, seeded)
// ---------------------------------------------------------------------------

/** Deterministic slot-filled template text. Throws on unknown topic/style. */
export function renderTemplate({ topic, style, seed }) {
  const slots = TOPIC_SLOTS[topic];
  const tpls = CONTENT_TEMPLATES[topic]?.[style];
  if (!slots || !tpls) throw new Error(`renderTemplate: no templates for topic='${topic}' style='${style}'`);
  const rng = makeRng(`wa-content|${seed}`);
  const tpl = tpls[Math.floor(rng.u32() / 0xffffffff * tpls.length) % tpls.length];
  const text = tpl.replace(/\{(\w+)\}/g, (_, slot) => {
    const pool = slots[slot];
    if (!Array.isArray(pool) || !pool.length) throw new Error(`renderTemplate: slot '${slot}' missing for topic '${topic}'`);
    return pool[Math.floor(rng.u32() / 0xffffffff * pool.length) % pool.length];
  });
  return { text, template: tpl };
}

// ---------------------------------------------------------------------------
// LLM mode (endpoint via ENV — NO hardcoded host/port/model in code)
// ---------------------------------------------------------------------------

export const LLM_ENV = Object.freeze({ endpoint: 'CONTENT_LLM_ENDPOINT', model: 'CONTENT_LLM_MODEL' });

/** OpenAI-compatible chat-completion caller. `fetchImpl` injectable for tests. */
export function makeLlmClient({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 60_000 } = {}) {
  const endpoint = env[LLM_ENV.endpoint];
  const model = env[LLM_ENV.model];
  if (!endpoint || !model) return null; // caller falls back — reported, never silent
  return async function llm(prompt) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(endpoint.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.9, max_tokens: 120 }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
      const body = await res.json();
      const text = body?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new Error('LLM response shape invalid (no message.content)');
      return text.trim();
    } finally { clearTimeout(timer); }
  };
}

const STYLE_LABEL = Object.freeze({ written: '港式書面語', cantonese: '粵語口語（廣東話）', en: 'natural British English' });

/** Hard cap for LLM-returned text (prompt asks 30–120 chars; adversarial
 *  round FIX-2: a compromised/hallucinating endpoint must never blow up the
 *  ledger, the dedup gate, or downstream renderers). */
export const LLM_TEXT_MAX = 300;
/**
 * Sanitize hostile LLM output: strip control + format chars (NUL, \n, BOM,
 * zero-width/LRM injection), unwrap leaked `{slot}` placeholders, collapse
 * whitespace, hard-cap length. Returns '' when nothing visible survives —
 * caller treats that as a loud fallback, never ships invisible text.
 */
export function sanitizeLlmText(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ');        // control + format (zero-width, BOM, bidi)
  s = s.replace(/\{([A-Za-z_][\w]*)\}/g, '$1');         // leaked template slots → bare word
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > LLM_TEXT_MAX ? s.slice(0, LLM_TEXT_MAX) : s;
}

export function buildPrompt({ topic, style, profile }) {
  return [
    `以身處香港的普通网民身分，用${STYLE_LABEL[style] ?? style}寫一则社交媒體短帖（30–120字），主題：${topic}。`,
    `人設背景（只作口吻參考，唔准出現人名）：職業 ${profile.occupation}，興趣：${profile.interests.join('、')}。`,
    '口語自然、唔好有廣告味、唔好帶 hashtag/emotion icon 堆砌、唔好講價錢之外嘅具體商戶名。只輸出正文。',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Batch pipeline + review ledger
// ---------------------------------------------------------------------------

/**
 * Generate deduplicated content candidates for accounts.
 * @param {object} p
 *  - accounts: [{ accountId, persona? }]  (persona = vault record persona; optional)
 *  - perAccount: candidates per account (default 4, max 50)
 *  - seed (required) — candidate ids/texts replay byte-equal in template mode
 *  - mode: 'template' (default) | 'llm' (llm failure → template fallback, reported)
 *  - existingTexts: strings to dedup against (existing pool)
 *  - llmClient: injected client (default makeLlmClient() from env); tests pass a stub
 *  - simThreshold: default 0.55
 * @returns {{candidates, rejected, meta}}
 */
export async function buildContentPool(p = {}) {
  const {
    accounts, perAccount = 4, seed, mode = 'template',
    existingTexts = [], llmClient, simThreshold = DEFAULT_SIM_THRESHOLD,
  } = p;
  if (!Array.isArray(accounts) || !accounts.length) throw new Error('buildContentPool: accounts[] required');
  if (seed === undefined || seed === null || seed === '') throw new Error('buildContentPool: seed required (determinism discipline)');
  if (!CONTENT_MODES.includes(mode)) throw new Error(`buildContentPool: mode must be one of ${CONTENT_MODES.join('/')}`);
  if (!(perAccount >= 1 && perAccount <= 50)) throw new RangeError('buildContentPool: perAccount must be 1..50');

  const client = mode === 'llm' ? (llmClient !== undefined ? llmClient : makeLlmClient()) : null;
  const llmFallback = [];
  const candidates = [];
  const rejected = [];
  const poolTexts = [...existingTexts];
  let attempts = 0;

  for (const { accountId, persona } of accounts) {
    if (!accountId) throw new Error('buildContentPool: every account needs accountId');
    const profile = deriveLifeProfile(accountId, persona ?? undefined);
    const langMix = profile.life?.social?.languageMix ?? 'zh-Hant-dominant';
    const rng = makeRng(`wa-content-acct|${accountId}|${seed}`);
    for (let i = 0; i < perAccount; i++) {
      const topic = pickTopic(profile, rng);
      const style = pickStyle(langMix, rng);
      const cs = `${seed}|${accountId}|${i}`;
      let text = null;
      if (client) {
        try {
          const raw = await client(buildPrompt({ topic, style, profile }));
          const clean = sanitizeLlmText(raw);
          if (clean.length < 4) {
            // invisible-only / garbage reply: loud fallback, never ship it raw
            llmFallback.push({ accountId, i, reason: 'LLM output empty or too-short after sanitize (control/zero-width-only?)' });
          } else text = clean;
        } catch (e) { llmFallback.push({ accountId, i, reason: String(e?.message ?? e).slice(0, 200) }); }
      }
      if (!text) ({ text } = renderTemplate({ topic, style, seed: cs }));
      attempts++;
      const sim = maxSimilarity(text, poolTexts);
      if (sim.max >= simThreshold) {
        rejected.push({ accountId, topic, style, text, similarity: Number(sim.max.toFixed(3)), againstIndex: sim.at });
        continue;
      }
      poolTexts.push(text);
      const rngId = makeRng(`wa-content-id|${cs}|${topic}|${style}`);
      candidates.push({
        id: `cc-${rngId.code(10).toLowerCase()}`,
        text, topic, style, accountId,
        mode: client && !llmFallback.some((f) => f.accountId === accountId && f.i === i) ? 'llm' : 'template',
        status: 'pending',
        createdAt: new Date(0).toISOString(), // stamped by CLI write time; module stays pure
      });
    }
  }
  return {
    candidates,
    rejected,
    meta: {
      mode, seed: String(seed), requested: accounts.length * perAccount, attempts,
      accepted: candidates.length, duplicatesRejected: rejected.length,
      llmFallback: client ? llmFallback : null, // null = llm mode not attempted
      simThreshold,
    },
  };
}

// ---------------------------------------------------------------------------
// Review ledger (JSONL) — human queue with status flips; S3 consumes approved
// ---------------------------------------------------------------------------

export function readLedger(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
export function writeLedger(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  fs.renameSync(tmp, filePath);
}
/** Append candidates (id-collision = hard fail — ids are content-addressed). */
export function appendCandidates(filePath, candidates, { now = new Date().toISOString() } = {}) {
  const rows = readLedger(filePath);
  const seen = new Set(rows.map((r) => r.id));
  const dupIds = candidates.filter((c) => seen.has(c.id));
  if (dupIds.length) throw new Error(`appendCandidates: duplicate ids already in ledger: ${dupIds.map((d) => d.id).join(', ')}`);
  writeLedger(filePath, [...rows, ...candidates.map((c) => ({ ...c, createdAt: now }))]);
  return { added: candidates.length, total: rows.length + candidates.length };
}

/** Flip review status; returns updated row. Unknown id / bad status = throw. */
export function decideReview(filePath, id, status, { now = new Date().toISOString() } = {}) {
  if (!['approved', 'rejected'].includes(status)) throw new Error(`decideReview: status must be approved|rejected`);
  const rows = readLedger(filePath);
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`decideReview: unknown id '${id}'`);
  row.status = status;
  row.decidedAt = now;
  writeLedger(filePath, rows);
  return row;
}

/** Approved pool consumable by S3. */
export function approvedPool(filePath) {
  return readLedger(filePath).filter((r) => r.status === 'approved');
}
