/**
 * W1b (ADR-028) integration — REAL build-profile templates through the device
 * create path + fleet semantics.
 *
 * Hard assertions:
 *  1. Template mode ON (WA_TEMPLATE_PROFILES_ENABLED, subordinate to the W1
 *     injection switch): create with identityId → profile drawn from the
 *     verified real-build pool; Cmd carries oem_* args with the model
 *     %20-encoded (real models contain spaces; carrier forbids them); device
 *     row snapshot agrees; schemaVersion 2 recorded.
 *  2. Shared-build fleet semantics: two identities on the SAME template share
 *     fingerprint + displayId (the real-world relation) without a collision
 *     error; serials stay distinct; the collision endpoint stays non-blocking.
 *  3. Generator stickiness: a fleet with existing W1 rows flips template mode
 *     ON — ensureProfile replays the stored W1 profile (no drift, no silent
 *     re-derivation); NEW identities get template profiles.
 *
 * On-device consumption (oem-propctl mapping) = real-device stage, ADR-028.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { makeRedroidTestApp, login, seedRedroidTemplates } from '../helpers/redroid-fakes.js';
import { loadBuildTemplates, generateTemplateProfile, templateProfileToRoOverrides } from '../../packages/shared/src/w1b-profiles.js';
import { generateFingerprintProfile, profileToRoOverrides, propToAndroidbootKey } from '../../packages/shared/src/fingerprint-profile.js';
import { createFingerprintService } from '../../apps/api/src/services/fingerprint-service.js';

async function makeApp(opts = {}) {
  const { app, db, dataRoot, redroidMock } = await makeRedroidTestApp(opts);
  const cookies = { admin: await login(app, 'admin'), operator: await login(app, 'operator') };
  await seedRedroidTemplates(app, cookies.admin);
  return {
    app, db, dataRoot, redroidMock, cookies,
    close: async () => {
      await app.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

function lastCreateBody(redroidMock) {
  const calls = redroidMock.docker.client.__calls.filter((c) => c.method === 'createContainer');
  return calls.at(-1)?.cfg._body ?? null;
}

const ON = { configOverride: { redroidRoOverridesEnabled: true } };
const ON_TPL = { configOverride: { redroidRoOverridesEnabled: true, redroidTemplateProfilesEnabled: true } };

test('template mode ON: real-build profile in Cmd (oem_* + %20 model), row schemaVersion 2', async (t) => {
  const { app, db, cookies, redroidMock, close } = await makeApp(ON_TPL);
  t.after(close);
  const ident = await db.identity.create({ data: { id: randomUUID(), displayName: 'w1b-on' } });
  const expected = generateTemplateProfile(ident.id);

  const res = await app.inject({
    method: 'POST', url: '/api/devices/redroid',
    headers: { cookie: cookies.operator },
    payload: { name: 'redroid-w1b-on', templateName: 'redroid-14-swiftshader', idempotencyKey: 'w1b-on-00001', identityId: ident.id },
  });
  assert.equal(res.statusCode, 201, res.body);
  const { device } = res.json();
  assert.equal(device.identityId, ident.id);
  assert.deepEqual(device.roOverrides, templateProfileToRoOverrides(expected), 'snapshot = template overrides');

  const cmd = lastCreateBody(redroidMock).Cmd;
  assert.deepEqual(cmd.slice(0, 5), [
    'androidboot.redroid_width=720',
    'androidboot.redroid_height=1280',
    'androidboot.redroid_dpi=320',
    'androidboot.redroid_fps=20',
    'androidboot.redroid_gpu_mode=swiftshader_indirect',
  ], 'base args untouched');
  assert.ok(cmd.includes(`${propToAndroidbootKey('ro.build.fingerprint')}=${expected.fingerprint}`), 'real fingerprint rides the Cmd');
  const modelArg = cmd.find((a) => a.startsWith(propToAndroidbootKey('ro.product.model') + '='));
  assert.equal(modelArg, `${propToAndroidbootKey('ro.product.model')}=${expected.model.replaceAll(' ', '%20')}`, 'model %20-encoded (no raw spaces on the cmdline)');
  assert.ok(!modelArg.slice(modelArg.indexOf('=') + 1).includes(' '), 'carrier value has no raw space');

  // the profile is a VERBATIM real build (not synthetic): fingerprint must exist in the verified pool
  const pool = new Set(loadBuildTemplates().filter((x) => x.verified).map((x) => x.fields.fingerprint));
  assert.ok(pool.has(expected.fingerprint), 'generated fingerprint is a real shipped build');

  const row = await db.identityFingerprint.findUnique({ where: { identityId: ident.id } });
  assert.equal(row.profileJson.templateId, expected.templateId);
  assert.equal(row.schemaVersion, 2, 'template-backed rows record schemaVersion 2');
});

test('shared-build fleet: same template → fingerprint/displayId repeat legally, serials unique, audit non-blocking', async (t) => {
  const { app, db, cookies, close } = await makeApp(ON_TPL);
  t.after(close);
  // find two uuids that deterministically draw the SAME template
  const draws = new Map();
  let twin = null;
  for (;;) {
    const id = randomUUID();
    const tpl = generateTemplateProfile(id).templateId;
    if (draws.has(tpl)) { twin = { first: draws.get(tpl), second: id, tpl }; break; }
    draws.set(tpl, id);
  }
  for (const [label, id] of [['first', twin.first], ['second', twin.second]]) {
    await db.identity.create({ data: { id, displayName: `w1b-twin-${label}` } });
    const ensured = await app.inject({ method: 'POST', url: `/api/identities/${id}/fingerprint`, headers: { cookie: cookies.admin } });
    assert.equal(ensured.statusCode, 200, `${label}: ${ensured.body}`);
  }
  const a = generateTemplateProfile(twin.first);
  const b = generateTemplateProfile(twin.second);
  assert.equal(a.templateId, b.templateId);
  assert.equal(a.fingerprint, b.fingerprint, 'same template → same real build fingerprint');
  assert.notEqual(a.serial, b.serial, 'serials stay per-device distinct');

  const audit = await app.inject({ method: 'GET', url: '/api/identities/fingerprints/collisions', headers: { cookie: cookies.admin } });
  assert.equal(audit.statusCode, 200, audit.body);
  assert.equal(audit.json().blocking, false, 'shared fingerprint/displayId must NOT be fleet-blocking under template semantics');
});

test('generator stickiness: template mode ON never re-derives existing W1 rows; new identities get templates', async (t) => {
  const { app, db, cookies, close } = await makeApp(ON); // W1 mode fleet
  t.after(close);
  const w1ident = await db.identity.create({ data: { id: randomUUID(), displayName: 'w1-sticky' } });
  const w1svc = app.fingerprintService; // built with templateProfiles=false
  await w1svc.ensureProfile(w1ident.id);
  const w1Row = await db.identityFingerprint.findUnique({ where: { identityId: w1ident.id } });
  assert.equal(w1Row.profileJson.templateId, undefined);

  // operator flips the switch mid-fleet: SAME db, template-mode service
  const tplSvc = createFingerprintService({ db, log: console, templateProfiles: true });
  const replayed = await tplSvc.resolveForDeviceCreate(w1ident.id);
  assert.deepEqual(replayed, w1Row.profileJson, 'stored W1 profile replays unchanged (no drift, no silent template swap)');

  const fresh = await db.identity.create({ data: { id: randomUUID(), displayName: 'w1b-fresh' } });
  const got = await tplSvc.resolveForDeviceCreate(fresh.id);
  assert.ok(got.templateId, 'new identity under the flipped switch draws a template profile');
});
