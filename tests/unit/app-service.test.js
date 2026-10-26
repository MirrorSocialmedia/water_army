/**
 * W2 (ADR-026) — app-service unit tests: the host-side APK gate (managed
 * directory + traversal + size + ZIP magic), device verdict parsing, focus
 * parsing, and the running-device fail-closed precondition.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAppService } from '../../apps/api/src/services/app-service.js';

const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('pretend-zip-payload')]);

function setup({ row = { id: 'd1', name: 'redroid-x', adbPort: 15001, containerState: 'running', width: 720, height: 1280 } } = {}) {
  const apkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-apk-'));
  const db = { device: { findFirst: async ({ where }) => (where.name === row.name || where.id === row.id ? row : null) } };
  const audits = [];
  const adbStub = { ops: { PACKAGE_LIST: 'package-list', PACKAGE_INFO: 'package-info', APK_PUSH: 'apk-push', APK_INSTALL: 'apk-install', APK_UNINSTALL: 'apk-uninstall', UIA_DUMP: 'uia-dump', DEVICE_READ: 'device-read', INPUT_TAP: 'input-tap', DUMPSYS: 'dumpsys' }, run: async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false }) };
  const svc = createAppService({ db, adb: adbStub, config: { waApkDir: apkDir, waApkMaxBytes: 1024, waUiaMaxBytes: 65536 }, audit: async (a) => audits.push(a) });
  return { svc, adbStub, apkDir, db, audits, row, cleanup: () => fs.rmSync(apkDir, { recursive: true, force: true }) };
}

const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.apiCode; } };

test('APK gate: illegal file names rejected before any fs touch', async (t) => {
  const s = setup(); t.after(s.cleanup);
  for (const bad of ['../evil.apk', 'a/b.apk', 'no-suffix', 'a.apk.txt', '', '.hidden.apk', 'a b.apk', 'a;id.apk', 'x'.repeat(200) + '.apk', 'a$b.apk', null, 42]) {
    assert.equal(await codeOf(s.svc.__resolveApkFile(bad)), 'APK_FILE_INVALID', `name ${String(bad)} must be invalid`);
  }
});

test('APK gate: missing dir 503; missing file 404; non-ZIP 422; oversize 413; happy path ok', async (t) => {
  const s = setup(); t.after(s.cleanup);
  // dir exists (mkdtemp). Missing file:
  assert.equal(await codeOf(s.svc.__resolveApkFile('absent.apk')), 'APK_FILE_NOT_FOUND');
  // corrupt (wrong magic)
  fs.writeFileSync(path.join(s.apkDir, 'bad.apk'), 'not a zip at all');
  assert.equal(await codeOf(s.svc.__resolveApkFile('bad.apk')), 'APK_CORRUPT');
  // empty
  fs.writeFileSync(path.join(s.apkDir, 'zero.apk'), '');
  assert.equal(await codeOf(s.svc.__resolveApkFile('zero.apk')), 'APK_CORRUPT');
  // oversize (cap = 1024)
  fs.writeFileSync(path.join(s.apkDir, 'big.apk'), Buffer.concat([ZIP.subarray(0, 4), Buffer.alloc(2000)]));
  assert.equal(await codeOf(s.svc.__resolveApkFile('big.apk')), 'APK_TOO_LARGE');
  // symlink escape: a symlink pointing OUTSIDE the dir fails containment
  const outside = path.join(os.tmpdir(), `wa-outside-${process.pid}.apk`);
  fs.writeFileSync(outside, ZIP);
  fs.symlinkSync(outside, path.join(s.apkDir, 'link.apk'));
  assert.equal(await codeOf(s.svc.__resolveApkFile('link.apk')), 'APK_FILE_INVALID', 'symlink escape must be rejected');
  // happy
  fs.writeFileSync(path.join(s.apkDir, 'good.apk'), ZIP);
  const ok = await s.svc.__resolveApkFile('good.apk');
  assert.equal(ok.size, ZIP.length);
  fs.rmSync(outside, { force: true });
});

test('APK gate: absent managed dir = 503 APK_DIR_UNAVAILABLE', async (t) => {
  const apkDir = path.join(os.tmpdir(), 'wa-does-not-exist-dir');
  fs.rmSync(apkDir, { recursive: true, force: true });
  const db = { device: { findFirst: async () => ({ id: 'd', name: 'n', adbPort: 1, containerState: 'running' }) } };
  const svc = createAppService({ db, adb: { ops: {}, run: async () => ({ exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: false }) }, config: { waApkDir: apkDir } });
  assert.equal(await codeOf(svc.__resolveApkFile('x.apk')), 'APK_DIR_UNAVAILABLE');
});

test('device precondition: stopped container = 409 APP_DEVICE_NOT_RUNNING (未執行); unknown = 404', async (t) => {
  const s = setup({ row: { id: 'd1', name: 'redroid-x', adbPort: 1, containerState: 'exited' } }); t.after(s.cleanup);
  assert.equal(await codeOf(s.svc.listPackages('redroid-x')), 'APP_DEVICE_NOT_RUNNING');
  assert.equal(await codeOf(s.svc.foregroundApp('redroid-x')), 'APP_DEVICE_NOT_RUNNING');
  assert.equal(await codeOf(s.svc.listPackages('nope'), {}), 'REDROID_DEVICE_NOT_FOUND');
});

test('uninstall: package-shape validation happens BEFORE adb (injected names 400)', async (t) => {
  const s = setup(); t.after(s.cleanup);
  for (const bad of ['com.example;id', 'Com.Ex', 'single', 'com.example app']) {
    assert.equal(await codeOf(s.svc.uninstallApp('redroid-x', { packageName: bad })), 'VALIDATION_ERROR', `${bad} must 400`);
    assert.equal(await codeOf(s.svc.packageInfo('redroid-x', bad)), 'VALIDATION_ERROR');
    assert.equal(await codeOf(s.svc.listPackages('redroid-x', { filter: bad })), 'VALIDATION_ERROR');
  }
});

test('engine unavailable (exitCode null) maps to 502 ADB_UNAVAILABLE, not offline', async (t) => {
  const apkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-apk-')); t.after(() => fs.rmSync(apkDir, { recursive: true, force: true }));
  const db = { device: { findFirst: async () => ({ id: 'd1', name: 'n', adbPort: 1, containerState: 'running' }) } };
  const adb = { ops: { PACKAGE_LIST: 'package-list' }, run: async () => ({ exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: false }) };
  const svc = createAppService({ db, adb, config: { waApkDir: apkDir } });
  assert.equal(await codeOf(svc.listPackages('n')), 'ADB_UNAVAILABLE');
});

test('uninstall failure: device Failure verdict → APK code + error audit recorded', async (t) => {
  const s = setup(); t.after(s.cleanup);
  const calls = [];
  const adb = {
    ops: { APK_UNINSTALL: 'apk-uninstall' },
    run: async (p) => { calls.push(p); return { exitCode: 1, stdout: 'Failure [DELETE_FAILED_INTERNAL_ERROR]', stderr: '', truncated: false, timedOut: false }; },
  };
  const svc = createAppService({ db: s.db, adb, config: {}, audit: async (a) => s.audits.push(a) });
  assert.equal(await codeOf(svc.uninstallApp('redroid-x', { packageName: 'com.demo.app' })), 'APP_UNINSTALL_FAILED');
  assert.equal(s.audits.at(-1).status, 'error');
  assert.match(s.audits.at(-1).details.deviceVerdict, /DELETE_FAILED/);
});

test('focus parse: mCurrentFocus preferred; mFocusedApp fallback; none = null pair', async (t) => {
  const s = setup(); t.after(s.cleanup);
  const mk = (stdout) => {
    const adb = { ops: { DUMPSYS: 'dumpsys' }, run: async () => ({ exitCode: 0, stdout, stderr: '', truncated: false, timedOut: false }) };
    return createAppService({ db: s.db, adb, config: {} });
  };
  const a = await mk('  mCurrentFocus=Window{abc u0 com.demo/com.demo.Main}\n').foregroundApp('redroid-x');
  assert.deepEqual(a.foreground, { package: 'com.demo', activity: 'com.demo.Main' });
  const b = await mk('  mCurrentFocus=null\n  mFocusedApp=AppWindowToken{x u0 com.demo/com.demo.Splash}').foregroundApp('redroid-x');
  assert.deepEqual(b.foreground, { package: 'com.demo', activity: 'com.demo.Splash' });
  const c = await mk('no focus here').foregroundApp('redroid-x');
  assert.deepEqual(c.foreground, { package: null, activity: null });
  // honesty: never a login verdict
  assert.match(a.loginState, /activity-level/);
});

test('packageInfo: installed keyed on "Unable to find" ABSENCE — stable under truncation; version fields best-effort + honestly flagged (live 2026-10-27 W2 E3: 324KB dump, versionName at byte ~319K > 256KB cap silently false-negatived a real install)', async (t) => {
  const s = setup(); t.after(s.cleanup);
  const bigPad = 'x'.repeat(300 * 1024); // resolver-table bulk before the per-package tail
  const fullDump = `${bigPad}\nPackages:\n  Package [com.demo.app] (abc123):\n    versionCode=163 minSdk=18 targetSdk=35\n    versionName=2.16.1\n`;
  const tailDropped = fullDump.slice(0, 200 * 1024); // header + version lines cut away
  s.adbStub.run = async () => ({ exitCode: 0, stdout: fullDump, stderr: '', truncated: false, timedOut: false });
  const full = await s.svc.packageInfo('redroid-x', 'com.demo.app');
  assert.equal(full.installed, true);
  assert.equal(full.versionCode, '163');
  assert.equal(full.versionName, '2.16.1');

  s.adbStub.run = async () => ({ exitCode: 0, stdout: tailDropped, stderr: '', truncated: true, timedOut: false });
  const trunc = await s.svc.packageInfo('redroid-x', 'com.demo.app');
  assert.equal(trunc.installed, true, 'a cap truncation must NOT flip a real install to absent');
  assert.equal(trunc.versionCode, null, 'version fields are best-effort under truncation');
  assert.equal(trunc.versionName, null);
  assert.equal(trunc.truncated, true, 'truncation is surfaced honestly on the payload');

  s.adbStub.run = async () => ({ exitCode: 0, stdout: 'Unable to find package: com.demo.app\n', stderr: '', truncated: false, timedOut: false });
  const absent = await s.svc.packageInfo('redroid-x', 'com.demo.app');
  assert.equal(absent.installed, false);
});
