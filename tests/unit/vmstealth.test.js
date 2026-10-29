/**
 * WA-VMSTEALTH S2 hermetic suite (no docker, no boot — S1 red lines).
 * Covers: MAC planning (device-mac.js), battery story (stealth-battery.js),
 * derived stealth props (fingerprint-profile.js), stealth rc artifact
 * (w1b-image-mapping.js drift + sweep ordering).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  planDeviceMac, validateDeviceMac, OUI_POOL_FLAT, PHONE_OUI_POOL,
} from '../../packages/shared/src/device-mac.js';
import {
  buildStealthBatteryProfile, buildStealthBatteryScript, BATTERY_STEALTH_MARKER,
} from '../../packages/shared/src/stealth-battery.js';
import {
  deriveStealthRoOverrides, stealthDerivedPropList, mergeRoOverrides, buildRoCmdArgs,
} from '../../packages/shared/src/fingerprint-profile.js';
import { templateProfileToRoOverrides } from '../../packages/shared/src/w1b-profiles.js';
import {
  generateWaRoMapRc, generateWaRoMapStealthRc, parseWaRoMapRc, propToCarrierRoKey,
} from '../../packages/shared/src/w1b-image-mapping.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const FULL_PROFILE = {
  brand: 'Xiaomi', manufacturer: 'Xiaomi', model: 'Redmi Note 12 Pro',
  device: 'ruby', productName: 'ruby', buildId: 'TKQ1.221114.001',
  displayId: 'TKQ1.221114.001', androidRelease: '13',
  fingerprint: 'Xiaomi/ruby/ruby:13/TKQ1.221114.001/V14.0.6.0.TMCMIXM:user/release-keys',
  serial: 'ABC123XYZ', locale: 'en-US', timezone: 'Asia/Hong_Kong',
  carrierName: 'HKTC', carrierMcc: '454', carrierMnc: '00',
};

describe('device-mac: planning', () => {
  it('is deterministic per seed and salt', () => {
    const a = planDeviceMac({ seed: 'id-1' });
    const b = planDeviceMac({ seed: 'id-1' });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.mac, b.mac);
  });

  it('produces pool OUIs, unicast, vendor-assigned', () => {
    for (let i = 0; i < 300; i++) {
      const p = planDeviceMac({ seed: `identity-${i}` });
      assert.equal(p.ok, true, `seed identity-${i} failed: ${p.reason}`);
      assert.ok(OUI_POOL_FLAT.includes(p.mac.slice(0, 8)), `foreign OUI: ${p.mac}`);
      assert.equal(validateDeviceMac(p.mac), true);
    }
  });

  it('brand selection stays inside the brand pool', () => {
    const p = planDeviceMac({ seed: 'id-x', brand: 'xiaomi' });
    assert.ok(PHONE_OUI_POOL.xiaomi.includes(p.mac.slice(0, 8)));
    const unknown = planDeviceMac({ seed: 'id-y', brand: 'Nokia-ish' });
    assert.ok(OUI_POOL_FLAT.includes(unknown.mac.slice(0, 8)));
  });

  it('10k identities → zero collisions (birthday safety of the pool)', () => {
    const seen = new Set();
    for (let i = 0; i < 10000; i++) {
      const p = planDeviceMac({ seed: `idn-${i}`, taken: seen });
      assert.equal(p.ok, true, `collision-exhausted at ${i}`);
      seen.add(p.mac);
    }
    assert.equal(seen.size, 10000);
  });

  it('avoids the taken set via bounded salt retry; salt is reported', () => {
    const first = planDeviceMac({ seed: 'dup' });
    const second = planDeviceMac({ seed: 'dup', taken: new Set([first.mac]) });
    assert.equal(second.ok, true);
    assert.notEqual(second.mac, first.mac);
    assert.ok(second.salt > first.salt);
  });

  it('fails closed on junk seeds', () => {
    assert.equal(planDeviceMac({ seed: '' }).ok, false);
    assert.equal(planDeviceMac({ seed: 42 }).ok, false);
    assert.equal(planDeviceMac({ seed: 'x'.repeat(201) }).ok, false);
  });
});

describe('device-mac: validation', () => {
  it('rejects the docker tell and every non-plausible shape', () => {
    const bad = [
      '02:42:ac:13:00:06', // docker default: locally-administered + IP-encoded
      '01:00:5e:00:00:fb', // multicast
      '03:11:22:33:44:55', // multicast AND locally-administered
      'aa:bb:cc:dd:ee:ff', // pool foreign
      'cc:eb:5e:00:00:00', // degenerate NIC half
      'cc:eb:5e:ff:ff:ff', // broadcast-ish NIC half
      'CC:EB:5E:11:22:33', // uppercase — canonical form is lowercase
      'cc-eb-5e-11-22-33', // wrong separator
      'cc:eb:5e:11:22',    // short
      null, 42, '',
    ];
    for (const b of bad) assert.equal(validateDeviceMac(b), false, `accepted: ${b}`);
    assert.equal(validateDeviceMac('cc:eb:5e:11:22:33'), true);
  });

  it('pool enforcement is switchable (validator is still a shape gate)', () => {
    assert.equal(validateDeviceMac('00:1b:44:11:22:33', { enforcePool: false }), true);
    assert.equal(validateDeviceMac('02:1b:44:11:22:33', { enforcePool: false }), false);
  });
});

describe('stealth battery', () => {
  it('profile: deterministic, in-band, discharging', () => {
    const a = buildStealthBatteryProfile({ seed: 'dev-1' });
    const b = buildStealthBatteryProfile({ seed: 'dev-1' });
    assert.deepEqual(a, b);
    assert.equal(a.status, 3);
    assert.ok(a.level >= 46 && a.level <= 92, `level ${a.level}`);
    assert.ok(a.temperature >= 245 && a.temperature <= 355, `temp ${a.temperature}`);
    assert.ok(a.voltage >= 3600 && a.voltage <= 4305, `volt ${a.voltage}`);
    // different identities tell different stories
    assert.notEqual(buildStealthBatteryProfile({ seed: 'dev-2' }).level, a.level);
  });

  it('script: fixed argv, marker-terminated, integers only', () => {
    const p = buildStealthBatteryProfile({ seed: 'dev-3' });
    const s = buildStealthBatteryScript(p);
    assert.ok(s.includes(BATTERY_STEALTH_MARKER));
    assert.ok(s.includes(`dumpsys battery set level ${p.level}`));
    assert.doesNotMatch(s, /[$`|&*()\\]/); // no expansion/substitution surface (semicolons are OUR separators)
  });

  it('script v2 (WA-STEALTH-FIX2): ONLY the supported shell surface, present 1, no temperature/voltage', () => {
    // s1 real-device ruling (S1-RESEARCH §1): this image's BatteryService
    // answers `Unknown set option:` for temperature/voltage — v2 must not
    // send them, and must pin present 1 (container default present:false).
    const p = buildStealthBatteryProfile({ seed: 'dev-3b' });
    const s = buildStealthBatteryScript(p);
    assert.ok(s.includes('dumpsys battery set present 1'));
    assert.ok(s.includes('dumpsys battery set dock 0'));
    assert.doesNotMatch(s, /set (temperature|voltage)/);
    assert.equal(s.split('; ').at(-1), `echo ${BATTERY_STEALTH_MARKER}`);
  });

  it('script: fail-closed on anything non-integer or out of range', () => {
    const p = buildStealthBatteryProfile({ seed: 'dev-4' });
    assert.throws(() => buildStealthBatteryScript({ ...p, level: '7; rm -rf /' }));
    assert.throws(() => buildStealthBatteryScript({ ...p, level: 7.5 }));
    assert.throws(() => buildStealthBatteryScript({ ...p, level: 101 }));
    assert.throws(() => buildStealthBatteryScript({ ...p, status: 9 }));
    assert.doesNotThrow(() => buildStealthBatteryScript({ ...p, temperature: 999 })); // v2: unused knob
    assert.throws(() => buildStealthBatteryScript(undefined));
  });
});

describe('stealth derived build props', () => {
  const d = deriveStealthRoOverrides(FULL_PROFILE);

  it('emits exactly the declared static list (rc sync contract)', () => {
    const list = new Set(stealthDerivedPropList());
    for (const k of Object.keys(d)) assert.ok(list.has(k), `undeclared derived prop: ${k}`);
    assert.equal(Object.keys(d).length, list.size);
  });

  it('story self-consistency: flavor/description/type/tags/incremental from the fingerprint', () => {
    assert.equal(d['ro.build.flavor'], 'ruby-user');
    assert.equal(d['ro.build.product'], 'ruby');
    assert.equal(d['ro.build.type'], 'user');
    assert.equal(d['ro.build.tags'], 'release-keys');
    assert.equal(d['ro.build.version.incremental'], 'V14.0.6.0.TMCMIXM');
    assert.equal(d['ro.build.description'], 'ruby-user%2013%20TKQ1.221114.001%20V14.0.6.0.TMCMIXM%20release-keys');
    for (const part of ['system', 'vendor', 'odm', 'product', 'system_ext']) {
      assert.equal(d[`ro.${part}.build.fingerprint`], FULL_PROFILE.fingerprint);
      assert.equal(d[`ro.product.${part}.brand`], 'Xiaomi');
      assert.equal(d[`ro.product.${part}.model`], 'Redmi%20Note%2012%20Pro');
      assert.equal(d[`ro.product.${part}.device`], 'ruby');
      assert.equal(d[`ro.${part}.build.version.incremental`], 'V14.0.6.0.TMCMIXM');
    }
    assert.doesNotMatch(JSON.stringify(d), /redroid/i);
  });

  it('unparseable (legacy) fingerprint degrades to the segment-free subset', () => {
    const d2 = deriveStealthRoOverrides({ ...FULL_PROFILE, fingerprint: 'legacy-no-grammar' });
    assert.equal(d2['ro.build.flavor'], undefined);
    assert.equal(d2['ro.product.system.brand'], 'Xiaomi'); // story props survive
    assert.equal(d2['ro.system.build.fingerprint'], 'legacy-no-grammar');
  });

  it('merges with the carrier layer and passes the FULL fail-closed gate', () => {
    const merged = mergeRoOverrides([templateProfileToRoOverrides(FULL_PROFILE), d]);
    assert.deepEqual(merged.problems, []);
    const args = buildRoCmdArgs(merged.overrides);
    assert.ok(args.length > 55, `expected full expansion, got ${args.length} args`);
    assert.ok(args.join(' ').length < 8192); // argv budget sanity
  });

  it('is deterministic (pure function)', () => {
    assert.deepEqual(deriveStealthRoOverrides(FULL_PROFILE), d);
  });
});

describe('stealth rc artifact', () => {
  const rc = generateWaRoMapStealthRc();
  const committed = readFileSync(join(ROOT, 'images/redroid-w1b/oem-ro-map-stealth.rc'), 'utf8');

  it('committed artifact == generator (CI drift)', () => {
    assert.equal(rc, committed);
  });

  it('base rc bytes are untouched (old images rebuild byte-identical)', () => {
    assert.equal(generateWaRoMapRc(), readFileSync(join(ROOT, 'images/redroid-w1b/oem-ro-map.rc'), 'utf8'));
  });

  it('parses clean; every carrier — base and stealth — is swept after its phase', () => {
    const { rows, deleted, problems } = parseWaRoMapRc(rc);
    assert.deepEqual(problems, []);
    assert.equal(rows.length, 12 + stealthDerivedPropList().length);
    const carriers = rows.map((r) => r.carrier);
    assert.deepEqual([...deleted].sort(), [...carriers].sort());
    for (const prop of stealthDerivedPropList()) {
      assert.ok(rows.some((r) => r.target === prop), `missing rc row for ${prop}`);
    }
  });

  it('sweep sections run strictly after all write blocks (file order = init order)', () => {
    const lines = rc.split('\n');
    let lastWrite = -1;
    let firstSweep = Infinity;
    lines.forEach((l, i) => {
      if (/^\s{4}exec -- .+ \$\{ro\.boot\.oem_/.test(l)) lastWrite = i;
      if (/^on (early-init|load_persist_props_action)$/.test(l) && firstSweep > i) firstSweep = i;
    });
    assert.ok(lastWrite >= 0);
    assert.ok(firstSweep > lastWrite, 'a sweep section appears before the last write block');
    assert.equal(
      lines.filter((l) => l.includes('--delete-if-exist ro.boot.oem_')).length,
      12 + stealthDerivedPropList().length,
    );
  });

  it('persist carriers are swept in the persist phase only (timezone story intact)', () => {
    const { problems, deleted } = parseWaRoMapRc(rc);
    assert.deepEqual(problems, []);
    assert.ok(deleted.includes(propToCarrierRoKey('persist.sys.timezone')));
  });
});
