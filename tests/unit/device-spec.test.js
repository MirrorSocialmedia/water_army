/**
 * L2 wave-2 (ADR-033) — deviceSpec test matrix: /proc view mechanism +
 * display pool + generator drift + vacuous-assertion defences.
 *
 * Vacuous-assertion rule (fleet discipline): every "expected green" here is
 * paired with a proven "would catch red" — empty cluster sets, missing
 * observations, and rng-stream shifts all have explicit RED tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  validateDeviceSpec,
  memTotalKbForIdentity,
  procViewCmdArgs,
  profileProcCmdArgs,
  profileProcCpuCores,
  renderMeminfoText,
  renderCpuinfoText,
  generateProcViewRc,
  parseProcViewRc,
  deviceDisplayArgs,
  expectedWebGeometry,
  checkDeviceSpecConsistency,
  encodeClusters,
} from '../../packages/shared/src/device-spec.js';
import { generateWaRoMapRc } from '../../packages/shared/src/w1b-image-mapping.js';
import { generateFingerprintProfile, validateFingerprintProfile } from '../../packages/shared/src/fingerprint-profile.js';
import { loadBuildTemplates, validateTemplatePool, generateTemplateProfile } from '../../packages/shared/src/w1b-profiles.js';
import { runAssert } from '../../scripts/w1b/probe-assert.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const sha16 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const makeRng = (seed) => ({ u32: () => seed >>> 0 });

const PIXEL8PRO_PROC = {
  cpuCores: 9,
  memTotalKb: 11324620,
  cpuClusters: [
    { count: 1, part: '0xd4e' },
    { count: 4, part: '0xd4d' },
    { count: 4, part: '0xd46' },
  ],
};
const DISPLAY = { widthPx: 1344, heightPx: 2992, densityDpi: 489, refreshHz: 120 };

// ---------------------------------------------------------------------------
// 1. validation (template form vs profile form, vacuous guards)
// ---------------------------------------------------------------------------

test('validateDeviceSpec: profile form valid, template form valid, both/neither invalid', () => {
  assert.deepEqual(validateDeviceSpec({ display: DISPLAY, proc: PIXEL8PRO_PROC }), []);
  const tplForm = { display: DISPLAY, proc: { cpuCores: 9, memTotalMb: 12288, cpuClusters: PIXEL8PRO_PROC.cpuClusters } };
  assert.deepEqual(validateDeviceSpec(tplForm), []);
  const both = { display: DISPLAY, proc: { ...PIXEL8PRO_PROC, memTotalMb: 12288 } };
  assert.match(validateDeviceSpec(both).join(';'), /mutually exclusive/);
  const neither = { display: DISPLAY, proc: { cpuCores: 9, cpuClusters: PIXEL8PRO_PROC.cpuClusters } };
  assert.match(validateDeviceSpec(neither).join(';'), /requires memTotalKb/);
});

test('validateDeviceSpec: VACUOUS GUARD — empty/missing cluster list is invalid (no zero-core green)', () => {
  assert.match(validateDeviceSpec({ display: DISPLAY, proc: { ...PIXEL8PRO_PROC, cpuClusters: [] } }).join(';'), /non-empty array/);
  assert.match(validateDeviceSpec({ display: DISPLAY, proc: { ...PIXEL8PRO_PROC, cpuClusters: undefined } }).join(';'), /non-empty array/);
  // count/cores sum mismatch caught BOTH directions
  assert.match(validateDeviceSpec({ display: DISPLAY, proc: { ...PIXEL8PRO_PROC, cpuClusters: [{ count: 8, part: '0xd05' }] } }).join(';'), /sum 8 != cpuCores 9/);
  assert.match(validateDeviceSpec({ display: DISPLAY, proc: { ...PIXEL8PRO_PROC, cpuClusters: [{ count: 10, part: '0xd05' }] } }).join(';'), /sum 10 != cpuCores 9/);
});

test('validateDeviceSpec: field-level rejects (part ids, ranges, shapes)', () => {
  const bad = (proc, display = DISPLAY) => validateDeviceSpec({ display, proc }).join(';');
  assert.match(bad({ ...PIXEL8PRO_PROC, cpuClusters: [{ count: 9, part: 'd05' }] }), /ARM part id/);
  assert.match(bad({ ...PIXEL8PRO_PROC, cpuClusters: [{ count: 9, part: '0xd4e', variant: 'x1' }] }), /variant/);
  assert.match(bad({ ...PIXEL8PRO_PROC, cpuCores: 0 }), /cpuCores/);
  assert.match(bad({ ...PIXEL8PRO_PROC, memTotalKb: 1000 }), /memTotalKb/);
  assert.match(bad({ ...PIXEL8PRO_PROC, memTotalKb: 1000 }, { ...DISPLAY, densityDpi: 9999 }), /densityDpi/);
  assert.match(validateDeviceSpec(null).join(';'), /plain object/);
});

// ---------------------------------------------------------------------------
// 2. per-identity MemTotal (kernel reserve model)
// ---------------------------------------------------------------------------

test('memTotalKbForIdentity: deterministic, inside 3.5-9.5% reserve, varies per stream', () => {
  const a = memTotalKbForIdentity(makeRng(0x1234), 12288);
  assert.equal(a, memTotalKbForIdentity(makeRng(0x1234), 12288));
  const lo = Math.floor(12288 * 1024 * 0.905);
  const hi = Math.ceil(12288 * 1024 * 0.965);
  assert.ok(a >= lo && a <= hi, `reserve band: ${a} not in [${lo},${hi}]`);
  const seen = new Set();
  for (let i = 0; i < 100; i++) seen.add(memTotalKbForIdentity(makeRng((i * 1103515245 + 12345) >>> 0), 12288));
  // 61 reserve steps exist; rng quality only needs to cover a healthy share
  assert.ok(seen.size > 20, `per-identity spread collapsed: ${seen.size}/100`);
  assert.throws(() => memTotalKbForIdentity(makeRng(1), 64), /must be 128/);
});

// ---------------------------------------------------------------------------
// 3. renderers (host reference for the on-device script)
// ---------------------------------------------------------------------------

test('renderMeminfoText: exact MemTotal, deterministic, per-identity bytes differ', () => {
  const t1 = renderMeminfoText(PIXEL8PRO_PROC);
  assert.match(t1, /^MemTotal:\s+11324620 kB$/m);
  assert.equal(t1, renderMeminfoText(PIXEL8PRO_PROC));
  assert.notEqual(t1, renderMeminfoText({ ...PIXEL8PRO_PROC, memTotalKb: 11324621 }));
  assert.throws(() => renderMeminfoText({ memTotalKb: 5 }), /131072/);
});

test('renderCpuinfoText: ARM64 kernel shape + exact core count both directions', () => {
  const ci = renderCpuinfoText(PIXEL8PRO_PROC);
  assert.equal((ci.match(/^processor\t: \d+$/gm) || []).length, 9);
  assert.equal((ci.match(/CPU part\t: 0xd4d/g) || []).length, 4);
  assert.ok(!/model name/i.test(ci), 'x86 model-name tell must never appear');
  assert.ok(!/^Hardware/m.test(ci), 'arm32 Hardware line must never appear');
  // VACUOUS GUARD both directions (mirrors the oem-proc-view.sh end-guard):
  assert.throws(() => renderCpuinfoText({ cpuCores: 8, cpuClusters: [{ count: 9, part: '0xd05' }] }), /rendered 9 cores/);
  assert.throws(() => renderCpuinfoText({ cpuCores: 9, cpuClusters: [{ count: 8, part: '0xd05' }] }), /rendered 8 cores/);
  assert.throws(() => renderCpuinfoText({ cpuCores: 9, cpuClusters: [] }), /non-empty/);
});

// ---------------------------------------------------------------------------
// 4. carrier contract (all-or-none, fixed order, fail closed)
// ---------------------------------------------------------------------------

test('procViewCmdArgs: three args fixed order; null/undefined -> []; invalid throws', () => {
  const args = procViewCmdArgs(PIXEL8PRO_PROC);
  assert.deepEqual(args.map((a) => a.split('=')[0]), [
    'androidboot.oem_mem_total_kb', 'androidboot.oem_cpu_cores', 'androidboot.oem_cpu_clusters',
  ]);
  assert.ok(args[2].endsWith(encodeClusters(PIXEL8PRO_PROC.cpuClusters)));
  assert.deepEqual(procViewCmdArgs(null), []);
  assert.deepEqual(procViewCmdArgs(undefined), []);
  assert.throws(() => procViewCmdArgs({ cpuCores: 9, cpuClusters: [] }), /invalid proc spec/);
  // no spaces / '=' / '%' in any arg value; ':' and ',' are cluster-encoding
  // by-design members (kernel cmdline splits on whitespace only)
  for (const a of args) assert.ok(/^[a-z0-9_.=:,-]+$/.test(a), `carrier arg unsafe: ${a}`);
});

test('profileProcCmdArgs / profileProcCpuCores degrade on legacy profiles', () => {
  assert.deepEqual(profileProcCmdArgs({ model: 'x' }), []);
  assert.equal(profileProcCpuCores({ model: 'x' }), null);
  assert.equal(profileProcCpuCores({ deviceSpec: { proc: { cpuCores: 9 } } }), 9);
});

// ---------------------------------------------------------------------------
// 5. generated rc artifact + drift guard (committed file == generator)
// ---------------------------------------------------------------------------

test('oem-proc-view.rc + oem-ro-map.rc: committed artifacts equal their generators (CI drift)', () => {
  assert.equal(readFileSync(join(ROOT, 'images/redroid-w1b/oem-proc-view.rc'), 'utf8'), generateProcViewRc());
  assert.equal(readFileSync(join(ROOT, 'images/redroid-w1b/oem-ro-map.rc'), 'utf8'), generateWaRoMapRc());
});

test('parseProcViewRc: accepts generated rc; rejects wrong phase, foreign carrier, junk', () => {
  const P = (rc) => parseProcViewRc(rc).problems.join(';');
  assert.deepEqual(parseProcViewRc(generateProcViewRc()).problems, []);
  assert.match(P('on early-init && property:ro.boot.oem_mem_total_kb=*\n    exec -- /vendor/bin/oem-proc-view.sh\n'), /must be post-fs-data/);
  assert.match(P('on post-fs-data && property:ro.boot.oem_cpu_cores=*\n    exec -- /vendor/bin/oem-proc-view.sh\n'), /unexpected/);
  assert.match(P('on post-fs-data && property:ro.boot.oem_mem_total_kb=*\n'), /dangling/);
  assert.match(P('    service foo /system/bin/id\n'), /unexpected rc content/);
});

// ---------------------------------------------------------------------------
// 6. display resolution + web geometry math
// ---------------------------------------------------------------------------

test('deviceDisplayArgs: spec wins, legacy null, invalid throws; web geometry math', () => {
  assert.deepEqual(deviceDisplayArgs({ deviceSpec: { display: DISPLAY, proc: PIXEL8PRO_PROC } }), { width: 1344, height: 2992, dpi: 489 });
  assert.equal(deviceDisplayArgs({ model: 'legacy' }), null);
  assert.throws(() => deviceDisplayArgs({ deviceSpec: { display: { ...DISPLAY, densityDpi: 99999 }, proc: PIXEL8PRO_PROC } }), /invalid display/);
  const g = expectedWebGeometry({ deviceSpec: { display: DISPLAY, proc: PIXEL8PRO_PROC } });
  assert.equal(g.dpr, 489 / 160);
  assert.equal(g.cssWidthPx, Math.round(1344 / (489 / 160)));
  assert.equal(g.cssHeightPx, Math.round(2992 / (489 / 160)));
  assert.equal(expectedWebGeometry({}), null);
});

// ---------------------------------------------------------------------------
// 7. probe-dump consistency kernel (anti-vacuous MISSING)
// ---------------------------------------------------------------------------

test('checkDeviceSpecConsistency: legacy SKIP green; spec profile + empty dump = all MISSING (never vacuous)', () => {
  const legacy = checkDeviceSpecConsistency({ model: 'x' }, null);
  assert.equal(legacy.pass, true);
  assert.deepEqual(legacy.rows.map((r) => r.status), ['SKIP']);

  const profile = { deviceSpec: { display: DISPLAY, proc: PIXEL8PRO_PROC } };
  const empty = checkDeviceSpecConsistency(profile, null);
  assert.equal(empty.pass, false);
  assert.deepEqual(empty.rows.map((r) => r.status), ['MISSING', 'MISSING', 'MISSING', 'MISSING', 'MISSING']);

  const full = checkDeviceSpecConsistency(profile, {
    display: { widthPx: 1344, heightPx: 2992, densityDpi: 489 },
    proc: { memTotalKb: 11324620, cpuinfoCores: 9 },
  });
  assert.equal(full.pass, true);
  assert.deepEqual([...new Set(full.rows.map((r) => r.status))], ['PASS']);

  const wrong = checkDeviceSpecConsistency(profile, {
    display: { widthPx: 720, heightPx: 1280, densityDpi: 489 }, // fleet default leaked
    proc: { memTotalKb: 11324620, cpuinfoCores: 9 },
  });
  assert.equal(wrong.pass, false);
});

test('probe-assert runAssert: deviceSpec section gates the verdict', () => {
    const baseProps = { 'ro.product.brand': 'google', 'ro.product.device': 'husky', 'ro.product.name': 'husky', 'ro.build.display.id': 'UP1A.231005.007', 'ro.serialno': '44299017', 'ro.build.fingerprint': 'google/husky/husky:14/UP1A.231005.007/10760280:user/release-keys' };
  const profile = { deviceSpec: { display: DISPLAY, proc: PIXEL8PRO_PROC } };
  const noObs = runAssert({ dump: { props: baseProps }, expected: profile });
  assert.equal(noObs.pass, false, 'missing deviceSpec observations must block (anti-vacuous)');
  assert.ok(noObs.lines.some((l) => l.startsWith('MISSING') && l.includes('deviceSpec.')), 'MISSING rows emitted');

  const good = runAssert({
    dump: {
      props: { ...baseProps, 'ro.sf.lcd_density': '489' },
      context: { 'qemu.sf.main_display_size': '1344,2992' },
      deviceSpec: { proc: { memTotalKb: 11324620, cpuinfoCores: 9 } },
    },
    expected: profile,
  });
  assert.equal(good.pass, true, good.lines.join('\n'));

  const badMem = runAssert({
    dump: {
      props: { ...baseProps, 'ro.sf.lcd_density': '489' },
      context: { 'qemu.sf.main_display_size': '1344,2992' },
      deviceSpec: { proc: { memTotalKb: 96453412, cpuinfoCores: 9 } }, // host RAM leak
    },
    expected: profile,
  });
  assert.equal(badMem.pass, false, 'host meminfo leak must FAIL the verdict');

  // legacy profile (no deviceSpec) never gates and never prints MISSING rows
  const legacy = runAssert({ dump: { props: baseProps }, expected: { model: 'old' } });
  assert.ok(!legacy.lines.some((l) => l.includes('deviceSpec.')), 'no deviceSpec rows for legacy profile');
});

// ---------------------------------------------------------------------------
// 8. template pool full chain
// ---------------------------------------------------------------------------

test('template pool: every template carries a valid deviceSpec; profiles copy geometry verbatim + jitter MemTotal in band', () => {
  const templates = loadBuildTemplates();
  const { problems } = validateTemplatePool(templates);
  assert.deepEqual(problems, []);
  for (const t of templates) {
    assert.ok(t.deviceSpec, `template ${t.id} missing deviceSpec`);
    assert.equal(typeof t.deviceSpecSource, 'string');
    assert.deepEqual(validateDeviceSpec(t.deviceSpec, t.id), []);
    assert.ok(t.deviceSpec.proc.cpuClusters.length >= 1, `${t.id}: empty cluster set`);
    assert.ok(t.deviceSpecSource.length > 8, `${t.id}: deviceSpec provenance citation required`);
  }
  // fleet diversity floor: verified templates must not all claim one geometry
  const verified = templates.filter((t) => t.verified === true);
  assert.ok(new Set(verified.map((t) => JSON.stringify(t.deviceSpec.display))).size >= 2,
    'verified templates collapse to a single display geometry — fleet would cluster');

  // full chain across a deterministic id sweep
  const seenMem = new Set();
  for (let i = 0; i < 20; i++) {
    const p = generateTemplateProfile(`l2w2-sweep-id-${i}`);
    assert.deepEqual(validateFingerprintProfile(p, true), []);
    const t = templates.find((x) => x.id === p.templateId);
    assert.deepEqual(p.deviceSpec.display, t.deviceSpec.display, 'display copied verbatim from template');
    assert.deepEqual(p.deviceSpec.proc.cpuClusters, t.deviceSpec.proc.cpuClusters, 'clusters verbatim');
    assert.equal(p.deviceSpec.proc.cpuCores, t.deviceSpec.proc.cpuCores);
    const mb = t.deviceSpec.proc.memTotalMb;
    assert.ok(p.deviceSpec.proc.memTotalKb >= Math.floor(mb * 1024 * 0.905));
    assert.ok(p.deviceSpec.proc.memTotalKb <= Math.ceil(mb * 1024 * 0.965));
    assert.equal(JSON.stringify(generateTemplateProfile(`l2w2-sweep-id-${i}`)), JSON.stringify(p), 'idempotent');
    seenMem.add(p.deviceSpec.proc.memTotalKb);
  }
  assert.ok(seenMem.size > 8, `MemTotal spread collapsed across identities: ${seenMem.size}/20`);
});

test('template pool RED pair: verified template without deviceSpec fails the pool gate', () => {
  const templates = loadBuildTemplates();
  const stripped = templates.map((t) => {
    const { deviceSpec, ...rest } = t;
    return rest;
  });
  const { problems } = validateTemplatePool(stripped);
  assert.ok(problems.some((p) => /deviceSpec required on verified templates/.test(p)),
    'pool must reject verified templates missing the geometry story (no silent fleet-default)');
});

// ---------------------------------------------------------------------------
// 9. generator drift: wave-1 field stream sticky + wave-2 golden hashes
// ---------------------------------------------------------------------------

// Wave-1 (pre deviceSpec) outputs — hashes recorded from HEAD a391dc4 BEFORE
// this wave touched the generators. If these move, every stored legacy row
// would falsely alarm drift; the rng tail rule is what protects them.
const WAVE1_STICKY_HASHES = {
  'ident-a1b2c3d4': { w1: '2ef55b5066bcbda4', tpl: '7f8675b9aa3f5f34' },
  'ident-e5f6g7h8': { w1: 'dff35abe976bf614', tpl: 'd8ccddc57b77a173' },
  'ident-j9k0l1m2': { w1: '5b3046c0d95b7b4b', tpl: 'd92ab38a4e227079' },
  'wa-test-identity-0001': { w1: 'c1b52da0d0a69d7d', tpl: 'c3f85637d8d32091' },
  identity_probe_42: { w1: '341d40dae6e28009', tpl: '57bebd5f42c6d525' },
};
// Wave-2 full outputs (deviceSpec appended LAST) — pin current behaviour.
const WAVE2_FULL_HASHES = {
  'ident-a1b2c3d4': { w1: 'f3bda2aa29f2e8c1', tpl: 'b026ab04ba1aa556' },
  'ident-e5f6g7h8': { w1: 'cddc96ae06f828a8', tpl: '208038dc8418c67b' },
  'ident-j9k0l1m2': { w1: '5fa9cc06d8e8b7cf', tpl: '7dd8c21a999e98dc' },
  'wa-test-identity-0001': { w1: 'd8948da19d4625c5', tpl: '2f119856e1ae051f' },
  identity_probe_42: { w1: 'd127fe52bf7b1566', tpl: '2cec992e610af7e1' },
};

test('generator drift discipline: wave-1 field stream byte-sticky; wave-2 outputs golden-pinned', () => {
  for (const id of Object.keys(WAVE1_STICKY_HASHES)) {
    const w1 = generateFingerprintProfile(id);
    const tpl = generateTemplateProfile(id);
    const { deviceSpec: _a, ...w1Rest } = w1;
    const { deviceSpec: _b, ...tplRest } = tpl;
    assert.equal(sha16(JSON.stringify(w1Rest)), WAVE1_STICKY_HASHES[id].w1, `${id} W1 stream moved`);
    assert.equal(sha16(JSON.stringify(tplRest)), WAVE1_STICKY_HASHES[id].tpl, `${id} template stream moved`);
    assert.equal(sha16(JSON.stringify(w1)), WAVE2_FULL_HASHES[id].w1, `${id} W1 wave-2 output moved`);
    assert.equal(sha16(JSON.stringify(tpl)), WAVE2_FULL_HASHES[id].tpl, `${id} template wave-2 output moved`);
    // deviceSpec really is the LAST key in both generators (the invariant
    // that makes the sticky comparison above sufficient)
    assert.equal(Object.keys(w1).at(-1), 'deviceSpec');
    assert.equal(Object.keys(tpl).at(-1), 'deviceSpec');
  }
});

test('W1 synthetic generator: deviceSpec valid + validator accepts generated profile', () => {
  for (let i = 0; i < 15; i++) {
    const p = generateFingerprintProfile(`l2w2-synth-id-${i}`);
    assert.deepEqual(validateFingerprintProfile(p), []);
    assert.deepEqual(validateDeviceSpec(p.deviceSpec), []);
    // synthetic pool members are never x86-shaped and never empty
    assert.ok(p.deviceSpec.proc.cpuClusters.length >= 1);
    assert.ok(p.deviceSpec.display.densityDpi >= 100);
  }
});
