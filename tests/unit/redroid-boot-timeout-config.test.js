/**
 * R3 live-found (2026-10-20): `redroidTunnelBootTimeoutMs` was read by
 * redroid-service (provisionTunnel boot wait + watchdog stuck-starting
 * guard) but NEVER mapped from env in config.js — the knob silently did
 * not exist, and a real 14+ min first boot was hard-failed at 600s.
 *
 * R6 calibration (R5 live evidence): a REAL fresh boot took ~24min on the
 * live host (2026-10-20 23:17:24 → 23:41 adb 'device' + boot_completed=1;
 * documented range 14–20min + margin), and a RECREATE boots ≈ cold boot.
 * 600s would hard-fail healthy-but-slow boots with
 * REDROID_TUNNEL_BOOT_TIMEOUT, so the default is calibrated to 2400s
 * (40min = 2× the observed worst case). The R4 live host already ran
 * REDROID_TUNNEL_BOOT_TIMEOUT_MS=2400000 via env — this just makes the
 * code default honest. Fast hosts may lower it via env.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../../apps/api/src/config.js';

test('redroidTunnelBootTimeoutMs: 2400s calibrated default (R6: real cold boot ≈ 24min)', () => {
  assert.equal(loadConfig({}).redroidTunnelBootTimeoutMs, 2_400_000);
});

test('redroidTunnelBootTimeoutMs: REDROID_TUNNEL_BOOT_TIMEOUT_MS overrides', () => {
  assert.equal(
    loadConfig({ REDROID_TUNNEL_BOOT_TIMEOUT_MS: '1800000' }).redroidTunnelBootTimeoutMs,
    1_800_000,
  );
  // non-numeric → config fail-fast (optInt contract), never a silent default
  assert.throws(
    () => loadConfig({ REDROID_TUNNEL_BOOT_TIMEOUT_MS: 'bogus' }),
    /REDROID_TUNNEL_BOOT_TIMEOUT_MS must be a positive integer/,
  );
});
