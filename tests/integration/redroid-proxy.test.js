/**
 * Stage B (2026-10-19) — per-device egress proxy (gost + tun2socks) tests.
 *
 * Coverage:
 *  - pure builders (gost container body, tunnel scripts, URL parsing) —
 *    exact-shape assertions incl. the digest-pinned image, 172.17.0.1 bind,
 *    empty Env, and the verified netd table-100 `onlink` route
 *  - template proxy CRUD: encrypted at rest (ciphertext in DB, never
 *    plaintext), masked in views, null-clear on patch
 *  - device create: gost container created+started with the EXACT body,
 *    tunnel provisioned in the background (exec seam recorded), proxyState
 *    → running; device-level override wins over template; no-proxy devices
 *    get no gost; two devices get distinct ports
 *  - device delete: gost container removed; stop/start: proxyState machine
 *  - LEAK GUARD: no API response ever contains the proxy credentials
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  GOST_IMAGE,
  GOST_LISTEN_PORT,
  GOST_HOST_BIND,
  GOST_PORT_RANGE,
  PROXY_STATES,
  parseProxyUrl,
  validateProxyUrl,
  gostContainerName,
  buildGostContainerBody,
  buildTunnelSetupScript,
  buildTunnelTeardownScript,
} from '../../apps/api/src/services/redroid-service.js';
import { makeRedroidTestApp, login } from '../helpers/redroid-fakes.js';

const CRED = 'topsecret-passw0rd';
const PROXY_A = `socks5://userA:${CRED}@proxy-a.example:7801`;
const PROXY_B = 'socks5://10.9.9.9:1080';

async function makeApp(opts = {}) {
  const { app, db, dataRoot, redroidMock } = await makeRedroidTestApp(opts);
  const admin = await login(app, 'admin');
  const operator = await login(app, 'operator');
  const viewer = await login(app, 'viewer');
  return {
    app,
    db,
    redroidMock,
    cookies: { admin, operator, viewer },
    close: async () => { await app.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); },
  };
}

async function seedTemplate(app, cookie, name, extra = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/redroid/templates',
    headers: { cookie },
    payload: { name, image: 'redroid/redroid:14.0.0', androidVersion: '14', ...extra },
  });
  assert.equal(res.statusCode, 201, `seed template ${name}: ${res.statusCode} ${res.body}`);
  return res.json().template;
}

async function waitProxyState(app, cookie, deviceName, want, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/api/devices/redroid/${deviceName}`, headers: { cookie } });
    assert.equal(res.statusCode, 200, `get device: ${res.statusCode} ${res.body}`);
    const state = res.json().device.proxy?.state;
    if (state === want) return res.json().device;
    if (Date.now() > deadline) throw new Error(`proxyState stuck at '${state}', wanted '${want}'`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------------------
// Pure builders
// ---------------------------------------------------------------------------

test('stageb proxy: parseProxyUrl accepts socks5 with/without credentials, rejects everything else', () => {
  const ok1 = parseProxyUrl(PROXY_A);
  assert.equal(ok1.user, 'userA');
  assert.equal(ok1.pass, CRED);
  assert.equal(ok1.host, 'proxy-a.example');
  assert.equal(ok1.port, 7801);
  const ok2 = parseProxyUrl(PROXY_B);
  assert.equal(ok2.user, null);
  assert.equal(ok2.host, '10.9.9.9');
  assert.equal(ok2.port, 1080);
  for (const bad of [
    'http://proxy-a.example:7801',
    'socks4://proxy-a.example:7801',
    'SOCKS5://proxy-a.example:7801',
    'socks5://proxy-a.example', // no port
    'socks5://proxy-a.example:0', // port 0
    'socks5://proxy-a.example:99999', // > 65535
    `socks5://userA:${CRED}@proxy-a.example: 7801`, // space
    'socks5://userA:pa:ss@h:1080', // extra : in credentials (ambiguous — must be percent-encoded)
    '',
    null,
    undefined,
  ]) {
    assert.equal(parseProxyUrl(bad), null, `should reject: ${JSON.stringify(bad)}`);
  }
  // trim tolerance: leading/trailing whitespace is trimmed (API convenience)
  assert.equal(parseProxyUrl('  socks5://proxy-a.example:7801  ').host, 'proxy-a.example');
  // internal spaces are still rejected (covered above)
  assert.throws(() => validateProxyUrl('nope'), /proxyUrl must look like socks5/);
  assert.doesNotThrow(() => validateProxyUrl(PROXY_A));
});

test('stageb proxy: buildGostContainerBody — pinned image, 172.17.0.1 bind, empty Env, credentials only in Cmd', () => {
  const body = buildGostContainerBody({ deviceName: 'redroid-dev1', gostPort: 20082, proxyUrl: PROXY_A });
  assert.equal(body.Image, GOST_IMAGE);
  assert.match(GOST_IMAGE, /^gogost\/gost@sha256:[a-f0-9]{64}$/);
  assert.deepEqual(body.Env, []);
  assert.deepEqual(body.Cmd, ['start', '-L', `socks5://:${GOST_LISTEN_PORT}`, '-F', PROXY_A]);
  assert.deepEqual(body.HostConfig.NetworkMode, 'bridge');
  assert.deepEqual(body.HostConfig.PortBindings, {
    [`${GOST_LISTEN_PORT}/tcp`]: [{ HostIP: GOST_HOST_BIND, HostPort: '20082' }],
  });
  assert.equal(body.HostConfig.Privileged ?? false, false); // gost needs NOTHING privileged
  assert.equal(body.Labels['app.kind'], 'redroid-gost');
  assert.equal(body.Labels['redroid.device.name'], 'redroid-dev1');
  // range enforcement
  assert.throws(() => buildGostContainerBody({ deviceName: 'redroid-x', gostPort: 19999, proxyUrl: PROXY_A }), /gostPort/);
  assert.throws(() => buildGostContainerBody({ deviceName: 'redroid-x', gostPort: 20180, proxyUrl: PROXY_A }), /gostPort/);
  assert.throws(() => buildGostContainerBody({ deviceName: 'redroid-x', gostPort: 20090, proxyUrl: 'nope' }), /proxyUrl/);
});

test('stageb proxy: tunnel scripts — verified netd sequence (table 100 + onlink) + idempotency', () => {
  const setup = buildTunnelSetupScript({ gostPort: 20082 });
  assert.match(setup, /ip link del tun0 2>\/dev\/null \|\| true/); // idempotent re-run
  assert.match(setup, /ip link add tun0 type tun/);
  assert.match(setup, /ip addr add 10\.8\.0\.1 peer 10\.8\.0\.2\/32 dev tun0/);
  assert.match(setup, /ip link set tun0 up/);
  // the onlink flag is REQUIRED (10.8.0.2 is not resolvable inside table 100)
  assert.match(setup, /ip route add default via 10\.8\.0\.2 dev tun0 table 100 onlink/);
  // GATEWAY EXCEPTION (live-found 2026-10-19: without it the gVisor→gost
  // handshake hairpins out tun0 and the proxy connection is reset)
  assert.match(setup, /ip route add 172\.17\.0\.1 dev eth0 scope link table 100/);
  // rule 5000 fallback (netd owns it for TUNs it registers; EEXIST-safe)
  assert.match(setup, /ip rule add priority 5000 from all lookup 100 2>\/dev\/null \|\| true/);
  // RTM_NEWLINK is blocked in some Android netd states — link add must be
  // best-effort (tun2socks creates tun0 via ioctl when it is)
  assert.match(setup, /ip link add tun0 type tun 2>\/dev\/null \|\| true/);
  // tun2socks starts BEFORE addr/route config (it owns the device fd)
  assert.ok(setup.indexOf('tun2socks --device tun0') < setup.indexOf('ip addr add 10.8.0.1'), 't2s must start before addr add');
  // F-B (R1): bracketed + quoted pattern — combined with staged-file execution
  // (buildT2sRunScript) this is what keeps pkill from killing the runner shell
  assert.match(setup, /pkill -f "\[t\]un2socks" 2>\/dev\/null \|\| true/);
  assert.match(setup, /nohup \/data\/local\/tmp\/tun2socks --device tun0 --proxy socks5:\/\/172\.17\.0\.1:20082 --loglevel debug > \/data\/local\/tmp\/tun2socks\.log 2>&1 &/);
  assert.match(setup, /ps -ef \| grep \[t\]un2socks/); // bracket trick — grep must not self-match
  assert.throws(() => buildTunnelSetupScript({ gostPort: 21000 }), /gostPort/);
  assert.match(buildTunnelTeardownScript(), /pkill -f "\[t\]un2socks"/);
  assert.match(buildTunnelTeardownScript(), /ip link del tun0/);
});

test('stageb proxy: gostContainerName — redroid-matrix-b- prefix, docker-length safe', () => {
  const n = gostContainerName('redroid-dev1');
  assert.equal(n, 'redroid-matrix-b-gost-redroid-dev1');
  assert.ok(n.length <= 64, 'docker container name limit');
});

test('stageb proxy: constants — port range + state machine are frozen', () => {
  assert.equal(GOST_PORT_RANGE.start, 20080);
  assert.equal(GOST_PORT_RANGE.end, 20179);
  assert.deepEqual(PROXY_STATES, ['off', 'provisioning', 'running', 'stopped', 'error']);
  assert.throws(() => { GOST_PORT_RANGE.start = 1; }, /Cannot assign|read-only/i);
});

// ---------------------------------------------------------------------------
// Template proxy CRUD (encryption boundary)
// ---------------------------------------------------------------------------

test('stageb proxy: template create/update — encrypted at rest, masked in views, no plaintext leak', async (t) => {
  const { app, db, cookies, close } = await makeApp();
  t.after(close);

  const created = await app.inject({
    method: 'POST',
    url: '/api/redroid/templates',
    headers: { cookie: cookies.admin },
    payload: { name: 'tpl-proxy-a', image: 'redroid/redroid:14.0.0', androidVersion: '14', proxyUrl: PROXY_A },
  });
  assert.equal(created.statusCode, 201, created.body);
  const view = created.json().template;
  assert.equal(view.proxy.configured, true);
  assert.equal(view.proxy.hasUrl, true);
  // LEAK GUARD: the full response body must not contain the plaintext URL/credentials
  assert.ok(!created.body.includes(CRED), 'credentials leaked into template create response');
  assert.ok(!created.body.includes('proxy-a.example'), 'proxy host leaked into template create response');

  // DB stores CIPHERTEXT (v1: prefix), never plaintext
  const row = db.__state.templateRows.get(view.id);
  assert.ok(row.proxyUrlEncrypted, 'proxyUrlEncrypted missing in DB');
  assert.ok(row.proxyUrlEncrypted.startsWith('v1:'), 'expected v1: envelope');
  assert.ok(!row.proxyUrlEncrypted.includes(CRED), 'plaintext credential stored in DB');
  const cipher1 = row.proxyUrlEncrypted; // string copy — row is mutated in place by the fake DB

  // list + get views also masked
  const list = await app.inject({ method: 'GET', url: '/api/redroid/templates', headers: { cookie: cookies.viewer } });
  const tpl = list.json().templates.find((x) => x.name === 'tpl-proxy-a');
  assert.equal(tpl.proxy.configured, true);
  assert.ok(!list.body.includes(CRED), 'credentials leaked into template list');

  // patch: new URL
  const upd = await app.inject({
    method: 'PUT',
    url: `/api/redroid/templates/${view.id}`,
    headers: { cookie: cookies.admin },
    payload: { proxyUrl: PROXY_B },
  });
  assert.equal(upd.statusCode, 200, upd.body);
  assert.ok(!upd.body.includes('10.9.9.9'), 'proxy host leaked into template update response');
  const row2 = db.__state.templateRows.get(view.id);
  assert.notEqual(row2.proxyUrlEncrypted, cipher1, 'ciphertext should change (fresh IV + different plaintext)');
  assert.ok(!row2.proxyUrlEncrypted.includes('10.9.9.9'), 'updated plaintext stored unencrypted');

  // patch: null clears
  const clr = await app.inject({
    method: 'PUT',
    url: `/api/redroid/templates/${view.id}`,
    headers: { cookie: cookies.admin },
    payload: { proxyUrl: null },
  });
  assert.equal(clr.statusCode, 200, clr.body);
  assert.equal(clr.json().template.proxy.configured, false);
  assert.equal(db.__state.templateRows.get(view.id).proxyUrlEncrypted, null);

  // malformed rejected (400) on create and patch
  for (const bad of ['http://x.example:1080', 'socks5://noport', `socks5://a b:1080`]) {
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/redroid/templates',
      headers: { cookie: cookies.admin },
      payload: { name: `tpl-bad-${Math.random().toString(36).slice(2, 8)}`, image: 'redroid/redroid:14.0.0', androidVersion: '14', proxyUrl: bad },
    });
    assert.equal(r1.statusCode, 400, `create ${bad}: ${r1.body}`);
  }
});

// ---------------------------------------------------------------------------
// Device lifecycle with proxy
// ---------------------------------------------------------------------------

test('stageb proxy: device create inherits template proxy — gost up + tunnel provisioned → running', async (t) => {
  const { app, db, redroidMock, cookies, close } = await makeApp();
  t.after(close);

  const tpl = await seedTemplate(app, cookies.admin, 'tpl-dev-proxy', { proxyUrl: PROXY_A });
  const res = await app.inject({
    method: 'POST',
    url: '/api/devices/redroid',
    headers: { cookie: cookies.operator },
    payload: { name: 'redroid-p1', templateName: 'tpl-dev-proxy', idempotencyKey: 'sb-k-00001' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const device = res.json().device;
  assert.equal(device.proxy.configured, true);
  assert.equal(device.gostPort, undefined, 'legacy flat field must not exist');
  assert.ok(device.proxy.gostPort >= GOST_PORT_RANGE.start && device.proxy.gostPort <= GOST_PORT_RANGE.end, `gostPort out of range: ${device.proxy.gostPort}`);
  assert.equal(device.proxy.gostBind, GOST_HOST_BIND);
  assert.equal(device.proxy.hasUrl, true);
  assert.equal(device.proxy.containerName, 'redroid-matrix-b-gost-redroid-p1');
  // LEAK GUARD
  assert.ok(!res.body.includes(CRED), 'credentials leaked into device create response');
  assert.ok(!res.body.includes('proxy-a.example'), 'proxy host leaked into device create response');

  // DB: encrypted + state machine started
  const row = [...db.__state.deviceRows.values()].find((d) => d.name === 'redroid-p1');
  assert.ok(row.proxyUrlEncrypted?.startsWith('v1:'));
  assert.ok(PROXY_STATES.includes(row.proxyState));

  // gost container: created with the EXACT body + started
  const gostCreates = redroidMock.docker.client.__calls.filter((c) => c.method === 'createContainer' && c.cfg?._body?.Labels?.['app.kind'] === 'redroid-gost');
  assert.equal(gostCreates.length, 1, 'exactly one gost container');
  assert.equal(gostCreates[0].cfg._query.name, 'redroid-matrix-b-gost-redroid-p1');
  assert.equal(gostCreates[0].cfg._body.Image, GOST_IMAGE);
  assert.deepEqual(gostCreates[0].cfg._body.Cmd, ['start', '-L', `socks5://:${GOST_LISTEN_PORT}`, '-F', PROXY_A]);
  assert.deepEqual(gostCreates[0].cfg._body.Env, []);
  const started = redroidMock.docker.client.__calls.filter((c) => c.method === 'start');
  assert.ok(started.length >= 2, 'redroid + gost containers started');

  // background tunnel: staged-file execution (F-B/R1) — stage then run;
  // the INNER setup script (decoded from the stage b64) keeps the exact shape
  const device2 = await waitProxyState(app, cookies.operator, 'redroid-p1', 'running');
  assert.equal(device2.proxy.gostPort, device.proxy.gostPort);
  const stageCalls = redroidMock.exec.calls.filter((c) => c.script.includes('T2S_STAGED'));
  const runCalls = redroidMock.exec.calls.filter((c) => c.script.includes('sh /data/local/tmp/.t2s-setup.sh'));
  assert.equal(stageCalls.length, 1, 'setup staged exactly once');
  assert.equal(runCalls.length, 1, 'staged script executed exactly once');
  assert.ok(redroidMock.exec.calls.findIndex((c) => c.script.includes('T2S_STAGED')) <
    redroidMock.exec.calls.findIndex((c) => c.script.includes('sh /data/local/tmp/.t2s-setup.sh')), 'stage must precede run');
  const inner = Buffer.from(stageCalls[0].script.match(/printf '%s' '([A-Za-z0-9+\/=]+)' \| base64 -d/)[1], 'base64').toString('utf8');
  assert.ok(inner.includes(`socks5://172.17.0.1:${device.proxy.gostPort}`), 'inner setup script must point at THIS device\'s gost port');
  assert.ok(inner.includes('table 100 onlink'));
  assert.ok(!runCalls[0].script.includes('tun2socks'), 'RUNNER cmdline must never contain the literal tun2socks (F-B)');
});

test('stageb proxy: device-level proxyUrl override wins over template', async (t) => {
  const { app, redroidMock, cookies, close } = await makeApp();
  t.after(close);

  await seedTemplate(app, cookies.admin, 'tpl-ovr', { proxyUrl: PROXY_A });
  const res = await app.inject({
    method: 'POST',
    url: '/api/devices/redroid',
    headers: { cookie: cookies.operator },
    payload: { name: 'redroid-p2', templateName: 'tpl-ovr', idempotencyKey: 'sb-k-00002', proxyUrl: PROXY_B },
  });
  assert.equal(res.statusCode, 201, res.body);
  const gostCreates = redroidMock.docker.client.__calls.filter((c) => c.cfg?._body?.Labels?.['app.kind'] === 'redroid-gost');
  assert.equal(gostCreates.length, 1);
  assert.deepEqual(gostCreates[0].cfg._body.Cmd, ['start', '-L', `socks5://:${GOST_LISTEN_PORT}`, '-F', PROXY_B], 'override URL must be the forward target');
  assert.ok(!res.body.includes(CRED), 'credentials leaked (override test)');
  await waitProxyState(app, cookies.operator, 'redroid-p2', 'running');
});

test('stageb proxy: no proxy configured → no gost container, state off', async (t) => {
  const { app, redroidMock, cookies, close } = await makeApp();
  t.after(close);

  await seedTemplate(app, cookies.admin, 'tpl-noproxy');
  const res = await app.inject({
    method: 'POST',
    url: '/api/devices/redroid',
    headers: { cookie: cookies.operator },
    payload: { name: 'redroid-p3', templateName: 'tpl-noproxy', idempotencyKey: 'sb-k-00003' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const device = res.json().device;
  assert.equal(device.proxy.configured, false);
  assert.equal(device.proxy.state, 'off');
  assert.equal(device.proxy.gostPort, null);
  const gostCreates = redroidMock.docker.client.__calls.filter((c) => c.cfg?._body?.Labels?.['app.kind'] === 'redroid-gost');
  assert.equal(gostCreates.length, 0, 'no gost container for a proxy-less device');
  assert.equal(redroidMock.exec.calls.length, 0, 'no tunnel exec for a proxy-less device');
});

test('stageb proxy: two devices get distinct gost ports; delete tears down gost', async (t) => {
  const { app, db, redroidMock, cookies, close } = await makeApp();
  t.after(close);

  await seedTemplate(app, cookies.admin, 'tpl-two', { proxyUrl: PROXY_A });
  const r1 = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: { cookie: cookies.operator }, payload: { name: 'redroid-d1', templateName: 'tpl-two', idempotencyKey: 'sb-k-00010' } });
  const r2 = await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: { cookie: cookies.operator }, payload: { name: 'redroid-d2', templateName: 'tpl-two', idempotencyKey: 'sb-k-00011' } });
  assert.equal(r1.statusCode, 201, r1.body);
  assert.equal(r2.statusCode, 201, r2.body);
  const p1 = r1.json().device.proxy.gostPort;
  const p2 = r2.json().device.proxy.gostPort;
  assert.notEqual(p1, p2, 'distinct gost ports per device');

  await waitProxyState(app, cookies.operator, 'redroid-d1', 'running');
  await waitProxyState(app, cookies.operator, 'redroid-d2', 'running');

  // delete d1: gost container must be gone from the mock engine
  const del = await app.inject({ method: 'DELETE', url: '/api/devices/redroid/redroid-d1', headers: { cookie: cookies.admin }, payload: { confirm: 'redroid-d1' } });
  assert.equal(del.statusCode, 200, del.body);
  assert.equal(del.json().gostRemoved?.removed, true, `gost teardown: ${del.body}`);
  let inspectErr = null;
  try {
    await redroidMock.docker.client.getContainer('redroid-matrix-b-gost-redroid-d1').inspect();
  } catch (e) {
    inspectErr = e;
  }
  assert.ok(inspectErr, 'gost container should be removed after device delete');
  // d2 untouched
  const still = await app.inject({ method: 'GET', url: '/api/devices/redroid/redroid-d2', headers: { cookie: cookies.viewer } });
  assert.equal(still.json().device.proxy.state, 'running');
  // d1 row gone
  assert.ok(![...db.__state.deviceRows.values()].some((d) => d.name === 'redroid-d1'));
});

test('stageb proxy: stop → stopped (+ teardown exec); start → re-provisioned to running', async (t) => {
  const { app, redroidMock, cookies, close } = await makeApp();
  t.after(close);

  await seedTemplate(app, cookies.admin, 'tpl-lc', { proxyUrl: PROXY_A });
  await app.inject({ method: 'POST', url: '/api/devices/redroid', headers: { cookie: cookies.operator }, payload: { name: 'redroid-lc1', templateName: 'tpl-lc', idempotencyKey: 'sb-k-00020' } });
  await waitProxyState(app, cookies.operator, 'redroid-lc1', 'running');
  const stagedInnerScripts = (calls = redroidMock.exec.calls) =>
    calls.filter((c) => c.script.includes('T2S_STAGED'))
      .map((c) => Buffer.from(c.script.match(/printf '%s' '([A-Za-z0-9+\/=]+)' \| base64 -d/)[1], 'base64').toString('utf8'));
  const stagesBeforeStop = stagedInnerScripts().length;

  const stop = await app.inject({ method: 'POST', url: '/api/devices/redroid/redroid-lc1/stop', headers: { cookie: cookies.operator } });
  assert.equal(stop.statusCode, 200, stop.body);
  assert.equal(stop.json().device.proxy.state, 'stopped');
  // teardown is also staged (F-B/R1): decode the stage payloads, not the runner
  const stagedAfterStop = stagedInnerScripts();
  assert.equal(stagedAfterStop.length, stagesBeforeStop + 1, 'one more staged script on stop (the teardown)');
  assert.ok(stagedAfterStop[stagedAfterStop.length - 1].includes('TUNNEL_TEARDOWN_DONE'), 'last staged script on stop is the teardown');

  const start = await app.inject({ method: 'POST', url: '/api/devices/redroid/redroid-lc1/start', headers: { cookie: cookies.operator } });
  assert.equal(start.statusCode, 200, start.body);
  await waitProxyState(app, cookies.operator, 'redroid-lc1', 'running');
  const stagedAfterStart = stagedInnerScripts();
  assert.equal(stagedAfterStart.length, stagesBeforeStop + 2, 're-provisioned on start (one more staged setup)');
  // gost container is reused (idempotent — still exactly one create total)
  const gostCreates = redroidMock.docker.client.__calls.filter((c) => c.cfg?._body?.Labels?.['app.kind'] === 'redroid-gost');
  assert.equal(gostCreates.length, 1, 'gost container must be reused, not recreated');
});

test('stageb proxy: create with malformed device proxyUrl → 400, no partial row', async (t) => {
  const { app, db, cookies, close } = await makeApp();
  t.after(close);
  await seedTemplate(app, cookies.admin, 'tpl-baddev');
  const res = await app.inject({
    method: 'POST',
    url: '/api/devices/redroid',
    headers: { cookie: cookies.operator },
    payload: { name: 'redroid-bad', templateName: 'tpl-baddev', idempotencyKey: 'sb-k-00030', proxyUrl: 'not-a-url' },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.ok(![...db.__state.deviceRows.values()].some((d) => d.name === 'redroid-bad'), 'no orphan device row');
});
