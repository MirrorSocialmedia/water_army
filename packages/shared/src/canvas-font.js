/**
 * WA-FIX2B (R3) — per-device canvas raster fingerprint (font variant).
 *
 * Boss ruling 2026-10-29 22:15: canvas hash must differ PER DEVICE, seeded
 * from the identity/profile (deterministic + reproducible — NO hardcoded
 * per-device ifs). Carrier: bind-mount a real Roboto WEIGHT variant over
 * /system/fonts/Roboto-Regular.ttf (the ONLY sans-serif raster the image
 * maps — s1 evidence: identical canvas hash across machines).
 *
 * Determinism contract (same as the MAC / profile layers):
 *   seed = profile.serial (per-device random-format, stored on the identity)
 *        + model + device + templateId — joined, FNV-1a → variant index.
 *   Same identity → same variant, every boot / recreate / host.
 *   'regular' = the image's own file → NO mount (baseline raster untouched).
 *
 * Variants are real Roboto static weights instantiated from the Google
 * variable font (images/fonts/canvas-weights/ + SOURCE.sha256 provenance);
 * Apache-2.0 licensed. Layout metrics are near-identical (same family), the
 * glyph raster differs → per-device canvas text fingerprint moves.
 */
export const CANVAS_FONT_VARIANTS = Object.freeze(['regular', 'thin', 'light', 'medium', 'black']);

/** variant -> repo asset file ('regular' = image default, no mount). */
export const CANVAS_FONT_FILES = Object.freeze({
  regular: null,
  thin: 'Roboto-Thin.ttf',
  light: 'Roboto-Light.ttf',
  medium: 'Roboto-Medium.ttf',
  black: 'Roboto-Black.ttf',
});

/** The in-device path every sans-serif raster (canvas included) resolves to. */
export const CANVAS_FONT_TARGET = '/system/fonts/Roboto-Regular.ttf';

/** FNV-1a (32-bit) over a UTF-8 seed string — stable, host-independent. */
export function fnv1a32(seedStr) {
  let h = 0x811c9dc5;
  const buf = Buffer.from(String(seedStr), 'utf8');
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Canonical seed string from a profile (field order fixed — JSON key order
 *  of the stored profileJson must not move the bucket). */
export function canvasFontSeed(profile) {
  if (!profile || typeof profile !== 'object') throw new Error('canvasFontSeed: profile object required');
  const parts = [profile.serial ?? '', profile.model ?? '', profile.device ?? '', profile.templateId ?? ''];
  if (!parts.some((p) => p !== '')) {
    throw new Error(`canvasFontSeed: profile carries no usable seed fields (${JSON.stringify(Object.keys(profile)).slice(0, 120)})`);
  }
  return `canvas-font:${parts.join('|')}`;
}

/** variant name for a profile ('regular' = no mount). */
export function canvasFontVariantForProfile(profile) {
  const idx = fnv1a32(canvasFontSeed(profile)) % CANVAS_FONT_VARIANTS.length;
  return CANVAS_FONT_VARIANTS[idx];
}

/** plan = { variant, file|null } — file null => 'regular', no mount. */
export function canvasFontPlanForProfile(profile) {
  const variant = canvasFontVariantForProfile(profile);
  return { variant, file: CANVAS_FONT_FILES[variant] };
}
