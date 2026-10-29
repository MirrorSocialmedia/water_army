#!/usr/bin/env node
/**
 * WA-FIX2B (R2) — lvp/host-GLES cstr patch driver.
 *
 * Runs the pinned patch_cstr.mjs ops over an extracted copy of
 * /vendor/lib64/dri/libgallium_dri.so (the ONE fat-gallium every *_dri.so
 * symlinks to — s1/fx evidence: GLES face = host Mesa passthrough,
 * renderer "AMD Radeon Graphics (radeonsi, raphael_mendocino, ACO, DRM 3.57,
 * 6.8.0-117-generic)", version "OpenGL ES 3.2 Mesa 24.0.8 (git-441f064c1c)").
 *
 * Ops (fail closed, exact counts — same discipline as WA-VMSTEALTH):
 *  1. renderer suffix format  "%s (radeonsi, %s%s, DRM %i.%i%s)" -> "%s"
 *     kills radeonsi + chip + ACO + DRM + host kernel in GL_RENDERER.
 *     The remaining prefix is the amdgpu FIRMWARE sku string
 *     ("AMD Radeon Graphics", DRM ioctl — NOT an image file string,
 *     residual documented in the fix2b report).
 *  2. GL_VERSION format  "%s%u.%u%s Mesa 24.0.8 (git-441f064c1c)"
 *     -> "%s%u.%u%s V@0615"  => "OpenGL ES 3.2 V@0615" (Adreno-style V@tag).
 *  3. vendor  "AMD" -> "ARM" (130x, exact NUL-terminated standalone only)
 *     — kills GL_VENDOR "AMD"; "ARM" is mobile-plausible (real Android GL
 *     vendor token); zero behavioural strcmp risk (loader vendor tables are
 *     display strings; driver matching keys on uevent DRIVER=amdgpu).
 *
 * Zero layout change (NUL-pad, file size fixed) — worst case cosmetic.
 * Usage: patch-ops.mjs <file>
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PATCHER = join(HERE, '..', '..', 'scripts', 'stealth', 'patch_cstr.mjs');
const OPS = [
  ['%s (radeonsi, %s%s, DRM %i.%i%s)', '%s', '1'],
  ['%s%u.%u%s Mesa 24.0.8 (git-441f064c1c)', '%s%u.%u%s V@0615', '1'],
  ['AMD', 'ARM', '130'],
];
const file = process.argv[2];
if (!file) { console.error('usage: patch-ops.mjs <file>'); process.exit(2); }
for (const [oldS, newS, count] of OPS) {
  const out = execFileSync(process.execPath, [PATCHER, file, oldS, newS, count], { encoding: 'utf8' });
  process.stdout.write(out);
}
