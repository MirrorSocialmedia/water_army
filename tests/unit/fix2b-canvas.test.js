/**
 * WA-FIX2B (R3) — units for the canvas font variant seed (pure, hermetic).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANVAS_FONT_VARIANTS, CANVAS_FONT_FILES, CANVAS_FONT_TARGET,
  fnv1a32, canvasFontSeed, canvasFontVariantForProfile, canvasFontPlanForProfile,
} from '@water-army/shared';

test('fnv1a32: stable, 32-bit, order-sensitive', () => {
  assert.equal(fnv1a32('canvas-font:A|B|C|D'), fnv1a32('canvas-font:A|B|C|D'));
  assert.notEqual(fnv1a32('canvas-font:A|B|C|D'), fnv1a32('canvas-font:A|B|C|E'));
  const h = fnv1a32('x');
  assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
});

test('canvasFontSeed: needs at least one seed field; serial dominates', () => {
  assert.match(canvasFontSeed({ serial: 'S1', model: 'M', device: 'd', templateId: 't' }), /canvas-font:S1\|M\|d\|t/);
  assert.throws(() => canvasFontSeed({}), /no usable seed fields/);
  assert.throws(() => canvasFontSeed(null), /profile object required/);
  // missing optional fields degrade to empty parts, not a throw
  assert.match(canvasFontSeed({ serial: 'S2' }), /canvas-font:S2\|\|\|/);
});

test('variant selection: in-set, deterministic, plan matches table', () => {
  const profile = { serial: 'FIX2BTEST01', model: 'Pixel 8', device: 'shiba' };
  const v1 = canvasFontVariantForProfile(profile);
  const v2 = canvasFontVariantForProfile({ ...profile });
  assert.ok(CANVAS_FONT_VARIANTS.includes(v1));
  assert.equal(v1, v2, 'pure across recomputation');
  const plan = canvasFontPlanForProfile(profile);
  assert.equal(plan.variant, v1);
  assert.equal(plan.file, CANVAS_FONT_FILES[v1]);
  if (v1 === 'regular') assert.equal(plan.file, null, 'regular = image default, no mount');
});

test('distribution sanity: 400 distinct profiles reach >= 4 of the 5 buckets', () => {
  const buckets = new Set();
  for (let i = 0; i < 400; i++) {
    buckets.add(canvasFontVariantForProfile({ serial: `SER${String(i).padStart(6, '0')}` }));
  }
  assert.ok(buckets.size >= 4, `only ${buckets.size} buckets hit: ${[...buckets]}`);
  assert.ok(CANVAS_FONT_VARIANTS.length === 5 && CANVAS_FONT_TARGET === '/system/fonts/Roboto-Regular.ttf');
});
