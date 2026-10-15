/**
 * ADB whitelist engine (施工 MD §1.2 / §7 / §10.3 硬規則).
 *
 * This is the ONLY way the platform talks to ADB. Rules, verbatim from the
 * workorder:
 *  - initial set = 3 whitelisted SHELL ops: `getprop` (allowlist property),
 *    `dumpsys <service>` (service allowlist), `logcat` (capped `-t <n>`)
 *  - plus 2 fixed NON-shell ops for the connectivity diagnostic zone:
 *    `connect` / `get-state` (no shell at all)
 *  - fixed binary path + argument ARRAYS + execFile/spawn — `shell: true`
 *    is FORBIDDEN; no user string ever reaches a shell
 *  - every argument is validated against a strict allowlist; injection
 *    attempts (`;`, `$(`, backtick, `|`, `>`, space, non-loopback targets)
 *    are all rejected
 *  - per-call timeout + stdout/stderr output caps (truncation is flagged,
 *    never silently dropped)
 *  - there is NO arbitrary-command endpoint and NO way to pass a custom
 *    binary, target host, or argument
 *
 * Targets are `127.0.0.1:<port>` ONLY (MD §1.2: ADB 只可綁定 127.0.0.1).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Buffer/string → utf8 string (real execFile resolves Buffers). */
function toText(v) {
  if (v === undefined || v === null) return '';
  return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
}

/** The complete op set. Anything else = not allowed. */
export const ADB_OPS = Object.freeze({
  GETPROP: 'getprop',
  DUMPSYS: 'dumpsys',
  LOGCAT: 'logcat',
  CONNECT: 'connect',
  GET_STATE: 'get-state',
});

/** dumpsys service allowlist (MD §1.2: 查詢指定 dumpsys). */
export const DUMPSYS_SERVICES = Object.freeze([
  'window', 'activity', 'package', 'meminfo', 'battery', 'display',
  'gfxinfo', 'input', 'power', 'wifi', 'connectivity', 'usb', 'cpu', 'mem', 'statusbar',
]);

/** getprop property allowlist (fixed set; the no-arg full dump is capped separately). */
export const GETPROP_PROPERTIES = Object.freeze([
  'ro.build.version.release', 'ro.build.version.sdk', 'ro.build.fingerprint',
  'ro.build.display.id', 'ro.build.date.utc', 'ro.product.model', 'ro.product.brand',
  'ro.product.name', 'ro.product.device', 'ro.serialno', 'ro.boot.serialno',
  'ro.debuggable', 'ro.secure', 'ro.kernel.version', 'ro.config.gpu',
  'ro.hardware.egl', 'ro.hardware.vulkan', 'androidboot.redroid_gpu_mode',
  'androidboot.redroid_width', 'androidboot.redroid_height', 'androidboot.redroid_dpi',
  'androidboot.redroid_fps', 'persist.sys.language', 'sys.boot_completed',
]);

/** ADB target = 127.0.0.1:<port> ONLY. localhost/::1/0.0.0.0/anything else = rejected. */
export const ADB_TARGET_RE = /^127\.0\.0\.1:([0-9]{1,5})$/;

/** @returns {boolean} target is exactly 127.0.0.1:<valid port> */
export function isValidAdbTarget(target) {
  if (typeof target !== 'string') return false;
  const m = ADB_TARGET_RE.exec(target);
  if (!m) return false;
  const port = Number(m[1]);
  return port >= 1 && port <= 65535;
}

/** getprop key shape (defense-in-depth before the allowlist check). */
const PROP_KEY_RE = /^[a-z0-9._-]{1,128}$/;

/**
 * Service-level error with a stable API code + HTTP status.
 */
export class AdbWhitelistError extends Error {
  constructor({ code, status, message }) {
    super(message ?? code);
    this.name = 'AdbWhitelistError';
    this.apiCode = code;
    this.statusCode = status;
    this.statusCodeNum = status;
  }
}

/**
 * Build the exact argv for an op. Pure function — unit-tested in isolation.
 * Throws AdbWhitelistError (VALIDATION_ERROR) on any violation.
 *
 * @param {object} p
 * @param {string} p.op  one of ADB_OPS
 * @param {string} [p.target]  `127.0.0.1:<port>` (required for device-scoped ops)
 * @param {string} [p.prop]    getprop key (must be in GETPROP_PROPERTIES)
 * @param {string} [p.service] dumpsys service (must be in DUMPSYS_SERVICES)
 * @param {number} [p.tail]    logcat line count (1..logcatTailMax)
 */
export function buildAdbArgv({ op, target, prop, service, tail, logcatTailMax = 5000 }) {
  const fail = (message) => {
    throw new AdbWhitelistError({ code: 'VALIDATION_ERROR', status: 400, message });
  };

  if (!Object.values(ADB_OPS).includes(op)) {
    fail(`adb op '${String(op).slice(0, 64)}' is not in the whitelist (allowed: ${Object.values(ADB_OPS).join(', ')})`);
  }

  const targetOk = (required) => {
    if (target === undefined || target === null || target === '') {
      if (required) fail('adb target (127.0.0.1:<port>) is required for this op');
      return false;
    }
    if (!isValidAdbTarget(target)) {
      fail(`adb target must be 127.0.0.1:<port> — got '${String(target).slice(0, 64)}' (0.0.0.0 / public / non-loopback are forbidden)`);
    }
    return true;
  };

  const t = (required = true) => (targetOk(required) ? ['-s', target] : []);

  switch (op) {
    case ADB_OPS.GETPROP: {
      if (prop === undefined || prop === null || prop === '') return [...t(), 'shell', 'getprop'];
      if (typeof prop !== 'string' || !PROP_KEY_RE.test(prop)) {
        fail(`getprop key has illegal characters (allowed: a-z 0-9 . _ -) — got '${String(prop).slice(0, 64)}'`);
      }
      if (!GETPROP_PROPERTIES.includes(prop)) {
        fail(`getprop key '${prop}' is not in the allowlist`);
      }
      return [...t(), 'shell', 'getprop', prop];
    }
    case ADB_OPS.DUMPSYS: {
      if (typeof service !== 'string' || !DUMPSYS_SERVICES.includes(service)) {
        fail(`dumpsys service '${String(service).slice(0, 64)}' is not in the allowlist`);
      }
      return [...t(), 'shell', 'dumpsys', service];
    }
    case ADB_OPS.LOGCAT: {
      // Strict integer — no string coercion (the route converts; the engine
      // stays honest about types).
      if (!Number.isInteger(tail) || tail < 1) fail('logcat tail must be a positive integer');
      if (tail > logcatTailMax) fail(`logcat tail ${tail} exceeds the cap of ${logcatTailMax}`);
      // -d (dump-and-exit) is appended SERVER-SIDE — the op can never stream.
      return [...t(), 'shell', 'logcat', '-d', '-t', String(tail)];
    }
    case ADB_OPS.CONNECT: {
      targetOk(true); // validate — `adb connect 127.0.0.1:<port>` (no -s)
      return ['connect', target];
    }
    case ADB_OPS.GET_STATE: {
      return [...t(), 'get-state'];
    }
    default:
      fail(`unknown op '${op}'`);
  }
}

/**
 * @param {object} deps
 * @param {string} [deps.adbBinary] fixed binary path (never user-controlled)
 * @param {number} [deps.timeoutMs]
 * @param {number} [deps.maxOutputBytes] stdout/stderr cap
 * @param {number} [deps.logcatTailMax]
 * @param {number} [deps.logcatTailDefault]
 * @param {Function} [deps.execFile] test seam — same signature as promisify(execFile): (bin, args, opts) => Promise<{stdout,stderr}>
 * @param {Function} [deps.log]
 */
export function createAdbWhitelist({
  adbBinary = '/usr/bin/adb',
  timeoutMs = 20_000,
  maxOutputBytes = 262_144,
  logcatTailMax = 5000,
  logcatTailDefault = 200,
  execFile: exec = execFileAsync,
  log = { warn() {} },
} = {}) {
  if (typeof adbBinary !== 'string' || !adbBinary.startsWith('/')) {
    throw new Error('adbBinary must be an absolute fixed path');
  }

  /**
   * Validate + run one whitelisted op.
   * Resolves with a full result (never throws for op-level failures):
   *   { op, target, argv, exitCode, stdout, stderr, truncated, timedOut, durationMs }
   * Throws AdbWhitelistError only for validation violations (400).
   */
  async function run({ op, target, prop, service, tail = logcatTailDefault }) {
    const argv = buildAdbArgv({ op, target, prop, service, tail, logcatTailMax });
    const startedAt = Date.now();

    const result = await new Promise((resolve) => {
      let settled = false;
      const settle = (r) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      const timer = setTimeout(() => settle({ timedOut: true }), timeoutMs);
      Promise.resolve()
        .then(() => exec(adbBinary, argv, { timeout: timeoutMs, maxBuffer: maxOutputBytes, killSignal: 'SIGKILL', windowsHide: true }))
        .then(
          ({ stdout, stderr }) => {
            clearTimeout(timer);
            const out = toText(stdout);
            const errOut = toText(stderr);
            settle({
              timedOut: false,
              exitCode: 0,
              stdout: out.slice(0, maxOutputBytes),
              stderr: errOut.slice(0, maxOutputBytes),
              truncated: out.length > maxOutputBytes || errOut.length > maxOutputBytes,
            });
          },
          (err) => {
            clearTimeout(timer);
            const timedOut = Boolean(err?.killed) || err?.code === 'ETIMEDOUT' || /timed? ?out/i.test(String(err?.message ?? ''));
            const out = toText(err?.stdout);
            const errOut = toText(err?.stderr ?? err?.message ?? '');
            settle({
              timedOut,
              exitCode: typeof err?.code === 'number' ? err.code : null,
              stdout: out.slice(0, maxOutputBytes),
              stderr: errOut.slice(0, maxOutputBytes),
              truncated: out.length > maxOutputBytes || errOut.length > maxOutputBytes,
            });
          },
        );
    });

    return {
      op,
      target: target ?? null,
      argv,
      durationMs: Date.now() - startedAt,
      exitCode: result.exitCode ?? null, // timer-settle path has no code — normalize to null
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      truncated: Boolean(result.truncated),
      timedOut: Boolean(result.timedOut),
    };
  }

  return {
    /** @returns {string[]} the fixed binary (evidence for audits/tests). */
    binary: () => adbBinary,
    buildArgv: (p) => buildAdbArgv({ logcatTailMax, ...p }),
    run,
    ops: ADB_OPS,
  };
}
