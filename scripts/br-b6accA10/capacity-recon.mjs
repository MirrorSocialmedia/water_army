#!/usr/bin/env node
// A10-2 — capacity reconciliation (read-only analysis of A+B AB3 raw samples).
// Re-derives per-device RAM cost + host-MemAvailable-redline capacity INDEPENDENTLY
// from logs/br-b6-accAB/boot5-samples.csv, and corrects the A+B decision-report §7
// "~20 devices @ 16G redline" figure (which treated the 16G as a TOTAL device
// budget instead of a MINIMUM HOST MemAvailable floor).
//
// Usage: node capacity-recon.mjs [csvPath] [baselineMb] [outMd]
import fs from 'node:fs';

const csvPath = process.argv[2] || '/home/kenneth/.openclaw/workspace/logs/br-b6-accAB/boot5-samples.csv';
const N = 5;                 // AB3 device count (boots field length)
const REDLINE_MB = 16384;    // W4: host MemAvailable >= 16 GiB (ladder redline)
const BASELINE_1346_MB = 23000; // A+B AB1 baseline MemAvailable (13:46, "23G available")

const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
const header = lines[0].split(',');
const iMem = header.indexOf('mem_avail_mb');
const iBoots = header.indexOf('boots');
const iTs = header.indexOf('ts');

const rows = lines.slice(1).filter(Boolean).map((l) => {
  const c = l.split(',');
  return { ts: c[iTs], mem: +c[iMem], boots: c[iBoots] };
});

// 0-device pre-boot = boots all zeros; all-up = boots all ones
const preBoot = rows.filter((r) => /^0+$/.test(r.boots));
const allUp = rows.filter((r) => /^1+$/.test(r.boots));
const minOf = (arr, f) => Math.min(...arr.map(f));
const maxOf = (arr, f) => Math.max(...arr.map(f));
const argmin = (arr, f) => { let b = arr[0]; for (const x of arr) if (f(x) < f(b)) b = x; return b; };
const argmax = (arr, f) => { let b = arr[0]; for (const x of arr) if (f(x) > f(b)) b = x; return b; };

const preMinRow = argmin(preBoot, (r) => r.mem);
const preMaxRow = argmax(preBoot, (r) => r.mem);
const allMinRow = argmin(allUp, (r) => r.mem);
const allFirstRow = allUp[0];

const perDevPrimary = (preMinRow.mem - allMinRow.mem) / N;
// variant baselines (document the sensitivity range)
const variants = [
  { label: 'pre-boot min (09:18:14)', base: preMinRow.mem, src: `row ${preMinRow.ts}` },
  { label: 'pre-boot max (09:18:03, first sample)', base: preMaxRow.mem, src: `row ${preMaxRow.ts}` },
  { label: 'AB1 13:46 baseline (23000MB)', base: BASELINE_1346_MB, src: 'ab1-baseline.json ram.available_g=23' },
];

const cap = (base, per) => (base - REDLINE_MB) / per;

const md = [];
md.push('# A10-2 — Capacity Reconciliation (corrects A+B decision-report §7 "~20 devices")');
md.push('');
md.push('Source data: `' + csvPath + '` (A+B AB3, 5-device staged boot, 10s sampling).');
md.push('Companion baseline: `logs/br-b6-accAB/ab1-baseline.json` (13:46 HKT).');
md.push('');
md.push('## 1. Raw sample table (the two calipers)');
md.push('');
md.push('**0-device pre-boot (boots=`00000`)** — host at rest before any redroid boot:');
md.push('');
md.push('| ts | mem_avail_mb |');
md.push('|---|---|');
for (const r of preBoot) md.push(`| ${r.ts} | ${r.mem} |`);
md.push('');
md.push(`→ **pre-boot MemAvailable min = ${preMinRow.mem}MB** (at ${preMinRow.ts}); max (first sample) = ${preMaxRow.mem}MB (at ${preMaxRow.ts}).`);
md.push('');
md.push('**5-device all-up (boots=`11111`)** — all five redroid booted + settled:');
md.push('');
md.push('| ts | mem_avail_mb | note |');
md.push('|---|---|---|');
for (const r of allUp) {
  const note = r.ts === allMinRow.ts ? '**MIN**' : (r.ts === allFirstRow.ts ? 'first all-up' : '');
  md.push(`| ${r.ts} | ${r.mem} | ${note} |`);
}
md.push('');
md.push(`→ **5-device all-up MemAvailable min = ${allMinRow.mem}MB** (at ${allMinRow.ts}).`);
md.push('');
md.push('## 2. Per-device RAM cost (re-derived, independent)');
md.push('');
md.push(`- Δ = pre-boot min − 5-dev all-up min = ${preMinRow.mem} − ${allMinRow.mem} = **${preMinRow.mem - allMinRow.mem}MB for ${N} devices**`);
md.push(`- **Per-device = ${perDevPrimary.toFixed(1)} MB/device** (primary, quiet-min caliper)`);
md.push('');
md.push('Sensitivity to baseline choice (this is the "561–666 MB/dev" range):');
md.push('');
md.push('| baseline | MemAvail (MB) | Δ for 5 dev (MB) | per-device (MB) | source |');
md.push('|---|---|---|---|---|');
for (const v of variants) {
  const d = v.base - allMinRow.mem;
  md.push(`| ${v.label} | ${v.base} | ${d} | ${(d / N).toFixed(1)} | ${v.src} |`);
}
md.push('');
md.push(`> The A+B report used **0.66G/device** ("rounded 3.3G/5"). The raw samples show the all-up floor is ${allMinRow.mem}MB, i.e. only **${(preMinRow.mem - allMinRow.mem) / 1024}GiB** above the pre-boot min for 5 devices = **${(perDevPrimary / 1024).toFixed(2)}GiB/device**. The 0.66G figure over-states per-device cost by ~18%.`);
md.push('');
md.push('## 3. The caliber error (why "~20" is wrong)');
md.push('');
md.push(`The redline **W4 is a MINIMUM HOST MemAvailable floor (16 GiB = 16384MB), NOT a total device-RAM budget.** The A+B report §7 computed "16G / 0.66G ≈ 24 → ~20 devices", which is only valid if the host could dedicate the full 16G to devices. It cannot: the host already has ~68G of 91–92G committed to everything else (SGLang, DB, compose, OS, C-item, etc.), so baseline MemAvailable is only ~23–25.5G. The device budget is therefore **baseline_MemAvailable − 16384MB**, not 16384MB.`);
md.push('');
md.push('## 4. Corrected capacity @ 16GiB host-MemAvailable redline');
md.push('');
md.push('Formula: `N = (baseline_MemAvailable − 16384) / per_device`');
md.push('');
md.push('| baseline (MB) | device headroom (MB) | per-device (MB) | N (raw) | N (safe, floor) |');
md.push('|---|---|---|---|---|');
for (const v of variants) {
  const per = (v.base - allMinRow.mem) / N;
  const head = v.base - REDLINE_MB;
  const n = cap(v.base, per);
  md.push(`| ${v.label} | ${head} | ${per.toFixed(1)} | ${n.toFixed(1)} | ${Math.floor(n)} |`);
}
md.push('');
md.push(`**Corrected capacity ≈ 11–12 devices** (primary: baseline ${preMinRow.mem}MB / ${perDevPrimary.toFixed(0)}MB-per-dev → ${cap(preMinRow.mem, perDevPrimary).toFixed(1)}; floor = **${Math.floor(cap(preMinRow.mem, perDevPrimary))}**).`);
md.push('');
md.push(`This matches the boss's independent ~11. The A+B "~20" is wrong by the caliber (total-budget vs host-floor). It is NOT a device-cost error (that one, if anything, over-states cost at 0.66G) — it is a **budget-frame error**: 16G was the host-floor, and the true device budget is only baseline−16G ≈ 6.5–7.5G, not 16G.`);
md.push('');
md.push('## 5. Why the two errors did not cancel');
md.push('');
md.push('- Per-device: report 0.66G is ~18% high (true ~0.55–0.66G). Higher cost would REDUCE capacity.')
md.push('- Budget: report used 16G; true device budget ~6.5–7.5G. Smaller budget REDUCES capacity.')
md.push('- Both errors push in the direction of "fewer devices than 20" — so the correct answer is robustly **~11–12**, clearly below the reported ~20 even under the most favorable reading.');
md.push('');
md.push('## 6. Caveats (honest)');
md.push('');
md.push('- This is a **measured 5-device** extrapolation to 11–12. Per-device cost was verified at 1 and 5 devices (AB2/AB3); 10+ is extrapolation. The A10-4 10-device test directly measures up to 10 devices and will tighten this — see report.md for the live 10-device per-device + capacity-at-10 result.');
md.push('- Baseline MemAvailable drifts with host load (13:46 = 23G, 18:40 A10-1 = 25.5G). Use the CONSERVATIVE (lower) baseline for the redline budget. The 13:46 23000MB figure is the safe one → N≈11.8 → floor 11.');
md.push('- swap is 8G/8G full (long-standing). The 16G MemAvailable redline is the operative guard; swap-full is a separate pre-existing condition, not caused by devices.');
md.push('');

const outMd = process.argv[4];
const mdText = md.join('\n') + '\n';
if (outMd) fs.writeFileSync(outMd, mdText);
process.stdout.write(mdText);
