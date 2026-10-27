/**
 * 行為引擎 S2 unit — content pipeline (ADR-035 決策 5).
 * Hermetic: template mode seeded determinism; llm mode via injected fetch/
 * client stubs (no network). Ledger ops on tmp dirs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generatePersona } from '@water-army/shared';
import {
  CONTENT_MODES, REVIEW_STATUS, DEFAULT_SIM_THRESHOLD,
  TOPIC_SLOTS, CONTENT_TEMPLATES,
  renderTemplate, trigrams, jaccard, maxSimilarity, normalizeForSim,
  makeLlmClient, buildPrompt, buildContentPool,
  appendCandidates, readLedger, decideReview, approvedPool,
} from '../../apps/worker/src/content-pipeline.js';

const tmpLedger = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ledger-')), 'ledger.jsonl');
const personaOf = (i) => generatePersona(`acct-CONT${String(i).padStart(4, '')}`.slice(0, 15), { role: 'farm', region: 'hk', bindings: { deferred: true } });
// valid Crockford ids (persona generator is strict) — derive from rng
import { makeRng } from '@water-army/shared';
const acctId = (tag) => `acct-${makeRng(`wa-content-test|${tag}`).code(10)}`;
const acctPersona = (tag) => {
  const id = acctId(tag);
  return { accountId: id, persona: generatePersona(id, { role: 'farm', region: 'hk', bindings: { deferred: true } }) };
};

test('template render: deterministic, placeholder-complete, pool-bound', () => {
  const a = renderTemplate({ topic: 'food-restaurant', style: 'cantonese', seed: 'x1' });
  assert.deepEqual(a, renderTemplate({ topic: 'food-restaurant', style: 'cantonese', seed: 'x1' }));
  assert.ok(!/\{\w+\}/.test(a.text), 'no unfilled slots');
  assert.ok(a.text.length >= 8);
  assert.notDeepEqual(a.text, renderTemplate({ topic: 'food-restaurant', style: 'cantonese', seed: 'x2' }).text);
  assert.throws(() => renderTemplate({ topic: 'klingon-history', style: 'en', seed: 's' }), /no templates/);
  assert.throws(() => renderTemplate({ topic: 'travel', style: 'klingon', seed: 's' }), /no templates/);
});

test('template table integrity: every topic × style renders; every slot exists', () => {
  for (const topic of Object.keys(TOPIC_SLOTS)) {
    for (const style of ['written', 'cantonese', 'en']) {
      const tpls = CONTENT_TEMPLATES[topic][style];
      assert.ok(Array.isArray(tpls) && tpls.length >= 1, `${topic}/${style} missing`);
      for (const tpl of tpls) {
        for (const slot of tpl.match(/\{(\w+)\}/g).map((s) => s.slice(1, -1))) {
          assert.ok(Array.isArray(TOPIC_SLOTS[topic][slot]), `${topic}/${style}: slot '${slot}' not in TOPIC_SLOTS`);
        }
        for (let s = 0; s < 5; s++) assert.ok(!/\{\w+\}/.test(renderTemplate({ topic, style, seed: `t${s}` }).text));
      }
    }
  }
});

test('similarity: trigram jaccard known cases + near-duplicate gate', () => {
  assert.equal(jaccard(trigrams(' abcdef '), trigrams('abcdef')), 1);
  assert.equal(jaccard(trigrams('abcdef'), trigrams('uvwxyz')), 0);
  assert.equal(jaccard(trigrams('ab'), trigrams('ab')), 1);
  assert.equal(jaccard(trigrams(''), trigrams('abc')), 0);
  const near = maxSimilarity('帶阿媽去觀塘睇中醫診所，等半個鐘就見到醫生，下次繼續返去。', [
    '帶阿媽去觀塘睇中醫診所，等半個鐘就見到醫生，下次繼續返去！', // same text, diff punctuation
    '周末去西貢行山，風景療癒，成個週末充實咗。',
  ]);
  assert.equal(near.max, 1, 'punctuation-insensitive match expected');
  assert.equal(near.at, 0);
  assert.ok(maxSimilarity('完全唔同嘅一句嘢講緊跑步同埋天氣', ['帶阿媽去睇中醫']).max < DEFAULT_SIM_THRESHOLD);
  assert.equal(normalizeForSim('Hello, 世界!  '), 'hello世界');
});

test('buildContentPool: seeded determinism (template mode), statuses pending, ids unique', async () => {
  const accts = [acctPersona('c0'), acctPersona('c1'), acctPersona('c2')];
  const r1 = await buildContentPool({ accounts: accts, perAccount: 5, seed: 'S' });
  const r2 = await buildContentPool({ accounts: accts, perAccount: 5, seed: 'S' });
  assert.deepEqual(r1.candidates, r2.candidates);
  assert.equal(r1.meta.accepted + r1.meta.duplicatesRejected, 15);
  const ids = new Set(r1.candidates.map((c) => c.id));
  assert.equal(ids.size, r1.candidates.length, 'unique ids');
  for (const c of r1.candidates) {
    assert.equal(c.status, 'pending');
    assert.ok(REVIEW_STATUS.includes(c.status));
    assert.ok(['written', 'cantonese', 'en'].includes(c.style));
    assert.ok(Object.keys(TOPIC_SLOTS).includes(c.topic));
    assert.equal(c.mode, 'template');
  }
  const r3 = await buildContentPool({ accounts: accts, perAccount: 5, seed: 'S-diff' });
  assert.notDeepEqual(r3.candidates.map((c) => c.text), r1.candidates.map((c) => c.text));
});

test('buildContentPool: near-duplicate rejection vs existing pool (loud, counted)', async () => {
  const accts = [acctPersona('dup0'), acctPersona('dup1')];
  const first = await buildContentPool({ accounts: accts, perAccount: 4, seed: 'same' });
  const texts = first.candidates.map((c) => c.text);
  const second = await buildContentPool({ accounts: accts, perAccount: 4, seed: 'same', existingTexts: texts });
  assert.equal(second.meta.accepted, 0, 'identical regeneration must be 100% dedup-rejected');
  assert.equal(second.meta.duplicatesRejected, 8);
  for (const rj of second.rejected) assert.ok(rj.similarity >= DEFAULT_SIM_THRESHOLD);
});

test('llm mode: injected client wins; failure falls back LOUDLY; env-driven client factory', async () => {
  const accts = [acctPersona('llm0')];
    let n = 0;
  const stub = async (prompt) => `LLM-OUT ${++n} ${prompt.length} ${'呀啫啦'.repeat(n)}`;
  const ok = await buildContentPool({ accounts: accts, perAccount: 3, seed: 'L', mode: 'llm', llmClient: stub });
  assert.equal(ok.candidates.length, 3);
  assert.ok(ok.candidates.every((c) => c.mode === 'llm' && c.text.startsWith('LLM-OUT')));
  assert.deepEqual(ok.meta.llmFallback, []);

  const boom = async () => { throw new Error('ECONNREFUSED'); };
  const fb = await buildContentPool({ accounts: accts, perAccount: 3, seed: 'L', mode: 'llm', llmClient: boom });
  assert.equal(fb.candidates.length, 3, 'template fallback keeps delivery');
  assert.equal(fb.meta.llmFallback.length, 3, 'fallback reported per item');
  assert.match(fb.meta.llmFallback[0].reason, /ECONNREFUSED/);
  assert.ok(fb.candidates.every((c) => c.mode === 'template'));

  // env-driven factory: zero env → null (caller must fall back); with env → fetch called, shape-checked
  assert.equal(makeLlmClient({ env: {} }), null);
  let captured = null;
  const fetchStub = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '  貼文内容  ' } }] }) };
  };
  const client = makeLlmClient({ env: { CONTENT_LLM_ENDPOINT: 'http://example.test:9/v1', CONTENT_LLM_MODEL: 'some-model' }, fetchImpl: fetchStub });
  assert.equal(await client('hi'), '貼文内容', 'trimmed content returned');
  assert.equal(captured.url, 'http://example.test:9/v1/chat/completions');
  assert.equal(captured.body.model, 'some-model', 'model comes from ENV, never hardcoded');
  const badShape = makeLlmClient({ env: { CONTENT_LLM_ENDPOINT: 'http://x', CONTENT_LLM_MODEL: 'm' }, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  await assert.rejects(() => badShape('hi'), /shape invalid/);
  const httpFail = makeLlmClient({ env: { CONTENT_LLM_ENDPOINT: 'http://x', CONTENT_LLM_MODEL: 'm' }, fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(() => httpFail('hi'), /HTTP 503/);
  assert.equal(CONTENT_MODES.join(','), 'template,llm');
  assert.match(buildPrompt({ topic: 'travel', style: 'cantonese', profile: { occupation: '厨师', interests: ['煮嘢食'] } }), /廣東話/);
});

test('persona affinity reaches the pool: chef accounts skew to food topics', async () => {
  const chefAccts = [];
  for (let i = 0; i < 12; i++) {
    const id = acctId(`chef-${i}`);
    chefAccts.push({ accountId: id, persona: { hk: { life: { occupation: '厨师', interests: ['煮嘢食'], social: { languageMix: 'zh-Hant-dominant' } } } } });
  }
  const r = await buildContentPool({ accounts: chefAccts, perAccount: 6, seed: 'aff' });
  const food = r.candidates.filter((c) => c.topic === 'food-restaurant').length;
  assert.ok(food >= r.candidates.length * 0.3, `chef food share expected ≥30%, got ${food}/${r.candidates.length}`);
  assert.ok(new Set(r.candidates.map((c) => c.topic)).size >= 3, 'no single-topic collapse');
});

test('ledger: append/list/decide/approve roundtrip, dup ids + unknown ids fail loud', async () => {
  const f = tmpLedger();
  const accts = [acctPersona('led0'), acctPersona('led1')];
  const r = await buildContentPool({ accounts: accts, perAccount: 2, seed: 'led' });
  assert.deepEqual(readLedger(f), []);
  const add = appendCandidates(f, r.candidates);
  assert.equal(add.added, r.candidates.length);
  assert.equal(readLedger(f).length, r.candidates.length);
  assert.throws(() => appendCandidates(f, [r.candidates[0]]), /duplicate ids/);
  const row = decideReview(f, r.candidates[0].id, 'approved');
  assert.equal(row.status, 'approved');
  assert.ok(row.decidedAt);
  assert.throws(() => decideReview(f, 'cc-nope', 'approved'), /unknown id/);
  assert.throws(() => decideReview(f, r.candidates[1].id, 'maybe'), /must be approved\|rejected/);
  const pool = approvedPool(f);
  assert.equal(pool.length, 1);
  assert.equal(pool[0].id, r.candidates[0].id);
  assert.equal(fs.existsSync(`${f}.tmp-${process.pid}`), false, 'atomic write leaves no tmp');
});

test('content-cli: generate → review approve → stats roundtrip (spawn, tmp ledger)', async () => {
  const { spawnSync } = await import('node:child_process');
  const cli = path.resolve(import.meta.dirname, '../../apps/worker/src/content-cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ccontent-'));
  const ledger = path.join(dir, 'ledger.jsonl');
  const a = acctId('cli0'); const b = acctId('cli1');
  const gen = spawnSync(process.execPath, [cli, 'generate', '--accounts', `${a},${b}`, '--per', '3', '--seed', 'cli-1', '--ledger', ledger], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);
  assert.match(gen.stdout, /cc-/);
  assert.match(gen.stdout, /mode=template accepted=/);
  const rows = readLedger(ledger);
  assert.equal(rows.length, 6);
  const ls = spawnSync(process.execPath, [cli, 'review', 'list', '--ledger', ledger], { encoding: 'utf8' });
  assert.equal(ls.status, 0);
  assert.equal(ls.stdout.split('\n').filter((l) => l.includes('pending')).length, 6);
  const ap = spawnSync(process.execPath, [cli, 'review', 'approve', rows[0].id, '--ledger', ledger], { encoding: 'utf8' });
  assert.equal(ap.status, 0, ap.stderr);
  assert.match(ap.stdout, /approved/);
  const bad = spawnSync(process.execPath, [cli, 'review', 'approve', 'cc-missing', '--ledger', ledger], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown id/);
  const st = spawnSync(process.execPath, [cli, 'stats', '--ledger', ledger], { encoding: 'utf8' });
  assert.equal(st.status, 0);
  assert.match(st.stdout, /"approved":1/);
  const ledger2 = path.join(dir, 'ledger2.jsonl');
  const gen2 = spawnSync(process.execPath, [cli, 'generate', '--accounts', `${a},${b}`, '--per', '3', '--seed', 'cli-1', '--ledger', ledger2], { encoding: 'utf8' });
  assert.equal(gen2.status, 0, gen2.stderr);
  assert.deepEqual(readLedger(ledger2).map((r) => r.text), readLedger(ledger).map((r) => r.text));
});
