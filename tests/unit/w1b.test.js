/**
 * W1b unit tests — template library semantics, carrier mapping contract,
 * probe consistency validator. Code-segment guarantees ONLY (no device boot;
 * ground truth lives in the real-device stage checklist, ADR-028).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadBuildTemplates,
  validateBuildTemplate,
  validateTemplatePool,
  generateTemplateProfile,
  validateTemplateProfile,
  templateProfileToRoOverrides,
} from '../../packages/shared/src/w1b-profiles.js';
import {
  carrierMappingTable,
  generateWaRoMapRc,
  parseWaRoMapRc,
  propToCarrierRoKey,
} from '../../packages/shared/src/w1b-image-mapping.js';
import {
  checkProfileConsistency,
  checkProbeSelfConsistency,
} from '../../packages/shared/src/w1b-consistency.js';
import { runAssert } from '../../scripts/w1b/probe-assert.mjs';
import { profilePropEntries, propToAndroidbootKey } from '../../packages/shared/src/fingerprint-profile.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// Template pool
// ---------------------------------------------------------------------------

test('templates: shipped pool passes the full cross-validator', () => {
  const pool = validateTemplatePool(loadBuildTemplates());
  assert.deepEqual(pool.problems, [], `pool problems: ${pool.problems.join(' | ')}`);
  const verified = pool.templates.filter((t) => t.verified === true);
  assert.ok(verified.length >= 5, 'at least 5 machine-verified templates required');
});

test('templates: every template cites provenance; verified flag is boolean', () => {
  for (const t of loadBuildTemplates()) {
    assert.ok(typeof t.source === 'string' && t.source.length >= 8, `${t.id}: source must be a substantive citation`);
    assert.equal(typeof t.verified, 'boolean', `${t.id}: verified must be boolean`);
  }
});

test('templates: cross-validator rejects broken fingerprints / sdk map / reserved %', () => {
  const [good] = loadBuildTemplates();
  assert.ok(validateBuildTemplate(good).length === 0);

  const fp = good.fields.fingerprint;
  // fingerprint disagrees with its own parts (classic stale-template bug)
  assert.ok(validateBuildTemplate({ ...good, fields: { ...good.fields, fingerprint: fp.replace('user/', 'userdebug/') } }).some((m) => /must equal/.test(m)));
  // release/sdk map violation (17 != 33)
  assert.ok(validateBuildTemplate({ ...good, fields: { ...good.fields, sdkVersion: '33' } }).some((m) => /inconsistent with sdkVersion/.test(m)));
  // brand/device drift breaks the fingerprint prefix
  assert.ok(validateBuildTemplate({ ...good, fields: { ...good.fields, device: 'otherdevice' } }).some((m) => /must equal|grammar/.test(m)));
  // tags/user tells
  assert.ok(validateBuildTemplate({ ...good, fields: { ...good.fields, buildTags: 'dev-keys' } }).some((m) => /release-keys/.test(m)));
  assert.ok(validateBuildTemplate({ ...good, fields: { ...good.fields, buildType: 'userdebug' } }).some((m) => /"user"/.test(m)));
  // reserved % (carrier encoding)
  assert.ok(validateBuildTemplate({ ...good, fields: { ...good.fields, model: 'Pixel%20X' } }).some((m) => /model must not contain/.test(m)));
  assert.ok(validateBuildTemplate({ ...good, fields: { ...good.fields, buildId: 'CP3A%2E1' } }).some((m) => /must not contain "%"/.test(m)));
  // missing provenance
  assert.ok(validateBuildTemplate({ ...good, source: '' }).some((m) => /source citation/.test(m)));
});

test('templates: pool rejects duplicate ids', () => {
  const [a] = loadBuildTemplates();
  const { problems } = validateTemplatePool([a, structuredClone(a)]);
  assert.ok(problems.some((m) => /duplicate template id/.test(m)));
});

// ---------------------------------------------------------------------------
// Generation semantics
// ---------------------------------------------------------------------------

const ids = (n, p = 'w1btestid') => Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(16, 'z')}`);

test('generator: deterministic per identity (200 ids x2 deep-equal)', () => {
  for (const id of ids(200)) {
    assert.deepEqual(generateTemplateProfile(id), generateTemplateProfile(id));
  }
});

test('generator: verified-only by default; includeUnverified widens the pool', () => {
  const templates = loadBuildTemplates();
  const unverifiedIds = new Set(templates.filter((t) => !t.verified).map((t) => t.id));
  assert.ok(unverifiedIds.size > 0, 'fixture expects some unverified entries');
  for (const id of ids(100)) {
    assert.ok(!unverifiedIds.has(generateTemplateProfile(id).templateId), 'unverified template leaked into default generation');
  }
  const widened = new Set(ids(200).map((id) => generateTemplateProfile(id, { includeUnverified: true }).templateId));
  for (const t of templates) {
    assert.ok(widened.has(t.id) || t.verified, `${t.id}: unverified entry must be reachable with includeUnverified`);
  }
});

test('generator: every produced profile passes validation and real-shape rules', () => {
  for (const id of ids(300)) {
    const p = generateTemplateProfile(id);
    assert.deepEqual(validateTemplateProfile(p), []);
    assert.match(p.serial, /^[A-Za-z0-9]{6,32}$/);
    assert.match(p.securityPatch, /^\d{4}-\d{2}-\d{2}$/);
    // build fields are VERBATIM template values (the whole point of real builds)
    const t = loadBuildTemplates().find((x) => x.id === p.templateId);
    assert.equal(p.fingerprint, t.fields.fingerprint);
    assert.equal(p.buildId, t.fields.buildId);
    assert.equal(p.model, t.fields.model);
  }
});

test('generator: 2000-identity fleet — unique fields stay distinct (deterministic, zero-flake)', () => {
  const seen = { serial: new Map(), fingerprint: new Map(), displayId: new Map() };
  for (const id of ids(2000)) {
    const p = generateTemplateProfile(id);
    for (const f of ['serial', 'fingerprint', 'displayId']) {
      // fingerprint/displayId repeat LEGITIMATELY (shared build); serial must not
      if (f === 'serial') {
        assert.ok(!seen.serial.has(p.serial), `serial collision: ${p.serial} (${id} vs ${seen.serial.get(p.serial)})`);
        seen.serial.set(p.serial, id);
      }
    }
  }
  // fingerprints should spread across the verified pool (no single-template collapse)
  const fps = new Set(ids(200).map((id) => generateTemplateProfile(id).fingerprint));
  assert.ok(fps.size >= 2, 'fleet must spread across templates');
});

test('generator: cross-template fields differ between templates (pool diversity)', () => {
  const tpls = loadBuildTemplates().filter((t) => t.verified);
  const models = new Set(tpls.map((t) => t.fields.model));
  const fps = new Set(tpls.map((t) => t.fields.fingerprint));
  assert.equal(models.size, tpls.length, 'verified pool must not repeat models');
  assert.equal(fps.size, tpls.length);
});

// ---------------------------------------------------------------------------
// Carrier overrides (%20 model encoding, ADR-028)
// ---------------------------------------------------------------------------

test('overrides: templateProfileToRoOverrides maps the full expanded prop set, model %20-encoded', () => {
  const p = generateTemplateProfile('w1bmodel0aaaaaaaaaaaa');
  const o = templateProfileToRoOverrides(p);
  const flattened = profilePropEntries().map(([, prop]) => prop).sort();
  assert.ok(flattened.length === 12, `expanded prop set must be 12 rows (11 fields incl. hardware x2), got ${flattened.length}`);
  assert.deepEqual(Object.keys(o).sort(), flattened);
  assert.equal(o['ro.product.model'], p.model.replaceAll(' ', '%20'));
  assert.ok(!o['ro.product.model'].includes(' '), 'carrier value must not contain raw spaces');
  assert.equal(o['ro.build.fingerprint'], p.fingerprint);
  // L2 wave-1 (ADR-031): timezone + hardware ride the same carrier chain as the
  // identity ro.* props — one field tells BOTH hardware props the same story
  assert.equal(o['persist.sys.timezone'], p.timezone);
  assert.match(o['persist.sys.timezone'], /^[A-Za-z]+\/[A-Za-z_+]+$/, 'IANA timezone rides the carrier verbatim');
  assert.equal(o['ro.hardware'], p.hardware);
  assert.equal(o['ro.boot.hardware'], p.hardware, 'ro.hardware and ro.boot.hardware carry the SAME board token');
  // round-trip through the W1 carrier builder
  const args = (m) => Object.keys(m).sort().map((k) => `${propToAndroidbootKey(k)}=${m[k]}`);
  for (const a of args(o)) {
    assert.match(a, /^androidboot\.oem_[a-z0-9_]+=[A-Za-z0-9][A-Za-z0-9._:/,+%-]*$/);
  }
});

test('rename: carrier prefix is neutral oem_, no wa_ signature left in keys', () => {
  assert.equal(propToAndroidbootKey('ro.build.fingerprint'), 'androidboot.oem_ro_build_fingerprint');
  assert.equal(propToCarrierRoKey('ro.build.fingerprint'), 'ro.boot.oem_ro_build_fingerprint');
  assert.ok(!generateWaRoMapRc().includes('wa_'), 'rc artifact must not leak wa_ carriers');
});

// ---------------------------------------------------------------------------
// Image mapping contract (rc drift)
// ---------------------------------------------------------------------------

test('rc artifact: committed file equals generator output (drift guard)', () => {
  const committed = readFileSync(join(ROOT, 'images', 'redroid-w1b', 'oem-ro-map.rc'), 'utf8');
  assert.equal(committed, generateWaRoMapRc(), 'oem-ro-map.rc drifted — run scripts/w1b/generate-wa-ro-map-rc.mjs');
});

test('rc artifact: parses back to exactly the 12-entry mapping table (non-empty guard)', () => {
  const { rows, problems } = parseWaRoMapRc(generateWaRoMapRc());
  assert.deepEqual(problems, []);
  const table = carrierMappingTable().map((r) => ({ carrier: r.carrier, target: r.target })).sort((a, b) => (a.target < b.target ? -1 : 1));
  assert.ok(table.length === 12, 'mapping table must be 12 rows — a silently empty/short table is the vacuous-assertion failure mode');
  assert.deepEqual([...rows].sort((a, b) => (a.target < b.target ? -1 : 1)), table);
  assert.equal(rows.length, 12);
  // L2 wave-1 phase discipline: persist.* maps in post-fs-data ONLY (ro.* in
  // early-init) — enforced by the parser too, but assert it here at source
  const rc = generateWaRoMapRc();
  assert.match(rc, /on post-fs-data && property:ro\.boot\.oem_persist_sys_timezone=\*/);
  assert.ok(!/^on early-init && property:ro\.boot\.oem_persist_/m.test(rc), 'persist.* carrier must NOT map in early-init (load_persistent_properties races it)');
});

test('rc parser: catches tampering (dangling trigger / foreign content / carrier mismatch / wrong phase)', () => {
  assert.ok(parseWaRoMapRc('on early-init && property:ro.boot.oem_x=*\n').problems.some((m) => /dangling/.test(m)));
  assert.ok(parseWaRoMapRc('service sneaky /system/bin/sneaky\n').problems.some((m) => /unexpected/.test(m)));
  assert.ok(parseWaRoMapRc('on early-init && property:ro.boot.oem_a=*\n    exec -- /vendor/bin/oem-propctl ro.x ${ro.boot.oem_b}').problems.some((m) => /does not match trigger/.test(m)));
  // phase tampering: persist.* in early-init / ro.* in post-fs-data both rejected
  assert.ok(parseWaRoMapRc('on early-init && property:ro.boot.oem_persist_sys_timezone=*\n    exec -- /vendor/bin/oem-propctl persist.sys.timezone ${ro.boot.oem_persist_sys_timezone}').problems.some((m) => /must be post-fs-data/.test(m)));
  assert.ok(parseWaRoMapRc('on post-fs-data && property:ro.boot.oem_ro_serialno=*\n    exec -- /vendor/bin/oem-propctl ro.serialno ${ro.boot.oem_ro_serialno}').problems.some((m) => /must be early-init/.test(m)));
});

// ---------------------------------------------------------------------------
// Consistency validator (probe ground truth kernel)
// ---------------------------------------------------------------------------

function devicePropsFrom(profile) {
  const props = {};
  for (const [field, prop] of profilePropEntries()) props[prop] = profile[field]; // device sees REAL values (spaces decoded)
  return props;
}

test('consistency: device truth matching profile -> all PASS', () => {
  const p = generateTemplateProfile('w1bcons00aaaaaaaaaa');
  const r = checkProfileConsistency(p, devicePropsFrom(p));
  assert.ok(r.pass, JSON.stringify(r.rows.filter((x) => x.status !== 'PASS')));
  assert.equal(r.blocking, false);
  assert.equal(r.rows.length, 12);
  // L2 wave-1: timezone + hardware rows must EXIST and PASS (vacuous guard: a
  // row silently missing from the kernel would let device drift slip unnoticed)
  for (const prop of ['persist.sys.timezone', 'ro.hardware', 'ro.boot.hardware']) {
    const row = r.rows.find((x) => x.prop === prop);
    assert.ok(row && row.status === 'PASS', `${prop} row missing/not PASS: ${JSON.stringify(row)}`);
  }
});

test('consistency: hardware mismatch on ONE of the two props -> blocking FAIL', () => {
  const p = generateTemplateProfile('w1bcons03aaaaaaaaaa');
  const props = devicePropsFrom(p);
  props['ro.boot.hardware'] = 'redroid'; // boot arg mirrored but identity rc forgot one target
  const r = checkProfileConsistency(p, props);
  assert.equal(r.pass, false);
  assert.equal(r.rows.find((x) => x.prop === 'ro.boot.hardware').status, 'FAIL');
  assert.equal(r.rows.find((x) => x.prop === 'ro.hardware').status, 'PASS');
});

test('consistency: legacy W1 profile (no hardware field) -> SKIP rows, never FAIL', () => {
  const p = generateTemplateProfile('w1bcons04aaaaaaaaaa');
  const legacy = { ...p };
  delete legacy.hardware; // stored profile predates L2 wave-1: no carrier emitted, device shows image default
  const props = devicePropsFrom(p);
  props['ro.hardware'] = 'redroid';
  props['ro.boot.hardware'] = 'redroid';
  const r = checkProfileConsistency(legacy, props);
  assert.equal(r.pass, true, 'SKIP must not block legacy rows');
  const skips = r.rows.filter((x) => x.status === 'SKIP');
  assert.equal(skips.length, 2);
  assert.deepEqual(skips.map((x) => x.prop).sort(), ['ro.boot.hardware', 'ro.hardware']);
});

test('consistency: fingerprint mismatch / missing prop -> FAIL/MISSING + blocking', () => {
  const p = generateTemplateProfile('w1bcons01aaaaaaaaaa');
  const props = devicePropsFrom(p);
  props['ro.build.fingerprint'] = 'samsung/gt5note10/gt5note10:9/UP1A/a1:user/release-keys';
  delete props['ro.serialno'];
  const r = checkProfileConsistency(p, props);
  assert.equal(r.pass, false);
  assert.equal(r.blocking, true);
  assert.equal(r.rows.find((x) => x.field === 'fingerprint').status, 'FAIL');
  assert.equal(r.rows.find((x) => x.field === 'serial').status, 'MISSING');
});

test('probe-assert runner: fixture dump -> per-field lines + VERDICT semantics', () => {
  const p = generateTemplateProfile('w1bassert00aaaaaaaaa');
  const props = devicePropsFrom(p);
  // L2 wave-2 (ADR-033): a probe dump for a deviceSpec profile must carry the
  // geometry/proc observations — anti-vacuous: without them the verdict FAILs
  // (device-spec.test.js pins that direction); here we feed the truthful set.
  const ds = p.deviceSpec;
  const dump = {
    schema: 'wa-probe/1',
    props: { ...props, 'ro.sf.lcd_density': String(ds.display.densityDpi) },
    context: { 'ro.build.type': 'user', 'ro.build.tags': 'release-keys', 'qemu.sf.main_display_size': `${ds.display.widthPx},${ds.display.heightPx}` },
    deviceSpec: { proc: { memTotalKb: ds.proc.memTotalKb, cpuinfoCores: ds.proc.cpuCores } },
    propCount: 900,
  };
  const good = runAssert({ dump, expected: p });
  assert.equal(good.pass, true, good.lines.join('\n'));
  assert.ok(good.lines.filter((l) => l.startsWith('PASS') && l.includes('(')).length === 12);
  assert.ok(good.lines.filter((l) => l.startsWith('PASS') && l.includes('deviceSpec.')).length === 5, 'wave-2 deviceSpec rows all observed');
  const noObs = runAssert({ dump: { ...dump, deviceSpec: undefined, context: { 'ro.build.type': 'user', 'ro.build.tags': 'release-keys' }, props }, expected: p });
  assert.equal(noObs.pass, false, 'deviceSpec profile without observations = MISSING = blocking (never vacuous green)');

  const legacyProbe = { ...dump, context: { ...dump.context, 'ro.hardware': 'redroid' } }; // pre-L2 probe APK kept hardware in context only
  const withTell = runAssert({ dump: legacyProbe, expected: null });
  assert.ok(withTell.lines.some((l) => l.startsWith('NOTE') && /ro.hardware=redroid/.test(l)), 'L2 tells reported as notes (non-blocking)');

  const broken = runAssert({ dump: { ...dump, props: { ...props, 'ro.serialno': 'OTHER' } }, expected: p });
  assert.equal(broken.pass, false);
  assert.ok(broken.lines.some((l) => l.startsWith('FAIL') && /serial/.test(l)));

  const selfBad = runAssert({ dump: { ...dump, props: { ...props, 'ro.product.brand': 'Mismatch' } } });
  assert.equal(selfBad.pass, false, 'self-consistency failure is blocking even without expected');

  const usage = runAssert({ dump: {} });
  assert.equal(usage.usage, true);
});

test('probe self-consistency: real dump passes; tells are caught', () => {
  const p = generateTemplateProfile('w1bcons02aaaaaaaaaa');
  const props = devicePropsFrom(p);
  assert.deepEqual(checkProbeSelfConsistency(props), []);

  // fingerprint prefix vs ro.product.* disagreement (partial map through)
  assert.ok(checkProbeSelfConsistency({ ...props, 'ro.product.brand': 'OtherBrand' }).some((m) => /prefix does not match/.test(m)));
  // fingerprint buildId segment != ro.build.id
  assert.ok(checkProbeSelfConsistency({ ...props, 'ro.build.id': 'ZED9.999999.001' }).some((m) => /buildId segment/.test(m)));
  // userdebug farm tell
  const udbg = { ...props, 'ro.build.fingerprint': props['ro.build.fingerprint'].replace('user/', 'userdebug/') };
  assert.ok(checkProbeSelfConsistency(udbg).some((m) => /build type/.test(m)));
  // missing serial (unique identity field)
  const { 'ro.serialno': _drop, ...noSerial } = props;
  assert.ok(checkProbeSelfConsistency(noSerial).some((m) => /ro\.serialno missing/.test(m)));
  // empty dump fails closed
  assert.ok(checkProbeSelfConsistency({}).length > 0);
});
