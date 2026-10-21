/**
 * BR-B4 — SSRF hardening matrix (施工 MD Phase 4, §5.1).
 *
 * Hermetic: zero network. DNS is a fake resolver (injected); every case asserts
 * the exact stable deny code from NETWORK_GATE_ERROR. Covers:
 *   - scheme allowlist (http/https only)
 *   - target shape (userinfo / port / unparseable)
 *   - full IP-class table: loopback / private / link-local / metadata / CGNAT /
 *     unspecified / multicast / broadcast / nat64 / test-net / public — incl.
 *     IPv4-mapped + IPv4-compatible IPv6 spellings (byte-level classification)
 *   - DNS rebinding: all-IPs validation + single-resolve + pinned-IP plan
 *   - zones (public vs internal) + the metadata exception in BOTH zones
 *   - allowlist entry parser strictness (wildcards/userinfo/paths rejected)
 *   - redirect policy (per-hop re-validation + downgrade rejection)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NETWORK_GATE_ERROR,
  parseAllowlistEntry,
  parseAllowlist,
  classifyIp,
  isIpAllowedForZone,
  normalizeHost,
  parseTarget,
  assessTarget,
  assessRedirect,
} from '@water-army/shared';

const PUB = '93.184.216.34'; // stable documentation IP (example.com)

/** Default allowlist: one public host + one internal Docker-DNS host. */
const ENTRIES = {
  public: [
    { scheme: 'https', host: 'qa.example.com', port: 443 },
    { scheme: 'https', host: 'api.qa.example.com', port: 8443 },
    { scheme: 'http', host: '10.0.0.5', port: 8443 }, // explicit private literal — must still be blocked in public zone
    { scheme: 'https', host: PUB, port: 443 },
  ],
  internal: [
    { scheme: 'http', host: 'api', port: 3000 },
    { scheme: 'http', host: '127.0.0.1', port: 80 },
    { scheme: 'http', host: '169.254.169.254', port: 80 }, // metadata — must be rejected even when listed
  ],
};

/** Fake resolver: host → IPs (or Error / special tokens). Records every call. */
function fakeResolver(map = {}) {
  const calls = [];
  const fn = async (h) => {
    calls.push(h);
    const v = map[h];
    if (v instanceof Error) throw v;
    return v ?? [PUB];
  };
  fn.calls = calls;
  return fn;
}

const DENY = (r) => assert.equal(r.ok, false);
const codeOf = (r) => r.code;

// ---------------------------------------------------------------------------
// A. Positive cases (allow) — the happy path + the pinned-IP contract
// ---------------------------------------------------------------------------

test('allow: public host resolving to a public IP — pinned plan, resolver called exactly once', async () => {
  const resolve = fakeResolver({ 'qa.example.com': [PUB] });
  const r = await assessTarget('https://qa.example.com/', { resolve, entries: ENTRIES });
  assert.equal(r.ok, true);
  assert.equal(r.zone, 'public');
  assert.equal(r.scheme, 'https');
  assert.equal(r.host, 'qa.example.com');
  assert.equal(r.port, 443);
  assert.deepEqual(r.pinnedIps, [PUB]);
  assert.equal(resolve.calls.length, 1, 'DNS resolved exactly ONCE (no second resolve = rebinding-proof)');
  assert.deepEqual(resolve.calls, ['qa.example.com']);
});

test('allow: internal-zone host resolving to a Docker bridge IP', async () => {
  const resolve = fakeResolver({ api: ['172.18.0.2'] });
  const r = await assessTarget('http://api:3000/', { resolve, entries: ENTRIES });
  assert.equal(r.ok, true);
  assert.equal(r.zone, 'internal');
  assert.deepEqual(r.pinnedIps, ['172.18.0.2']);
});

test('allow: exact port entry matches; other ports on the same host are denied', async () => {
  const resolve = fakeResolver();
  const ok = await assessTarget('https://api.qa.example.com:8443/x', { resolve, entries: ENTRIES });
  assert.equal(ok.ok, true);
  for (const bad of ['https://api.qa.example.com:9443/', 'https://api.qa.example.com/']) {
    const r = await assessTarget(bad, { resolve, entries: ENTRIES });
    DENY(r);
    assert.equal(codeOf(r), NETWORK_GATE_ERROR.TARGET_DENIED);
  }
});

test('allow: IPv4-literal host on the allowlist (resolves to itself)', async () => {
  const resolve = fakeResolver({ [PUB]: [PUB] });
  const r = await assessTarget(`https://${PUB}/`, { resolve, entries: ENTRIES });
  assert.equal(r.ok, true);
  assert.equal(r.zone, 'public');
});

test('allow: IPv4-mapped IPv6 that is genuinely public (transparent normalization)', async () => {
  const resolve = fakeResolver({ 'qa.example.com': ['::ffff:93.184.216.34'] });
  const r = await assessTarget('https://qa.example.com/', { resolve, entries: ENTRIES });
  assert.equal(r.ok, true, 'the mapped form must classify as its embedded v4 (public)');
});

// ---------------------------------------------------------------------------
// B. Scheme allowlist (only http/https — file/gopher/ftp/data are SSRF vectors)
// ---------------------------------------------------------------------------

test('deny: file:// scheme (BAD_SCHEME) — local file read vector', async () => {
  const r = await assessTarget('file:///etc/passwd', { resolve: fakeResolver(), entries: ENTRIES });
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.BAD_SCHEME);
});

test('deny: gopher:// scheme (BAD_SCHEME) — redis/SSRF classic', async () => {
  const r = await assessTarget('gopher://127.0.0.1:6379/_INFO', { resolve: fakeResolver(), entries: ENTRIES });
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.BAD_SCHEME);
});

test('deny: ftp:// scheme (BAD_SCHEME)', async () => {
  const r = await assessTarget('ftp://qa.example.com/file', { resolve: fakeResolver(), entries: ENTRIES });
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.BAD_SCHEME);
});

test('deny: data: scheme (BAD_SCHEME)', async () => {
  const r = await assessTarget('data:text/plain,hello', { resolve: fakeResolver(), entries: ENTRIES });
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.BAD_SCHEME);
});

test('deny: unparseable target string (BAD_TARGET)', async () => {
  const r = await assessTarget('not a url', { resolve: fakeResolver(), entries: ENTRIES });
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.BAD_TARGET);
});

// ---------------------------------------------------------------------------
// C. Target shape + allowlist matching
// ---------------------------------------------------------------------------

test('deny: credentials in URL (userinfo) rejected (BAD_TARGET)', async () => {
  const r = await assessTarget('http://user:pass@api:3000/', { resolve: fakeResolver(), entries: ENTRIES });
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.BAD_TARGET);
  assert.match(r.reason, /credentials/i);
});

test('deny: non-allowlisted host (TARGET_DENIED) AND no DNS query is ever made (no DNS leak)', async () => {
  const resolve = fakeResolver();
  const r = await assessTarget('https://evil.example.com:8443/', { resolve, entries: ENTRIES });
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.TARGET_DENIED);
  assert.equal(resolve.calls.length, 0, 'allowlist check runs BEFORE DNS — arbitrary hosts never trigger a lookup');
});

test('deny: scheme mismatch (https entry, http request) (TARGET_DENIED)', async () => {
  const resolve = fakeResolver();
  const r = await assessTarget('http://qa.example.com/', { resolve, entries: ENTRIES });
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.TARGET_DENIED);
});

test('deny: public-zone entry that is a private IP literal is still blocked (BLOCKED_IP)', async () => {
  // The operator explicitly listed http://10.0.0.5:8443 in the PUBLIC list —
  // the IP check must override the (mis)configuration.
  const resolve = fakeResolver({ '10.0.0.5': ['10.0.0.5'] });
  const r = await assessTarget('http://10.0.0.5:8443/', { resolve, entries: ENTRIES });
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.BLOCKED_IP);
});

// ---------------------------------------------------------------------------
// D. IP-class matrix (public zone): every blocked class + the public boundaries
// ---------------------------------------------------------------------------

const BLOCKED_V4_V6 = [
  // loopback
  ['127.0.0.1', 'loopback'],
  ['127.255.255.254', 'loopback'], // edge of 127/8
  ['::1', 'loopback'],
  // private
  ['10.0.0.1', 'private'],
  ['10.255.255.255', 'private'],
  ['172.16.0.1', 'private'],
  ['172.31.255.254', 'private'], // edge of 172.16/12
  ['192.168.0.1', 'private'],
  ['192.168.255.255', 'private'],
  ['fc00::abcd:1234', 'private'], // fc00::/7 edge
  ['fd12::1', 'private'], // ULA
  // link-local
  ['169.254.10.10', 'link-local'],
  ['fe80::1', 'link-local'],
  // metadata (the cloud credential endpoint — always rejected)
  ['169.254.169.254', 'metadata'],
  // CGNAT
  ['100.64.0.1', 'cgnat'],
  ['100.127.255.254', 'cgnat'], // edge of 100.64/10
  // unspecified
  ['0.0.0.0', 'unspecified'],
  ['::', 'unspecified'],
  // multicast
  ['224.0.0.1', 'multicast'],
  ['ff02::1', 'multicast'],
  // broadcast
  ['255.255.255.255', 'broadcast'],
  // nat64 / test-net (synthetic / documentation ranges — never real targets)
  ['64:ff9b::1', 'nat64'],
  ['192.0.2.53', 'test-net'],
  // IPv4-mapped / IPv4-compatible IPv6 spellings (byte-level catch)
  ['::ffff:127.0.0.1', 'loopback'],
  ['::ffff:7f00:1', 'loopback'], // WHATWG-normalized spelling of the same address
  ['::ffff:100.64.0.1', 'cgnat'],
  ['::ffff:169.254.169.254', 'metadata'],
  ['::127.0.0.1', 'loopback'], // deprecated v4-compatible form
];

for (const [ip, cls] of BLOCKED_V4_V6) {
  test(`classifyIp: ${ip} → ${cls}`, () => {
    const r = classifyIp(ip);
    assert.equal(r.ok, true, `expected ${ip} to parse, got: ${r.reason}`);
    assert.equal(r.cls, cls);
    assert.equal(isIpAllowedForZone(r.cls, 'public'), false);
  });
}

const PUBLIC_BOUNDARIES = [
  ['93.184.216.34', 'public'],
  ['8.8.8.8', 'public'],
  ['172.15.255.255', 'public'], // just below 172.16/12
  ['172.32.0.1', 'public'], // just above 172.16/12
  ['100.128.0.1', 'public'], // just above 100.64/10
  ['2001:db8::1', 'public'], // global v6
];

for (const [ip, cls] of PUBLIC_BOUNDARIES.filter(Boolean)) {
  test(`classifyIp: ${ip} → ${cls} (boundary)`, () => {
    const r = classifyIp(ip);
    assert.equal(r.ok, true, `expected ${ip} to parse, got: ${r.reason}`);
    assert.equal(r.cls, cls);
    assert.equal(isIpAllowedForZone(r.cls, 'public'), true);
  });
}

test('classifyIp: unparseable inputs fail (never classified as public)', () => {
  for (const bad of ['256.1.1.1', '1.2.3', 'not-an-ip', '::gggg::1', '1:2:3', '', '  ']) {
    const r = classifyIp(bad);
    assert.equal(r.ok, false, `expected '${bad}' to be unparseable`);
  }
});

// The full assessment path: allowlisted public host resolving to each blocked IP.
for (const [ip] of [
  ['127.0.0.1'],
  ['10.1.2.3'],
  ['172.16.0.1'],
  ['192.168.1.1'],
  ['fd12::1'],
  ['169.254.169.254'],
  ['fe80::1'],
  ['100.64.0.1'],
  ['0.0.0.0'],
  ['::'],
  ['::ffff:127.0.0.1'],
]) {
  test(`assess: allowlisted host resolving to ${ip} → BLOCKED_IP`, async () => {
    const r = await assessTarget('https://qa.example.com/', {
      resolve: fakeResolver({ 'qa.example.com': [ip] }),
      entries: ENTRIES,
    });
    DENY(r);
    assert.equal(codeOf(r), NETWORK_GATE_ERROR.BLOCKED_IP);
    assert.match(r.reason, /169\.254\.169\.254|BLOCKED|disallowed|loopback|private|link-local|metadata|cgnat|unspecified/i);
  });
}

// ---------------------------------------------------------------------------
// E. DNS rebinding (the core)
// ---------------------------------------------------------------------------

test('rebinding: a record set [public, 127.0.0.1] is rejected — ALL resolved IPs must pass', async () => {
  const r = await assessTarget('https://qa.example.com/', {
    resolve: fakeResolver({ 'qa.example.com': [PUB, '127.0.0.1'] }),
    entries: ENTRIES,
  });
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.BLOCKED_IP);
  assert.match(r.reason, /127\.0\.0\.1\(loopback\)/);
});

test('rebinding: time-based rebind (public now, private later) — single resolve + pin defeats it', async () => {
  // Classic rebinding: first TXT/A answer is public, the next answer (which a
  // second resolver call — or the real socket connect — would see) is 127.0.0.1.
  let n = 0;
  const resolve = async () => {
    n += 1;
    return n === 1 ? [PUB] : ['127.0.0.1'];
  };
  const r = await assessTarget('https://qa.example.com/', { resolve, entries: ENTRIES });
  assert.equal(r.ok, true, 'the first (validated) answer is pinned');
  assert.equal(n, 1, 'assessTarget NEVER resolves twice — the second (poisoned) answer is never seen');
  assert.deepEqual(r.pinnedIps, [PUB], 'the connection plan pins the validated IP');
});

test('resolution: resolver throws → RESOLUTION_FAILED (fail-closed)', async () => {
  const r = await assessTarget('https://qa.example.com/', {
    resolve: fakeResolver({ 'qa.example.com': new Error('EAI_AGAIN') }),
    entries: ENTRIES,
  });
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.RESOLUTION_FAILED);
});

test('resolution: resolver returns zero addresses → RESOLUTION_FAILED', async () => {
  const r = await assessTarget('https://qa.example.com/', {
    resolve: fakeResolver({ 'qa.example.com': [] }),
    entries: ENTRIES,
  });
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.RESOLUTION_FAILED);
});

test('resolution: resolver returns a non-IP string → RESOLUTION_FAILED (fail-closed)', async () => {
  const r = await assessTarget('https://qa.example.com/', {
    resolve: fakeResolver({ 'qa.example.com': ['not-an-ip'] }),
    entries: ENTRIES,
  });
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.RESOLUTION_FAILED);
});

// ---------------------------------------------------------------------------
// F. Internal zone (Docker bridge / host-local)
// ---------------------------------------------------------------------------

test('internal zone: accepts loopback (host-local dev API)', async () => {
  const r = await assessTarget('http://127.0.0.1/', {
    resolve: fakeResolver({ '127.0.0.1': ['127.0.0.1'] }),
    entries: ENTRIES,
  });
  assert.equal(r.ok, true);
  assert.equal(r.zone, 'internal');
});

test('internal zone: accepts private + ULA', async () => {
  const r1 = await assessTarget('http://api:3000/', {
    resolve: fakeResolver({ api: ['172.18.0.2'] }),
    entries: ENTRIES,
  });
  assert.equal(r1.ok, true);
  const entries2 = { public: [], internal: [{ scheme: 'http', host: 'ula', port: 80 }] };
  const r2 = await assessTarget('http://ula/', {
    resolve: fakeResolver({ ula: ['fd12::9'] }),
    entries: entries2,
  });
  assert.equal(r2.ok, true);
});

test('internal zone: metadata 169.254.169.254 is rejected EVEN WHEN EXPLICITLY LISTED', async () => {
  const r = await assessTarget('http://169.254.169.254/latest/meta-data/', {
    resolve: fakeResolver({ '169.254.169.254': ['169.254.169.254'] }),
    entries: ENTRIES,
  });
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.BLOCKED_IP);
});

test('internal zone: metadata in IPv4-mapped form is rejected too', async () => {
  const entries = { public: [], internal: [{ scheme: 'http', host: 'meta', port: 80 }] };
  const r = await assessTarget('http://meta/', {
    resolve: fakeResolver({ meta: ['::ffff:169.254.169.254'] }),
    entries,
  });
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.BLOCKED_IP);
});

test('internal zone: CGNAT is rejected (not a Docker bridge)', async () => {
  const entries = { public: [], internal: [{ scheme: 'http', host: 'x', port: 80 }] };
  const r = await assessTarget('http://x/', {
    resolve: fakeResolver({ x: ['100.64.0.1'] }),
    entries,
  });
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.BLOCKED_IP);
});

test('internal zone: an entry resolving to a PUBLIC IP is rejected (misconfig / DNS hijack)', async () => {
  const r = await assessTarget('http://api:3000/', {
    resolve: fakeResolver({ api: [PUB] }),
    entries: ENTRIES,
  });
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.BLOCKED_IP);
});

test('internal zone: 0.0.0.0 (unspecified) is rejected', async () => {
  const entries = { public: [], internal: [{ scheme: 'http', host: 'y', port: 80 }] };
  const r = await assessTarget('http://y/', {
    resolve: fakeResolver({ y: ['0.0.0.0'] }),
    entries,
  });
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.BLOCKED_IP);
});

// ---------------------------------------------------------------------------
// G. Allowlist entry parser strictness
// ---------------------------------------------------------------------------

test('entry: bare host shorthand = https on default port', () => {
  const r = parseAllowlistEntry('qa.example.com');
  assert.equal(r.ok, true);
  assert.deepEqual(r.entry, { scheme: 'https', host: 'qa.example.com', port: 443 });
});

test('entry: bare host:port shorthand = https', () => {
  const r = parseAllowlistEntry('api.qa.example.com:8443');
  assert.equal(r.ok, true);
  assert.deepEqual(r.entry, { scheme: 'https', host: 'api.qa.example.com', port: 8443 });
});

test('entry: explicit http scheme is honored', () => {
  const r = parseAllowlistEntry('http://api:3000');
  assert.equal(r.ok, true);
  assert.deepEqual(r.entry, { scheme: 'http', host: 'api', port: 3000 });
});

test('entry: wildcard host rejected (no subdomain wildcarding)', () => {
  assert.equal(parseAllowlistEntry('https://*.example.com').ok, false);
  assert.equal(parseAllowlistEntry('*').ok, false);
});

test('entry: userinfo rejected', () => {
  assert.equal(parseAllowlistEntry('https://user:pass@example.com').ok, false);
});

test('entry: path/query/fragment rejected (host[:port] only)', () => {
  for (const bad of ['https://x.com/path', 'https://x.com/?q=1', 'https://x.com#frag']) {
    assert.equal(parseAllowlistEntry(bad).ok, false, bad);
  }
});

test('entry: non-http(s) schemes rejected', () => {
  for (const bad of ['gopher://x.com', 'file:///x', 'ftp://x.com']) {
    assert.equal(parseAllowlistEntry(bad).ok, false, bad);
  }
});

test('entry: invalid ports rejected (0, 65536, leading zeros)', () => {
  for (const bad of ['http://x.com:0', 'http://x.com:65536', 'http://x.com:0443']) {
    assert.equal(parseAllowlistEntry(bad).ok, false, bad);
  }
});

test('entry: unbracketed IPv6 rejected', () => {
  assert.equal(parseAllowlistEntry('http://[::1').ok, false);
  assert.equal(parseAllowlistEntry('http://fd12::1:8080').ok, false); // ambiguous — brackets required
});

test('entry: whitespace rejected', () => {
  assert.equal(parseAllowlistEntry('https://x .com').ok, false);
  assert.equal(parseAllowlistEntry(' https://x.com').ok, false);
});

test('parseAllowlist: ONE malformed entry invalidates the WHOLE list (fail-closed, no partial policy)', () => {
  const r = parseAllowlist('https://good.example.com, https://*.bad.example.com', 'env');
  assert.equal(r.ok, false);
  assert.match(r.reason, /wildcard/);
});

test('parseAllowlist: empty items tolerated (trailing comma); empty source = zero entries', () => {
  assert.deepEqual(parseAllowlist('https://a.example.com,,  ', 'env').entries, [
    { scheme: 'https', host: 'a.example.com', port: 443 },
  ]);
  assert.deepEqual(parseAllowlist('', 'env').entries, []);
  assert.deepEqual(parseAllowlist([], 'env').entries, []);
});

// ---------------------------------------------------------------------------
// H. normalizeHost (IPv6 canonical matching across spellings)
// ---------------------------------------------------------------------------

test('normalizeHost: IPv6 spellings canonicalize identically (v4-mapped / case / brackets)', () => {
  const a = normalizeHost('[::ffff:127.0.0.1]');
  const b = normalizeHost('::ffff:7f00:1');
  const c = normalizeHost('[::FFFF:7F00:1]');
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(normalizeHost('API'), 'api');
  assert.equal(normalizeHost('qa.example.com.'), 'qa.example.com.'); // trailing dot stays a string (entries reject it earlier)
});

// ---------------------------------------------------------------------------
// I. parseTarget
// ---------------------------------------------------------------------------

test('parseTarget: WHATWG-normalized v4-mapped hostname is preserved for the IP check', () => {
  const r = parseTarget('http://[::ffff:127.0.0.1]/');
  assert.equal(r.ok, true);
  assert.equal(r.host, normalizeHost('::ffff:7f00:1'), 'host normalization must agree with entry normalization');
});

// ---------------------------------------------------------------------------
// J. Redirect policy (per-hop re-validation; downgrade rejected)
// ---------------------------------------------------------------------------

test('redirect: Location to an allowlisted https host passes full re-validation', async () => {
  const r = await assessRedirect(
    'https://qa.example.com/start',
    'https://qa.example.com/final',
    { resolve: fakeResolver({ 'qa.example.com': [PUB] }), entries: ENTRIES },
  );
  assert.equal(r.ok, true);
});

test('redirect: https→http protocol downgrade rejected (BAD_TARGET)', async () => {
  const entries = { public: [{ scheme: 'http', host: 'qa.example.com', port: 80 }], internal: [] };
  const r = await assessRedirect(
    'https://qa.example.com/',
    'http://qa.example.com/steal',
    { resolve: fakeResolver({ 'qa.example.com': [PUB] }), entries },
  );
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.BAD_TARGET);
  assert.match(r.reason, /downgrade/);
});

test('redirect: Location that resolves to loopback → BLOCKED_IP (per-hop IP check applies)', async () => {
  // The Location host IS allowlisted (public zone) but its answer is loopback
  // — exactly the rebinding shape a redirect can carry. Per-hop re-validation
  // catches it.
  const r = await assessRedirect(
    'https://qa.example.com/',
    'https://api.qa.example.com:8443/',
    { resolve: fakeResolver({ 'api.qa.example.com': ['127.0.0.1'] }), entries: ENTRIES },
  );
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.BLOCKED_IP);
});

test('redirect: Location of a non-allowlisted host → TARGET_DENIED', async () => {
  const r = await assessRedirect(
    'https://qa.example.com/',
    'https://evil.example.com/',
    { resolve: fakeResolver(), entries: ENTRIES },
  );
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.TARGET_DENIED);
});

test('redirect: Location with a blocked scheme → BAD_SCHEME', async () => {
  const r = await assessRedirect('https://qa.example.com/', 'file:///etc/shadow', { resolve: fakeResolver(), entries: ENTRIES });
  DENY(r);
  assert.equal(codeOf(r), NETWORK_GATE_ERROR.BAD_SCHEME);
});
