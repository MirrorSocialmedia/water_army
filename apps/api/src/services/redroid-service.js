/**
 * Redroid device service (工單 P5 / 施工 MD §7 Templates-Redroid).
 *
 * Hard rules implemented here (MD §1.2 / §2.1 / §7 / §10):
 *  - Redroid containers can ONLY be created via an enabled Redroid template —
 *    no raw Docker HostConfig ever reaches this service (the route schema
 *    has no HostConfig field; this service only builds configs from
 *    template fields + a narrow override allowlist)
 *  - `androidboot.*` settings are CONTAINER START ARGS (Cmd — redroid-doc
 *    official method), NEVER Env (MD §2.1). Env is explicitly empty.
 *  - ADB host port is published on 127.0.0.1 ONLY — the bind address is a
 *    server-side constant; no client input can change it
 *  - `privileged` comes ONLY from the template (which itself is
 *    admin-created and must carry privilegedReason, MD §9.2)
 *  - adbPort is unique (DB constraint + allocation probe with collision retry)
 *  - each device gets a dedicated host data dir bind-mounted at /data
 *    (MD §10.2 — per-device persistence)
 *  - failed preflight is an EXPLICIT WARNING in the create response, never
 *    a silent success and never the sole verdict (MD §2.3 — ADR §14)
 *  - worker is NOT involved: all device ops are synchronous API-side (工單)
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { DOCKER_ERROR, encryptSecret, decryptSecret, resolveProviderKey } from '@water-army/shared';

import { DockerServiceError } from './docker-service.js';
import { checkPortAvailable, } from './preflight.js';
import { createAdbWhitelist } from './adb-whitelist.js';
import {
  NET_STATES,
  NET_TO_LEGACY_PROXY,
  NET_ERRORS,
  T2S_NETCHECK_MARKER,
  T2S_CANARY_MARKER,
  assertNetTransition,
  IllegalNetTransition,
  buildT2sNetcheckScript,
  parseNetcheckOutput,
  classifyNetcheck,
  buildT2sCanaryScript,
  parseCanaryOutput,
  classifyCanary,
  generateCanaryNonce,
  computeRecoveryDecision,
  backoffMs,
  buildNetPayload,
} from './redroid-health.js';

// R3 markers are re-exported so the mock adapter (redroid-mock.js) can match
// the canary/netcheck scripts without a second import surface.
export { T2S_NETCHECK_MARKER, T2S_CANARY_MARKER } from './redroid-health.js';

/** Server-side ADB bind constant — MD §1.2: 127.0.0.1 ONLY. Never client input. */
export const REDROID_LOOPBACK_BIND = '127.0.0.1';
/** Redroid's ADB container port is fixed by the image (5555). */
export const REDROID_ADB_CONTAINER_PORT = 5555;

export const GPU_MODES = Object.freeze(['swiftshader_indirect', 'host']);
export const GPU_STATUS = Object.freeze(['unknown', 'unverified', 'software', 'verified']);

export class RedroidServiceError extends Error {
  constructor({ code, status, message, details }) {
    super(message ?? code);
    this.name = 'RedroidServiceError';
    this.apiCode = code;
    this.statusCode = status;
    this.statusCodeNum = status;
    this.details = details ?? undefined;
  }
}

const fail = (code, status, message, details) => new RedroidServiceError({ code, status, message, details });

// ---------------------------------------------------------------------------
// Stage B (2026-10-19): per-device egress proxy (gost + tun2socks)
//
// Architecture (live-spike-verified, see logs/redroid-matrix-B-progress.md):
//  - one gost container PER device: `redroid-matrix-b-gost-<devName>`,
//    bridge network, publishes 1080/tcp on 172.17.0.1:<gostPort> (range
//    20080–20179, DB-unique). gost forwards to the fleet/proxy upstream
//    (socks5://[user:pass@]host:port).
//  - inside the redroid device: tun0 (10.8.0.1 peer 10.8.0.2/32) +
//    tun2socks v2.7.0 at /data/local/tmp/tun2socks pointing at
//    socks5://172.17.0.1:<gostPort>; Android netd's table 100 default route
//    (via 10.8.0.2 onlink) shadows the eth0 default → all device egress
//    (DNS UDP verified end-to-end; see progress doc for the known
//    gVisor TCP-over-TUN payload limitation) crosses the proxy.
//  - R1 (2026-10-20) binary contract: the tun2socks binary is a VERIFIED
//    build artifact of the wrapper image (pinned fetch + sha256/ELF check in
//    docker/redroid-matrix, reproducible from a clean clone) — not a manual
//    push. Every provision run FIRST executes a read-only in-device check
//    (checkTun2socksBinary: present → executable → ELF → --version canary)
//    and FAILS CLOSED (BINARY_MISSING/BINARY_INVALID/BINARY_CHECK_ERROR,
//    proxyState=error, device never reaches 'running'); the diagnosis is
//    persisted (binary_state/binary_version) and exposed in the device view
//    without ever carrying credentials.
//  - proxy URL (with credentials) is ENCRYPTED at rest (AES-256-GCM,
//    provider-key pattern) and NEVER appears in API responses or audit
//    details — views expose `hasProxyUrl` / masked host only.
// ---------------------------------------------------------------------------

/** gogost/gost pinned BY DIGEST (Docker Hub 3.3.0; `docker pull` verified). */
export const GOST_IMAGE = 'gogost/gost@sha256:f7a958c451928fbe1b99046d25bd0c9bf42019d4c60a82200f50dc8e617b7580';
/** In-container listen port (fixed; the per-device variable is the host port). */
export const GOST_LISTEN_PORT = 1080;
/**
 * Host bind for gost ports: the docker bridge gateway IP — reachable from
 * every bridge-network device (spike-verified), NOT exposed on the public
 * interfaces. Never client input.
 */
export const GOST_HOST_BIND = '172.17.0.1';
/** Dedicated (non-ADB) port range for per-device gost listeners. */
export const GOST_PORT_RANGE = Object.freeze({ start: 20080, end: 20179 });
/** proxyState machine: off → provisioning → running | stopped | error. */
export const PROXY_STATES = Object.freeze(['off', 'provisioning', 'running', 'stopped', 'error']);
/** TUN constants inside the device (spike-verified addresses). */
export const TUN = Object.freeze({
  iface: 'tun0',
  localIp: '10.8.0.1',
  peerIp: '10.8.0.2',
  bin: '/data/local/tmp/tun2socks',
  // R2 (2026-10-20): second landing spot, OUTSIDE /data. A fresh /data volume
  // (production createDevice geometry) shadows the image layer that bakes
  // /data/local/tmp/tun2socks → the canonical path is missing on every fresh
  // device while /usr/local/bin/tun2socks survives. The setup script self-heals
  // canonical ← fallback; the check script falls back for diagnosis.
  binFallback: '/usr/local/bin/tun2socks',
  logFile: '/data/local/tmp/tun2socks.log',
});

/**
 * tun2socks deployment pin (R1, 2026-10-20) — the binary is fetched +
 * checksum-verified at wrapper-image BUILD time (see
 * docker/redroid-matrix/tun2socks.env — that file is the shell-side single
 * source of truth for the Dockerfile; this constant is the JS-side mirror).
 * A unit test asserts the two stay in sync (tests/unit/redroid-t2s-pin.test.js).
 * MIT-licensed upstream (xjasonlyu/tun2socks); static x86-64 ELF → runs in
 * the redroid Android x86_64 userspace on an x86_64 host kernel.
 */
export const TUN2SOCKS_PIN = Object.freeze({
  version: '2.7.0',
  asset: 'tun2socks-linux-amd64.zip',
  innerFile: 'tun2socks-linux-amd64',
  sha256: '98d545a663b790b4a4100d0c796e1d43d82c5442efdb6e9c4d82e2e32e99c031',
  url: 'https://github.com/xjasonlyu/tun2socks/releases/download/v2.7.0/tun2socks-linux-amd64.zip',
  binPath: TUN.bin,
});

/** Marker comment line in the binary-check script (mock detection + versioning). */
export const TUN2SOCKS_CHECK_MARKER = 'wa-t2scheck-v2';

/** Derived asset URL — one place (no floating 'latest' possible: version is a constant). */
export function tun2socksAssetUrl(version = TUN2SOCKS_PIN.version, asset = TUN2SOCKS_PIN.asset) {
  return `https://github.com/xjasonlyu/tun2socks/releases/download/v${version}/${asset}`;
}

/**
 * F-B fix (R1, 2026-10-20) — tunnel scripts are STAGED AS A FILE inside the
 * device, then executed as `sh <file>`. Why: the exec seam runs
 * `docker exec … sh -c '<script text>'`, so the script text sits IN THE
 * RUNNER'S CMDLINE. The setup script contains the literal tun2socks path
 * (nohup line), so any `pkill -f tun2socks`-style pattern — bracket trick
 * included — also matches the runner itself → pkill SIGTERMs its own shell
 * (pre-fix: rc=143, repro in docs/audits/repair-baseline.md §5.4; the tunnel
 * could NEVER be provisioned by the repo code path). With the file staged,
 * the runner cmdline is `sh /data/local/tmp/.t2s-setup.sh` — zero tun2socks
 * literal in it — so the in-file pkill can only ever match the real daemon.
 * (Same failure class the grep bracket trick defends against, but pkill -f
 * has NO escape: the nohup line is itself the daemon's cmdline shape.)
 */
export const T2S_SETUP_FILE = '/data/local/tmp/.t2s-setup.sh';

/**
 * Stage script (pure — unit-tested): base64-decode the inner script into the
 * device and make it 0700 (root-only: it configures routes). The b64 blob is
 * safe in a shell single-quoted arg (charset A-Za-z0-9+/=).
 * @param {string} innerScript buildTunnel*Script() output
 */
export function buildT2sStageScript(innerScript) {
  const b64 = Buffer.from(String(innerScript), 'utf8').toString('base64');
  return [
    `printf '%s' '${b64}' | base64 -d > ${T2S_SETUP_FILE}`,
    `chmod 0700 ${T2S_SETUP_FILE}`,
    'echo T2S_STAGED',
  ].join('\n');
}

/**
 * Run script (pure — unit-tested): execute the staged file, capture its
 * combined output (the exec seam reads it for the ps-based liveness check),
 * remove the file (no residue), and propagate the inner exit code.
 * NOTE: this text becomes the runner's cmdline — it must NEVER contain the
 * literal 'tun2socks' (guarded by tests/unit/redroid-t2s-staging.test.js).
 */
export function buildT2sRunScript() {
  return [
    `sh ${T2S_SETUP_FILE} 2>&1`,
    'rc=$?',
    `rm -f ${T2S_SETUP_FILE}`,
    'exit $rc',
  ].join('\n');
}

/**
 * Binary diagnostic check script (pure — unit-tested). RUN INLINE (not
 * staged): it is read-only (no pkill/pgrep, no route mutation), so it
 * carries no F-B hazard, and the mock seam detects it via the marker
 * comment. Machine-readable contract — one BINARY_STATE= line always,
 * optional BINARY_DETAIL=/BINARY_VERSION=, exit codes:
 *   0 ready · 3 missing · 4 invalid (any flavor) · 1 anything else
 */
export function buildT2sCheckScript() {
  return [
    `# ${TUN2SOCKS_CHECK_MARKER}`,
    'set -u',
    `CANON=${TUN.bin}`,
    // T2S_BIN_FALLBACK is a TEST KNOB (unset in-device → the real fallback path).
    `FALLBACK=${'${T2S_BIN_FALLBACK:-' + TUN.binFallback + '}'}`,
    // T2S_BIN is a TEST KNOB (unset in-device → the single canonical path).
    `BIN=${'${T2S_BIN:-$CANON}'}`,
    // R2: fresh /data volumes shadow the baked canonical path — fall back to
    // the /usr/local/bin copy (same build-verified artifact, image layer).
    `if [ ! -f "$BIN" ] && [ "$BIN" = "$CANON" ] && [ -f "$FALLBACK" ]; then BIN=$FALLBACK; SRC=fallback; else SRC=canonical; fi`,
    `if [ ! -f "$BIN" ]; then echo "BINARY_STATE=missing"; exit 3; fi`,
    `if [ ! -x "$BIN" ]; then echo "BINARY_STATE=invalid"; echo "BINARY_DETAIL=not-executable"; exit 4; fi`,
    `MAGIC=$(head -c 4 "$BIN" 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \\n')`,
    `if [ "$MAGIC" != "7f454c46" ]; then MAGIC8=$(printf '%s' "$MAGIC" | cut -c1-8); echo "BINARY_STATE=invalid"; echo "BINARY_DETAIL=not-elf(magic=$MAGIC8)"; exit 4; fi`,
    `V=$("$BIN" --version 2>&1 | head -n 1) || { echo "BINARY_STATE=invalid"; echo "BINARY_DETAIL=exec-failed"; exit 4; }`,
    'case "$V" in',
    `  tun2socks-*) echo "BINARY_STATE=ready"; echo "BINARY_VERSION=$V"; [ "$SRC" = fallback ] && echo "BINARY_DETAIL=fallback($FALLBACK)"; exit 0 ;;`,
    '  *) echo "BINARY_STATE=invalid"; echo "BINARY_DETAIL=unexpected-version($V)"; exit 4 ;;',
    'esac',
  ].join('\n');
}

/** Parse the check script's machine-readable output (pure — unit-tested). */
export function parseT2sCheckOutput(stdout) {
  const s = String(stdout ?? '');
  const state = s.match(/BINARY_STATE=(\w+)/)?.[1] ?? null;
  const version = s.match(/BINARY_VERSION=(\S+)/)?.[1] ?? null;
  const detail = s.match(/BINARY_DETAIL=(.+)/)?.[1] ?? null;
  return { state, version, detail };
}

/** socks5://[user:pass@]host:port — strict, no scheme drift, no spaces. */
const PROXY_URL_RE = /^socks5:\/\/(?:([^:@\s/]+):([^:@\s/]+)@)?([a-zA-Z0-9.-]+):([1-9][0-9]{0,4})$/;

/**
 * Parse a socks5 proxy URL. Returns {scheme,user,pass,host,port,raw} or
 * null (never throws — callers decide the error shape).
 */
export function parseProxyUrl(url) {
  const s = String(url ?? '').trim();
  const m = PROXY_URL_RE.exec(s);
  if (!m) return null;
  const port = Number(m[4]);
  if (port > 65535) return null;
  return { scheme: 'socks5', user: m[1] ?? null, pass: m[2] ?? null, host: m[3], port, raw: s };
}

/** Validate a proxy URL; throws RedroidServiceError (400) when malformed. */
export function validateProxyUrl(url) {
  const p = parseProxyUrl(url);
  if (!p) throw fail('VALIDATION_ERROR', 400, "proxyUrl must look like socks5://[user:pass@]host:port (socks5 only, no spaces)");
  return p;
}

/** Deterministic gost container name — the name IS the binding (no extra DB column). */
export function gostContainerName(deviceName) {
  return `redroid-matrix-b-gost-${deviceName}`;
}

/**
 * Build the gost container create-body (pure — unit-testable, no docker).
 * Security: the upstream URL (with credentials) lives ONLY in Cmd; Env is
 * deliberately empty (the docker host is the trust boundary — root there
 * can already read every container's filesystem).
 */
export function buildGostContainerBody({ deviceName, gostPort, proxyUrl }) {
  const p = parseProxyUrl(proxyUrl);
  if (!p) throw fail('VALIDATION_ERROR', 400, 'proxyUrl is malformed (buildGostContainerBody)');
  if (!Number.isInteger(gostPort) || gostPort < GOST_PORT_RANGE.start || gostPort > GOST_PORT_RANGE.end) {
    throw fail('VALIDATION_ERROR', 400, `gostPort must be an integer in ${GOST_PORT_RANGE.start}-${GOST_PORT_RANGE.end}`);
  }
  return {
    Image: GOST_IMAGE,
    ExposedPorts: { [`${GOST_LISTEN_PORT}/tcp`]: {} },
    // 2026-10-20 R3 live-found (container exited 73ms with fatal
    // 'Config File "gost" Not Found'): the pinned image's ENTRYPOINT is
    // ["/bin/gost"] — the old extra 'start' arg was parsed by the gost CLI as
    // a CONFIG FILE NAME, not a subcommand. Correct invocation (verified
    // against the pinned digest): gost -L socks5://:1080 -F <upstream>.
    Cmd: ['-L', `socks5://:${GOST_LISTEN_PORT}`, '-F', p.raw],
    Env: [],
    Labels: {
      'app.managed': 'true',
      'app.kind': 'redroid-gost',
      'redroid.device.name': deviceName,
    },
    HostConfig: {
      NetworkMode: 'bridge',
      PortBindings: { [`${GOST_LISTEN_PORT}/tcp`]: [{ HostIP: GOST_HOST_BIND, HostPort: String(gostPort) }] },
    },
  };
}

/**
 * The in-device tunnel setup script (pure — unit-tested; the sequence was
 * verified on TWO live devices, see logs/redroid-matrix-B-progress.md).
 *
 * Environment facts baked in (all empirically found, do not "simplify"):
 *  - Android netd sometimes BLOCKS RTM_NEWLINK (new-link creation over
 *    netlink → EOPNOTSUPP). So `ip link add` is BEST-EFFORT: when blocked,
 *    tun2socks (gVisor) creates tun0 itself via ioctl TUNSETIFF (proven to
 *    work) and holds the fd. When allowed, it pre-creates it — gVisor
 *    attaches to the existing device either way (both paths verified).
 *  - netd owns table 100 + rule 5000 for TUNs it registers itself; for an
 *    ioctl-created TUN netd does NOT add the rule → we add it (EEXIST-safe;
 *    if netd owns it, ours is a no-op duplicate of the same shape).
 *  - `onlink` is REQUIRED on the table-100 default (10.8.0.2 is not
 *    resolvable inside table 100 → ENETUNREACH without it).
 *  - GATEWAY EXCEPTION: 172.17.0.1 (docker bridge) must route via eth0
 *    INSIDE table 100 — otherwise the gVisor→gost handshake (dst
 *    172.17.0.1:<gostPort>) matches the table-100 default and HAIRPINS
 *    back out tun0 → connection reset, zero proxy traffic. Live-found
 *    (dev2 failure mode, 2026-10-19).
 *  - Idempotent: re-runnable while the device is up (pkill + del first).
 */
export function buildTunnelSetupScript({ gostPort }) {
  if (!Number.isInteger(gostPort) || gostPort < GOST_PORT_RANGE.start || gostPort > GOST_PORT_RANGE.end) {
    throw fail('VALIDATION_ERROR', 400, `gostPort must be an integer in ${GOST_PORT_RANGE.start}-${GOST_PORT_RANGE.end}`);
  }
  const lines = [
    'set -e',
    // R2: fresh /data volumes shadow the image-layer /data/local/tmp/tun2socks
    // (R1 P0 gap). Self-heal from the second landing spot before starting t2s;
    // the pre-provision check (wa-t2scheck-v2) already admitted the fallback,
    // and its magic+version gates apply to the same artifact.
    `if [ ! -f ${TUN.bin} ] && [ -f ${TUN.binFallback} ]; then cp ${TUN.binFallback} ${TUN.bin} && chmod 0755 ${TUN.bin}; fi`,
    // bracketed + quoted: this line only ever executes from the staged file
    // (buildT2sRunScript), where the runner cmdline is clean — but the bracket
    // also keeps the pkill process's OWN cmdline from matching (defense in
    // depth; see F-B note above T2S_SETUP_FILE).
    'pkill -f "[t]un2socks" 2>/dev/null || true',
    'sleep 1',
    `ip link del ${TUN.iface} 2>/dev/null || true`,
    // best-effort: RTM_NEWLINK is blocked in some Android netd states;
    // tun2socks creates the device itself via ioctl when it is
    `ip link add ${TUN.iface} type tun 2>/dev/null || true`,
    // tun2socks FIRST: opens/creates tun0 via ioctl and holds the fd
    `nohup ${TUN.bin} --device ${TUN.iface} --proxy socks5://${GOST_HOST_BIND}:${gostPort} --loglevel debug > ${TUN.logFile} 2>&1 &`,
    'sleep 2',
    `ip addr add ${TUN.localIp} peer ${TUN.peerIp}/32 dev ${TUN.iface} 2>/dev/null || true`,
    `ip link set ${TUN.iface} up`,
    'ip route flush table 100 2>/dev/null || true',
    `ip route add default via ${TUN.peerIp} dev ${TUN.iface} table 100 onlink`,
    // GATEWAY EXCEPTION — without this the gVisor→gost handshake hairpins
    // out tun0 (table-100 default) and the proxy connection is reset
    `ip route add ${GOST_HOST_BIND} dev eth0 scope link table 100`,
    'ip rule add priority 5000 from all lookup 100 2>/dev/null || true',
    'sleep 1',
    // bracket trick: grep must not match its own cmdline
    'ps -ef | grep [t]un2socks || { echo TUN2SOCKS_NOT_RUNNING; exit 1; }',
    `ip route get 8.8.8.8 || true`,
  ];
  return lines.join('\n');
}

/** Teardown script: kill tun2socks (tun0 dies with the process) + stray tun0 fallback. */
export function buildTunnelTeardownScript() {
  return [
    // bracketed + quoted (F-B, R1 — same rule as the setup script)
    'pkill -f "[t]un2socks" 2>/dev/null || true',
    'sleep 1',
    `ip link del ${TUN.iface} 2>/dev/null || true`,
    'echo TUNNEL_TEARDOWN_DONE',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Validation (exported for unit tests)
// ---------------------------------------------------------------------------

const TEMPLATE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const DEVICE_NAME_RE = /^redroid-[a-z0-9][a-z0-9_-]{0,39}$/;
const PINNED_IMAGE_RE = /^[a-z0-9][a-z0-9._/-]*(:[a-z0-9][a-z0-9._-]*)?(@sha256:[a-f0-9]{64})?$/;

/**
 * Image must be PINNED (MD §7): explicit tag or digest; `latest`/`nightly`
 * / untagged references are rejected.
 */
export function validatePinnedImage(image) {
  const s = String(image ?? '').trim();
  if (!PINNED_IMAGE_RE.test(s)) return false;
  const tail = s.slice(s.lastIndexOf('/') + 1);
  if (!/[:@]/.test(tail)) return false; // untagged — implicit :latest
  if (/(^|:)latest$/i.test(tail)) return false;
  if (/nightly/i.test(tail)) return false;
  return true;
}

/**
 * Validate + normalize a Redroid template definition. Throws
 * RedroidServiceError (VALIDATION_ERROR, 400) on any violation.
 */
export function validateRedroidTemplate(t) {
  const problems = [];
  const name = String(t?.name ?? '');
  if (!TEMPLATE_NAME_RE.test(name)) problems.push('name must be 1-40 chars, lowercase alnum/_/-, starting alnum');

  if (!validatePinnedImage(t?.image)) problems.push('image must be pinned (explicit tag or digest; latest/nightly/untagged are forbidden, MD §7)');

  const androidVersion = String(t?.androidVersion ?? '');
  if (!/^\d{1,2}$/.test(androidVersion) || Number(androidVersion) < 5) problems.push('androidVersion must be an integer 5..99 (e.g. "15")');

  const checkDim = (label, v, lo, hi) => {
    if (!Number.isInteger(v) || v < lo || v > hi) problems.push(`${label} must be an integer between ${lo} and ${hi}`);
  };
  checkDim('width', t?.width, 160, 8192);
  checkDim('height', t?.height, 160, 8192);
  checkDim('dpi', t?.dpi, 100, 1200);
  checkDim('fps', t?.fps, 1, 120);

  const gpuMode = String(t?.gpuMode ?? 'swiftshader_indirect');
  if (!GPU_MODES.includes(gpuMode)) problems.push(`gpuMode must be one of: ${GPU_MODES.join(', ')}`);

  const privileged = t?.privileged === undefined ? false : t.privileged;
  if (typeof privileged !== 'boolean') problems.push('privileged must be a boolean');
  const privilegedReason = String(t?.privilegedReason ?? '').trim();
  if (privileged && (privilegedReason.length < 10 || privilegedReason.length > 200)) {
    problems.push('privileged=true requires privilegedReason (10-200 chars) — the explicit label (MD §9.2)');
  }

  // Stage B: optional fleet egress proxy (validated URL, stored encrypted by the service).
  let proxyUrl = null;
  if (t?.proxyUrl !== undefined && t.proxyUrl !== null) {
    if (typeof t.proxyUrl !== 'string' || parseProxyUrl(t.proxyUrl) === null) {
      problems.push('proxyUrl must look like socks5://[user:pass@]host:port (socks5 only, no spaces)');
    } else {
      proxyUrl = String(t.proxyUrl).trim();
    }
  }

  // R5: optional resource limits (MD §7.2.7). Null/undefined = unlimited.
  let cpuLimit = null;
  if (t?.cpuLimit !== undefined && t.cpuLimit !== null) {
    if (typeof t.cpuLimit !== 'number' || !Number.isFinite(t.cpuLimit) || t.cpuLimit <= 0 || t.cpuLimit > 256) {
      problems.push('cpuLimit must be a number in (0, 256] vCPU');
    } else {
      cpuLimit = t.cpuLimit;
    }
  }
  let memoryLimitBytes = null;
  if (t?.memoryLimitBytes !== undefined && t.memoryLimitBytes !== null) {
    if (!Number.isInteger(t.memoryLimitBytes) || t.memoryLimitBytes < 1073741824 || t.memoryLimitBytes > 274877906944) {
      problems.push('memoryLimitBytes must be an integer in [1 GiB, 256 GiB]');
    } else {
      memoryLimitBytes = t.memoryLimitBytes;
    }
  }

  if (problems.length) throw fail('VALIDATION_ERROR', 400, problems.join('; '));

  return {
    name,
    image: String(t.image).trim(),
    androidVersion,
    width: t.width,
    height: t.height,
    dpi: t.dpi,
    fps: t.fps,
    gpuMode,
    privileged,
    privilegedReason: privileged ? privilegedReason : null,
    isEnabled: t?.isEnabled === undefined ? true : Boolean(t.isEnabled),
    cpuLimit,
    memoryLimitBytes,
    proxyUrl, // plaintext ONLY here — the service encrypts before any DB/API touch
  };
}

/**
 * Build the redroid START-UP ARGUMENTS (Cmd) from template + overrides
 * (MD §2.1 — androidboot.* as container start args, redroid-doc official
 * method). Returns a pure string array; nothing here touches a shell.
 */
export function buildRedroidCmd({ width, height, dpi, fps, gpuMode }) {
  return [
    `androidboot.redroid_width=${width}`,
    `androidboot.redroid_height=${height}`,
    `androidboot.redroid_dpi=${dpi}`,
    `androidboot.redroid_fps=${fps}`,
    `androidboot.redroid_gpu_mode=${gpuMode}`,
  ];
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {object} deps.db        prisma (redroidTemplate / device models)
 * @param {object} deps.docker    docker wrapper (mock adapter allowed via config)
 * @param {object} deps.dockerService P2 DockerService instance (actions/logs/delete/inspect)
 * @param {object} deps.config    API config (redroid knobs)
 * @param {object} [deps.log]
 * @param {Function} [deps.audit] writeAudit
 * @param {object} [deps.adb]     AdbWhitelist engine (createAdbWhitelist result) — injectable
 * @param {(params:object)=>Promise<object>} [deps.preflight] preflight fn (injectable for tests)
 */
export function createRedroidService({
  db,
  docker,
  dockerService,
  config,
  log = { info() {}, warn() {}, error() {} },
  audit = async () => {},
  adb,
  preflight,
  // Stage B: in-container exec seam. Real path = dockerode exec (built lazily
  // below); mock mode injects a recorder so tests assert the EXACT tunnel
  // scripts without a daemon. Returns {exitCode, stdout, stderr}.
  exec: injectedExec,
  // R3: host-side proxy-leg reachability probe. Real = gost container
  // inspect + TCP connect to 172.17.0.1:<gostPort>; mock adapter injects a
  // deterministic stand-in (the whole device is simulated there).
  proxyReachable: injectedProxyReachable,
} = {}) {
  const adbEngine = adb ?? createAdbWhitelist({
    adbBinary: config?.redroidAdbBinary,
    timeoutMs: config?.redroidAdbTimeoutMs,
    maxOutputBytes: config?.redroidAdbMaxOutput,
    logcatTailMax: config?.redroidLogcatTailMax,
    logcatTailDefault: config?.redroidLogcatTailDefault,
    log,
  });

  /**
   * Run a shell script inside a container (Stage B tunnel provisioning).
   * Single-purpose: the ONLY scripts that pass through are the exported,
   * unit-tested buildTunnel*Script() outputs — no arbitrary-shell endpoint
   * exists (same zero-arbitrary-shell rule as the ADB whitelist).
   */
  async function execInContainer(containerId, script, { timeoutMs = 120_000 } = {}) {
    if (injectedExec) return injectedExec(containerId, script, { timeoutMs });
    const client = requireClient();
    const dockerExec = await client.getContainer(containerId).exec({
      Cmd: ['sh', '-c', script],
      AttachStdout: true,
      AttachStderr: true,
    });
    const chunksOut = [];
    const chunksErr = [];
    const stream = await dockerExec.start({ hijack: false, stream: true });
    stream.on('data', (d) => chunksOut.push(d));
    // stream mode: stderr is multiplexed on the same stream; dockerode
    // exposes it via the 'stderr' event when Demux is requested — we don't
    // demux, so collect what we get and rely on the exit code + stdout.
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), timeoutMs);
      stream.on('end', () => { clearTimeout(timer); resolve('end'); });
      stream.on('close', () => { clearTimeout(timer); resolve('close'); });
      stream.on('error', () => { clearTimeout(timer); resolve('error'); });
    });
    let exitCode = 1;
    try {
      const info = await dockerExec.inspect();
      exitCode = info?.ExitCode ?? 1;
    } catch { /* inspect failed — treat as failure */ }
    return {
      exitCode: exited === 'timeout' ? 124 : exitCode,
      stdout: Buffer.concat(chunksOut).toString('utf8').slice(0, 65536),
      stderr: Buffer.concat(chunksErr).toString('utf8').slice(0, 65536),
    };
  }

  function gostRange() {
    return {
      start: config?.redroidGostRangeStart ?? GOST_PORT_RANGE.start,
      end: config?.redroidGostRangeEnd ?? GOST_PORT_RANGE.end,
    };
  }

  const createIdempotency = new Map(); // key → {state, at, result?}

  function sweepIdempotency(now) {
    for (const [k, v] of createIdempotency) if (now - v.at > (config?.redroidIdempotencyTtlMs ?? 600_000)) createIdempotency.delete(k);
  }

  function requireClient() {
    if (docker?.disabled) throw fail('DOCKER_DISABLED', 503, 'Docker integration disabled via config');
    if (!docker?.client) throw fail(DOCKER_ERROR.DAEMON_UNAVAILABLE, 503, 'Docker client not configured');
    return docker.client;
  }

  // ---- templates -----------------------------------------------------------

  async function listTemplates({ enabledOnly = false } = {}) {
    const rows = await db.redroidTemplate.findMany({ orderBy: { name: 'asc' } });
    return (enabledOnly ? rows.filter((t) => t.isEnabled) : rows).map(publicTemplate);
  }

  async function getTemplateView(idOrName) {
    const row = await db.redroidTemplate.findUnique({ where: { id: isUuid(idOrName) ? idOrName : undefined, name: isUuid(idOrName) ? undefined : idOrName } });
    return row ? publicTemplate(row) : null;
  }

  /**
   * Admin-only (route guard). Creates a Redroid template.
   */
  async function createTemplate(input, { actorUserId, requestId, ip } = {}) {
    const t = validateRedroidTemplate(input);
    // Stage B encryption boundary: plaintext proxyUrl (validated above) → ciphertext for the DB.
    let proxyUrlEncrypted = null;
    if (t.proxyUrl) {
      proxyUrlEncrypted = encryptSecret(t.proxyUrl, proxyKey());
    }
    let row;
    try {
      row = await db.redroidTemplate.create({ data: { ...t, proxyUrl: undefined, proxyUrlEncrypted } });
    } catch (err) {
      if (err?.code === 'P2002') throw fail('REDROID_TEMPLATE_NAME_TAKEN', 409, `Template name '${t.name}' already exists`);
      throw err;
    }
    await audit({
      actorUserId: actorUserId ?? null,
      action: 'redroid.template.create',
      resourceType: 'redroid_template',
      resourceId: row.id,
      requestId: requestId ?? null,
      ip: ip ?? null,
      status: 'success',
      details: { name: t.name, image: t.image, gpuMode: t.gpuMode, privileged: t.privileged, proxySet: Boolean(t.proxyUrl) },
    });
    return publicTemplate(row);
  }

  async function updateTemplate(id, patch, { actorUserId, requestId, ip } = {}) {
    const current = await db.redroidTemplate.findUnique({ where: { id } });
    if (!current) throw fail('REDROID_TEMPLATE_NOT_FOUND', 404, `Template '${id}' not found`);
    // Stage B: proxy is handled OUTSIDE the plain-field merge (encryption boundary).
    //   undefined → keep current | null → clear | string → validate + encrypt
    let proxyUrlEncrypted;
    if (patch.proxyUrl === undefined) {
      proxyUrlEncrypted = current.proxyUrlEncrypted ?? null;
    } else if (patch.proxyUrl === null) {
      proxyUrlEncrypted = null;
    } else {
      const p = validateProxyUrl(patch.proxyUrl); // 400 when malformed
      proxyUrlEncrypted = encryptSecret(p.raw, proxyKey());
    }
    const merged = validateRedroidTemplate({
      name: patch.name ?? current.name,
      image: patch.image ?? current.image,
      androidVersion: patch.androidVersion ?? current.androidVersion,
      width: patch.width ?? current.width,
      height: patch.height ?? current.height,
      dpi: patch.dpi ?? current.dpi,
      fps: patch.fps ?? current.fps,
      gpuMode: patch.gpuMode ?? current.gpuMode,
      privileged: patch.privileged ?? current.privileged,
      privilegedReason: patch.privilegedReason !== undefined ? patch.privilegedReason : current.privilegedReason,
      isEnabled: patch.isEnabled !== undefined ? patch.isEnabled : current.isEnabled,
      // R5: null patch = clear the limit; undefined = keep current.
      cpuLimit: patch.cpuLimit !== undefined ? patch.cpuLimit : current.cpuLimit,
      memoryLimitBytes: patch.memoryLimitBytes !== undefined ? patch.memoryLimitBytes : current.memoryLimitBytes,
    });
    let row;
    try {
      row = await db.redroidTemplate.update({ where: { id }, data: { ...merged, proxyUrl: undefined, proxyUrlEncrypted } });
    } catch (err) {
      if (err?.code === 'P2002') throw fail('REDROID_TEMPLATE_NAME_TAKEN', 409, `Template name '${merged.name}' already exists`);
      throw err;
    }
    await audit({
      actorUserId: actorUserId ?? null,
      action: 'redroid.template.update',
      resourceType: 'redroid_template',
      resourceId: row.id,
      requestId: requestId ?? null,
      ip: ip ?? null,
      status: 'success',
      details: { name: row.name, changed: Object.keys(patch), proxyChanged: patch.proxyUrl !== undefined },
    });
    return publicTemplate(row);
  }

  async function deleteTemplate(id, { actorUserId, requestId, ip } = {}) {
    const current = await db.redroidTemplate.findUnique({ where: { id } });
    if (!current) throw fail('REDROID_TEMPLATE_NOT_FOUND', 404, `Template '${id}' not found`);
    const inUse = await db.device.count({ where: { templateId: id } });
    if (inUse > 0) throw fail('REDROID_TEMPLATE_IN_USE', 409, `Template has ${inUse} device(s) — delete the devices first`);
    await db.redroidTemplate.delete({ where: { id } });
    await audit({
      actorUserId: actorUserId ?? null,
      action: 'redroid.template.delete',
      resourceType: 'redroid_template',
      resourceId: id,
      requestId: requestId ?? null,
      ip: ip ?? null,
      status: 'success',
      details: { name: current.name },
    });
    return { deleted: true, name: current.name };
  }

  // ---- ADB port allocation ---------------------------------------------------

  /**
   * Allocate a unique host ADB port: DB-unique + actually free on 127.0.0.1
   * (real bind probe, MD §10.1 "port 是否已被佔用"). Collision → retry next
   * port; exhausted range → REDROID_PORT_UNAVAILABLE (503).
   * @param {{excludeDeviceId?:string}} [opts]
   */
  async function allocateAdbPort({ excludeDeviceId } = {}) {
    const start = config?.redroidAdbRangeStart ?? 15000;
    const end = config?.redroidAdbRangeEnd ?? 15999;
    for (let port = start; port <= end; port++) {
      const taken = await db.device.findFirst({
        where: { adbPort: port, ...(excludeDeviceId ? { id: { not: excludeDeviceId } } : {}) },
        select: { id: true },
      });
      if (taken) continue;
      const state = await checkPortAvailable(port, { timeoutMs: 1500 });
      if (state === 'free') return port;
      if (state === 'unknown') continue; // probe inconclusive — try next
    }
    throw fail('REDROID_PORT_UNAVAILABLE', 503, `No free ADB port in ${start}-${end} (all in use or occupied on 127.0.0.1)`);
  }

  // ---- Stage B: proxy (gost + tun2socks) lifecycle --------------------------

  /**
   * Allocate a unique gost host port in the dedicated range (DB-unique +
   * 127.0.0.1 bind probe as a conservative collision screen — the real bind
   * is 172.17.0.1; a 0.0.0.0 listener shows up as occupied, a 127.0.0.1-only
   * listener does not and cannot conflict with 172.17.0.1).
   */
  async function allocateGostPort({ excludeDeviceId } = {}) {
    const { start, end } = gostRange();
    for (let port = start; port <= end; port++) {
      const taken = await db.device.findFirst({
        where: { gostPort: port, ...(excludeDeviceId ? { id: { not: excludeDeviceId } } : {}) },
        select: { id: true },
      });
      if (taken) continue;
      const state = await checkPortAvailable(port, { timeoutMs: 1500 });
      if (state === 'free') return port;
      if (state === 'unknown') continue; // probe inconclusive — try next
    }
    throw fail('REDROID_GOST_PORT_UNAVAILABLE', 503, `No free gost port in ${start}-${end} (all allocated or occupied)`);
  }

  // ---- R3: network health (repair MD Phase 3 — fail-closed watchdog) ------
  //
  // Architecture: ONE authoritative state machine (redroid-health.js) + one
  // in-process watchdog loop. The ONLY code path into HEALTHY is VERIFYING +
  // a fresh bidirectional-TCP-canary PASS (MD §5.2/§6.3). The legacy
  // proxyState is a conservative PROJECTION of the new state (R4 retires it).

  /** Health/watchdog config with safe defaults (REDROID_* env knobs). */
  function healthCfg() {
    return {
      pollMs: config?.redroidHealthPollMs ?? 30_000,
      canaryHost: String(config?.redroidCanaryHost ?? '').trim(),
      canaryPort: Number(config?.redroidCanaryPort ?? 0) || 0,
      canaryTimeoutMs: config?.redroidCanaryTimeoutMs ?? 10_000,
      canaryFailThreshold: Math.max(1, config?.redroidCanaryFailThreshold ?? 2),
      staleTtlMs: config?.redroidHealthStaleMs ?? 60_000,
      netcheckTimeoutMs: config?.redroidNetcheckTimeoutMs ?? 20_000,
      backoffBaseMs: config?.redroidRecoveryBackoffBaseMs ?? 15_000,
      backoffMaxMs: config?.redroidRecoveryBackoffMaxMs ?? 600_000,
      maxRetries: Math.max(1, config?.redroidRecoveryMaxRetries ?? 3),
      stallMaxRetries: Math.max(0, config?.redroidRecoveryStallMaxRetries ?? 1),
      lockLeaseMs: config?.redroidRecoveryLockLeaseMs ?? 900_000,
      startingTimeoutMs: config?.redroidTunnelBootTimeoutMs ?? 600_000,
    };
  }

  function canaryConfigured() {
    const c = healthCfg();
    return c.canaryHost !== '' && c.canaryPort >= 1 && c.canaryPort <= 65535;
  }

  function netPolicyCfg() {
    const c = healthCfg();
    return { backoffBaseMs: c.backoffBaseMs, backoffMaxMs: c.backoffMaxMs, maxRetries: c.maxRetries, stallMaxRetries: c.stallMaxRetries };
  }

  function clip(s, n = 200) {
    return String(s ?? '').slice(0, n);
  }

  function normNetState(row) {
    return NET_STATES.includes(row?.netState) ? row.netState : 'STOPPED';
  }

  /**
   * The ONLY network-state write path (MD §6.3 — state moves only via
   * verified events). Writes the net_* columns + the legacy proxyState
   * projection in ONE update; audits every transition.
   *  - to === from → "refresh": field update only, no transition event
   *  - to !== from → assertNetTransition first; an illegal transition is
   *    REJECTED (warn log + audit 'net_transition_refused', nothing written)
   * ZERO SECRETS: details are machine-readable codes / script status lines
   * (canary + netcheck output) — never a proxy URL.
   */
  async function persistNet(row, to, ev = {}) {
    if (!row?.id) return row;
    const from = normNetState(row);
    const data = {};
    if (to !== from) {
      try {
        assertNetTransition(from, to, ev);
      } catch (err) {
        if (err instanceof IllegalNetTransition) {
          log.warn({ device: row.name, from, to, reason: ev.reason ?? null }, 'redroid net: ILLEGAL transition refused (state unchanged)');
          await audit({
            actorUserId: null, action: 'redroid.device.net_transition_refused', resourceType: 'redroid_device', resourceId: row.id,
            requestId: null, ip: null, status: 'failure',
            details: {
              name: row.name, from, to, reason: ev.reason ?? null, source: ev.source ?? null,
              // MD §6.3 audit contract: device-level network events have no
              // associated task run — the field exists so the contract is
              // complete (task-bound dispatch would carry its id here).
              relatedTaskId: null,
            },
          }).catch(() => {});
          return null;
        }
        throw err;
      }
      data.netState = to;
      data.netStateSince = new Date();
      // legacy projection — only devices WITH a proxy leave 'off'
      if (row.gostPort) data.proxyState = NET_TO_LEGACY_PROXY[to];
      if (to === 'HEALTHY') { data.netRecoveries = 0; data.netManualIntervention = false; data.netNextRecoveryAt = null; }
      if (to === 'FAILED') data.netManualIntervention = true; // MD §5.4.6: FAILED = 人工介入
    }
    if (ev.consecutiveFailures !== undefined) data.netConsecutiveFailures = ev.consecutiveFailures;
    if (ev.errorCode !== undefined) {
      data.netLastErrorCode = ev.errorCode;
      data.netLastErrorDetail = ev.errorDetail !== undefined ? clip(ev.errorDetail, 300) : null;
    }
    if (ev.checkedAt !== undefined) data.netCheckedAt = ev.checkedAt;
    if (ev.lastSuccessAt !== undefined) data.netLastSuccessAt = ev.lastSuccessAt;
    if (ev.lastCanaryLine !== undefined) data.netLastCanary = ev.lastCanaryLine;
    if (ev.lastChecks !== undefined) data.netLastChecks = ev.lastChecks; // R4 MD §6.2 per-check breakdown
    if (ev.recoveries !== undefined) data.netRecoveries = ev.recoveries;
    if (ev.lastRecoveryAt !== undefined) data.netLastRecoveryAt = ev.lastRecoveryAt;
    if (ev.nextRecoveryAt !== undefined) data.netNextRecoveryAt = ev.nextRecoveryAt;
    if (ev.manualIntervention !== undefined) data.netManualIntervention = ev.manualIntervention;
    if (Object.keys(data).length === 0) return row;
    let updated = null;
    try {
      updated = await db.device.update({ where: { id: row.id }, data });
    } catch (err) {
      log.warn({ device: row.name, to, error: err?.message }, 'redroid net: persistNet failed');
      return row;
    }
    if (to !== from) {
      log.info(
        { device: row.name, from, to, reason: ev.reason ?? null, errorCode: ev.errorCode ?? undefined, consecutiveFailures: ev.consecutiveFailures ?? undefined },
        'redroid net: transition',
      );
      await audit({
        actorUserId: null, action: 'redroid.device.net_transition', resourceType: 'redroid_device', resourceId: row.id,
        requestId: null, ip: null, status: to === 'HEALTHY' ? 'success' : 'warning',
        details: {
          name: row.name, from, to,
          reason: ev.reason ?? null,
          errorCode: ev.errorCode ?? null,
          source: ev.source ?? null,
          consecutiveFailures: updated.netConsecutiveFailures ?? null,
          recoveries: updated.netRecoveries ?? null,
          // MD §6.3 audit contract: deviceId (resourceId) + from/to + reason
          // + time (createdAt) + trigger source (source) + related task id.
          // Device-level network events have no associated task run — null
          // is the honest value (task-bound dispatch would carry its id).
          relatedTaskId: null,
        },
      }).catch(() => {});
    }
    return updated ?? row;
  }

  /**
   * One full verification pass (MD §5.3 — control plane AND data plane):
   *   container (host) → netcheck (in-device: process/tun0/table-100/rule/
   *   effective route) → TCP bidirectional canary → proxy leg (gost listener)
   * Outcome applied through persistNet:
   *   all pass  → HEALTHY (via VERIFYING, with the canary PASS as evidence)
   *   definite  → BLOCKED immediately (process dead / tun0 gone / route lost /
   *               fail-open detected / container gone / proxy unreachable)
   *   soft      → consecutiveFailures++ → DEGRADED (1) / BLOCKED (threshold)
   * Stale-health rule: a canary that did not run / timed out is a failure,
   * never an absence of evidence (MD §5.5).
   * Returns { healthy, checks, canary, row, failed? }.
   */
  async function verifyNow(row, { source = 'watchdog' } = {}) {
    const cfg = healthCfg();
    const cur = normNetState(row);
    const checks = {};

    // -- container (host side) --
    let containerRunning = null; // null = unknown (daemon unreachable)
    if (row.containerId) {
      try {
        const s = await dockerService.inspectSummary(row.containerId);
        containerRunning = s?.state?.status === 'running';
      } catch (err) {
        containerRunning = err instanceof DockerServiceError && err.apiCode === DOCKER_ERROR.CONTAINER_NOT_FOUND ? false : null;
      }
    } else {
      containerRunning = false;
    }
    checks.container = containerRunning === null ? 'UNKNOWN' : containerRunning ? 'PASS' : 'FAIL';

    let definite = null; // {code, detail} — protection DEFINITIVELY lost
    let soft = null;     // {code, detail} — inconclusive / data-plane failure
    if (containerRunning === false) {
      definite = { code: NET_ERRORS.CONTAINER_NOT_RUNNING, detail: 'device container is not running' };
    } else if (containerRunning === null) {
      soft = { code: NET_ERRORS.DOCKER_UNAVAILABLE, detail: 'docker inspect failed (daemon unavailable?)' };
    }

    // -- in-device control-plane netcheck --
    let canary = null;
    let canaryLine = null;
    if (containerRunning === true) {
      try {
        const r = await execInContainer(row.containerId, buildT2sNetcheckScript(), { timeoutMs: cfg.netcheckTimeoutMs });
        const parsed = parseNetcheckOutput(r.stdout);
        if (!parsed.ok) {
          soft = soft ?? { code: parsed.code, detail: `netcheck inconclusive (exit=${r.exitCode})` };
        } else {
          checks.netcheck = { process: parsed.process, pid: parsed.pid, iface: parsed.iface, route: parsed.route, rule: parsed.rule, effective: parsed.effective };
          const cls = classifyNetcheck(parsed);
          if (cls) {
            const line = `process=${parsed.process} iface=${parsed.iface} route=${parsed.route} rule=${parsed.rule} effective=${parsed.effective}`;
            if (cls.severity === 'definite') definite = definite ?? { code: cls.code, detail: line };
            else soft = soft ?? { code: cls.code, detail: line };
          }
        }
      } catch (err) {
        soft = soft ?? { code: NET_ERRORS.TUNNEL_CHECK_ERROR, detail: clip(err?.message, 160) };
      }

      // -- data-plane canary (the ONLY thing that may earn HEALTHY) --
      if (!canaryConfigured()) {
        // No admin canary target → data plane UNVERIFIABLE → fail-closed:
        // the device can never be (stay) HEALTHY (MD §5.3/§5.5).
        canary = { result: 'SKIPPED', reason: 'not-configured' };
        canaryLine = 'CANARY=FAIL nonce=0000000000000000 reason=not-configured';
        soft = soft ?? { code: NET_ERRORS.CANARY_NOT_CONFIGURED, detail: 'no REDROID_CANARY_HOST/REDROID_CANARY_PORT configured — data plane unverifiable' };
      } else {
        const nonce = generateCanaryNonce();
        let r = null;
        try {
          r = await execInContainer(
            row.containerId,
            buildT2sCanaryScript({ host: cfg.canaryHost, port: cfg.canaryPort, timeoutMs: cfg.canaryTimeoutMs, nonce }),
            { timeoutMs: cfg.canaryTimeoutMs + 15_000 },
          );
        } catch (err) {
          r = null; // exec seam failure → counted below (never silently healthy)
        }
        canary = r ? parseCanaryOutput(r.stdout) : { result: 'ERROR', reason: 'exec-error' };
        canaryLine = canary.result === 'PASS'
          ? `CANARY=PASS nonce=${nonce} ms=${canary.ms ?? 0}`
          : `CANARY=FAIL nonce=${nonce} reason=${canary.reason}`;
        const cls = classifyCanary(canary);
        if (!cls.pass) soft = soft ?? { code: cls.code, detail: `canary ${canary.result}:${canary.reason}` };
      }

      // -- proxy leg (host side: gost container + listener) --
      let proxy = null;
      try {
        proxy = await proxyReachableFn(row);
      } catch (err) {
        proxy = { ok: false, error: clip(err?.message, 160) };
      }
      checks.proxy = proxy?.ok ? 'PASS' : 'FAIL';
      if (!proxy?.ok && canary?.result !== 'PASS') {
        // A canary PASS already proves the full leg (device→t2s→gost→upstream);
        // a probe failure despite a canary PASS is a probe artifact, not loss.
        definite = definite ?? { code: NET_ERRORS.PROXY_UNREACHABLE, detail: proxy?.error ?? 'proxy listener not reachable' };
      }
    }

    // R4 (MD §6.2): persist the per-check breakdown of THIS pass — the
    // single source for the `checks{binary,process,interface,routePolicy,
    // tcpCanary}` view that API/worker/UI all read (one calculation, one
    // schema). Flat status vocabulary only — zero secrets by construction.
    const lastChecks = {
      at: new Date().toISOString(),
      container: checks.container, // PASS|FAIL|UNKNOWN (host docker inspect)
      binary: row.binaryState ?? 'unknown', // ready|missing|invalid|error (R1)
      process: checks.netcheck?.process ?? 'unknown', // alive|dead|unknown
      interface: checks.netcheck?.iface ?? 'unknown', // up|down|missing|unknown
      routePolicy: checks.netcheck
        ? (checks.netcheck.route === 'present' && checks.netcheck.rule === 'present' ? 'enforced' : 'broken')
        : 'unknown',
      effectiveRoute: checks.netcheck?.effective ?? 'unknown', // tunnel|direct|unknown
      proxy: checks.proxy ?? 'UNKNOWN', // PASS|FAIL (gost leg)
      tcpCanary: canary
        ? (canary.result === 'PASS' ? 'PASS' : canary.result === 'FAIL' ? 'FAIL' : canary.result === 'ERROR' ? 'ERROR' : 'SKIPPED')
        : 'UNKNOWN',
      canaryReason: canary?.reason ?? null,
    };

    const now = new Date();
    if (!definite && !soft) {
      // all required checks pass — the canary PASS IS the entry condition
      const base = { checkedAt: now, lastSuccessAt: now, lastCanaryLine: canaryLine, consecutiveFailures: 0, errorCode: null, errorDetail: null, source, lastChecks };
      const evidence = { canary: { result: 'PASS', nonce: canary.nonce, at: now.getTime() } };
      if (cur === 'HEALTHY') {
        const updated = await persistNet(row, 'HEALTHY', { ...base, reason: 'verify-refresh' });
        return { healthy: Boolean(updated), checks, canary, row: updated ?? row };
      }
      if (cur === 'VERIFYING') {
        const updated = await persistNet(row, 'HEALTHY', { ...base, reason: 'verification-passed', ...evidence });
        return { healthy: Boolean(updated), checks, canary, row: updated ?? row };
      }
      // DEGRADED / BLOCKED → VERIFYING → HEALTHY (two audited transitions;
      // direct DEGRADED/BLOCKED→HEALTHY edges do not exist in the table)
      const mid = await persistNet(row, 'VERIFYING', { reason: 'recovery-verify', source });
      if (!mid) return { healthy: false, checks, canary, row };
      const updated = await persistNet(mid, 'HEALTHY', { ...base, reason: 'recovery-verification-passed', ...evidence });
      return { healthy: Boolean(updated), checks, canary, row: updated ?? row };
    }

    // ---- failure path ----
    const failed = definite ?? soft;
    const consecutive = (Number.isInteger(row.netConsecutiveFailures) ? row.netConsecutiveFailures : 0) + 1;
    const isDefinite = Boolean(definite);
    const target = isDefinite || consecutive >= cfg.canaryFailThreshold ? 'BLOCKED' : 'DEGRADED';
    const base = {
      checkedAt: now,
      lastCanaryLine: canaryLine,
      consecutiveFailures: consecutive,
      errorCode: failed.code,
      errorDetail: failed.detail,
      source,
      lastChecks,
    };
    const updated = await persistNet(row, target, {
      ...base,
      reason: target === cur ? undefined : (isDefinite ? `definite-loss:${failed.code}` : `consecutive-failures:${consecutive}/${cfg.canaryFailThreshold}`),
    });
    return { healthy: false, checks, canary, row: updated ?? row, failed, target };
  }

  // ---- R3: recovery (lock + backoff + max retries + stall rule) -----------

  let watchdogTimer = null;
  let watchdogSweepTimer = null;
  let watchdogRunning = false;
  /** In-process double-trigger guard (the DB lease is the cross-crash guard). */
  const recovering = new Set();

  /**
   * Acquire the per-device recovery lock as a DB LEASE (conditional update —
   * only one holder fleet-wide; a stale lease from a crashed process expires
   * on its own). Fail-closed: any DB error = NOT acquired = no recovery.
   */
  async function acquireRecoveryLock(deviceId, owner, leaseMs) {
    try {
      const until = new Date(Date.now() + leaseMs);
      const res = await db.$queryRaw`
        UPDATE "devices" SET "net_recovery_lock_owner" = ${owner}, "net_recovery_lock_until" = ${until}
        WHERE id = ${deviceId} AND ("net_recovery_lock_until" IS NULL OR "net_recovery_lock_until" < now())
        RETURNING id`;
      return Array.isArray(res) && res.length > 0;
    } catch (err) {
      log.warn({ deviceId, error: err?.message }, 'redroid net: recovery lock acquire failed (no recovery this tick)');
      return false;
    }
  }

  async function releaseRecoveryLock(deviceId) {
    recovering.delete(deviceId);
    await db.device.update({ where: { id: deviceId }, data: { netRecoveryLockOwner: null, netRecoveryLockUntil: null } }).catch(() => {});
  }

  /**
   * One recovery attempt: STARTING → (container restart if needed) → gost
   * ensure → FULL tunnel re-provision + immediate re-verification. Process
   * resurrection is NOT health — only the canary can restore HEALTHY
   * (MD §5.4.5).
   */
  async function runRecovery(deviceId, owner, attempt) {
    try {
      const row = await findDevice(deviceId);
      if (!row || !row.gostPort) return;
      const mid = await persistNet(row, 'STARTING', { reason: 'recovery-reprovision', source: 'watchdog', recoveries: attempt, lastRecoveryAt: new Date(), nextRecoveryAt: null });
      if (!mid) return; // transition refused (device stopped/deleted meanwhile)

      // container down? restart it first (provisionTunnel re-times the boot wait)
      let containerState = null;
      try {
        const s = await dockerService.inspectSummary(row.containerId);
        containerState = s?.state?.status ?? null;
      } catch (err) {
        containerState = err instanceof DockerServiceError && err.apiCode === DOCKER_ERROR.CONTAINER_NOT_FOUND ? 'missing' : null;
      }
      if (containerState && containerState !== 'running') {
        try {
          const r = await dockerService.runAction(row.containerId, 'restart');
          await db.device.update({ where: { id: row.id }, data: { containerState: r?.state ?? 'running' } }).catch(() => {});
        } catch (err) {
          log.warn({ device: row.name, error: err?.message }, 'redroid net: recovery container restart failed');
          await persistNet(row, 'FAILED', { reason: 'container-restart-failed', errorCode: NET_ERRORS.CONTAINER_NOT_RUNNING, errorDetail: clip(err?.message, 160), source: 'watchdog' });
          return;
        }
      }
      // ensure the per-device gost container (idempotent reuse), then the full
      // tunnel re-provision (pkill + tun0 + t2s + routes) + re-verification
      const fresh = await findDevice(row.id);
      fresh._proxyUrlPlaintext =
        decryptProxyUrl(fresh.proxyUrlEncrypted, `device '${fresh.name}'`) ??
        decryptProxyUrl(fresh.template?.proxyUrlEncrypted, 'template');
      if (fresh._proxyUrlPlaintext) {
        try { await provisionGost(fresh); } catch (err) { log.warn({ device: row.name, error: err?.message }, 'redroid net: recovery gost ensure failed'); }
      }
      await provisionTunnel(fresh); // hard failures already persisted by it
    } catch (err) {
      log.warn({ device: deviceId, attempt, error: err?.message }, 'redroid net: recovery run failed');
    } finally {
      await releaseRecoveryLock(deviceId);
    }
  }

  /**
   * Decide + trigger recovery for a device that just failed a verify pass.
   * Enforces (MD §5.4.4/§5.5): ONE recovery lock per device, exponential
   * backoff, max retries, and the gVisor-stall small budget (R2 L6h).
   */
  async function scheduleRecovery(row) {
    if (!row?.id || recovering.has(row.id)) return { recovery: 'locked' };
    const cfg = healthCfg();
    const lockUntilTs = row.netRecoveryLockUntil ? new Date(row.netRecoveryLockUntil).getTime() : 0;
    const lockHeld = Boolean(row.netRecoveryLockOwner) && lockUntilTs > Date.now();
    const dec = computeRecoveryDecision(
      {
        netState: normNetState(row),
        recoveries: Number.isInteger(row.netRecoveries) ? row.netRecoveries : 0,
        nextRecoveryAt: row.netNextRecoveryAt ? new Date(row.netNextRecoveryAt).getTime() : 0,
        lockHeldBy: lockHeld ? row.netRecoveryLockOwner : null,
        lastErrorCode: row.netLastErrorCode ?? null,
        now: Date.now(),
      },
      netPolicyCfg(),
    );
    switch (dec.action) {
      case 'skip':
        return { recovery: 'skip' };
      case 'locked':
        return { recovery: 'locked' };
      case 'wait':
        return { recovery: 'wait', retryAt: dec.retryAt };
      case 'manual-fail': {
        const cur = normNetState(row);
        const rootCause = row.netLastErrorCode ?? 'unknown';
        const detail = dec.code === NET_ERRORS.STALL_REPROVISION_USELESS
          ? `process alive + canary dead: re-provision did not restore the data plane (R2 L6h pattern) — manual intervention required (last failure: ${rootCause})`
          : `recovery attempts exhausted (max=${cfg.maxRetries}) — manual intervention required (last failure: ${rootCause})`;
        if (cur !== 'FAILED') {
          await persistNet(row, 'FAILED', { reason: `recovery-exhausted:${dec.code}`, errorCode: dec.code, errorDetail: detail, source: 'watchdog' });
        } else {
          await db.device.update({ where: { id: row.id }, data: { netManualIntervention: true, netLastErrorCode: dec.code, netLastErrorDetail: detail } }).catch(() => {});
        }
        return { recovery: 'failed', code: dec.code };
      }
      case 'recover': {
        const owner = `api-pid${process.pid}-${Date.now()}`;
        const acquired = await acquireRecoveryLock(row.id, owner, cfg.lockLeaseMs);
        if (!acquired) return { recovery: 'locked' };
        recovering.add(row.id);
        const attempt = dec.attempt;
        log.info({ device: row.name, attempt }, 'redroid net: recovery attempt starting');
        await audit({
          actorUserId: null, action: 'redroid.device.net_recovery', resourceType: 'redroid_device', resourceId: row.id,
          requestId: null, ip: null, status: 'success',
          details: { name: row.name, attempt, from: normNetState(row) },
        }).catch(() => {});
        runRecovery(row.id, owner, attempt).catch((err) => log.error({ device: row.name, error: err?.message }, 'redroid net: recovery run crashed'));
        return { recovery: 'started', attempt };
      }
      default:
        return { recovery: 'skip' };
    }
  }

  /** One watchdog pass over a single device (MD §5.4 — independent monitor). */
  async function healthTickDevice(row) {
    if (!row?.gostPort) return { skipped: 'no-proxy' };
    const cfg = healthCfg();
    const cur = normNetState(row);
    if (cur === 'STOPPED') return { skipped: 'stopped' };
    if (cur === 'FAILED') return { skipped: 'failed-manual-only' };
    if (cur === 'STARTING') {
      // stuck guard: provisioning has its own timeout, but a crashed provision
      // path would leave the device in STARTING forever → FAILED (MD §5.4.6)
      const sinceTs = row.netStateSince ? new Date(row.netStateSince).getTime() : (row.updatedAt ? new Date(row.updatedAt).getTime() : Date.now());
      if (Date.now() - sinceTs > cfg.startingTimeoutMs) {
        await persistNet(row, 'FAILED', {
          reason: 'stuck-starting',
          errorCode: NET_ERRORS.TUNNEL_START_TIMEOUT,
          errorDetail: `no progress for ${Math.round((Date.now() - sinceTs) / 1000)}s`,
          source: 'watchdog',
        });
        return { transitioned: 'FAILED' };
      }
      return { skipped: 'starting' };
    }
    // VERIFYING / HEALTHY / DEGRADED / BLOCKED → full re-verification
    const v = await verifyNow(row, { source: 'watchdog' });
    if (v.healthy) return { healthy: true };
    if (v.row?.netConsecutiveFailures === 1) {
      // first failure of the episode → its own audit event (transitions are
      // audited separately; this keeps the failure REASON findable even when
      // the state does not change)
      await audit({
        actorUserId: null, action: 'redroid.device.net_check_failed', resourceType: 'redroid_device', resourceId: row.id,
        requestId: null, ip: null, status: 'failure',
        details: { name: row.name, state: v.row?.netState ?? cur, code: v.failed?.code ?? null, detail: v.failed?.detail ?? null },
      }).catch(() => {});
    }
    // Arm the recovery backoff BEFORE deciding (stable persisted anchor,
    // MD §5.4.4): every auto attempt — including the first — is SCHEDULED,
    // never immediate. This keeps the observed state stable (DEGRADED /
    // BLOCKED, not a racing STARTING) across ticks and crash-safe across
    // API restarts. Arm semantics: null = "no schedule" → arm now; future =
    // wait; EXPIRED = fire the attempt this tick (never re-arm an expired
    // anchor — that would push the schedule into the future on the very
    // tick that should fire it and the device would wait forever).
    let target = v.row;
    if (!target.netNextRecoveryAt) {
      const nextAttempt = (Number.isInteger(target.netRecoveries) ? target.netRecoveries : 0) + 1;
      const armed = await persistNet(target, normNetState(target), { nextRecoveryAt: new Date(Date.now() + backoffMs(nextAttempt, netPolicyCfg())) });
      if (armed) target = armed;
    }
    return scheduleRecovery(target);
  }

  async function tickWatchdog() {
    if (watchdogRunning) return; // single-flight: never overlap sweeps
    watchdogRunning = true;
    try {
      const rows = await db.device.findMany({ include: { template: true } });
      for (const row of rows) {
        if (!row.gostPort) continue;
        try {
          await healthTickDevice(row);
        } catch (err) {
          log.error({ device: row.name, error: err?.message }, 'redroid net: watchdog tick device error (isolated)');
        }
      }
    } catch (err) {
      log.warn({ error: err?.message }, 'redroid net: watchdog sweep failed (db?)');
    } finally {
      watchdogRunning = false;
    }
  }

  function startWatchdog() {
    stopWatchdog();
    const pollMs = healthCfg().pollMs;
    if (!pollMs || pollMs <= 0) return; // pollMs=0 → disabled (tests use __tickOnceHealth)
    watchdogTimer = setInterval(() => {
      tickWatchdog().catch((e) => log.warn({ error: e?.message }, 'redroid net: watchdog sweep crashed'));
    }, pollMs);
    watchdogTimer.unref?.();
    // API-restart rule (MD §5.6.9): persisted state must be RECOMPUTED shortly
    // after boot — a stale HEALTHY from before the restart must not stand.
    watchdogSweepTimer = setTimeout(() => {
      tickWatchdog().catch(() => {});
    }, Math.min(pollMs, 5000));
    watchdogSweepTimer.unref?.();
  }

  function stopWatchdog() {
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    if (watchdogSweepTimer) { clearTimeout(watchdogSweepTimer); watchdogSweepTimer = null; }
  }

  /** Real host-side proxy-leg probe: gost container running + listener open. */
  async function realProxyReachable(row) {
    const client = requireClient();
    let status = 'missing';
    try {
      const info = await client.getContainer(gostContainerName(row.name)).inspect();
      status = info?.State?.Status ?? 'missing';
    } catch { /* not found */ }
    if (status !== 'running') return { ok: false, error: `gost container status=${status}` };
    try {
      await new Promise((resolve, reject) => {
        const s = net.connect({ host: GOST_HOST_BIND, port: row.gostPort, timeout: 5000 });
        s.once('connect', () => { s.destroy(); resolve(); });
        s.once('timeout', () => { s.destroy(); reject(new Error('connect timeout')); });
        s.once('error', (e) => reject(e));
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `gost listener not accepting on ${GOST_HOST_BIND}:${row.gostPort} (${clip(err?.message, 80)})` };
    }
  }

  const proxyReachableFn = injectedProxyReachable ?? realProxyReachable;

  // ---- Stage B: proxy (gost + tun2socks) lifecycle --------------------------
  async function setBinaryState(id, state, version) {
    await db.device.update({ where: { id }, data: { binaryState: state, binaryVersion: version ?? null } }).catch((err) => {
      log.warn({ deviceId: id, state, error: err?.message }, 'redroid proxy: setBinaryState failed');
    });
  }

  /**
   * Pre-provision binary check (R1). Verifies the image-baked tun2socks at
   * the single canonical path (TUN.bin) BEFORE any tunnel work: present →
   * executable → ELF magic → --version canary. Returns {state, version,
   * detail}; state=error means the check itself could not be executed
   * (exec seam failure). Machine-readable — no credentials, ever.
   */
  async function checkTun2socksBinary(containerId, name) {
    try {
      const r = await execInContainer(containerId, buildT2sCheckScript());
      const parsed = parseT2sCheckOutput(r.stdout);
      if (parsed.state) return { state: parsed.state, version: parsed.version, detail: parsed.detail };
      // no marker line at all — the check did not complete (weird output)
      return { state: 'error', version: null, detail: `unexpected check output (exit=${r.exitCode})` };
    } catch (err) {
      return { state: 'error', version: null, detail: String(err?.message ?? err).slice(0, 160) };
    }
  }

  /**
   * Create+start the device's gost container (idempotent — an existing
   * container with the deterministic name is reused, e.g. after an API
   * restart). Called from createDevice / start-action while the device
   * container is running.
   */
  async function provisionGost(row) {
    const client = requireClient();
    const name = gostContainerName(row.name);
    try {
      const existing = await client.getContainer(name).inspect();
      return { containerId: existing.Id, reused: true };
    } catch { /* not present — create below */ }
    const body = buildGostContainerBody({ deviceName: row.name, gostPort: row.gostPort, proxyUrl: row._proxyUrlPlaintext });
    let created;
    try {
      created = await client.createContainer({ _query: { name }, _body: body });
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (/port is already allocated|address already in use/i.test(msg)) {
        throw fail('REDROID_GOST_PORT_IN_USE', 502, `gost host port ${row.gostPort} conflicted at engine create time`);
      }
      throw toDockerServiceError(err, 'redroid.gost.create', name);
    }
    const containerId = typeof created?.id === 'string' ? created.id : created?.Id;
    if (!containerId || containerId.length < 12) {
      throw fail(DOCKER_ERROR.GENERIC, 502, 'gost container create returned no container id');
    }
    await client.getContainer(containerId).start();
    return { containerId, reused: false };
  }

  /** Stop+remove the device's gost container (best-effort; idempotent). */
  async function teardownGost(row) {
    if (!row.gostPort) return { removed: false, reason: 'no-gost' };
    const client = requireClient();
    const name = gostContainerName(row.name);
    try {
      await client.getContainer(name).stop().catch(() => {});
    } catch { /* already gone */ }
    try {
      await client.getContainer(name).remove({ force: true });
      return { removed: true };
    } catch (err) {
      if (/No such container|not found/i.test(String(err?.message ?? err))) return { removed: true, reason: 'already-gone' };
      return { removed: false, error: String(err?.message ?? err).slice(0, 200) };
    }
  }

  /**
   * Bring up the in-device tunnel: wait for Android boot (adb whitelist
   * getprop sys.boot_completed — the SAME op the diagnostics use), then run
   * the verified setup script via the exec seam. Idempotent. Runs in the
   * background (never blocks the create/start API response); failures land
   * in the network state machine + the log.
   *
   * R3: the end of a successful provision is VERIFYING, NEVER 'running'/
   * HEALTHY by fiat — the data-plane canary (verifyNow) is the only path
   * into HEALTHY (MD §5.2/§6.3).
   */
  async function provisionTunnel(row) {
    const cur = normNetState(row);
    if (cur === 'HEALTHY') return { started: false, reason: 'already-healthy' };
    if (cur !== 'STARTING') {
      const mid = await persistNet(row, 'STARTING', { reason: 'provision-begin', source: 'provision' });
      if (!mid) return { started: false, reason: 'transition-refused' };
      row = mid;
    }
    const bootTimeoutMs = config?.redroidTunnelBootTimeoutMs ?? 600_000;
    const pollMs = config?.redroidTunnelPollMs ?? 5000;
    const deadline = Date.now() + bootTimeoutMs;
    const target = `127.0.0.1:${row.adbPort}`;
    // 1) adb connect (first contact) — best effort
    await adbEngine.run({ op: 'connect', target }).catch(() => {});
    // 2) wait for boot_completed
    let booted = false;
    while (Date.now() < deadline) {
      try {
        const r = await adbEngine.run({ op: 'getprop', target, prop: 'sys.boot_completed' });
        if (!r.timedOut && r.exitCode === 0 && r.stdout?.trim() === '1') { booted = true; break; }
      } catch { /* adb engine validation error — do not loop forever */ break; }
      await new Promise((res) => setTimeout(res, pollMs));
    }
    if (!booted) {
      await persistNet(row, 'FAILED', { reason: 'boot-timeout', errorCode: NET_ERRORS.TUNNEL_START_TIMEOUT, errorDetail: `boot_completed not seen within ${Math.round(bootTimeoutMs / 1000)}s`, source: 'provision' });
      throw fail('REDROID_TUNNEL_BOOT_TIMEOUT', 504, `Device '${row.name}' did not report boot_completed within ${Math.round(bootTimeoutMs / 1000)}s — tunnel not provisioned`);
    }
    // 3) binary check (R1): the image-baked tun2socks must be present +
    //    executable + valid BEFORE we provision — fail-closed, machine-
    //    readable, and the device never reaches proxy 'running' on a bad
    //    binary. Diagnosis is persisted for the device view/health.
    const check = await checkTun2socksBinary(row.containerId, row.name);
    await setBinaryState(row.id, check.state, check.version);
    if (check.state === 'missing') {
      await persistNet(row, 'FAILED', { reason: 'binary-missing', errorCode: 'BINARY_MISSING', errorDetail: `tun2socks absent at ${TUN.bin} (fallback ${TUN.binFallback} also absent)`, source: 'provision' });
      throw fail('BINARY_MISSING', 500, `tun2socks binary missing on '${row.name}' at ${TUN.bin} (fallback ${TUN.binFallback} also absent) — rebuild the wrapper image (pinned v${TUN2SOCKS_PIN.version}, see docker/redroid-matrix) — tunnel not provisioned`);
    }
    if (check.state !== 'ready') {
      await persistNet(row, 'FAILED', { reason: `binary-${check.state}`, errorCode: check.state === 'invalid' ? 'BINARY_INVALID' : 'BINARY_CHECK_ERROR', errorDetail: clip(check.detail, 200), source: 'provision' });
      const code = check.state === 'invalid' ? 'BINARY_INVALID' : 'BINARY_CHECK_ERROR';
      throw fail(code, 500, `tun2socks binary ${check.state} on '${row.name}': ${check.detail ?? 'no detail'} — tunnel not provisioned`);
    }
    // 4) stage the verified setup script into the device, then run it
    //    (F-B, R1: the runner cmdline must not contain the script text —
    //    see T2S_SETUP_FILE note. Two execs: stage → run.)
    const stage = await execInContainer(row.containerId, buildT2sStageScript(buildTunnelSetupScript({ gostPort: row.gostPort })));
    if (stage.exitCode !== 0 || !/T2S_STAGED/.test(stage.stdout)) {
      await persistNet(row, 'FAILED', { reason: 'script-stage-failed', errorCode: NET_ERRORS.TUNNEL_SETUP_FAILED, errorDetail: `stage exit=${stage.exitCode} ${clip(stage.stdout ?? stage.stderr, 160)}`, source: 'provision' });
      throw fail('REDROID_TUNNEL_PROVISION_FAILED', 500, `tunnel script staging failed on '${row.name}': exit=${stage.exitCode} ${String(stage.stdout ?? stage.stderr).trim().slice(0, 200)}`);
    }
    const r = await execInContainer(row.containerId, buildT2sRunScript());
    if (r.exitCode === 0 && /tun2socks/.test(r.stdout)) {
      // tunnel process up — but PROCESS EXISTENCE IS NOT HEALTH (R2 L6h):
      // go to VERIFYING and immediately run the full data-plane verification.
      const mid = (await persistNet(row, 'VERIFYING', { reason: 'tunnel-process-up', source: 'provision' })) ?? row;
      log.info({ device: row.name, gostPort: row.gostPort }, 'redroid proxy: tunnel up — VERIFYING (data-plane canary next; only a canary PASS may earn HEALTHY)');
      const v = await verifyNow(mid, { source: 'provision' });
      return { started: true, verified: v.healthy, networkState: v.row?.netState ?? 'VERIFYING' };
    }
    await persistNet(row, 'FAILED', { reason: 'script-run-failed', errorCode: NET_ERRORS.TUNNEL_SETUP_FAILED, errorDetail: `run exit=${r.exitCode} ${clip(r.stdout ?? r.stderr, 160)}`, source: 'provision' });
    throw fail('REDROID_TUNNEL_PROVISION_FAILED', 500, `tunnel setup failed on '${row.name}': exit=${r.exitCode} ${String(r.stdout ?? r.stderr).trim().slice(0, 200)}`);
  }

  /** Kill tun2socks inside the device (best-effort; idempotent). F-B/R1: staged-file execution (same two-exec pattern as provisioning). */
  async function teardownTunnel(row) {
    if (!row.gostPort) return { done: false, reason: 'no-proxy' };
    if (!row.containerId || row.containerState !== 'running') {
      // container not running → the tunnel cannot be up; claim STOPPED so no
      // stale HEALTHY survives a container death discovered here (MD §5.4.1)
      await persistNet(row, 'STOPPED', { reason: 'teardown-container-not-running', source: 'action' });
      return { done: true, reason: 'container-not-running' };
    }
    try {
      const stage = await execInContainer(row.containerId, buildT2sStageScript(buildTunnelTeardownScript()));
      if (stage.exitCode !== 0) {
        return { done: false, error: `staging failed: exit=${stage.exitCode} ${String(stage.stdout ?? stage.stderr).trim().slice(0, 160)}` };
      }
      const r = await execInContainer(row.containerId, buildT2sRunScript());
      const ok = r.exitCode === 0;
      if (ok) await persistNet(row, 'STOPPED', { reason: 'teardown-complete', source: 'action' });
      return { done: ok, error: ok ? undefined : String(r.stdout ?? r.stderr).trim().slice(0, 200) };
    } catch (err) {
      return { done: false, error: String(err?.message ?? err).slice(0, 200) };
    }
  }

  /** Resolved 32-byte proxy encryption key (or a clean 500 — never a raw crypto throw). */
  function proxyKey() {
    if (!config?.encryptionKey) throw fail('REDROID_PROXY_CONFIG_INVALID', 500, 'APP_ENCRYPTION_KEY is not configured — cannot store proxyUrl');
    try {
      return resolveProviderKey(config.encryptionKey);
    } catch {
      throw fail('REDROID_PROXY_CONFIG_INVALID', 500, 'APP_ENCRYPTION_KEY is invalid — cannot store proxyUrl');
    }
  }

  /** Decrypt a stored proxy URL (template or device) — throws 500 on corrupt ciphertext. */
  function decryptProxyUrl(encrypted, what) {
    if (!encrypted) return null;
    try {
      return decryptSecret(encrypted, proxyKey());
    } catch {
      throw fail('REDROID_PROXY_CONFIG_INVALID', 500, `${what} proxyUrl failed to decrypt — fix or re-set it`);
    }
  }

  // ---- device lifecycle ------------------------------------------------------

  async function findDevice(idOrName) {
    const where = isUuid(idOrName) ? { id: idOrName } : { name: idOrName };
    const row = await db.device.findUnique({ where, include: { template: true } });
    return row;
  }

  /**
   * Create a device STRICTLY from a template (工單: 唔得傳原始 Docker
   * HostConfig). Body shape (route schema): {name, templateName,
   * overrides?: {width?, height?, dpi?, fps?}, idempotencyKey}.
   *
   * Order: validate → idempotency → template → name → dataDir mkdir →
   * DB row (provisioning) → docker create → start (best-effort) → DB update.
   * A docker failure rolls back the DB row + the fresh data dir (best-effort).
   */
  async function createDevice(input, { actorUserId, requestId, ip } = {}) {
    const { name, templateName, overrides, idempotencyKey } = input;
    const now = Date.now();
    sweepIdempotency(now);

    if (idempotencyKey) {
      const entry = createIdempotency.get(idempotencyKey);
      if (entry?.state === 'done') {
        // R4: replay integrity (R3 live-found footgun) — the cached create
        // result can reference a device that was DELETED within the TTL
        // window. Replaying a dead id returns a PHANTOM view (create 200,
        // GET 404). Validate the row first: gone → invalidate the key and
        // fall through to a FRESH create (this request is a legitimate
        // re-create, not a duplicate); present → replay as before.
        const rid = entry.result?.id;
        if (rid && (await findDevice(rid))) {
          return { device: entry.result, replay: true, preflight: entry.preflight ?? null };
        }
        createIdempotency.delete(idempotencyKey);
      }
      if (entry?.state === 'pending' && now - entry.at <= (config?.redroidIdempotencyTtlMs ?? 600_000)) {
        throw fail('REDROID_CREATE_IN_PROGRESS', 409, 'A device creation with this idempotency key is still in progress');
      }
    }

    if (!DEVICE_NAME_RE.test(name)) {
      throw fail('VALIDATION_ERROR', 400, `device name must match ${DEVICE_NAME_RE} (redroid- prefix, lowercase alnum/_/-)`);
    }

    const template = await db.redroidTemplate.findUnique({ where: { name: templateName } });
    if (!template) throw fail('REDROID_TEMPLATE_NOT_FOUND', 404, `Redroid template '${templateName}' not found`);
    if (!template.isEnabled) throw fail('REDROID_TEMPLATE_DISABLED', 409, `Redroid template '${templateName}' is disabled`);

    // Stage B: resolve the effective egress proxy — device override > template.
    // Both are encrypted at rest; the plaintext exists only in this function's
    // scope (never logged, never in audit details, never in the response).
    const templateProxyPlain = decryptProxyUrl(template.proxyUrlEncrypted, 'template');
    let effectiveProxy = null;
    if (typeof input.proxyUrl === 'string' && input.proxyUrl.trim() !== '') {
      effectiveProxy = validateProxyUrl(input.proxyUrl); // 400 when malformed
    } else if (templateProxyPlain) {
      effectiveProxy = parseProxyUrl(templateProxyPlain);
      if (!effectiveProxy) throw fail('REDROID_PROXY_CONFIG_INVALID', 500, 'template proxyUrl decrypted but is malformed — fix the template');
    }
    let proxyUrlEncrypted = null;
    if (effectiveProxy) {
      proxyUrlEncrypted = encryptSecret(effectiveProxy.raw, proxyKey());
    }

    // Override allowlist: display geometry only (工單: template 允許嘅字段).
    const o = overrides ?? {};
    const dim = (label, v) => {
      if (v === undefined) return;
      if (!Number.isInteger(v) || v < 160 || v > 8192) throw fail('VALIDATION_ERROR', 400, `overrides.${label} must be an integer between 160 and 8192`);
    };
    dim('width', o.width);
    dim('height', o.height);
    const dpi = o.dpi ?? template.dpi;
    if (o.dpi !== undefined && (!Number.isInteger(o.dpi) || o.dpi < 100 || o.dpi > 1200)) throw fail('VALIDATION_ERROR', 400, 'overrides.dpi must be an integer between 100 and 1200');
    const fps = o.fps ?? template.fps;
    if (o.fps !== undefined && (!Number.isInteger(o.fps) || o.fps < 1 || o.fps > 120)) throw fail('VALIDATION_ERROR', 400, 'overrides.fps must be an integer between 1 and 120');
    const width = o.width ?? template.width;
    const height = o.height ?? template.height;

    // Preflight BEFORE create — explicit warning, never the sole verdict (MD §2.3).
    let preflightResult = null;
    if (preflight) {
      try {
        preflightResult = await preflight({ gpuMode: template.gpuMode === 'host', port: null, image: template.image });
      } catch (err) {
        log.warn({ error: err?.message }, 'preflight failed during device create — reported as unknown');
        preflightResult = { overall: 'unknown', warnings: [`preflight unavailable: ${String(err?.message ?? err).slice(0, 160)}`] };
      }
    }

    const dataRoot = path.resolve(config?.redroidDataRoot ?? '/var/lib/water-army/redroid');
    const dataDir = path.join(dataRoot, name);

    let row = null;
    let createdDir = false;
    try {
      // 1. data dir (per-device persistence, MD §10.2)
      try {
        const stat = await fs.promises.lstat(dataDir).catch(() => null);
        if (stat && !stat.isDirectory()) throw new Error('data path exists and is not a directory');
        if (!stat) {
          await fs.promises.mkdir(dataDir, { recursive: true, mode: 0o750 });
          createdDir = true;
        }
      } catch (err) {
        throw fail('REDROID_DATA_DIR_ERROR', 500, `Cannot prepare device data dir: ${err.message}`, { dataDir });
      }

      // 2. DB row (port allocation with collision retry)
      const portAttempts = Math.min(endRange(config) - startRange(config) + 1, 25);
      for (let attempt = 0; ; attempt++) {
        const adbPort = await allocateAdbPort();
        const gostPort = effectiveProxy ? await allocateGostPort() : null;
        try {
          row = await db.device.create({
            data: {
              name,
              templateId: template.id,
              adbPort,
              dataDir,
              containerName: name,
              containerId: null,
              image: template.image,
              androidVersion: template.androidVersion,
              width,
              height,
              dpi,
              fps,
              gpuMode: template.gpuMode,
              containerState: 'provisioning',
              adbState: 'unknown',
              // MD §2.4: DeviceRequests 存在 ≠ GPU 正常 — host mode starts
              // as 未驗證; swiftshader is honestly 'software'.
              gpuStatus: template.gpuMode === 'host' ? 'unverified' : 'software',
              // Stage B: per-device proxy binding (null trio = no proxy).
              gostPort,
              proxyUrlEncrypted,
              proxyState: effectiveProxy ? 'provisioning' : 'off',
              // R3: authoritative network state — devices start STOPPED; the
              // proxied path claims STARTING through the audited transition
              // right below (the create event itself never writes state blind).
              netState: 'STOPPED',
              netStateSince: new Date(),
              netConsecutiveFailures: 0,
              netRecoveries: 0,
              netManualIntervention: false,
            },
          });
          break;
        } catch (err) {
          if (err?.code === 'P2002') {
            if (String(err?.message ?? '').includes('(name)')) {
              throw fail('REDROID_NAME_TAKEN', 409, `Device name '${name}' already exists`);
            }
            if (String(err?.message ?? '').includes('adbPort') && attempt < portAttempts) continue;
            if (String(err?.message ?? '').includes('gostPort') && attempt < portAttempts) continue;
            throw err;
          }
          throw err;
        }
      }

      if (idempotencyKey) createIdempotency.set(idempotencyKey, { state: 'pending', at: now });

      // R3: claim the provisioning state through the audited STOPPED→STARTING
      // transition (audit trail completeness — MD §5.4.2: every state change
      // is a data event; the create must not bypass the state machine).
      if (effectiveProxy) {
        const mid = await persistNet(row, 'STARTING', { reason: 'provision-begin', source: 'create' });
        if (mid) row = mid;
      }

      // 3. docker create — config built from template fields ONLY (MD §13.1)
      const client = requireClient();
      const HostConfig = {
        NetworkMode: 'bridge',
        PortBindings: {
          // MD §1.2 hard rule: ADB publishes on 127.0.0.1 ONLY.
          // The bind address is a server-side constant — there is no client
          // input that can change it (route schema has no bind field).
          [`${REDROID_ADB_CONTAINER_PORT}/tcp`]: [{ HostIP: REDROID_LOOPBACK_BIND, HostPort: String(row.adbPort) }],
        },
        Mounts: [{ Type: 'bind', Source: dataDir, Target: '/data', ReadOnly: false }],
        // MD §7: privileged comes ONLY from the template.
        Privileged: Boolean(template.privileged),
      };
      // R5 (MD §7.2.7): resource limits come ONLY from the template (validated
      // ranges in validateRedroidTemplate); null = unlimited (honest default).
      if (template.cpuLimit) HostConfig.NanoCpus = Math.round(template.cpuLimit * 1e9);
      if (template.memoryLimitBytes !== null && template.memoryLimitBytes !== undefined) {
        HostConfig.Memory = Number(template.memoryLimitBytes);
      }
      if (template.gpuMode === 'host') {
        // 「設定 + 實測」(MD §2.4): the DeviceRequest is the configuration;
        // gpuStatus stays 'unverified' until an in-device render check exists.
        HostConfig.DeviceRequests = [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }];
      }
      const createBody = {
        Image: template.image, // pinned at template time — immutable here
        ExposedPorts: { [`${REDROID_ADB_CONTAINER_PORT}/tcp`]: {} },
        // MD §2.1: androidboot.* as START ARGS. Env is deliberately empty —
        // redroid reads these from the kernel cmdline, not from Env.
        Cmd: buildRedroidCmd({ width, height, dpi, fps, gpuMode: template.gpuMode }),
        Env: [],
        Labels: {
          'app.managed': 'true',
          'app.template': template.name,
          'app.created-by': String(actorUserId ?? 'unknown'),
          'redroid.device.name': name,
          'redroid.gpu.mode': template.gpuMode,
        },
        HostConfig,
      };

      let created;
      try {
        created = await client.createContainer({ _query: { name }, _body: createBody });
      } catch (err) {
        const msg = String(err?.message ?? err);
        if (/port is already allocated|address already in use/i.test(msg)) {
          await rollback(row, dataDir, createdDir);
          throw fail('PORT_IN_USE', 409, `ADB host port ${row.adbPort} conflicted at engine create time`);
        }
        if (/already in use|name already/i.test(msg)) {
          await rollback(row, dataDir, createdDir);
          throw fail('REDROID_NAME_TAKEN', 409, `Container name '${name}' is already in use`);
        }
        await rollback(row, dataDir, createdDir);
        log.error({ op: 'redroid.create', name, error: msg }, 'redroid container create failed');
        throw toDockerServiceError(err, 'redroid.create', name);
      }

      const containerId = typeof created?.id === 'string' ? created.id : created?.Id;
      if (!containerId || containerId.length < 12) {
        await rollback(row, dataDir, createdDir);
        throw fail(DOCKER_ERROR.GENERIC, 502, 'Docker create returned no container id');
      }

      // 4. start (best-effort — creation is the contract, MD §9.2 parity)
      let containerState = 'created';
      let startError = null;
      try {
        await client.getContainer(containerId).start();
        containerState = 'running';
      } catch (err) {
        startError = { code: err.apiCode ?? 'DOCKER_ERROR', message: String(err?.message ?? err).slice(0, 300) };
      }
      try {
        const info = await client.getContainer(containerId).inspect();
        containerState = info?.State?.Status ?? containerState;
      } catch {
        /* keep best-effort state */
      }

      row = await db.device.update({
        where: { id: row.id },
        data: { containerId, containerState },
      });

      // Stage B: when a proxy is bound, bring up the per-device gost container
      // (synchronous — part of the creation contract: a device with a proxy
      // that has no working local listener is broken-by-default) and then the
      // in-device tunnel in the BACKGROUND (boot can take minutes; the create
      // response must not wait — failures land in proxyState='error').
      if (effectiveProxy && containerState === 'running') {
        row._proxyUrlPlaintext = effectiveProxy.raw;
        await provisionGost(row); // throws → rollback() tears down (incl. gost)
        const freshRow = { ...row, containerId, containerState };
        provisionTunnel(freshRow).catch((err) => {
          log.error({ device: name, error: err?.message }, 'redroid proxy: background tunnel provisioning failed');
        });
      } else if (effectiveProxy && containerState !== 'running') {
        log.warn({ device: name, containerState }, 'redroid proxy: container not running at create — tunnel will be provisioned on the start action');
      }

      const result = deviceView({ ...row, template: { name: template.name } }, { withDataDir: true });
      if (idempotencyKey) createIdempotency.set(idempotencyKey, { state: 'done', at: Date.now(), result, preflight: preflightResult });

      await audit({
        actorUserId: actorUserId ?? null,
        action: 'redroid.device.create',
        resourceType: 'redroid_device',
        resourceId: row.id,
        requestId: requestId ?? null,
        ip: ip ?? null,
        status: startError ? 'failure' : 'success',
        details: {
          name,
          templateName: template.name,
          image: template.image,
          adbPort: row.adbPort,
          adbBind: REDROID_LOOPBACK_BIND,
          gpuMode: template.gpuMode,
          privileged: Boolean(template.privileged),
          proxySet: Boolean(effectiveProxy),
          gostPort: row.gostPort ?? null,
          startError: startError ?? undefined,
          preflightOverall: preflightResult?.overall ?? null,
        },
      });

      return { device: result, replay: false, startError, preflight: preflightResult };
    } catch (err) {
      if (idempotencyKey) createIdempotency.delete(idempotencyKey);
      throw err;
    }
  }

  /** Roll back a failed create: DB row + fresh data dir (never a pre-existing one) + any gost container already started. */
  async function rollback(row, dataDir, createdDir) {
    try {
      if (row?.gostPort) await teardownGost(row).catch(() => {});
    } catch {
      /* best-effort */
    }
    try {
      if (row) await db.device.delete({ where: { id: row.id } }).catch(() => {});
    } catch {
      /* best-effort */
    }
    try {
      if (createdDir) await fs.promises.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    } catch {
      /* best-effort */
    }
  }

  function toDockerServiceError(err, operation, name) {
    if (err instanceof RedroidServiceError || err instanceof DockerServiceError) return err;
    const e = new DockerServiceError({ code: DOCKER_ERROR.GENERIC, message: String(err?.message ?? err).slice(0, 300) });
    e.operation = operation;
    e.containerId = name;
    return e;
  }

  async function listDevices({ templateName } = {}) {
    const rows = await db.device.findMany({
      where: templateName ? { template: { name: templateName } } : {},
      include: { template: true },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => deviceView(r));
  }

  async function getDeviceView(idOrName, { withDataDir = false } = {}) {
    const row = await findDevice(idOrName);
    if (!row) throw fail('REDROID_DEVICE_NOT_FOUND', 404, `Device '${idOrName}' not found`);
    return deviceView(row, { withDataDir });
  }

  /**
   * start / stop / restart via the P2 DockerService action protocol
   * (inspect → op → inspect confirm). Container gone from the daemon →
   * device marked 'missing' + 409 (honest — never pretend success).
   */
  async function runDeviceAction(idOrName, action, { actorUserId, requestId, ip } = {}) {
    const row = await findDevice(idOrName);
    if (!row) throw fail('REDROID_DEVICE_NOT_FOUND', 404, `Device '${idOrName}' not found`);
    if (!row.containerId) {
      throw fail('REDROID_NOT_PROVISIONED', 409, `Device '${row.name}' has no container (create failed) — delete and recreate it`);
    }
    // Stage B: tear the tunnel down BEFORE the container stops (exec needs a
    // running container). Best-effort — the docker action is the contract.
    if (row.gostPort && (action === 'stop' || action === 'restart')) {
      // R3: claim STOPPED BEFORE the container stops — an operator stop must
      // never be read as a crash by the watchdog (MD §5.4.1); the tunnel
      // teardown then follows (needs the container still running).
      await persistNet(row, 'STOPPED', { reason: `action-${action}`, source: 'action' });
      await teardownTunnel(row).catch(() => {});
    }
    let result;
    try {
      result = await dockerService.runAction(row.containerId, action);
    } catch (err) {
      if (err instanceof DockerServiceError && err.apiCode === DOCKER_ERROR.CONTAINER_NOT_FOUND) {
        await db.device.update({ where: { id: row.id }, data: { containerState: 'missing', adbState: 'unknown' } }).catch(() => {});
        throw fail('REDROID_CONTAINER_MISSING', 409, `Container for device '${row.name}' no longer exists in the daemon — delete the device and recreate`);
      }
      throw err;
    }
    await db.device.update({ where: { id: row.id }, data: { containerState: result.state } });
    // Stage B: after start/restart — (re)provision gost (idempotent reuse)
    // synchronously + the in-device tunnel in the background (boot may take minutes).
    if (row.gostPort && (action === 'start' || action === 'restart') && result.state === 'running') {
      row._proxyUrlPlaintext =
        decryptProxyUrl(row.proxyUrlEncrypted, `device '${row.name}'`) ??
        decryptProxyUrl(row.template?.proxyUrlEncrypted, 'template');
      if (!row._proxyUrlPlaintext) {
        throw fail('REDROID_PROXY_CONFIG_INVALID', 500, `Device '${row.name}' has a gost port but no resolvable proxyUrl`);
      }
      await provisionGost(row);
      const freshNow = await findDevice(row.id);
      provisionTunnel(freshNow).catch((err) => {
        log.error({ device: row.name, error: err?.message }, 'redroid proxy: background tunnel provisioning failed');
      });
    }
    await audit({
      actorUserId: actorUserId ?? null,
      action: `redroid.device.${action}`,
      resourceType: 'redroid_device',
      resourceId: row.id,
      requestId: requestId ?? null,
      ip: ip ?? null,
      status: 'success',
      details: { name: row.name, containerId: row.containerId, state: result.state, idempotent: result.idempotent },
    });
    const fresh = await findDevice(row.id);
    return { device: deviceView(fresh), idempotent: result.idempotent, action };
  }

  /**
   * Delete (admin, two-step confirm = device name or id).
   * - stop-if-running (best-effort) → container remove (P2 protocol)
   * - data dir removed ONLY when removeData=true, after strict path checks
   *   (realpath must stay inside redroidDataRoot — no symlink escape)
   */
  async function deleteDevice(idOrName, { confirm, removeData = false, actorUserId, requestId, ip } = {}) {
    const row = await findDevice(idOrName);
    if (!row) throw fail('REDROID_DEVICE_NOT_FOUND', 404, `Device '${idOrName}' not found`);
    const confirmValue = String(confirm ?? '').trim();
    if (confirmValue !== row.name && confirmValue !== row.id) {
      throw fail('VALIDATION_ERROR', 400, 'confirm must repeat the device name or id exactly (two-step confirmation)');
    }

    let containerRemoved = false;
    let containerError = null;
    // Stage B: tear down the tunnel FIRST (needs the container running), then
    // the container, then the per-device gost container.
    let tunnelTeardown = null;
    if (row.gostPort) {
      tunnelTeardown = await teardownTunnel(row).catch((e) => ({ done: false, error: String(e?.message ?? e).slice(0, 200) }));
    }
    if (row.containerId) {
      try {
        await dockerService.runAction(row.containerId, 'stop').catch(() => {});
        await dockerService.deleteContainer(row.containerId, { confirm: row.containerName });
        containerRemoved = true;
      } catch (err) {
        containerError = String(err?.message ?? err).slice(0, 200);
        // A container already gone is fine — the daemon state wins.
        if (err instanceof DockerServiceError && err.apiCode === DOCKER_ERROR.CONTAINER_NOT_FOUND) containerRemoved = true;
      }
    }

    let dataRemoved = false;
    let dataRemoveError = null;
    if (removeData) {
      const r = await removeRedroidDataDir(row.dataDir, config?.redroidDataRoot);
      dataRemoved = r.removed;
      dataRemoveError = r.error;
    }

    let gostTeardown = null;
    if (row.gostPort) {
      gostTeardown = await teardownGost(row).catch((e) => ({ removed: false, error: String(e?.message ?? e).slice(0, 200) }));
    }

    // R4: invalidate any create-idempotency entry that cached THIS device's
    // create result — otherwise a re-create with the same key within the TTL
    // window would replay the deleted device (phantom view: create 200,
    // GET 404). Defense in depth: the replay path ALSO validates row
    // existence (covers an API crash-restart between create and delete…
    // note the map is per-process, so this sweep is the same-process guard).
    for (const [k, v] of createIdempotency) {
      if (v?.state === 'done' && v.result?.id === row.id) createIdempotency.delete(k);
    }

    await db.device.delete({ where: { id: row.id } });
    await audit({
      actorUserId: actorUserId ?? null,
      action: 'redroid.device.delete',
      resourceType: 'redroid_device',
      resourceId: row.id,
      requestId: requestId ?? null,
      ip: ip ?? null,
      status: containerError ? 'failure' : 'success',
      details: { name: row.name, adbPort: row.adbPort, containerRemoved, removeData: Boolean(removeData), dataRemoved, dataRemoveError: dataRemoveError ?? undefined, containerError: containerError ?? undefined, proxyTornDown: tunnelTeardown ?? undefined, gostRemoved: gostTeardown ?? undefined },
    });
    return { deleted: true, name: row.name, containerRemoved, removeData: Boolean(removeData), dataRemoved, dataRemoveError: dataRemoveError ?? undefined, containerError: containerError ?? undefined, proxyTornDown: tunnelTeardown ?? undefined, gostRemoved: gostTeardown ?? undefined };
  }

  /**
   * Refresh device state: container state from the daemon (inspect) + ADB
   * state via the whitelist `get-state` op (honest: adb unavailable →
   * 'unknown', never 'online'). gpuStatus is NEVER touched here — only an
   * in-device render check may change it (MD §2.4).
   */
  async function refreshDevice(idOrName, { actorUserId, requestId, ip } = {}) {
    const row = await findDevice(idOrName);
    if (!row) throw fail('REDROID_DEVICE_NOT_FOUND', 404, `Device '${idOrName}' not found`);

    let containerState = row.containerState;
    if (row.containerId) {
      try {
        const summary = await dockerService.inspectSummary(row.containerId);
        containerState = summary.state.status;
      } catch (err) {
        if (err instanceof DockerServiceError && err.apiCode === DOCKER_ERROR.CONTAINER_NOT_FOUND) containerState = 'missing';
        else containerState = row.containerState; // daemon error — keep last known, report the error
      }
    }

    let adbState = 'unknown';
    let adbNote = null;
    if (containerState === 'running') {
      try {
        const res = await adbEngine.run({ op: 'get-state', target: `127.0.0.1:${row.adbPort}` });
        const out = `${res.stdout}\n${res.stderr}`.toLowerCase();
        if (res.timedOut) adbNote = 'adb get-state timed out';
        else if (/device online/.test(out)) adbState = 'online';
        else if (/offline|no devices|cannot connect/.test(out)) adbState = 'offline';
        else adbState = res.exitCode === 0 ? 'online' : 'offline';
        if (res.truncated) adbNote = adbNote ?? 'adb output truncated';
      } catch (err) {
        adbState = 'unknown';
        adbNote = err?.apiCode ? err.message : 'adb unavailable on this host';
      }
    } else {
      adbNote = `container state '${containerState}' — adb not checked (not executed = 未驗證)`;
    }

    await db.device.update({ where: { id: row.id }, data: { containerState, adbState } });
    await audit({
      actorUserId: actorUserId ?? null,
      action: 'redroid.device.refresh',
      resourceType: 'redroid_device',
      resourceId: row.id,
      requestId: requestId ?? null,
      ip: ip ?? null,
      status: 'success',
      details: { name: row.name, containerState, adbState },
    });
    const fresh = await findDevice(row.id);
    if (!fresh) throw fail('REDROID_DEVICE_NOT_FOUND', 404, `Device '${row.name}' vanished during refresh`);
    // R3: a refresh must not leave a stale HEALTHY — recompute the
    // authoritative network state when a proxy is bound (a device whose
    // container just died drops out of HEALTHY within this call).
    let netTick = null;
    if (fresh.gostPort) {
      try { netTick = await healthTickDevice(fresh); } catch (err) { netTick = { error: clip(err?.message, 160) }; }
    }
    const fresh2 = netTick && !netTick.skipped ? await findDevice(row.id) : fresh;
    return { device: deviceView(fresh2 ?? fresh), adbNote, network: fresh2?.gostPort ? buildNetPayload(fresh2 ?? fresh, { staleTtlMs: healthCfg().staleTtlMs, canaryConfigured: canaryConfigured() }) : null };
  }

  // ---- diagnostics (工單: 4 個獨立結果區，任一項未執行 = 未驗證) ----------

  /**
   * POST /diagnostics — the four independent result zones (施工 MD §6.4):
   *   kernel            — real host preflight (or mock-labelled)
   *   containerLogs     — bounded docker logs
   *   adbConnectivity   — whitelist get-state (+ one connect attempt)
   *   gpuVerification   — honest configuration-level assessment
   * Each zone reports `executed` + its own status; a zone that was NOT
   * executed is 'unverified' — never a silent pass (未驗證 語義).
   */
  async function diagnoseDevice(idOrName, { actorUserId, requestId, ip } = {}) {
    const row = await findDevice(idOrName);
    if (!row) throw fail('REDROID_DEVICE_NOT_FOUND', 404, `Device '${idOrName}' not found`);

    // -- zone 1: kernel (MD §10.1 — real host check, independent display) --
    let kernel;
    if (!preflight) {
      kernel = { executed: true, status: 'unknown', note: 'preflight not configured on this service' };
    } else {
      try {
        const pf = await preflight({ gpuMode: row.gpuMode === 'host', port: null });
        kernel = {
          executed: true,
          status: pf.overall ?? 'unknown', // supported | unsupported | unknown
          mock: pf.mock === true ? true : undefined,
          summary: pf.warnings ?? [],
          details: pf,
        };
      } catch (err) {
        kernel = { executed: true, status: 'unknown', note: `preflight failed: ${String(err?.message ?? err).slice(0, 200)}` };
      }
    }

    // -- zone 2: container logs (bounded) --
    let containerLogs;
    if (!row.containerId) {
      containerLogs = { executed: false, status: 'unverified', note: 'device not provisioned (no container) — not executed' };
    } else {
      try {
        const logs = await dockerService.getLogs(row.containerId, { tail: config?.dockerLogTailDefault ?? 500 });
        containerLogs = { executed: true, status: 'ok', lines: logs.lines, truncated: logs.truncated, tail: logs.lines.length };
      } catch (err) {
        if (err instanceof DockerServiceError && err.apiCode === DOCKER_ERROR.CONTAINER_NOT_FOUND) {
          containerLogs = { executed: false, status: 'unverified', note: 'container no longer exists in the daemon — not executed' };
        } else {
          containerLogs = { executed: true, status: 'error', note: String(err?.message ?? err).slice(0, 200) };
        }
      }
    }

    // -- zone 3: ADB connectivity (whitelist get-state; loopback only) --
    let adbConnectivity;
    const running = row.containerState === 'running';
    if (!running) {
      adbConnectivity = { executed: false, status: 'unverified', note: `container state '${row.containerState}' — adb not checked (not executed = 未驗證)` };
    } else {
      const target = `127.0.0.1:${row.adbPort}`;
      const parseState = (res) => {
        const out = `${res.stdout}\n${res.stderr}`.toLowerCase();
        if (/device online/.test(out) && !/offline/.test(out)) return true;
        if (/offline|no devices|cannot connect/.test(out)) return false;
        return res.exitCode === 0 ? true : false; // unknown wording — exit code is the last resort
      };
      try {
        let res = await adbEngine.run({ op: 'get-state', target });
        let online = parseState(res);
        let connectAttempted = false;
        if (!online) {
          // one connect attempt, then re-check (still whitelist ops only)
          await adbEngine.run({ op: 'connect', target });
          connectAttempted = true;
          res = await adbEngine.run({ op: 'get-state', target });
          online = parseState(res);
        }
        adbConnectivity = {
          executed: true,
          status: online ? 'online' : 'offline',
          target,
          connectAttempted,
          timedOut: res.timedOut || undefined,
          truncated: res.truncated || undefined,
          evidence: (res.stdout ?? '').slice(0, 500),
        };
      } catch (err) {
        adbConnectivity = { executed: true, status: 'offline', note: err?.apiCode ? err.message : 'adb unavailable on this host' };
      }
    }

    // -- zone 4: GPU verification (MD §2.4 — 設定 + 實測) --
    let gpuVerification;
    if (row.gpuMode === 'host') {
      gpuVerification = {
        executed: true, // the configuration assessment was executed
        status: 'unverified', // P5 has NO in-device render check — 未驗證 is the truth
        gpuStatus: row.gpuStatus,
        note: 'Docker DeviceRequests are configured (host GPU mode) but no in-device render check exists in P5 — status stays 未驗證 until one does (MD §2.4). nvidia-smi success alone is NOT verification (see kernel zone gpu detail).',
      };
    } else {
      gpuVerification = {
        executed: true,
        status: 'software',
        gpuStatus: row.gpuStatus,
        note: 'swiftshader_indirect configured — software rendering (no host GPU). This is the configured mode, reported as 軟體/降級模式 (MD §2.4).',
      };
    }

    // -- zone 5: network (R3) — control plane + data plane + binary state --
    // Runs the SAME verification pass as the watchdog (source=diagnostics),
    // so a diagnostics call is authoritative — and the result feeds the
    // transition table like any other verified event (MD §5.2/§5.3).
    // ZERO SECRETS: only machine-readable check values are exposed.
    let network;
    if (!row.gostPort) {
      network = { executed: false, status: 'unconfigured', note: 'device has no proxy binding — no network protection to verify' };
    } else {
      const curState = normNetState(row);
      if (curState === 'STOPPED' || curState === 'FAILED') {
        network = { executed: false, status: 'unverified', note: `network state ${curState} — checks not executed (operator/manual state; FAILED requires manual retry)`, state: curState };
      } else {
        try {
          const v = await verifyNow(row, { source: 'diagnostics' });
          network = {
            executed: true,
            status: v.healthy ? 'pass' : 'fail',
            state: v.row?.netState ?? curState,
            checks: v.checks ?? {},
            canary: v.canary ? { result: v.canary.result, reason: v.canary.reason ?? undefined, latencyMs: v.canary.ms ?? undefined } : null,
            lastError: v.failed ? { code: v.failed.code, detail: v.failed.detail } : null,
            binaryState: { state: row.binaryState ?? null, version: row.binaryVersion ?? null },
          };
        } catch (err) {
          network = { executed: true, status: 'error', state: curState, note: clip(err?.message, 200) };
        }
      }
    }

    await db.device.update({ where: { id: row.id }, data: { lastDiagnosedAt: new Date() } }).catch(() => {});
    await audit({
      actorUserId: actorUserId ?? null,
      action: 'redroid.device.diagnostics',
      resourceType: 'redroid_device',
      resourceId: row.id,
      requestId: requestId ?? null,
      ip: ip ?? null,
      status: 'success',
      details: {
        name: row.name,
        zones: {
          kernel: kernel.status,
          containerLogs: containerLogs.status,
          adbConnectivity: adbConnectivity.status,
          gpuVerification: gpuVerification.status,
          network: network.status,
        },
      },
    });

    const freshRow = await findDevice(row.id);
    return {
      device: deviceView(freshRow ?? row),
      checkedAt: new Date().toISOString(),
      diagnostics: { kernel, containerLogs, adbConnectivity, gpuVerification, network },
    };
  }

  /**
   * GET /logcat?tail= — whitelist logcat op with the tail CAP enforced
   * server-side (MD §1.2/§7: logcat 限量 -t <n>，n 有 cap).
   */
  async function getLogcat(idOrName, { tail, actorUserId, requestId, ip } = {}) {
    const row = await findDevice(idOrName);
    if (!row) throw fail('REDROID_DEVICE_NOT_FOUND', 404, `Device '${idOrName}' not found`);
    const max = config?.redroidLogcatTailMax ?? 5000;
    const def = config?.redroidLogcatTailDefault ?? 200;
    let requested = tail === undefined ? null : tail;
    if (requested !== null) {
      if (!Number.isInteger(requested) || requested < 1) throw fail('VALIDATION_ERROR', 400, 'tail must be a positive integer');
    }
    const effective = Math.min(requested ?? def, max); // cap is SERVER-side, always
    const target = `127.0.0.1:${row.adbPort}`;
    let result;
    try {
      result = await adbEngine.run({ op: 'logcat', target, tail: effective });
    } catch (err) {
      if (err?.name === 'AdbWhitelistError') throw fail('VALIDATION_ERROR', 400, err.message);
      throw err;
    }
    await db.device.update({ where: { id: row.id }, data: { lastDiagnosedAt: new Date() } }).catch(() => {});
    await audit({
      actorUserId: actorUserId ?? null,
      action: 'redroid.device.logcat',
      resourceType: 'redroid_device',
      resourceId: row.id,
      requestId: requestId ?? null,
      ip: ip ?? null,
      status: 'success',
      details: { name: row.name, tail: effective, truncated: result.truncated },
    });
    return {
      device: row.name,
      target,
      tail: effective,
      tailCap: max,
      truncated: result.truncated,
      timedOut: result.timedOut || undefined,
      lines: result.stdout.split('\n').filter((l) => l.length > 0),
    };
  }

  // ---- preflight (real host check, MD §10.1) ---------------------------------

  async function getPreflight({ gpuMode, port, image } = {}) {
    if (!preflight) throw fail('REDROID_PREFLIGHT_UNAVAILABLE', 503, 'preflight is not configured on this service');
    try {
      return await preflight({
        gpuMode: Boolean(gpuMode),
        port: Number.isInteger(port) ? port : null,
        image: typeof image === 'string' && image.length >= 3 ? image.slice(0, 255) : undefined,
      });
    } catch (err) {
      throw fail('REDROID_PREFLIGHT_UNAVAILABLE', 503, `preflight failed: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }

  /**
   * Device view (closure — needs healthCfg for the R3 net payload).
   * R3: proxy.network = the authoritative network health payload
   * (state, freshness, canary result, error, recovery info) — ZERO SECRETS:
   * no proxy URL/credentials in any field (buildNetPayload is structurally
   * incapable of carrying them; only machine-readable status values).
   */
  function deviceView(row, { withDataDir = false } = {}) {
    const net = row.gostPort
      ? buildNetPayload(row, { staleTtlMs: healthCfg().staleTtlMs, canaryConfigured: canaryConfigured() })
      : null;
    const view = {
      id: row.id,
      name: row.name,
      templateName: row.template?.name ?? null,
      image: row.image,
      androidVersion: row.androidVersion,
      width: row.width,
      height: row.height,
      dpi: row.dpi,
      fps: row.fps,
      adbPort: row.adbPort,
      adbBind: REDROID_LOOPBACK_BIND, // the UI must say "localhost only"
      gpuMode: row.gpuMode,
      gpuStatus: row.gpuStatus,
      containerName: row.containerName,
      containerId: row.containerId,
      containerState: row.containerState,
      adbState: row.adbState,
      // Stage B: proxy binding. The URL itself NEVER leaves the server —
      // clients see existence + port + state only.
      proxy: row.gostPort
        ? {
            configured: true,
            gostPort: row.gostPort,
            gostBind: GOST_HOST_BIND,
            state: row.proxyState ?? 'off', // legacy projection (R4 retires)
            hasUrl: Boolean(row.proxyUrlEncrypted),
            containerName: gostContainerName(row.name),
            // R1: tun2socks binary diagnosis (state + version string only —
            // no path internals, no credentials, ever).
            binaryState: row.binaryState ?? null,
            binaryVersion: row.binaryVersion ?? null,
            // R3: authoritative network health (the state machine, not the
            // legacy projection — R4 consumers read THIS).
            network: net,
          }
        : { configured: false, gostPort: null, state: row.proxyState ?? 'off', hasUrl: false, binaryState: row.binaryState ?? null, binaryVersion: row.binaryVersion ?? null, network: net },
      lastDiagnosedAt: row.lastDiagnosedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    if (withDataDir) view.dataDir = row.dataDir;
    return view;
  }

  /**
   * POST /:id/proxy/retry — the manual-intervention trigger (MD §5.4.6):
   * after FAILED (or to nudge a stuck DEGRADED/BLOCKED), a human resets the
   * failure episode and forces a recovery attempt NOW (explicit human intent
   * = backoff bypass). The attempt still ends in VERIFYING + canary — this
   * endpoint can never blind-set HEALTHY.
   */
  async function retryProxyRecovery(idOrName, { actorUserId, requestId, ip } = {}) {
    const row = await findDevice(idOrName);
    if (!row) throw fail('REDROID_DEVICE_NOT_FOUND', 404, `Device '${idOrName}' not found`);
    if (!row.gostPort) throw fail('REDROID_NO_PROXY', 409, `Device '${row.name}' has no proxy binding — nothing to recover`);
    const cur = normNetState(row);
    if (!['FAILED', 'BLOCKED', 'DEGRADED'].includes(cur)) {
      throw fail('REDROID_NET_RETRY_INVALID_STATE', 409, `network state '${cur}' does not accept a manual retry (allowed: FAILED/BLOCKED/DEGRADED)`);
    }
    // reset the failure episode (counters, last error, stale lock)
    await db.device.update({
      where: { id: row.id },
      data: {
        netRecoveries: 0, netManualIntervention: false, netConsecutiveFailures: 0,
        netLastErrorCode: null, netLastErrorDetail: null,
        netRecoveryLockOwner: null, netRecoveryLockUntil: null, netLastRecoveryAt: null, netNextRecoveryAt: null,
      },
    }).catch((err) => log.warn({ device: row.name, error: err?.message }, 'redroid net: retry episode reset failed'));
    const fresh = await findDevice(row.id);
    await audit({
      actorUserId: actorUserId ?? null, action: 'redroid.device.net_retry', resourceType: 'redroid_device', resourceId: row.id,
      requestId: requestId ?? null, ip: ip ?? null, status: 'success',
      details: { name: row.name, from: cur },
    });
    if (cur === 'FAILED') {
      // The manual exit door (MD §5.4.6): FAILED → STARTING is the only
      // manual transition out of the sink. Then the full re-provision +
      // re-verification — only a canary PASS can restore HEALTHY.
      const mid = await persistNet(fresh, 'STARTING', { reason: 'manual-retry', source: 'retry', recoveries: 0, nextRecoveryAt: null });
      if (!mid) return { device: deviceView(fresh), triggered: false, schedule: { recovery: 'skip' } };
      mid._proxyUrlPlaintext =
        decryptProxyUrl(mid.proxyUrlEncrypted, `device '${mid.name}'`) ??
        decryptProxyUrl(mid.template?.proxyUrlEncrypted, 'template');
      if (mid._proxyUrlPlaintext) {
        try { await provisionGost(mid); } catch (err) { log.warn({ device: mid.name, error: err?.message }, 'redroid net: manual retry gost ensure failed'); }
      }
      provisionTunnel(mid).catch((err) => log.error({ device: mid.name, error: err?.message }, 'redroid net: manual retry re-provision failed'));
      const after = await findDevice(mid.id);
      return { device: deviceView(after ?? mid), triggered: true, schedule: { recovery: 'started', attempt: 1 } };
    }
    // DEGRADED/BLOCKED: the episode reset above cleared the anchor, so the
    // forced attempt is immediate (manual retry bypasses the auto backoff).
    const sched = await scheduleRecovery(fresh);
    const after = await findDevice(row.id);
    return { device: deviceView(after ?? fresh), triggered: sched.recovery === 'started' || sched.recovery === 'wait' || sched.recovery === 'locked', schedule: sched };
  }

  /** Close the watchdog (test/ops seam; timers are unref'd anyway). */
  async function close() {
    stopWatchdog();
  }

  /** One watchdog pass (test/ops seam). deviceId omitted → all proxy devices. */
  async function __tickOnceHealth(idOrName) {
    if (idOrName) {
      const row = await findDevice(idOrName);
      if (!row) return { skipped: 'not-found' };
      return healthTickDevice(row);
    }
    await tickWatchdog();
    return { swept: true };
  }

  // The watchdog is the fail-closed heart of R3 — start it with the service.
  // pollMs=0 disables it (hermetic tests drive __tickOnceHealth explicitly).
  startWatchdog();

  return {
    listTemplates,
    getTemplateView,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    listDevices,
    getDeviceView,
    createDevice,
    runDeviceAction,
    deleteDevice,
    refreshDevice,
    diagnoseDevice,
    getLogcat,
    getPreflight,
    retryProxyRecovery,
    close,
    // test/ops seams
    __allocateAdbPort: allocateAdbPort,
    __tickOnceHealth,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s ?? ''));
}

function startRange(config) {
  return config?.redroidAdbRangeStart ?? 15000;
}
function endRange(config) {
  return config?.redroidAdbRangeEnd ?? 15999;
}

function publicTemplate(t) {
  return {
    id: t.id,
    name: t.name,
    image: t.image,
    androidVersion: t.androidVersion,
    width: t.width,
    height: t.height,
    dpi: t.dpi,
    fps: t.fps,
    gpuMode: t.gpuMode,
    privileged: t.privileged,
    privilegedReason: t.privilegedReason,
    isEnabled: t.isEnabled,
    // R5: limits as JSON-safe numbers (BigInt → number; ≤ 256 GiB « 2^53).
    cpuLimit: t.cpuLimit ?? null,
    memoryLimitBytes: t.memoryLimitBytes === null || t.memoryLimitBytes === undefined ? null : Number(t.memoryLimitBytes),
    // Stage B: proxy binding presence only (never the URL itself)
    proxy: t.proxyUrlEncrypted ? { configured: true, hasUrl: true } : { configured: false, hasUrl: false },
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/**
 * Strictly-scoped rm of a device data dir (MD §10.2).
 * - resolves + checks the target stays inside redroidDataRoot (realpath —
 *   symlink escape impossible)
 * - refuses to touch anything that is not a directory
 */
export async function removeRedroidDataDir(dataDir, dataRoot) {
  const root = path.resolve(dataRoot ?? '/var/lib/water-army/redroid');
  const target = path.resolve(dataDir);
  if (target === root || !target.startsWith(root + path.sep)) {
    return { removed: false, error: `refusing to remove '${dataDir}' — outside redroid data root` };
  }
  try {
    const real = await fs.promises.realpath(target);
    const realRoot = await fs.promises.realpath(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      return { removed: false, error: 'refusing to remove — realpath escapes the redroid data root (symlink?)' };
    }
    const stat = await fs.promises.lstat(real);
    if (!stat.isDirectory()) return { removed: false, error: 'refusing to remove — not a directory' };
    await fs.promises.rm(real, { recursive: true, force: true });
    return { removed: true, error: null };
  } catch (err) {
    return { removed: false, error: String(err?.message ?? err).slice(0, 200) };
  }
}
