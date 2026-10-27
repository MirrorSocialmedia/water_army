/**
 * GAcct 段4 unit — randomised registration scheduler + action delay.
 * Statistical claims are tested as SEEDED PROPERTIES (deterministic runs of
 * many seeds), never as flaky one-shot distributions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseWindow,
  planRegistrationSchedule,
  actionDelay,
  SCHEDULE_TZ_OFFSET_MINUTES,
} from '../../packages/shared/src/account-schedule.js';

const START = Date.UTC(2026, 10, 3, 16, 0, 0); // 2026-11-04T00:00Z = 08:00 HKT (fully daytime window start)

const localHour = (ev) => Math.floor(((ev.epochMs + SCHEDULE_TZ_OFFSET_MINUTES * 60_000) % 86400_000) / 3600_000);

test('parseWindow: units + errors', () => {
  assert.equal(parseWindow('24h'), 86400);
  assert.equal(parseWindow('90m'), 5400);
  assert.equal(parseWindow('3600s'), 3600);
  assert.equal(parseWindow(7200), 7200);
  assert.throws(() => parseWindow('tomorrow'));
  assert.throws(() => parseWindow('0h'));
});

test('plan: seeded determinism — same {count,window,seed,start} replays byte-equal', () => {
  const a = planRegistrationSchedule({ count: 10, window: '24h', seed: 'X1', start: START });
  const b = planRegistrationSchedule({ count: 10, window: '24h', seed: 'X1', start: START });
  assert.deepEqual(a, b);
  const c = planRegistrationSchedule({ count: 10, window: '24h', seed: 'X2', start: START });
  assert.notDeepEqual(a.events.map((e) => e.epochMs), c.events.map((e) => e.epochMs));
});

test('plan: bounds, ordering, minimum gap (200 runs across seeds)', () => {
  for (let s = 0; s < 40; s++) {
    const { events } = planRegistrationSchedule({ count: 10, window: '24h', seed: `g${s}`, start: START, minGapMinutes: 15 });
    assert.equal(events.length, 10);
    for (let i = 0; i < events.length; i++) {
      assert.ok(events[i].epochMs >= START && events[i].epochMs < START + 86400_000, 'inside window');
      if (i > 0) {
        assert.ok(events[i].epochMs >= events[i - 1].epochMs, 'sorted');
        assert.ok(events[i].epochMs - events[i - 1].epochMs >= 15 * 60_000 - 1, 'min gap held');
      }
    }
  }
});

test('plan: night avoidance — zero events in local [0,7) across a week of seeds', () => {
  for (let s = 0; s < 30; s++) {
    const { events, meta } = planRegistrationSchedule({ count: 8, window: '7d', seed: `n${s}`, start: START, minGapMinutes: 10 });
    assert.equal(meta.relaxed.length, 0, `unexpected relaxation: ${meta.relaxed}`);
    for (const ev of events) {
      const h = localHour(ev);
      assert.ok(h >= 7, `event at local hour ${h} inside night band`);
    }
  }
});

test('plan: allowNight genuinely opens the night band (some night events appear)', () => {
  let night = 0;
  for (let s = 0; s < 30; s++) {
    const { events } = planRegistrationSchedule({ count: 12, window: '7d', seed: `f${s}`, start: START, minGapMinutes: 5, avoidNight: false });
    for (const ev of events) if (localHour(ev) < 7) night++;
  }
  assert.ok(night > 0, 'free-fall sampling must hit night hours over 7d×30 seeds');
});

test('plan: statistical spread — events are NOT clumped (seeded property, 12 seeds)', () => {
  const firstRel = [];
  for (let s = 0; s < 12; s++) {
    const { events } = planRegistrationSchedule({ count: 10, window: '24h', seed: `sp${s}`, start: START, minGapMinutes: 10 });
    firstRel.push((events[0].epochMs - START) / 86400_000);
    const lastRel = (events.at(-1).epochMs - START) / 86400_000;
    assert.ok(lastRel - firstRel.at(-1) > 0.3, 'span must cover a good chunk of the window');
  }
  // randomness of the first event: spread across the (daytime) window, not pinned
  assert.ok(Math.max(...firstRel) - Math.min(...firstRel) > 0.15, `first-event spread too tight: ${firstRel}`);
  // distinct seeds never coincide
  assert.equal(new Set(firstRel).size, firstRel.length);
});

test('plan: graded relaxation is LOUD (never silent) when capacity is tight', () => {
  // 2h window × 100 events × 15min gap cannot fit daytime-only silently.
  const { events, meta } = planRegistrationSchedule({ count: 60, window: '2h', seed: 'tight', start: START, minGapMinutes: 15 });
  assert.equal(events.length, 60);
  assert.ok(meta.relaxed.length > 0, 'relaxation must be reported');
  const minSeen = Math.min(...events.slice(1).map((e, i) => e.epochMs - events[i].epochMs));
  assert.ok(minSeen > 60_000, 'still reasonably spaced');
});

test('plan: rejects bad inputs (fail-closed)', () => {
  assert.throws(() => planRegistrationSchedule({ count: 0, seed: 'a' }), RangeError);
  assert.throws(() => planRegistrationSchedule({ count: 5 }), /seed required/);
  assert.throws(() => planRegistrationSchedule({ count: 5, seed: 'a', minGapMinutes: -1 }), RangeError);
});

test('actionDelay: seeded determinism + clamps + lognormal shape', () => {
  assert.equal(actionDelay({ seed: 'k1' }), actionDelay({ seed: 'k1' }));
  assert.notEqual(actionDelay({ seed: 'k1' }), actionDelay({ seed: 'k2' }));
  const samples = [];
  for (let i = 0; i < 2000; i++) {
    const d = actionDelay({ seed: `ad-${i}` });
    assert.ok(d >= 30_000 && d <= 6 * 3600_000, `delay ${d} outside clamp`);
    samples.push(d);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  // lognormal: median ≈ exp(mu) = 90s (±35%), right-skew: mean > median
  assert.ok(median > 55_000 && median < 145_000, `median ${median} off target`);
  assert.ok(mean > median, 'right-skewed distribution expected');
});
