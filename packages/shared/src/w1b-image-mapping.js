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
 * ADR-031 adds the load_persist_props_action phase for persist.* targets —
 * WA-OEMPROP S3 real-device: the post-fs-data stage does NOT guarantee
 * ordering after init.rc's load_persist_props builtin, and that reload
 * erased an early persist.* write — see the S3 finding in
 * docs/audits/oemprop-report.md):
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
 * Init phase for a target prop (ADR-031, amended WA-OEMPROP S3 2026-10-29):
 *  - ro.* → early-init (the W1b-verified path: before any consumer starts);
 *  - persist.* → load_persist_props_action. init.rc runs its
 *    `load_persist_props` builtin inside the `on post-fs-data` section and
 *    then fires `trigger load_persist_props_action` — that trigger is the
 *    canonical, ordering-guaranteed "stored persist props are loaded" hook
 *    (init.rc comment: "Some existing vendor rc files use 'on
 *    load_persist_props_action' to know when the persist properties have
 *    been loaded"). A bare `on post-fs-data` section can queue BEFORE that
 *    builtin runs (section order across rc files), so its persist.* write
 *    gets erased when the persist area is re-initialized from /data/property
 *    (real-device observed: persist.sys.timezone reverted to GMT).
 *    The hook still fires strictly before zygote, so every process
 *    resolves the identity timezone.
 */
export function rcPhaseFor(prop) {
  return String(prop).startsWith('persist.') ? 'load_persist_props_action' : 'early-init';
}

/**
 * Writer binary per target type (WA-OEMPROP S3 2026-10-29, real-device):
 *  - ro.* → oem-propctl (resetprop-rs raw property-area write — the only
 *    path that can bypass the ro.* one-time-write rule);
 *  - persist.* → /system/bin/setprop. resetprop-rs can NOT write persist.*
 *    (real-device: exit 0, area + /data/property untouched — its raw-area
 *    write path does not cover persist entries, which need the bionic
 *    setprop path that also journals /data/property). setprop is present
 *    and usable at load_persist_props_action (APEX/bionic is mounted since
 *    early-fs). No %20 concern: the only persist target (timezone) contains
 *    no spaces, and init performs the ${carrier} substitution itself.
 */
export const SETPROP_BIN = '/system/bin/setprop';
export function rcWriterFor(prop) {
  return String(prop).startsWith('persist.') ? SETPROP_BIN : PROPCTL_BIN;
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
  out.push('# load_persist_props_action: persist.* targets (timezone) map HERE via the');
  out.push('# stock setprop (resetprop-rs cannot write persist.* — real-device,');
  out.push('# WA-OEMPROP S3), not in early-init/post-fs-data: init.rc loads stored');
  out.push('# persistent properties from /data/property via `load_persist_props` inside');
  out.push('# its own `on post-fs-data` section and then fires this trigger. Mapping on');
  out.push('# the trigger is the ordering-guaranteed hook; it still fires strictly');
  out.push('# before zygote reads persist.sys.timezone.');
  out.push('');
  for (const r of rows) {
    out.push(`on ${r.phase} && property:${r.carrier}=*`);
    out.push(`    exec -- ${rcWriterFor(r.target)} ${r.target} \${${r.carrier}}`);
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
    const trig = line.match(/^on (early-init|load_persist_props_action) && property:([A-Za-z0-9_.]+)=\*$/);
    if (trig) {
      if (pending) problems.push(`line ${i}: trigger without matching exec (previous: ${pending.carrier})`);
      pending = { carrier: trig[2], phase: trig[1] };
      continue;
    }
    const exec = line.match(/^ {4}exec -- (\/vendor\/bin\/oem-propctl|\/system\/bin\/setprop) ([A-Za-z0-9_.]+) \$\{([A-Za-z0-9_.]+)\}$/);
    if (exec) {
      if (!pending) { problems.push(`line ${i}: exec without trigger`); continue; }
      if (exec[3] !== pending.carrier) problems.push(`line ${i}: exec carrier ${exec[3]} does not match trigger ${pending.carrier}`);
      const wantPhase = rcPhaseFor(exec[2]);
      if (pending.phase !== wantPhase) problems.push(`line ${i}: trigger phase ${pending.phase} wrong for target ${exec[2]} (must be ${wantPhase})`);
      const wantWriter = rcWriterFor(exec[2]);
      if (exec[1] !== wantWriter) problems.push(`line ${i}: writer ${exec[1]} wrong for target ${exec[2]} (must be ${wantWriter})`);
      rows.push({ carrier: pending.carrier, target: exec[2] });
      pending = null;
      continue;
    }
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    problems.push(`line ${i}: unexpected rc content "${line.slice(0, 60)}"`);
  }
  if (pending) problems.push(`dangling trigger without exec: ${pending.carrier}`);
  return { rows, problems };
}
