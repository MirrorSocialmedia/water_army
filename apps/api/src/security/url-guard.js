/**
 * URL guard — reject provider baseUrls that point at loopback / private /
 * link-local / cloud-metadata addresses (SSRF defence).
 *
 * The provider `baseUrl` is admin-supplied but is fetched *server-side* by
 * both `POST /api/providers/:name/test` and the worker engine. Without this
 * guard an admin (or anyone who takes over an admin session) can aim the API
 * and worker at internal services or the cloud metadata endpoint
 * (169.254.169.254). We validate at write time (create/patch) so a bad URL is
 * never stored, and re-check at fetch time as defence in depth.
 *
 * Checks performed:
 *   - protocol must be http/https
 *   - the literal host (if an IP) must not be in a blocked range
 *   - the host name `localhost` / `*.localhost` / `*.internal` / `*.local`
 *     is rejected outright
 *   - DNS names are resolved and every resolved address is range-checked
 *     (best effort — closes the obvious rebinding-at-config-time gap; a
 *     fetch-time re-check covers the rest)
 */
import net from 'node:net';
import dns from 'node:dns/promises';

/** Blocked IP ranges (loopback, private, link-local incl. metadata, CGNAT). */
const BLOCK = new net.BlockList();
// IPv4
BLOCK.addAddress('0.0.0.0', 'ipv4');
BLOCK.addSubnet('0.0.0.0', 8, 'ipv4'); // "this" network
BLOCK.addSubnet('10.0.0.0', 8, 'ipv4');
BLOCK.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT
BLOCK.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
BLOCK.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local incl. 169.254.169.254 metadata
BLOCK.addSubnet('172.16.0.0', 12, 'ipv4');
BLOCK.addSubnet('192.0.0.0', 24, 'ipv4');
BLOCK.addSubnet('192.168.0.0', 16, 'ipv4');
BLOCK.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking
BLOCK.addAddress('255.255.255.255', 'ipv4');
// IPv6
BLOCK.addAddress('::', 'ipv6');
BLOCK.addAddress('::1', 'ipv6'); // loopback
BLOCK.addSubnet('fc00::', 7, 'ipv6'); // unique-local
BLOCK.addSubnet('fe80::', 10, 'ipv6'); // link-local

const BLOCKED_HOST_SUFFIX = ['.localhost', '.internal', '.local'];

export class UrlGuardError extends Error {
  constructor(message, host) {
    super(message);
    this.name = 'UrlGuardError';
    this.code = 'BLOCKED_URL';
    this.host = host;
  }
}

/** Parse + require http(s). Throws UrlGuardError on anything else. */
export function parseHttpUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new UrlGuardError('baseUrl is not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new UrlGuardError(`baseUrl protocol '${u.protocol}' is not allowed (http/https only)`);
  }
  return u;
}

/** Strip IPv6 brackets and normalise an IPv4-mapped IPv6 (::ffff:1.2.3.4). */
function normaliseHost(hostname) {
  let h = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) h = mapped[1];
  return h;
}

/** @returns {boolean} true if the address literal is in a blocked range. */
function isBlockedAddress(addr) {
  const h = normaliseHost(addr);
  const fam = net.isIP(h);
  if (fam === 4) return BLOCK.check(h, 'ipv4');
  if (fam === 6) return BLOCK.check(h, 'ipv6');
  return false;
}

/**
 * Synchronous host check (no DNS): rejects blocked IP literals and the
 * reserved host suffixes. Returns null if OK, or a reason string if blocked.
 */
export function inspectHostSync(hostname) {
  const h = normaliseHost(hostname);
  if (h === 'localhost' || BLOCKED_HOST_SUFFIX.some((s) => h.endsWith(s))) {
    return `host '${hostname}' is a reserved/internal name`;
  }
  if (net.isIP(h) && isBlockedAddress(h)) {
    return `host '${hostname}' is a private/loopback/link-local address`;
  }
  return null;
}

/**
 * Full async validation. Parses the URL, runs the sync checks, then (for DNS
 * names) resolves and range-checks every address.
 *
 * @param {string} raw
 * @param {{resolve?: (host:string)=>Promise<Array<{address:string,family:number}>>, skipDns?: boolean}} [opts]
 *        `resolve` is injectable for tests; defaults to dns.lookup(all).
 *        `skipDns` runs only the synchronous literal/suffix checks (used in
 *        the hermetic test env, where no network is available).
 * @returns {Promise<URL>} the parsed URL when safe
 * @throws {UrlGuardError}
 */
export async function assertPublicHttpUrl(raw, opts = {}) {
  const u = parseHttpUrl(raw);
  const reason = inspectHostSync(u.hostname);
  if (reason) throw new UrlGuardError(`baseUrl ${reason}`, u.hostname);

  // Already an IP literal → sync check above was authoritative.
  if (net.isIP(normaliseHost(u.hostname))) return u;
  // DNS disabled (test env / opt-out): the sync literal + suffix checks stand.
  if (opts.skipDns) return u;

  const resolve = opts.resolve ?? ((host) => dns.lookup(host, { all: true }));
  let addrs;
  try {
    addrs = await resolve(u.hostname);
  } catch {
    throw new UrlGuardError(`baseUrl host '${u.hostname}' could not be resolved`, u.hostname);
  }
  for (const a of addrs ?? []) {
    if (isBlockedAddress(a.address)) {
      throw new UrlGuardError(
        `baseUrl host '${u.hostname}' resolves to a private/loopback/link-local address`,
        u.hostname,
      );
    }
  }
  return u;
}
