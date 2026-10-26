/**
 * W2 (ADR-026) — app lifecycle + UI-tree service (per redroid device).
 *
 * Owns: package listing/info, APK install/uninstall (managed host directory),
 * foreground activity probe, uiautomator dump → parsed tree, and tap-by-
 * selector. Every device interaction goes through the ADB whitelist engine —
 * this service never shells out.
 *
 * Login-state honesty (ADR-026 §3): the platform detects FOREGROUND PACKAGE +
 * ACTIVITY only (dumpsys window mCurrentFocus). Whether a given activity
 * means "logged in" is a business rule the owner defines on REAL devices —
 * this service reports the proxy metric, never a verdict.
 *
 * Fail-closed posture:
 *  - switch WA_APP_OPS_ENABLED off → routes answer 503 APP_OPS_DISABLED
 *  - device must be container-running for any adb op (else 409)
 *  - APK host path: strict filename RE + realpath containment + ZIP magic +
 *    size cap — a corrupt APK never reaches the device (no half-install)
 *  - install/uninstall success requires the device's own `Success` verdict
 *
 * Audit: every mutation (and the UI dump/tap, which push work onto the
 * device) is audited with action prefix `app.device.*`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { RedroidServiceError } from './redroid-service.js';
import { parseUiDump, pickTapTarget } from './ui-tree.js';

const fail = (code, status, message, details) => new RedroidServiceError({ code, status, message, details });

/** Host-side APK file name: flat, safe, .apk — no separators, no '..', no metachars. */
const APK_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.apk$/;
/** Java package name (same shape the whitelist enforces — service-level guard). */
const PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const clip = (s, n = 300) => String(s ?? '').slice(0, n);

/**
 * @param {object} deps
 * @param {object} deps.db prisma-shaped (device model)
 * @param {object} deps.adb AdbWhitelist engine (createAdbWhitelist result)
 * @param {object} [deps.config] waApkDir / waApkMaxBytes / waUiaMaxBytes / waUiaMaxNodes
 * @param {Function} [deps.audit]
 * @param {object} [deps.log]
 */
export function createAppService({ db, adb, config = {}, audit = async () => {}, log = { warn() {} } } = {}) {
  if (!db) throw new Error('createAppService: db is required');
  if (!adb) throw new Error('createAppService: adb engine is required');

  const apkDir = () => config.waApkDir ?? '/var/lib/water-army/apk';
  const maxApkBytes = () => config.waApkMaxBytes ?? 524_288_000; // 512 MiB
  const uiaMaxBytes = () => config.waUiaMaxBytes ?? 4_194_304; // 4 MiB
  const uiaMaxNodes = () => config.waUiaMaxNodes ?? 2000;

  async function findDevice(idOrName) {
    const where = /^[0-9a-f-]{36}$/i.test(String(idOrName)) ? { id: idOrName } : { name: idOrName };
    return db.device.findFirst({ where });
  }

  /** Device must exist AND be container-running — adb ops are fail-closed. */
  async function requireRunning(idOrName) {
    const row = await findDevice(idOrName);
    if (!row) throw fail('REDROID_DEVICE_NOT_FOUND', 404, `Device '${String(idOrName).slice(0, 64)}' not found`);
    if (row.containerState !== 'running') {
      throw fail('APP_DEVICE_NOT_RUNNING', 409, `device container state is '${row.containerState ?? 'unknown'}' — app ops need a running device (not executed = 未驗證)`);
    }
    return { row, target: `127.0.0.1:${row.adbPort}` };
  }

  const aud = (actor, action, row, status, details) =>
    audit({
      actorUserId: actor?.actorUserId ?? null,
      action,
      resourceType: 'redroid_device',
      resourceId: row?.id ?? null,
      requestId: actor?.requestId ?? null,
      ip: actor?.ip ?? null,
      status,
      details,
    });

  /** Engine result → did the DEVICE itself answer `Success`? */
  const deviceSaidSuccess = (res) => !res.timedOut && res.exitCode === 0 && /\bSuccess\b/.test(`${res.stdout}\n${res.stderr}`);

  // ---- packages ---------------------------------------------------------------

  /** GET /apps — `pm list packages` (optional package-shape filter). */
  async function listPackages(idOrName, { filter, actor } = {}) {
    const { row, target } = await requireRunning(idOrName);
    if (filter !== undefined && !PACKAGE_RE.test(String(filter))) {
      throw fail('VALIDATION_ERROR', 400, `filter '${clip(filter, 80)}' is not a valid package name`);
    }
    const res = await adb.run({ op: adb.ops.PACKAGE_LIST, target, packageName: filter });
    if (res.timedOut || res.exitCode === null) throw fail('ADB_UNAVAILABLE', 502, 'adb package-list could not run on this host');
    if (res.exitCode !== 0) throw fail('APP_LIST_FAILED', 502, `pm list packages failed: ${clip(res.stderr || res.stdout)}`);
    const packages = res.stdout
      .split('\n')
      .map((l) => /^package:(.+)$/.exec(l)?.[1])
      .filter(Boolean);
    const unique = [...new Set(packages)].sort();
    await aud(actor, 'app.device.packages', row, 'success', { name: row.name, count: unique.length, filter: filter ?? null, truncated: res.truncated || undefined });
    return { device: row.name, count: unique.length, truncated: res.truncated, packages: unique };
  }

  // `dumpsys package <installed>` is LARGE — global resolver tables dominate
  // the output and the per-package tail (header + versionCode/versionName)
  // is the LAST ~15 lines (live 2026-10-27 W2 E3: versionName at byte ~319K
  // of a 324K dump). The engine's 256KB default cap truncates that tail, so
  // this op gets a dedicated 1MiB read cap (well under the 4MiB hard
  // kill-buffer). A 256KB report cap is fine for getprop/dumpsys/logcat.
  const PACKAGE_INFO_READ_BYTES = 1_048_576;

  /** Version/existence via `dumpsys package <pkg>` (the device is the truth). */
  async function packageInfo(idOrName, packageName, { actor } = {}) {
    const { row, target } = await requireRunning(idOrName);
    if (!PACKAGE_RE.test(String(packageName))) {
      throw fail('VALIDATION_ERROR', 400, `package '${clip(packageName, 80)}' is not a valid package name`);
    }
    const res = await adb.run({ op: adb.ops.PACKAGE_INFO, target, packageName, maxOutputBytes: PACKAGE_INFO_READ_BYTES });
    if (res.timedOut || res.exitCode === null) throw fail('ADB_UNAVAILABLE', 502, 'adb package-info could not run on this host');
    const out = `${res.stdout}\n${res.stderr}`;
    // Installed and absent BOTH exit 0 — the discriminator is the message.
    // `dumpsys package <absent>` emits exactly "Unable to find package: <pkg>"
    // (tiny output, never truncated), so keying `installed` on the ABSENCE of
    // that line is stable under any truncation. Keying it on versionName= (a
    // TAIL line, live byte ~319K) silently false-negatived real installs the
    // moment a cap truncation dropped the tail (live 2026-10-27 W2 E3).
    // versionCode/versionName stay best-effort: null when truncated away,
    // with `truncated` flagged honestly on the payload.
    const absentRe = new RegExp(`Unable to find package: ${packageName.replace(/\./g, '\\.')}$`, 'm');
    const installed = !absentRe.test(out);
    const info = {
      device: row.name,
      package: packageName,
      installed,
      versionCode: installed ? /versionCode=([A-Za-z0-9.]+)/.exec(out)?.[1] ?? null : null,
      versionName: installed ? /versionName=(\S+)/.exec(out)?.[1] ?? null : null,
      truncated: res.truncated || undefined,
      // Honest scope: pm/dumpsys CANNOT see an app's internal login state.
      loginState: 'unknown (activity-level detection only — ADR-026 §3)',
    };
    await aud(actor, 'app.device.package_info', row, 'success', { name: row.name, package: packageName, installed, truncated: res.truncated || undefined });
    return info;
  }

  // ---- APK lifecycle ------------------------------------------------------------

  /**
   * Host-side APK gate (managed directory, defense in depth):
   * filename RE → realpath containment DIRECTLY inside the managed dir →
   * regular file → size cap → ZIP magic. Anything else fails BEFORE a byte
   * reaches the device (corrupt APK = fail-closed, no half-install).
   */
  async function resolveApkFile(fileName) {
    if (typeof fileName !== 'string' || !APK_FILE_RE.test(fileName) || path.basename(fileName) !== fileName) {
      throw fail('APK_FILE_INVALID', 400, `apk file name '${clip(fileName, 120)}' is illegal (flat safe name ending .apk — no path separators, no '..')`);
    }
    let dirReal;
    try {
      dirReal = await fs.realpath(apkDir());
    } catch {
      throw fail('APK_DIR_UNAVAILABLE', 503, `managed APK directory '${apkDir()}' is not present on this host`);
    }
    const candidate = path.resolve(dirReal, fileName);
    let real;
    try {
      real = await fs.realpath(candidate);
    } catch {
      throw fail('APK_FILE_NOT_FOUND', 404, `apk '${fileName}' not found in the managed directory`);
    }
    if (path.dirname(real) !== dirReal) {
      throw fail('APK_FILE_INVALID', 400, 'apk path escapes the managed directory (symlink or traversal)');
    }
    const st = await fs.stat(real);
    if (!st.isFile()) throw fail('APK_FILE_INVALID', 400, 'apk path is not a regular file');
    if (st.size === 0) throw fail('APK_CORRUPT', 422, 'apk is empty (0 bytes) — refusing to install');
    if (st.size > maxApkBytes()) {
      throw fail('APK_TOO_LARGE', 413, `apk size ${st.size} exceeds the ${maxApkBytes()}-byte cap`);
    }
    const head = Buffer.alloc(4);
    const fh = await fs.open(real, 'r');
    try {
      await fh.read(head, 0, 4, 0);
    } finally {
      await fh.close();
    }
    if (!head.equals(ZIP_MAGIC)) {
      throw fail('APK_CORRUPT', 422, 'apk is not a readable ZIP (bad magic bytes) — refusing to install a corrupt file');
    }
    return { real, size: st.size };
  }

  /** Install = host gate → push → `pm install -r` → device's own Success verdict. */
  async function installApk(idOrName, { fileName, actor } = {}) {
    const { row, target } = await requireRunning(idOrName);
    const { real, size } = await resolveApkFile(fileName);
    const devicePath = `/data/local/tmp/wa_${fileName}`;

    const push = await adb.run({ op: adb.ops.APK_PUSH, target, localPath: real, devicePath });
    if (push.timedOut || push.exitCode === null) throw fail('ADB_UNAVAILABLE', 502, 'adb push could not run on this host');
    if (push.exitCode !== 0 || /error:/i.test(String(push.stderr))) {
      await aud(actor, 'app.device.install', row, 'error', { name: row.name, fileName, stage: 'push', stderr: clip(push.stderr || push.stdout) });
      throw fail('APK_PUSH_FAILED', 502, `adb push failed: ${clip(push.stderr || push.stdout)}`);
    }

    const inst = await adb.run({ op: adb.ops.APK_INSTALL, target, devicePath });
    if (inst.timedOut || inst.exitCode === null) throw fail('ADB_UNAVAILABLE', 502, 'pm install could not run on this host');
    if (!deviceSaidSuccess(inst)) {
      const msg = clip(inst.stdout || inst.stderr);
      await aud(actor, 'app.device.install', row, 'error', { name: row.name, fileName, stage: 'install', deviceVerdict: msg });
      // Fail-closed: there is no half-installed PLATFORM state to unwind — the
      // device decides atomically; the tmp file is overwritten by the next
      // push (device-rm is not whitelisted; see ADR-026 §4).
      throw fail('APK_INSTALL_FAILED', 502, `pm install rejected the apk: ${msg || 'no Success verdict from device'}`);
    }
    await aud(actor, 'app.device.install', row, 'success', { name: row.name, fileName, bytes: size });
    return { device: row.name, fileName, bytes: size, installed: true, devicePath };
  }

  /** Uninstall = `pm uninstall` + device verdict. */
  async function uninstallApp(idOrName, { packageName, actor } = {}) {
    const { row, target } = await requireRunning(idOrName);
    if (!PACKAGE_RE.test(String(packageName))) {
      throw fail('VALIDATION_ERROR', 400, `package '${clip(packageName, 80)}' is not a valid package name`);
    }
    const res = await adb.run({ op: adb.ops.APK_UNINSTALL, target, packageName });
    if (res.timedOut || res.exitCode === null) throw fail('ADB_UNAVAILABLE', 502, 'pm uninstall could not run on this host');
    if (!deviceSaidSuccess(res)) {
      const msg = clip(res.stdout || res.stderr);
      await aud(actor, 'app.device.uninstall', row, 'error', { name: row.name, package: packageName, deviceVerdict: msg });
      throw fail('APP_UNINSTALL_FAILED', 502, `pm uninstall rejected: ${msg || 'no Success verdict from device'}`);
    }
    await aud(actor, 'app.device.uninstall', row, 'success', { name: row.name, package: packageName });
    return { device: row.name, package: packageName, uninstalled: true };
  }

  // ---- foreground probe (login-state PROXY, activity level only) ------------------

  /** Parse `mCurrentFocus=Window{... u0 pkg/activity}` from dumpsys window. */
  function parseFocus(stdout) {
    const m = /mCurrentFocus=Window\{[^ ]+ u\d+ ([^\s/]+)\/([^\s}]+)/.exec(stdout ?? '');
    if (m) return { package: m[1], activity: m[2] };
    const app = /mFocusedApp=[^{]*\{[^ ]+ u\d+ ([^\s/]+)\/([^\s} ]+)/.exec(stdout ?? '');
    if (app) return { package: app[1], activity: app[2] };
    return { package: null, activity: null };
  }

  async function foregroundApp(idOrName, { actor } = {}) {
    const { row, target } = await requireRunning(idOrName);
    const res = await adb.run({ op: adb.ops.DUMPSYS, target, service: 'window' });
    if (res.timedOut || res.exitCode === null) throw fail('ADB_UNAVAILABLE', 502, 'dumpsys window could not run on this host');
    const { package: pkg, activity } = parseFocus(res.stdout);
    const out = {
      device: row.name,
      foreground: { package: pkg, activity },
      // ADR-026 §3 — proxy metric ONLY; login rules are owner-defined (real-device phase).
      loginState: 'unknown (activity-level detection only)',
      evidence: clip(res.stdout, 500),
      truncated: res.truncated,
    };
    await aud(actor, 'app.device.foreground', row, 'success', { name: row.name, package: pkg, activity });
    return out;
  }

  // ---- UI tree + tap ---------------------------------------------------------------

  const dumpPathOf = (target) => adb.buildArgv({ op: adb.ops.UIA_DUMP, target }).at(-1);

  /** Internal: uiautomator dump → read-back (bounded) → parse. */
  async function dumpAndParse(target) {
    const dump = await adb.run({ op: adb.ops.UIA_DUMP, target });
    if (dump.timedOut || dump.exitCode === null) throw fail('ADB_UNAVAILABLE', 502, 'uiautomator could not run on this host');
    const dumpOut = `${dump.stdout}\n${dump.stderr}`;
    if (dump.exitCode !== 0 || !/dumped to/i.test(dumpOut)) {
      // classic real-world failure: 'could not get idle state' — honest passthrough
      throw fail('UIA_DUMP_FAILED', 502, `uiautomator dump failed: ${clip(dumpOut)}`);
    }
    const cap = uiaMaxBytes();
    const read = await adb.run({ op: adb.ops.DEVICE_READ, target, devicePath: dumpPathOf(target), maxOutputBytes: cap });
    if (read.timedOut || read.exitCode === null) throw fail('ADB_UNAVAILABLE', 502, 'adb exec-out could not run on this host');
    if (read.exitCode !== 0) throw fail('UIA_DUMP_FAILED', 502, `dump read-back failed: ${clip(read.stderr || read.stdout)}`);
    if (read.truncated) {
      throw fail('UIA_DUMP_TOO_LARGE', 522, `ui hierarchy exceeds the ${cap}-byte read cap — the XML would be incomplete (raise WA_UIA_MAX_BYTES or simplify the screen)`);
    }
    const parsed = parseUiDump(read.stdout, { maxBytes: cap, maxNodes: uiaMaxNodes() });
    return parsed;
  }

  const elementView = (n) => ({
    resourceId: n.resourceId || null,
    text: n.text || null,
    contentDesc: n.contentDesc || null,
    className: n.className,
    clickable: n.clickable,
    bounds: n.bounds,
  });

  /** POST /ui/dump — fresh hierarchy + parsed (bounded) node list. */
  async function dumpUi(idOrName, { actor } = {}) {
    const { row, target } = await requireRunning(idOrName);
    const started = Date.now();
    const { nodes, stats } = await dumpAndParse(target);
    await aud(actor, 'app.device.ui_dump', row, 'success', { name: row.name, nodes: stats.parsed, skipped: stats.skippedMalformed, ms: Date.now() - started });
    return {
      device: row.name,
      dumpPath: dumpPathOf(target),
      durationMs: Date.now() - started,
      stats,
      nodeLimit: uiaMaxNodes(),
      nodes: nodes.map(elementView),
    };
  }

  /**
   * POST /ui/tap — ONE fresh dump, resolve the selector (explicit
   * NOT_FOUND / AMBIGUOUS / OFFSCREEN contract), tap the element center.
   * The screen bounds for the OFFSCREEN check come from the device's own
   * template geometry when available.
   */
  async function tapBySelector(idOrName, { selector, actor } = {}) {
    const { row, target } = await requireRunning(idOrName);
    const started = Date.now();
    const { nodes } = await dumpAndParse(target);
    const screen = Number.isInteger(row.width) && Number.isInteger(row.height) ? { screenWidth: row.width, screenHeight: row.height } : {};
    const { x, y, element } = pickTapTarget(nodes, selector, screen);
    const res = await adb.run({ op: adb.ops.INPUT_TAP, target, x, y });
    if (res.timedOut || res.exitCode === null) throw fail('ADB_UNAVAILABLE', 502, 'adb input tap could not run on this host');
    if (res.exitCode !== 0) {
      await aud(actor, 'app.device.ui_tap', row, 'error', { name: row.name, x, y, stderr: clip(res.stderr || res.stdout) });
      throw fail('UIA_TAP_FAILED', 502, `input tap failed: ${clip(res.stderr || res.stdout)}`);
    }
    await aud(actor, 'app.device.ui_tap', row, 'success', { name: row.name, x, y, resourceId: element.resourceId || undefined });
    return {
      device: row.name,
      tapped: { x, y },
      element: elementView(element),
      selector,
      durationMs: Date.now() - started,
    };
  }

  return {
    listPackages,
    packageInfo,
    installApk,
    uninstallApp,
    foregroundApp,
    dumpUi,
    tapBySelector,
    // test seam
    __resolveApkFile: resolveApkFile,
  };
}
