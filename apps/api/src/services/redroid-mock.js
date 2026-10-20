/**
 * Redroid MOCK adapter (工單 P5 scope 8: mock 驗證主路徑).
 *
 * Selected via REDROID_ADAPTER=mock (config.redroidAdapter). NEVER active in
 * production (app.js forces 'real' when NODE_ENV=production).
 *
 * This is a DETERMINISTIC, honest mock:
 *  - dockerode-shaped client with the same state machine the engine uses
 *    (created → running → exited; remove; 404 shapes; call recording so
 *    tests can assert the exact 127.0.0.1 PortBinding + Cmd shape)
 *  - fake adb executor: canned output per whitelisted argv, records every
 *    (binary, argv) so zero-shell + no-shell-option assertions are possible
 *  - canned preflight: reports 'supported' WITH mock:true so any UI/API that
 *    shows it can say exactly what it is (no fake 'verified' anywhere)
 *
 * The mock does NOT pretend to be real: every result carries mock:true.
 */
import { EventEmitter } from 'node:events';

import { removeRedroidDataDir, T2S_SETUP_FILE, T2S_NETCHECK_MARKER, T2S_CANARY_MARKER, TUN2SOCKS_CHECK_MARKER, TUN2SOCKS_PIN } from './redroid-service.js';

let mockIdSeq = 9000;

/**
 * @param {object} [opts]
 * @param {string[]} [opts.networks]
 * @param {boolean} [opts.startFails] created containers fail to start (simulate boot crash)
 * @param {string} [opts.startErrorMessage]
 * @param {{statusCode:number, message:string}} [opts.createError] createContainer
 *   fails with a dockerode-shaped engine error (e.g. the daemon's
 *   "(HTTP code 404) no such container - No such image: <ref>" for a missing
 *   image reference — R6 error-contract test seam)
 */
export function createMockRedroidDocker({ networks = ['bridge'], startFails = false, startErrorMessage = 'OCI runtime create failed: /dev/binder not found (mock host without binder_linux)', createError = null } = {}) {
  const byId = new Map();
  const byName = new Map();
  const calls = [];
  const logBuffers = new Map();

  function engineError(statusCode, message) {
    const e = new Error(message);
    e.statusCode = statusCode;
    return e;
  }

  function resolveId(idOrName) {
    if (byId.has(idOrName)) return byId.get(idOrName);
    const id = byName.get(idOrName);
    if (id) return byId.get(id);
    throw engineError(404, `No such container: ${idOrName}`);
  }

  function bootLog(name) {
    return [
      '[    0.000000] Booting Android on water_army mock host',
      `[    1.200000] redroid: device=${name} (mock — no real kernel modules)`,
      '[    2.500000] binder: mock binder nodes',
      '[    3.100000] init: mock boot completed',
      'I/ActivityManager(  500): Mock system ready',
    ].join('\n');
  }

  const client = {
    __mock: true,
    __calls: calls,
    __byId: byId,
    __byName: byName,

    async listContainers() {
      calls.push({ method: 'listContainers' });
      return [...byId.values()].map((rec) => ({
        Id: rec.inspect.Id,
        Names: [rec.inspect.Name],
        Image: rec.inspect.Config.Image,
        State: rec.inspect.State.Status,
        Status: rec.inspect.State.Status === 'running' ? 'Up (mock)' : 'Exited (0) (mock)',
        Ports: Object.entries(rec.inspect.HostConfig?.PortBindings ?? {}).flatMap(([key, binds]) => {
          const [port, type] = key.split('/');
          return binds.map((b) => ({ PrivatePort: Number(port), Type: type, PublicPort: Number(b.HostPort), IP: b.HostIP ?? '0.0.0.0' }));
        }),
        Labels: rec.inspect.Config.Labels,
        Created: Math.floor(new Date(rec.inspect.Created).getTime() / 1000),
      }));
    },

    getContainer(idOrName) {
      return {
        id: idOrName,
        async inspect() {
          calls.push({ method: 'inspect', id: idOrName });
          const rec = resolveId(idOrName);
          return JSON.parse(JSON.stringify(rec.inspect));
        },
        async logs(opts) {
          calls.push({ method: 'logs', id: idOrName, opts: opts ?? null });
          const rec = resolveId(idOrName);
          let buf = logBuffers.get(rec.inspect.Id) ?? Buffer.from(bootLog(rec.inspect.Name.replace(/^\//, '')));
          if (opts?.tail && Number(opts.tail) > 0) {
            const lines = buf.toString('utf8').split('\n').filter((l) => l.length > 0);
            buf = Buffer.from(lines.slice(-Number(opts.tail)).join('\n') + '\n');
          }
          const framed = Buffer.alloc(8 + buf.length);
          framed[0] = 1;
          framed.writeUInt32BE(buf.length, 4);
          buf.copy(framed, 8);
          return framed;
        },
        async start() {
          calls.push({ method: 'start', id: idOrName });
          const rec = resolveId(idOrName);
          if (rec.inspect.State.Status === 'dead') throw engineError(500, 'cannot start container: dead');
          if (startFails) throw engineError(400, startErrorMessage);
          if (rec.inspect.State.Status !== 'running') {
            rec.inspect.State.Status = 'running';
            rec.inspect.State.Running = true;
            rec.inspect.State.Paused = false;
          }
        },
        async stop() {
          calls.push({ method: 'stop', id: idOrName });
          const rec = resolveId(idOrName);
          if (rec.inspect.State.Status !== 'exited') {
            rec.inspect.State.Status = 'exited';
            rec.inspect.State.Running = false;
            rec.inspect.State.FinishedAt = new Date().toISOString();
          }
        },
        async restart() {
          calls.push({ method: 'restart', id: idOrName });
          const rec = resolveId(idOrName);
          if (rec.inspect.State.Status === 'dead') throw engineError(500, 'cannot restart container: dead');
          rec.inspect.State.Status = 'running';
          rec.inspect.State.Running = true;
          rec.inspect.State.Paused = false;
        },
        async remove(opts) {
          calls.push({ method: 'remove', id: idOrName, opts: opts ?? null });
          const rec = resolveId(idOrName);
          const id = rec.inspect.Id;
          if (rec.inspect.State.Status === 'running' && !opts?.force) throw engineError(409, 'you cannot remove a running container: use -f');
          byId.delete(id);
          for (const [n, i] of byName) if (i === id) byName.delete(n);
          logBuffers.delete(id);
        },
      };
    },

    async createContainer(cfg) {
      calls.push({ method: 'createContainer', cfg: cfg ?? null });
      if (createError) throw engineError(createError.statusCode, createError.message);
      const body = cfg?._body ?? cfg ?? {};
      const name = String(cfg?._query?.name ?? body.Name ?? '').replace(/^\//, '');
      if (!name) throw engineError(400, 'container name required');
      if (byName.has(name)) throw engineError(409, `Conflict. The container name "/${name}" is already in use by container`);
      const id = `mock${String(++mockIdSeq).padStart(61, '0')}`;
      const rec = {
        inspect: {
          Id: id,
          Name: `/${name}`,
          State: { Status: 'created', Running: false, Paused: false, Restarting: false, Dead: false, StartedAt: '0001-01-01T00:00:00Z', FinishedAt: '0001-01-01T00:00:00Z', ExitCode: 0, RestartCount: 0, Health: null },
          Created: new Date().toISOString(),
          Image: 'sha256:mock-redroid',
          Config: { Labels: body.Labels ?? {}, Env: body.Env ?? [], Cmd: body.Cmd ?? null, Image: body.Image ?? 'unknown' },
          HostConfig: {
            NetworkMode: body.HostConfig?.NetworkMode ?? 'bridge',
            Privileged: Boolean(body.HostConfig?.Privileged),
            PortBindings: body.HostConfig?.PortBindings ?? null,
            DeviceRequests: body.HostConfig?.DeviceRequests ?? null,
          },
          NetworkSettings: { Ports: null },
          Mounts: (body.HostConfig?.Mounts ?? []).map((m) => ({ Type: m.Type, Source: m.Source ?? null, Destination: m.Target, RW: !m.ReadOnly })),
        },
      };
      byId.set(id, rec);
      byName.set(name, id);
      logBuffers.set(id, Buffer.from(bootLog(name)));
      // dockerode 5.x: resolves the Container instance (.id).
      return client.getContainer(id);
    },

    async listNetworks() {
      return networks.map((Name) => ({ Name }));
    },

    async ping() {
      return 'PONG (mock)';
    },
  };

  return client;
}

/**
 * Plugin-shape mock docker wrapper ({disabled, client, ping}).
 */
export function createMockRedroidDockerWrapper(opts = {}) {
  const client = createMockRedroidDocker(opts);
  return { disabled: false, client, ping: async () => 'PONG (mock)' };
}

// ---------------------------------------------------------------------------
// Mock ADB — canned output per whitelisted argv (zero PII, deterministic)
// ---------------------------------------------------------------------------

/**
 * @param {object} [opts]
 * @param {boolean} [opts.online] get-state reports online (default true)
 * @param {string[]} [opts.logcatLines] per-line source (default: generated)
 * @param {string} [opts.spawnError] make EVERY exec throw a spawn failure
 *   (ENOENT-shaped — the adb binary is missing / unrunnable on this host;
 *   R6 ADB_UNAVAILABLE error-contract test seam)
 */
export function createMockAdb({ online = true, logcatLines, spawnError = null } = {}) {
  const calls = [];
  // Mutable so a test can model the R5 recreate-stall transition
  // (confirmed online → adbd stops answering) without a new app instance.
  let adbOnline = online;

  const lines =
    logcatLines ??
    Array.from({ length: 300 }, (_, i) => `I/MockSystem(${1000 + (i % 50)}): mock logcat line ${i}`);

  async function exec(bin, argv) {
    calls.push({ bin, argv: [...argv] });
    if (spawnError) {
      const e = new Error(spawnError);
      e.code = 'ENOENT';
      e.stderr = '';
      throw e;
    }
    const targetIdx = argv.indexOf('-s');
    const target = targetIdx !== -1 ? argv[targetIdx + 1] : argv.find((a) => /^127\.0\.0\.1:\d+$/.test(a));

    if (argv[argv.length - 1] === 'get-state' && argv.includes('get-state') && argv[0] !== 'connect') {
      return { stdout: adbOnline ? 'device online\n' : 'device offline\n', stderr: '' };
    }
    if (argv[0] === 'connect') {
      return { stdout: adbOnline ? `connected to ${target}\n` : `cannot connect to ${target}: Connection refused\n`, stderr: '' };
    }
    const shellArgv = argv.slice(argv.indexOf('shell') + 1);
    const op = shellArgv[0];
    if (op === 'getprop') {
      const key = shellArgv[1];
      const PROPS = {
        'ro.build.version.release': '15',
        'ro.build.version.sdk': '35',
        'ro.build.fingerprint': 'mock/redroid/mock:15/AP1A.240505.004/1: user/release-keys',
        'ro.build.display.id': 'mock-redroid/15',
        'ro.product.model': 'redroid',
        'ro.product.brand': 'google',
        'ro.product.name': 'redroid',
        'ro.product.device': 'redroid',
        'ro.debuggable': '1',
        'ro.secure': '1',
        'sys.boot_completed': '1',
        'androidboot.redroid_gpu_mode': 'swiftshader_indirect',
      };
      if (key) return { stdout: `${PROPS[key] ?? ''}\n`, stderr: '' };
      return { stdout: Object.entries(PROPS).map(([k, v]) => `[${k}]: [${v}]\n`).join(''), stderr: '' };
    }
    if (op === 'dumpsys') {
      const svc = shellArgv[1];
      return { stdout: `DUMP OF SYSTEM SERVICE ${svc.toUpperCase()} (mock)\n  entry: mock-value\n  entries: 2\n`, stderr: '' };
    }
    if (op === 'logcat') {
      const tIdx = shellArgv.indexOf('-t');
      const n = tIdx !== -1 ? Math.max(1, Number(shellArgv[tIdx + 1]) || 1) : lines.length;
      return { stdout: lines.slice(-n).join('\n') + '\n', stderr: '' };
    }
    // Anything else should be impossible (the whitelist engine validates first) —
    // fail loudly rather than answer.
    const e = new Error(`mock adb: unexpected argv ${JSON.stringify(argv)}`);
    e.code = 2;
    e.stdout = '';
    e.stderr = 'mock adb: unexpected command (whitelist bug?)';
    throw e;
  }

  return {
    exec,
    calls,
    // R6 test seam: model the recreate-stall transition (online → offline).
    setOnline: (v) => { adbOnline = Boolean(v); },
  };
}

// ---------------------------------------------------------------------------
// Mock preflight — honest: it is a mock, and it says so
// ---------------------------------------------------------------------------

export function createMockPreflight() {
  return async (params = {}) => ({
    mock: true,
    checkedAt: new Date().toISOString(),
    host: { platform: 'linux', isLinux: true, kernel: 'mock-kernel', kernelSource: 'mock' },
    docker: { available: true, error: null },
    binder: {
      modules: { binder_linux: 'present', ashmem_linux: 'present' },
      devices: { '/dev/binder': true, '/dev/binder_hwbinder': true, '/dev/ashmem': true },
      dmesg: { readable: true, relevantLines: ['[mock] binder: mock nodes registered'] },
      supported: true,
      suggestions: [],
    },
    disk: { dataRoot: '(mock)', exists: true, writable: true, freeBytes: 10 * 1024 ** 3 },
    ports: params.port ? { port: params.port, state: 'free' } : null,
    gpu: params.gpuMode
      ? { available: true, driverVersion: 'mock-550', gpus: [{ name: 'Mock GPU', memory: '24576 MiB', driverVersion: 'mock-550' }], verified: false, note: 'mock: nvidia-smi simulation — verified stays false (MD §2.4)' }
      : null,
    overall: 'supported',
    warnings: ['mock preflight — deterministic simulation, not a real host check'],
  });
}

/**
 * Mock in-container exec (Stage B tunnel provisioning + R1 staged execution
 * + R3 netcheck/canary): records every {containerId, script} call and
 * emulates the device:
 *  - binary-check scripts (contain the TUN2SOCKS_CHECK_MARKER) → configurable
 *    BINARY_STATE=… line (default: ready — keeps the happy path deterministic)
 *  - netcheck scripts (R2S netcheck marker) → configurable NETCHECK line
 *    (default: fully healthy — process alive, tun0 up, table-100 route +
 *    netd rule present, effective=tunnel)
 *  - canary scripts (R3 canary marker) → configurable PASS/FAIL (default:
 *    PASS with the script's nonce echoed — the bidirectional-payload shape)
 *  - stage scripts (base64 → T2S_SETUP_FILE) → success; the staged payload is
 *    captured so the run call can emulate the INNER script's output
 *  - run scripts (sh T2S_SETUP_FILE) → the inner script's success output
 *    (teardown → TUNNEL_TEARDOWN_DONE; setup → the fake `ps` line the service
 *    greps for liveness)
 * opts.fail = true → exit 1 on every call (for the failure path).
 * opts.netcheck = {process,pid,iface,route,rule,effective} — inject
 *    control-plane failure shapes (e.g. process=dead, effective=direct).
 * opts.canary = {pass, reason, ms} — inject data-plane failure shapes.
 */
export function createMockExec({ fail = false, binaryCheck, netcheck, canary, stageFail = false } = {}) {
  const calls = [];
  let lastStagedB64 = null;
  // Mutable behavior (tests flip failure shapes mid-scenario):
  const behavior = { fail, binaryCheck, netcheck, canary, stageFail };
  async function exec(containerId, script) {
    calls.push({ containerId, script, at: Date.now() });
    if (behavior.fail) return { exitCode: 1, stdout: 'mock exec: forced failure', stderr: 'TUNNEL_TEARDOWN_FAILED' };
    // R1: tun2socks binary diagnostic check
    if (script.includes(TUN2SOCKS_CHECK_MARKER)) {
      const bc = behavior.binaryCheck ?? { state: 'ready', version: `tun2socks-${TUN2SOCKS_PIN.version}` };
      const lines = [`BINARY_STATE=${bc.state}`];
      if (bc.detail) lines.push(`BINARY_DETAIL=${bc.detail}`);
      if (bc.version) lines.push(`BINARY_VERSION=${bc.version}`);
      return { exitCode: 0, stdout: lines.join('\n') + '\n', stderr: '' };
    }
    // R3: control-plane netcheck
    if (script.includes(T2S_NETCHECK_MARKER)) {
      const nc = behavior.netcheck ?? { process: 'alive', pid: '4444', iface: 'up', route: 'present', rule: 'present', effective: 'tunnel' };
      return {
        exitCode: 0,
        stdout: `NETCHECK process=${nc.process} pid=${nc.pid ?? 'none'} iface=${nc.iface} route=${nc.route} rule=${nc.rule} effective=${nc.effective}\n`,
        stderr: '',
      };
    }
    // R3: data-plane canary (TCP bidirectional payload probe)
    if (script.includes(T2S_CANARY_MARKER)) {
      const c = behavior.canary ?? { pass: true, ms: 42 };
      const m = script.match(/NONCE=([a-f0-9]{8,64})/);
      const nonce = m?.[1] ?? '0000000000000000';
      if (c.pass) {
        return { exitCode: 0, stdout: `CANARY=PASS nonce=${nonce} ms=${c.ms ?? 42} reqsha=${'ab'.repeat(32)}\n`, stderr: '' };
      }
      return { exitCode: 1, stdout: `CANARY=FAIL nonce=${nonce} reason=${c.reason ?? 'timeout'}\n`, stderr: '' };
    }
    // R1: stage (base64 → file). Capture the payload for the run call.
    const m = script.match(/printf '%s' '([A-Za-z0-9+\/=]+)' \| base64 -d/);
    if (m) {
      if (behavior.stageFail) {
        // R6: stage fails while the binary check passed — isolates the
        // TUNNEL_SETUP_FAILED (script-stage-failed) persistence path.
        return { exitCode: 1, stdout: '', stderr: 'mock: forced stage failure' };
      }
      lastStagedB64 = m[1];
      return { exitCode: 0, stdout: 'T2S_STAGED\n', stderr: '' };
    }
    // R1: run the staged file — emulate the inner script's success output
    if (script.includes(T2S_SETUP_FILE)) {
      let inner = '';
      if (lastStagedB64) {
        try { inner = Buffer.from(lastStagedB64, 'base64').toString('utf8'); } catch { inner = ''; }
      }
      if (inner.includes('TUNNEL_TEARDOWN_DONE')) {
        return { exitCode: 0, stdout: 'TUNNEL_TEARDOWN_DONE\n', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: 'root 4444 1 0 10:00:00 ? 00:00:01 /data/local/tmp/tun2socks --device tun0 --proxy socks5://172.17.0.1:20082 --loglevel debug\n',
        stderr: '',
      };
    }
    return {
      exitCode: 0,
      stdout: 'root 4444 1 0 10:00:00 ? 00:00:01 /data/local/tmp/tun2socks --device tun0 --proxy socks5://172.17.0.1:20082 --loglevel debug\n',
      stderr: '',
    };
  }
  return {
    exec,
    calls,
    /**
     * Tests: change the emulated device behavior ({fail, binaryCheck,
     * netcheck, canary}). REPLACE semantics — omitted keys fall back to the
     * healthy defaults (see the ?? fallbacks in exec), so set({}) restores
     * the pristine device. (Merge semantics would make a "the failure
     * clears" reset impossible — live bug found in R3: a stuck canary
     * override survived a set({}) and stalled a recovery scenario.)
     */
    set: (b = {}) => {
      behavior.fail = Boolean(b.fail);
      behavior.binaryCheck = b.binaryCheck;
      behavior.netcheck = b.netcheck;
      behavior.canary = b.canary;
      behavior.stageFail = Boolean(b.stageFail);
    },
  };
}

/**
 * Mock host-side proxy-leg reachability probe (R3): deterministic
 * {ok, error} for the gost-container + listener check. opts.proxyReachableOpts
 * = { ok, error }.
 */
export function createMockProxyReachable({ ok = true, error = null } = {}) {
  const calls = [];
  const behavior = { ok, error };
  async function proxyReachable(row) {
    calls.push({ device: row?.name ?? null, gostPort: row?.gostPort ?? null, at: Date.now() });
    return { ok: behavior.ok, error: behavior.error };
  }
  proxyReachable.calls = calls;
  proxyReachable.set = (b = {}) => Object.assign(behavior, b); // test seam
  return proxyReachable;
}

/**
 * Assemble the full mock redroid environment (app.js REDROID_ADAPTER=mock).
 * @returns {{docker:object, adb:object, preflight:Function, exec:object, proxyReachable:Function}}
 */
export function createMockRedroidEnvironment(opts = {}) {
  // R6 (R5 handoff #5): data-dir removal seam. Default = the REAL guarded
  // implementation (the data dir is real fs under the test tmp root). A test
  // can force a failure shape — the R5 live finding was EACCES on a
  // ROOT-OWNED dir (privileged container files the API uid cannot remove).
  const removeDataDirState = { failure: opts.removeDataDirFailure ?? null };
  const removeDataDir = async (dataDir, dataRoot) => {
    if (removeDataDirState.failure) {
      const e = removeDataDirState.failure;
      const code = e?.code === 'EACCES' || e?.code === 'EPERM' ? 'DATA_DIR_PERM_DENIED' : 'DATA_DIR_REMOVAL_FAILED';
      return { removed: false, code, error: String(e?.message ?? e).slice(0, 200) };
    }
    return removeRedroidDataDir(dataDir, dataRoot);
  };
  return {
    docker: createMockRedroidDockerWrapper(opts),
    adb: createMockAdb(opts),
    preflight: createMockPreflight(),
    exec: createMockExec(opts.execOpts ?? {}),
    proxyReachable: createMockProxyReachable(opts.proxyReachableOpts ?? {}),
    removeDataDir,
    setRemoveDataDirFailure: (err) => { removeDataDirState.failure = err; },
  };
}

void EventEmitter;
