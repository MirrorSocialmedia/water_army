/**
 * WA-STEALTH-FIX2 (s2) — hermetic units for the product-layer fixes:
 * battery drift (A), browser launch-arg provisioning (D/E carriers),
 * region three-way consistency (E), and the Nothing OUI pool entry (F2).
 * Pure functions + service-level fakes only — zero docker/adb.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  batteryDriftLevel, buildBatteryDriftScript, buildStealthBatteryProfile, BATTERY_DRIFT_MARKER,
  buildBrowserArgsProvisionScript, buildWebviewCommandLine, validateDnsResolver,
  BROWSER_ARGS_MARKER, WEBRTC_IP_POLICIES,
  regionFromTimezone, regionFromLocale, profileRegionFrom, checkRegionConsistency,
  PHONE_OUI_POOL, OUI_POOL_FLAT, ouiCandidates,
} from '@water-army/shared';
import { createIdentityEgressService } from '../../apps/api/src/services/identity-egress-service.js';

// ---------------------------------------------------------------- battery drift

test('battery drift: deterministic slow decay with floor', () => {
  const profile = { level: 80 };
  const t0 = Date.parse('2026-10-29T12:00:00Z');
  assert.equal(batteryDriftLevel({ profile, anchorMs: t0, nowMs: t0 }), 80);
  assert.equal(batteryDriftLevel({ profile, anchorMs: t0, nowMs: t0 + 29 * 60_000 }), 80);
  assert.equal(batteryDriftLevel({ profile, anchorMs: t0, nowMs: t0 + 30 * 60_000 }), 79);
  assert.equal(batteryDriftLevel({ profile, anchorMs: t0, nowMs: t0 + 59 * 60_000 }), 79);
  assert.equal(batteryDriftLevel({ profile, anchorMs: t0, nowMs: t0 + 120 * 60_000 }), 76);
  // floors at 21 — never panic-low, never negative
  assert.equal(batteryDriftLevel({ profile, anchorMs: t0, nowMs: t0 + 90 * 24 * 60 * 60_000 }), 21);
  // clock went backwards (NTP correction) — hold base, never jump
  assert.equal(batteryDriftLevel({ profile, anchorMs: t0, nowMs: t0 - 10 * 60_000 }), 80);
});

test('battery drift: pure across recomputation (watchdog never fights itself)', () => {
  const profile = buildStealthBatteryProfile({ seed: 'drift-seed' });
  const anchor = Date.parse('2026-10-29T00:00:00Z');
  const now = anchor + 3 * 30 * 60_000 + 7; // mid-step
  const a = batteryDriftLevel({ profile, anchorMs: anchor, nowMs: now });
  const b = batteryDriftLevel({ profile, anchorMs: anchor, nowMs: now + 1000 });
  assert.equal(a, b);
  assert.ok(a < profile.level && a >= 21);
});

test('battery drift script: only the supported level knob + marker', () => {
  const s = buildBatteryDriftScript(57);
  assert.equal(s, `dumpsys battery set level 57; echo ${BATTERY_DRIFT_MARKER}`);
  assert.throws(() => buildBatteryDriftScript('5;7'));
  assert.throws(() => buildBatteryDriftScript(101));
  assert.throws(() => buildBatteryDriftScript(undefined));
});

// ---------------------------------------------------------------- browser args

test('browser args: default policy switch + marker + readback shape', () => {
  const s = buildBrowserArgsProvisionScript({});
  assert.ok(s.includes('--webrtc-ip-handling-policy=default_public_interface_only'));
  assert.ok(s.includes('/data/local/tmp/webview-command-line'));
  assert.ok(s.includes('setprop webviewcommandline'));
  assert.ok(s.includes('settings put global webrtc_ip_handling_policy default_public_interface_only'));
  assert.ok(s.endsWith(`${BROWSER_ARGS_MARKER} args=--webrtc-ip-handling-policy=default_public_interface_only dns=off`));
  assert.doesNotMatch(buildWebviewCommandLine({}), /[<>|&$`]/); // flag value itself carries no shell surface
});

test('browser args: every policy switch serialises; unknown throws', () => {
  for (const p of WEBRTC_IP_POLICIES) {
    assert.equal(buildWebviewCommandLine({ webrtcPolicy: p }), `--webrtc-ip-handling-policy=${p}`);
  }
  assert.throws(() => buildWebviewCommandLine({ webrtcPolicy: 'disable_all' }));
});

test('browser args: operator launchArgs override replaces the switch, shell metacharacters refused', () => {
  assert.equal(buildWebviewCommandLine({ launchArgs: '--webrtc-ip-handling-policy=disable_udp --mute-audio' }), '--webrtc-ip-handling-policy=disable_udp --mute-audio');
  assert.throws(() => buildWebviewCommandLine({ launchArgs: '--x; rm -rf /' }));
  assert.throws(() => buildWebviewCommandLine({ launchArgs: '--x --y=$(whoami)' }));
});

test('browser args: private DNS is OFF by default and validated when set', () => {
  assert.equal(validateDnsResolver(''), '');
  assert.equal(validateDnsResolver(null), '');
  assert.equal(validateDnsResolver('dns.google'), 'dns.google');
  assert.throws(() => validateDnsResolver('dns google;rm'));
  const s = buildBrowserArgsProvisionScript({ dnsResolver: 'dns.google' });
  assert.ok(s.includes('settings put global private_dns_mode hostname'));
  assert.ok(s.includes('settings put global private_dns dns.google'));
  assert.ok(s.endsWith(`dns=dns.google`));
});

// ---------------------------------------------------------------- region check

test('region: timezone map + locale subtag derivation', () => {
  assert.equal(regionFromTimezone('Europe/Paris'), 'FR');
  assert.equal(regionFromTimezone('Mars/Phobos'), null); // unmapped = unverifiable
  assert.equal(regionFromLocale('en-US'), 'US');
  assert.equal(regionFromLocale('zh-Hant-TW'), 'TW');
  assert.equal(regionFromLocale('fil'), null);
  assert.equal(regionFromLocale('sr_Latn'), null); // script subtag, NOT a region
  assert.equal(profileRegionFrom({ timezone: 'Mars/Phobos', locale: 'en-GB' }), 'GB');
});

test('region: the D2 case fails on BOTH axes independently', () => {
  const r = checkRegionConsistency({ egressRegion: 'CN', timezone: 'Europe/Paris', locale: 'en-US' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.mismatches.sort(), ['locale', 'timezone']);
  assert.equal(r.tzRegion, 'FR');
  assert.equal(r.localeRegion, 'US');
});

test('region: consistent binding passes; absent/unverifiable inputs are NOT failures', () => {
  assert.equal(checkRegionConsistency({ egressRegion: 'HK', timezone: 'Asia/Hong_Kong', locale: 'zh-Hant-HK' }).ok, true);
  assert.equal(checkRegionConsistency({ egressRegion: '', timezone: 'Europe/Paris', locale: 'en-US' }).ok, true);
  const unv = checkRegionConsistency({ egressRegion: 'XX', timezone: 'Mars/Phobos', locale: 'xx' });
  assert.equal(unv.ok, true);
  assert.equal(unv.unverifiable, true);
});

// ---------------------------------------------------------------- egress service region flow

function fakeDb(fp) {
  const binding = { id: 'b1' };
  const rows = [];
  return {
    _rows: rows,
    identity: { findUnique: async () => ({ id: 'id1' }) },
    identityFingerprint: fp === undefined ? undefined : { findUnique: async () => fp },
    device: { count: async () => 0, updateMany: async () => ({ count: 0 }) },
    identityEgress: {
      findFirst: async () => null,
      findUnique: async () => rows[0] ?? null,
      create: async ({ data }) => { rows.push({ ...data }); return rows[0]; },
      update: async ({ data }) => { Object.assign(rows[0], data); return rows[0]; },
      delete: async () => { rows.length = 0; },
    },
  };
}

function svc(db) {
  return createIdentityEgressService({ db, config: { encryptionKey: 'wa-stealth-fix2-unit-key-material-0123456789' }, audit: null });
}
const BIND = { proxyUrl: 'socks5://h:1080', expectedEgressIp: '1.2.3.4' };

test('egress region: D2 shape → 409 EGRESS_REGION_MISMATCH; override admits + audits', async () => {
  const audits = [];
  const db = fakeDb({ timezone: 'Europe/Paris', locale: 'en-US' });
  const s = svc(db);
  // base create WITHOUT region → legacy path unchanged (no region stored)
  const v0 = await s.upsertBinding('id1', { ...BIND });
  assert.equal(v0.region, null);
  // now the same identity declares a CN exit → mismatch on both axes
  await assert.rejects(
    () => s.upsertBinding('id1', { ...BIND, region: 'CN' }),
    (e) => e.statusCode === 409 && e.apiCode === 'EGRESS_REGION_MISMATCH',
  );
  // regionOverride admits it (admin acknowledgement — stored + visible)
  const s2 = createIdentityEgressService({ db, config: { encryptionKey: 'wa-stealth-fix2-unit-key-material-0123456789' }, audit: (a) => audits.push(a) });
  const v1 = await s2.upsertBinding('id1', { ...BIND, region: 'CN', regionOverride: true }, { actorUserId: 'admin1' });
  assert.equal(v1.region, 'CN');
  assert.ok(audits.some((a) => a.action === 'identity.egress_region_override' && a.details.mismatches.length === 2));
});

test('egress region: consistent region stores; invalid region is a 400', async () => {
  const db = fakeDb({ timezone: 'Asia/Hong_Kong', locale: 'zh-Hant-HK' });
  const s = svc(db);
  const v = await s.upsertBinding('id1', { ...BIND, region: 'HK' });
  assert.equal(v.region, 'HK');
  await assert.rejects(
    () => s.upsertBinding('id1', { ...BIND, region: 'hkk' }),
    (e) => e.statusCode === 400 && e.apiCode === 'EGRESS_REGION_INVALID',
  );
  // region-less PUT over a region-bearing row keeps the story coherent (no drift)
  const v2 = await s.upsertBinding('id1', { ...BIND });
  assert.equal(v2.region, null); // explicit: region is part of the expectation, absent = null
});

test('egress region: no fingerprint row = unverifiable, never blocks (fail-open ruling)', async () => {
  const db = fakeDb(undefined); // db.identityFingerprint absent entirely
  const s = svc(db);
  const v = await s.upsertBinding('id1', { ...BIND, region: 'SG' });
  assert.equal(v.region, 'SG');
});

// ---------------------------------------------------------------- OUI pool (F2)

test('OUI pool: Nothing has a curated brand pool (IEEE-verified, adv-a4 tell fixed)', () => {
  assert.deepEqual(PHONE_OUI_POOL.nothing, ['3c:b0:ed', '2c:be:eb', '2c:be:ee']);
  assert.ok(ouiCandidates({ brand: 'Nothing' }) === PHONE_OUI_POOL.nothing); // brand normalised
  for (const oui of PHONE_OUI_POOL.nothing) {
    assert.ok(OUI_POOL_FLAT.includes(oui));
    assert.equal(parseInt(oui.slice(0, 2), 16) & 0x02, 0); // unicast/global bits stay clean
  }
});
