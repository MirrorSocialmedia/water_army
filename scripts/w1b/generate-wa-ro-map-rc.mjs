#!/usr/bin/env node
/**
 * Regenerate images/redroid-w1b/oem-ro-map.rc from the single source of truth
 * (packages/shared/src/w1b-image-mapping.js). CI diff = unit drift test.
 * Usage: node scripts/w1b/generate-wa-ro-map-rc.mjs [--check]
 *   --check: exit 1 if the committed file differs (no write).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateWaRoMapRc } from '../../packages/shared/src/w1b-image-mapping.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TARGET = join(ROOT, 'images', 'redroid-w1b', 'oem-ro-map.rc');
const rc = generateWaRoMapRc();

if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(TARGET, 'utf8'); } catch { /* missing counts as drift */ }
  if (current !== rc) {
    console.error('oem-ro-map.rc is DRIFTED from w1b-image-mapping.js — run: node scripts/w1b/generate-wa-ro-map-rc.mjs');
    process.exit(1);
  }
  console.log('oem-ro-map.rc in sync');
} else {
  writeFileSync(TARGET, rc);
  console.log('wrote', TARGET);
}
