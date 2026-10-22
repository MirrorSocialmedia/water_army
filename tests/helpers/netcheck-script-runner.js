/**
 * T102 (BR-Acceptance C3-S2a follow-up) — device-netns emulator for the
 * in-container netcheck script.
 *
 * Runs the REAL generated script (buildT2sNetcheckScript()) under POSIX `sh`
 * (this host's /bin/sh = dash — the strict-POSIX counterpart of Android's
 * /system/bin/sh, i.e. also a toybox-sh compatibility check: the script must
 * contain no bashism or it fails here) with `ip` and `ps` replaced by stubs
 * that emit fixture text. Everything else (grep/awk/printf/head, the token
 * match itself) is the real tooling, so the matcher is exercised end-to-end
 * on the exact bytes the device would produce.
 *
 * Usage:
 *   const out = runNetcheckScript(buildT2sNetcheckScript(), {
 *     psLine: FX.PS_TUN2SOCKS_ALIVE,
 *     linkTun0: FX.IP_LINK_TUN0_UP,
 *     routeTable100: FX.TABLE_100_ROUTES_ALIVE,
 *     ruleShow: FX.IP_RULES_REAL_DEVICE,
 *     routeGet: FX.TUNNEL_ALIVE_ROUTE_GET,
 *   });
 *   // out.stdout → "NETCHECK process=alive pid=... iface=up ..."
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {string} script the generated netcheck script (any shell variant of
 *   it — passing the LEGACY line is how the before/after comparison is made)
 * @param {object} stubs
 * @param {string} [stubs.psLine]        `ps -ef` tun2socks line ('' = dead)
 * @param {string} [stubs.linkTun0]      `ip link show tun0` stdout ('' = missing)
 * @param {string} [stubs.routeTable100] `ip route show table 100` stdout
 * @param {string} [stubs.ruleShow]      `ip rule show` stdout
 * @param {string} [stubs.routeGet]      `ip route get 8.8.8.8` stdout ('' = e.g. RTNETLINK unreachable)
 * @returns {{ stdout: string, exitCode: number }}
 * @throws {Error} with .exitCode on nonzero script exit
 */
export function runNetcheckScript(script, stubs = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-t102-netcheck-'));
  const bin = path.join(dir, 'bin');
  const fx = path.join(dir, 'fx');
  fs.mkdirSync(bin);
  fs.mkdirSync(fx);

  const writeFx = (name, content) => {
    const p = path.join(fx, name);
    fs.writeFileSync(p, content ?? '');
    return p;
  };
  const psP = writeFx('ps.txt', stubs.psLine);
  const linkP = writeFx('link.txt', stubs.linkTun0);
  const routeP = writeFx('route100.txt', stubs.routeTable100);
  const ruleP = writeFx('rule.txt', stubs.ruleShow);
  const getP = writeFx('routeg.txt', stubs.routeGet);

  // Stub `ip`: branch on the first two args; each branch cats its fixture
  // file. stderr passes through (the real script 2>/dev/null's where needed).
  const fakeIp = [
    '#!/bin/sh',
    'case "$1 $2" in',
    `  "link show")  cat "${linkP}" ;;`,
    `  "route show") cat "${routeP}" ;;`,
    `  "rule show")  cat "${ruleP}" ;;`,
    `  "route get")  cat "${getP}" ;;`,
    '  *) : ;;',
    'esac',
    'exit 0',
  ].join('\n');
  const fakePs = [
    '#!/bin/sh',
    `cat "${psP}"`,
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'ip'), fakeIp);
  fs.writeFileSync(path.join(bin, 'ps'), fakePs);
  fs.chmodSync(path.join(bin, 'ip'), 0o755);
  fs.chmodSync(path.join(bin, 'ps'), 0o755);

  const scriptPath = path.join(dir, 'netcheck.sh');
  fs.writeFileSync(scriptPath, script);

  try {
    const stdout = execFileSync('sh', [scriptPath], {
      env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: dir },
      encoding: 'utf8',
      timeout: 10_000,
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    err.exitCode = err.status ?? 1;
    err.stdout = String(err.stdout ?? '');
    throw err;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
