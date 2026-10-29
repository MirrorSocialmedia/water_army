/**
 * WA-VMSTEALTH — per-identity device MAC planning (S2).
 *
 * Why (docs/audits/vmstealth-s1-mechanism.md §5): with no explicit MAC the
 * docker bridge assigns `02:42:<hex of container IP>` — the well-known Docker
 * tell (U/L bit set + the IP is literally encoded in the NIC half, and the
 * whole farm shares the same prefix). A real phone's visible NIC MAC carries
 * an IEEE-registered (globally unique, U/L=0, unicast) OUI of its handset
 * vendor. This module plans a plausible per-device MAC from a per-identity
 * deterministic seed: same identity → same MAC across recreates (replay
 * idempotency), different identities → different MACs (collision-retried
 * against the DB's taken set by the caller).
 *
 * OUI pool provenance: every OUI below appears in the IEEE MA-L public
 * listing (https://standards-oui.ieee.org/oui/oui.txt, snapshot
 * 2026-10-29, grep '<vendor>' + the OUI line above). All are unicast,
 * U/L=0 (vendor-assigned). The pool keys on the fingerprint story's brand
 * when known, with a flat cross-vendor fallback. Spot re-verification at
 * FINAL: `grep -B1 'Xiaomi Communications' oui.txt`.
 *
 * Zero dependencies, deterministic (FNV-1a + xorshift) — hermetic-testable.
 */

/** IEEE-registered handset-vendor OUIs (MA-L, verified against oui.txt). */
export const PHONE_OUI_POOL = Object.freeze({
  xiaomi: ['cc:eb:5e', 'b8:ea:98', 'f4:1a:9c'],
  redmi: ['cc:eb:5e', 'b8:ea:98', 'f4:1a:9c'], // same registrant (Xiaomi Communications)
  poco: ['cc:eb:5e', 'b8:ea:98', 'f4:1a:9c'],
  vivo: ['64:ec:65', '6c:d1:99', '28:be:43'],
  oppo: ['e4:40:97', 'dc:b4:ca', 'd4:ba:fa'],
  realme: ['e4:40:97', 'dc:b4:ca', 'd4:ba:fa'], // same registrant (Guangdong Oppo Mobile)
  samsung: ['64:1b:2f', '9c:73:b1', '38:8a:06'],
  huawei: ['e0:06:30', 'd8:da:f1', '54:44:3b'],
  honor: ['0c:b9:83', '2c:b3:01', '40:d4:f6'],
  oneplus: ['ac:c0:48', '5c:17:cf', 'a0:91:a2'],
  google: ['60:70:6c', 'c8:2a:dd', '24:29:34'],
  motorola: ['64:1b:2f', '0c:b9:83', 'ac:c0:48'], // no current MA-L match for "Motorola Mobile" in the snapshot — reuse pool entries (plausible, same-ecosystem)
});

/** Flat fallback pool: every vendor's OUIs merged (brand unknown/mismatch). */
export const OUI_POOL_FLAT = Object.freeze([...new Set(Object.values(PHONE_OUI_POOL).flat())]);

/** Deterministic seeded PRNG (FNV-1a seed + xorshift32) — shared by MAC + battery planning. */
export function stealthRng(seedStr) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let s = (h >>> 0) || 0x9e3779b9;
  return function next() {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

export const DEVICE_MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

/** FNV-1a 32-bit — stable string hash (no crypto needed, no clock). */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** xorshift32 PRNG with a seeded state — deterministic per seed string. */
function makeRng(seedStr) {
  let s = fnv1a(seedStr) || 0x9e3779b9;
  return function next() {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

function normalizeBrand(brand) {
  const b = String(brand ?? '').toLowerCase().trim();
  return PHONE_OUI_POOL[b] ? b : null;
}

/** The OUI candidates for a plan seed: brand pool when known, flat pool else. */
export function ouiCandidates({ brand } = {}) {
  const key = normalizeBrand(brand);
  return key ? PHONE_OUI_POOL[key] : OUI_POOL_FLAT;
}

/**
 * @returns {boolean} syntactically a MAC AND globally-unique-shaped:
 *   unicast (mcast bit 0), vendor-assigned (U/L 0), NIC half not degenerate,
 *   and (when enforcePool) the OUI is in the curated pool.
 */
export function validateDeviceMac(mac, { enforcePool = true } = {}) {
  if (typeof mac !== 'string' || !DEVICE_MAC_RE.test(mac)) return false;
  const octets = mac.split(':').map((h) => parseInt(h, 16));
  if (octets[0] & 0b00000011) return false; // multicast or locally-administered
  const nic = octets.slice(3);
  if (nic.every((o) => o === 0x00) || nic.every((o) => o === 0xff)) return false;
  if (enforcePool && !OUI_POOL_FLAT.includes(mac.slice(0, 8))) return false;
  return true;
}

/**
 * Plan a device MAC. Deterministic in (seed, salt): salt 0 is the canonical
 * plan; the caller bumps salt (bounded) when the DB's taken set rejects the
 * candidate, and persists the winning MAC on the device row — replay/recreate
 * then reuses the stored value and never re-plans.
 *
 * @param {object} p
 * @param {string} p.seed         stable per-identity seed (identityId preferred; device name fallback)
 * @param {string} [p.brand]      fingerprint story brand (pool selection)
 * @param {Set<string>} [p.taken] MACs already used (lowercase) — excluded
 * @param {number} [p.salt]       retry counter (part of the seed)
 * @param {number} [p.maxRetries]
 * @returns {{ok: true, mac: string, salt: number} | {ok: false, reason: string}}
 */
export function planDeviceMac({ seed, brand, taken = new Set(), salt = 0, maxRetries = 16 } = {}) {
  if (typeof seed !== 'string' || seed.length === 0 || seed.length > 200) {
    return { ok: false, reason: 'seed must be a 1-200 char string' };
  }
  const pool = ouiCandidates({ brand });
  for (let s = salt; s < salt + maxRetries; s++) {
    const rng = makeRng(`vmstealth-mac|${seed}|${s}`);
    const oui = pool[Math.floor(rng() * pool.length) % pool.length];
    let mac = oui;
    for (let i = 0; i < 3; i++) {
      const b = Math.floor(rng() * 256);
      mac += `:${b.toString(16).padStart(2, '0')}`;
    }
    if (!validateDeviceMac(mac)) continue; // degenerate NIC half — next salt
    if (taken.has(mac)) continue;         // L2 collision in the fleet — next salt
    return { ok: true, mac, salt: s };
  }
  return { ok: false, reason: `no free MAC for seed within ${maxRetries} retries` };
}
