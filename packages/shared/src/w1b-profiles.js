/**
 * W1b P2 — template-backed real build profiles (ADR-028).
 *
 * Why this replaces the W1 synthetic generator for real-device use:
 * the W1 splitmix64 generator invents brand/model/fingerprint values. Every
 * field is internally consistent, but the BUILD ITSELF IS NOT REAL — a
 * platform that checks ro.build.fingerprint against a firmware catalogue
 * (Google/Meta-grade cross-check) sees a build that never shipped. This
 * module draws from a pool of REAL authenticated build profiles
 * (data/build-profile-templates.json, sources cited per template).
 *
 * Generation semantics (seeded template draw):
 *   - identityId seeds the same deterministic splitmix64 stream as W1
 *     (regeneration stays idempotent);
 *   - the seed selects ONE template; the immutable real-build fields
 *     (brand/manufacturer/model/device/productName/buildId/displayId/
 *     fingerprint) are copied VERBATIM — two identities may legitimately
 *     share one build, exactly like two real users owning the same phone
 *     model on the same OTA;
 *   - per-identity variation is applied ONLY to fields that genuinely differ
 *     between two phones of the same model: serial, securityPatch, locale,
 *     timezone, carrier — real-format per-device values.
 *
 * Pool health gate: verified:false templates (community-published,
 * pattern-plausible, NOT machine-verified) are excluded from generation by
 * default — until the real-device probe stage replaces them with live data
 * the fleet only ever presents machine-verified builds.
 *
 * W1's generateFingerprintProfile() stays exported and behaviour-unchanged
 * (byte-inert W1 discipline; ADR-028 L1 switch decides which generator the
 * injection path uses).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  SAFE_PROFILE_VALUE_RE,
  PROFILE_PROP_MAP,
  POOL_LOCALES,
  POOL_TIMEZONES,
  POOL_CARRIERS,
  makeRng,
  validateFingerprintProfile,
} from './fingerprint-profile.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Load + parse the template pool data file. */
export function loadBuildTemplates(filePath = join(HERE, '..', 'data', 'build-profile-templates.json')) {
  const doc = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.templates) || doc.templates.length === 0) {
    throw new Error('loadBuildTemplates: data file must contain a non-empty templates[] array');
  }
  return doc.templates;
}

// ---------------------------------------------------------------------------
// Template validation (stricter than W1 profile validation — a template is a
// claim about a REAL build, so every cross-field invariant is enforced).
// ---------------------------------------------------------------------------

// AOSP build-fingerprint: brand/device/product:release/buildId/incremental:type/keys
// (real brands keep casing — Xiaomi/fuxi/…; Samsung uses lowercase — allow both)
const TEMPLATE_FP_RE = /^[A-Za-z][A-Za-z0-9+._-]*\/[a-z0-9][a-z0-9+._-]*\/[a-z0-9][a-z0-9+._-]*:\d+(\.\d+){0,2}\/[A-Z][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*:(user|userdebug|eng)\/[a-z][a-z0-9_-]*$/;
const BUILD_ID_RE = /^[A-Z][A-Z0-9._-]{2,31}$/;
// incrementals: pure-digit (Google 16271449), CSC-code (A520FXXU1ARA1), MIUI (V14.0.6.0.TMCMIXM), OOS hash-style
const INCREMENTAL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,39}$/;
const SDK_RE = /^\d{1,3}$/;
// AOSP release-major → sdk map (irregular history: 9=28, 13=33 — no formula)
const RELEASE_TO_SDK = Object.freeze({ 8: 26, 9: 28, 10: 29, 11: 30, 12: 31, 13: 33, 14: 34, 15: 35, 16: 36, 17: 37 });

export const TEMPLATE_REQUIRED_FIELDS = Object.freeze([
  'androidRelease', 'brand', 'manufacturer', 'model', 'device', 'productName',
  'buildId', 'displayId', 'incremental', 'fingerprint', 'sdkVersion',
  'firstApiLevel', 'buildType', 'buildTags',
]);

/**
 * Cross-check one template's self-consistency (the fields a platform probe
 * joins on). @returns {string[]} problems (empty = consistent)
 */
export function validateBuildTemplate(t) {
  const problems = [];
  if (!t || typeof t !== 'object' || Array.isArray(t)) return ['template must be a plain object'];
  if (typeof t.id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(t.id)) problems.push('template.id must be a lowercase slug');
  if (typeof t.source !== 'string' || t.source.length < 8) problems.push(`${t.id}: source citation required (provenance rule)`);
  const f = t.fields;
  if (!f || typeof f !== 'object' || Array.isArray(f)) { problems.push(`${t.id}: fields object required`); return problems; }
  for (const k of TEMPLATE_REQUIRED_FIELDS) {
    if (typeof f[k] !== 'string' || f[k] === '') problems.push(`${t.id}: fields.${k} must be a non-empty string`);
  }
  if (problems.length) return problems;
  for (const k of TEMPLATE_REQUIRED_FIELDS) {
    if (k === 'model') {
      // real models contain spaces ("Pixel 8 Pro") — exempt from the carrier
      // SAFE check; % is reserved for the %20 carrier encoding (ADR-028)
      if (f[k].includes('%')) problems.push(`${t.id}: model must not contain "%" (reserved for %20 carrier encoding — ADR-028)`);
      continue;
    }
    if (f[k].includes('%')) problems.push(`${t.id}: fields.${k} must not contain "%" (reserved char — ADR-028)`);
    if (!SAFE_PROFILE_VALUE_RE.test(f[k])) problems.push(`${t.id}: fields.${k} "${f[k].slice(0, 40)}" must be transport-safe (no spaces/=/quotes)`);
  }
  // fingerprint = brand/device/name:release/buildId/incremental:type/keys — the FULL join
  const expectedFp = `${f.brand}/${f.device}/${f.productName}:${f.androidRelease}/${f.buildId}/${f.incremental}:${f.buildType}/${f.buildTags}`;
  if (f.fingerprint !== expectedFp) problems.push(`${t.id}: fingerprint must equal "${expectedFp}" (full AOSP cross-check)`);
  if (!TEMPLATE_FP_RE.test(f.fingerprint)) problems.push(`${t.id}: fingerprint does not match AOSP build-fingerprint grammar`);
  if (!BUILD_ID_RE.test(f.buildId)) problems.push(`${t.id}: buildId "${f.buildId}" does not look like an Android build id`);
  if (!INCREMENTAL_RE.test(f.incremental)) problems.push(`${t.id}: incremental "${f.incremental}" does not look like a real incremental`);
  if (f.buildType !== 'user') problems.push(`${t.id}: buildType must be "user" (userdebug on a farm IS a tell)`);
  if (f.buildTags !== 'release-keys') problems.push(`${t.id}: buildTags must be "release-keys" (dev-keys on retail IS a tell)`);
  if (!SDK_RE.test(f.sdkVersion)) problems.push(`${t.id}: sdkVersion must be numeric`);
  if (!SDK_RE.test(f.firstApiLevel)) problems.push(`${t.id}: firstApiLevel must be numeric`);
  if (Number(f.firstApiLevel) > Number(f.sdkVersion)) problems.push(`${t.id}: firstApiLevel ${f.firstApiLevel} must be <= sdkVersion ${f.sdkVersion}`);
  // AOSP release↔sdk mapping (known majors only; unknown major skips)
  const major = Number(String(f.androidRelease).split('.')[0]);
  if (RELEASE_TO_SDK[major] !== undefined && Number(f.sdkVersion) !== RELEASE_TO_SDK[major]) problems.push(`${t.id}: androidRelease ${f.androidRelease} inconsistent with sdkVersion ${f.sdkVersion} (AOSP map: ${major} -> ${RELEASE_TO_SDK[major]})`);
  return problems;
}

/** Whole-pool validation + id uniqueness + fleet-diversity floor. */
export function validateTemplatePool(templates) {
  const problems = [];
  const seen = new Set();
  for (const t of templates) {
    problems.push(...validateBuildTemplate(t));
    if (seen.has(t?.id)) problems.push(`duplicate template id "${t?.id}"`);
    seen.add(t?.id);
  }
  const verified = templates.filter((t) => t.verified === true);
  if (verified.length >= 2 && new Set(verified.map((t) => t.fields?.fingerprint)).size < 2) {
    problems.push('pool: all verified templates share one fingerprint (fleet would cluster)');
  }
  return { templates, problems };
}

// ---------------------------------------------------------------------------
// Per-device real-format generators (serial / securityPatch)
// ---------------------------------------------------------------------------

// Serial formats observed on shipping devices (alnum, 10-11 chars).
const SERIAL_SHAPES = Object.freeze([
  (r) => r.upper(2) + r.digits(8), // Pixel-style: 2 letters + 8 digits
  (r) => r.upper(1) + r.digits(9), // generic OEM: 1 letter + 9 digits
]);

function securityPatchForTemplate(rng, t) {
  // Patch level sits in the template build's era (never future, never before
  // the build shipped as a supported release).
  const eraYear = { 17: 2026, 16: 2025, 15: 2025, 14: 2024, 13: 2023, 12: 2022, 8: 2018 }[Number(String(t.fields.androidRelease).split('.')[0])] ?? 2024;
  const year = eraYear - (rng.u32() % 2);
  const month = 1 + (rng.u32() % 12);
  const day = 1 + (rng.u32() % 28);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Fields of a generated template profile (W1 core + templateId metadata). */
export const TEMPLATE_PROFILE_FIELDS = Object.freeze([
  'androidRelease', 'brand', 'manufacturer', 'model', 'device', 'productName',
  'buildId', 'displayId', 'fingerprint', 'serial',
  'locale', 'timezone', 'carrierName', 'carrierMcc', 'carrierMnc',
  'securityPatch', 'templateId',
]);

/** Validate a GENERATED template profile (W1 core validator + W1b extras). */
export function validateTemplateProfile(profile) {
  const problems = validateFingerprintProfile(profile); // W1 core now tolerates templateId + real model casing
  for (const key of Object.keys(profile ?? {})) {
    if (!TEMPLATE_PROFILE_FIELDS.includes(key)) problems.push(`unknown profile field "${key}"`);
  }
  if (profile && typeof profile.serial === 'string' && profile.serial !== '' && !/^[A-Za-z0-9]{6,32}$/.test(profile.serial)) {
    problems.push(`serial "${profile.serial}" must be 6-32 alnum (real-device serial shape)`);
  }
  if (profile && typeof profile.model === 'string' && profile.model.includes('%')) {
    problems.push('model must not contain "%" (reserved for the %20 carrier encoding of spaces — ADR-028)');
  }
  // no other field may smuggle a '%' (wa-propctl decodes %20 in EVERY value —
  // a real-world value containing a literal %20 would corrupt; real values never do)
  for (const [field, prop] of Object.entries(PROFILE_PROP_MAP)) {
    if (field === 'model') continue;
    const v = profile?.[field];
    if (typeof v === 'string' && v.includes('%')) problems.push(`${field} must not contain "%" (reserved char — ADR-028)`);
  }
  if (profile && typeof profile.templateId === 'string' && profile.templateId !== '' && !/^[a-z0-9][a-z0-9-]{2,63}$/.test(profile.templateId)) {
    problems.push('templateId must be a lowercase slug');
  }
  if (profile && typeof profile.securityPatch === 'string' && profile.securityPatch !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(profile.securityPatch)) {
    problems.push('securityPatch must be YYYY-MM-DD');
  }
  return problems;
}

/**
 * Generate the device profile for one identity from the REAL template pool.
 * Deterministic: same identityId → deep-equal output (W1 idempotence rule).
 * @param {string} identityId 8-64 char [A-Za-z0-9_-]
 * @param {{ templates?: object[], includeUnverified?: boolean }} [opts]
 */
export function generateTemplateProfile(identityId, opts = {}) {
  if (typeof identityId !== 'string' || identityId.length < 8 || identityId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(identityId)) {
    throw new Error('generateTemplateProfile: identityId must be an 8-64 char [A-Za-z0-9_-] string');
  }
  const all = opts.templates ?? loadBuildTemplates();
  const pool = opts.includeUnverified ? [...all] : all.filter((t) => t.verified === true);
  if (!pool.length) throw new Error('generateTemplateProfile: no usable templates (verified pool empty and includeUnverified off)');
  pool.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // determinism independent of file order
  const rng = makeRng(identityId);
  const t = pool[rng.u32() % pool.length];
  const shape = SERIAL_SHAPES[rng.u32() % SERIAL_SHAPES.length];
  const carrier = POOL_CARRIERS[rng.u32() % POOL_CARRIERS.length];
  const profile = {
    androidRelease: t.fields.androidRelease,
    brand: t.fields.brand,
    manufacturer: t.fields.manufacturer,
    model: t.fields.model, // real model incl. spaces — model is NOT a carrier field (ADR-028)
    device: t.fields.device,
    productName: t.fields.productName,
    buildId: t.fields.buildId,
    displayId: t.fields.displayId,
    fingerprint: t.fields.fingerprint,
    serial: shape(rng),
    locale: POOL_LOCALES[rng.u32() % POOL_LOCALES.length],
    timezone: POOL_TIMEZONES[rng.u32() % POOL_TIMEZONES.length],
    carrierName: carrier.name,
    carrierMcc: carrier.mcc,
    carrierMnc: carrier.mnc,
    securityPatch: securityPatchForTemplate(rng, t),
    templateId: t.id, // audit + probe ground-truth linkage
  };
  const problems = validateTemplateProfile(profile);
  if (problems.length) {
    throw new Error(`generateTemplateProfile: generator produced invalid profile: ${problems.join('; ')}`);
  }
  return profile;
}

/**
 * Template profile → ro.* override map for the carrier (ADR-028).
 * Same 9 props as W1's profileToRoOverrides, but model is %20-encoded:
 * real models contain spaces ("Pixel 8 Pro") and the kernel-cmdline carrier
 * forbids them; wa-propctl (w1b image) decodes %20 back to spaces when it
 * writes the prop. Models are validated to never contain a literal '%'.
 */
export function templateProfileToRoOverrides(profile) {
  const out = {};
  for (const [field, prop] of Object.entries(PROFILE_PROP_MAP)) {
    const v = profile?.[field];
    if (typeof v !== 'string' || v === '') continue;
    out[prop] = field === 'model' ? v.replaceAll(' ', '%20') : v;
  }
  return out;
}
