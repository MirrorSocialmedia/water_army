/**
 * Network policy (施工 MD §5/§12, BR-B4) — QA endpoint allowlist + SSRF hardening.
 *
 * Pure module (zero intra-package imports except the stable deny-code table
 * in batch-constants.js; node builtins only):
 *
 *   parseAllowlist            strict entry parsing (scheme://host[:port], exact match, no wildcards)
 *   loadNetworkPolicy         env + AppSetting merge; ANY malformation => unavailable (fail-closed)
 *   classifyIp / isIpAllowed  loopback / private / link-local / CGNAT / metadata / ... (byte-level,
 *                             catches IPv4-mapped + IPv4-compatible IPv6 forms)
 *   assessTarget              parse -> allowlist match -> ONE dns resolve -> validate ALL resolved
 *                             IPs -> pinned-IP plan (the anti-rebinding contract)
 *   assessRedirect            per-hop re-validation helper (documented redirect policy, MD Phase 4)
 *   createNetworkPolicyGate   the B1 seam implementation — worker.js swaps this in (engine zero-change)
 *
 * Security posture (fail-closed, MD §5.1/§12):
 *   - policy not loaded / malformed / empty            => NETWORK_POLICY_UNAVAILABLE (deny)
 *   - NEVER falls back to allow-all or an unrestricted direct connection
 *   - the gate never throws; ANY internal failure is classified as POLICY_UNAVAILABLE
 *     (the B1 engine also maps a throwing gate to POLICY_UNAVAILABLE — double safety)
 *   - every deny writes an audit event (actor=system) + a log line; the target is redacted to
 *     scheme://host:port (never userinfo / path / query — credentials never reach the audit trail)
 *
 * See docs/network-policy.md for the full design (entry format, zones, code table,
 * redirect decision, DNS-rebinding contract, exposure-surface audit).
 */
import dns from 'node:dns/promises';

import { NETWORK_GATE_ERROR } from './batch-constants.js';

// ---------------------------------------------------------------------------
// Configuration surface (env + AppSetting)
// ---------------------------------------------------------------------------

/** Env vars read by loadNetworkPolicy (names are stable — compose/.env.example). */
export const NETWORK_POLICY_ENV = Object.freeze({
  /** Public-zone allowlist, comma-separated entries. */
  ALLOWLIST: 'QA_ENDPOINT_ALLOWLIST',
  /** Internal (Docker-network) zone allowlist, comma-separated entries. */
  ALLOWLIST_INTERNAL: 'QA_ENDPOINT_ALLOWLIST_INTERNAL',
});

/** AppSetting keys (admin-only edits — MD §12; the API route is a B6 item). */
export const NETWORK_SETTING_KEYS = Object.freeze({
  /** JSON array of entry strings, same format as the env var. */
  ALLOWLIST: 'network.qaEndpointAllowlist',
  /** JSON array of entry strings (internal zone). */
  ALLOWLIST_INTERNAL: 'network.qaEndpointAllowlistInternal',
  /** JSON object { ai: boolean, adhoc: boolean } — which task types may run at all. */
  TASK_TYPES: 'network.taskTypePolicy',
});

const DEFAULT_TASK_TYPES = Object.freeze({ ai: true, adhoc: true });

/** Address classes permitted for a PUBLIC-zone entry (must be genuinely public). */
const PUBLIC_ALLOWED_CLASSES = Object.freeze(['public']);
/**
 * Address classes permitted for an INTERNAL-zone entry (Docker bridge / host-local).
 * Deliberately still excludes: unspecified, cgnat, multicast, broadcast, nat64,
 * test-net and metadata (169.254.169.254 in ANY IP form) — those are rejected
 * in BOTH zones (metadata = cloud credential theft vector, MD §5.1).
 */
const INTERNAL_ALLOWED_CLASSES = Object.freeze(['loopback', 'private', 'link-local']);

// ---------------------------------------------------------------------------
// Allowlist entry parsing (strict; a malformed entry invalidates the WHOLE list)
// ---------------------------------------------------------------------------

const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const PORT_STR_RE = /^[1-9]\d{0,4}$/;

function parseIp4Literal(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const bytes = m.slice(1).map(Number);
  return bytes.every((b) => b <= 255) ? bytes : null;
}

function parsePortStr(s) {
  if (!PORT_STR_RE.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

/**
 * Parse one allowlist entry.
 * Format: `scheme://host[:port]` (scheme http|https) or bare `host[:port]`
 * (= https shorthand). host = DNS name (single-label allowed — Docker DNS
 * names like `api` are legitimate) | IPv4 literal | bracketed IPv6 literal.
 * Exact match only: wildcards, paths, queries, fragments, userinfo and
 * whitespace are all rejected.
 *
 * @param {string} entry
 * @param {string} source where the entry came from (for error messages)
 * @returns {{ok:true, entry:{scheme:string, host:string, port:number}} | {ok:false, reason:string}}
 */
export function parseAllowlistEntry(entry, source = 'allowlist') {
  if (typeof entry !== 'string' || entry.length === 0) {
    return { ok: false, reason: `${source}: entry is empty` };
  }
  if (entry !== entry.trim() || /\s/.test(entry)) {
    return { ok: false, reason: `${source}: entry contains whitespace` };
  }
  let scheme = 'https'; // bare shorthand = https (the safe default)
  let rest = entry;
  const schemeSep = entry.indexOf('://');
  if (schemeSep >= 0) {
    scheme = entry.slice(0, schemeSep).toLowerCase();
    rest = entry.slice(schemeSep + 3);
  }
  if (scheme !== 'http' && scheme !== 'https') {
    return { ok: false, reason: `${source}: scheme '${scheme}' rejected (only http/https)` };
  }
  if (rest.length === 0) {
    return { ok: false, reason: `${source}: missing host` };
  }
  if (rest.includes('@')) {
    return { ok: false, reason: `${source}: credentials in entry rejected` };
  }
  if (/[/?#]/.test(rest)) {
    return { ok: false, reason: `${source}: path/query/fragment in entry rejected (host[:port] only)` };
  }

  let host;
  let port = null;
  if (rest.startsWith('[')) {
    // Bracketed IPv6 literal: [v6] or [v6]:port
    const close = rest.indexOf(']');
    if (close < 0) {
      return { ok: false, reason: `${source}: unclosed IPv6 literal` };
    }
    host = rest.slice(1, close);
    const tail = rest.slice(close + 1);
    if (tail.length > 0) {
      if (!tail.startsWith(':')) {
        return { ok: false, reason: `${source}: invalid port after IPv6 literal` };
      }
      port = parsePortStr(tail.slice(1));
      if (port == null) {
        return { ok: false, reason: `${source}: invalid port '${tail.slice(1)}' (1-65535, no leading zeros)` };
      }
    }
    if (!parseIp6Literal(host)) {
      return { ok: false, reason: `${source}: invalid IPv6 literal` };
    }
  } else {
    const sep = rest.lastIndexOf(':');
    if (sep >= 0) {
      host = rest.slice(0, sep);
      if (host.includes(':')) {
        return { ok: false, reason: `${source}: IPv6 literal must be bracketed` };
      }
      port = parsePortStr(rest.slice(sep + 1));
      if (port == null) {
        return { ok: false, reason: `${source}: invalid port '${rest.slice(sep + 1)}' (1-65535, no leading zeros)` };
      }
    } else {
      host = rest;
    }
    if (host.length === 0) {
      return { ok: false, reason: `${source}: missing host` };
    }
    if (host.length > 253) {
      return { ok: false, reason: `${source}: host exceeds 253 chars` };
    }
    if (host.includes('*')) {
      return { ok: false, reason: `${source}: wildcard host rejected (exact match only — no subdomain wildcards)` };
    }
    if (host.endsWith('.')) {
      return { ok: false, reason: `${source}: trailing dot rejected` };
    }
    if (parseIp4Literal(host) === null && host.includes('.')) {
      // dotted but not a valid IPv4 literal -> DNS name; validate labels
      const labels = host.split('.');
      for (const label of labels) {
        if (label.length === 0 || label.length > 63 || !DNS_LABEL_RE.test(label)) {
          return { ok: false, reason: `${source}: invalid DNS label '${label}'` };
        }
      }
    } else if (host.includes('.') === false) {
      // single label (Docker DNS `api`, `postgres`, ...) — still validate charset
      if (!DNS_LABEL_RE.test(host)) {
        return { ok: false, reason: `${source}: invalid host '${host}'` };
      }
    }
  }

  if (port == null) port = scheme === 'https' ? 443 : 80;
  return { ok: true, entry: { scheme, host: normalizeHost(host), port } };
}

/**
 * Parse a full allowlist source.
 * @param {string[]|string} items array of entries, or a comma-separated string (env form)
 * @param {string} source error-message context
 * @returns {{ok:true, entries:Array} | {ok:false, reason:string}}
 */
export function parseAllowlist(items, source = 'allowlist') {
  const list = typeof items === 'string' ? items.split(',') : Array.isArray(items) ? items : null;
  if (list == null) {
    return { ok: false, reason: `${source}: must be a string or string[]` };
  }
  const entries = [];
  for (const raw of list) {
    const entry = typeof raw === 'string' ? raw.trim() : raw;
    if (entry === '' || entry == null) continue; // empty items tolerated (trailing commas)
    const parsed = parseAllowlistEntry(entry, source);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    entries.push(parsed.entry);
  }
  return { ok: true, entries };
}

// ---------------------------------------------------------------------------
// IP classification (byte-level — catches every IPv4-mapped/compatible form)
// ---------------------------------------------------------------------------

/**
 * @param {string} s dotted quad
 * @returns {number[]|null} 4 bytes
 */
export function parseIp4(s) {
  return parseIp4Literal(typeof s === 'string' ? s : '');
}

/**
 * @param {string} s IPv6 (with optional embedded dotted-quad tail)
 * @returns {number[]|null} 16 bytes
 */
export function parseIp6Literal(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 45) return null;
  let addr = s.toLowerCase();
  let v4 = null;
  if (addr.includes('.')) {
    const c = addr.lastIndexOf(':');
    if (c < 0) return null;
    v4 = parseIp4Literal(addr.slice(c + 1));
    if (!v4) return null;
    addr = addr.slice(0, c + 1) + '0:0'; // placeholder; v4 bytes applied at groups 6/7
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const parseGroup = (str) => {
    if (str === '') return [];
    const parts = str.split(':');
    if (parts.some((p) => p.length === 0 || p.length > 4 || !/^[0-9a-f]{1,4}$/.test(p))) return null;
    return parts.map((p) => parseInt(p, 16));
  };
  let head;
  let tail;
  if (halves.length === 2) {
    head = parseGroup(halves[0]);
    tail = parseGroup(halves[1]);
    if (head === null || tail === null) return null;
    if (head.length + tail.length > 7) return null;
  } else {
    head = parseGroup(halves[0]);
    if (head === null || head.length !== 8) return null;
    tail = [];
  }
  const groups = [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail];
  if (groups.length !== 8) return null;
  const bytes = [];
  for (let i = 0; i < 8; i += 1) {
    let g = groups[i];
    if (v4 && i === 6) g = v4[0] * 256 + v4[1];
    else if (v4 && i === 7) g = v4[2] * 256 + v4[3];
    bytes.push(g >> 8, g & 0xff);
  }
  return bytes;
}

/** [base (dotted/hex string), prefix bits, class] — checked in order. */
const V4_RANGES = [
  ['0.0.0.0/8', 8, 'unspecified'],
  ['10.0.0.0/8', 8, 'private'],
  ['100.64.0.0/10', 10, 'cgnat'],
  ['127.0.0.0/8', 8, 'loopback'],
  ['169.254.0.0/16', 16, 'link-local'],
  ['172.16.0.0/12', 12, 'private'],
  ['192.168.0.0/16', 16, 'private'],
  ['192.0.2.0/24', 24, 'test-net'],
  ['198.51.100.0/24', 24, 'test-net'],
  ['203.0.113.0/24', 24, 'test-net'],
  ['224.0.0.0/4', 4, 'multicast'],
  ['255.255.255.255/32', 32, 'broadcast'],
];

const V6_RANGES = [
  ['::/128', 128, 'unspecified'],
  ['::1/128', 128, 'loopback'],
  ['64:ff9b::/96', 96, 'nat64'],
  ['fc00::/7', 7, 'private'],
  ['fe80::/10', 10, 'link-local'],
  ['ff00::/8', 8, 'multicast'],
];

const METADATA_V4 = [169, 254, 169, 254]; // cloud metadata endpoint — ALWAYS rejected (both zones)

function bytesMatchPrefix(bytes, prefixBytes, bits) {
  for (let i = 0; i * 8 < bits; i += 1) {
    const remaining = bits - i * 8;
    const mask = remaining >= 8 ? 0xff : (0xff << (8 - remaining)) & 0xff;
    if ((bytes[i] & mask) !== (prefixBytes[i] & mask)) return false;
  }
  return true;
}

function classifyV4(bytes) {
  if (bytes.length === 4 && bytes.every((b, i) => b === METADATA_V4[i])) return 'metadata';
  for (const [cidr, bits, cls] of V4_RANGES) {
    if (bytesMatchPrefix(bytes, parseIp4Literal(cidr.split('/')[0]), bits)) return cls;
  }
  return 'public';
}

function classifyV6(bytes) {
  // :: and ::1 first (so v4-compatible normalization below never misclassifies them)
  if (bytes.every((b) => b === 0)) return 'unspecified';
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return 'loopback';
  // IPv4-mapped ::ffff:a.b.c.d (WHATWG URL normalizes to hex — caught byte-wise here)
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return classifyV4(bytes.slice(12));
  }
  // IPv4-compatible ::a.b.c.d (deprecated, still on the wire)
  if (bytes.slice(0, 12).every((b) => b === 0)) {
    return classifyV4(bytes.slice(12));
  }
  for (const [cidr, bits, cls] of V6_RANGES) {
    if (bytesMatchPrefix(bytes, parseIp6Literal(cidr.split('/')[0]), bits)) return cls;
  }
  return 'public';
}

/**
 * Classify one IP address string.
 *
 * @param {string} ip
 * @returns {{ok:true, ip:string, cls:string} | {ok:false, reason:string}}
 *   cls ∈ public|loopback|private|link-local|cgnat|unspecified|multicast|broadcast|metadata|nat64|test-net
 */
export function classifyIp(ip) {
  if (typeof ip !== 'string') return { ok: false, reason: 'ip is not a string' };
  const s = ip.trim();
  if (s.length === 0) return { ok: false, reason: 'ip is empty' };
  const v4 = parseIp4(s);
  if (v4) return { ok: true, ip: s, cls: classifyV4(v4) };
  const v6 = parseIp6Literal(s);
  if (v6) return { ok: true, ip: s, cls: classifyV6(v6) };
  return { ok: false, reason: `unparseable IP address '${s}'` };
}

/**
 * @param {string} cls from classifyIp
 * @param {'public'|'internal'} zone
 * @returns {boolean}
 */
export function isIpAllowedForZone(cls, zone) {
  const allowed = zone === 'public' ? PUBLIC_ALLOWED_CLASSES : INTERNAL_ALLOWED_CLASSES;
  return allowed.includes(cls);
}

// ---------------------------------------------------------------------------
// Target parsing (the URL side of assessTarget)
// ---------------------------------------------------------------------------

/**
 * Normalize a host for matching: lowercase; IPv6 literals (bracketed or not)
 * are canonicalized to FULLY EXPANDED hex groups — so an entry written as
 * `http://[::ffff:127.0.0.1]` and a URL whose WHATWG-normalized host is
 * `::ffff:7f00:1` (and every other spelling of the same address) match.
 */
export function normalizeHost(host) {
  let h = String(host ?? '').toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const v6 = parseIp6Literal(h);
  if (v6) {
    const groups = [];
    for (let i = 0; i < 16; i += 2) {
      groups.push(((v6[i] << 8) | v6[i + 1]).toString(16).padStart(4, '0'));
    }
    return groups.join(':');
  }
  return h;
}

/**
 * Parse + validate a candidate outbound URL at the string level.
 * Order matters: scheme first (file:// etc. are rejected BEFORE anything else),
 * then userinfo (credentials in URLs are an injection vector), then host/port.
 *
 * @param {string} raw
 * @returns {{ok:true, scheme, host, port} | {ok:false, code, reason}}
 */
export function parseTarget(raw) {
  const bad = (code, reason) => ({ ok: false, code, reason });
  if (typeof raw !== 'string' || raw.length === 0) return bad(NETWORK_GATE_ERROR.BAD_TARGET, 'target is empty');
  if (raw !== raw.trim()) return bad(NETWORK_GATE_ERROR.BAD_TARGET, 'target has leading/trailing whitespace');
  let u;
  try {
    u = new URL(raw);
  } catch {
    return bad(NETWORK_GATE_ERROR.BAD_TARGET, 'unparseable URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return bad(NETWORK_GATE_ERROR.BAD_SCHEME, `scheme '${u.protocol}' rejected (only http/https — no file/gopher/ftp/data/...)`);
  }
  if (u.username !== '' || u.password !== '') {
    return bad(NETWORK_GATE_ERROR.BAD_TARGET, 'credentials in URL (userinfo) rejected');
  }
  if (!u.hostname) return bad(NETWORK_GATE_ERROR.BAD_TARGET, 'missing host');
  const port = u.port !== '' ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return bad(NETWORK_GATE_ERROR.BAD_TARGET, `invalid port '${u.port}'`);
  }
  return { ok: true, scheme: u.protocol === 'https:' ? 'https' : 'http', host: normalizeHost(u.hostname), port };
}

// ---------------------------------------------------------------------------
// The core assessment (parse -> allowlist -> ONE resolve -> ALL IPs validated)
// ---------------------------------------------------------------------------

/** Real resolver: every A/AAAA record, verbatim (no v6->v4 mangling). */
export async function defaultResolve(hostname) {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

function entryMatches(entry, t) {
  return entry.scheme === t.scheme && entry.host === t.host && entry.port === t.port;
}

/**
 * Assess one outbound target against the allowlist + SSRF rules.
 *
 * Contract (the anti-rebinding core, MD Phase 4):
 *   1. scheme / userinfo / port validated at string level (no DNS for bad URLs)
 *   2. allowlist match — a non-matching host is rejected BEFORE any DNS query
 *      (no DNS leak for arbitrary task-supplied-looking hosts)
 *   3. the host is resolved EXACTLY ONCE (injected `resolve`; the real default
 *      is node:dns `all: true` — every A/AAAA record)
 *   4. EVERY resolved IP is classified; a single blocked address fails the target
 *      (the classic rebinding record [public, 127.0.0.1] is caught here)
 *   5. on success the result carries `pinnedIps`: the connecting client MUST
 *      dial one of these validated IPs with `Host: <original host>` — it must
 *      NOT re-resolve the name (a second resolve is where rebinding wins).
 *
 * @param {string} rawUrl
 * @param {object} deps
 * @param {(host:string) => Promise<string[]>} [deps.resolve] injectable resolver (tests are hermetic)
 * @param {{public:Array, internal:Array}} deps.entries parsed allowlist (from loadNetworkPolicy)
 */
export async function assessTarget(rawUrl, { resolve = defaultResolve, entries } = {}) {
  if (!entries || (!Array.isArray(entries.public) || !Array.isArray(entries.internal)
    || entries.public.length === 0 && entries.internal.length === 0)) {
    return { ok: false, code: NETWORK_GATE_ERROR.POLICY_UNAVAILABLE, reason: 'no allowlist entries loaded' };
  }
  const t = parseTarget(rawUrl);
  if (!t.ok) return t;

  const matchedPublic = entries.public.some((e) => entryMatches(e, t));
  const matchedInternal = entries.internal.some((e) => entryMatches(e, t));
  if (!matchedPublic && !matchedInternal) {
    return {
      ok: false,
      code: NETWORK_GATE_ERROR.TARGET_DENIED,
      reason: `target ${t.scheme}://${t.host}:${t.port} is not in the allowlist`,
    };
  }

  let ips;
  try {
    ips = await resolve(t.host);
  } catch (err) {
    return {
      ok: false,
      code: NETWORK_GATE_ERROR.RESOLUTION_FAILED,
      reason: `DNS resolution failed for '${t.host}': ${err?.message ?? err}`,
    };
  }
  if (!Array.isArray(ips) || ips.length === 0) {
    return {
      ok: false,
      code: NETWORK_GATE_ERROR.RESOLUTION_FAILED,
      reason: `DNS returned no addresses for '${t.host}'`,
    };
  }

  const classified = [];
  for (const ip of ips) {
    const c = classifyIp(String(ip));
    if (!c.ok) {
      return {
        ok: false,
        code: NETWORK_GATE_ERROR.RESOLUTION_FAILED,
        reason: `unparseable resolved address '${ip}' for '${t.host}'`,
      };
    }
    classified.push(c);
  }

  const okPublic = matchedPublic && classified.every((c) => isIpAllowedForZone(c.cls, 'public'));
  const okInternal = matchedInternal && classified.every((c) => isIpAllowedForZone(c.cls, 'internal'));
  if (okPublic || okInternal) {
    return {
      ok: true,
      scheme: t.scheme,
      host: t.host,
      port: t.port,
      zone: okPublic ? 'public' : 'internal',
      pinnedIps: classified.map((c) => c.ip),
    };
  }

  const offenders = classified.map((c) => `${c.ip}(${c.cls})`).join(', ');
  const reason = matchedPublic && matchedInternal
    ? `allowlisted target resolved to disallowed address class(es) for both zones: ${offenders}`
    : `allowlisted target resolved to disallowed address(es) — ${matchedPublic ? 'public-zone entries require public IPs only' : 'internal-zone entries require loopback/private/link-local IPs'}: ${offenders}`;
  return { ok: false, code: NETWORK_GATE_ERROR.BLOCKED_IP, reason };
}

/**
 * Redirect policy (documented decision, MD Phase 4): redirects are re-validated
 * PER HOP as a fresh target — full scheme / allowlist / single-resolve /
 * all-IPs checks again — and an https→http protocol downgrade is rejected
 * outright. (The alternative, blanket redirect blocking, is stricter but breaks
 * legitimate QA endpoints that canonicalize their URL; per-hop re-validation
 * keeps the same safety invariant — no hop may land outside the allowlist.)
 *
 * This helper is the library contract for the future pinned HTTP dispatcher
 * (B6 integration item); the worker's current provider client does not follow
 * redirects into unvalidated hosts without it.
 *
 * @param {string} fromRaw the URL the hop came from
 * @param {string} toRaw   the Location value
 */
export async function assessRedirect(fromRaw, toRaw, opts) {
  const from = parseTarget(fromRaw);
  if (!from.ok) return from;
  const to = await assessTarget(toRaw, opts);
  if (!to.ok) return to;
  if (from.scheme === 'https' && to.scheme === 'http') {
    return {
      ok: false,
      code: NETWORK_GATE_ERROR.BAD_TARGET,
      reason: `redirect protocol downgrade rejected (${from.scheme}→${to.scheme})`,
    };
  }
  return { ok: true, ...to };
}

// ---------------------------------------------------------------------------
// Policy loading (env + AppSetting; fail-closed on ANY malformation)
// ---------------------------------------------------------------------------

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * Load the effective policy: env vars + AppSetting rows (union per zone).
 *
 * Fail-closed rules (MD §5.1):
 *   - zero valid entries anywhere            -> unavailable
 *   - one malformed env entry / AppSetting   -> unavailable (a partial policy
 *     would silently change what is allowed — never)
 *   - a DB read ERROR (db present)           -> unavailable (we cannot prove
 *     the policy was fully loaded)
 *   - db == null (worker pre-start)          -> env-only (no job can be
 *     processed before start; documented robustness path)
 *
 * @param {object} deps
 * @param {object} deps.env process.env
 * @param {object|null} [deps.db] prisma client (appSetting model)
 * @param {object} [deps.log]
 * @returns {Promise<{available:true, entries:{public:Array, internal:Array}, taskTypes:{ai:boolean, adhoc:boolean}, sources:object} | {available:false, reason:string}>}
 */
export async function loadNetworkPolicy({ env = {}, db = null, log = silentLog }) {
  const fail = (reason) => {
    log.warn?.({ reason }, 'network policy unavailable — fail-closed (MD §5.1)');
    return { available: false, reason };
  };
  try {
    const envPublic = parseAllowlist(env[NETWORK_POLICY_ENV.ALLOWLIST] ?? '', NETWORK_POLICY_ENV.ALLOWLIST);
    if (!envPublic.ok) return fail(`env ${NETWORK_POLICY_ENV.ALLOWLIST} malformed: ${envPublic.reason}`);
    const envInternal = parseAllowlist(env[NETWORK_POLICY_ENV.ALLOWLIST_INTERNAL] ?? '', NETWORK_POLICY_ENV.ALLOWLIST_INTERNAL);
    if (!envInternal.ok) return fail(`env ${NETWORK_POLICY_ENV.ALLOWLIST_INTERNAL} malformed: ${envInternal.reason}`);

    let dbPublic = [];
    let dbInternal = [];
    let taskTypes = { ...DEFAULT_TASK_TYPES };
    if (db) {
      const readList = async (key) => {
        const row = await db.appSetting.findUnique({ where: { key } });
        if (!row) return [];
        if (!Array.isArray(row.valueJson)) {
          throw new Error(`appSetting '${key}' must be a JSON array of entry strings`);
        }
        return row.valueJson.map((v) => String(v));
      };
      dbPublic = await readList(NETWORK_SETTING_KEYS.ALLOWLIST);
      dbInternal = await readList(NETWORK_SETTING_KEYS.ALLOWLIST_INTERNAL);
      const parsedPublic = parseAllowlist(dbPublic, NETWORK_SETTING_KEYS.ALLOWLIST);
      if (!parsedPublic.ok) return fail(`appSetting ${NETWORK_SETTING_KEYS.ALLOWLIST} malformed: ${parsedPublic.reason}`);
      const parsedInternal = parseAllowlist(dbInternal, NETWORK_SETTING_KEYS.ALLOWLIST_INTERNAL);
      if (!parsedInternal.ok) return fail(`appSetting ${NETWORK_SETTING_KEYS.ALLOWLIST_INTERNAL} malformed: ${parsedInternal.reason}`);
      dbPublic = parsedPublic.entries;
      dbInternal = parsedInternal.entries;

      const ttRow = await db.appSetting.findUnique({ where: { key: NETWORK_SETTING_KEYS.TASK_TYPES } });
      if (ttRow) {
        const v = ttRow.valueJson;
        if (v == null || typeof v !== 'object' || Array.isArray(v)) {
          throw new Error(`appSetting '${NETWORK_SETTING_KEYS.TASK_TYPES}' must be a JSON object of booleans`);
        }
        for (const k of Object.keys(v)) {
          if (k !== 'ai' && k !== 'adhoc') throw new Error(`appSetting '${NETWORK_SETTING_KEYS.TASK_TYPES}' has unknown key '${k}'`);
          if (typeof v[k] !== 'boolean') throw new Error(`appSetting '${NETWORK_SETTING_KEYS.TASK_TYPES}' key '${k}' must be a boolean`);
        }
        if (typeof v.ai === 'boolean') taskTypes.ai = v.ai;
        if (typeof v.adhoc === 'boolean') taskTypes.adhoc = v.adhoc;
      }
    }

    const dedupe = (list) => {
      const seen = new Set();
      return list.filter((e) => {
        const k = `${e.scheme}|${e.host}|${e.port}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };
    const publicEntries = dedupe([...envPublic.entries, ...dbPublic]);
    const internalEntries = dedupe([...envInternal.entries, ...dbInternal]);
    if (publicEntries.length === 0 && internalEntries.length === 0) {
      return fail('no allowlist entries configured (env QA_ENDPOINT_ALLOWLIST[_INTERNAL] or appSetting) — fail-closed by design');
    }
    return {
      available: true,
      entries: { public: publicEntries, internal: internalEntries },
      taskTypes,
      sources: {
        envPublic: envPublic.entries.length,
        envInternal: envInternal.entries.length,
        dbPublic: dbPublic.length,
        dbInternal: dbInternal.length,
      },
    };
  } catch (err) {
    return fail(`policy load error: ${err?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// Audit (actor=system; target redacted to scheme://host:port — no credentials)
// ---------------------------------------------------------------------------

/**
 * Redact a raw target to the audit-safe form: scheme://host:port only.
 * userinfo (credentials), path and query NEVER reach the audit trail.
 */
export function redactTarget(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${u.protocol}//<opaque>`;
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch {
    return '<unparseable>';
  }
}

function truncateStr(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

/**
 * Default audit sink: appends to audit_events (actorUserId null = system) and
 * degrades to log-only on failure — mirrors apps/api createAuditService: the
 * deny verdict NEVER depends on the audit write succeeding.
 */
function createDbAuditSink(getDb, log) {
  return async function writeDenyAudit(entry) {
    const db = getDb ? getDb() : null;
    if (!db || typeof db.auditEvent?.create !== 'function') {
      log.debug?.('network policy audit: no db available — log-only');
      return;
    }
    try {
      await db.auditEvent.create({
        data: {
          actorUserId: null, // system actor (MD §9.5: actor=system)
          action: entry.action,
          resourceType: entry.resourceType ?? null,
          resourceId: entry.resourceId ?? null,
          requestId: null,
          ip: null,
          status: entry.status ?? null,
          detailsJson: entry.details,
        },
      });
    } catch (err) {
      log.error?.({ action: entry.action, error: err.message }, 'network policy audit write failed (deny still stands)');
    }
  };
}

// ---------------------------------------------------------------------------
// The gate (B1 seam implementation — the worker.js swap-in)
// ---------------------------------------------------------------------------

/**
 * Collect the egress targets this run can actually reach:
 *   1. the configured provider base URL (when the run names a real provider —
 *      'mock' / missing / disabled / row-missing all mean "no egress target":
 *      the provider resolver will fail the run BEFORE any network contact)
 *   2. the internal API URL (tool execution goes worker→API over HTTP)
 *
 * The gate reads the run row itself (inputJson) — the B1 ctx carries no URL
 * field, and the engine is frozen (zero-change contract).
 */
async function collectEgressTargets({ db, ctx, config }) {
  const targets = [];
  let inputJson = null;
  if (db) {
    const run = await db.taskRun.findUnique({ where: { id: ctx?.runId } });
    inputJson = run?.inputJson ?? null;
  }
  const providerName = inputJson?.provider;
  if (db && typeof providerName === 'string' && providerName.length > 0 && providerName !== 'mock') {
    const pc = await db.providerConfig.findUnique({ where: { name: providerName } });
    if (pc && pc.isEnabled !== false && typeof pc.baseUrl === 'string' && pc.baseUrl.length > 0) {
      targets.push({ name: `provider:${providerName}`, url: pc.baseUrl });
    }
    // pc missing / disabled / no baseUrl -> resolveProviderForRun hard-fails the
    // run pre-network (PROVIDER_NOT_CONFIGURED); there is nothing for the gate to fence.
  }
  if (config && typeof config.apiInternalUrl === 'string' && config.apiInternalUrl.length > 0) {
    targets.push({ name: 'api-internal', url: config.apiInternalUrl });
  }
  return targets;
}

/**
 * Create the real network policy gate (replaces createAllowAllNetworkGate in
 * worker.js — the B1 seam; engine zero-change).
 *
 * Contract (B1): `async (ctx) => { allowed: true } | { allowed: false, code, reason }`
 * with ctx = { runId, attempt, identityId, batchId, taskType }.
 * The gate NEVER throws: any internal failure is a POLICY_UNAVAILABLE deny.
 *
 * @param {object} deps
 * @param {() => (object|null)} [deps.getDb] lazy prisma client (worker builds the db at start())
 * @param {object} [deps.env] process.env (QA_ENDPOINT_ALLOWLIST[_INTERNAL])
 * @param {object} [deps.config] worker config (apiInternalUrl)
 * @param {object} [deps.log]
 * @param {(host:string) => Promise<string[]>} [deps.resolve] injectable DNS (tests are hermetic; default node:dns all-records)
 * @param {(entry:object) => Promise<void>} [deps.audit] custom sink (default: audit_events row + log)
 * @param {Function} [deps.loadPolicy] injectable (tests)
 */
export function createNetworkPolicyGate(deps = {}) {
  const env = deps.env ?? process.env;
  const log = deps.log ?? silentLog;
  const getDb = deps.getDb ?? (() => null);
  const resolve = typeof deps.resolve === 'function' ? deps.resolve : defaultResolve;
  const loadPolicy = deps.loadPolicy ?? loadNetworkPolicy;
  const config = deps.config ?? {};
  const auditSink = typeof deps.audit === 'function' ? deps.audit : createDbAuditSink(getDb, log);

  return async function networkPolicyGate(ctx = {}) {
    const startedAt = Date.now();

    /** @private fail-closed deny: audit (actor=system, redacted target) + verdict. */
    function deny(code, reason, rawTarget = null) {
      const details = {
        actor: 'system',
        code,
        taskType: ctx?.taskType ?? null,
        attempt: ctx?.attempt ?? null,
        identityId: ctx?.identityId ?? null,
        batchId: ctx?.batchId ?? null,
        target: redactTarget(rawTarget), // scheme://host:port only — never userinfo/path/query
        reason: truncateStr(reason, 300),
        durationMs: Date.now() - startedAt,
      };
      log.warn?.(details, 'network policy DENY (fail-closed)');
      return Promise.resolve(auditSink({
        action: 'network_policy_deny',
        status: 'failure',
        resourceType: 'task_run',
        resourceId: typeof ctx?.runId === 'string' ? ctx.runId : null,
        details,
      }))
        .catch((err) => {
          log.error?.({ error: err.message }, 'network policy audit sink failed (deny still stands)');
        })
        .then(() => ({ allowed: false, code, reason }));
    }

    try {
      const policy = await loadPolicy({ env, db: getDb(), log });
      if (!policy.available) {
        return deny(NETWORK_GATE_ERROR.POLICY_UNAVAILABLE, `policy unavailable: ${policy.reason}`);
      }
      if (typeof ctx.taskType === 'string' && policy.taskTypes?.[ctx.taskType] === false) {
        return deny(NETWORK_GATE_ERROR.TARGET_DENIED, `taskType '${ctx.taskType}' is not permitted by network policy`);
      }
      const targets = await collectEgressTargets({ db: getDb(), ctx, config });
      for (const t of targets) {
        const v = await assessTarget(t.url, { resolve, entries: policy.entries });
        if (!v.ok) return deny(v.code, v.reason, t.url);
      }
      return { allowed: true };
    } catch (err) {
      // Fail closed on ANY internal error — including a broken run-row read:
      // "cannot prove this run is safe" must equal "do not let it out".
      return deny(NETWORK_GATE_ERROR.POLICY_UNAVAILABLE, `gate internal error: ${err?.message ?? err}`);
    }
  };
}

