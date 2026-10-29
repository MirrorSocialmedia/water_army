#!/usr/bin/env node
/**
 * Regenerate the image init artifacts from the single source of truth:
 *   images/redroid-w1b/oem-ro-map.rc           <- w1b-image-mapping.js (ADR-028/031)
 *   images/redroid-w1b/oem-ro-map-stealth.rc   <- + WA-VMSTEALTH stealth layer (S1 §4.2)
 *   images/redroid-w1b/oem-proc-view.rc        <- device-spec.js (L2 wave-2, ADR-033)
 * CI diff = unit drift test. Usage: node scripts/w1b/generate-wa-ro-map-rc.mjs [--check]
 *   --check: exit 1 if any committed file differs (no write).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateWaRoMapRc, generateWaRoMapStealthRc } from '../../packages/shared/src/w1b-image-mapping.js';
import { generateProcViewRc } from '../../packages/shared/src/device-spec.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TARGETS = [
  [join(ROOT, 'images', 'redroid-w1b', 'oem-ro-map.rc'), generateWaRoMapRc()],
  [join(ROOT, 'images', 'redroid-w1b', 'oem-ro-map-stealth.rc'), generateWaRoMapStealthRc()],
  [join(ROOT, 'images', 'redroid-w1b', 'oem-proc-view.rc'), generateProcViewRc()],
];

if (process.argv.includes('--check')) {
  let drift = false;
  for (const [target, want] of TARGETS) {
    let current = '';
    try { current = readFileSync(target, 'utf8'); } catch { /* missing counts as drift */ }
    if (current !== want) {
      console.error(`${target.split('/').pop()} is DRIFTED from its generator — run: node scripts/w1b/generate-wa-ro-map-rc.mjs`);
      drift = true;
    }
  }
  if (drift) process.exit(1);
  console.log('image rc artifacts in sync (oem-ro-map.rc, oem-ro-map-stealth.rc, oem-proc-view.rc)');
} else {
  for (const [target, content] of TARGETS) {
    writeFileSync(target, content);
    console.log('wrote', target);
  }
}
