#!/usr/bin/env node
/**
 * redroid-preflight CLI (R5 / 施工 MD §7.1) — CI-friendly, READ-ONLY host
 * prerequisite check for the Redroid launch path.
 *
 *   node apps/api/src/cli/preflight.js [--json] [--gpu] [--port N]
 *       [--image <ref>] [--fail-on-warn]
 *
 * Exit codes (CI gate semantics):
 *   0 = PASS, or WARN without --fail-on-warn
 *   1 = WARN with --fail-on-warn (strict gate)
 *   2 = FAIL (at least one item FAIL), or CLI misuse/config error
 *
 * Vantage: runs wherever you run it. From a container, host-namespace items
 * (/dev, /proc/mounts, /proc/net/tcp, nvidia-smi) are reported as WARN with
 * the vantage stated — run this ON THE HOST for the authoritative result.
 *
 * Safety (MD §7.1): this command ONLY reads (bounded uname/dmesg/nvidia-smi
 * exec, /proc reads, docker socket ping/info/image-inspect). It never
 * installs modules, mounts anything, opens ports, or mutates host state.
 * It does not connect to the database or redis (placeholders satisfy config
 * validation only).
 */
import process from 'node:process';
import { loadConfig } from '../config.js';
import { createDockerClient } from '../plugins/docker.js';
import { runRedroidPreflight } from '../services/preflight.js';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const i = args.indexOf(f);
  return i === -1 ? undefined : args[i + 1];
};
const wantJson = has('--json');
const wantGpu = has('--gpu');
const wantFailOnWarn = has('--fail-on-warn');
const portArg = val('--port');
const imageArg = val('--image');

const bad =
  args.some((a) => a.startsWith('-') && !['--json', '--gpu', '--fail-on-warn', '--port', '--image'].includes(a)) ||
  (has('--port') && !/^[1-9][0-9]{0,4}$/.test(portArg ?? '')) ||
  (has('--image') && !(imageArg && imageArg.length >= 3));
if (bad) {
  process.stderr.write('usage: preflight.js [--json] [--gpu] [--port N] [--image <ref>] [--fail-on-warn]\n');
  process.exit(2);
}

// Config: DB/redis are NOT contacted by this tool — placeholders pass the
// shape validation only (documented; the tool has no db/redis import).
const env = { ...process.env };
if (!env.DATABASE_URL) env.DATABASE_URL = 'postgresql://preflight-cli:nodb@127.0.0.1:5432/preflight-cli';
if (!env.REDIS_URL) env.REDIS_URL = 'redis://127.0.0.1:6379';
let config;
try {
  config = loadConfig(env, { envFile: false });
} catch (err) {
  process.stderr.write(`config error: ${err.message}\n`);
  process.exit(2);
}

const docker = createDockerClient({ dockerSocketPath: env.DOCKER_SOCKET_PATH ?? '/var/run/docker.sock' });

try {
  const result = await runRedroidPreflight({
    config,
    docker: {
      ping: () => docker.ping(),
      info: () => (docker.client ? docker.client.info() : Promise.reject(new Error('docker client not configured'))),
      imageArchitecture: async (name) => {
        if (!docker.client) return null;
        try {
          const meta = await docker.client.getImage(name).inspect();
          return meta?.Architecture ?? null;
        } catch (err) {
          if (err?.statusCode === 404 || /no such image/i.test(String(err?.message ?? ''))) return null;
          throw err;
        }
      },
    },
    gpuMode: wantGpu,
    port: portArg ? Number(portArg) : null,
    image: imageArg,
  });

  if (wantJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    const line = (c) => {
      const fix = c.fix ? `  → ${c.fix}` : '';
      return `  ${c.status.padEnd(5)} ${c.id.padEnd(18)} ${c.detail}${fix}`;
    };
    process.stdout.write(`redroid preflight — ${result.checkedAt}\n`);
    process.stdout.write(`host: ${result.host.platform}/${result.host.arch} kernel ${result.host.kernel} (${result.host.kernelSource})\n`);
    process.stdout.write(`\nitems:\n`);
    for (const c of result.checks) process.stdout.write(line(c) + '\n');
    if (result.warnings.length) {
      process.stdout.write(`\nwarnings:\n`);
      for (const w of result.warnings) process.stdout.write(`  ! ${w}\n`);
    }
    if (result.gpu) {
      process.stdout.write(`\ngpu: ${result.gpu.detail ?? 'n/a'}\n`);
      process.stdout.write(`      ${result.gpu.note ?? ''}\n`);
    }
    process.stdout.write(`\nverdict: ${result.verdict}  (binder=${result.binder.supported}, docker=${result.docker.available === true ? 'up' : result.docker.available === false ? 'down' : 'unknown'})\n`);
  }

  const code = result.verdict === 'FAIL' ? 2 : result.verdict === 'WARN' && wantFailOnWarn ? 1 : 0;
  process.exit(code);
} catch (err) {
  process.stderr.write(`preflight error: ${err?.message ?? err}\n`);
  process.exit(2);
}
