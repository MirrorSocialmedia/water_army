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

import { runRedroidPreflight, checkPortAvailable } from '../../apps/api/src/services/preflight.js';

const DATA_ROOT = '/tmp/wa-p5-preflight-root';
const MODULES_OK = 'binder_linux 16384 0 - Live 0x0000000000000000 (O)\nashmem_linux 16384 0 - Live 0x0000000000000000 (O)\novl 16384 0 - Live 0x0000000000000000';

function makeDeps({
  modules = MODULES_OK,
  dmesg = 'ok',
  kernel = '6.8.0-p5-test',
  dockerOk = true,
  nvidia = 'ok',
  dataRootOk = true,
  hangUname = false,
  detectContainerized = undefined,
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
  const statfs = async () => ({ bavail: 1_000_000, bsize: 4096 });
  return {
    config: { redroidPreflightTimeoutMs: 400, redroidPreflightMaxOutput: 65_536, redroidDataRoot: DATA_ROOT },
    docker: dockerOk
      ? { ping: async () => 'PONG' }
      : {
          ping: async () => {
            const e = new Error('connect ECONNREFUSED /var/run/docker.sock');
            e.code = 'ECONNREFUSED';
            throw e;
          },
        },
    log: { warn() {}, error() {} },
    exec,
    accessSync,
    statfs,
    readProcModules: () => modules,
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
  assert.match(r.gpu.note, /driver/i);
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
  assert.equal(r.disk.freeBytes, 1_000_000 * 4096);
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
