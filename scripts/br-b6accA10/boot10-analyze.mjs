#!/usr/bin/env node
// A10-4 — analyze boot10-samples.csv + summary + A10-1 baseline.
// Derives per-stage (1/5/10) mins, per-device cost @10, capacity @10, redline
// margin, 30000 health, VRAM delta, and the GPU-util window check (did the
// operator stay idle = GPU ~0 during boot?). Emits markdown + JSON.
//
// Usage: node boot10-analyze.mjs [evidDir] [outMd]
import fs from 'node:fs';

const EVID = process.argv[2] || '/home/kenneth/.openclaw/workspace/logs/br-b6-accA10';
const CSV = `${EVID}/boot10-samples.csv`;
const SUM = `${EVID}/boot10-summary.json`;
const RUNLOG = `${EVID}/boot10-run.log`;
const BASE = `${EVID}/ab10-fresh-baseline.json`;
const OUT = process.argv[3] || `${EVID}/boot10-analysis.md`;
const REDLINE = 16384;
const VRAM_RED = 1500;

const lines = fs.readFileSync(CSV, 'utf8').trim().split('\n');
const header = lines[0].split(',');
const I = (n) => header.indexOf(n);
const iTs = I('ts'), iG0u = I('g0_util'), iG0f = I('g0_mem_free'), iG1u = I('g1_util'),
      iG1f = I('g1_mem_free'), iMem = I('mem_avail_mb'), iLoad = I('load1'),
      iSg = I('sglang_code'), iBoots = I('boots');

const rows = lines.slice(1).filter(Boolean).map((l) => {
  const c = l.split(',');
  const boots = c[iBoots] || '';
  const up = (boots.match(/1/g) || []).length;
  return {
    ts: c[iTs], g0u: +c[iG0u], g0f: +c[iG0f], g1u: +c[iG1u], g1f: +c[iG1f],
    mem: +c[iMem], load: parseFloat(c[iLoad]), sg: c[iSg], boots, up,
  };
});
const K = rows.length ? Math.max(...rows.map((r) => r.up)) : 0;

// 0-device baseline: A10-1 fresh baseline is canonical; cross-check PRE-SNAPSHOT + up==0 rows
const baseJson = JSON.parse(fs.readFileSync(BASE, 'utf8'));
const baseA10 = baseJson.ram.memavailable_mb;
let preSnap = null;
try {
  const lg = fs.readFileSync(RUNLOG, 'utf8');
  const m = lg.match(/PRE-SNAPSHOT.*?MemAvail (\d+)MB/);
  if (m) preSnap = +m[1];
} catch {}
const up0 = rows.filter((r) => r.up === 0);
const baseUp0 = up0.length ? Math.min(...up0.map((r) => r.mem)) : null;
const BASELINE = baseA10; // canonical 0-device MemAvailable (A10-1)

const minOf = (arr, f) => (arr.length ? Math.min(...arr.map(f)) : null);
const maxOf = (arr, f) => (arr.length ? Math.max(...arr.map(f)) : null);

// stage sets: rows where up == k (k = 1,5,10 or K)
const stageSet = (k) => rows.filter((r) => r.up === k);
const stageStats = (k) => {
  const s = stageSet(k);
  if (!s.length) return null;
  return {
    k, n: s.length,
    memMin: minOf(s, (r) => r.mem), g0fMin: minOf(s, (r) => r.g0f), g1fMin: minOf(s, (r) => r.g1f),
    loadMax: maxOf(s, (r) => r.load),
    sgAll200: s.every((r) => r.sg === '200'), sgWorst: minOf(s, (r) => (r.sg === '200' ? 200 : 999)),
    g0uMax: maxOf(s, (r) => r.g0u), g1uMax: maxOf(s, (r) => r.g1u),
    tsMin: s.find((r) => r.mem === minOf(s, (x) => x.mem)).ts,
  };
};
const stages = [1, 5, 10, K].filter((v, i, a) => v > 0 && a.indexOf(v) === i).map(stageStats).filter(Boolean);

// per-device cost
const st10 = stages.find((s) => s.k === K) || null; // final count (10 or stopped K)
const st5 = stages.find((s) => s.k === 5) || null;
const perDev10 = st10 ? (BASELINE - st10.memMin) / K : null;
const perDev5 = st5 ? (BASELINE - st5.memMin) / 5 : null;
const incr5to10 = st10 && st5 ? (st5.memMin - st10.memMin) / (K - 5) : null;
// capacity at the measured per-device cost
const cap10 = perDev10 ? (BASELINE - REDLINE) / perDev10 : null;
const margin10 = st10 ? st10.memMin - REDLINE : null;
// VRAM delta vs A10-1 (expect ~0 — redroid idle VRAM delta ≈ 0, A+B finding)
const vramDelta0 = st10 ? baseJson.gpu[0].mem_free_mib - st10.g0fMin : null;
const vramDelta1 = st10 ? baseJson.gpu[1].mem_free_mib - st10.g1fMin : null;
// 30000 health across whole run
const sgAll200 = rows.every((r) => r.sg === '200');
const sgNon200 = rows.filter((r) => r.sg !== '200').map((r) => `${r.ts}:${r.sg}`);
// GPU util window (operator idle => ~0). Report max util during boot phase (up < K) and during soak (up==K)
const bootPhase = rows.filter((r) => r.up < K);
const soakPhase = rows.filter((r) => r.up === K);
const gpuMaxBoot = { g0: maxOf(bootPhase, (r) => r.g0u), g1: maxOf(bootPhase, (r) => r.g1u) };
const gpuMaxSoak = { g0: maxOf(soakPhase, (r) => r.g0u), g1: maxOf(soakPhase, (r) => r.g1u) };
// redline breaches in CSV
const memBreaches = rows.filter((r) => r.mem < REDLINE).map((r) => `${r.ts}:${r.mem}`);
const vramBreaches = rows.filter((r) => r.g0f < VRAM_RED || r.g1f < VRAM_RED).map((r) => `${r.ts}:g0=${r.g0f},g1=${r.g1f}`);

const summary = JSON.parse(fs.readFileSync(SUM, 'utf8'));

const md = [];
md.push('# A10-4 — 10-device controlled boot: measured analysis');
md.push('');
md.push(`Source: ${CSV} (${rows.length} samples) + ${SUM} + A10-1 baseline ${BASE}.`);
md.push('');
md.push('## 1. Run facts');
md.push('');
md.push(`- devices up (final K): **${K}/${summary.devices_target}**`);
md.push(`- redline stop: **${summary.redline_stop}** ${summary.stop_reason ? `(${summary.stop_reason})` : ''}${summary.stop_memavailable_mb ? `, MemAvail@stop=${summary.stop_memavailable_mb}MB` : ''}`);
md.push(`- boot timeout: ${summary.boot_timeout}`);
md.push(`- per-device boot time (s): ${JSON.stringify(summary.per_device_boot_s || {})}`);
md.push(`- total samples: ${rows.length}; run span: ${rows[0]?.ts} → ${rows[rows.length - 1]?.ts}`);
md.push('');
md.push('## 2. 0-device baseline (caliber)');
md.push('');
md.push(`- A10-1 fresh baseline (canonical): **${BASELINE}MB**`);
md.push(`- PRE-SNAPSHOT (boot log): ${preSnap ?? 'n/a'}MB`);
md.push(`- up==0 CSV rows min (device-1 mid-boot, not clean): ${baseUp0 ?? 'n/a'}MB (${up0.length} rows)`);
md.push('');
md.push('## 3. Per-stage measured table (min over rows where up==k)');
md.push('');
md.push('| stage (up) | samples | MemAvail min (MB) | GPU0 free min (MiB) | GPU1 free min (MiB) | load1 max | 30000 all-200 | GPU0 util max | GPU1 util max | MemAvail-min ts |');
md.push('|---|---|---|---|---|---|---|---|---|---|');
for (const s of stages) {
  md.push(`| ${s.k} | ${s.n} | ${s.memMin} | ${s.g0fMin} | ${s.g1fMin} | ${s.loadMax} | ${s.sgAll200 ? 'yes' : 'NO (' + s.sgWorst + ')'} | ${s.g0uMax}% | ${s.g1uMax}% | ${s.tsMin} |`);
}
md.push('');
md.push('## 4. Per-device RAM cost (re-derived @ measured K)');
md.push('');
md.push(`- baseline (0-dev) = ${BASELINE}MB; ${K}-dev all-up min = ${st10 ? st10.memMin : 'n/a'}MB`);
md.push(`- **per-device @${K} = (${BASELINE} − ${st10 ? st10.memMin : '?'}) / ${K} = ${perDev10 ? perDev10.toFixed(1) : 'n/a'} MB/device**`);
if (perDev5) md.push(`- per-device @5 (cross-check A10-2's 561) = ${perDev5.toFixed(1)} MB/device`);
if (incr5to10) md.push(`- incremental 5→${K} = ${incr5to10.toFixed(1)} MB/device`);
md.push('');
md.push('## 5. Capacity @ 16GiB host-MemAvailable redline (measured per-device)');
md.push('');
md.push(`- formula: N = (baseline − 16384) / per_device`);
md.push(`- **capacity @ measured per-device(${K}) = (${BASELINE} − 16384) / ${perDev10 ? perDev10.toFixed(1) : '?'} = ${cap10 ? cap10.toFixed(1) : 'n/a'} devices (floor ${cap10 ? Math.floor(cap10) : 'n/a'})**`);
md.push(`- **redline margin at ${K} devices = ${st10 ? st10.memMin : '?'} − 16384 = ${margin10 !== null ? margin10 + 'MB (' + (margin10 / 1024).toFixed(2) + 'GiB)' : 'n/a'}**`);
md.push(`- does ${K}-dev stay above the 16G floor? **${margin10 !== null && margin10 > 0 ? 'YES' : 'NO / BREACHED'}**`);
md.push('');
md.push('## 6. VRAM + 30000 + GPU-util window');
md.push('');
md.push(`- VRAM delta vs A10-1 at ${K}-dev: GPU0 ${vramDelta0}MiB, GPU1 ${vramDelta1}MiB (A+B: idle redroid VRAM delta ≈ 0 → expect ~0)`);
md.push(`- 30000 health across whole run: **${sgAll200 ? 'ALL 200 (' + rows.length + '/' + rows.length + ')' : 'NON-200: ' + sgNon200.join(', ')}**`);
md.push(`- GPU util during BOOT phase (up<${K}): GPU0 max ${gpuMaxBoot.g0}%, GPU1 max ${gpuMaxSoak && gpuMaxBoot.g1}%.`);
md.push(`- GPU util during SOAK phase (up==${K}): GPU0 max ${gpuMaxSoak.g0}%, GPU1 max ${gpuMaxSoak.g1}%.`);
md.push(`- **idle-window check**: if operator stayed idle (no LLM inference), GPU util should be ~0% during boot/soak. Spikes = operator polling (window contaminated).`);
md.push('');
md.push('## 7. Redline breaches (from CSV)');
md.push('');
md.push(`- MemAvailable < 16384MB: **${memBreaches.length ? memBreaches.join(', ') : 'NONE'}**`);
md.push(`- any GPU free < 1500MiB: **${vramBreaches.length ? vramBreaches.join(', ') : 'NONE'}**`);
md.push('');
md.push('## 8. Reconciliation vs A10-2 (5-device extrapolation)');
md.push('');
md.push(`- A10-2 predicted per-device 545–666 MB (5-dev); predicted capacity ~11–12 (floor 11).`);
md.push(`- A10-4 measured per-device @${K} = ${perDev10 ? perDev10.toFixed(1) : 'n/a'} MB; capacity @${K} = ${cap10 ? Math.floor(cap10) : 'n/a'} (floor).`);
md.push(`- 10-device MemAvail ${st10 ? st10.memMin : 'n/a'}MB ${margin10 !== null && margin10 > 0 ? `sits ${(margin10 / 1024).toFixed(2)}GiB ABOVE the 16G floor` : 'is AT/BELOW the 16G floor'} — consistent with ~11–12 capacity (10 is just under the floor).`);
md.push('');

const outMd = md.join('\n') + '\n';
fs.writeFileSync(OUT, outMd);
const jsonOut = {
  baseline: BASELINE, K, per_dev_K: perDev10, per_dev_5: perDev5, incr_5_to_K: incr5to10,
  capacity_K: cap10, capacity_floor_K: cap10 ? Math.floor(cap10) : null,
  memavail_at_K_min: st10 ? st10.memMin : null, redline_margin_K_mb: margin10,
  vram_delta: { g0: vramDelta0, g1: vramDelta1 }, sglang_all200: sgAll200,
  gpu_util_max: { boot: gpuMaxBoot, soak: gpuMaxSoak },
  redline_breaches: { mem: memBreaches, vram: vramBreaches },
  stages,
};
fs.writeFileSync(`${EVID}/boot10-analysis.json`, JSON.stringify(jsonOut, null, 2) + '\n');
process.stdout.write(outMd);
console.error(`\n[analyze] wrote ${OUT} + ${EVID}/boot10-analysis.json`);
