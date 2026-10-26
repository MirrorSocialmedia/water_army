/**
 * NV5b(c) unit tests — StreamClient reconnect honours Retry-After (老細
 * 2026-10-26 拍板: 「429 有 RA 就跟 RA，等多過等死；無 RA 先落既有 backoff」).
 *
 * The gen9 storm killed streams because the 4-step ladder (~15s) died inside
 * the limiter's ~48s Retry-After window. These tests pin the new behaviour:
 *   - 429 + Retry-After → wait RA(+jitter), do NOT consume a ladder step;
 *   - 429 without Retry-After → legacy ladder;
 *   - pathological limiter → capped (RATE_LIMIT_MAX_WAITS) → ERROR, not forever.
 * Hermetic: api.post is stubbed, timers are fast-forwarded via a
 * _scheduleReconnect override; no WebSocket, no DOM (constructor is DOM-free).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { StreamClient } from '../../apps/web/src/lib/stream-client.js';
import { api, ApiError } from '../../apps/web/src/api/client.js';

const LEASE = { id: 'lease-1', version: 1 };

function makeReconnectClient() {
  const client = new StreamClient({
    deviceId: 'dev-x',
    mode: 'controller',
    canvas: { width: 0, height: 0, getContext: () => ({ drawImage() {} }) },
  });
  client.lease = { ...LEASE };
  client.wsPath = '/api/device-streams/lease-1/ws';
  client._openWs = () => { client._opened = (client._opened ?? 0) + 1; };
  // Fast-forward scheduling but expose the delay the client asked for.
  const delays = [];
  const orig = client._scheduleReconnect.bind(client);
  client._scheduleReconnect = (delayMs) => {
    delays.push(delayMs);
    orig(Math.min(delayMs, 10));
  };
  return { client, delays };
}

const err429 = (retryAfterMs) => new ApiError({ status: 429, code: 'RATE_LIMITED', message: 'Too many stream requests', requestId: null, retryAfterMs });

test('429 with Retry-After → waits RA + jitter, does NOT burn the backoff ladder, then succeeds', async () => {
  const { client, delays } = makeReconnectClient();
  const origPost = api.post;
  const states = [];
  client.onState = (s, info) => states.push({ s, info });
  let calls = 0;
  api.post = async () => {
    calls += 1;
    if (calls === 1) throw err429(40_000); // RA 40s — the storm window
    return { lease: { ...LEASE, version: 2 }, streamWsPath: client.wsPath };
  };
  try {
    client._tryReconnect();
    // wait for the (fast-forwarded) chain to settle
    for (let i = 0; i < 100 && calls < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls, 2, 'retried after the Retry-After window');
    assert.ok(delays.includes(40_000 + 500), `asked to wait RA+jitter, got ${JSON.stringify(delays)}`);
    assert.equal(client.reconnectAttempt, 0, 'ladder untouched by rate-limit waits');
    assert.equal(client.rateLimitWaits, 0, 'success resets the rate-limit counter');
    assert.equal(client._opened, 1, 'WS reopened after successful reconnect');
    assert.ok(states.some((x) => x.s === 'RECONNECTING' && x.info?.rateLimited === true), 'UI informed about rate-limited wait');
  } finally {
    api.post = origPost;
  }
});

test('429 WITHOUT Retry-After → legacy backoff ladder (attempt consumed)', async () => {
  const { client, delays } = makeReconnectClient();
  const origPost = api.post;
  let calls = 0;
  api.post = async () => {
    calls += 1;
    if (calls === 1) throw err429(null); // no RA header
    return { lease: { ...LEASE, version: 2 }, streamWsPath: client.wsPath };
  };
  try {
    client._tryReconnect();
    for (let i = 0; i < 100 && calls < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls, 2);
    assert.equal(delays[0], 1000, 'first ladder step used (no RA)');
    assert.equal(client._opened, 1);
  } finally {
    api.post = origPost;
  }
});

test('pathological limiter: RA waits are capped (RATE_LIMIT_MAX_WAITS) → ERROR, never infinite', async () => {
  const { client } = makeReconnectClient();
  const origPost = api.post;
  let calls = 0;
  api.post = async () => {
    calls += 1;
    throw err429(10); // always rate limited, tiny RA
  };
  try {
    client._tryReconnect();
    for (let i = 0; i < 200 && client.state !== 'ERROR'; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(client.state, 'ERROR');
    assert.equal(calls, 6, 'initial attempt + 5 capped rate-limit retries (5 waits max)');
  } finally {
    api.post = origPost;
  }
});

test('non-429 errors still walk the ladder to exhaustion (existing behaviour intact)', async () => {
  const { client } = makeReconnectClient();
  const origPost = api.post;
  let calls = 0;
  api.post = async () => {
    calls += 1;
    throw new ApiError({ status: 500, code: 'INTERNAL', message: 'boom', requestId: null, retryAfterMs: 30_000 });
  };
  try {
    client._tryReconnect();
    for (let i = 0; i < 300 && client.state !== 'ERROR'; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(client.state, 'ERROR', 'ladder exhausted → ERROR (RA ignored for non-429)');
    assert.equal(calls, 4, 'ladder = [1000,2000,4000,8000] → 4 attempts then ERROR');
  } finally {
    api.post = origPost;
  }
});
