/**
 * R1 live F-B proof driver — real service geometry against a real container.
 *
 * Uses dockerode's exec API with Cmd:['sh','-c',script] — byte-identical to
 * execInContainer (redroid-service.js:433-464) — so this is the same call
 * path the API uses, no host shell in between (which is exactly what makes
 * F-B solvable: the script text never enters any shell's argv as a cmdline
 * other than the in-container `sh -c` runner, and that runner's cmdline is
 * the clean buildT2sRunScript() body).
 *
 * Sequence (device wa-r1-imgrun, proxy = local test socks5 on
 * 172.17.0.1:20179 — the gost port shape the setup script expects):
 *   S1 stage setup      → rc=0 + T2S_STAGED
 *   R1 run setup        → rc=0 + tun2socks visible
 *   V1 pidof            → exactly one pid (A)
 *   S2 stage setup (idempotency: same file path, same content)
 *   R2 run setup        → rc=0 (2nd run: in-file pkill must kill A, not the runner)
 *   V2 pidof            → exactly one pid (B), B !== A  ← pkill proof
 *   C1 canary           → /data/local/tmp/tun2socks --version rc=0
 *   S3 stage teardown
 *   R3 run teardown     → rc=0 + TUNNEL_TEARDOWN_DONE
 *   V3 pidof            → empty (daemon gone), staged file removed
 *
 * Exit 0 = all proofs passed.
 */
import Docker from 'dockerode';
import {
  buildT2sStageScript,
  buildT2sRunScript,
  buildTunnelSetupScript,
  buildTunnelTeardownScript,
} from '../apps/api/src/services/redroid-service.js';

const CONTAINER = process.argv[2] || 'wa-r1-imgrun';
const GOST_PORT = Number(process.argv[3] || 20179);
const docker = new Docker();
const results = [];

async function exec(script, { timeoutMs = 120000 } = {}) {
  const c = docker.getContainer(CONTAINER);
  const ex = await c.exec({ Cmd: ['sh', '-c', script], AttachStdout: true, AttachStderr: true });
  const chunks = [];
  const stream = await ex.start({ hijack: false, stream: true });
  stream.on('data', (d) => chunks.push(d));
  const done = await new Promise((res) => {
    const t = setTimeout(() => res('timeout'), timeoutMs);
    stream.on('end', () => { clearTimeout(t); res('end'); });
    stream.on('close', () => { clearTimeout(t); res('close'); });
    stream.on('error', () => { clearTimeout(t); res('error'); });
  });
  let exitCode = 1;
  try { exitCode = (await ex.inspect())?.ExitCode ?? 1; } catch {}
  return { exitCode: done === 'timeout' ? 124 : exitCode, out: Buffer.concat(chunks).toString('utf8') };
}

function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: String(detail ?? '').slice(0, 300) });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name} :: ${String(detail ?? '').slice(0, 200).replace(/\n/g, ' | ')}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const setupStage = buildT2sStageScript(buildTunnelSetupScript({ gostPort: GOST_PORT }));
const teardownStage = buildT2sStageScript(buildTunnelTeardownScript());
const run = buildT2sRunScript();

const s1 = await exec(setupStage);
check('S1 stage setup', s1.exitCode === 0 && s1.out.includes('T2S_STAGED'), `rc=${s1.exitCode} ${s1.out.trim()}`);

const r1 = await exec(run);
check('R1 run setup (1st provision)', r1.exitCode === 0 && /tun2socks/.test(r1.out), `rc=${r1.exitCode} ${r1.out.trim()}`);
await sleep(3000);

const v1 = await exec('pidof tun2socks || true');
const pidA = String(v1.out).trim().split(/\s+/).filter(Boolean);
check('V1 one daemon after 1st provision', v1.exitCode === 0 && pidA.length === 1, `pids=${JSON.stringify(pidA)}`);

const s2 = await exec(setupStage);
check('S2 stage setup (idempotent restage)', s2.exitCode === 0 && s2.out.includes('T2S_STAGED'), `rc=${s2.exitCode}`);

const r2 = await exec(run);
check('R2 run setup (2nd provision — in-file pkill vs live daemon)', r2.exitCode === 0 && /tun2socks/.test(r2.out), `rc=${r2.exitCode} ${r2.out.trim()}`);
await sleep(2000);

const v2 = await exec('pidof tun2socks || true');
const pidB = String(v2.out).trim().split(/\s+/).filter(Boolean);
check('V2 still exactly one daemon after 2nd provision', pidB.length === 1, `pids=${JSON.stringify(pidB)}`);
check('V3 pid changed (old daemon A killed by bracketed pkill, not the runner)', pidB.length === 1 && pidA.length === 1 && pidB[0] !== pidA[0], `A=${pidA} B=${pidB}`);

const c1 = await exec('/data/local/tmp/tun2socks --version');
check('C1 binary canary (--version rc=0)', c1.exitCode === 0 && /tun2socks-/.test(c1.out), `rc=${c1.exitCode} ${c1.out.trim()}`);

const s3 = await exec(teardownStage);
check('S4 stage teardown', s3.exitCode === 0 && s3.out.includes('T2S_STAGED'), `rc=${s3.exitCode}`);

const r3 = await exec(run);
check('R4 run teardown', r3.exitCode === 0 && r3.out.includes('TUNNEL_TEARDOWN_DONE'), `rc=${r3.exitCode} ${r3.out.trim()}`);
await sleep(1000);

const v3 = await exec('pidof tun2socks || true');
check('V4 no daemon after teardown', String(v3.out).trim() === '', `out='${String(v3.out).trim()}'`);

const v4 = await exec('test ! -f /data/local/tmp/.t2s-setup.sh && echo STAGED_FILE_CLEAN || echo STAGED_FILE_LEFTOVER');
check('V5 staged file removed after run', v4.out.includes('STAGED_FILE_CLEAN'), v4.out.trim());

const failed = results.filter((r) => !r.ok);
console.log(`\n=== F-B LIVE PROOF SUMMARY: ${results.length - failed.length}/${results.length} passed ===`);
process.exit(failed.length ? 1 : 0);
