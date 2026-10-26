/**
 * W3 (ADR-027) — worker projection of the egress axis in
 * redroid.get_device_status. The worker sees WHY the dispatch gate is
 * BLOCKED (net vs egress) without ever seeing a proxy URL/credential.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createToolHandlers } from '../../apps/worker/src/tool-helpers.js';

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function makeHandlers(device) {
  const api = {
    redroidDeviceStatus: async () => ({ device }),
  };
  return createToolHandlers({ api, log: silentLog });
}

test('W3 worker projection: VERIFIED device → egress surfaced, dispatch ALLOWED', async () => {
  const h = makeHandlers({
    id: 'd1', name: 'redroid-w3-x', containerState: 'running', adbState: 'device',
    proxy: {
      network: {
        state: 'HEALTHY', stale: false, checkedAt: 't', lastSuccessAt: 't',
        consecutiveFailures: 0, lastError: null, checks: null, networkReady: true,
      },
    },
    egress: { state: 'VERIFIED', stale: false, ready: true, lastObservedIp: '203.0.113.10', lastErrorCode: null },
  });
  const r = await h['redroid.get_device_status']({ device: 'd1' });
  assert.equal(r.ok, true);
  assert.equal(r.result.network.dispatch, 'ALLOWED');
  assert.deepEqual(r.result.egress, {
    state: 'VERIFIED', stale: false, ready: true, lastObservedIp: '203.0.113.10', lastErrorCode: null,
  });
});

test('W3 worker projection: DRIFTED → dispatch BLOCKED with the egress reason (IP is egress metadata, not a secret)', async () => {
  const h = makeHandlers({
    id: 'd2', name: 'redroid-w3-y', containerState: 'running', adbState: 'device',
    proxy: {
      network: {
        state: 'HEALTHY', stale: false, checkedAt: 't', lastSuccessAt: 't',
        consecutiveFailures: 0, lastError: null, checks: null, networkReady: false,
      },
    },
    egress: { state: 'DRIFTED', stale: false, ready: false, lastObservedIp: '203.0.113.99', lastErrorCode: 'EGRESS_IP_DRIFT' },
  });
  const r = await h['redroid.get_device_status']({ device: 'd2' });
  assert.equal(r.result.network.dispatch, 'BLOCKED');
  assert.equal(r.result.network.state, 'HEALTHY', 'net axis is fine — the gate is blocked by EGRESS');
  assert.equal(r.result.egress.state, 'DRIFTED');
  assert.equal(r.result.egress.lastObservedIp, '203.0.113.99');
});

test('W3 worker projection: switch off → egress is null (byte-inert, pre-W3 shape)', async () => {
  const h = makeHandlers({
    id: 'd3', name: 'redroid-w3-z', containerState: 'running', adbState: 'device',
    proxy: {
      network: {
        state: 'HEALTHY', stale: false, checkedAt: 't', lastSuccessAt: 't',
        consecutiveFailures: 0, lastError: null, checks: null, networkReady: true,
      },
    },
    egress: null,
  });
  const r = await h['redroid.get_device_status']({ device: 'd3' });
  assert.equal(r.result.egress, null);
  assert.equal(r.result.network.dispatch, 'ALLOWED');
});

test('W3 worker projection: NO_PROXY / UNBOUND states pass through explicitly', async () => {
  for (const state of ['NO_PROXY', 'UNBOUND', 'UNREACHABLE', 'UNCHECKED']) {
    const h = makeHandlers({
      id: 'd4', name: 'redroid-w3-w', containerState: 'running', adbState: 'device',
      proxy: {
        network: {
          state: 'HEALTHY', stale: false, checkedAt: 't', lastSuccessAt: 't',
          consecutiveFailures: 0, lastError: null, checks: null, networkReady: false,
        },
      },
      egress: { state, stale: false, ready: false, lastObservedIp: null, lastErrorCode: null },
    });
    const r = await h['redroid.get_device_status']({ device: 'd4' });
    assert.equal(r.result.egress.state, state);
    assert.equal(r.result.network.dispatch, 'BLOCKED', `${state} is never dispatch-ready`);
  }
});
