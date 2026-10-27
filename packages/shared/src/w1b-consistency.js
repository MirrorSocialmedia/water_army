/**
 * W1b P3 — device-vs-profile consistency validator (shared kernel).
 *
 * ONE implementation used by BOTH sides:
 *  - platform: apps/api fingerprint-service asserts a probe dump reported by
 *    the device probe app against the identity's stored profile (ground truth);
 *  - device: scripts/w1b/probe-assert.mjs runs the SAME function over the
 *    probe APK's property dump (JSON) and prints per-field PASS/FAIL.
 *
 * Input contract (probe dump JSON):
 * {
 *   "props": { "ro.build.fingerprint": "...", ... },   // getprop results (device truth)
 *   "identityId": "…",                                  // optional, echoed for audit
 *   "expected": { ... }                                 // OPTIONAL — if the platform
 *        // embeds the expected profile, device-side runs need no DB access;
 *        // otherwise the caller passes expected explicitly.
 * }
 *
 * Policy fields (ADR-028 L1 scope + ADR-031 wave-1): every carrier-mapped
 * prop (ro.* identity props, persist.sys.timezone, ro.hardware/ro.boot.hardware)
 * is STRICT (a mismatch means the w1b image mapping failed). Fields a stored
 * profile does not carry (legacy rows) are SKIPped. Model-adjacent settings
 * the device cannot spoof via carrier (model string with spaces, locale,
 * carrier display) are REPORTED but not blocking — they ride settings /
 * telephony at a later phase. Everything returns per-field rows; nothing
 * throws on data disagreement (fail-CLOSED lives in the caller's verdict
 * handling).
 */

import { profilePropEntries, UNIQUE_PROFILE_FIELDS } from './fingerprint-profile.js';

/**
 * @param {object} expected profile fields (generateTemplateProfile output or stored profile)
 * @param {object} props    map of android prop name -> observed value (from device)
 * @returns {{rows: Array<{field: string, prop: string, expected: string, observed: string|null, status: 'PASS'|'FAIL'|'MISSING'|'SKIP'}>, pass: boolean, blocking: boolean}}
 *   `blocking` = a STRICT carrier-mapped prop mismatched (image mapping broken
 *   or identity cross-contamination). SKIP (non-blocking) = the stored profile
 *   predates the field (e.g. L2 wave-1 hardware on W1-era rows: no carrier was
 *   emitted, so the device correctly shows the image default — nothing to
 *   assert against).
 */
export function checkProfileConsistency(expected, props) {
  const rows = [];
  for (const [field, prop] of profilePropEntries()) {
    const want = expected?.[field];
    const got = typeof props?.[prop] === 'string' ? props[prop] : null;
    let status;
    if (typeof want !== 'string' || want === '') status = 'SKIP'; // field not carried by this profile generation
    else if (got === null) status = 'MISSING';
    else status = got === want ? 'PASS' : 'FAIL';
    rows.push({ field, prop, expected: want ?? null, observed: got, status });
  }
  const strict = rows.filter((r) => r.status !== 'PASS' && r.status !== 'SKIP');
  return {
    rows,
    pass: strict.length === 0,
    blocking: strict.length > 0, // every carrier-mapped prop is strict at L1
  };
}

/**
 * Cross-verify a probe dump's INTERNAL consistency (does not need the
 * platform profile — works from device truth alone): ro.build.fingerprint
 * must agree with ro.product.brand/device/name + the build id/incremental
 * pieces. A device presenting a self-inconsistent set failed mapping or got
 * a partial map through.
 * @returns {string[]} problems (empty = consistent)
 */
export function checkProbeSelfConsistency(props) {
  const problems = [];
  const fp = props?.['ro.build.fingerprint'];
  if (typeof fp !== 'string' || fp === '') return ['ro.build.fingerprint missing from probe dump'];
  const brand = props?.['ro.product.brand'];
  const device = props?.['ro.product.device'];
  const name = props?.['ro.product.name'];
  if (!brand || !device || !name) { problems.push('ro.product.{brand,device,name} must all be present'); return problems; }
  if (!fp.startsWith(`${brand}/${device}/${name}:`)) problems.push(`fingerprint prefix does not match ro.product.{brand,device,name}: ${fp.slice(0, 60)}`);
  // the build.id segment inside the fingerprint must equal ro.build.id
  const seg = fp.split(':')[1]?.split('/');
  if (!seg || seg.length !== 3) problems.push('fingerprint release/buildId/incremental segments malformed');
  else {
    const buildId = props?.['ro.build.id'];
    if (buildId && seg[1] !== buildId) problems.push(`fingerprint buildId segment "${seg[1]}" != ro.build.id "${buildId}"`);
  }
  // type/keys is the segment AFTER the second colon: .../incremental:type/keys
  const type = fp.split(':')[2]?.split('/')[0];
  if (type && type !== 'user') problems.push(`build type "${type}" is not "user" (farm tell)`);
  // uniqueness fields observed must not be empty
  for (const [f, prop] of profilePropEntries()) {
    if (!UNIQUE_PROFILE_FIELDS.includes(f)) continue;
    if (!(typeof props?.[prop] === 'string' && props[prop] !== '')) problems.push(`${prop} missing/empty (unique identity field)`);
  }
  return problems;
}
