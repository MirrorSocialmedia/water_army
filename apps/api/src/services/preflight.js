/**
 * Redroid host preflight (施工 MD §7.1 / §10.1) — repeatable, safe,
 * READ-ONLY host check. Runs BEFORE device start; the result is displayed
 * independently in the diagnostics page (kernel zone) and as warnings on
 * create/start. R5: per-item PASS/WARN/FAIL + verdict (CI-friendly),
 * binderfs mount check, kernel/arch compatibility, ADB port exposure scan,
 * GPU driver visibility from the docker socket (containerized vantage).
 *
 * Hard rules (MD §2.8 / §7.1 / §10.1):
 *  - fixed binary paths + argument arrays + execFile — `shell: true` is
 *    FORBIDDEN; nothing user-supplied ever reaches a shell
 *  - per-check timeout + output caps (dmesg lines capped, exec output capped)
 *  - every check reports honestly: unreadable/unavailable = `unknown`/WARN,
 *    NEVER "present" or "supported"
 *  - suggestions only (modprobe lines + official doc link) — the app never
 *    installs kernel modules or mutates the host (MD §7.1)
 *  - a preflight verdict is a WARNING, not the sole verdict (MD §2.3):
 *    device create/start still proceed and the honest state is displayed
 *
 * Stage A (redroid-matrix-A-20261019) — two vantage/semantics fixes found by
 * real-host testing on a 6.8 kernel host:
 *  - ashmem_linux is only REQUIRED when the kernel lacks memfd_create (< 3.17).
 *    Kernels 6.x removed the ashmem module entirely; Android uses memfd, and
 *    redroid boots without it (verified by real boot on 6.8.0-117).
 *  - a containerized api service cannot see host /dev nodes (limited mount
 *    namespace). The host binderfs state is then UNKNOWN from this vantage —
 *    never FALSE. A privileged redroid container gets the host /dev, so the
 *    host-level (direct module) preflight is the authoritative check.
 *
 * R5 (redroid-matrix-r5, 20261020) — vantage honesty carried to every item:
 *  - `checks[]`: one entry per item with status PASS | WARN | FAIL + detail
 *    + fix (修復方向). `verdict` = worst item (FAIL > WARN > PASS).
 *  - binderfs MOUNT check: /dev/binder existing is not enough — it must be a
 *    binderfs mount (fstype `binder` in /proc/mounts) or the redroid boot
 *    will fail with a binder ioctl error.
 *  - ADB port exposure: a host-level scan of /proc/net/tcp{,6} proves no
 *    listener in the configured ADB range is bound to a non-loopback
 *    address. Containerized vantage = WARN (the container netns probe is NOT
 *    the host — reported as such; the daemon-side 409 stays the hard guard).
 *  - GPU visibility from the docker socket (works containerized):
 *    `docker info` Runtimes.nvidia + in-process nvidia-smi (host-process
 *    deployments). Neither is "render verified" — that is the in-device
 *    diagnostics zone (MD §2.4 / §7.4).
 *  - kernel/arch compatibility: os.arch() must be x86_64|arm64 (the arches
 *    redroid ships); an image-arch mismatch is detectable from the daemon
 *    (read-only image inspect) when the image is local.
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

/** Redroid publishes images for these arches (normalized names). */
const REDROID_ARCHES = Object.freeze(['x86_64', 'arm64']);

/** os.arch() = 'x64', docker inspect = 'amd64', OCI = 'arm64'… normalize. */
export function normalizeArch(a) {
  switch (String(a ?? '').toLowerCase()) {
    case 'x64':
    case 'amd64':
    case 'x86_64':
      return 'x86_64';
    case 'arm64':
    case 'aarch64':
      return 'arm64';
    default:
      return String(a ?? '');
  }
}

/** Redroid needs a modern kernel: memfd (≥3.17) is the practical floor. */
const MIN_KERNEL = Object.freeze({ major: 3, minor: 17 });

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
 * Parse /proc/mounts and report the fstype mounted at `mountPoint`
 * (or null if not mounted / unreadable). Pure + injectable.
 * @param {string|null} mountsText raw /proc/mounts content
 * @param {string} mountPoint
 * @returns {string|null}
 */
export function fstypeAt(mountsText, mountPoint) {
  if (typeof mountsText !== 'string') return null;
  for (const line of mountsText.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 3 && parts[1] === mountPoint) return parts[2];
  }
  return null;
}

/**
 * Parse /proc/net/tcp{,6} content into LISTEN sockets. Pure + injectable.
 * Line fields: sl local_address rem_address st ... — local_address is field
 * 1 (hex ip:port, LISTEN port is on the LOCAL side, not the remote).
 * v4 line: local_address = 8 hex chars:port ; v6 = 32 hex chars:port.
 * @param {{v4?:string|null, v6?:string|null}} tcp
 * @returns {Array<{addr:string, port:number}>}
 */
export function listenSockets(tcp) {
  const out = [];
  const v6toAddr = (h) => {
    // Only the forms we must classify: all-zero = :: ; v4-mapped =
    // 00000000000000000000FFFF<ipv4hex>; anything else = "other".
    if (/^0+$/.test(h)) return '::';
    const m = /^0{20}ffff([0-9a-f]{8})$/i.exec(h);
    if (m) return `v4mapped:${hexIp4(m[1])}`;
    return `other6:${h.slice(0, 8)}…`;
  };
  const hexIp4 = (h) => {
    // /proc/net/tcp prints the 32-bit address in host (little-endian) byte
    // order: 127.0.0.1 appears as 0100007F — reverse the byte pairs.
    const b = [6, 4, 2, 0].map((i) => parseInt(h.slice(i, i + 2), 16));
    return b.join('.');
  };
  const parse = (text, isV6) => {
    if (typeof text !== 'string') return;
    const lines = text.split('\n').slice(1); // header
    for (const line of lines) {
      const f = line.trim().split(/\s+/);
      if (f.length < 4) continue;
      if (f[3] !== '0A') continue; // LISTEN only
      const [addrH, portH] = (f[1] ?? '').split(':');
      const port = Number.parseInt(portH ?? '0', 16) || 0;
      const addr = isV6 ? v6toAddr(addrH ?? '') : hexIp4(addrH ?? '');
      out.push({ addr, port });
    }
  };
  parse(tcp?.v4, false);
  parse(tcp?.v6, true);
  return out;
}

/** Is a listener address non-loopback (i.e. exposed beyond the host)? */
export function isNonLoopbackAddr(addr) {
  if (addr === '127.0.0.1' || addr === '::1') return false;
  if (addr.startsWith('v4mapped:127.')) return false;
  return true; // 0.0.0.0, ::, other6:*, v4mapped:non-127.*
}

/**
 * @param {object} deps
 * @param {object} deps.config API config (redroidPreflight* knobs + ADB range)
 * @param {{ping:()=>Promise<any>, info?:()=>Promise<any>, imageArchitecture?:(name:string)=>Promise<string|null>}} [deps.docker]
 * @param {boolean} [deps.gpuMode] check GPU/driver info when 'host'
 * @param {number} [deps.port] check this specific host port on 127.0.0.1
 * @param {string} [deps.image] optional: pinned image ref to verify architecture for
 * @param {Function} [deps.log]
 * @param {Function} [deps.exec] test seam — (bin, args, opts) => {code,stdout,stderr}
 * @param {Function} [deps.accessSync] test seam — (path, mode) sync
 * @param {Function} [deps.readProcModules] test seam — () => string|null
 * @param {Function} [deps.readProcMounts] test seam — () => string|null
 * @param {Function} [deps.readProcNetTcp] test seam — () => {v4:string|null, v6:string|null}
 * @param {Function} [deps.statfs] test seam — async (path) => {bavail, bsize}
 * @param {string} [deps.gpuBin] test seam — fixed nvidia-smi path override
 * @param {Function} [deps.detectContainerized] test seam — () => boolean
 */
export async function runRedroidPreflight({
  config,
  docker,
  gpuMode = false,
  port,
  image,
  log = { warn() {}, error() {} },
  exec,
  accessSync = fs.accessSync,
  readProcModules = readProcModulesImpl,
  readProcMounts = readProcMountsImpl,
  readProcNetTcp = readProcNetTcpImpl,
  statfs = fs.promises.statfs,
  gpuBin,
  detectContainerized = detectContainerizedImpl,
} = {}) {
  const timeoutMs = config?.redroidPreflightTimeoutMs ?? 5000;
  const maxBytes = config?.redroidPreflightMaxOutput ?? 65_536;
  const dataRoot = config?.redroidDataRoot ?? '/var/lib/water-army/redroid';
  const rangeStart = config?.redroidAdbRangeStart ?? 15000;
  const rangeEnd = config?.redroidAdbRangeEnd ?? 15999;
  const isLinux = os.platform() === 'linux';
  const checks = [];
  const addCheck = (id, status, detail, fix) => {
    checks.push(fix ? { id, status, detail, fix } : { id, status, detail });
  };

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

  // memfd_create (kernel ≥ 3.17) supersedes the ashmem_linux module — kernels
  // 6.x removed the module entirely; Android (and redroid) use memfd instead.
  const kernelVersion = parseKernelVersion(kernel);
  const memfd =
    kernelVersion === null
      ? { available: 'unknown', kernel: null, note: 'kernel version unparseable — memfd availability unknown' }
      : kernelAtLeast(kernelVersion, MIN_KERNEL.major, MIN_KERNEL.minor)
        ? { available: true, kernel: `${kernelVersion.major}.${kernelVersion.minor}`, note: 'memfd_create available (kernel ≥ 3.17) — ashmem_linux module not required' }
        : { available: false, kernel: `${kernelVersion.major}.${kernelVersion.minor}`, note: `kernel < ${MIN_KERNEL.major}.${MIN_KERNEL.minor} — ashmem_linux module required` };

  // Vantage honesty: a containerized api service sees a LIMITED /dev (its own
  // mount namespace), so "host /dev/binder missing" from here is an artifact of
  // the vantage, not the host state. A privileged redroid container gets the
  // host /dev — so from a container the host node state is UNKNOWN, never false.
  const containerized = detectContainerized();
  const deviceVisibility = containerized ? 'containerized' : 'direct';

  // binderfs MOUNT (R5): /dev/binder must be a binderfs mount (fstype 'binder').
  // A plain char device or directory at /dev/binder will NOT boot redroid.
  const mountsText = readProcMounts();
  const binderFstype = deviceVisibility === 'direct' ? fstypeAt(mountsText, '/dev/binder') : 'unknown';

  // Honest tri-state: every input must positively confirm before 'true'.
  // Shared-memory backing = ashmem module OR memfd (kernel ≥ 3.17).
  const smBacking =
    moduleStates.ashmem_linux === 'present' || memfd.available === true
      ? true
      : moduleStates.ashmem_linux === 'unknown' || memfd.available === 'unknown'
        ? 'unknown'
        : false;
  const binderDevice = deviceVisibility === 'direct' ? devices['/dev/binder'] === true : 'unknown';
  const binderSupported =
    !isLinux ||
    moduleStates.binder_linux === 'unknown' ||
    smBacking === 'unknown' ||
    binderDevice === 'unknown' ||
    binderFstype === 'unknown'
      ? 'unknown'
      : moduleStates.binder_linux === 'present' && smBacking === true && binderDevice === true && binderFstype === 'binder'
        ? true
        : false;

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

  // ---- kernel / arch compatibility (R5) -------------------------------------
  const hostArch = os.arch();
  const hostArchNorm = normalizeArch(hostArch);
  const archOk = REDROID_ARCHES.includes(hostArchNorm);
  let imageArch = null;
  let imageArchError = null;
  if (image && docker?.imageArchitecture) {
    try {
      imageArch = await docker.imageArchitecture(image);
    } catch (err) {
      imageArchError = String(err?.message ?? err).slice(0, 160);
    }
  }
  const imageArchNorm = imageArch === null || imageArch === undefined ? null : normalizeArch(imageArch);
  const archMismatch = imageArchNorm !== null && imageArchNorm !== hostArchNorm;

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
    ports = { port, state: await checkPortAvailable(port, { timeoutMs }), vantage: deviceVisibility };
  }

  // ---- ADB range exposure scan (R5, host-level, read-only) -------------------
  let exposure = null;
  if (isLinux) {
    const tcp = readProcNetTcp();
    const vantageOk = !containerized;
    const listeners = vantageOk ? listenSockets(tcp) : null;
    const exposed = (listeners ?? []).filter((s) => s.port >= rangeStart && s.port <= rangeEnd && isNonLoopbackAddr(s.addr));
    exposure = {
      range: { start: rangeStart, end: rangeEnd },
      vantage: deviceVisibility,
      scanned: vantageOk,
      listenersInRange: (listeners ?? []).filter((s) => s.port >= rangeStart && s.port <= rangeEnd).slice(0, 50),
      exposed,
    };
  }

  // ---- gpu (MD §2.4/§7.1: visibility ≠ rendering) ----------------------------
  let gpu = null;
  if (gpuMode) {
    gpu = await checkGpu({ timeoutMs, maxBytes, exec, accessSync, gpuBin, docker });
  }

  // ---- suggestions ------------------------------------------------------------
  const suggestions = [];
  if (moduleStates.binder_linux !== 'present') {
    suggestions.push(
      'Load the binder module (requires root): modprobe binder_linux devices="binder,hwbinder,vndbinder"',
    );
  }
  if (moduleStates.ashmem_linux !== 'present' && memfd.available !== true) {
    suggestions.push(
      'Load ashmem if this kernel provides it (requires root; newer kernels may use memfd instead): modprobe ashmem_linux',
    );
  }
  if (containerized) {
    if (!devices['/dev/binder']) {
      suggestions.push(
        'api service runs in a container and cannot see host /dev — verify the binderfs mount FROM THE HOST (mount | grep binder). A privileged redroid container gets the host /dev, so the host-level preflight is the authoritative check for this node.',
      );
    }
  } else if (!devices['/dev/binder']) {
    suggestions.push('Ensure /dev/binder (and /dev/binder_hwbinder) exist and are accessible by the api service.');
  } else if (binderFstype !== 'binder') {
    suggestions.push(
      '/dev/binder exists but is not a binderfs mount — mount it (requires root): mount -t binder binder /dev/binder (see the redroid-doc host setup for this kernel).',
    );
  }
  suggestions.push('Official docs: https://github.com/remote-android/redroid-doc — verify the exact procedure for this kernel before booting Redroid.');

  // ---- per-item checks (R5) -----------------------------------------------------
  // docker daemon
  if (dockerState.available === true) addCheck('docker-daemon', 'PASS', 'docker daemon answered ping');
  else if (dockerState.available === false) addCheck('docker-daemon', 'FAIL', `docker daemon unavailable: ${dockerState.error}`, 'Start the docker daemon (systemctl start docker) and re-run');
  else addCheck('docker-daemon', 'WARN', 'docker state not determined (no ping available)', 'Run preflight with docker socket access');

  // binder module
  if (moduleStates.binder_linux === 'present') addCheck('binder-module', 'PASS', 'binder_linux loaded');
  else if (moduleStates.binder_linux === 'absent') addCheck('binder-module', 'FAIL', 'binder_linux NOT loaded — redroid cannot boot', 'Load it (requires root, after explicit approval): modprobe binder_linux devices="binder,hwbinder,vndbinder"');
  else addCheck('binder-module', 'WARN', '/proc/modules unreadable from this process', 'Run the host-level preflight (direct vantage)');

  // binderfs mount
  if (binderFstype === 'binder') addCheck('binderfs-mount', 'PASS', '/dev/binder is a binderfs mount');
  else if (binderFstype === 'unknown') addCheck('binderfs-mount', 'WARN', deviceVisibility === 'containerized' ? 'containerized vantage — host /proc/mounts not visible' : '/proc/mounts unreadable', 'Verify from the host: mount | grep binder');
  else if (!devices['/dev/binder']) addCheck('binderfs-mount', 'FAIL', '/dev/binder does not exist on this host', 'Create the binderfs mount (requires root, after explicit approval): mount -t binder binder /dev/binder');
  else addCheck('binderfs-mount', 'FAIL', `/dev/binder exists but fstype is ${binderFstype === null ? 'none (not mounted)' : `'${binderFstype}'`} (expected 'binder')`, 'Re-mount as binderfs (requires root, after explicit approval): mount -t binder binder /dev/binder');

  // shared memory backing (memfd or ashmem)
  if (smBacking === true) addCheck('shared-memory', 'PASS', memfd.available === true ? `memfd available (kernel ${memfd.kernel})` : 'ashmem_linux loaded');
  else if (smBacking === 'unknown') addCheck('shared-memory', 'WARN', 'memfd/ashmem availability undetermined', 'Verify kernel ≥ 3.17 (uname -r) from the host');
  else addCheck('shared-memory', 'FAIL', `kernel ${memfd.kernel} lacks memfd and ashmem_linux is absent`, 'Upgrade the kernel or load ashmem_linux (requires approval)');

  // kernel / arch compatibility
  if (!isLinux) addCheck('kernel-compat', 'FAIL', `host platform '${os.platform()}' — redroid requires Linux`, 'Run the platform on a Linux host');
  else if (!archOk) addCheck('kernel-compat', 'FAIL', `host arch '${hostArch}' is not a redroid image arch (${REDROID_ARCHES.join('/')})`, 'Use a host matching a published redroid image architecture');
  else if (kernelVersion === null) addCheck('kernel-compat', 'WARN', `kernel '${kernel}' unparseable`, 'Verify the kernel version from the host (uname -r)');
  else if (!kernelAtLeast(kernelVersion, MIN_KERNEL.major, MIN_KERNEL.minor)) addCheck('kernel-compat', 'FAIL', `kernel ${kernel} is below the ${MIN_KERNEL.major}.${MIN_KERNEL.minor} floor (no memfd)`, 'Upgrade the kernel (requires approval)');
  else addCheck('kernel-compat', 'PASS', `kernel ${kernel} (${hostArchNorm}) — meets the redroid floor`);

  // image arch (only when a local image ref was supplied)
  if (image) {
    if (archMismatch) addCheck('image-arch', 'FAIL', `image arch '${imageArch}' (${imageArchNorm}) != host arch '${hostArch}' (${hostArchNorm}) for image '${image}'`, 'Pull/build the image for the host architecture');
    else if (imageArchError) addCheck('image-arch', 'WARN', `image inspect failed: ${imageArchError}`, 'Verify the image exists locally (docker images)');
    else if (imageArchNorm === null) addCheck('image-arch', 'WARN', 'image architecture not determined (image not local or inspect unavailable)', 'docker pull/build the pinned image before creating devices from it');
    else addCheck('image-arch', 'PASS', `image '${image}' arch '${imageArchNorm}' matches host`);
  }

  // specific ADB port
  if (ports) {
    if (ports.state === 'free' && !containerized) addCheck('adb-port', 'PASS', `127.0.0.1:${ports.port} free (direct vantage)`);
    else if (ports.state === 'free' && containerized) addCheck('adb-port', 'WARN', `containerized vantage — probe is the CONTAINER netns, not the host; daemon-side 409 is the hard guard`, 'Verify host 127.0.0.1 occupancy from the host (ss -ltn) for certainty');
    else if (ports.state === 'occupied') addCheck('adb-port', 'FAIL', `127.0.0.1:${ports.port} already bound`, 'Free the port or pick another ADB port');
    else addCheck('adb-port', 'WARN', `port probe inconclusive (${ports.state})`, 'Re-run; if persistent, check the host directly');
  }

  // ADB range exposure (public binding)
  if (exposure) {
    if (!exposure.scanned) addCheck('adb-exposure', 'WARN', 'containerized vantage — host /proc/net/tcp not visible from here', 'Verify from the host: ss -ltn | grep -E \":1[56][0-9]{3}\" — expect 127.0.0.1 only');
    else if (exposure.exposed.length > 0) addCheck('adb-exposure', 'FAIL', `non-loopback ADB listener(s) found: ${exposure.exposed.map((s) => `${s.addr}:${s.port}`).join(', ')}`, 'Stop or rebind the listener to 127.0.0.1 — ADB must never be public');
    else addCheck('adb-exposure', 'PASS', `no non-loopback listener in ${rangeStart}-${rangeEnd} (host scan)`);
  }

  // data volume
  if (disk.exists && disk.writable && (disk.freeBytes === null || disk.freeBytes >= 4 * 1024 * 1024 * 1024)) {
    addCheck('data-volume', 'PASS', `${dataRoot} writable${disk.freeBytes !== null ? `, ${Math.round(disk.freeBytes / (1024 ** 3))} GiB free` : ''}`);
  } else if (disk.exists && disk.writable) {
    addCheck('data-volume', 'WARN', `less than 4 GiB free under ${dataRoot}`, 'Free disk space before booting devices (fresh /data can take ~10+ GiB)');
  } else if (disk.exists) {
    addCheck('data-volume', 'FAIL', `${dataRoot} exists but is not writable by the api user`, 'chown the data root to the api user (see runbook §9)');
  } else {
    addCheck('data-volume', 'FAIL', `${dataRoot} does not exist`, 'Create it before device data persistence (scripts/redroid-host-setup.sh)');
  }

  // gpu visibility (when requested)
  if (gpu) {
    if (gpu.verified) addCheck('gpu-visibility', 'PASS', gpu.detail ?? 'gpu verified in-device');
    else if (gpu.available) addCheck('gpu-visibility', 'WARN', gpu.detail ?? 'driver visible but rendering NOT verified', gpu.fix ?? 'Rendering is proven only by the in-device diagnostics check (device → diagnostics → gpu zone)');
    else if (gpu.visibleUnknown) addCheck('gpu-visibility', 'WARN', gpu.detail ?? 'gpu visibility undetermined from this vantage', gpu.fix ?? 'Install the nvidia container toolkit or run the host-level preflight');
    else addCheck('gpu-visibility', 'FAIL', gpu.detail ?? 'no nvidia driver visible', gpu.fix ?? 'Install the nvidia driver + container toolkit on the host (requires approval)');
  }

  // ---- rollup ----------------------------------------------------------------
  const warnings = [];
  if (!isLinux) warnings.push('Host is not Linux — Redroid containers cannot run on this platform.');
  if (dockerState.available === false) warnings.push(`Docker daemon unavailable: ${dockerState.error}`);
  if (moduleStates.binder_linux === 'absent') warnings.push('Kernel module binder_linux is NOT loaded — Redroid boot will fail on this host.');
  if (moduleStates.ashmem_linux === 'absent' && memfd.available !== true) {
    warnings.push(`Kernel module ashmem_linux is NOT loaded and the kernel has no memfd (kernel < ${MIN_KERNEL.major}.${MIN_KERNEL.minor}) — check dmesg.`);
  }
  if (containerized && !devices['/dev/binder']) {
    warnings.push('api service is containerized — host /dev nodes are not visible from here; run the host-level preflight to confirm /dev/binder (a privileged redroid container gets the host /dev).');
  }
  if (!containerized && !devices['/dev/binder']) {
    warnings.push('/dev/binder is missing on this host — redroid cannot boot until the binderfs mount exists.');
  }
  if (disk.freeBytes !== null && disk.freeBytes < 4 * 1024 * 1024 * 1024) warnings.push(`Less than 4 GiB free under ${dataRoot} — device /data persistence will exhaust quickly.`);
  if (gpu && !gpu.verified) warnings.push('GPU is NOT verified for Redroid rendering — nvidia-smi success does not prove Android EGL/WebGL works (MD §2.4).');

  const verdict = checks.some((c) => c.status === 'FAIL')
    ? 'FAIL'
    : checks.some((c) => c.status === 'WARN')
      ? 'WARN'
      : 'PASS';

  return {
    checkedAt: new Date().toISOString(),
    host: { platform: os.platform(), isLinux, kernel, kernelSource, arch: hostArch },
    docker: dockerState,
    binder: {
      modules: moduleStates,
      devices,
      deviceVisibility,
      binderFstype,
      memfd,
      dmesg,
      supported: binderSupported,
      suggestions,
    },
    disk,
    ports,
    exposure,
    imageArch: image ? { image, imageArch, imageArchNorm, hostArch, hostArchNorm, mismatch: archMismatch, error: imageArchError } : null,
    gpu,
    checks,
    verdict,
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

function readProcMountsImpl() {
  try {
    return fs.readFileSync('/proc/mounts', 'utf8');
  } catch {
    return null;
  }
}

function readProcNetTcpImpl() {
  const read = (p) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };
  return { v4: read('/proc/net/tcp'), v6: read('/proc/net/tcp6') };
}

/**
 * Detect whether THIS process runs inside a container (/.dockerenv or a
 * cgroup controller path). Determines the /dev vantage for the binder device
 * check — see the module header (Stage A fix). Read-only, never throws.
 */
function detectContainerizedImpl() {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
    const cg = fs.readFileSync('/proc/1/cgroup', 'utf8');
    return /docker|kubepods|containerd|lxc/i.test(cg);
  } catch {
    return false; // undecidable — treat as direct vantage (device check applies)
  }
}

/** "6.8.0-117-generic" → {major:6, minor:8} | null (unparseable). */
export function parseKernelVersion(kernel) {
  const m = /^(\d+)\.(\d+)/.exec(String(kernel ?? ''));
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

function kernelAtLeast(v, major, minor) {
  return v.major > major || (v.major === major && v.minor >= minor);
}

/**
 * GPU visibility check (MD §10.1 / §7.1). R5: two visibility sources, both
 * read-only:
 *   1. in-process nvidia-smi (host-process deployments, or images that ship it)
 *   2. docker info → Runtimes.nvidia (works from a containerized api — the
 *      socket is the vantage)
 * The result NEVER flips GPU status to verified — it is evidence the host has
 * a driver/runtime, not that Redroid renders through it (MD §2.4).
 */
async function checkGpu({ timeoutMs, maxBytes, exec, accessSync = fs.accessSync, gpuBin, docker }) {
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

  // source 1: nvidia-smi (real driver query)
  if (bin) {
    const r = await runBounded({
      bin,
      args: ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'],
      timeoutMs,
      maxBytes,
      exec,
    });
    if (r.code === 0) {
      const gpus = r.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [name = '', mem = '', driver = ''] = l.split(',').map((s) => s.trim());
          return { name, memory: mem || null, driverVersion: driver || null };
        })
        .slice(0, 8);
      if (gpus.length > 0) {
        return {
          available: true,
          driverVersion: gpus[0]?.driverVersion ?? null,
          gpus,
          verified: false,
          source: 'nvidia-smi',
          detail: `nvidia-smi: ${gpus[0].name} ×${gpus.length}, driver ${gpus[0].driverVersion ?? 'unknown'}`,
          note: 'nvidia-smi success ≠ Redroid GPU verified (MD §2.4). Status stays 未驗證 until the in-device render check passes.',
        };
      }
      return {
        available: false,
        driverVersion: null,
        gpus: [],
        verified: false,
        source: 'nvidia-smi',
        detail: 'nvidia-smi ran but reports no GPU',
        fix: 'Verify the nvidia driver sees the device (lspci | grep -i nvidia) from the host',
        note: 'MD §2.4: a missing GPU is not a rendering pass.',
      };
    }
    // nvidia-smi present but failing — fall through to docker info, note it.
  }

  // source 2: docker info → Runtimes.nvidia (socket vantage, read-only)
  if (docker?.info) {
    try {
      const info = await docker.info();
      const runtimes = info?.Runtimes ?? {};
      if (runtimes.nvidia) {
        return {
          available: true,
          driverVersion: null,
          gpus: [],
          verified: false,
          source: 'docker-info',
          detail: `docker nvidia runtime registered (path: ${String(runtimes.nvidia.path ?? 'unknown').slice(0, 120)}) — driver visible from the socket vantage`,
          note: 'runtime registration ≠ Redroid GPU verified (MD §2.4). In-device render check is required.',
        };
      }
      // docker info was READABLE (the vantage works) and has no nvidia runtime:
      // that is a positive absence from a working vantage — FAIL, not unknown.
      return {
        available: false,
        visibleUnknown: false,
        driverVersion: null,
        gpus: [],
        verified: false,
        source: 'docker-info',
        detail: 'docker info readable: no nvidia runtime registered — the daemon cannot pass GPUs to containers',
        fix: 'Install the nvidia container toolkit on the host (requires approval); then docker info | grep -i nvidia',
        note: 'MD §2.4: configuration presence is never a success claim.',
      };
    } catch {
      /* fall through */
    }
  }

  return {
    available: false,
    visibleUnknown: true,
    driverVersion: null,
    gpus: [],
    verified: false,
    source: 'none',
    detail: 'nvidia-smi not available in this process and docker info not usable from here',
    fix: 'Run the host-level preflight (direct vantage) — the containerized api cannot see host drivers',
    note: 'MD §2.4: absence of evidence here is vantage, not proof of no GPU.',
  };
}

/**
 * Is `port` already bound on 127.0.0.1? (MD §10.1 "port 是否已被佔用")
 * NOTE (R5 vantage honesty): from a containerized api this probes the
 * CONTAINER netns, not the host — the daemon-side 409 at create time is the
 * hard guard. Callers report the vantage.
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
