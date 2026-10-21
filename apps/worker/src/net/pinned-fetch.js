/**
 * Pinned-IP fetch — closes the G3 TOCTOU (BR-B6, docs/network-policy.md §10).
 *
 * The problem: the network gate (createNetworkPolicyGate) resolves each
 * allowlisted target EXACTLY ONCE, validates every IP, and returns
 * `pinnedIps` with an explicit contract — the connecting client MUST dial one
 * of those IPs and must NOT re-resolve the name. A plain `fetch(url)` breaks
 * that contract: Node/undici re-resolve the hostname at socket-connect time,
 * so a DNS rebinding swap (attacker controls the zone, flips the A record
 * after the gate's check) lands the run's traffic on an unvalidated address.
 *
 * This module is the "future pinned HTTP dispatcher" the shared library was
 * written for:
 *   - an undici Agent whose `connect` hook dials ONLY the gate-validated IPs
 *     for the exact (scheme, host, port) — any other target is refused
 *     (fail closed, no socket, no DNS)
 *   - the original hostname is kept for SNI/`Host` (TLS works; no leakage of
 *     the IP as the virtual host)
 *   - redirect following is MANUAL and every hop is re-validated with the
 *     shared `assessRedirect` contract (fresh parse + allowlist + single
 *     resolve + all-IPs check + no https→http downgrade); each accepted hop
 *     extends the pin set with its validated IPs
 *   - pinned IPs are tried in order (all were validated, so failover is safe)
 *
 * Lifecycle: one fetcher per call site (the provider creates one per chat()
 * call), `destroy()` in a finally — no pool outlives the request context, so
 * abort semantics stay simple and nothing leaks.
 */
import net from 'node:net';
import tls from 'node:tls';

import { Agent, fetch as undiciFetch } from 'undici';
import { assessRedirect, normalizeHost } from '@water-army/shared';

const MAX_REDIRECT_HOPS = 5;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** Pinned-transport failure with a stable `code` (provider maps to ProviderError). */
export class PinnedFetchError extends Error {
  /**
   * @param {string} code OFF_PIN | PIN_DIAL_FAILED | PIN_CONNECT_TIMEOUT |
   *        ABORTED | NO_PINS | NO_POLICY | NO_RESOLVER | BAD_REDIRECT |
   *        REDIRECT_LOOP | (assessTarget/assessRedirect NETWORK_GATE_ERROR code)
   */
  constructor(code, message, { cause } = {}) {
    super(message);
    this.name = 'PinnedFetchError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function pinKey(scheme, host, port) {
  return `${scheme}|${host}|${port}`;
}

/** Walk an error chain (undici wraps connector errors) looking for our code. */
export function pinnedErrorFrom(err) {
  let e = err;
  for (let i = 0; i < 10 && e; i += 1) {
    if (e instanceof PinnedFetchError) return e;
    e = e.cause ?? null;
  }
  return null;
}

/**
 * @param {object} opts
 * @param {Array<{scheme:string, host:string, port:number, pinnedIps:string[]}>} opts.pins
 *        the gate-validated pin set (non-empty)
 * @param {{public:Array, internal:Array}} opts.entries parsed allowlist —
 *        required so redirect hops can be re-validated with the SAME policy
 * @param {(host:string) => Promise<string[]>} opts.resolve resolver for the
 *        redirect re-validation (single resolve per hop, same contract as
 *        the gate)
 * @param {number} [opts.connectTimeoutMs] per-IP dial timeout (default 10000)
 * @param {object} [opts.log]
 */
export function createPinnedFetch({ pins, entries, resolve, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS, log = console } = {}) {
  if (!Array.isArray(pins) || pins.length === 0) {
    throw new PinnedFetchError('NO_PINS', 'pinned fetch requires a non-empty gate pin set');
  }
  if (!entries || (!Array.isArray(entries.public) || !Array.isArray(entries.internal))) {
    throw new PinnedFetchError('NO_POLICY', 'pinned fetch requires the parsed policy entries (redirect re-validation)');
  }
  if (typeof resolve !== 'function') {
    throw new PinnedFetchError('NO_RESOLVER', 'pinned fetch requires the gate resolver (redirect re-validation)');
  }

  /** Mutable across redirect hops within one request; fresh per fetcher. */
  const pinMap = new Map();
  for (const p of pins) {
    const ips = Array.isArray(p.pinnedIps) ? p.pinnedIps.map(String) : [];
    if (!ips.length) throw new PinnedFetchError('NO_PINS', `pin for ${p.host}:${p.port} has no validated IPs`);
    pinMap.set(pinKey(p.scheme, normalizeHost(p.host), Number(p.port)), { host: normalizeHost(p.host), port: Number(p.port), scheme: p.scheme, ips });
  }
  const addHopPin = (v) => {
    const ips = v.pinnedIps.map(String);
    pinMap.set(pinKey(v.scheme, normalizeHost(v.host), Number(v.port)), { host: normalizeHost(v.host), port: Number(v.port), scheme: v.scheme, ips });
  };

  /**
   * Build the undici Agent. `connect(opts, cb)` is the dial hook: `opts`
   * carries the ORIGINAL hostname (never an IP) + effective port + protocol.
   * @param {AbortSignal} signal the request signal — aborts stop IP failover
   */
  function buildAgent(signal) {
    return new Agent({
      connect(opts, cb) {
        const isTLS = opts.protocol === 'https:';
        const port = Number(opts.port) || (isTLS ? 443 : 80);
        const pin = pinMap.get(pinKey(isTLS ? 'https' : 'http', normalizeHost(opts.hostname), port));
        if (!pin) {
          // FAIL CLOSED: a target the gate never validated is never dialed —
          // not even once, and no DNS query for it is issued.
          cb(new PinnedFetchError('OFF_PIN', `dial refused: ${opts.hostname}:${port} is not in the gate-validated pin set`));
          return;
        }
        let settled = false;
        let i = 0;
        const fail = (err) => { if (!settled) { settled = true; cb(err); } };
        const succeed = (socket) => { if (!settled) { settled = true; cb(null, socket); } };
        const tryNext = () => {
          if (settled) return;
          if (signal?.aborted) {
            return fail(new PinnedFetchError('ABORTED', 'request aborted during pinned dial'));
          }
          if (i >= pin.ips.length) {
            return fail(new PinnedFetchError('PIN_DIAL_FAILED', `all ${pin.ips.length} validated IP(s) for ${pin.host}:${pin.port} failed to connect`));
          }
          const ip = pin.ips[i];
          i += 1;
          let socket;
          try {
            socket = isTLS
              ? tls.connect({
                  host: ip,
                  port: pin.port,
                  servername: pin.host, // SNI = original hostname
                  rejectUnauthorized: true,
                  ALPNProtocols: ['http/1.1'], // HTTP/1.1 only — no h2 session on a hand-dialed socket
                })
              : net.connect({ host: ip, port: pin.port });
          } catch (err) {
            tryNext();
            return;
          }
          socket.setTimeout(connectTimeoutMs);
          socket.once('timeout', () => socket.destroy(new PinnedFetchError('PIN_CONNECT_TIMEOUT', `connect timeout to validated IP ${ip} for ${pin.host}:${pin.port}`)));
          socket.once('error', (err) => {
            socket.destroy();
            if (signal?.aborted) return fail(new PinnedFetchError('ABORTED', 'request aborted during pinned dial', { cause: err }));
            tryNext();
          });
          socket.once(isTLS ? 'secureConnect' : 'connect', () => {
            socket.setTimeout(0);
            try { socket.setKeepAlive(true, 60_000); } catch { /* socket already closing */ }
            succeed(socket);
          });
          // A close without connect/error (undici destroyed the socket on
          // abort) must settle too — never leave the callback dangling.
          socket.once('close', () => {
            if (settled) return;
            fail(new PinnedFetchError(signal?.aborted ? 'ABORTED' : 'PIN_DIAL_FAILED', signal?.aborted ? 'request aborted during pinned dial' : `socket closed during dial to ${pin.host}:${pin.port}`));
          });
        };
        tryNext();
      },
    });
  }

  /**
   * fetch-compatible, pinned + redirect-revalidated.
   * @param {string|URL} input
   * @param {object} [init] standard RequestInit (method/headers/body/signal)
   */
  async function pinnedFetch(input, init = {}) {
    let current = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url);
    const agent = buildAgent(init.signal);
    try {
      for (let hop = 0; ; hop += 1) {
        let res;
        try {
          res = await undiciFetch(current.href, { ...init, dispatcher: agent, redirect: 'manual' });
        } catch (err) {
          const pinned = pinnedErrorFrom(err);
          if (pinned) throw pinned;
          throw err; // transport error undici didn't tag (TIMEOUT etc.) — provider classifies
        }
        if (res.status < 300 || res.status > 399) return res;
        const loc = res.headers.get('location');
        if (!loc) {
          await res.body?.cancel().catch(() => {});
          throw new PinnedFetchError('BAD_REDIRECT', `redirect ${res.status} without a Location header`);
        }
        if (hop >= MAX_REDIRECT_HOPS) {
          await res.body?.cancel().catch(() => {});
          throw new PinnedFetchError('REDIRECT_LOOP', `more than ${MAX_REDIRECT_HOPS} redirect hops`);
        }
        let next;
        try {
          next = new URL(loc, current);
        } catch (err) {
          await res.body?.cancel().catch(() => {});
          throw new PinnedFetchError('BAD_REDIRECT', `unparseable Location header: ${loc.slice(0, 100)}`, { cause: err });
        }
        // PER-HOP re-validation — the same library contract the gate used for
        // hop 0: fresh parse, allowlist match, ONE resolve, every IP
        // classified, no protocol downgrade. A hop that fails validation is
        // never dialed.
        const v = await assessRedirect(current.href, next.href, { resolve, entries });
        if (!v.ok) {
          await res.body?.cancel().catch(() => {});
          log?.debug?.({ code: v.code, reason: v.reason }, 'pinned fetch: redirect hop rejected by policy');
          throw new PinnedFetchError(v.code, `redirect rejected: ${v.reason}`);
        }
        addHopPin(v);
        current = next;
      }
    } finally {
      // The request context is over (success, error, or abort) — close the
      // pool so no socket outlives the call. destroy() = no wait.
      agent.destroy(new Error('pinned fetch complete')).catch?.(() => {});
    }
  }

  return {
    fetch: pinnedFetch,
    /** Pin count after hop extensions (test/observability seam). */
    pinCount: () => pinMap.size,
  };
}
