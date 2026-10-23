/**
 * Unit tests — StreamClient (web) state machine + input accounting.
 *
 * Covers the ADR-020 degrade-meta handling (source/degraded/degradeReason
 * transitions on LIVE / degraded frames) and the inputSent/inputRejected
 * counters that back the P3 "input success rate" metric (老細 12:40 decision
 * item 3). Hermetic: no WebSocket, no network, no DOM — the constructor is
 * DOM-free and only the message/input paths are exercised.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamClient } from '../../apps/web/src/lib/stream-client.js';

function makeClient({ mode = 'controller' } = {}) {
  const states = [];
  const metas = [];
  const inputResults = [];
  const sent = [];
  const client = new StreamClient({
    deviceId: 'dev-test-0001',
    mode,
    canvas: { width: 0, height: 0, getContext: () => ({ drawImage() {} }) },
    onState: (s, info) => states.push({ s, info }),
    onMeta: (m) => metas.push({ ...m }),
    onInputResult: (r) => inputResults.push(r),
  });
  // fake open socket
  client.ws = { readyState: 1, send: (s) => sent.push(s) };
  return { client, states, metas, inputResults, sent };
}

function goLive(client, { source = 'screencap', degraded = false } = {}) {
  client._onText({ t: 'state', state: 'LIVE', source, degraded, width: 720, height: 1280 });
}

test('fresh LIVE screencap (configured default) records default mode, not a degradation', () => {
  const { client } = makeClient({ mode: 'controller' });
  goLive(client);
  assert.equal(client.state, 'LIVE_CONTROLLED_BY_YOU');
  assert.equal(client.stats.source, 'screencap');
  assert.equal(client.stats.degraded, false);
  assert.match(client.stats.degradeReason, /default mode/);
});

test('degraded frame flips stats.degraded and sets the reason (ADR-020 req 6)', () => {
  const { client } = makeClient();
  goLive(client, { source: 'scrcpy', degraded: false });
  assert.equal(client.stats.degraded, false);
  client._onText({ t: 'degraded', reason: 'h264 encoder stalled (no frames 15s)' });
  assert.equal(client.stats.degraded, true);
  assert.equal(client.stats.source, 'screencap');
  assert.equal(client.stats.degradeReason, 'h264 encoder stalled (no frames 15s)');
  // control survives degradation
  assert.equal(client.state, 'LIVE_CONTROLLED_BY_YOU');
});

test('fresh LIVE scrcpy (non-degraded) clears a stale degrade reason', () => {
  const { client } = makeClient();
  client._onText({ t: 'degraded', reason: 'boom' });
  assert.equal(client.stats.degraded, true);
  goLive(client, { source: 'scrcpy', degraded: false });
  assert.equal(client.stats.degraded, false);
  assert.equal(client.stats.degradeReason, null);
  assert.equal(client.state, 'LIVE_CONTROLLED_BY_YOU');
});

test('viewer LIVE is read-only even before input() is called', () => {
  const { client } = makeClient({ mode: 'viewer' });
  goLive(client);
  assert.equal(client.state, 'LIVE_READ_ONLY');
});

test('input() before LIVE → STREAM_NOT_LIVE + rejected counted', () => {
  const { client, inputResults, sent } = makeClient();
  client.input({ kind: 'tap', x: 1, y: 2 });
  assert.equal(client.stats.inputSent, 0);
  assert.equal(client.stats.inputRejected, 1);
  assert.equal(inputResults[0].code, 'STREAM_NOT_LIVE');
  assert.equal(sent.length, 0);
});

test('input() in read-only mode → STREAM_READ_ONLY, nothing sent', () => {
  const { client, inputResults, sent } = makeClient({ mode: 'viewer' });
  goLive(client);
  client.input({ kind: 'tap', x: 1, y: 2 });
  assert.equal(client.stats.inputRejected, 1);
  assert.equal(inputResults[0].code, 'STREAM_READ_ONLY');
  assert.equal(sent.length, 0);
});

test('controller LIVE input() → sent exactly once + inputSent counted', () => {
  const { client, sent } = makeClient();
  goLive(client);
  client.input({ kind: 'tap', x: 10, y: 20 });
  assert.equal(client.stats.inputSent, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /"t":"input"/);
});

test('device-side input-rejected increments inputRejected and notifies', () => {
  const { client, inputResults } = makeClient();
  goLive(client);
  client._onText({ t: 'input-rejected', code: 'ADB_TIMEOUT', message: 'adb' });
  assert.equal(client.stats.inputRejected, 1);
  assert.equal(inputResults[0].code, 'ADB_TIMEOUT');
});

test('inputBlocked (tab hidden) → STREAM_INPUT_BLOCKED, no ws traffic', () => {
  const { client, inputResults, sent } = makeClient();
  goLive(client);
  client.inputBlocked = true;
  client.input({ kind: 'tap', x: 1, y: 2 });
  assert.equal(client.stats.inputRejected, 1);
  assert.equal(client.stats.inputSent, 0);
  assert.equal(inputResults[0].code, 'STREAM_INPUT_BLOCKED');
  assert.equal(sent.length, 0);
});

test('input success rate = inputSent / (inputSent + local rejections) stays ≥ 0', () => {
  const { client } = makeClient();
  // mix: 2 sent, 1 not-live rejection, 1 device rejection, 1 blocked
  client.input({ kind: 'tap', x: 1, y: 2 }); // not live
  goLive(client);
  client.input({ kind: 'tap', x: 1, y: 2 }); // sent
  client._onText({ t: 'input-rejected', code: 'ADB_TIMEOUT', message: 'adb' });
  client.input({ kind: 'tap', x: 1, y: 2 }); // sent
  client.inputBlocked = true;
  client.input({ kind: 'tap', x: 1, y: 2 }); // blocked
  assert.equal(client.stats.inputSent, 2);
  assert.equal(client.stats.inputRejected, 3);
});

// ---- wsPath contract (P2 E2E finding) ------------------------------------------
// The acquire/reconnect response carries streamWsPath at TOP LEVEL
// ({lease, ticket, streamWsPath, usage}). The old client read
// lease.streamWsPath (undefined) → new WebSocket('ws://hostundefined')
// threw a SyntaxError that start()'s caller swallowed → banner stuck
// CONNECTING, zero WS traffic on the wire.

test('wsUrl() builds from the top-level wsPath field', () => {
  globalThis.window = { location: { protocol: 'http:', host: '127.0.0.1:16492' } };
  const { client } = makeClient();
  client.wsPath = '/api/device-streams/lease-123/ws';
  assert.equal(client.wsUrl(), 'ws://127.0.0.1:16492/api/device-streams/lease-123/ws');
  delete globalThis.window;
});

test('wsUrl() uses wss under https origins', () => {
  globalThis.window = { location: { protocol: 'https:', host: 'console.example' } };
  const { client } = makeClient();
  client.wsPath = '/api/device-streams/lease-123/ws';
  assert.equal(client.wsUrl(), 'wss://console.example/api/device-streams/lease-123/ws');
  delete globalThis.window;
});

test('_openWs() without wsPath → ERROR state, no WebSocket constructed', () => {
  const constructed = [];
  globalThis.WebSocket = class {
    constructor(url) { constructed.push(url); }
  };
  const { client, states } = makeClient();
  client._openWs();
  assert.equal(constructed.length, 0);
  assert.equal(states.at(-1).s, 'ERROR');
  assert.match(states.at(-1).info.error.message, /streamWsPath/);
  delete globalThis.WebSocket;
});

test('_openWs() catches a throwing WebSocket constructor → ERROR, no crash', () => {
  // simulates the original bug: malformed URL (hostundefined) makes the
  // browser WebSocket constructor throw a SyntaxError
  globalThis.WebSocket = class {
    constructor(url) {
      if (url.includes('undefined')) throw new SyntaxError(`Invalid URL: ${url}`);
    }
  };
  const { client, states } = makeClient();
  client.wsPath = 'undefined';
  globalThis.window = { location: { protocol: 'http:', host: '127.0.0.1:16492' } };
  client._openWs();
  delete globalThis.window;
  assert.equal(states.at(-1).s, 'ERROR');
  assert.match(states.at(-1).info.note, /WebSocket construction failed/);
  delete globalThis.WebSocket;
});
