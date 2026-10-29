/**
 * WA-FIX2B (R3) integration — per-device canvas font variant mount.
 *
 * Hermetic (mock docker + tmp data root): the create path stages a real
 * Roboto weight variant (seeded deterministically from the identity
 * profile) into the device data dir and bind-mounts it over
 * /system/fonts/Roboto-Regular.ttf — the ONLY sans-serif raster the image
 * carries, so canvas text hashes move PER DEVICE.
 *
 * Assertions:
 *  1. stealth ON + non-'regular' variant → two Mounts (data + font), staged
 *     file byte-identical to the repo asset; 'regular' profile → no mount.
 *  2. determinism: the variant follows the PROFILE (same identity recomputes
 *     the same bucket), and two identities in different buckets get
 *     different files (A≠B — the boss acceptance for per-device canvas).
 *  3. stealth gate OFF → Mounts byte-identical to legacy (exactly the /data
 *     bind), nothing staged (zero behaviour change).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { makeRedroidTestApp, login, seedRedroidTemplates } from '../helpers/redroid-fakes.js';
import { generateFingerprintProfile } from '../../packages/shared/src/fingerprint-profile.js';
import {
  CANVAS_FONT_TARGET, CANVAS_FONT_VARIANTS, CANVAS_FONT_FILES,
  canvasFontVariantForProfile,
} from '../../packages/shared/src/canvas-font.js';

const ASSETS = path.join(process.cwd(), 'images', 'fonts', 'canvas-weights');

async function makeApp(configOverride) {
  const { app, db, dataRoot, redroidMock } = await makeRedroidTestApp({ configOverride });
  const cookies = { admin: await login(app, 'admin'), operator: await login(app, 'operator') };
  await seedRedroidTemplates(app, cookies.admin);
  return {
    app, db, dataRoot, redroidMock, cookies,
    close: async () => { await app.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); },
  };
}
function lastCreateBody(redroidMock) {
  const calls = redroidMock.docker.client.__calls.filter((c) => c.method === 'createContainer');
  return calls.at(-1)?.cfg._body ?? null;
}
async function createDevice(app, cookies, name, identityId) {
  const res = await app.inject({
    method: 'POST', url: '/api/devices/redroid',
    headers: { cookie: cookies.operator },
    payload: { name, templateName: 'redroid-14-swiftshader', idempotencyKey: `fix2b-${name}`, identityId },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().device;
}
// deterministic identity ids: UUID-shaped strings (the route schema enforces
// the pattern) enumerated so the SHARED bucket fn lands on a wanted variant.
function idsByVariant(wantVariant, want = 1) {
  const out = [];
  for (let i = 0; out.length < want && i < 65536; i++) {
    const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
    if (canvasFontVariantForProfile(generateFingerprintProfile(id)) === wantVariant) out.push(id);
  }
  if (out.length < want) throw new Error(`no UUID maps to variant ${wantVariant} in first 65536`);
  return out;
}

test('assets present: all four variant files exist and are real TTFs', () => {
  for (const v of CANVAS_FONT_VARIANTS) {
    const f = CANVAS_FONT_FILES[v];
    if (f === null) continue; // regular = the image's own file (no mount)
    const p = path.join(ASSETS, f);
    const st = fs.statSync(p);
    assert.ok(st.size > 100_000, `${f} suspiciously small: ${st.size}`);
    assert.deepEqual(fs.readFileSync(p).subarray(0, 4), Buffer.from([0x00, 0x01, 0x00, 0x00]), `${f} not a sfnt`);
  }
});

test('stealth ON + non-regular variant: staged font file + second bind Mount at the sans-serif target', async (t) => {
  process.env.CANVAS_FONT_ASSETS_DIR = ASSETS;
  const { app, db, dataRoot, cookies, redroidMock, close } = await makeApp({ redroidRoOverridesEnabled: true, redroidStealthEnabled: true });
  t.after(close);
  const ident = await db.identity.create({ data: { id: idsByVariant('medium')[0], displayName: 'fix2b-med' } });
  assert.equal(canvasFontVariantForProfile(generateFingerprintProfile(ident.id)), 'medium', 'test identity must bucket to medium');
  const device = await createDevice(app, cookies, 'redroid-fb-med', ident.id);
  assert.equal(device.identityId, ident.id);

  const body = lastCreateBody(redroidMock);
  const mounts = body.HostConfig.Mounts;
  assert.equal(mounts.length, 2, `data + font mount expected, got: ${JSON.stringify(mounts)}`);
  assert.equal(mounts[0].Target, '/data');
  const fontMount = mounts.find((m) => m.Target === CANVAS_FONT_TARGET);
  assert.ok(fontMount, 'font mount at /system/fonts/Roboto-Regular.ttf');
  assert.equal(fontMount.Type, 'bind');
  const staged = fontMount.Source;
  assert.ok(staged.startsWith(path.join(dataRoot, 'redroid-fb-med')), 'staged file lives in the device data dir');
  assert.equal(fs.existsSync(staged), true, 'font staged before docker create');
  const asset = fs.readFileSync(path.join(ASSETS, CANVAS_FONT_FILES.medium));
  assert.deepEqual(fs.readFileSync(staged), asset, 'staged bytes = the repo asset');
});

test('determinism A≠B: two identities in different buckets → different staged bytes', async (t) => {
  process.env.CANVAS_FONT_ASSETS_DIR = ASSETS;
  const { app, db, cookies, redroidMock, close } = await makeApp({ redroidRoOverridesEnabled: true, redroidStealthEnabled: true });
  t.after(close);
  const a = await db.identity.create({ data: { id: idsByVariant('thin')[0], displayName: 'fix2b-a' } });
  const b = await db.identity.create({ data: { id: idsByVariant('black')[0], displayName: 'fix2b-b' } });
  const devA = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: { cookie: cookies.operator },
    payload: { name: 'redroid-fb-a1', templateName: 'redroid-14-swiftshader', idempotencyKey: 'fix2b-a1', identityId: a.id } });
  assert.equal(devA.statusCode, 201, devA.body);
  const srcA = lastCreateBody(redroidMock).HostConfig.Mounts.find((m) => m.Target === CANVAS_FONT_TARGET)?.Source;
  const devB = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: { cookie: cookies.operator },
    payload: { name: 'redroid-fb-b1', templateName: 'redroid-14-swiftshader', idempotencyKey: 'fix2b-b1', identityId: b.id } });
  assert.equal(devB.statusCode, 201, devB.body);
  const mountB = lastCreateBody(redroidMock).HostConfig.Mounts.find((m) => m.Target === CANVAS_FONT_TARGET);
  assert.ok(srcA && mountB?.Source, 'thin/black buckets are both non-regular → both mounted');
  assert.notDeepEqual(fs.readFileSync(srcA), fs.readFileSync(mountB.Source), 'different buckets → different staged bytes');
});

test('stealth gate OFF: Mounts stay byte-identical to legacy (only the /data bind), nothing staged', async (t) => {
  process.env.CANVAS_FONT_ASSETS_DIR = ASSETS;
  const { app, db, dataRoot, cookies, redroidMock, close } = await makeApp({ redroidRoOverridesEnabled: true, redroidStealthEnabled: false });
  t.after(close);
  const ident = await db.identity.create({ data: { id: randomUUID(), displayName: 'fix2b-off' } });
  const device = await createDevice(app, cookies, 'redroid-fb-off', ident.id);
  assert.equal(device.identityId, ident.id, 'profile still binds (Ro switch ON)');
  const mounts = lastCreateBody(redroidMock).HostConfig.Mounts;
  assert.deepEqual(mounts, [{ Type: 'bind', Source: path.join(dataRoot, 'redroid-fb-off'), Target: '/data', ReadOnly: false }]);
  assert.equal(fs.existsSync(path.join(dataRoot, 'redroid-fb-off', 'canvas-font.ttf')), false);
});
