/**
 * W1 (ADR-025) ro.* injection switch — DEFAULT FLIPPED OFF→ON on 2026-10-27
 * (老細拍板, Kairo mvq3juq1kmxzz R6-2; precondition: finalize.sh in the build
 * pipeline, 6bf179a). This file pins the post-flip contract of
 * WA_REDROID_RO_OVERRIDES_ENABLED:
 *   - unset → ON (production default; injection active),
 *   - explicit 1/true/yes/on → ON (explicit opt-in still honoured),
 *   - explicit 0/false/no/off → OFF (kill-switch semantics preserved),
 *   - garbage → OFF (positive-list fail-safe, same as the W1 original).
 * Subordinate switch WA_TEMPLATE_PROFILES_ENABLED stays default-OFF (ADR-028
 * real-device stage open) — pinned here too so a future flip can't sneak by.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../../apps/api/src/config.js';

// hermetic (same discipline as redroid-boot-timeout-config.test.js R7):
// fake-but-valid required fields + envFile:false (never read CWD/.env).
const base = {
  DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:5432/water_army_test',
  REDIS_URL: 'redis://127.0.0.1:6379',
  SESSION_SECRET: 'ci-test-session-secret-0000000000000000000000000000000',
  APP_ENCRYPTION_KEY: 'ci-test-encryption-key-00000000000000000000000000000000',
};
const cfg = (env = {}) => loadConfig({ ...base, ...env }, { envFile: false });

test('WA_REDROID_RO_OVERRIDES_ENABLED: unset → ON (default flip 2026-10-27, 老細拍板)', () => {
  assert.equal(cfg().redroidRoOverridesEnabled, true);
  assert.equal(cfg({ WA_REDROID_RO_OVERRIDES_ENABLED: '' }).redroidRoOverridesEnabled, false,
    'explicit empty string = garbage → fail-safe OFF (positive-list, pre-flip semantics)');
});

test('WA_REDROID_RO_OVERRIDES_ENABLED: explicit ON values honoured', () => {
  for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'On']) {
    assert.equal(cfg({ WA_REDROID_RO_OVERRIDES_ENABLED: v }).redroidRoOverridesEnabled, true, `env=${v} must be ON`);
  }
});

test('WA_REDROID_RO_OVERRIDES_ENABLED: kill-switch — explicit OFF values', () => {
  for (const v of ['0', 'false', 'no', 'off', 'FALSE', 'Off', 'banana']) {
    assert.equal(cfg({ WA_REDROID_RO_OVERRIDES_ENABLED: v }).redroidRoOverridesEnabled, false, `env=${v} must be OFF`);
  }
});

test('WA_TEMPLATE_PROFILES_ENABLED: subordinate template switch stays default-OFF (ADR-028 real-device stage open)', () => {
  assert.equal(cfg().redroidTemplateProfilesEnabled, false);
  assert.equal(cfg({ WA_TEMPLATE_PROFILES_ENABLED: 'true' }).redroidTemplateProfilesEnabled, true);
});
