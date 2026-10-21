/**
 * BR-B6 G2 — dedicated device network (apps/api/src/services/device-network.js).
 *
 * Hermetic: pure CIDR math + fake dockerode (no engine, no real network).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cidrGateway,
  deviceNetwork,
  deviceNetworkCreateBody,
  ensureDeviceNetwork,
  GOST_HOST_BIND,
  withDeviceNetwork,
} from '../../apps/api/src/services/device-network.js';
import { makeFakeDockerClient } from '../helpers/fake-docker-client.js';

// ------------------------------------------------------------ cidrGateway ---
test('cidrGateway: first usable address of the subnet (the bridge gateway)', () => {
  assert.equal(cidrGateway('172.38.200.0/24'), '172.38.200.1');
  assert.equal(cidrGateway('172.38.100.0/24'), '172.38.100.1');
  assert.equal(cidrGateway('10.0.0.0/16'), '10.0.0.1');
  assert.equal(cidrGateway('192.168.10.0/30'), '192.168.10.1');
  assert.equal(cidrGateway(' 172.38.200.0/24 '), '172.38.200.1'); // trim
});

test('cidrGateway: rejects malformed / out-of-band input (fail closed)', () => {
  assert.equal(cidrGateway('172.38.200.0'), null); // no prefix
  assert.equal(cidrGateway('172.38.200.0/31'), null); // too small for our use
  assert.equal(cidrGateway('172.38.200.0/33'), null);
  assert.equal(cidrGateway('300.38.200.0/24'), null);
  assert.equal(cidrGateway('172.38.200.256/24'), null);
  assert.equal(cidrGateway('172.38/24'), null);
  assert.equal(cidrGateway(''), null);
  assert.equal(cidrGateway(null), null);
});

test('default device network contract: dedicated bridge, clear of existing subnets', () => {
  assert.equal(deviceNetwork.name, 'water-army-devices');
  assert.equal(deviceNetwork.subnet, '172.38.200.0/24');
  assert.equal(deviceNetwork.gateway, '172.38.200.1');
  assert.equal(GOST_HOST_BIND, '172.38.200.1'); // the gost bind FOLLOWS the network
  // never collides with the docker defaults / platform net / LAN (live-checked
  // on the build host 2026-10-22: 172.17/16/18, 172.38.100, 192.168.31)
  assert.ok(!['172.17', '172.18', '172.16'].some((p) => deviceNetwork.subnet.startsWith(p)));
  assert.ok(!deviceNetwork.subnet.startsWith('172.38.100'));
});

test('deviceNetworkCreateBody: pinned bridge body (no internal, explicit IPAM)', () => {
  const body = deviceNetworkCreateBody();
  assert.equal(body.Name, 'water-army-devices');
  assert.equal(body.Driver, 'bridge');
  assert.equal(body.Internal, false); // devices need egress (governed by the B4 policy gate)
  assert.deepEqual(body.IPAM.Config, [{ Subnet: '172.38.200.0/24', Gateway: '172.38.200.1' }]);
  assert.equal(body.Labels['app.managed'], 'true');
});

// ------------------------------------------------------- withDeviceNetwork ---
test('withDeviceNetwork: removes NetworkMode, adds the explicit endpoint', () => {
  const { body } = withDeviceNetwork({
    hostConfig: { NetworkMode: 'bridge', PortBindings: { '5555/tcp': [{ HostIp: '127.0.0.1', HostPort: '16380' }] } },
  });
  assert.equal(body.HostConfig.NetworkMode, undefined);
  assert.deepEqual(body.HostConfig.PortBindings, { '5555/tcp': [{ HostIp: '127.0.0.1', HostPort: '16380' }] });
  assert.deepEqual(body.NetworkingConfig, { EndpointsConfig: { 'water-army-devices': {} } });
  // caller object untouched (new object, not a mutation)
});

// ------------------------------------------------------------ ensure ---------
test('ensureDeviceNetwork: creates the network when missing (idempotent second call)', async () => {
  const c = makeFakeDockerClient(); // seed has no water-army-devices
  const name1 = await ensureDeviceNetwork(c);
  assert.equal(name1, 'water-army-devices');
  assert.ok(c.__calls.some((x) => x.method === 'createNetwork'));
  const before = c.__calls.filter((x) => x.method === 'createNetwork').length;
  const name2 = await ensureDeviceNetwork(c); // second call: inspect hit, no create
  assert.equal(name2, 'water-army-devices');
  assert.equal(c.__calls.filter((x) => x.method === 'createNetwork').length, before);
});

test('ensureDeviceNetwork: refuses a foreign non-bridge network with the same name (fail closed)', async () => {
  const c = makeFakeDockerClient();
  c.__registerNetwork({ Name: 'water-army-devices', Driver: 'overlay' });
  await assert.rejects(ensureDeviceNetwork(c), /driver 'overlay'/);
});

test('ensureDeviceNetwork: refuses subnet drift (a hand-migrated network) (fail closed)', async () => {
  const c = makeFakeDockerClient();
  c.__registerNetwork({ Name: 'water-army-devices', Driver: 'bridge', IPAM: { Config: [{ Subnet: '10.66.0.0/16', Gateway: '10.66.0.1' }] } });
  await assert.rejects(ensureDeviceNetwork(c), /subnet 10\.66\.0\.0\/16 != expected/);
});

test('ensureDeviceNetwork: propagates real engine errors (does not guess "missing")', async () => {
  const c = makeFakeDockerClient({ mode: 'daemon-down' });
  await assert.rejects(ensureDeviceNetwork(c), /ECONNREFUSED/);
});
