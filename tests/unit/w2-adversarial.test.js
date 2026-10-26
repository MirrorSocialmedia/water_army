/**
 * W2 (ADR-026) — adversarial unit matrix: injection-surface EDGES.
 *
 * Complements (does not duplicate) adb-whitelist-w2.test.js — that file pins
 * the happy argv shapes + the basic injection matrix; this file pins the
 * boundary values an attacker actually probes:
 *
 *  1. `-s` serial (target = 127.0.0.1:<port>) port edges + control chars
 *  2. package-name exotic characters (CR/LF/NUL/zero-width/unicode/quotes)
 *  3. path edges (NUL, backslash, length boundaries; `a..b` is NOT `..`)
 *  4. op-name tampering (case / whitespace / near-collisions)
 *  5. dump size bombs: exact cap boundaries + per-attribute clip
 *  6. element-location edges: zero-size, exact screen-boundary centers,
 *     negative bounds, missing screen dims, missing bounds attr,
 *     AMBIGUOUS candidate cap, selector value coercion
 *  7. device verdict precision: "Successfully" ≠ Success (word boundary)
 *  8. uiautomator dump failure paths (idle-state / engine / read-back)
 *  9. APK magic SPOOF: ZIP-magic + garbage passes the host gate by design —
 *     the device verdict is the arbiter; no partial state; no package claim
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildAdbArgv, isValidAdbTarget, AdbWhitelistError } from '../../apps/api/src/services/adb-whitelist.js';
import { parseUiDump, findElements, pickTapTarget, UiTreeError } from '../../apps/api/src/services/ui-tree.js';
import { createAppService } from '../../apps/api/src/services/app-service.js';

const TARGET = '127.0.0.1:5555';
const vErr = (e) => e instanceof AdbWhitelistError && e.apiCode === 'VALIDATION_ERROR';
const uErr = (code) => (e) => e instanceof UiTreeError && e.apiCode === code;
const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.apiCode; } };

// ---------------------------------------------------------------------------
// 1. `-s` serial edges — the serial IS the target (redroid convention:
//    adb server bound on 127.0.0.1:<port>; ADB_TARGET_RE is the gate).

test('adb -s serial: port 0 / 65535 / 6-digit / empty / control chars', () => {
  assert.equal(isValidAdbTarget('127.0.0.1:0'), false, 'port 0 is invalid');
  assert.equal(isValidAdbTarget('127.0.0.1:65535'), true, 'port 65535 is valid');
  assert.equal(isValidAdbTarget('127.0.0.1:65536'), false, '6 digits cannot be a port');
  assert.equal(isValidAdbTarget('127.0.0.1:'), false);
  assert.equal(isValidAdbTarget('127.0.0.1:5555 '), false);
  assert.equal(isValidAdbTarget('127.0.0.1:5555\n'), false, 'CRLF injection into argv');
  assert.equal(isValidAdbTarget('127.0.0.1:5555\x00'), false, 'NUL byte');
  assert.equal(isValidAdbTarget('127.0.0.1:0x22'), false);
  for (const t of ['127.0.0.1:0', '127.0.0.1:65536', '127.0.0.1:5555\n', '127.0.0.1:5555\x00']) {
    assert.throws(() => buildAdbArgv({ op: 'package-list', target: t, packageName: 'com.a.b' }), vErr, `serial ${JSON.stringify(t)}`);
  }
  assert.deepEqual(buildAdbArgv({ op: 'package-list', target: '127.0.0.1:65535' }).slice(0, 2), ['-s', '127.0.0.1:65535']);
});

// ---------------------------------------------------------------------------
// 2. package name exotic characters

test('package names: CR/LF/NUL/tabs, zero-width, quotes, CJK/fullwidth, shell metachars — all rejected', () => {
  const bad = [
    'com.example.app\r', 'com.example.app\n', 'com.example.app\t',
    'com.example.app\u0000',
    'com.example.app\u200b', 'com.example.app\u00a0', // zero-width / nbsp
    '"com.example.app"', "'com.example.app'",
    'com.example.app;id', 'com.example.app$(reboot)', 'com.example.app`x`',
    'com.example.app|nc', 'com.example.app>x', 'com.example.app<y',
    'com.example.app&bg', 'com.example.app&&', 'com.example.app||',
    'com.example.app\u4e2d', 'com.example.app\uff11', // CJK / fullwidth digit
    ' com.example.app', 'com.example.app ',
    'com.example.app\u00e9', // accented latin
    'com.example.app-', '-com.example', 'com.example.-app',
  ];
  for (const p of bad) {
    assert.throws(() => buildAdbArgv({ op: 'apk-uninstall', target: TARGET, packageName: p }), vErr, `uninstall ${JSON.stringify(p)}`);
    assert.throws(() => buildAdbArgv({ op: 'package-info', target: TARGET, packageName: p }), vErr, `info ${JSON.stringify(p)}`);
  }
});

// ---------------------------------------------------------------------------
// 3. path edges

test('path edges: NUL + backslash rejected; "a..b" (one segment) is NOT traversal; exact length boundary', () => {
  assert.throws(() => buildAdbArgv({ op: 'device-read', target: TARGET, devicePath: '/data/local/tmp/a\x00b.xml' }), vErr, 'NUL in device path');
  assert.throws(() => buildAdbArgv({ op: 'apk-push', target: TARGET, localPath: '/var/lib/wa\x00x.apk', devicePath: '/data/local/tmp/x.apk' }), vErr, 'NUL in local path');
  assert.throws(() => buildAdbArgv({ op: 'device-read', target: TARGET, devicePath: '/data/local\\tmp/x.xml' }), vErr, 'backslash (windows-style) in device path');
  // '..' as a SUBSTRING inside a single segment is legal — the guard is per-segment
  assert.ok(Array.isArray(buildAdbArgv({ op: 'device-read', target: TARGET, devicePath: '/data/local/tmp/a..b.xml' })), 'a..b must pass');
  // local path: RE = '/' + 2..512 safe chars → total length ≤ 513
  const okLen = '/a/' + 'b'.repeat(510); // total 513
  assert.equal(okLen.length, 513);
  assert.ok(buildAdbArgv({ op: 'apk-push', target: TARGET, localPath: okLen, devicePath: '/data/local/tmp/x.apk' }));
  assert.throws(() => buildAdbArgv({ op: 'apk-push', target: TARGET, localPath: '/a/' + 'b'.repeat(511), devicePath: '/data/local/tmp/x.apk' }), vErr, '514-char local path');
});

// ---------------------------------------------------------------------------
// 4. op-name tampering

test('op-name tampering: case / whitespace / near-collisions stay rejected', () => {
  for (const op of ['APK_INSTALL', 'apk-install ', ' apk-install', 'pm-install', 'package list', 'input-tap2', 'Apk-Install', '']) {
    assert.throws(
      () => buildAdbArgv({ op, target: TARGET, packageName: 'com.a.b', devicePath: '/data/local/tmp/x.apk', localPath: '/a/b.apk', x: 1, y: 1 }),
      vErr, `op ${JSON.stringify(op)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. dump size bombs — exact boundaries

const mkXml = (inner) => `<?xml version='1.0' encoding='UTF-8' standalone=yes ?>\n<hierarchy rotation="0">\n${inner}\n</hierarchy>`;
const node = (id, bounds, extra = '') => `<node resource-id="${id}" bounds="${bounds}" class="c" package="p" clickable="true" enabled="true" ${extra}/>`;

test('dump size bomb: exactly maxBytes passes, one byte less fails; exact node cap passes, one node over fails', () => {
  const xml = mkXml(node('id/a', '[0,0][10,10]'));
  const bytes = Buffer.byteLength(xml, 'utf8');
  assert.equal(parseUiDump(xml, { maxBytes: bytes }).nodes.length, 1, 'exactly-at-cap must parse');
  assert.throws(() => parseUiDump(xml, { maxBytes: bytes - 1 }), uErr('UIA_DUMP_TOO_LARGE'));

  const five = mkXml(Array.from({ length: 5 }, (_, i) => node(`id/n${i}`, '[0,0][1,1]')).join('\n'));
  assert.equal(parseUiDump(five, { maxNodes: 5 }).nodes.length, 5, 'exactly-at-node-cap must parse');
  const six = mkXml(Array.from({ length: 6 }, (_, i) => node(`id/n${i}`, '[0,0][1,1]')).join('\n'));
  assert.throws(() => parseUiDump(six, { maxNodes: 5 }), uErr('UIA_DUMP_NODE_LIMIT'));
});

test('dump size bomb: a single huge attribute is clipped at maxTextLen (never a 4 MiB node)', () => {
  const longText = 'x'.repeat(1000);
  const { nodes } = parseUiDump(mkXml(node('id/long', '[0,0][10,10]', `text="${longText}"`)), { maxTextLen: 512 });
  assert.equal(nodes[0].text.length, 512);
  const { nodes: dflt } = parseUiDump(mkXml(node('id/long2', '[0,0][10,10]', `content-desc="${longText}"`)));
  assert.equal(dflt[0].contentDesc.length, 512, 'default clip is also 512');
});

// ---------------------------------------------------------------------------
// 6. element-location edges

test('tap edges: zero-size element; center exactly ON the screen edge = OFFSCREEN, one inside = OK', () => {
  const { nodes } = parseUiDump(mkXml([
    node('id/zero', '[5,5][5,5]'),
    node('id/edge-in', '[718,0][720,10]'),  // center x = 719 < 720 → on screen
    node('id/edge-out', '[719,0][721,10]'), // center x = 720 = screenWidth → OFFSCREEN
  ].join('\n')));
  const screen = { screenWidth: 720, screenHeight: 1280 };
  assert.deepEqual({ x: pickTapTarget(nodes, { resourceId: 'id/zero' }, screen).x, y: pickTapTarget(nodes, { resourceId: 'id/zero' }, screen).y }, { x: 5, y: 5 });
  assert.equal(pickTapTarget(nodes, { resourceId: 'id/edge-in' }, screen).x, 719);
  assert.throws(() => pickTapTarget(nodes, { resourceId: 'id/edge-out' }, screen), uErr('UIA_ELEMENT_OFFSCREEN'), 'center == screenWidth must be off-screen');
  // without screen dims (device row without geometry) the bounds check is skipped — the engine argv cap still bounds the tap
  assert.equal(pickTapTarget(nodes, { resourceId: 'id/edge-out' }).x, 720);
});

test('tap edges: negative bounds with in-screen center OK; node without bounds attr skipped+counted', () => {
  const { nodes } = parseUiDump(mkXml(node('id/neg', '[-10,0][10,10]')));
  assert.equal(pickTapTarget(nodes, { resourceId: 'id/neg' }, { screenWidth: 720, screenHeight: 1280 }).x, 0);
  const { nodes: nb, stats } = parseUiDump(mkXml(
    '<node resource-id="id/nob" class="c" package="p" /><node resource-id="id/ok" bounds="[0,0][1,1]" class="c" package="p" />',
  ));
  assert.equal(stats.skippedMalformed, 1);
  assert.equal(nb.length, 1);
  assert.equal(nb[0].resourceId, 'id/ok');
});

test('selector: numeric value coerced for *Contains (route schema enforces strings); clickable:false filters; AMBIGUOUS caps candidates at 8 with honest count', () => {
  const ten = parseUiDump(mkXml(Array.from({ length: 10 }, (_, i) => node(`id/dup${i === 0 ? '' : i}`, '[0,0][1,1]', `text="dup${i}"`)).join('\n'))).nodes;
  // 9 distinct ids + id/dup appears once; all share text prefix
  assert.equal(findElements(ten, { textContains: 4 }).length, 1, 'number → String() coercion');
  assert.equal(findElements(ten, { textContains: 'dup' }).length, 10);
  assert.equal(findElements(ten, { clickable: false }).length, 0, 'all fixtures are clickable=true');

  const dups = parseUiDump(mkXml(Array.from({ length: 10 }, () => node('id/dup', '[0,0][1,1]')).join('\n'))).nodes;
  assert.throws(
    () => pickTapTarget(dups, { resourceId: 'id/dup' }),
    (e) => {
      assert.equal(e.apiCode, 'UIA_ELEMENT_AMBIGUOUS');
      assert.equal(e.details.count, 10, 'count is the full truth');
      assert.equal(e.details.candidates.length, 8, 'candidates capped at 8');
      return true;
    },
  );
  // zero nodes → NOT_FOUND (never AMBIGUOUS)
  assert.throws(() => pickTapTarget([], { resourceId: 'id/x' }), uErr('UIA_ELEMENT_NOT_FOUND'));
});

// ---------------------------------------------------------------------------
// 7–9. app-service verdict precision + dump failures + magic spoof
// (service-level, stubbed adb engine — no fs beyond the managed dir)

const ADB_OPS = {
  PACKAGE_LIST: 'package-list', PACKAGE_INFO: 'package-info', APK_PUSH: 'apk-push',
  APK_INSTALL: 'apk-install', APK_UNINSTALL: 'apk-uninstall', UIA_DUMP: 'uia-dump',
  DEVICE_READ: 'device-read', INPUT_TAP: 'input-tap', DUMPSYS: 'dumpsys',
};
const DEVICE_ROW = { id: 'd1', name: 'r-x', adbPort: 15001, containerState: 'running', width: 720, height: 1280 };
const dbStub = { device: { findFirst: async ({ where }) => (where.name === DEVICE_ROW.name || where.id === DEVICE_ROW.id ? DEVICE_ROW : null) } };

function svcWith(adbRun, config = {}) {
  const audits = [];
  return {
    svc: createAppService({ db: dbStub, adb: { ops: ADB_OPS, buildArgv: buildAdbArgv, run: adbRun }, config, audit: async (a) => audits.push(a) }),
    audits,
  };
}

test('device verdict precision: "Successfully" is NOT a Success verdict (word boundary); exact "Success" is', async (t) => {
  const apkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-verdict-'));
  t.after(() => fs.rmSync(apkDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(apkDir, 'a.apk'), Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('zip-ish')]));
  const mk = (installStdout, installCode = 0) => svcWith(async (p) =>
    (p.op === 'apk-install'
      ? { exitCode: installCode, stdout: installStdout, stderr: '', truncated: false, timedOut: false }
      : { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false }),
    { waApkDir: apkDir });

  assert.equal(await codeOf(mk('Successfully finished the job\n').svc.installApk('r-x', { fileName: 'a.apk' })), 'APK_INSTALL_FAILED', 'no word-boundary match → must fail closed');
  const ok = await mk('Success\n').svc.installApk('r-x', { fileName: 'a.apk' });
  assert.equal(ok.installed, true, 'exact Success → installed');
});

test('uia dump failure paths: idle-state error / engine unavailable / read-back failure — all fail closed', async () => {
  const mk = (dumpRes) => svcWith(async (p) => {
    if (p.op === 'uia-dump') return dumpRes;
    if (p.op === 'device-read') return { exitCode: 1, stdout: '', stderr: 'cat: /data/local/tmp/wa_ui_dump.xml: No such file or directory', truncated: false, timedOut: false };
    return { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false };
  });
  // classic real-world: uiautomator could not get idle state (exit 0, no 'dumped to')
  assert.equal(await codeOf(mk({ exitCode: 0, stdout: 'ERROR: could not get idle state', stderr: '', truncated: false, timedOut: false }).svc.dumpUi('r-x')), 'UIA_DUMP_FAILED');
  // engine-level failure (no exit code)
  assert.equal(await codeOf(mk({ exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: false }).svc.dumpUi('r-x')), 'ADB_UNAVAILABLE');
  // dump ok but read-back fails (file vanished between dump and cat)
  assert.equal(await codeOf(mk({ exitCode: 0, stdout: 'UI hierchary dumped to: /data/local/tmp/wa_ui_dump.xml', stderr: '', truncated: false, timedOut: false }).svc.dumpUi('r-x')), 'UIA_DUMP_FAILED');
});

test('APK magic SPOOF: ZIP-magic + garbage passes the host gate by design; device verdict decides; no partial state; no package claim', async (t) => {
  const apkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-spoof-'));
  t.after(() => fs.rmSync(apkDir, { recursive: true, force: true }));
  const spoof = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('garbage-no-structure-at-all')]);
  fs.writeFileSync(path.join(apkDir, 'spoof.apk'), spoof);

  // host gate: name + containment + size + magic → PASSES (by design: the gate cannot parse APKs)
  const { svc } = svcWith(async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false }), { waApkDir: apkDir });
  const resolved = await svc.__resolveApkFile('spoof.apk');
  assert.equal(resolved.size, spoof.length, 'magic-spoof passes the host gate (documented design)');

  // device verdict is the arbiter: real-device-style Failure → fail closed
  const pushCalls = [];
  const { svc: svc2, audits } = svcWith(async (p) => {
    if (p.op === 'apk-push') { pushCalls.push(p); return { exitCode: 0, stdout: 'mock push', stderr: '', truncated: false, timedOut: false }; }
    if (p.op === 'apk-install') return { exitCode: 1, stdout: 'Failure [INSTALL_PARSE_FAILED_NOT_APK]\n', stderr: '', truncated: false, timedOut: false };
    if (p.op === 'package-list') return { exitCode: 0, stdout: 'package:com.android.systemui\n', stderr: '', truncated: false, timedOut: false };
    return { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false };
  }, { waApkDir: apkDir });

  assert.equal(await codeOf(svc2.installApk('r-x', { fileName: 'spoof.apk' })), 'APK_INSTALL_FAILED');
  assert.equal(pushCalls.length, 1, 'exactly one push — the spoof reached the device, the device said no');
  const last = audits.at(-1);
  assert.equal(last.status, 'error');
  assert.equal(last.details.stage, 'install');
  assert.match(last.details.deviceVerdict, /INSTALL_PARSE_FAILED_NOT_APK/);
  // no partial state: the platform never claims which package landed
  const list = await svc2.listPackages('r-x');
  assert.deepEqual(list.packages, ['com.android.systemui']);
});
