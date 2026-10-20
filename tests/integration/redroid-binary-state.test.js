/**
 * R1 (2026-10-20) — tun2socks binary state (diagnostic columns + fail-closed
 * pre-provision check). Hermetic: mock docker/adb/exec (no real containers).
 *
 * Contract under test (MD §3.2/§3.3):
 *  - every tunnel provision FIRST runs the binary check (marker-detectable
 *    exec call, ordered before the setup staging)
 *  - binary missing  → BINARY_MISSING path: proxyState=error, binaryState=
 *    missing, device NEVER reaches proxy 'running'
 *  - binary invalid  → BINARY_INVALID path: same fail-closed shape
 *  - check itself failed (seam) → binaryState=error, fail-closed
 *  - binaryState/binaryVersion surface in the device view — state + version
 *    string only, never credentials (leak guard)
 *  - the check script is read-only (no pkill/pgrep/route mutation — the
 *    F-B hazard class is structurally absent)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  TUN2SOCKS_PIN,
  TUN2SOCKS_CHECK_MARKER,
  TUN,
  buildT2sCheckScript,
  parseT2sCheckOutput,
} from '../../apps/api/src/services/redroid-service.js';
import { makeRedroidTestApp, login } from '../helpers/redroid-fakes.js';

const CRED = 'topsecret-passw0rd';
const PROXY_A = `socks5://userA:${CRED}@proxy-a.example:7801`;

async function makeApp(opts = {}) {
  const { app, db, dataRoot, redroidMock } = await makeRedroidTestApp(opts);
  const admin = await login(app, 'admin');
  const operator = await login(app, 'operator');
  return {
    app,
    db,
    redroidMock,
    cookies: { admin, operator },
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
  assert.equal(res.statusCode, 201, res.body);
  return res.json().template;
}

/** Poll the device until proxy.state === want (or fail). */
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

async function createProxyDevice(app, cookies, name, key) {
  await seedTemplate(app, cookies.admin, `tpl-bs-${key}`, { proxyUrl: PROXY_A });
  const res = await app.inject({
    method: 'POST',
    url: '/api/devices/redroid',
    headers: { cookie: cookies.operator },
    payload: { name, templateName: `tpl-bs-${key}`, idempotencyKey: `bs-k-${key}` },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().device;
}

// ---------------------------------------------------------------------------
// Pure contract: the check script itself
// ---------------------------------------------------------------------------

test('t2s binary check: script is read-only (no F-B hazard) and machine-readable', () => {
  const s = buildT2sCheckScript();
  assert.ok(s.includes(TUN2SOCKS_CHECK_MARKER), 'carries the versioned marker (mock + audit)');
  assert.ok(!/pkill|pgrep|kill /.test(s), 'no process-kill commands (read-only — F-B hazard class absent)');
  assert.ok(!/ip route|ip link|ip rule|netd/.test(s), 'no route/link mutation');
  assert.ok(s.includes(TUN.bin), 'checks the canonical path');
  assert.ok(s.includes(TUN.binFallback), 'carries the /usr/local/bin fallback (R2 fresh-/data shadowing gap)');
  assert.ok(s.includes('BINARY_STATE=missing'), 'missing branch is machine-readable');
  assert.ok(s.includes('BINARY_STATE=ready'), 'ready branch is machine-readable');
  assert.ok(s.includes('BINARY_DETAIL=fallback('), 'fallback provenance is machine-readable');
  assert.ok(s.includes('7f454c46'), 'ELF magic check present');
});

test('t2s binary check: output parser (pure)', () => {
  assert.deepEqual(parseT2sCheckOutput('BINARY_STATE=ready\nBINARY_VERSION=tun2socks-2.7.0\n'), {
    state: 'ready', version: 'tun2socks-2.7.0', detail: null,
  });
  assert.deepEqual(parseT2sCheckOutput('BINARY_STATE=invalid\nBINARY_DETAIL=not-elf(magic=0000dead)'), {
    state: 'invalid', version: null, detail: 'not-elf(magic=0000dead)',
  });
  assert.equal(parseT2sCheckOutput('garbage without markers').state, null);
  // R2: fallback provenance rides in BINARY_DETAIL (state stays 'ready')
  assert.deepEqual(parseT2sCheckOutput('BINARY_STATE=ready\nBINARY_VERSION=tun2socks-2.7.0\nBINARY_DETAIL=fallback(/usr/local/bin/tun2socks)\n'), {
    state: 'ready', version: 'tun2socks-2.7.0', detail: 'fallback(/usr/local/bin/tun2socks)',
  });
});

/**
 * The check script executed FOR REAL under sh (dash) against stand-in
 * binaries via the T2S_BIN test knob — every branch, machine-readable,
 * with the documented exit codes (0 ready / 3 missing / 4 invalid).
 */
test('t2s binary check: real execution (sh) — all four outcomes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-r1-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = buildT2sCheckScript();
  // Run via a FILE (sh <file>), not sh -c '<text>': the script text contains
  // the canonical tun2socks path, and a parallel pkill -f *tun2socks* (the
  // staging test) matches cmdlines — the file-based runner keeps this test's
  // children out of that match set (same F-B-safe geometry the service uses).
  const scriptFile = path.join(dir, 'check.sh');
  fs.writeFileSync(scriptFile, script);
  const run = (binPath) =>
    spawnSync('sh', [scriptFile], { encoding: 'utf8', env: { ...process.env, T2S_BIN: binPath } });

  // 1) missing
  const miss = run(path.join(dir, 'nope'));
  assert.equal(miss.status, 3, `missing: rc=3 got ${miss.status} ${miss.stderr}`);
  assert.match(miss.stdout, /BINARY_STATE=missing/);

  // 2) invalid: not an ELF (plain text with a plausible name)
  const txt = path.join(dir, 'tun2socks-text');
  fs.writeFileSync(txt, 'this is not an elf binary\n');
  fs.chmodSync(txt, 0o755);
  const bad = run(txt);
  assert.equal(bad.status, 4, `not-elf: rc=4 got ${bad.status} ${bad.stderr}`);
  assert.match(bad.stdout, /BINARY_STATE=invalid/);
  assert.match(bad.stdout, /BINARY_DETAIL=not-elf\(magic=[0-9a-f]*\)/);

  // 3) invalid: not executable (ELF magic but mode 0644)
  const roelf = path.join(dir, 'tun2socks-ro');
  fs.writeFileSync(roelf, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));
  fs.chmodSync(roelf, 0o644);
  const ro = run(roelf);
  assert.equal(ro.status, 4, `not-executable: rc=4 got ${ro.status} ${ro.stderr}`);
  assert.match(ro.stdout, /BINARY_DETAIL=not-executable/);

  // 4) ready: a REAL executable that answers the --version canary. A shell
  //    script cannot stand in (the check execs the file directly — a #!-file
  //    would fail the ELF-magic gate, which is correct behavior). So we
  //    compile a tiny canary binary at test time (source lives in the repo,
  //    no committed binaries — same rule as the wrapper image). Skipped
  //    where gcc is unavailable.
  const good = path.join(dir, 'canary-bin'); // neutral name: a parallel pkill -f *tun2socks* (staging test) must not match this cmdline
  const cc = spawnSync('gcc', ['-O2', '-o', good, '-x', 'c', '-', '-s', 'tun2socks-2.7.0\n'], { encoding: 'utf8', input: '#include <stdio.h>\nint main(void){ printf("tun2socks-2.7.0\\n"); return 0; }' });
  if (cc.status !== 0) {
    console.error('t2s check ready-case: skipped (no gcc)');
  } else {
    const ok = run(good);
    assert.equal(ok.status, 0, `ready: rc=0 got ${ok.status} ${ok.stderr}`);
    assert.match(ok.stdout, /BINARY_STATE=ready/);
    assert.match(ok.stdout, /BINARY_VERSION=tun2socks-2\.7\.0/);
  }

  // 5) invalid: valid ELF + executable + rc=0, but the canary answer is
  //    wrong (/bin/true: a real static-ish ELF that prints nothing)
  const lieR = run('/bin/true');
  assert.equal(lieR.status, 4, `wrong canary: rc=4 got ${lieR.status} ${lieR.stderr}`);
  assert.match(lieR.stdout, /BINARY_DETAIL=unexpected-version/);

  // 6) R2 fallback: canonical path absent, T2S_BIN unset (→ $CANON), fallback
  //    knob points at the good canary → ready WITH fallback provenance.
  //    (Hermetic stand-in for the fresh-/data geometry where the baked
  //    canonical is shadowed but /usr/local/bin/tun2socks survives.)
  const fb = path.join(dir, 'canary-fallback');
  const cc2 = spawnSync('gcc', ['-O2', '-o', fb, '-x', 'c', '-', '-s', 'tun2socks-2.7.0\n'], { encoding: 'utf8', input: '#include <stdio.h>\nint main(void){ printf("tun2socks-2.7.0\\n"); return 0; }' });
  if (cc2.status !== 0) {
    console.error('t2s check fallback-case: skipped (no gcc)');
  } else {
    const fbRun = spawnSync('sh', [scriptFile], { encoding: 'utf8', env: { ...process.env, T2S_BIN_FALLBACK: fb } });
    assert.equal(fbRun.status, 0, `fallback ready: rc=0 got ${fbRun.status} ${fbRun.stderr}`);
    assert.match(fbRun.stdout, /BINARY_STATE=ready/);
    assert.match(fbRun.stdout, new RegExp(`BINARY_DETAIL=fallback\(${fb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\)`));
    assert.match(fbRun.stdout, /BINARY_VERSION=tun2socks-2\.7\.0/);
  }

  // 7) R2 fallback must NOT engage when T2S_BIN is set (test-knob priority;
  //    also guards the "$BIN != $CANON → no fallback" branch — case 1 above
  //    already proves rc=3 with a bogus T2S_BIN even though a fallback knob
  //    could have been offered).
  const noFb = spawnSync('sh', [scriptFile], { encoding: 'utf8', env: { ...process.env, T2S_BIN: path.join(dir, 'nope'), T2S_BIN_FALLBACK: path.join(dir, 'canary-bin') } });
  assert.equal(noFb.status, 3, `T2S_BIN set + missing: rc=3 got ${noFb.status} ${noFb.stderr}`);
  assert.match(noFb.stdout, /BINARY_STATE=missing/);
  assert.ok(!noFb.stdout.includes('BINARY_DETAIL=fallback('), 'no fallback when T2S_BIN is explicit');
});

// ---------------------------------------------------------------------------
// Integration: fail-closed provisioning via the mock exec seam
// ---------------------------------------------------------------------------

test('binary ready: provision proceeds; diagnosis surfaces in the view (no credentials)', async (t) => {
  const { app, db, redroidMock, cookies, close } = await makeApp();
  t.after(close);

  await createProxyDevice(app, cookies, 'redroid-bs1', '0001');
  const device = await waitProxyState(app, cookies.operator, 'redroid-bs1', 'running');

  // the check ran BEFORE any setup staging
  const checkIdx = redroidMock.exec.calls.findIndex((c) => c.script.includes(TUN2SOCKS_CHECK_MARKER));
  const stageIdx = redroidMock.exec.calls.findIndex((c) => c.script.includes('T2S_STAGED'));
  assert.ok(checkIdx >= 0, 'binary check exec call recorded');
  assert.ok(stageIdx >= 0, 'setup staging recorded');
  assert.ok(checkIdx < stageIdx, 'binary check must precede setup staging');

  // diagnosis persisted + in the view
  assert.equal(device.proxy.binaryState, 'ready');
  assert.equal(device.proxy.binaryVersion, `tun2socks-${TUN2SOCKS_PIN.version}`);
  const row = [...db.__state.deviceRows.values()].find((d) => d.name === 'redroid-bs1');
  assert.equal(row.binaryState, 'ready');
  assert.equal(row.binaryVersion, `tun2socks-${TUN2SOCKS_PIN.version}`);

  // LEAK GUARD: the diagnosis never drags credentials along
  const body = JSON.stringify(device);
  assert.ok(!body.includes(CRED), 'credentials leaked into device view');
  assert.ok(!body.includes('proxy-a.example'), 'proxy host leaked into device view');
});

test('binary missing → BINARY_MISSING fail-closed: never running, state=missing', async (t) => {
  const { app, db, redroidMock, cookies, close } = await makeApp({
    redroidMockOpts: { execOpts: { binaryCheck: { state: 'missing' } } },
  });
  t.after(close);

  await createProxyDevice(app, cookies, 'redroid-bs2', '0002');
  const device = await waitProxyState(app, cookies.operator, 'redroid-bs2', 'error');

  assert.equal(device.proxy.state, 'error', 'proxy must be in error, not running');
  assert.equal(device.proxy.binaryState, 'missing');
  assert.equal(device.proxy.binaryVersion, null);
  const row = [...db.__state.deviceRows.values()].find((d) => d.name === 'redroid-bs2');
  assert.equal(row.binaryState, 'missing');
  assert.notEqual(row.proxyState, 'running', 'device proxy must NEVER reach running on a missing binary');
  // the device container itself is fine — only the proxy binding failed
  assert.equal(device.containerState, 'running');
  // fail-closed BEFORE provisioning work: nothing was staged
  const staged = redroidMock.exec.calls.filter((c) => c.script.includes('T2S_STAGED'));
  assert.equal(staged.length, 0, 'setup must not be staged when the binary is missing');
});

test('binary invalid → BINARY_INVALID fail-closed with detail', async (t) => {
  const { app, db, cookies, close } = await makeApp({
    redroidMockOpts: { execOpts: { binaryCheck: { state: 'invalid', detail: 'not-elf(magic=0000dead)' } } },
  });
  t.after(close);

  await createProxyDevice(app, cookies, 'redroid-bs3', '0003');
  const device = await waitProxyState(app, cookies.operator, 'redroid-bs3', 'error');

  assert.equal(device.proxy.state, 'error');
  assert.equal(device.proxy.binaryState, 'invalid');
  const row = [...db.__state.deviceRows.values()].find((d) => d.name === 'redroid-bs3');
  assert.equal(row.binaryState, 'invalid');
  assert.notEqual(row.proxyState, 'running');
});

test('check seam failure → binaryState=error, still fail-closed', async (t) => {
  const { app, db, cookies, close } = await makeApp({
    redroidMockOpts: { execOpts: { fail: true } },
  });
  t.after(close);

  await createProxyDevice(app, cookies, 'redroid-bs4', '0004');
  const device = await waitProxyState(app, cookies.operator, 'redroid-bs4', 'error');

  assert.equal(device.proxy.state, 'error');
  assert.equal(device.proxy.binaryState, 'error', 'seam failure is diagnosed as error, not ready');
  const row = [...db.__state.deviceRows.values()].find((d) => d.name === 'redroid-bs4');
  assert.equal(row.binaryState, 'error');
  assert.notEqual(row.proxyState, 'running');
});

