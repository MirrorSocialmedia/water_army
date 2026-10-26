/**
 * P5 commit 2 — adb-whitelist engine unit tests.
 *
 * Hard rules under test (工單 硬驗收 4/5):
 *  - only the 3 shell ops (+2 fixed non-shell connectivity ops) exist
 *  - injection attempts (;, $(), backtick, |, >, space, newline) all rejected
 *  - targets must be 127.0.0.1:<port> — 0.0.0.0 / localhost / ::1 / other IPs rejected
 *  - fixed binary path + argv arrays + no shell (exec called with the exact array)
 *  - timeout → timedOut flag; output cap → truncated flag (never silent drop)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAdbWhitelist,
  buildAdbArgv,
  AdbWhitelistError,
  ADB_OPS,
  isValidAdbTarget,
} from '../../apps/api/src/services/adb-whitelist.js';

const TARGET = '127.0.0.1:5555';

// ---- buildAdbArgv: exact fixed command shapes --------------------------------

test('getprop full dump and allowlisted key build exact argv arrays', () => {
  assert.deepEqual(buildAdbArgv({ op: 'getprop', target: TARGET }), ['-s', TARGET, 'shell', 'getprop']);
  assert.deepEqual(buildAdbArgv({ op: 'getprop', target: TARGET, prop: 'ro.build.version.release' }), [
    '-s', TARGET, 'shell', 'getprop', 'ro.build.version.release',
  ]);
});

test('dumpsys builds argv only for allowlisted services', () => {
  assert.deepEqual(buildAdbArgv({ op: 'dumpsys', target: TARGET, service: 'window' }), ['-s', TARGET, 'shell', 'dumpsys', 'window']);
  for (const bad of ['pm', 'pm list', 'window;id', 'window | grep x', '', null, undefined]) {
    assert.throws(
      () => buildAdbArgv({ op: 'dumpsys', target: TARGET, service: bad }),
      (e) => e instanceof AdbWhitelistError && e.apiCode === 'VALIDATION_ERROR',
      `dumpsys service ${String(bad)} must be rejected`,
    );
  }
});

test('logcat always gets server-side -d and a capped -t', () => {
  assert.deepEqual(buildAdbArgv({ op: 'logcat', target: TARGET, tail: 100 }), ['-s', TARGET, 'shell', 'logcat', '-d', '-t', '100']);
  for (const bad of [0, -5, 1.5, '100', null, undefined, 5001]) {
    assert.throws(
      () => buildAdbArgv({ op: 'logcat', target: TARGET, tail: bad }),
      (e) => e instanceof AdbWhitelistError,
      `logcat tail ${String(bad)} must be rejected`,
    );
  }
});

test('connect / get-state are fixed non-shell commands', () => {
  assert.deepEqual(buildAdbArgv({ op: 'connect', target: TARGET }), ['connect', TARGET]);
  assert.deepEqual(buildAdbArgv({ op: 'get-state', target: TARGET }), ['-s', TARGET, 'get-state']);
});

test('any op outside the whitelist is rejected (no /exec semantics exist)', () => {
  for (const bad of ['shell', 'reboot', 'pm', 'install', 'push', 'pull', 'screencap', 'settings', '', null, undefined, 'GETPROP']) {
    assert.throws(
      () => buildAdbArgv({ op: bad, target: TARGET }),
      (e) => e instanceof AdbWhitelistError && e.apiCode === 'VALIDATION_ERROR',
      `op ${String(bad)} must be rejected`,
    );
  }
});

// ---- injection attempts (工單 硬驗收 4: 注入嘗試全拒) -----------------------------

test('getprop property injection attempts are all rejected', () => {
  const injections = [
    'ro.build.version.release;id',
    'ro.build.version.release$(reboot)',
    'ro.build.version.release`id`',
    'ro.build.version.release|nc evil 1',
    'ro.build.version.release>out',
    'ro.build.version.release<in',
    'ro.build.version.release\nid',
    'ro.build.version.release\tid',
    'ro build.version.release', // space
    'RO.BUILD.VERSION.RELEASE', // case: property keys are lowercase by convention
    'ro.custom.not.allowlisted', // legal shape, not allowlisted
    'ro.build.version.release\n;rm -rf /',
    ';'.repeat(1),
    '$(reboot)',
    '`reboot`',
  ];
  for (const prop of injections) {
    assert.throws(
      () => buildAdbArgv({ op: 'getprop', target: TARGET, prop }),
      (e) => e instanceof AdbWhitelistError && e.apiCode === 'VALIDATION_ERROR',
      `prop ${JSON.stringify(prop)} must be rejected`,
    );
  }
});

test('target injection / non-loopback targets are all rejected', () => {
  const badTargets = [
    '0.0.0.0:5555',
    '10.0.0.5:5555',
    '192.168.1.1:5555',
    '172.17.0.1:5555',
    'localhost:5555',
    'localhost5555',
    '::1:5555',
    '[::1]:5555',
    '127.0.0.2:5555',
    '127.0.0.1:0',
    '127.0.0.1:65536',
    '127.0.0.1:',
    '127.0.0.1',
    '127.0.0.1:5555;id',
    '127.0.0.1:55 55',
    '127.0.0.1:5555 ',
    'evil:5555',
    '127.0.0.1:5555/../../etc/passwd',
  ];
  for (const t of badTargets) {
    assert.equal(isValidAdbTarget(t), false, `target ${JSON.stringify(t)} must be invalid`);
    assert.throws(
      () => buildAdbArgv({ op: 'get-state', target: t }),
      (e) => e instanceof AdbWhitelistError && e.apiCode === 'VALIDATION_ERROR',
      `target ${JSON.stringify(t)} must be rejected`,
    );
  }
  assert.equal(isValidAdbTarget('127.0.0.1:5555'), true);
  assert.equal(isValidAdbTarget('127.0.0.1:65535'), true);
});

test('device-scoped ops require a target', () => {
  for (const op of ['getprop', 'dumpsys', 'logcat', 'get-state']) {
    assert.throws(
      () => buildAdbArgv({ op, service: op === 'dumpsys' ? 'window' : undefined }),
      (e) => e instanceof AdbWhitelistError,
    );
  }
});

// ---- run(): fixed binary, argv array, no shell, caps, timeout -----------------

function makeRecorder() {
  const calls = [];
  const exec = async (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return { stdout: 'ok\n', stderr: '' };
  };
  return { calls, exec };
}

test('run() calls the FIXED binary with an argv array and NO shell option', async () => {
  const { calls, exec } = makeRecorder();
  const adb = createAdbWhitelist({ adbBinary: '/usr/bin/adb', execFile: exec });
  const r = await adb.run({ op: 'dumpsys', target: TARGET, service: 'window' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, '/usr/bin/adb');
  assert.deepEqual(calls[0].args, ['-s', TARGET, 'shell', 'dumpsys', 'window']);
  assert.equal(calls[0].opts.shell, undefined, 'shell option must never be set');
  assert.equal(typeof calls[0].opts.timeout, 'number');
  assert.ok(calls[0].opts.maxBuffer > 0);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, 'ok\n');
  assert.equal(r.timedOut, false);
  assert.equal(r.truncated, false);
});

test('run() passes through non-zero exit codes honestly', async () => {
  const exec = async () => {
    const e = new Error('Error: device offline');
    e.code = 1;
    e.stdout = '';
    e.stderr = 'error: no devices/emulators found';
    throw e;
  };
  const adb = createAdbWhitelist({ adbBinary: '/usr/bin/adb', execFile: exec, timeoutMs: 1000 });
  const r = await adb.run({ op: 'get-state', target: TARGET });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /no devices/);
  assert.equal(r.timedOut, false);
});

test('output cap: huge stdout is truncated and flagged (never silent drop)', async () => {
  const huge = 'x'.repeat(4096);
  const exec = async () => ({ stdout: huge, stderr: '' });
  const adb = createAdbWhitelist({ adbBinary: '/usr/bin/adb', execFile: exec, maxOutputBytes: 1024, timeoutMs: 1000 });
  const r = await adb.run({ op: 'getprop', target: TARGET });
  assert.equal(r.stdout.length, 1024);
  assert.equal(r.truncated, true);
});

test('timeout: a hanging adb call resolves with timedOut (never hangs the API)', async () => {
  const hang = () => new Promise(() => {}); // adb that never returns
  const adb = createAdbWhitelist({ adbBinary: '/usr/bin/adb', execFile: hang, timeoutMs: 60 });
  const r = await adb.run({ op: 'logcat', target: TARGET, tail: 50 });
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
});

test('kill-style timeout errors (node execFile timeout shape) map to timedOut', async () => {
  const exec = async () => {
    const e = new Error('Command timed out');
    e.killed = true;
    e.signal = 'SIGKILL';
    e.stdout = 'partial';
    e.stderr = '';
    throw e;
  };
  const adb = createAdbWhitelist({ adbBinary: '/usr/bin/adb', execFile: exec, timeoutMs: 1000 });
  const r = await adb.run({ op: 'getprop', target: TARGET });
  assert.equal(r.timedOut, true);
  assert.equal(r.stdout, 'partial');
});

test('binary must be an absolute fixed path — relative/empty rejected at construction', () => {
  assert.throws(() => createAdbWhitelist({ adbBinary: 'adb' }));
  assert.throws(() => createAdbWhitelist({ adbBinary: '' }));
  const adb = createAdbWhitelist({ adbBinary: '/usr/bin/adb' });
  assert.equal(adb.binary(), '/usr/bin/adb');
});

test('op constants match the documented set', () => {
  assert.deepEqual(Object.values(ADB_OPS).sort(), [
    // sorted; P5 core (W1 era) + W2 (ADR-026) app-layer ops = the FULL documented set
    'apk-install', 'apk-push', 'apk-uninstall',
    'connect', 'device-read', 'dumpsys', 'get-state', 'getprop',
    'input-tap', 'logcat', 'package-info', 'package-list', 'uia-dump',
  ]);
});
