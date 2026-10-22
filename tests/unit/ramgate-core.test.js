/**
 * RAM-G1 — host metrics sampler + pure admission math (hermetic).
 *
 * Covers:
 *   - parseMeminfo / createHostMetrics.sample() on fixture /proc files
 *     (4-gauge conversion: kB → MiB exactly, timestamp, loadavg)
 *   - fail-closed reads (missing MemAvailable / unreadable file)
 *   - resolveRamGateConfig (defaults / patch / env precedence / invalid)
 *   - computeAdmission (the MD formula + reason precedence + A10-shape
 *     scenarios at the real baseline numbers)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  parseMeminfo,
  createHostMetrics,
  RAM_GATE_DEFAULTS,
  RAM_GATE_ENV,
  RAM_GATE_REASON,
  resolveRamGateConfig,
  computeAdmission,
} from '@water-army/shared';

const MEMINFO = `MemTotal:       96439452 kB
MemFree:         2498928 kB
MemAvailable:   30906952 kB
Buffers:          266000 kB
Cached:         29062532 kB
SwapTotal:      8388604 kB
SwapFree:       8333820 kB
`;

test('parseMeminfo — fields parsed as kB numbers, junk tolerated', () => {
  const mi = parseMeminfo(MEMINFO);
  assert.equal(mi.MemAvailable, 30_906_952);
  assert.equal(mi.MemTotal, 96_439_452);
  assert.equal(mi.SwapFree, 8_333_820);
  assert.equal(parseMeminfo('').MemAvailable, undefined);
  assert.equal(parseMeminfo('nonsense').MemAvailable, undefined);
});

test('host metrics — sample(): MiB conversion (1024 kB = 1 MiB) + ts + loadavg', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ramgate-proc-'));
  await fs.writeFile(path.join(dir, 'meminfo'), MEMINFO);
  await fs.writeFile(path.join(dir, 'loadavg'), '3.27 3.26 3.10 1/512 424242\n');
  const t0 = Date.now();
  const m = createHostMetrics({ procDir: dir, now: () => t0 });
  const s = await m.sample();
  assert.equal(s.ts, t0);
  // 30,906,952 kB / 1024 = 30,182.5703125 → rounded 1dp = 30,182.6
  assert.equal(s.memAvailableMiB, 30182.6);
  assert.equal(s.memTotalMiB, 94179.2); // 96,439,452/1024 = 94,179.1523 → 94,179.2
  assert.equal(s.memFreeMiB, 2440.4);
  assert.equal(s.swapTotalMiB, 8192.0);
  assert.equal(s.swapFreeMiB, 8138.5);
  assert.deepEqual(s.loadAvg, [3.27, 3.26, 3.1]);
  assert.equal(s.source, 'proc-meminfo');
  await fs.rm(dir, { recursive: true, force: true });
});

test('host metrics — missing loadavg is display-only (sample still ok)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ramgate-proc-'));
  await fs.writeFile(path.join(dir, 'meminfo'), MEMINFO);
  const m = createHostMetrics({ procDir: dir });
  const s = await m.sample();
  assert.equal(s.memAvailableMiB, 30182.6);
  assert.deepEqual(s.loadAvg, [null, null, null]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('host metrics — MemAvailable missing → throws (gate maps to METRICS_UNAVAILABLE)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ramgate-proc-'));
  await fs.writeFile(path.join(dir, 'meminfo'), 'MemTotal: 1000 kB\n');
  const m = createHostMetrics({ procDir: dir });
  await assert.rejects(() => m.sample(), /MemAvailable missing/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('host metrics — unreadable meminfo → throws (fail-closed input)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ramgate-proc-'));
  const m = createHostMetrics({ procDir: path.join(dir, 'does-not-exist') });
  await assert.rejects(() => m.sample(), /cannot read/);
  await fs.rm(dir, { recursive: true, force: true });
});

// ------------------------------------------------ config resolution

test('resolveRamGateConfig — defaults match the MD constants', () => {
  const r = resolveRamGateConfig(null, {});
  assert.ok(r.ok);
  assert.deepEqual(r.config, {
    enabled: true,
    maxParallel: 10,
    hardFloorMiB: 16384,
    postBootTargetMiB: 18432,
    perBootBudgetMiB: 1200,
    metricsMaxAgeMs: 30_000,
    leaseTtlMs: 86_400_000,
  });
});

test('resolveRamGateConfig — patch merge + env precedence (env > AppSetting > constant)', () => {
  const r = resolveRamGateConfig({ maxParallel: 7, perBootBudgetMiB: 1300 }, {
    [RAM_GATE_ENV.maxParallel]: '5',
    [RAM_GATE_ENV.enabled]: 'false',
  });
  assert.ok(r.ok);
  assert.equal(r.config.maxParallel, 5); // env wins over patch
  assert.equal(r.config.perBootBudgetMiB, 1300); // patch over constant
  assert.equal(r.config.enabled, false);
  assert.equal(r.config.hardFloorMiB, 16384); // constant
});

test('resolveRamGateConfig — invalid values fail closed (ok=false)', () => {
  for (const patch of [{ maxParallel: 0 }, { hardFloorMiB: 10 }, { perBootBudgetMiB: 1 }, { metricsMaxAgeMs: 10 }, { leaseTtlMs: 5 }, { bogus: 1 }]) {
    const r = resolveRamGateConfig(patch, {});
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.ok(r.errors.length > 0);
  }
  const r2 = resolveRamGateConfig(null, { [RAM_GATE_ENV.maxParallel]: 'ten' });
  assert.equal(r2.ok, false);
});

// ------------------------------------------------ pure admission math

const BASE = { maxParallel: 10, hardFloorMiB: 16384, postBootTargetMiB: 18432, perBootBudgetMiB: 1200 };

test('computeAdmission — admit when everything passes (baseline + 0 live)', () => {
  const r = computeAdmission({ currentMiB: 30_000, liveLeases: 0, ...BASE });
  assert.equal(r.admitted, true);
  assert.equal(r.reason, RAM_GATE_REASON.ADMITTED);
  assert.equal(r.projectedMiB, 28_800); // 30000 − 1×1200
});

test('computeAdmission — the 10th device at the G1 baseline (A10-shape)', () => {
  // 9 live leases (=9 devices committed), current = 23:56 baseline 30,182.6
  const low = computeAdmission({ currentMiB: 30_182.6, liveLeases: 9, ...BASE });
  assert.equal(low.admitted, false);
  assert.equal(low.reason, RAM_GATE_REASON.PROJECTED_BELOW_TARGET);
  assert.equal(low.projectedMiB, 18_183); // 30182.6 − 10×1200 = 18182.6 → 18183
  // higher baseline (23:59 sample 30,660.66): the 10th passes
  const high = computeAdmission({ currentMiB: 30_660.7, liveLeases: 9, ...BASE });
  assert.equal(high.admitted, true);
  assert.equal(high.projectedMiB, 18_661);
});

test('computeAdmission — MAX_PARALLEL is the binding constraint at live=10', () => {
  const r = computeAdmission({ currentMiB: 90_000, liveLeases: 10, ...BASE });
  assert.equal(r.admitted, false);
  assert.equal(r.reason, RAM_GATE_REASON.MAX_PARALLEL);
});

test('computeAdmission — BELOW_HARD_FLOOR wins over a fine projection', () => {
  // current below floor → deny even though projected math "looks fine"
  const r = computeAdmission({ currentMiB: 16_000, liveLeases: 0, ...BASE });
  assert.equal(r.admitted, false);
  assert.equal(r.reason, RAM_GATE_REASON.BELOW_HARD_FLOOR);
});

test('computeAdmission — reservations subtract from the projection', () => {
  const withRes = computeAdmission({ currentMiB: 30_000, liveLeases: 0, reservationsMiB: 2000, ...BASE });
  assert.equal(withRes.projectedMiB, 26_800); // 30000 − 1200 − 2000
  assert.equal(withRes.admitted, true);
});

test('computeAdmission — reason precedence: MAX_PARALLEL > FLOOR > PROJECTED', () => {
  assert.equal(computeAdmission({ currentMiB: 5000, liveLeases: 10, ...BASE }).reason, RAM_GATE_REASON.MAX_PARALLEL);
  assert.equal(computeAdmission({ currentMiB: 5000, liveLeases: 5, ...BASE }).reason, RAM_GATE_REASON.BELOW_HARD_FLOOR);
  assert.equal(computeAdmission({ currentMiB: 20_000, liveLeases: 9, ...BASE }).reason, RAM_GATE_REASON.PROJECTED_BELOW_TARGET);
});
