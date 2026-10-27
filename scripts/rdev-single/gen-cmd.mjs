#!/usr/bin/env node
/**
 * rdev-single (P1) — deterministic boot material generator.
 *
 * Produces, WITHOUT the platform API (single-box scratch parity with
 * redroid-service.createDevice):
 *   - profile        : generateTemplateProfile(identityId) — the W1b template
 *                      ground truth (probe-assert --expected input)
 *   - roOverrides    : templateProfileToRoOverrides (model %20-encoded)
 *   - cmd            : exact docker Cmd (buildRedroidCmd semantics + oem carriers)
 *
 * Usage:
 *   node scripts/rdev-single/gen-cmd.mjs --identity <id8-64> [--template <id>] \
 *        [--width 720 --height 1280 --dpi 320 --fps 30 --gpu host] > boot.json
 */
import { loadBuildTemplates, generateTemplateProfile, templateProfileToRoOverrides, buildRoCmdArgs } from '../../packages/shared/src/index.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const identityId = arg('identity', '');
const templateId = arg('template', null);
if (!/^[A-Za-z0-9_-]{8,64}$/.test(identityId)) {
  console.error('usage: gen-cmd.mjs --identity <8-64 [A-Za-z0-9_-]> [--template <id>]');
  process.exit(2);
}
let templates = loadBuildTemplates();
if (templateId) {
  templates = templates.filter((t) => t.id === templateId);
  if (!templates.length) { console.error(`template not found: ${templateId}`); process.exit(2); }
}
// Determinism: pin the pool to the requested template (or full verified pool).
const profile = generateTemplateProfile(identityId, { templates });
const roOverrides = templateProfileToRoOverrides(profile);
const width = +arg('width', 720), height = +arg('height', 1280), dpi = +arg('dpi', 320), fps = +arg('fps', 30);
const gpu = arg('gpu', 'host');
const cmd = [
  `androidboot.redroid_width=${width}`,
  `androidboot.redroid_height=${height}`,
  `androidboot.redroid_dpi=${dpi}`,
  `androidboot.redroid_fps=${fps}`,
  `androidboot.redroid_gpu_mode=${gpu}`,
  ...buildRoCmdArgs(roOverrides),
];
process.stdout.write(JSON.stringify({
  identityId, templateId: profile.templateId, image: 'water-army/redroid:14.0.0-240527-w1b',
  profile, roOverrides, cmd,
}, null, 2) + '\n');
