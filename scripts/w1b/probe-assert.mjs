#!/usr/bin/env node
/**
 * W1b P3 — ground-truth assertion runner (ADR-028 real-device stage tool).
 *
 * Input : probe dump JSON (com.waterarmy.probe dump — see probe-app/), via
 *         --dump <file> (or - for stdin).
 * Expected profile: --expected <file> (profile JSON from
 *         GET /api/identities/:id/fingerprint) OR the dump's embedded
 *         "expected" object (probe intent extra expected_json).
 *
 * Output: one PASS/FAIL/MISSING line per prop (platform-vs-device truth),
 *         then probe self-consistency findings (device-truth-internal), then
 *         a VERDICT line. Exit 0 = all strict checks pass; 1 = any FAIL/
 *         MISSING (fail closed); 2 = usage/input errors.
 *
 * The assertion kernel is the SHARED module (w1b-consistency.js) — this
 * script is only I/O + formatting, so platform-side and device-side verdicts
 * can never disagree.
 */
import { readFileSync } from 'node:fs';
import { checkProfileConsistency, checkProbeSelfConsistency } from '../../packages/shared/src/w1b-consistency.js';
import { checkDeviceSpecConsistency } from '../../packages/shared/src/device-spec.js';

/**
 * L2 wave-2 (ADR-033): assemble the observed deviceSpec from the dump.
 * Primary source = probe "deviceSpec" section (probe app + shell harness
 * capture /proc renders at the real-device stage). display density/geometry
 * additionally derive from dump props when present (ro.sf.lcd_density = the
 * framework density — same number `wm density` prints; [docs: AOSP
 * WindowService reads qemu.sf.lcd_density/ro.sf.lcd_density for density]);
 * qemu.sf.main_display_size is redroid-only and tagged best-effort.
 */
function deviceSpecObservation(dump) {
  const ctx = { ...dump.props, ...(dump.context ?? {}) };
  const ds = dump.deviceSpec ?? {};
  const obs = { display: { ...(ds.display ?? {}) }, proc: { ...(ds.proc ?? {}) } };
  if (obs.display.densityDpi === undefined && /^\d+$/.test(String(ctx['ro.sf.lcd_density'] ?? ''))) {
    obs.display.densityDpi = Number(ctx['ro.sf.lcd_density']);
  }
  const mds = String(ctx['qemu.sf.main_display_size'] ?? '');
  if (obs.display.widthPx === undefined && /^\d+,\d+$/.test(mds)) {
    const [w, h] = mds.split(',').map(Number);
    obs.display.widthPx = w;
    obs.display.heightPx = h;
  }
  return obs;
}

export function runAssert({ dump, expected }) {
  const lines = [];
  if (!dump || typeof dump !== 'object' || !dump.props || typeof dump.props !== 'object') {
    return { lines: ['INPUT dump.props object required'], pass: false, usage: true };
  }
  const exp = expected ?? dump.expected ?? null;
  let pass = true;
  if (exp) {
    const r = checkProfileConsistency(exp, dump.props);
    for (const row of r.rows) {
      lines.push(`${row.status.padEnd(7)} ${row.field} (${row.prop}) expected=${JSON.stringify(row.expected)} observed=${JSON.stringify(row.observed)}`);
    }
    pass = r.pass;
  } else {
    lines.push('SKIP    profile-vs-device (no expected profile supplied)');
  }
  const selfProblems = checkProbeSelfConsistency(dump.props);
  for (const p of selfProblems) {
    lines.push(`FAIL    self-consistency: ${p}`);
  }
  pass = pass && selfProblems.length === 0;
  // L2 wave-2 (ADR-033): /proc view + display geometry truth. Anti-vacuous:
  // when the profile carries a deviceSpec, observations are REQUIRED —
  // missing /proc or density capture = MISSING = blocking (no empty-set green).
  if (exp?.deviceSpec) {
    const r = checkDeviceSpecConsistency(exp, deviceSpecObservation(dump));
    for (const row of r.rows) {
      lines.push(`${row.status.padEnd(7)} deviceSpec.${row.key} expected=${JSON.stringify(row.expected)} observed=${JSON.stringify(row.observed)}`);
    }
    pass = pass && r.pass;
  }
  // L1 informational layer (never blocking): what L2 must close
  const ctx = dump.context ?? {};
  // L2 wave-1 (ADR-031): ro.hardware/ro.boot.hardware moved from the
  // informational context block INTO the asserted props map (they are now
  // carrier-mapped identity props). Read both placements so old probe APK
  // dumps (context-only) still produce the tell note.
  const hwView = { ...dump.props, ...ctx };
  const notes = [];
  if (ctx['ro.kernel.qemu'] === '1') notes.push('ro.kernel.qemu=1 (emulator tell — L2)');
  if (hwView['ro.hardware'] === 'redroid' || hwView['ro.boot.hardware'] === 'redroid') notes.push('ro.hardware=redroid (image tell — L2)');
  if (typeof dump.propCount === 'number' && dump.propCount >= 0 && dump.propCount < 1500) notes.push(`prop count ${dump.propCount} below real-firmware range (L2 inventory gap)`);
  for (const n of notes) lines.push(`NOTE    ${n}`);
  return { lines, pass };
}

function loadJson(path) {
  return JSON.parse(path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8'));
}

if (process.argv[1] && process.argv[1].endsWith('probe-assert.mjs')) {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const dumpPath = get('--dump');
  if (!dumpPath) {
    console.error('usage: probe-assert.mjs --dump <probe-dump.json|-> [--expected <profile.json>]');
    process.exit(2);
  }
  let dump, expected;
  try {
    dump = loadJson(dumpPath);
    const expPath = get('--expected');
    expected = expPath ? loadJson(expPath) : undefined;
  } catch (e) {
    console.error(`input error: ${e.message}`);
    process.exit(2);
  }
  const { lines, pass } = runAssert({ dump, expected });
  for (const l of lines) console.log(l);
  console.log(pass ? 'VERDICT PASS — device truth matches the platform profile (L1 scope)' : 'VERDICT FAIL — see FAIL lines above');
  process.exit(pass ? 0 : 1);
}
