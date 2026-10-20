/**
 * R3 live-found (2026-10-20): `redroidTunnelBootTimeoutMs` was read by
 * redroid-service (provisionTunnel boot wait + watchdog stuck-starting
 * guard) but NEVER mapped from env in config.js — the knob silently did
 * not exist, and a real 14+ min first boot was hard-failed at 600s.
 * Pins the env wiring + the unchanged 600s production default.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../../apps/api/src/config.js';

test('redroidTunnelBootTimeoutMs: 600s production default', () => {
  assert.equal(loadConfig({}).redroidTunnelBootTimeoutMs, 600_000);
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
