/**
 * WA-STEALTH-FIX2 (s2, work-order E) — region consistency (the three-way check).
 *
 * D2-0 FAIL shape: an identity whose profile says Europe (timezone
 * Europe/Paris, locale en-US pinned in the profile pool) was bound to a CN
 * exit — TZ, locale and egress geo each plausible ALONE but mutually
 * contradictory TOGETHER. A platform fingerprinting correlation only needs
 * ONE such axis to break the story.
 *
 * There is no authoritative "profile.region" column (work order: add/make it
 * explicit). We DERIVE it from the two fields the fingerprint ALREADY pins:
 *   - timezone  → region via a curated IANA→ISO-3166 alpha-2 map (authoritative
 *     for the pool's zones; unknown zones yield null = unverifiable, NOT fail).
 *   - locale    → region subtag (en-US → US, zh-Hant-TW → TW…). Locales with no
 *     region subtag (fi, ms-MY…) contribute nothing.
 * The check then compares the BINDING's declared egress region against both
 * axes INDEPENDENTLY (tz mismatch and locale mismatch are separate findings —
 * D2's en-US + Europe/Paris + CN breaks on both). A locale whose region
 * disagrees with the identity's own timezone is flagged in `internal` (the
 * profile contradicts itself before egress is even considered) — advisory,
 * not blocking, until the profile pool is regenerated.
 */

export const ISO2_RE = /^[A-Z]{2}$/;

/** IANA timezone → ISO-3166 alpha-2 (curated: pool zones + common fleet zones). */
export const TZ_TO_ISO2 = Object.freeze({
  'Asia/Hong_Kong': 'HK', 'Asia/Shanghai': 'CN', 'Asia/Chongqing': 'CN', 'Asia/Urumqi': 'CN',
  'Asia/Taipei': 'TW', 'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR', 'Asia/Singapore': 'SG',
  'Asia/Bangkok': 'TH', 'Asia/Jakarta': 'ID', 'Asia/Kuala_Lumpur': 'MY', 'Asia/Manila': 'PH',
  'Asia/Ho_Chi_Minh': 'VN', 'Asia/Kolkata': 'IN', 'Asia/Karachi': 'PK', 'Asia/Dhaka': 'BD',
  'Asia/Dubai': 'AE', 'Asia/Riyadh': 'SA', 'Asia/Jerusalem': 'IL',
  'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE',
  'Europe/Madrid': 'ES', 'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE',
  'Europe/Lisbon': 'PT', 'Europe/Vienna': 'AT', 'Europe/Zurich': 'CH', 'Europe/Warsaw': 'PL',
  'Europe/Prague': 'CZ', 'Europe/Budapest': 'HU', 'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO',
  'Europe/Copenhagen': 'DK', 'Europe/Helsinki': 'FI', 'Europe/Athens': 'GR', 'Europe/Moscow': 'RU',
  'Europe/Istanbul': 'TR', 'Europe/Kyiv': 'UA', 'Europe/Kiev': 'UA',
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US',
  'America/Los_Angeles': 'US', 'America/Phoenix': 'US', 'America/Detroit': 'US',
  'America/Anchorage': 'US', 'Pacific/Honolulu': 'US', 'America/Toronto': 'CA',
  'America/Vancouver': 'CA', 'America/Edmonton': 'CA', 'America/Winnipeg': 'CA',
  'America/Halifax': 'CA', 'America/Mexico_City': 'MX', 'America/Monterrey': 'MX',
  'America/Sao_Paulo': 'BR', 'America/Buenos_Aires': 'AR', 'America/Santiago': 'CL',
  'America/Bogota': 'CO', 'America/Lima': 'PE', 'America/Caracas': 'VE',
  'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Brisbane': 'AU',
  'Australia/Perth': 'AU', 'Australia/Adelaide': 'AU', 'Pacific/Auckland': 'NZ',
  'Africa/Lagos': 'NG', 'Africa/Johannesburg': 'ZA', 'Africa/Cairo': 'EG', 'Africa/Nairobi': 'KE',
});

/** ISO-3166 alpha-2 → the primary BCP-47 language for that market (pool sanity aid). */
export const ISO2_TO_LANGUAGE = Object.freeze({
  US: 'en', GB: 'en', IE: 'en', AU: 'en', NZ: 'en', CA: 'en',
  CN: 'zh', TW: 'zh', HK: 'zh', SG: 'en', MY: 'ms',
  JP: 'ja', KR: 'ko', TH: 'th', VN: 'vi', ID: 'id', PH: 'fil',
  IN: 'en', PK: 'ur', BD: 'bn', AE: 'ar', SA: 'ar', EG: 'ar', IL: 'he', TR: 'tr',
  FR: 'fr', DE: 'de', ES: 'es', IT: 'it', NL: 'nl', BE: 'nl', PT: 'pt', CH: 'de',
  AT: 'de', PL: 'pl', CZ: 'cs', HU: 'hu', SE: 'sv', NO: 'no', DK: 'da', FI: 'fi',
  GR: 'el', RU: 'ru', UA: 'uk', BR: 'pt', AR: 'es', CL: 'es', CO: 'es', PE: 'es',
  MX: 'es', NG: 'en', ZA: 'en', KE: 'en',
});

/** @returns {string|null} ISO-2 for an IANA zone, null when unmapped (unverifiable). */
export function regionFromTimezone(tz) {
  if (typeof tz !== 'string' || tz.length === 0) return null;
  return TZ_TO_ISO2[tz.trim()] ?? null;
}

/**
 * @returns {string|null} region subtag inside a BCP-47 locale
 * ("en-US"→US, "zh-Hant-TW"→TW, "fil"→null). Accepts '-' and '_' separators.
 */
export function regionFromLocale(locale) {
  if (typeof locale !== 'string' || locale.length === 0) return null;
  const m = /[-_]([A-Za-z]{2})(?![A-Za-z])/.exec(locale.trim());
  if (!m) return null;
  const tag = m[1].toUpperCase();
  // A 2-letter trailing segment is a region subtag only if NOT the primary
  // language itself ("fi" alone has no separator; "en_US" style always has one).
  return ISO2_RE.test(tag) ? tag : null;
}

/**
 * The profile's own region: timezone is authoritative; locale subtag is the
 * fallback when the zone is unmapped. null = unverifiable.
 */
export function profileRegionFrom({ timezone, locale } = {}) {
  return regionFromTimezone(timezone) ?? regionFromLocale(locale);
}

/**
 * The three-way check. `egressRegion` is the BINDING's declared exit country.
 * @returns {{ ok: boolean, egressRegion: string, profileRegion: string|null,
 *            tzRegion: string|null, localeRegion: string|null,
 *            mismatches: string[], unverifiable: boolean }}
 * `mismatches` ⊂ ['timezone','locale'] — each axis independently (work order E).
 * `ok=true` when egressRegion is absent (nothing to check) or unverifiable
 * (no derivable profile region — fail-open by ruling: the profile pool must
 * keep booting before the map is complete; the gap is visible in the view).
 */
export function checkRegionConsistency({ egressRegion, timezone, locale } = {}) {
  const tzRegion = regionFromTimezone(timezone);
  const localeRegion = regionFromLocale(locale);
  const profileRegion = tzRegion ?? localeRegion;
  const eg = typeof egressRegion === 'string' ? egressRegion.trim().toUpperCase() : '';
  const base = { egressRegion: eg || null, profileRegion, tzRegion, localeRegion };
  if (!eg) return { ...base, ok: true, mismatches: [], unverifiable: false };
  if (!tzRegion && !localeRegion) return { ...base, ok: true, mismatches: [], unverifiable: true };
  const mismatches = [];
  if (tzRegion && tzRegion !== eg) mismatches.push('timezone');
  if (localeRegion && localeRegion !== eg) mismatches.push('locale');
  return { ...base, ok: mismatches.length === 0, mismatches, unverifiable: false };
}
