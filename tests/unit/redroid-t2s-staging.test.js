/**
 * F-B (R1, 2026-10-20) — pkill self-kill regression + staged-script contract.
 *
 * The bug: the exec seam runs `docker exec … sh -c '<script text>'`, so the
 * script text lives IN THE RUNNER'S CMDLINE. The tunnel setup script contains
 * the literal tun2socks path (nohup line) — so `pkill -f tun2socks` (and even
 * the bracket trick, because the nohup line is itself the daemon's cmdline
 * shape) matched the runner → pkill SIGTERMed its own shell (rc=143). The
 * tunnel could never be provisioned by the repo code path (repro + evidence:
 * docs/audits/repair-baseline.md §5.4).
 *
 * The fix: stage the script as a FILE (base64 → /data/local/tmp/.t2s-setup.sh)
 * and run `sh <file>` — the runner cmdline is then free of any tun2socks
 * literal, so the in-file pkill can only match the real daemon.
 *
 * These tests prove, with REAL process execution (host sh + pkill):
 *  1. the OLD pattern self-kills a runner whose cmdline contains it (the bug)
 *  2. the NEW staged geometry does NOT self-kill, and still kills a real
 *     stale-daemon stand-in (a process whose cmdline contains 'tun2socks')
 *
 * Note: host pkill is procps (documented: never kills itself). The toybox
 * pkill inside the redroid image is additionally validated live (R1 evidence,
 * runbook §10).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import {
  T2S_SETUP_FILE,
  TUN2SOCKS_PIN,
  TUN,
  buildTunnelSetupScript,
  buildTunnelTeardownScript,
  buildT2sStageScript,
  buildT2sRunScript,
  tun2socksAssetUrl,
} from '../../apps/api/src/services/redroid-service.js';

const hasPkill = spawnSync('sh', ['-c', 'command -v pkill >/dev/null 2>&1']).status === 0;

/** Spawn `sh -c <script>`; the runner's cmdline is `sh -c <script>` — the exact geometry the exec seam creates. */
function runShell(script, { timeoutMs = 15000 } = {}) {
  return spawnSync('sh', ['-c', script], { encoding: 'utf8', timeout: timeoutMs });
}

/** A stand-in for a stale tun2socks daemon: a long-lived node process whose cmdline contains the literal token. */
function startT2sStandIn() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)', 'tun2socks'], { stdio: 'ignore', detached: false });
  child.unref();
  return child;
}

function killStandIn(child) {
  if (child && !child.killed) {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/** True when the stand-in has fully vanished from the pid table (ESRCH). Node's ChildProcess 'exit' event can lag or never arrive for externally signalled children in this environment, so we poll the pid directly — that is the ground truth. */
async function waitStandInGone(child, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(child.pid, 0); // signal 0 = existence probe
    } catch (e) {
      if (e.code === 'ESRCH') return true;
      throw e;
    }
    if (Date.now() > deadline) return false;
    await new Promise((res) => setTimeout(res, 100));
  }
}

// ---------------------------------------------------------------------------
// Staged-script contract (pure)
// ---------------------------------------------------------------------------

test('f-b: run script — runner cmdline is tun2socks-free and propagates the inner exit code', () => {
  const run = buildT2sRunScript();
  // THE core F-B invariant: whatever sits in the runner's cmdline must not
  // contain the literal token that pkill -f hunts for.
  assert.ok(!run.includes('tun2socks'), 'run script must not contain the literal tun2socks');
  assert.ok(!/[t]un2socks/.test(run), 'run script must not even match the daemon regex');
  assert.match(run, new RegExp(`sh ${T2S_SETUP_FILE.replace(/[/\\.^$*+?()[\]{}|]/g, '\\$&')} 2>&1`));
  assert.match(run, /^sh .* 2>&1\nrc=\$\?\nrm -f .*\.sh\nexit \$rc$/);
});

test('f-b: stage script — base64 round-trip, 0700, done-signal, shell-safe blob', () => {
  const inner = buildTunnelSetupScript({ gostPort: 20082 });
  const stage = buildT2sStageScript(inner);
  const m = stage.match(/printf '%s' '([A-Za-z0-9+\/=]+)' \| base64 -d > (.+)$/m);
  assert.ok(m, 'stage script must carry the b64 blob');
  assert.equal(Buffer.from(m[1], 'base64').toString('utf8'), inner, 'b64 must round-trip to the exact inner script');
  assert.match(stage, /chmod 0700/);
  assert.match(stage, /echo T2S_STAGED/);
  // the blob is single-quote-safe by construction (charset check)
  assert.match(m[1], /^[A-Za-z0-9+\/=]+$/);
  assert.ok(stage.split('\n').length === 3, 'stage script is exactly 3 lines');
});

test('f-b: inner scripts — pkill pattern is bracketed + quoted (defense in depth)', () => {
  for (const script of [buildTunnelSetupScript({ gostPort: 20082 }), buildTunnelTeardownScript()]) {
    assert.match(script, /pkill -f "\[t\]un2socks" 2>\/dev\/null \|\| true/);
    // and NO bare unbracketed pkill form remains anywhere
    assert.ok(!/pkill -f tun2socks/.test(script), 'bare pkill form must be gone');
  }
});

test('f-b: pin constant — derived URL is version-pinned (no floating latest)', () => {
  assert.equal(tun2socksAssetUrl(), TUN2SOCKS_PIN.url);
  assert.ok(!/latest/i.test(TUN2SOCKS_PIN.url), 'no floating "latest" in the asset URL');
  assert.match(TUN2SOCKS_PIN.url, new RegExp(`^https://github\\.com/xjasonlyu/tun2socks/releases/download/v${TUN2SOCKS_PIN.version}/${TUN2SOCKS_PIN.asset}$`));
  assert.match(TUN2SOCKS_PIN.sha256, /^[a-f0-9]{64}$/);
});

// ---------------------------------------------------------------------------
// F-B self-kill regression (real execution)
// ---------------------------------------------------------------------------

test('f-b regression: the OLD inline pattern self-kills its runner (bug, documented)', { skip: !hasPkill ? 'no pkill on host' : false }, async () => {
  const runner = `pkill -f tun2socks 2>/dev/null || true; echo after-pkill-still-alive`;
  // The runner's own cmdline contains the literal 'tun2socks' (as the pkill
  // argument) → pkill -f matches the runner itself → SIGTERM before the echo.
  const r = runShell(runner);
  assert.ok(!String(r.stdout).includes('after-pkill-still-alive'), 'runner must have been killed by its own pkill (pre-fix behavior)');
  assert.ok(r.signal === 'SIGTERM' || (r.status ?? 0) !== 0, `expected SIGTERM/kill, got status=${r.status} signal=${r.signal}`);
});

test('f-b fix: bracketed pattern kills a real stale-daemon stand-in but NOT its own runner', { skip: !hasPkill ? 'no pkill on host' : false }, async (t) => {
  const victim = startT2sStandIn();
  t.after(() => killStandIn(victim));
  await new Promise((res) => setTimeout(res, 300)); // let the victim's cmdline settle in /proc

  const runner = `pkill -f "[t]un2socks" 2>/dev/null || true; echo after-pkill-still-alive`;
  const r = runShell(runner);
  assert.equal(r.status, 0, `runner must survive (stdout=${r.stdout} stderr=${r.stderr} signal=${r.signal})`);
  assert.ok(String(r.stdout).includes('after-pkill-still-alive'), 'runner reached the echo — not self-killed');

  assert.ok(await waitStandInGone(victim), 'stale-daemon stand-in must have been killed by pkill');
});

test('f-b fix: staged geometry (sh <file> runner) — no self-kill, stale daemon still killed', { skip: !hasPkill ? 'no pkill on host' : false }, async (t) => {
  // Reproduce the EXACT production geometry with a tmp path in place of the
  // in-device path: runner = buildT2sRunScript() text, inner = the real
  // teardown's pkill line + a done-signal.
  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-r1-fb-')), 't2s-setup.sh');
  t.after(() => fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }));
  fs.writeFileSync(tmpFile, [
    'pkill -f "[t]un2socks" 2>/dev/null || true',
    'echo inner-alive',
  ].join('\n'));

  const victim = startT2sStandIn();
  t.after(() => killStandIn(victim));
  await new Promise((res) => setTimeout(res, 300));

  const runner = buildT2sRunScript().split(T2S_SETUP_FILE).join(tmpFile); // swap the in-device path
  assert.ok(runner.includes('exit $rc'), 'swapped runner keeps the exit-code propagation');
  const r = runShell(runner);
  assert.ok(r.status === 0, `staged runner must survive (status=${r.status} signal=${r.signal} stderr=${r.stderr})`);
  assert.ok(String(r.stdout).includes('inner-alive'), 'inner script ran to completion');
  assert.ok(!fs.existsSync(tmpFile), 'staged file removed after the run (no residue)');

  assert.ok(await waitStandInGone(victim), 'stale daemon stand-in killed by the in-file pkill');
});

// ---------------------------------------------------------------------------
// R2 (2026-10-20) — fresh-/data volume shadowing: canonical ← fallback self-heal
// ---------------------------------------------------------------------------

test('r2: setup script carries the self-heal before start', () => {
  const s = buildTunnelSetupScript({ gostPort: 20082 });
  const healIdx = s.indexOf(`cp ${TUN.binFallback} ${TUN.bin}`);
  const nohupIdx = s.indexOf('nohup');
  assert.ok(healIdx >= 0, 'self-heal cp line present (fresh /data shadows the baked canonical)');
  assert.ok(nohupIdx >= 0 && healIdx < nohupIdx, 'self-heal runs BEFORE tun2socks starts');
  assert.ok(s.includes(`chmod 0755 ${TUN.bin}`), 'restored binary is made executable');
  // conditional: never clobbers a healthy canonical
  assert.match(s, /if \[ ! -f [^\]]+ \] && \[ -f [^\]]+ \]; then cp/);
});

test('r2: self-heal line executes for real (sh) — restore / no-clobber / no-op', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-r2-heal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const canonical = path.join(dir, 'canonical'); // neutral names: no 'tun2socks' literal in any child cmdline (F-B-safe)
  const fallback = path.join(dir, 'fallback');
  // Extract the EXACT self-heal line from the generated script and swap the
  // in-device paths to tmp paths — same path-swap technique as the staged test above.
  const generated = buildTunnelSetupScript({ gostPort: 20082 });
  const line = generated.split('\n').find((l) => l.includes(`cp ${TUN.binFallback} ${TUN.bin}`));
  assert.ok(line, 'self-heal line found in generated script');
  const adapted = line.split(TUN.binFallback).join(fallback).split(TUN.bin).join(canonical);
  assert.ok(!adapted.includes(TUN.bin) && !adapted.includes(TUN.binFallback), 'paths fully swapped to tmp');
  const run = () => runShell(adapted);

  // 1) fresh volume: canonical absent, fallback present → restored + 0755 + same bytes
  fs.writeFileSync(fallback, 'FAKE-ELF-PAYLOAD', { mode: 0o644 });
  let r = run();
  assert.equal(r.status, 0, `restore: rc=0 got ${r.status} ${r.stderr}`);
  assert.ok(fs.existsSync(canonical), 'canonical restored');
  assert.equal(fs.readFileSync(canonical, 'utf8'), 'FAKE-ELF-PAYLOAD', 'bytes identical');
  assert.equal(fs.statSync(canonical).mode & 0o777, 0o755, 'restored mode is 0755');

  // 2) no clobber: canonical already healthy, fallback differs → canonical untouched
  fs.writeFileSync(canonical, 'HEALTHY-CANONICAL');
  fs.writeFileSync(fallback, 'STALE-FALLBACK');
  r = run();
  assert.equal(r.status, 0, `no-clobber: rc=0 got ${r.status} ${r.stderr}`);
  assert.equal(fs.readFileSync(canonical, 'utf8'), 'HEALTHY-CANONICAL', 'healthy canonical never overwritten');

  // 3) no-op: both absent → no file created, no error (the pre-provision
  //    check has already fail-closed with BINARY_MISSING before this point)
  fs.rmSync(canonical); fs.rmSync(fallback);
  r = run();
  assert.equal(r.status, 0, `no-op: rc=0 got ${r.status} ${r.stderr}`);
  assert.ok(!fs.existsSync(canonical), 'nothing fabricated when both landing spots are empty');
});
