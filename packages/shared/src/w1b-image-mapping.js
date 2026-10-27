/**
 * W1b P1/P2 — the carrier→ro.* mapping contract for the w1b image.
 *
 * The w1b redroid image boots with an init hook (/vendor/etc/init/wa-ro-map.rc
 * — auto-imported by Android init because it lives in /vendor/etc/init/) that
 * maps the cmdline carrier props (androidboot.oem_* → ro.boot.oem_*) onto
 * their real ro.* targets using resetprop, bypassing init's one-time-write
 * ro.* rule (ro.build.* are already populated from build.prop long before
 * early-init, so plain `setprop` would silently no-op — that is exactly why
 * Magisk resetprop is baked into the image; see images/redroid-w1b/).
 *
 * THIS MODULE IS THE SINGLE SOURCE OF TRUTH for the mapping table. The .rc
 * file is a GENERATED artifact (images/redroid-w1b/wa-ro-map.rc); a unit test
 * re-runs generateWaRoMapRc() and diffs it against the committed file — the
 * platform side (Cmd injection) and the image side (init mapping) cannot
 * drift apart silently.
 *
 * Trigger design (stock redroid 14 verified against its init.rc import chain):
 *  - one `on early-init && property:<carrier>=*` action per prop: the action
 *    only runs when THAT carrier is actually present (partial maps legal,
 *    absent props leave the image default untouched);
 *  - `${ro.boot.oem_*}` expansion happens inside init (no shell in the image —
 *    /system/bin/sh needs the APEX linker which is not mounted until early-fs);
 *  - values are word-expanded by init: profile values are validated to
 *    contain no spaces/globs before they can reach the Cmd line
 *    (SAFE_PROFILE_VALUE_RE), so expansion is single-word by construction.
 */

import { PROFILE_PROP_MAP, propToAndroidbootKey } from './fingerprint-profile.js';

/** Carrier prop (ro.boot.* namespace, device side) for an ro.* target prop. */
export function propToCarrierRoKey(prop) {
  return propToAndroidbootKey(prop).replace(/^androidboot\./, 'ro.boot.');
}

/**
 * The 9-entry mapping table: carrier ro.boot key → real ro.* target.
 * Order = stable (sorted by target) for byte-deterministic rc generation.
 */
export function carrierMappingTable() {
  return Object.entries(PROFILE_PROP_MAP)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([field, prop]) => ({ field, target: prop, carrier: propToCarrierRoKey(prop) }));
}

/**
 * NOTE: no redroid-internal carriers are re-mapped here. Stock redroid's own
 * init logic reads its ro.boot.* knobs directly (redroid.common.rc conditions
 * on property:ro.boot.use_redroid_overlayfs), so only the 9 identity props
 * need the mapping.
 */

/**
 * Generate the committed init rc artifact. Byte-deterministic.
 * The resetprop binary lands at /vendor/bin/wa-propctl (baked, sha256-pinned
 * from the official Magisk release — provenance in images/redroid-w1b/resetprop.provenance.md).
 */
export function generateWaRoMapRc() {
  const rows = carrierMappingTable();
  const out = [];
  out.push('# water_army W1b — carrier -> ro.* mapping (GENERATED — do not hand-edit)');
  out.push('# regenerate: node scripts/w1b/generate-wa-ro-map-rc.mjs');
  out.push('# source of truth: packages/shared/src/w1b-image-mapping.js (unit-diffed in CI)');
  out.push('#');
  out.push('# early-init: for every androidboot.oem_* carrier present on the kernel');
  out.push('# cmdline (init exposes them as ro.boot.oem_*), rewrite the REAL ro.* prop via');
  out.push('# resetprop (bypasses the ro.* one-time-write rule; ro.build.* are already');
  out.push('# loaded from build.prop before early-init). Absent carrier = no action.');
  out.push('');
  for (const r of rows) {
    out.push(`on early-init && property:${r.carrier}=*`);
    out.push(`    exec -- /vendor/bin/wa-propctl --set ${r.target}=\${${r.carrier}}`);
  }
  out.push('');
  return out.join('\n');
}

/**
 * Parse an rc artifact back into the table (drift check + shell-harness input).
 * @returns {{rows: Array<{carrier: string, target: string}>, problems: string[]}}
 */
export function parseWaRoMapRc(text) {
  const problems = [];
  const rows = [];
  const lines = String(text ?? '').split('\n');
  let pending = null;
  for (const [i, line] of lines.entries()) {
    const trig = line.match(/^on early-init && property:([A-Za-z0-9_.]+)=\*$/);
    if (trig) {
      if (pending) problems.push(`line ${i}: trigger without matching exec (previous: ${pending.carrier})`);
      pending = { carrier: trig[1] };
      continue;
    }
    const exec = line.match(/^ {4}exec -- \/vendor\/bin\/wa-propctl --set ([A-Za-z0-9_.]+)=\$\{([A-Za-z0-9_.]+)\}$/);
    if (exec) {
      if (!pending) { problems.push(`line ${i}: exec without trigger`); continue; }
      if (exec[2] !== pending.carrier) problems.push(`line ${i}: exec carrier ${exec[2]} does not match trigger ${pending.carrier}`);
      rows.push({ carrier: pending.carrier, target: exec[1] });
      pending = null;
      continue;
    }
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    problems.push(`line ${i}: unexpected rc content "${line.slice(0, 60)}"`);
  }
  if (pending) problems.push(`dangling trigger without exec: ${pending.carrier}`);
  return { rows, problems };
}
