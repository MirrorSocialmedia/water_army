/**
 * W2 (ADR-026) — adb-whitelist app-layer op unit tests.
 *
 * Same security posture as the P5 core ops (工單 硬驗收 4/5 patterns):
 *  - exact fixed argv shapes per op
 *  - package names / device paths / local paths: injection + traversal rejected
 *  - tap coordinates: strict bounded integers
 *  - new ops still obey: fixed binary, argv arrays, no shell, caps, per-call cap override
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAdbArgv,
  createAdbWhitelist,
  AdbWhitelistError,
  isValidAdbTarget,
  PACKAGE_NAME_RE,
  DEVICE_PATH_RE,
  LOCAL_PATH_RE,
  UIA_DUMP_DEVICE_PATH,
} from '../../apps/api/src/services/adb-whitelist.js';

const TARGET = '127.0.0.1:5555';
const throwValidation = (fn, msg) =>
  assert.throws(fn, (e) => e instanceof AdbWhitelistError && e.apiCode === 'VALIDATION_ERROR', msg);

// ---- exact argv shapes -------------------------------------------------------

test('W2 ops build exact fixed argv arrays', () => {
  assert.deepEqual(buildAdbArgv({ op: 'package-list', target: TARGET }), ['-s', TARGET, 'shell', 'pm', 'list', 'packages']);
  assert.deepEqual(buildAdbArgv({ op: 'package-list', target: TARGET, packageName: 'com.example.app' }), [
    '-s', TARGET, 'shell', 'pm', 'list', 'packages', 'com.example.app',
  ]);
  assert.deepEqual(buildAdbArgv({ op: 'package-info', target: TARGET, packageName: 'com.example.app' }), [
    '-s', TARGET, 'shell', 'dumpsys', 'package', 'com.example.app',
  ]);
  assert.deepEqual(buildAdbArgv({
    op: 'apk-push', target: TARGET,
    localPath: '/var/lib/water-army/apk/app-v1.apk',
    devicePath: '/data/local/tmp/wa_app-v1.apk',
  }), ['-s', TARGET, 'push', '/var/lib/water-army/apk/app-v1.apk', '/data/local/tmp/wa_app-v1.apk']);
  assert.deepEqual(buildAdbArgv({ op: 'apk-install', target: TARGET, devicePath: '/data/local/tmp/wa_app-v1.apk' }), [
    '-s', TARGET, 'shell', 'pm', 'install', '-r', '/data/local/tmp/wa_app-v1.apk',
  ]);
  assert.deepEqual(buildAdbArgv({ op: 'apk-uninstall', target: TARGET, packageName: 'com.example.app' }), [
    '-s', TARGET, 'shell', 'pm', 'uninstall', 'com.example.app',
  ]);
  assert.deepEqual(buildAdbArgv({ op: 'uia-dump', target: TARGET }), ['-s', TARGET, 'shell', 'uiautomator', 'dump', UIA_DUMP_DEVICE_PATH]);
  assert.deepEqual(buildAdbArgv({ op: 'device-read', target: TARGET, devicePath: UIA_DUMP_DEVICE_PATH }), [
    '-s', TARGET, 'exec-out', 'cat', UIA_DUMP_DEVICE_PATH,
  ]);
  assert.deepEqual(buildAdbArgv({ op: 'input-tap', target: TARGET, x: 100, y: 200 }), ['-s', TARGET, 'shell', 'input', 'tap', '100', '200']);
});

test('uia-dump takes no user arguments — the dump path is a fixed constant', () => {
  assert.equal(UIA_DUMP_DEVICE_PATH, '/data/local/tmp/wa_ui_dump.xml');
  // extra fields are ignored for this op (argv shape is constant)
  assert.deepEqual(buildAdbArgv({ op: 'uia-dump', target: TARGET, packageName: 'com.evil.app;id' }).slice(2), [
    'shell', 'uiautomator', 'dump', UIA_DUMP_DEVICE_PATH,
  ]);
});

// ---- package name injection matrix -------------------------------------------

test('package names: injections and illegal shapes are all rejected', () => {
  const bad = [
    'com.example.app;id',
    'com.example.app$(reboot)',
    'com.example.app`id`',
    'com.example.app|nc evil 1',
    'com.example.app>x',
    'com.example.app app',
    'com.example.app\nid',
    'Com.Example.App', // uppercase
    'com.example.app/app',
    "com.example.app'suffix",
    'com..example',
    '.com.example',
    'com.example.',
    'singlesegment', // no dot = not a package shape
    'com.example.app\u0000',
    'a'.repeat(200),
    null, undefined, 42, {},
  ];
  for (const p of bad) {
    throwValidation(() => buildAdbArgv({ op: 'apk-uninstall', target: TARGET, packageName: p }), `uninstall pkg ${String(p)} must be rejected`);
    throwValidation(() => buildAdbArgv({ op: 'package-info', target: TARGET, packageName: p }), `package-info pkg ${String(p)} must be rejected`);
    // for package-list only null/undefined/'' are 'no filter'; anything else must validate
    if (p !== null && p !== undefined && p !== '') {
      throwValidation(() => buildAdbArgv({ op: 'package-list', target: TARGET, packageName: p }), `list filter ${String(p)} must be rejected`);
    }
  }
  assert.match('com.example.app', PACKAGE_NAME_RE);
  assert.match('a.b', PACKAGE_NAME_RE);
});

// ---- path validation matrices --------------------------------------------------

test('device paths: only managed prefixes, safe chars, no traversal', () => {
  const bad = [
    '/etc/passwd',
    '/data/local/tmp/../../etc/passwd',
    '/sdcard/../../../etc/shadow',
    '/data/local/tmp/app;id.apk',
    '/data/local/tmp/app $(reboot).apk',
    '/data/local/tmp/app`x`.apk',
    '/data/local/tmp/app|nc.apk',
    '/data/local/tmp/a'.concat('x'.repeat(300)) + '.apk',
    'data/local/tmp/rel.apk', // not absolute
    '', null, undefined, 7,
  ];
  for (const p of bad) {
    throwValidation(() => buildAdbArgv({ op: 'device-read', target: TARGET, devicePath: p }), `device path ${String(p)} must be rejected`);
    throwValidation(() => buildAdbArgv({ op: 'apk-install', target: TARGET, devicePath: p }), `install device path ${String(p)} must be rejected`);
  }
  assert.match('/data/local/tmp/wa_app.apk', DEVICE_PATH_RE);
  assert.match('/sdcard/Download/wa_app.apk', DEVICE_PATH_RE);
});

test('local paths: absolute safe-char only; traversal and metachars rejected', () => {
  const bad = [
    '/var/lib/water-army/apk/../../etc/passwd',
    '/var/lib/apk/a;id.apk',
    '/var/lib/apk/a b.apk',
    '/var/lib/apk/a$(x).apk',
    '/var/lib/apk/a|b.apk',
    '/var/lib/apk/a\tb.apk',
    'var/lib/apk/rel.apk', // not absolute
    '/'.repeat(600),
    '', null, undefined, {},
  ];
  for (const p of bad) {
    throwValidation(
      () => buildAdbArgv({ op: 'apk-push', target: TARGET, localPath: p, devicePath: '/data/local/tmp/x.apk' }),
      `local path ${String(p).slice(0, 40)} must be rejected`,
    );
  }
  // devicePath must ALSO fail on its own merits in apk-push
  throwValidation(
    () => buildAdbArgv({ op: 'apk-push', target: TARGET, localPath: '/a/b.apk', devicePath: '/etc/passwd' }),
    'apk-push must reject non-managed device path',
  );
  assert.match('/var/lib/water-army/apk/app_v1.2-3.apk', LOCAL_PATH_RE);
});

// ---- tap coordinate contract ----------------------------------------------------

test('input-tap: strict bounded integers; strings/floats/out-of-range rejected', () => {
  for (const [x, y] of [[0, 0], [16384, 16384], [720, 1280]]) {
    assert.deepEqual(buildAdbArgv({ op: 'input-tap', target: TARGET, x, y }).slice(-2), [String(x), String(y)]);
  }
  for (const [x, y] of [[-1, 0], [0, -1], [1.5, 0], ['100', '200'], [16385, 0], [0, 16385], [null, 0], [0, undefined], [NaN, 0], [Infinity, 0]]) {
    throwValidation(() => buildAdbArgv({ op: 'input-tap', target: TARGET, x, y }), `tap (${x},${y}) must be rejected`);
  }
});

// ---- W1 core-op regression guard: legacy ops unchanged ---------------------------

test('W1-era ops and rejections are untouched by the W2 extension', () => {
  // ops that are NOT in the whitelist must stay rejected (verb-name collision guard)
  for (const bad of ['shell', 'pm', 'install', 'push', 'uninstall', 'uiautomator', 'tap', 'cat', 'exec-out']) {
    throwValidation(() => buildAdbArgv({ op: bad, target: TARGET }), `op ${bad} must stay rejected`);
  }
  // target rules unchanged for the new ops too
  for (const t of ['0.0.0.0:5555', 'localhost:5555', '127.0.0.1:5555;id', null]) {
    if (t !== null) assert.equal(isValidAdbTarget(t), false);
    throwValidation(() => buildAdbArgv({ op: 'package-list', target: t ?? undefined, packageName: 'com.a.b' }), `target ${t} must be rejected`);
  }
  // device-scoped: target required
  for (const op of ['package-list', 'package-info', 'apk-push', 'apk-install', 'apk-uninstall', 'uia-dump', 'device-read', 'input-tap']) {
    throwValidation(() => buildAdbArgv({ op, x: 1, y: 1, localPath: '/a/b.apk', devicePath: '/data/local/tmp/b.apk', packageName: 'com.a.b' }), `${op} requires a target`);
  }
});

// ---- run(): fixed binary / no shell / per-call cap -------------------------------

test('W2 run() keeps fixed binary + argv arrays + no shell option', async () => {
  const calls = [];
  const exec = async (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return { stdout: 'Success\n', stderr: '' };
  };
  const adb = createAdbWhitelist({ adbBinary: '/usr/bin/adb', execFile: exec });
  const r = await adb.run({ op: 'apk-install', target: TARGET, devicePath: '/data/local/tmp/wa_a.apk' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, '/usr/bin/adb');
  assert.deepEqual(calls[0].args, ['-s', TARGET, 'shell', 'pm', 'install', '-r', '/data/local/tmp/wa_a.apk']);
  assert.equal(calls[0].opts.shell, undefined);
  assert.equal(r.stdout, 'Success\n');
});

test('run() per-call maxOutputBytes override (uiautomator XML needs a bigger cap) and honest truncation', async () => {
  const huge = 'x'.repeat(4096);
  const exec = async () => ({ stdout: huge, stderr: '' });
  const adb = createAdbWhitelist({ adbBinary: '/usr/bin/adb', execFile: exec, maxOutputBytes: 1024 });
  const small = await adb.run({ op: 'device-read', target: TARGET, devicePath: UIA_DUMP_DEVICE_PATH });
  assert.equal(small.stdout.length, 1024);
  assert.equal(small.truncated, true);
  const big = await adb.run({ op: 'device-read', target: TARGET, devicePath: UIA_DUMP_DEVICE_PATH, maxOutputBytes: 4096 });
  assert.equal(big.stdout.length, 4096);
  assert.equal(big.truncated, false, 'per-call cap 4096 must fit exactly');
  const r3 = await adb.run({ op: 'device-read', target: TARGET, devicePath: UIA_DUMP_DEVICE_PATH, maxOutputBytes: 2048 });
  assert.equal(r3.truncated, true, 'honest truncation under the raised cap too');
});
