/**
 * BR-B6 G3 — pinned-IP transport (apps/worker/src/net/pinned-fetch.js).
 *
 * Hermetic against a REAL local HTTP server on 127.0.0.1 (ephemeral ports) —
 * the point of this suite is the actual dial: the socket must land on the
 * gate-validated IP with the ORIGINAL hostname as Host/SNI, and it must never
 * re-resolve or dial an off-pin target.
 *
 * The allowlist uses INTERNAL-zone entries (loopback is a legal internal
 * address; public-zone entries require public IPs, which this host is not).
 */
import test from 'node:test';
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  parseAllowlist,
  assessTarget,
} from '../../packages/shared/src/network-policy.js';
import { NETWORK_GATE_ERROR } from '../../packages/shared/src/batch-constants.js';
import {
  createPinnedFetch,
  PinnedFetchError,
  pinnedErrorFrom,
} from '../../apps/worker/src/net/pinned-fetch.js';
import { createOpenAICompatibleProvider } from '../../apps/worker/src/providers/openai-compatible.js';
import { PROVIDER_ERROR } from '../../packages/shared/src/index.js';

/** @returns {Promise<{server: import('node:http').Server, port: number, requests: object[]}>} */
function startServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, host: req.headers.host ?? null });
    handler(req, res, () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

/**
 * Build gate-shaped pins for a host:port pair via the REAL assessTarget
 * (single resolve, all-IPs classified) — the same object the gate verdict
 * now carries.
 */
async function makePins({ host, port, extraEntries = [], resolver }) {
  const entries = parseAllowlist([`http://${host}:${port}`, ...extraEntries], 'test');
  assert.equal(entries.ok, true);
  const v = await assessTarget(`http://${host}:${port}`, {
    resolve: resolver ?? (async (h) => (h === host ? ['127.0.0.1'] : [])),
    entries: { public: [], internal: entries.entries },
  });
  assert.equal(v.ok, true, v.reason);
  return {
    pins: [{ name: 'provider:test', url: `http://${host}:${port}`, scheme: v.scheme, host: v.host, port: v.port, zone: v.zone, pinnedIps: v.pinnedIps }],
    entries: { public: [], internal: entries.entries },
    resolve: resolver ?? (async (h) => (h === host ? ['127.0.0.1'] : [])),
  };
}

const quietLog = { debug() {}, warn() {}, info() {}, error() {} };

/** File-level server registry — closed once, after every test. */
const _servers = [];
after(() => Promise.all(_servers.map((s) => new Promise((r) => s.close(r)))));
function track(server) { _servers.push(server); }

test('g3: happy path — dials the validated IP, original hostname as Host header', async () => {
  const { server, port, requests } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  track(server);
  const net = await makePins({ host: 'qa.internal', port });
  const { fetch } = createPinnedFetch({ ...net, log: quietLog });
  const res = await fetch(`http://qa.internal:${port}/ping`);
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].host, `qa.internal:${port}`, 'Host header = original hostname, not the IP');
  assert.equal(requests[0].url, '/ping');
});

test('g3 TOCTOU: DNS flip AFTER the pin is computed cannot move the dial', async () => {
  const { server, port, requests } = await startServer((req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  track(server);
  // The gate resolved qa.internal → 127.0.0.1 and pinned it.
  const goodResolve = async (h) => (h === 'qa.internal' ? ['127.0.0.1'] : []);
  const entries = parseAllowlist([`http://qa.internal:${port}`], 'test');
  const v = await assessTarget(`http://qa.internal:${port}`, { resolve: goodResolve, entries: { public: [], internal: entries.entries } });
  assert.equal(v.ok, true);
  // The attacker flips the zone AFTER the gate (rebinding). If the transport
  // re-resolved, this fetch would dial 10.99.99.99 and fail (or worse, hit
  // the attacker). The pinned transport must ignore the new record.
  const evilResolve = async () => ['10.99.99.99'];
  const { fetch } = createPinnedFetch({
    pins: [{ name: 'provider:test', url: `http://qa.internal:${port}`, scheme: v.scheme, host: v.host, port: v.port, zone: v.zone, pinnedIps: v.pinnedIps }],
    entries: { public: [], internal: entries.entries },
    resolve: evilResolve, // a re-resolving transport would see THIS
    log: quietLog,
  });
  const res = await fetch(`http://qa.internal:${port}/`);
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(requests.length, 1, 'the request landed on the pinned local server');
});

test('g3: off-pin target is refused — no socket, no DNS (NXDOMAIN host proves no lookup)', async () => {
  const { server, port, requests } = await startServer(() => {});
  track(server);
  const net = await makePins({ host: 'qa.internal', port });
  const { fetch } = createPinnedFetch({ ...net, log: quietLog });
  // evil.example is NXDOMAIN: a re-resolving transport would fail with
  // ENOTFOUND; the pinned transport must fail FIRST with OFF_PIN.
  await assert.rejects(
    () => fetch('http://evil.example/ping'),
    (e) => e instanceof PinnedFetchError && e.code === 'OFF_PIN',
  );
  assert.equal(requests.length, 0, 'no request reached the server');
});

test('g3: redirect hop is re-validated and pinned; the second server gets the original hostname', async () => {
  const b = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"hop":2}');
  });
  const a = await startServer((req, res) => {
    res.writeHead(302, { location: `http://qa2.internal:${b.port}/two` });
    res.end('');
  });
  track(a.server);
  track(b.server);
  const entries = parseAllowlist([`http://qa.internal:${a.port}`, `http://qa2.internal:${b.port}`], 'test');
  const resolve = async (h) =>
    h === 'qa.internal' ? ['127.0.0.1'] : h === 'qa2.internal' ? ['127.0.0.1'] : [];
  const v1 = await assessTarget(`http://qa.internal:${a.port}`, { resolve, entries: { public: [], internal: entries.entries } });
  assert.equal(v1.ok, true);
  const { fetch, pinCount } = createPinnedFetch({
    pins: [{ name: 'provider:test', url: `http://qa.internal:${a.port}`, scheme: v1.scheme, host: v1.host, port: v1.port, zone: v1.zone, pinnedIps: v1.pinnedIps }],
    entries: { public: [], internal: entries.entries },
    resolve,
    log: quietLog,
  });
  assert.equal(pinCount(), 1);
  const res = await fetch(`http://qa.internal:${a.port}/one`);
  assert.equal(res.status, 200);
  const body = JSON.parse(await res.text());
  assert.equal(body.hop, 2);
  assert.equal(b.requests.length, 1);
  assert.equal(b.requests[0].host, `qa2.internal:${b.port}`, 'hop 2 Host header = original hostname');
  assert.equal(pinCount(), 2, 'the accepted hop extended the pin set');
});

test('g3: redirect to a NON-allowlisted host is rejected before any dial', async () => {
  const a = await startServer((req, res) => {
    res.writeHead(302, { location: 'http://evil.example/steal' });
    res.end('');
  });
  track(a.server);
  const net = await makePins({ host: 'qa.internal', port: a.port });
  const { fetch } = createPinnedFetch({ ...net, log: quietLog });
  await assert.rejects(
    () => fetch(`http://qa.internal:${a.port}/x`),
    (e) => e instanceof PinnedFetchError && e.code === NETWORK_GATE_ERROR.TARGET_DENIED,
  );
});

test('g3: redirect loop > max hops → REDIRECT_LOOP', async () => {
  let other = null;
  const a = await startServer((req, res) => {
    res.writeHead(302, { location: `http://qa.internal:${other}/ping` });
    res.end('');
  });
  other = a.port;
  const b = await startServer((req, res) => {
    res.writeHead(302, { location: `http://qa.internal:${a.port}/pong` });
    res.end('');
  });
  track(a.server);
  track(b.server);
  // Two hosts on ONE server? No — the redirect ping-pongs between
  // qa.internal:a.port and qa.internal:b.port (same hostname, two ports —
  // each is a distinct allowlisted target).
  const entries = parseAllowlist([`http://qa.internal:${a.port}`, `http://qa.internal:${b.port}`], 'test');
  const resolve = async () => ['127.0.0.1'];
  const v = await assessTarget(`http://qa.internal:${a.port}`, { resolve, entries: { public: [], internal: entries.entries } });
  assert.equal(v.ok, true);
  const { fetch } = createPinnedFetch({
    pins: [{ name: 'provider:test', url: `http://qa.internal:${a.port}`, scheme: v.scheme, host: v.host, port: v.port, zone: v.zone, pinnedIps: v.pinnedIps }],
    entries: { public: [], internal: entries.entries },
    resolve,
    log: quietLog,
  });
  await assert.rejects(
    () => fetch(`http://qa.internal:${a.port}/start`),
    (e) => e instanceof PinnedFetchError && e.code === 'REDIRECT_LOOP',
  );
});

test('g3: 302 without Location → BAD_REDIRECT', async () => {
  const a = await startServer((req, res) => {
    res.writeHead(302);
    res.end('');
  });
  track(a.server);
  const net = await makePins({ host: 'qa.internal', port: a.port });
  const { fetch } = createPinnedFetch({ ...net, log: quietLog });
  await assert.rejects(
    () => fetch(`http://qa.internal:${a.port}/x`),
    (e) => e instanceof PinnedFetchError && e.code === 'BAD_REDIRECT',
  );
});

test('g3: pinned-IP failover — first validated IP dead, second delivers', async () => {
  const { server, port, requests } = await startServer((req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  track(server);
  const entries = parseAllowlist([`http://qa.internal:${port}`], 'test');
  const resolve = async () => ['127.0.0.1'];
  const v = await assessTarget(`http://qa.internal:${port}`, { resolve, entries: { public: [], internal: entries.entries } });
  assert.equal(v.ok, true);
  const { fetch } = createPinnedFetch({
    // Gate-validated set with a dead first IP (TEST-NET-1, unroutable):
    // failover to 127.0.0.1 must succeed — every dial is still pin-validated.
    pins: [{ name: 'provider:test', url: `http://qa.internal:${port}`, scheme: v.scheme, host: v.host, port: v.port, zone: v.zone, pinnedIps: ['192.0.2.1', '127.0.0.1'] }],
    entries: { public: [], internal: entries.entries },
    resolve,
    connectTimeoutMs: 800,
    log: quietLog,
  });
  const res = await fetch(`http://qa.internal:${port}/`);
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(requests.length, 1);
});

test('g3: all validated IPs dead → PIN_DIAL_FAILED (surfaced as-is)', async () => {
  const net = await makePins({ host: 'qa.internal', port: 12399 }); // nothing listens at 127.0.0.1:12399
  const { fetch } = createPinnedFetch({
    pins: net.pins.map((p) => ({ ...p, pinnedIps: ['192.0.2.1'] })),
    entries: net.entries,
    resolve: net.resolve,
    connectTimeoutMs: 500,
    log: quietLog,
  });
  await assert.rejects(
    () => fetch(`http://qa.internal:${12399}/`),
    (e) => {
      const pinned = e instanceof PinnedFetchError ? e : pinnedErrorFrom(e);
      assert.ok(pinned, `expected PinnedFetchError, got ${e?.name}: ${e?.message}`);
      assert.ok(['PIN_DIAL_FAILED', 'PIN_CONNECT_TIMEOUT'].includes(pinned.code), pinned.code);
      return true;
    },
  );
});

test('g3: constructor fail-closed guards (no pins / no policy / no resolver)', () => {
  assert.throws(() => createPinnedFetch({ pins: [], entries: { public: [], internal: [] }, resolve: async () => [] }), (e) => e instanceof PinnedFetchError && e.code === 'NO_PINS');
  assert.throws(() => createPinnedFetch({ pins: [{ scheme: 'http', host: 'h', port: 1, pinnedIps: ['127.0.0.1'] }], entries: null, resolve: async () => [] }), (e) => e.code === 'NO_POLICY');
  assert.throws(() => createPinnedFetch({ pins: [{ scheme: 'http', host: 'h', port: 1, pinnedIps: ['127.0.0.1'] }], entries: { public: [], internal: [] }, resolve: null }), (e) => e.code === 'NO_RESOLVER');
});

// ---------------------------------------------------------------------------
// Provider integration: the gate verdict's pins flow through chat() and the
// REAL undici dial reaches the local model server.
// ---------------------------------------------------------------------------

const chatOk = {
  id: 'chatcmpl-p',
  model: 'local',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pinned-ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

test('g3 provider: chat() with gate pins dials the pinned IP (real socket)', async () => {
  const { server, port, requests } = await startServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer sk-pinned-test');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(chatOk));
  });
  track(server);
  const net = await makePins({ host: 'model.internal', port });
  const provider = createOpenAICompatibleProvider({
    baseUrl: `http://model.internal:${port}/v1`,
    apiKey: 'sk-pinned-test',
    model: 'local',
    baseDelayMs: 1,
    maxDelayMs: 2,
    log: quietLog,
  });
  const res = await provider.chat({
    messages: [{ role: 'user', content: 'hi' }],
    net: { pins: net.pins, entries: net.entries, resolve: net.resolve },
  });
  assert.equal(res.content, 'pinned-ok');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].host, `model.internal:${port}`);
  assert.equal(requests[0].url, '/v1/chat/completions');
});

test('g3 provider: pins present but baseUrl NOT in the pin set → NETWORK_POLICY, never retried, never falls back to unpinned fetch', async () => {
  const { server, port, requests } = await startServer((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify(chatOk));
  });
  track(server);
  const net = await makePins({ host: 'model.internal', port });
  // The provider targets a DIFFERENT host than the pins cover (a misconfig or
  // a swapped provider row). The pinned transport must refuse the dial.
  const provider = createOpenAICompatibleProvider({
    baseUrl: `http://other-host.internal:${port}/v1`,
    apiKey: 'sk-pinned-test',
    model: 'local',
    maxRetries: 3, // would mask a policy failure as "retried transient"
    baseDelayMs: 1,
    maxDelayMs: 2,
    log: quietLog,
  });
  await assert.rejects(
    () => provider.chat({ messages: [], net: { pins: net.pins, entries: net.entries, resolve: net.resolve } }),
    (e) => e.apiCode === PROVIDER_ERROR.NETWORK_POLICY,
  );
  assert.equal(requests.length, 0, 'off-pin dial never reached the server');
});

test('g3 provider: malformed pin set is a hard NETWORK_POLICY (never a silent fallback to unpinned fetch)', async () => {
  const { server, port, requests } = await startServer((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify(chatOk));
  });
  track(server);
  const provider = createOpenAICompatibleProvider({
    baseUrl: `http://model.internal:${port}/v1`,
    apiKey: 'sk-pinned-test',
    model: 'local',
    log: quietLog,
  });
  await assert.rejects(
    () => provider.chat({ messages: [], net: { pins: [{ scheme: 'http', host: 'model.internal', port, pinnedIps: [] }], entries: null, resolve: null } }),
    (e) => e.apiCode === PROVIDER_ERROR.NETWORK_POLICY,
  );
  assert.equal(requests.length, 0);
});
