/**
 * W1b P1/P2 — the carrier→ro.* mapping contract for the w1b image.
 *
 * The w1b redroid image boots with an init hook (/vendor/etc/init/oem-ro-map.rc
 * — auto-imported by Android init because it lives in /vendor/etc/init/) that
 * maps the cmdline carrier props (androidboot.oem_* → ro.boot.oem_*) onto
 * their real ro.* targets using oem-propctl (resetprop-rs — direct property
 * area write), bypassing init's one-time-write ro.* rule (ro.build.* are
 * already populated from build.prop long before early-init, so plain `setprop`
 * would silently no-op — that is exactly why resetprop-rs is baked into the
 * image; see images/redroid-w1b/propctl.provenance.md).
 *
 * THIS MODULE IS THE SINGLE SOURCE OF TRUTH for the mapping table. The .rc
 * file is a GENERATED artifact (images/redroid-w1b/oem-ro-map.rc); a unit test
 * re-runs generateWaRoMapRc() and diffs it against the committed file — the
 * platform side (Cmd injection) and the image side (init mapping) cannot
 * drift apart silently.
 *
 * Trigger design (stock redroid 14 verified against its init.rc import chain;
 * ADR-031 adds the post-fs-data phase for persist.* targets):
 *  - one `on <phase> && property:<carrier>=*` action per prop: the action
 *    only runs when THAT carrier is actually present (partial maps legal,
 *    absent props leave the image default untouched);
 *  - `${ro.boot.oem_*}` expansion happens inside init (no usable shell at
 *    early-init in the stock image — /system/bin/sh needs the APEX linker
 *    which is not mounted until early-fs);
 *  - values are word-expanded by init: profile values are validated to
 *    contain no spaces/globs before they can reach the Cmd line
 *    (SAFE_PROFILE_VALUE_RE), so expansion is single-word by construction.
 *    ro.product.model carries spaces as %20 — oem-propctl decodes %20 back
 *    to spaces when writing the prop (ADR-028);
 *  - CLI: `oem-propctl NAME VALUE` positional set (resetprop-rs v0.6.0 —
 *    NOT `--set`; NOT named `resetprop` to avoid Magisk/KSU applet shadowing).
 */

import { propToAndroidbootKey, profilePropEntries } from './fingerprint-profile.js';

/** Carrier prop (ro.boot.* namespace, device side) for an ro.* target prop. */
export function propToCarrierRoKey(prop) {
  return propToAndroidbootKey(prop).replace(/^androidboot\./, 'ro.boot.');
}

/** Path the resetprop-rs binary is baked to inside the image. */
export const PROPCTL_BIN = '/vendor/bin/oem-propctl';

/**
 * The mapping table: carrier ro.boot key → real ro.* / persist.* target.
 * One row per (field, prop) pair — a field with several props (hardware →
 * ro.hardware + ro.boot.hardware) gets one carrier action per prop, all
 * riding the field's single carrier value (single story, single source).
 * Order = stable (sorted by field, then prop) for byte-deterministic rc
 * generation.
 */
export function carrierMappingTable() {
  return profilePropEntries()
    .sort(([fa, pa], [fb, pb]) => (fa < fb ? -1 : fa > fb ? 1 : pa < pb ? -1 : pa > pb ? 1 : 0))
    .map(([field, prop]) => ({ field, target: prop, carrier: propToCarrierRoKey(prop), phase: rcPhaseFor(prop) }));
}

/**
 * Init phase for a target prop (ADR-031):
 *  - ro.* → early-init (the W1b-verified path: before any consumer starts);
 *  - persist.* → post-fs-data. persistent properties are re-loaded from
 *    /data/property during the fs stage; setting persist.* in early-init
 *    races that load (a stale stored value could win), while post-fs-data
 *    runs strictly AFTER it and still strictly before zygote — the one
 *    phase where a fresh write to persist.* is deterministic.
 */
export function rcPhaseFor(prop) {
  return String(prop).startsWith('persist.') ? 'post-fs-data' : 'early-init';
}

/**
 * NOTE: no redroid-internal carriers are re-mapped here. Stock redroid's own
 * init logic reads its ro.boot.* knobs directly (redroid.common.rc conditions
 * on property:ro.boot.use_redroid_overlayfs), so only the 12 mapped identity
 * props (11 fields → 12 targets, ADR-031) need the mapping.
 */

/**
 * Generate the committed init rc artifact. Byte-deterministic.
 */
export function generateWaRoMapRc() {
  const rows = carrierMappingTable();
  const out = [];
  out.push('# water_army W1b — carrier -> ro.*/persist.* mapping (GENERATED — do not hand-edit)');
  out.push('# regenerate: node scripts/w1b/generate-wa-ro-map-rc.mjs');
  out.push('# source of truth: packages/shared/src/w1b-image-mapping.js (unit-diffed in CI)');
  out.push('#');
  out.push('# early-init: for every androidboot.oem_* carrier present on the kernel');
  out.push('# cmdline (init exposes them as ro.boot.oem_*), rewrite the REAL ro.* prop via');
  out.push('# oem-propctl (resetprop-rs writes the property area directly, bypassing the');
  out.push('# ro.* one-time-write rule; ro.build.* are already loaded from build.prop');
  out.push('# before early-init). Absent carrier = no action.');
  out.push('# post-fs-data: persist.* targets (timezone) map HERE, not early-init —');
  out.push('# init re-loads stored persistent properties from /data during the fs stage,');
  out.push('# so a post-fs-data write is the first deterministic one (and still before');
  out.push('# zygote reads persist.sys.timezone).');
  out.push('');
  for (const r of rows) {
    out.push(`on ${r.phase} && property:${r.carrier}=*`);
    out.push(`    exec -- ${PROPCTL_BIN} ${r.target} \${${r.carrier}}`);
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
    const trig = line.match(/^on (early-init|post-fs-data) && property:([A-Za-z0-9_.]+)=\*$/);
    if (trig) {
      if (pending) problems.push(`line ${i}: trigger without matching exec (previous: ${pending.carrier})`);
      pending = { carrier: trig[2], phase: trig[1] };
      continue;
    }
    const exec = line.match(/^ {4}exec -- \/vendor\/bin\/oem-propctl ([A-Za-z0-9_.]+) \$\{([A-Za-z0-9_.]+)\}$/);
    if (exec) {
      if (!pending) { problems.push(`line ${i}: exec without trigger`); continue; }
      if (exec[2] !== pending.carrier) problems.push(`line ${i}: exec carrier ${exec[2]} does not match trigger ${pending.carrier}`);
      const wantPhase = rcPhaseFor(exec[1]);
      if (pending.phase !== wantPhase) problems.push(`line ${i}: trigger phase ${pending.phase} wrong for target ${exec[1]} (must be ${wantPhase})`);
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
