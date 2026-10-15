/**
 * Redroid host preflight (施工 MD §10.1) — repeatable, safe, READ-ONLY host
 * check. Runs BEFORE device start; the result is displayed independently in
 * the diagnostics page (kernel zone) and as warnings on create/start.
 *
 * Hard rules (MD §2.8 / §10.1):
 *  - fixed binary paths + argument arrays + execFile — `shell: true` is
 *    FORBIDDEN; nothing user-supplied ever reaches a shell
 *  - per-check timeout + output caps (dmesg lines capped, exec output capped)
 *  - every check reports honestly: unreadable/unavailable = `unknown`,
 *    NEVER "present" or "supported"
 *  - suggestions only (modprobe lines + official doc link) — the app never
 *    installs kernel modules or mutates the host (MD §10.1)
 *
 * A failed preflight is a WARNING, not the sole verdict (MD §2.3): device
 * create/start still proceed and the honest state (未驗證) is displayed.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';

const execFileAsync = promisify(execFile);

/** Buffer/string → utf8 string (real execFile resolves Buffers). */
function toText(v) {
  if (v === undefined || v === null) return '';
  return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
}

/** Fixed candidate paths per binary — resolved once, no `which`/shell. */
const BINARY_CANDIDATES = Object.freeze({
  uname: ['/usr/bin/uname', '/bin/uname'],
  dmesg: ['/usr/bin/dmesg', '/bin/dmesg'],
  'nvidia-smi': ['/usr/bin/nvidia-smi', '/usr/local/bin/nvidia-smi'],
});

/** Binder/ashmem device nodes Redroid may need (MD §10.1). */
const DEV_PATHS = Object.freeze(['/dev/binder', '/dev/binder_hwbinder', '/dev/ashmem']);

const DMESG_RELEVANT = /binder|ashmem/i;
const DMESG_MAX_LINES = 20;

/**
 * Resolve a binary from its fixed candidate list.
 * @param {string} name
 * @param {(path:string, mode:number)=>void} accessSync
 * @returns {string|null}
 */
export function resolveBinary(name, accessSync) {
  for (const p of BINARY_CANDIDATES[name] ?? []) {
    try {
      accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * Run one fixed binary with an argument array (no shell), bounded.
 * @param {object} p
 * @param {string} p.bin
 * @param {string[]} p.args
 * @param {number} p.timeoutMs
 * @param {number} p.maxBytes
 * @param {(bin:string, args:string[], opts:object)=>Promise<{code:number, stdout:string, stderr:string}>} [p.exec]
 */
async function runBounded({ bin, args, timeoutMs, maxBytes, exec = execFileAsync }) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const timer = setTimeout(() => settle({ code: null, stdout: '', stderr: '', timedOut: true }), timeoutMs);
    Promise.resolve()
      .then(() =>
        exec(bin, args, { timeout: timeoutMs, maxBuffer: maxBytes, killSignal: 'SIGKILL', windowsHide: true }),
      )
      .then(
        ({ stdout, stderr }) => {
          clearTimeout(timer);
          settle({
            code: 0,
            stdout: toText(stdout).slice(0, maxBytes),
            stderr: toText(stderr).slice(0, maxBytes),
            timedOut: false,
          });
        },
        (err) => {
          clearTimeout(timer);
          settle({
            code: err?.code === 'ENOENT' ? null : typeof err?.code === 'number' ? err.code : err?.code,
            stdout: toText(err?.stdout).slice(0, maxBytes),
            stderr: toText(err?.stderr ?? err?.message ?? 'error').slice(0, maxBytes),
            timedOut: Boolean(err?.killed) || err?.code === 'ETIMEDOUT' || err?.message === 'timed out',
          });
        },
      );
  });
}

/**
 * @param {object} deps
 * @param {object} deps.config API config (redroidPreflight* knobs)
 * @param {{ping:()=>Promise<any>}} [deps.docker] docker wrapper (availability only)
 * @param {boolean} [deps.gpuMode] check GPU/driver info when 'host'
 * @param {number} [deps.port] check this specific host port on 127.0.0.1
 * @param {Function} [deps.log]
 * @param {Function} [deps.exec] test seam — (bin, args, opts) => {code,stdout,stderr}
 * @param {Function} [deps.accessSync] test seam — (path, mode) sync
 * @param {Function} [deps.readProcModules] test seam — () => string|null
 * @param {Function} [deps.statfs] test seam — async (path) => {bavail, bsize}
 * @param {string} [deps.gpuBin] test seam — fixed nvidia-smi path override
 */
export async function runRedroidPreflight({
  config,
  docker,
  gpuMode = false,
  port,
  log = { warn() {}, error() {} },
  exec,
  accessSync = fs.accessSync,
  readProcModules = readProcModulesImpl,
  statfs = fs.promises.statfs,
  gpuBin,
} = {}) {
  const timeoutMs = config?.redroidPreflightTimeoutMs ?? 5000;
  const maxBytes = config?.redroidPreflightMaxOutput ?? 65_536;
  const dataRoot = config?.redroidDataRoot ?? '/var/lib/water-army/redroid';
  const isLinux = os.platform() === 'linux';

  // ---- host / kernel -------------------------------------------------------
  let kernel = null;
  let kernelSource = 'os.release()';
  const unameBin = resolveBinary('uname', accessSync);
  if (unameBin) {
    const r = await runBounded({ bin: unameBin, args: ['-r'], timeoutMs, maxBytes, exec });
    if (r.code === 0 && r.stdout.trim()) {
      kernel = r.stdout.trim().split('\n')[0].slice(0, 128);
      kernelSource = 'uname -r';
    }
  }
  if (!kernel) kernel = os.release() || null;

  // ---- docker daemon -------------------------------------------------------
  let dockerState = { available: null, error: null };
  if (docker?.ping) {
    try {
      await docker.ping();
      dockerState = { available: true, error: null };
    } catch (err) {
      dockerState = { available: false, error: String(err?.message ?? err).slice(0, 200) };
    }
  }

  // ---- binder / ashmem ------------------------------------------------------
  const modulesText = readProcModules();
  const moduleStates = {
    binder_linux: modulesText === null ? 'unknown' : /(^|\n)\s*binder_linux\s/.test(modulesText) ? 'present' : 'absent',
    ashmem_linux: modulesText === null ? 'unknown' : /(^|\n)\s*ashmem_linux\s/.test(modulesText) ? 'present' : 'absent',
  };
  const devices = {};
  for (const p of DEV_PATHS) {
    try {
      accessSync(p, fs.constants.F_OK);
      devices[p] = true;
    } catch {
      devices[p] = false;
    }
  }

  const dmesgBin = resolveBinary('dmesg', accessSync);
  let dmesg = { readable: false, relevantLines: [] };
  if (dmesgBin) {
    const r = await runBounded({ bin: dmesgBin, args: [], timeoutMs, maxBytes, exec });
    if (r.code === 0) {
      const lines = r.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && DMESG_RELEVANT.test(l))
        .slice(0, DMESG_MAX_LINES)
        .map((l) => l.slice(0, 300));
      dmesg = { readable: true, relevantLines: lines };
    } else if (r.timedOut) {
      dmesg = { readable: false, relevantLines: [], note: 'dmesg timed out' };
    } else {
      dmesg = { readable: false, relevantLines: [], note: String(r.stderr).slice(0, 160) };
    }
  }

  // Honest tri-state: every input must positively confirm before 'true'.
  const binderUnknown = !isLinux || moduleStates.binder_linux === 'unknown' || moduleStates.ashmem_linux === 'unknown';
  const binderOk =
    moduleStates.binder_linux === 'present' && moduleStates.ashmem_linux === 'present' && devices['/dev/binder'] === true;
  const binderSupported = binderUnknown ? 'unknown' : binderOk ? true : false;

  const supported = !isLinux
    ? 'unsupported'
    : dockerState.available === false
      ? 'unknown' // daemon state may be transient — don't overclaim
      : dockerState.available === true
        ? binderSupported === 'unknown'
          ? 'unknown'
          : binderSupported
            ? 'supported'
            : 'unsupported'
        : 'unknown';

  const suggestions = [];
  if (moduleStates.binder_linux !== 'present') {
    suggestions.push(
      'Load the binder module (requires root): modprobe binder_linux devices="binder,hwbinder,vndbinder"',
    );
  }
  if (moduleStates.ashmem_linux !== 'present') {
    suggestions.push(
      'Load ashmem if this kernel provides it (requires root; newer kernels may use memfd instead): modprobe ashmem_linux',
    );
  }
  if (!devices['/dev/binder']) {
    suggestions.push('Ensure /dev/binder (and /dev/binder_hwbinder) exist and are accessible by the api service.');
  }
  suggestions.push('Official docs: https://github.com/remote-android/redroid-doc — verify the exact procedure for this kernel before booting Redroid.');

  // ---- disk -----------------------------------------------------------------
  let disk = { dataRoot, exists: false, writable: false, freeBytes: null };
  try {
    accessSync(dataRoot, fs.constants.W_OK);
    disk = { dataRoot, exists: true, writable: true, freeBytes: null };
    const st = await statfs(dataRoot);
    disk.freeBytes = Math.max(0, (st.bavail ?? 0) * (st.bsize ?? 4096));
  } catch (err) {
    try {
      accessSync(dataRoot, fs.constants.F_OK);
      disk = { dataRoot, exists: true, writable: false, freeBytes: null, note: 'not writable by the api user' };
    } catch {
      disk = { dataRoot, exists: false, writable: false, freeBytes: null, note: 'data root does not exist (create it before device data persistence)' };
    }
  }

  // ---- port -----------------------------------------------------------------
  let ports = null;
  if (Number.isInteger(port) && port > 0) {
    ports = { port, state: await checkPortAvailable(port, { timeoutMs }) };
  }

  // ---- gpu (informational only — MD §2.4: nvidia-smi OK ≠ Redroid GPU OK) ---
  let gpu = null;
  if (gpuMode) {
    gpu = await checkGpu({ timeoutMs, maxBytes, exec, accessSync, gpuBin });
  }

  // ---- rollup ----------------------------------------------------------------
  const warnings = [];
  if (!isLinux) warnings.push('Host is not Linux — Redroid containers cannot run on this platform.');
  if (dockerState.available === false) warnings.push(`Docker daemon unavailable: ${dockerState.error}`);
  if (moduleStates.binder_linux === 'absent') warnings.push('Kernel module binder_linux is NOT loaded — Redroid boot will fail on this host.');
  if (moduleStates.ashmem_linux === 'absent') warnings.push('Kernel module ashmem_linux is NOT loaded (may be built-in/memfd on newer kernels — check dmesg).');
  if (disk.freeBytes !== null && disk.freeBytes < 4 * 1024 * 1024 * 1024) warnings.push(`Less than 4 GiB free under ${dataRoot} — device /data persistence will exhaust quickly.`);
  if (gpu && !gpu.verified) warnings.push('GPU is NOT verified for Redroid rendering — nvidia-smi success does not prove Android EGL/WebGL works (MD §2.4).');

  return {
    checkedAt: new Date().toISOString(),
    host: { platform: os.platform(), isLinux, kernel, kernelSource },
    docker: dockerState,
    binder: {
      modules: moduleStates,
      devices,
      dmesg,
      supported: binderSupported,
      suggestions,
    },
    disk,
    ports,
    gpu,
    overall: supported,
    warnings,
  };
}

function readProcModulesImpl() {
  try {
    return fs.readFileSync('/proc/modules', 'utf8');
  } catch {
    return null; // honest: unreadable ≠ absent
  }
}

/**
 * Fixed-argument nvidia-smi query (MD §10.1). The result NEVER flips GPU
 * status to verified — it is evidence the host has a driver, not that
 * Redroid renders through it (MD §2.4).
 */
async function checkGpu({ timeoutMs, maxBytes, exec, accessSync = fs.accessSync, gpuBin }) {
  const candidates = gpuBin ? [gpuBin] : BINARY_CANDIDATES['nvidia-smi'];
  let bin = null;
  for (const p of candidates) {
    try {
      accessSync(p, fs.constants.X_OK);
      bin = p;
      break;
    } catch {
      /* next */
    }
  }
  if (!bin) return { available: false, driverVersion: null, gpus: [], verified: false, note: 'nvidia-smi not found' };

  const r = await runBounded({
    bin,
    args: ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'],
    timeoutMs,
    maxBytes,
    exec,
  });
  if (r.code !== 0) {
    return { available: false, driverVersion: null, gpus: [], verified: false, note: String(r.stderr).slice(0, 160) };
  }
  const gpus = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name = '', mem = '', driver = ''] = l.split(',').map((s) => s.trim());
      return { name, memory: mem || null, driverVersion: driver || null };
    })
    .slice(0, 8);
  return {
    available: gpus.length > 0,
    driverVersion: gpus[0]?.driverVersion ?? null,
    gpus,
    verified: false, // HARD RULE — only in-device, reproducible checks may claim verified
    note: 'nvidia-smi success ≠ Redroid GPU verified (MD §2.4). Status stays 未驗證 until an in-device render check exists.',
  };
}

/**
 * Is `port` already bound on 127.0.0.1? (MD §10.1 "port 是否已被佔用")
 * @returns {Promise<'free'|'occupied'|'unknown'>}
 */
export function checkPortAvailable(port, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      resolve(err?.code === 'EADDRINUSE' ? 'occupied' : 'unknown');
      try {
        server.close();
      } catch {
        /* already closed */
      }
    });
    server.once('listening', () => {
      server.close(() => resolve('free'));
    });
    const timer = setTimeout(() => {
      try {
        server.close();
      } catch {
        /* */
      }
      resolve('unknown');
    }, timeoutMs);
    timer.unref?.();
    server.listen(port, '127.0.0.1');
  });
}
