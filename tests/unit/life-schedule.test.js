/**
 * 行為引擎 S1 unit — life schedule engine (ADR-035).
 * Statistical claims are tested as SEEDED PROPERTIES (deterministic sweeps),
 * never one-shot flaky distributions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { generatePersona } from '../../packages/shared/src/account-persona.js';
import {
  LIFE_ACTION_TYPES, HK_HOLIDAYS, holidayFor, HK_OCCUPATIONS, HK_INTERESTS,
  TOPIC_AFFINITY, deriveLifeProfile, pickTopic, pickStyle, CONTENT_STYLES,
  travelSpec, ageMultiplier, generateLifePlan, KIND_MULTIPLIER,
} from '../../packages/shared/src/life-schedule.js';
import { makeRng } from '../../packages/shared/src/fingerprint-profile.js';

const BIND = { deferred: true };
const START = Date.UTC(2026, 10, 8, 16, 0, 0); // 2026-11-09T00:00Z = 08:00 HKT Mon
// valid Crockford ids, deterministic per logical tag
const acctIdOf = (tag) => `acct-${makeRng(`wa-life-test|${tag}`).code(10)}`;
const personaOf = (tag, region = 'hk') => generatePersona(acctIdOf(tag), { role: 'farm', region, bindings: BIND });
const localHourF = (e) => Number(e.local.slice(11, 13)) + Number(e.local.slice(14, 16)) / 60;
const ACTION_EV = (p) => p.events.filter((e) => !['active-window', 'travel-silent'].includes(e.type));

test('closed sets + pool integrity (affinity keys ⊆ pools)', () => {
  assert.deepEqual([...LIFE_ACTION_TYPES].sort(), ['active-window', 'browse', 'comment', 'follow', 'like', 'post', 'travel-silent']);
  assert.deepEqual([...CONTENT_STYLES].sort(), ['cantonese', 'en', 'written']);
  const pool = new Set([...HK_OCCUPATIONS, ...HK_INTERESTS]);
  for (const [topic, aff] of Object.entries(TOPIC_AFFINITY)) {
    for (const k of Object.keys(aff)) assert.ok(pool.has(k), `topic ${topic}: affinity key '${k}' not in occupation/interest pools`);
  }
});

test('holidayFor: embedded table coverage, fail-closed outside', () => {
  assert.equal(holidayFor('2026-10-01'), 'National Day');
  assert.equal(holidayFor('2026-11-11'), null);
  assert.equal(holidayFor('2027-12-27'), 'Christmas Day (replacement)');
  assert.throws(() => holidayFor('2025-10-01'), RangeError);
  assert.throws(() => holidayFor('2028-01-01'), RangeError);
  assert.equal(holidayFor('2025-10-01', { strict: false }), null);
  for (const d of ['2026-02-17', '2026-02-18', '2026-02-19']) assert.match(HK_HOLIDAYS[d], /Lunar New Year/);
});

test('deriveLifeProfile: deterministic, pool-bound, overrides honoured + validated', () => {
  const id = acctIdOf('derive-aaa');
  assert.deepEqual(deriveLifeProfile(id), deriveLifeProfile(id));
  const a = deriveLifeProfile(id);
  assert.ok(HK_OCCUPATIONS.includes(a.occupation));
  assert.ok(a.interests.length >= 1);
  for (const it of a.interests) assert.ok(HK_INTERESTS.includes(it));
  const o = deriveLifeProfile(id, { hk: { life: { occupation: '护士', interests: ['宠物'] } } });
  assert.equal(o.occupation, '护士');
  assert.deepEqual(o.interests, ['宠物']);
  assert.throws(() => deriveLifeProfile(id, { hk: { life: { occupation: '太空人' } } }), /not in pool/);
  assert.throws(() => deriveLifeProfile(id, { hk: { life: { interests: ['打邊爐'] } } }), /not in pool/);
  assert.throws(() => deriveLifeProfile(''), /accountId required/);
});

test('plan determinism: same inputs byte-equal; different seed differs', () => {
  const p = personaOf('det-1');
  const x = generateLifePlan({ accountId: p.accountId, persona: p, days: 7, startMs: START, seed: 's1' });
  const y = generateLifePlan({ accountId: p.accountId, persona: p, days: 7, startMs: START, seed: 's1' });
  assert.deepEqual(x, y);
  const z = generateLifePlan({ accountId: p.accountId, persona: p, days: 7, startMs: START, seed: 's2' });
  assert.notDeepEqual(x.events.map((e) => e.epochMs), z.events.map((e) => e.epochMs));
});

test('plan shape: sorted, closed-set types, ISO/local consistency, no midnight spill', () => {
  for (let i = 0; i < 12; i++) {
    const p = personaOf(`shape-${i}`);
    p.hk.life.travelPattern = 'none';
    const plan = generateLifePlan({ accountId: p.accountId, persona: p, days: 5, startMs: START, seed: `shape-${i}` });
    let prev = -Infinity;
    for (const [idx, e] of plan.events.entries()) {
      assert.equal(e.index, idx);
      assert.ok(e.epochMs >= prev, 'sorted by ts'); prev = e.epochMs;
      assert.ok(LIFE_ACTION_TYPES.includes(e.type), `type ${e.type}`);
      assert.equal(e.ts, new Date(e.epochMs).toISOString());
      assert.equal(e.local, new Date(e.epochMs + 480 * 60_000).toISOString().slice(0, 19).replace('T', ' '));
      const h = localHourF(e);
      assert.ok(h >= 6 && h < 24, `event at local hour ${h.toFixed(2)}`);
      if (e.type !== 'travel-silent') assert.ok(plan.days.some((d) => e.local.startsWith(d.day)), 'event inside its planned local day');
    }
  }
});

test('circadian discipline: bimodal peaks, afternoon lull, zero night events', () => {
  const hours = [];
  for (let i = 0; i < 40; i++) {
    const p = personaOf(`circ-${i}`);
    p.hk.life.travelPattern = 'none';
    const plan = generateLifePlan({ accountId: p.accountId, persona: p, days: 6, startMs: START, seed: `c-${i}` });
    for (const e of plan.events) hours.push(localHourF(e));
  }
  const share = (lo, hi) => hours.filter((h) => h >= lo && h < hi).length / hours.length;
  assert.ok(share(6, 11) > 0.2, `morning peak mass ${share(6, 11).toFixed(2)}`);
  assert.ok(share(18, 24) > 0.2, `evening peak mass ${share(18, 24).toFixed(2)}`);
  assert.ok(share(13, 16) < share(7, 10.5), 'afternoon lull below morning peak band');
});

test('holiday rhythm shift: CNY mean active hour later than plain weekday', () => {
  const meanActiveHour = (startMs, seedTag) => {
    const h = [];
    for (let i = 0; i < 25; i++) {
      const p = personaOf(`hol-${i}`);
      p.hk.life.travelPattern = 'none';
      const plan = generateLifePlan({ accountId: p.accountId, persona: p, days: 1, startMs, seed: `${seedTag}-${i}` });
      for (const e of plan.events) h.push(localHourF(e));
    }
    return h.reduce((a, b) => a + b, 0) / h.length;
  };
  const weekday = meanActiveHour(Date.UTC(2026, 2, 2, 16), 'wd'); // Wed 2026-03-04 HKT
  const cny = meanActiveHour(Date.UTC(2026, 1, 17, 16), 'cny');   // 2026-02-18 = CNY(2)
  assert.ok(cny > weekday + 0.15, `holiday shift expected: cny=${cny.toFixed(2)} wd=${weekday.toFixed(2)}`);
});

test('weekend intensity > weekday intensity (travelless sweep)', () => {
  let wk = 0, wkd = 0, wkN = 0, wkdN = 0;
  for (let i = 0; i < 30; i++) {
    const p = personaOf(`wknd-${i}`);
    p.hk.life.travelPattern = 'none';
    const a = generateLifePlan({ accountId: p.accountId, persona: p, days: 7, startMs: START, seed: `w-${i}` });
    for (const d of a.days) {
      const n = Object.values(d.counts).reduce((x, y) => x + y, 0);
      if (d.kind === 'weekday') { wk += n; wkN++; } else if (d.kind === 'weekend') { wkd += n; wkdN++; }
    }
  }
  const perWk = wk / wkN, perWkd = wkd / wkdN;
  assert.ok(perWkd > perWk * 1.08, `weekend day-mean (${perWkd.toFixed(1)}) should exceed weekday (${perWk.toFixed(1)})`);
  assert.ok(KIND_MULTIPLIER.weekend > KIND_MULTIPLIER.weekday);
});

test('travel silence: spans within spec, zero non-marker events inside, resume after return', () => {
  const sweep = (pattern, count, days) => {
    const spans = [];
    for (let i = 0; i < count; i++) {
      const p = personaOf(`trv-${pattern}-${i}`);
      p.hk.life.travelPattern = pattern;
      const plan = generateLifePlan({ accountId: p.accountId, persona: p, days, startMs: START, seed: `t-${pattern}-${i}` });
      for (const w of plan.meta.travelWindows) {
        spans.push(w.silentDays);
        const [lo, hi] = travelSpec(pattern).span;
        assert.ok(w.silentDays >= lo && w.silentDays <= hi, `span ${w.silentDays} outside ${pattern} [${lo},${hi}]`);
        const untilMs = Date.parse(w.until);
        const fromMs = Date.parse(w.from);
        let markers = 0;
        for (const e of plan.events) {
          if (e.epochMs >= fromMs && e.epochMs < untilMs) {
            if (e.type === 'travel-silent') markers++;
            else assert.fail(`event ${e.type} inside silence window ${w.from}..${w.until}`);
          }
        }
        assert.equal(markers, 1, 'exactly one departure marker per window');
        // discipline: NO events at all inside silence except the marker; and
        // every marker of the plan lives inside SOME window
        assert.equal(
          plan.events.filter((e) => e.type === 'travel-silent' && e.epochMs >= fromMs).length,
          plan.meta.travelWindows.filter((x) => Date.parse(x.from) >= fromMs).length,
          'markers only at window starts');
      }
      for (const d of plan.days) if (d.silent) assert.deepEqual(d.counts, {});
    }
    return spans;
  };
  const jp = sweep('jp-quarterly', 15, 90);
  assert.ok(jp.length >= 5 && jp.every((s) => s >= 3 && s <= 7), `3–7d discipline (jp) got ${jp}`);
  const sea = sweep('sea-half-year', 20, 90);
  assert.ok(sea.length >= 3 && sea.every((s) => s >= 3 && s <= 7), `3–7d discipline (sea) got ${sea}`);
  const sz = sweep('shenzhen-weekly', 10, 30);
  assert.ok(sz.every((s) => s >= 1 && s <= 2), `shenzhen documented exception 1–2d got ${sz}`);
});

test('travel pattern none → zero silence markers; unknown pattern throws', () => {
  let found = false;
  for (let i = 0; i < 40 && !found; i++) {
    const p = personaOf(`none-${i}`);
    if (p.hk.life.travelPattern === 'none') {
      const plan = generateLifePlan({ accountId: p.accountId, persona: p, days: 30, startMs: START, seed: 'n' });
      assert.equal(plan.meta.travelWindows.length, 0);
      assert.equal(plan.events.filter((e) => e.type === 'travel-silent').length, 0);
      found = true;
    }
  }
  assert.ok(found, 'pool should surface travelPattern=none within 40 ids');
  assert.equal(travelSpec('none'), null);
  assert.throws(() => travelSpec('mars-daily'), /unknown travelPattern/);
});

test('age curve: sprint decays to floor; plan-level young>old dominance', () => {
  assert.ok(ageMultiplier(0) > ageMultiplier(7));
  assert.ok(Math.abs(ageMultiplier(14) - 1.0) < 1e-9);
  let prev = ageMultiplier(14);
  for (const age of [30, 60, 120, 365, 730]) {
    const m = ageMultiplier(age);
    assert.ok(m <= prev + 1e-9 && m >= 0.75 - 1e-9);
    prev = m;
  }
  assert.equal(ageMultiplier(10_000), 0.75);
  assert.throws(() => ageMultiplier(-1), RangeError);
  let youngWins = 0;
  for (let i = 0; i < 20; i++) {
    const p = personaOf(`age-${i}`);
    p.hk.life.travelPattern = 'none';
    p.hk.life.social.postingCadence = 'regular';
    const base = { accountId: p.accountId, persona: p, days: 3, startMs: START, seed: `a-${i}` };
    const nY = ACTION_EV(generateLifePlan({ ...base, accountAgeDays: 0 })).length;
    const nO = ACTION_EV(generateLifePlan({ ...base, accountAgeDays: 400 })).length;
    if (nY > nO) youngWins++;
  }
  assert.ok(youngWins >= 14, `young should out-plan old in most cases (${youngWins}/20)`);
});

test('cross-account independence: shared seed, distinct accounts → distinct streams + spread', () => {
  const plans = [];
  for (let i = 0; i < 10; i++) {
    const p = personaOf(`ind-${i}`);
    p.hk.life.travelPattern = 'none';
    plans.push(generateLifePlan({ accountId: p.accountId, persona: p, days: 7, startMs: START, seed: 'shared-seed' }));
  }
  const digests = new Set(plans.map((pl) => pl.events.map((e) => `${e.epochMs}:${e.type}`).join('|')));
  assert.equal(digests.size, 10, 'all-unique event streams expected');
  for (let evIdx = 0; evIdx < 3; evIdx++) {
    const firsts = plans.map((pl) => pl.events.filter((e) => e.type === 'active-window')[evIdx]?.ts).filter(Boolean);
    assert.ok(new Set(firsts).size >= 8, `fleet must not share a peak minute (got ${new Set(firsts).size}/${firsts.length})`);
  }
  const day1 = plans.map((pl) => Object.values(pl.days[0].counts).reduce((a, b) => a + b, 0));
  assert.ok(new Set(day1).size >= 4, `per-account activity spread expected, got ${day1}`);
});

test('pickTopic honours affinity: chef+cooking → food topic over-weighted, no collapse', () => {
  const profile = { occupation: '厨师', interests: ['煮嘢食'], jitter: { morning: 0, evening: 0 } };
  const rng = makeRng('topic-test');
  const seen = {};
  for (let i = 0; i < 3000; i++) { const t = pickTopic(profile, rng); seen[t] = (seen[t] ?? 0) + 1; }
  assert.ok(seen['food-restaurant'] > 3000 * 0.35, `food over-weight expected, got ${seen['food-restaurant']}/3000`);
  assert.ok(Object.keys(seen).length >= 5, 'no topic collapse (all topics reachable)');
  assert.throws(() => pickTopic(profile, rng, ['nonexistent']), /unknown topic/);
});

test('pickStyle: persona languageMix drives mix', () => {
  const rng = makeRng('style-test');
  const en = { written: 0, cantonese: 0, en: 0 };
  const zh = { written: 0, cantonese: 0, en: 0 };
  for (let i = 0; i < 3000; i++) { en[pickStyle('en-dominant', rng)]++; zh[pickStyle('zh-Hant-dominant', rng)]++; }
  assert.ok(en.en > 1500, `en-dominant skews en, got ${en.en}`);
  assert.ok(zh.written + zh.cantonese > 2400, `zh-dominant skews chinese, got ${zh.written + zh.cantonese}`);
  assert.throws(() => pickStyle('klingon', rng), /unknown languageMix/);
});

test('input validation: fail-closed on missing seed/days/topics', () => {
  assert.throws(() => generateLifePlan({ accountId: 'x', seed: 's', startMs: START, days: 0 }), RangeError);
  assert.throws(() => generateLifePlan({ accountId: 'x', startMs: START, days: 3 }), /seed required/);
  assert.throws(() => generateLifePlan({ seed: 's', days: 3 }), /accountId required/);
  assert.throws(() => generateLifePlan({ accountId: 'x', seed: 's', days: 3, startMs: START, contentTopics: [] }), /non-empty/);
  assert.throws(() => generateLifePlan({ accountId: 'x', seed: 's', days: 3, startMs: START, contentTopics: ['nope'] }), /unknown topic/);
});

test('holiday days flagged in summaries; kind labelling correct', () => {
  const p = personaOf('holflag');
  p.hk.life.travelPattern = 'none';
  // 2026-10-01 (Thu, National Day): horizon starts 2026-09-30 00:00 HKT (= 09-29T16Z)
  const plan = generateLifePlan({ accountId: p.accountId, persona: p, days: 3, startMs: Date.UTC(2026, 8, 29, 16), seed: 'hf' });
  assert.deepEqual(plan.days.map((d) => d.kind), ['weekday', 'holiday', 'weekday']);
  assert.match(plan.days[1].holiday, /National Day/);
  assert.equal(plan.days[0].holiday, null);
});
