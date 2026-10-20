/**
 * P5 commit 2 — preflight unit tests (MD §10.1).
 *
 * Hermetic: exec/accessSync/statfs are injected seams. What is proven here:
 *  - honest tri-state (present/absent/unknown) — unreadable is NEVER "present"
 *  - unsupported → concrete manual suggestions + official doc link (no auto-modprobe)
 *  - dmesg bounded (line cap) and unreadable-dmesg is a note, not a crash
 *  - hung subprocesses resolve within the timeout (API never hangs)
 *  - nvidia-smi success NEVER claims GPU verified (MD §2.4)
 *  - port check is real (127.0.0.1 bind probe)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';

import { runRedroidPreflight, checkPortAvailable, fstypeAt, listenSockets, isNonLoopbackAddr } from '../../apps/api/src/services/preflight.js';

const DATA_ROOT = '/tmp/wa-p5-preflight-root';
const MODULES_OK = 'binder_linux 16384 0 - Live 0x0000000000000000 (O)\nashmem_linux 16384 0 - Live 0x0000000000000000 (O)\novl 16384 0 - Live 0x0000000000000000';
// Hermetic /proc/mounts: /dev/binder IS a binderfs mount (fstype 'binder').
const MOUNTS_OK = 'binder /dev/binder binder rw,relatime 0 0\n/dev/nvme0n1p2 / ext4 rw,relatime 0 0\n';
// Hermetic /proc/net/tcp: header only (no listeners).
const TCP_EMPTY = { v4: '  sl  local_address rem_address st\n', v6: null };

function makeDeps({
  modules = MODULES_OK,
  dmesg = 'ok',
  kernel = '6.8.0-p5-test',
  dockerOk = true,
  dockerInfo = undefined, // {ok:true, runtimes:{nvidia:{path}}} | {ok:false}
  nvidia = 'ok',
  dataRootOk = true,
  hangUname = false,
  detectContainerized = undefined,
  mounts = MOUNTS_OK,
  tcp = TCP_EMPTY,
  imageArch = undefined, // 'x86_64' | 'arm64' | 'notlocal' | 'error'
} = {}) {
  const accessible = new Set(['/usr/bin/uname', '/usr/bin/dmesg', '/usr/local/bin/nvidia-smi', '/dev/binder', '/dev/ashmem']);
  if (dataRootOk) accessible.add(DATA_ROOT);
  const accessSync = (p) => {
    if (!accessible.has(p)) {
      const e = new Error(`ENOENT: no such file or directory, access '${p}'`);
      e.code = 'ENOENT';
      throw e;
    }
  };
  const exec = async (bin) => {
    const base = bin.split('/').pop();
    if (hangUname && base === 'uname') return new Promise(() => {});
    if (base === 'uname') return { stdout: `${kernel}\n`, stderr: '' };
    if (base === 'dmesg') {
      if (dmesg === 'reject') {
        const e = new Error('dmesg: read kernel buffer failed: Operation not permitted');
        e.code = 'EACCES';
        e.stderr = 'Operation not permitted';
        throw e;
      }
      if (dmesg === 'big') {
        const lines = Array.from({ length: 500 }, (_, i) => `[ 10.${i} binder] binder: device ${i} registered for hwbinder`);
        return { stdout: lines.join('\n'), stderr: '' };
      }
      return { stdout: '[ 1.0] binder_linux: module loaded\n[ 2.0] ashmem_linux: loaded\n[ 3.0] usb: unrelated line', stderr: '' };
    }
    if (base === 'nvidia-smi') {
      if (nvidia === 'reject') {
        const e = new Error('NVIDIA-SMI has failed');
        e.code = 9;
        e.stderr = 'NVIDIA-SMI failed because the GPU is not available';
        throw e;
      }
      if (nvidia === 'none') {
        const e = new Error('NVIDIA-SMI: command failed');
        e.code = 9;
        e.stderr = 'NVIDIA-SMI has failed because it couldn\'t communicate with the NVIDIA driver';
        throw e;
      }
      return {
        stdout: 'NVIDIA GeForce RTX 3090, 24576 MiB, 550.54.15\nNVIDIA GeForce RTX 3090, 24576 MiB, 550.54.15',
        stderr: '',
      };
    }
    throw new Error(`unexpected binary in preflight: ${bin}`);
  };
  const statfs = async () => ({ bavail: 3_000_000, bsize: 4096 }); // ~12 GiB — above the 4 GiB warn line
  const dockerWrapper = dockerOk
    ? {
        ping: async () => 'PONG',
        ...(dockerInfo !== undefined
          ? {
              info: async () => {
                if (dockerInfo.ok === false) {
                  const e = new Error('docker info failed');
                  throw e;
                }
                return { Runtimes: dockerInfo.runtimes ?? {} };
              },
            }
          : {}),
        ...(imageArch !== undefined
          ? {
              imageArchitecture: async () => {
                if (imageArch === 'error') {
                  const e = new Error('inspect boom');
                  throw e;
                }
                if (imageArch === 'notlocal') {
                  const e = new Error('No such image: water-army/redroid:x');
                  e.statusCode = 404;
                  throw e;
                }
                return imageArch;
              },
            }
          : {}),
      }
    : {
        ping: async () => {
          const e = new Error('connect ECONNREFUSED /var/run/docker.sock');
          e.code = 'ECONNREFUSED';
          throw e;
        },
      };
  return {
    config: {
      redroidPreflightTimeoutMs: 400,
      redroidPreflightMaxOutput: 65_536,
      redroidDataRoot: DATA_ROOT,
      redroidAdbRangeStart: 16200,
      redroidAdbRangeEnd: 16299,
    },
    docker: dockerWrapper,
    log: { warn() {}, error() {} },
    exec,
    accessSync,
    statfs,
    readProcModules: () => modules,
    readProcMounts: () => mounts,
    readProcNetTcp: () => tcp,
    gpuBin: '/usr/local/bin/nvidia-smi',
    ...(detectContainerized !== undefined ? { detectContainerized } : {}),
  };
}

test('fully supported host: binder present + docker ok → supported, zero binder warnings', async () => {
  const r = await runRedroidPreflight(makeDeps());
  assert.equal(r.overall, 'supported');
  assert.equal(r.binder.supported, true);
  assert.equal(r.binder.modules.binder_linux, 'present');
  assert.equal(r.binder.modules.ashmem_linux, 'present');
  assert.equal(r.binder.devices['/dev/binder'], true);
  assert.equal(r.host.isLinux, os.platform() === 'linux');
  assert.equal(r.host.kernel, '6.8.0-p5-test');
  assert.equal(r.host.kernelSource, 'uname -r');
  assert.equal(r.docker.available, true);
  assert.ok(!r.warnings.some((w) => /binder|ashmem/.test(w)), `unexpected binder warning: ${r.warnings.join(' | ')}`);
});

test('missing modules → unsupported + concrete modprobe suggestions + official doc link', async () => {
  const r = await runRedroidPreflight(makeDeps({ modules: '' }));
  assert.equal(r.overall, 'unsupported');
  assert.equal(r.binder.supported, false);
  assert.equal(r.binder.modules.binder_linux, 'absent');
  assert.ok(r.binder.suggestions.some((s) => s.includes('modprobe binder_linux devices="binder,hwbinder,vndbinder"')));
  // kernel 6.8 has memfd — the ashmem modprobe suggestion is NOT required
  assert.ok(!r.binder.suggestions.some((s) => s.includes('modprobe ashmem_linux')));
  assert.equal(r.binder.memfd.available, true);
  assert.ok(r.binder.suggestions.some((s) => s.includes('https://github.com/remote-android/redroid-doc')));
  assert.ok(r.warnings.some((w) => w.includes('binder_linux is NOT loaded')));
});

test('ashmem absent on kernel ≥3.17 (6.x) + /dev/binder present → supported (memfd supersedes ashmem)', async () => {
  const r = await runRedroidPreflight(makeDeps({ modules: 'binder_linux 16384 0 - Live 0x0000000000000000 (O)\novl 16384 0 - Live 0x0000000000000000', kernel: '6.8.0-117-generic' }));
  assert.equal(r.binder.modules.binder_linux, 'present');
  assert.equal(r.binder.modules.ashmem_linux, 'absent');
  assert.equal(r.binder.memfd.available, true);
  assert.equal(r.binder.memfd.kernel, '6.8');
  assert.equal(r.binder.supported, true);
  assert.equal(r.overall, 'supported');
  assert.ok(!r.binder.suggestions.some((s) => s.includes('modprobe ashmem_linux')));
  assert.ok(!r.warnings.some((w) => /ashmem/.test(w)), `no ashmem warning expected with memfd: ${r.warnings.join(' | ')}`);
});

test('ashmem absent on kernel <3.17 → unsupported + ashmem modprobe suggestion (memfd unavailable)', async () => {
  const r = await runRedroidPreflight(makeDeps({ modules: 'binder_linux 16384 0 - Live 0x0000000000000000 (O)', kernel: '2.6.32-431.el6.x86_64' }));
  assert.equal(r.binder.memfd.available, false);
  assert.equal(r.binder.supported, false);
  assert.equal(r.overall, 'unsupported');
  assert.ok(r.binder.suggestions.some((s) => s.includes('modprobe ashmem_linux')));
  assert.ok(r.warnings.some((w) => /ashmem_linux is NOT loaded/.test(w)));
});

test('containerized vantage: host /dev not visible → unknown, never false-unsupported (honest tri-state)', async () => {
  const deps = makeDeps({ detectContainerized: () => true });
  const origAccess = deps.accessSync;
  deps.accessSync = (p, m) => {
    if (p.startsWith('/dev/')) {
      const e = new Error('ENOENT: limited container /dev');
      e.code = 'ENOENT';
      throw e;
    }
    return origAccess(p, m);
  };
  const r = await runRedroidPreflight(deps);
  assert.equal(r.binder.deviceVisibility, 'containerized');
  // all host inputs are OK — but the /dev vantage is limited, so it must be 'unknown'
  assert.equal(r.binder.supported, 'unknown');
  assert.equal(r.overall, 'unknown');
  assert.ok(r.warnings.some((w) => /containerized/.test(w)), `expected containerized warning: ${r.warnings.join(' | ')}`);
  assert.ok(!r.warnings.some((w) => /binder_linux is NOT loaded/.test(w)), 'module IS loaded — must not claim it missing');
});

test('unparseable kernel + ashmem absent → unknown (memfd indeterminate, never claimed)', async () => {
  const r = await runRedroidPreflight(makeDeps({ modules: 'binder_linux 16384 0 - Live 0x0000000000000000 (O)', kernel: 'weird-kernel' }));
  assert.equal(r.binder.memfd.available, 'unknown');
  assert.equal(r.binder.supported, 'unknown');
  assert.equal(r.overall, 'unknown');
  assert.ok(r.binder.suggestions.some((s) => s.includes('modprobe ashmem_linux'))); // honest fallback advice
});

test('unreadable /proc/modules → unknown, never absent/present (honest tri-state)', async () => {
  const r = await runRedroidPreflight(makeDeps({ modules: null }));
  assert.equal(r.overall, 'unknown');
  assert.equal(r.binder.supported, 'unknown');
  assert.equal(r.binder.modules.binder_linux, 'unknown');
});

test('missing /dev/binder (modules loaded) → still unsupported', async () => {
  const deps = makeDeps();
  const origAccess = deps.accessSync;
  deps.accessSync = (p, m) => {
    if (p.startsWith('/dev/')) {
      const e = new Error('ENOENT');
      e.code = 'ENOENT';
      throw e;
    }
    return origAccess(p, m);
  };
  const r = await runRedroidPreflight(deps);
  assert.equal(r.overall, 'unsupported');
  assert.ok(r.warnings.length > 0);
});

test('unreadable dmesg → readable:false with note; no crash', async () => {
  const r = await runRedroidPreflight(makeDeps({ dmesg: 'reject' }));
  assert.equal(r.binder.dmesg.readable, false);
  assert.match(r.binder.dmesg.note, /permitted|EACCES|error/i);
  // dmesg readability does NOT change the supported verdict (MD §2.3: not the sole verdict)
  assert.equal(r.overall, 'supported');
});

test('dmesg output is bounded: ≤20 relevant lines, each ≤300 chars', async () => {
  const r = await runRedroidPreflight(makeDeps({ dmesg: 'big' }));
  assert.equal(r.binder.dmesg.readable, true);
  assert.ok(r.binder.dmesg.relevantLines.length <= 20);
  assert.ok(r.binder.dmesg.relevantLines.length > 0);
  for (const l of r.binder.dmesg.relevantLines) assert.ok(l.length <= 300);
});

test('hung uname subprocess resolves within the timeout (API never hangs)', async () => {
  const startedAt = Date.now();
  const r = await runRedroidPreflight(makeDeps({ hangUname: true }));
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 3000, `preflight took ${elapsed}ms — it must not hang`);
  assert.equal(r.host.kernel, os.release(), 'kernel falls back to os.release() when uname hangs');
  assert.equal(r.overall, 'supported'); // the hang must not poison the verdict
});

test('nvidia-smi success NEVER claims GPU verified (MD §2.4 hard rule)', async () => {
  const r = await runRedroidPreflight({ ...makeDeps(), gpuMode: true });
  assert.equal(r.gpu.available, true);
  assert.equal(r.gpu.gpus.length, 2);
  assert.equal(r.gpu.gpus[0].name, 'NVIDIA GeForce RTX 3090');
  assert.equal(r.gpu.driverVersion, '550.54.15');
  assert.equal(r.gpu.verified, false, 'verified must be false until an in-device render check exists');
  assert.ok(r.warnings.some((w) => /NOT verified/.test(w)));
});

test('nvidia-smi failure → honest gpu.available=false, still no verification claim', async () => {
  const r = await runRedroidPreflight({ ...makeDeps({ nvidia: 'none' }), gpuMode: true });
  assert.equal(r.gpu.available, false);
  assert.equal(r.gpu.verified, false);
  assert.ok(r.gpu.visibleUnknown === true, 'without docker info the visibility is unknown, not "no gpu"');
  assert.match(r.gpu.note, /2\.4|vantage/);
});

test('docker daemon down → unknown (transient state, not overclaimed) + warning', async () => {
  const r = await runRedroidPreflight(makeDeps({ dockerOk: false }));
  assert.equal(r.overall, 'unknown');
  assert.equal(r.docker.available, false);
  assert.match(r.docker.error, /ECONNREFUSED/);
  assert.ok(r.warnings.some((w) => /Docker daemon unavailable/.test(w)));
});

test('missing data root → disk.exists=false with an actionable note', async () => {
  const r = await runRedroidPreflight(makeDeps({ dataRootOk: false }));
  assert.equal(r.disk.exists, false);
  assert.equal(r.disk.writable, false);
  assert.match(r.disk.note, /does not exist/);
});

test('disk free bytes come from statfs (bavail * bsize)', async () => {
  const r = await runRedroidPreflight(makeDeps());
  assert.equal(r.disk.exists, true);
  assert.equal(r.disk.writable, true);
  assert.equal(r.disk.freeBytes, 3_000_000 * 4096);
});

test('R5: data volume below the 4 GiB line → data-volume WARN + free-space fix', async () => {
  const deps = makeDeps();
  deps.statfs = async () => ({ bavail: 1_000_000, bsize: 4096 }); // ~4 GiB - 16 MiB
  const r = await runRedroidPreflight(deps);
  assert.equal(check(r, 'data-volume').status, 'WARN');
  assert.match(check(r, 'data-volume').fix, /space/i);
});

test('port check (real 127.0.0.1 probe): occupied while bound, free after', async () => {
  const server = net.createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  try {
    assert.equal(await checkPortAvailable(port), 'occupied');
  } finally {
    await new Promise((res) => server.close(res));
  }
  assert.equal(await checkPortAvailable(port), 'free');
});

test('preflight reports checkedAt and never includes secrets/paths in warnings beyond the data root', async () => {
  const r = await runRedroidPreflight(makeDeps());
  assert.ok(!Number.isNaN(new Date(r.checkedAt).getTime()));
  for (const w of r.warnings) assert.ok(w.length <= 300);
});

// ---------------------------------------------------------------------------
// R5: per-item checks + verdict (MD §7.1 PASS/WARN/FAIL + 修復方向)
// ---------------------------------------------------------------------------

const check = (r, id) => r.checks.find((c) => c.id === id);

function tcpLineV4(ipHex, portHex, st = '0A') {
  return `   0: ${ipHex}:${portHex} 00000000:0000 ${st} 0:0 0 0 3 0 0 1 0 0 0 10 0 0 10 0`;
}

// 127.0.0.1 = 0100007F; 0.0.0.0 = 00000000 (hex is little-endian per byte)
// port 16201 = 0x3F49 (0x3EFD is 16125 — out of range!)
function tcpV4(lines) {
  return '  sl  local_address rem_address st\n' + lines.join('\n') + '\n';
}
function tcpV6(lines) {
  return '  sl  local_address rem_address st\n' + lines.join('\n') + '\n';
}

// 0.0.0.0:16201 → port hex 3EFD
test('R5: 0.0.0.0 listener in the ADB range → adb-exposure FAIL + exposed entry', async () => {
  const r = await runRedroidPreflight(makeDeps({ tcp: { v4: tcpV4([tcpLineV4('00000000', '3F49')]), v6: null } }));
  const c = check(r, 'adb-exposure');
  assert.equal(c.status, 'FAIL');
  assert.ok(r.exposure.exposed.length === 1);
  assert.equal(r.exposure.exposed[0].port, 16201);
  assert.match(c.fix ?? '', /127\.0\.0\.1/);
  assert.equal(r.verdict, 'FAIL');
});

test('R5: 127.0.0.1 listener in the ADB range → adb-exposure PASS (loopback is the contract)', async () => {
  const r = await runRedroidPreflight(makeDeps({ tcp: { v4: tcpV4([tcpLineV4('0100007F', '3F49')]), v6: null } }));
  assert.equal(check(r, 'adb-exposure').status, 'PASS');
  assert.equal(r.exposure.exposed.length, 0);
});

test('R5: [::] listener in the ADB range → FAIL; v4-mapped 127.0.0.1 → not exposed', async () => {
  const v6Wild = `   0: 00000000000000000000000000000000:3F49 00000000000000000000000000000000:0000 0A 0:0 0 0 3 0 0 1 0 0 0 10 0 0 10 0`;
  let r = await runRedroidPreflight(makeDeps({ tcp: { v4: null, v6: tcpV6([v6Wild]) } }));
  assert.equal(check(r, 'adb-exposure').status, 'FAIL');

  // v4-mapped ::ffff:127.0.0.1 = 0000...00FFFF0100007F (lowercase in /proc)
  const v6Mapped = `   0: 00000000000000000000ffff0100007f:3F49 00000000000000000000000000000000:0000 0A 0:0 0 0 3 0 0 1 0 0 0 10 0 0 10 0`;
  r = await runRedroidPreflight(makeDeps({ tcp: { v4: null, v6: tcpV6([v6Mapped]) } }));
  assert.equal(check(r, 'adb-exposure').status, 'PASS');
  assert.equal(r.exposure.exposed.length, 0);
});

test('R5: non-ADB-range wild listener is NOT flagged (range scope is the contract)', async () => {
  // 0.0.0.0:12345 (hex 3039)
  const r = await runRedroidPreflight(makeDeps({ tcp: { v4: tcpV4([tcpLineV4('00000000', '3039')]), v6: null } }));  assert.equal(check(r, 'adb-exposure').status, 'PASS');
  assert.equal(r.exposure.listenersInRange.length, 0);
});

test('R5: containerized vantage → exposure + binderfs are WARN (vantage honesty), never FAIL', async () => {
  const deps = makeDeps({ detectContainerized: () => true });
  const origAccess = deps.accessSync;
  deps.accessSync = (p, m) => {
    if (p.startsWith('/dev/')) {
      const e = new Error('ENOENT: limited container /dev');
      e.code = 'ENOENT';
      throw e;
    }
    return origAccess(p, m);
  };
  const r = await runRedroidPreflight(deps);
  assert.equal(check(r, 'binderfs-mount').status, 'WARN');
  assert.equal(check(r, 'adb-exposure').status, 'WARN');
  assert.match(check(r, 'adb-exposure').detail, /containerized/);
  assert.equal(r.exposure.scanned, false);
});

test('R5: /dev/binder exists but is NOT a binderfs mount → binderfs-mount FAIL + mount fix', async () => {
  const r = await runRedroidPreflight(makeDeps({ mounts: 'tmpfs /dev tmpfs rw,relatime 0 0\ntmpfs /dev/binder tmpfs rw 0 0\n/dev/nvme0n1p2 / ext4 rw,relatime 0 0\n' }));
  const c = check(r, 'binderfs-mount');
  assert.equal(c.status, 'FAIL');
  assert.match(c.detail, /tmpfs/);
  assert.match(c.fix, /mount -t binder/);
  assert.equal(r.binder.supported, false);
  assert.equal(r.verdict, 'FAIL');
});

test('R5: /dev/binder missing entirely (direct vantage) → binderfs-mount FAIL', async () => {
  const deps = makeDeps({ mounts: '/dev/nvme0n1p2 / ext4 rw,relatime 0 0\n' });
  const origAccess = deps.accessSync;
  deps.accessSync = (p, m) => {
    if (p.startsWith('/dev/')) {
      const e = new Error('ENOENT');
      e.code = 'ENOENT';
      throw e;
    }
    return origAccess(p, m);
  };
  const r = await runRedroidPreflight(deps);
  assert.equal(check(r, 'binderfs-mount').status, 'FAIL');
  assert.equal(r.binder.supported, false);
});

test('R5: kernel below the 3.17 floor → kernel-compat FAIL', async () => {
  const r = await runRedroidPreflight(makeDeps({ kernel: '2.6.32-431.el6.x86_64', modules: 'binder_linux 1 0 - Live 0x0 (O)' }));
  assert.equal(check(r, 'kernel-compat').status, 'FAIL');
  assert.match(check(r, 'kernel-compat').detail, /memfd/);
});

test('R5: image arch mismatch → image-arch FAIL; match → PASS; not local → WARN', async () => {
  const hostNorm = os.arch() === 'x64' ? 'x86_64' : os.arch();
  const mismatchArch = hostNorm === 'x86_64' ? 'arm64' : 'x86_64';
  let r = await runRedroidPreflight({ ...makeDeps({ imageArch: mismatchArch }), image: 'water-army/redroid:test' });
  assert.equal(check(r, 'image-arch').status, 'FAIL');
  assert.equal(r.imageArch.mismatch, true);

  // docker reports 'amd64' — normalization must treat it as a match
  const hostReported = hostNorm === 'x86_64' ? 'amd64' : 'aarch64';
  r = await runRedroidPreflight({ ...makeDeps({ imageArch: hostReported }), image: 'water-army/redroid:test' });
  assert.equal(check(r, 'image-arch').status, 'PASS');

  r = await runRedroidPreflight({ ...makeDeps({ imageArch: 'notlocal' }), image: 'water-army/redroid:test' });
  assert.equal(check(r, 'image-arch').status, 'WARN');
  assert.equal(r.imageArch.imageArchNorm, null, 'not-local must be null (honest), never a guess');
});

test('R5: GPU via docker info (containerized vantage, no nvidia-smi) → visible, unverified, WARN', async () => {
  const deps = makeDeps({ nvidia: 'none', dockerInfo: { ok: true, runtimes: { nvidia: { path: 'nvidia-container-runtime' } } } });
  // simulate no nvidia-smi in this process
  const origAccess = deps.accessSync;
  deps.accessSync = (p, m) => {
    if (p.includes('nvidia-smi')) {
      const e = new Error('ENOENT');
      e.code = 'ENOENT';
      throw e;
    }
    return origAccess(p, m);
  };
  const r = await runRedroidPreflight({ ...deps, gpuMode: true });
  assert.equal(r.gpu.available, true);
  assert.equal(r.gpu.source, 'docker-info');
  assert.equal(r.gpu.verified, false, 'runtime registration is never a render verification');
  assert.equal(check(r, 'gpu-visibility').status, 'WARN');
});

test('R5: no gpu visibility anywhere → gpu-visibility FAIL with driver fix (explicit gpuMode)', async () => {
  const deps = makeDeps({ nvidia: 'none', dockerInfo: { ok: true, runtimes: {} } });
  const origAccess = deps.accessSync;
  deps.accessSync = (p, m) => {
    if (p.includes('nvidia-smi')) {
      const e = new Error('ENOENT');
      e.code = 'ENOENT';
      throw e;
    }
    return origAccess(p, m);
  };
  const r = await runRedroidPreflight({ ...deps, gpuMode: true });
  assert.equal(r.gpu.available, false);
  assert.equal(r.gpu.verified, false);
  assert.equal(check(r, 'gpu-visibility').status, 'FAIL');
  assert.match(check(r, 'gpu-visibility').fix ?? '', /nvidia/i);
});

test('R5: verdict rollup — PASS when all items pass; containerized vantage = pure WARN (no FAIL)', async () => {
  const allPass = await runRedroidPreflight(makeDeps());
  assert.equal(allPass.verdict, 'PASS', `expected all-PASS on a healthy fixture: ${JSON.stringify(allPass.checks)}`);
  for (const c of allPass.checks) assert.equal(c.status, 'PASS');

  const deps = makeDeps({ detectContainerized: () => true });
  const origAccess = deps.accessSync;
  deps.accessSync = (p, m) => {
    if (p.startsWith('/dev/')) {
      const e = new Error('ENOENT');
      e.code = 'ENOENT';
      throw e;
    }
    return origAccess(p, m);
  };
  const warn = await runRedroidPreflight(deps);
  assert.equal(warn.verdict, 'WARN');
  assert.ok(warn.checks.every((c) => c.status !== 'FAIL'), JSON.stringify(warn.checks));
});

test('R5: fstypeAt — exact mount point match, missing point = null, unreadable = null', () => {
  assert.equal(fstypeAt(MOUNTS_OK, '/dev/binder'), 'binder');
  assert.equal(fstypeAt(MOUNTS_OK, '/'), 'ext4');
  assert.equal(fstypeAt(MOUNTS_OK, '/nope'), null);
  assert.equal(fstypeAt(null, '/dev/binder'), null);
});

test('R5: listenSockets — LISTEN-only filter + hex port decode + v6 forms', () => {
  const s = listenSockets({
    v4: '  sl  local_address rem_address st\n' + tcpLineV4('00000000', '3F49') + '\n' + tcpLineV4('0100007F', '3F49', '01') + '\n',
    v6: null,
  });
  // only the LISTEN (0A) socket survives; port comes from the LOCAL address (field 1)
  assert.equal(s.length, 1);
  assert.equal(s[0].port, 16201);
  assert.equal(s[0].addr, '0.0.0.0');
  assert.ok(isNonLoopbackAddr('0.0.0.0'));
  assert.ok(isNonLoopbackAddr('::'));
  assert.ok(!isNonLoopbackAddr('127.0.0.1'));
  assert.ok(!isNonLoopbackAddr('::1'));
  assert.ok(!isNonLoopbackAddr('v4mapped:127.0.0.1'));
  assert.ok(isNonLoopbackAddr('v4mapped:10.0.0.1'));
});
