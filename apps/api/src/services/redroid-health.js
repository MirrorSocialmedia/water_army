/**
 * Redroid network health — state machine, canary + netcheck scripts,
 * recovery policy (R3 / repair MD Phase 3, fail-closed watchdog core).
 *
 * DESIGN (see docs/audits/fail-closed-validation.md + R2 tcp-transport report):
 *
 *  - The network-protection state is a FIRST-CLASS state machine. The only
 *    code path into HEALTHY is: VERIFYING + a FRESH bidirectional TCP
 *    canary PASS carried as transition evidence. No background task can
 *    "blind set" HEALTHY — the machine rejects the transition without
 *    evidence (structurally, not by convention).
 *  - The canary is a TCP bidirectional payload probe (nonce + request-body
 *    sha256 verified on BOTH sides). DNS/UDP success NEVER counts toward
 *    HEALTHY (R2: during the gVisor stall the UDP ASSOCIATE DNS canary
 *    passes while the TCP forward path is 100% dead).
 *  - Fail-closed: any definite control-plane loss (process dead, TUN gone,
 *    route/rule shadowed or effective route = direct = fail-open detected,
 *    container gone, proxy listener unreachable) drops the device to
 *    BLOCKED immediately; inconclusive checks and canary failures follow
 *    the single-fail → DEGRADED, consecutive → BLOCKED rule (MD §5.5).
 *  - Recovery is bounded: one recovery lock per device (DB lease),
 *    exponential backoff, max retries, and a special rule for the gVisor
 *    stall signature (process alive + canary dead — R2 L6h: re-provision
 *    does not restore the data plane → do NOT spin: one auto re-provision,
 *    then FAILED + manual-intervention flag).
 *
 *  - ZERO SECRETS: nothing in this module may carry a proxy URL or
 *    credentials. The canary target is an admin-configured host:port
 *    (not a secret); probe output is machine-readable status lines only.
 *
 * All functions here are PURE (no docker, no db, no timers) so the whole
 * decision surface is hermetically unit-testable. The service layer
 * (redroid-service.js) owns the side effects.
 */
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// State model (MD §5.2) — semantics are fixed; names are the MD's names.
// ---------------------------------------------------------------------------

export const NET_STATES = Object.freeze([
  'STOPPED',   // deliberately stopped (or no proxy); claims NO network protection
  'STARTING',  // provisioning in progress (boot / binary check / tunnel script)
  'VERIFYING', // tunnel process up; data-plane verification pending/in flight
  'HEALTHY',   // process + interface + route protection + fresh canary PASS
  'DEGRADED',  // single/transient failure; must NOT be reported as healthy
  'BLOCKED',   // protection uncertain or data-plane failed; network work halted
  'FAILED',    // start or recovery failed beyond budget; manual intervention
]);

/**
 * Legal transition table (MD §5.2). Enforced in code (assertNetTransition):
 * an illegal transition is REJECTED (throws) — callers log + audit the
 * rejection and DO NOT persist.
 *
 *  - HEALTHY is reachable ONLY from VERIFYING, and only with a fresh
 *    canary-pass evidence object (see assertNetTransition).
 *  - STOPPED is reachable from any state (operator stop / delete / recovery
 *    abort) — the one universal sink.
 *  - FAILED is a manual-intervention sink: only a human retry (STARTING) or
 *    a stop (STOPPED) leaves it.
 */
export const NET_TRANSITIONS = Object.freeze({
  STOPPED: Object.freeze(['STARTING', 'FAILED', 'STOPPED']),
  STARTING: Object.freeze(['VERIFYING', 'FAILED', 'STOPPED']),
  VERIFYING: Object.freeze(['HEALTHY', 'DEGRADED', 'BLOCKED', 'FAILED', 'STOPPED']),
  HEALTHY: Object.freeze(['DEGRADED', 'BLOCKED', 'VERIFYING', 'FAILED', 'STOPPED']),
  DEGRADED: Object.freeze(['VERIFYING', 'BLOCKED', 'STARTING', 'FAILED', 'STOPPED']),
  BLOCKED: Object.freeze(['STARTING', 'VERIFYING', 'FAILED', 'STOPPED']),
  FAILED: Object.freeze(['STARTING', 'STOPPED']),
});

export class IllegalNetTransition extends Error {
  constructor(from, to, why) {
    super(`illegal network health transition ${from} -> ${to}${why ? ` (${why})` : ''}`);
    this.name = 'IllegalNetTransition';
    this.from = from;
    this.to = to;
  }
}

/** Pure: is `from -> to` a legal edge in the transition table? */
export function canEnterNetState(from, to) {
  if (!NET_STATES.includes(from)) return false;
  if (!NET_STATES.includes(to)) return false;
  return NET_TRANSITIONS[from].includes(to);
}

/**
 * Evidence required to ENTER HEALTHY: a fresh bidirectional TCP canary PASS
 * result produced by THIS verification pass (not a stale one). Shape:
 *   { result: 'PASS', nonce: string(8..64 hex), at: <finite ms epoch> }
 */
export function isCanaryPassEvidence(ev) {
  return (
    Boolean(ev) &&
    ev.result === 'PASS' &&
    typeof ev.nonce === 'string' &&
    /^[a-f0-9]{8,64}$/.test(ev.nonce) &&
    Number.isFinite(ev.at)
  );
}

/**
 * Validate a transition. Throws IllegalNetTransition on:
 *  - unknown state
 *  - edge not in the table (self-transitions are NOT events — rejected;
 *    callers should no-op instead of calling this)
 *  - to === 'HEALTHY' without fresh canary-pass evidence (the "no blind
 *    HEALTHY" invariant — MD §5.2/§6.3)
 */
export function assertNetTransition(from, to, evidence = {}) {
  if (from === to) throw new IllegalNetTransition(from, to, 'self-transition is not an event — no-op instead');
  if (!canEnterNetState(from, to)) throw new IllegalNetTransition(from, to, 'edge not in transition table');
  if (to === 'HEALTHY' && !isCanaryPassEvidence(evidence.canary)) {
    throw new IllegalNetTransition(from, to, 'HEALTHY requires a fresh bidirectional TCP canary PASS as evidence');
  }
  return { from, to, ok: true };
}

/**
 * Legacy `proxyState` projection (kept for pre-R4 consumers; R4 Phase 4
 * retires it). Conservative on purpose: a DEGRADED/BLOCKED device is NEVER
 * projected as 'running' (MD §5.2 "不得報為 healthy" / "不得繼續報 HEALTHY").
 *  - STOPPED → 'stopped'  · STARTING/VERIFYING → 'provisioning'
 *  - HEALTHY → 'running'  · DEGRADED → 'stopped'
 *  - BLOCKED/FAILED → 'error'
 * Devices without a proxy keep legacy 'off' (the mapping is not applied).
 */
export const NET_TO_LEGACY_PROXY = Object.freeze({
  STOPPED: 'stopped',
  STARTING: 'provisioning',
  VERIFYING: 'provisioning',
  HEALTHY: 'running',
  DEGRADED: 'stopped',
  BLOCKED: 'error',
  FAILED: 'error',
});

// ---------------------------------------------------------------------------
// Machine-readable error codes (MD §8.3 style; extends the existing
// BINARY_* / REDROID_* codes — one system, no duplicate semantics).
// ---------------------------------------------------------------------------

export const NET_ERRORS = Object.freeze({
  TUNNEL_PROCESS_DEAD: 'TUNNEL_PROCESS_DEAD',        // tun2socks process gone (definite)
  TUNNEL_IFACE_MISSING: 'TUNNEL_IFACE_MISSING',      // tun0 disappeared (definite)
  TUNNEL_IFACE_DOWN: 'TUNNEL_IFACE_DOWN',            // tun0 present but not UP (definite)
  TUNNEL_ROUTE_UNCERTAIN: 'TUNNEL_ROUTE_UNCERTAIN',  // table-100 default or rule 5000 gone, or effective route = direct (fail-open detected) (definite)
  CONTAINER_NOT_RUNNING: 'CONTAINER_NOT_RUNNING',    // device container exited/missing (definite)
  PROXY_UNREACHABLE: 'PROXY_UNREACHABLE',            // gost container down or 172.17.0.1:<gostPort> not accepting TCP (definite)
  CANARY_FAIL: 'CANARY_FAIL',                        // canary ran, verification failed (content/status)
  CANARY_TIMEOUT: 'CANARY_TIMEOUT',                  // canary exceeded its timeout (forward/return data plane dead)
  CANARY_NOT_CONFIGURED: 'CANARY_NOT_CONFIGURED',    // no admin canary target → data plane unverifiable → can never be HEALTHY
  TUNNEL_CHECK_ERROR: 'TUNNEL_CHECK_ERROR',          // netcheck script itself failed (exec seam) — inconclusive
  DOCKER_UNAVAILABLE: 'DOCKER_UNAVAILABLE',          // daemon unreachable during a check — inconclusive
  TUNNEL_START_TIMEOUT: 'TUNNEL_START_TIMEOUT',      // stuck in STARTING beyond boot timeout
  RECOVERY_EXHAUSTED: 'RECOVERY_EXHAUSTED',          // recovery budget spent → FAILED + manual intervention
  STALL_REPROVISION_USELESS: 'STALL_REPROVISION_USELESS', // gVisor stall signature: re-provision did not restore data plane (R2 L6h)
});

// ---------------------------------------------------------------------------
// Control-plane check: in-device netcheck script (READ-ONLY, no pkill —
// safe to run inline through the exec seam; the ps pattern uses the bracket
// trick so the runner's own cmdline never matches).
// ---------------------------------------------------------------------------

export const T2S_NETCHECK_MARKER = 'wa-netcheck-v1';
export const T2S_CANARY_MARKER = 'wa-canary-v1';

/**
 * Build the in-device control-plane check script. Machine-readable output —
 * one NETCHECK= line:
 *   NETCHECK process=alive|dead pid=<n|none> iface=up|down|missing
 *          route=present|missing rule=present|missing effective=tunnel|direct|unknown
 */
export function buildT2sNetcheckScript() {
  return [
    `# ${T2S_NETCHECK_MARKER}`,
    'set -u',
    'PSL=$(ps -ef | grep [t]un2socks | head -n1)',
    'if [ -n "$PSL" ]; then PROCESS=alive; PID=$(printf "%s" "$PSL" | awk \'{print $2}\'); else PROCESS=dead; PID=none; fi',
    'L=$(ip link show tun0 2>/dev/null)',
    'if [ -z "$L" ]; then IFACE=missing; elif printf "%s" "$L" | grep -q ",UP,"; then IFACE=up; else IFACE=down; fi',
    'R=$(ip route show table 100 2>/dev/null)',
    'if printf "%s" "$R" | grep -q "default via 10.8.0.2"; then ROUTE=present; else ROUTE=missing; fi',
    'RU=$(ip rule show 2>/dev/null)',
    'if printf "%s" "$RU" | grep -q "5000:"; then RULE=present; else RULE=missing; fi',
    'G=$(ip route get 8.8.8.8 2>/dev/null)',
    'if printf "%s" "$G" | grep -q "table 100"; then EFFECTIVE=tunnel; elif printf "%s" "$G" | grep -q "dev eth0"; then EFFECTIVE=direct; else EFFECTIVE=unknown; fi',
    'echo "NETCHECK process=$PROCESS pid=$PID iface=$IFACE route=$ROUTE rule=$RULE effective=$EFFECTIVE"',
  ].join('\n');
}

/**
 * Parse the NETCHECK= line. Returns
 *   { ok:false, code } on missing/malformed line, else
 *   { ok:true, process, pid, iface, route, rule, effective }
 */
export function parseNetcheckOutput(stdout) {
  const s = String(stdout ?? '');
  const m = s.match(/NETCHECK process=(alive|dead) pid=(\S+) iface=(up|down|missing) route=(present|missing) rule=(present|missing) effective=(tunnel|direct|unknown)/);
  if (!m) return { ok: false, code: NET_ERRORS.TUNNEL_CHECK_ERROR };
  return { ok: true, process: m[1], pid: m[2], iface: m[3], route: m[4], rule: m[5], effective: m[6] };
}

/**
 * Classify a parsed netcheck result:
 *   { severity:'definite', code }  — protection is DEFINITIVELY lost
 *   { severity:'inconclusive' }    — the check itself was inconclusive
 *   null                           — control plane looks intact
 *
 * "definite" includes the fail-open detection (effective=direct): the
 * R2/R0 evidence shows that when tun0/t2s die, table 100's default route
 * vanishes and Android silently falls back to the physical eth0 default —
 * the device "works" but has NO egress isolation. That is a security event,
 * not a transient blip.
 */
export function classifyNetcheck(parsed) {
  if (!parsed?.ok) return { severity: 'inconclusive', code: parsed?.code ?? NET_ERRORS.TUNNEL_CHECK_ERROR };
  if (parsed.process === 'dead') return { severity: 'definite', code: NET_ERRORS.TUNNEL_PROCESS_DEAD };
  if (parsed.iface === 'missing') return { severity: 'definite', code: NET_ERRORS.TUNNEL_IFACE_MISSING };
  if (parsed.iface === 'down') return { severity: 'definite', code: NET_ERRORS.TUNNEL_IFACE_DOWN };
  if (parsed.route === 'missing' || parsed.rule === 'missing' || parsed.effective === 'direct') {
    return { severity: 'definite', code: NET_ERRORS.TUNNEL_ROUTE_UNCERTAIN };
  }
  if (parsed.effective === 'unknown') return { severity: 'inconclusive', code: NET_ERRORS.TUNNEL_CHECK_ERROR };
  return null;
}

// ---------------------------------------------------------------------------
// Data-plane canary: TCP bidirectional payload probe (MD §5.3).
//
// Protocol (admin-configured target; reference implementation =
// tests/mocks/mock-echo.js, which is part of the repo):
//   1. device generates nonce (16 hex) + 1024-byte random ASCII body
//   2. device computes reqsha = sha256(body)
//   3. POST /canary with X-Nonce + body through the tunnel
//   4. target answers 200 + `req_sha256=<sha>` (and echoes nonce=)
//   5. device verifies nonce AND reqsha in the response
//      forward direction  : server saw EXACTLY our body (sha match)
//      return direction   : the verified response reached the device
//   The two verifications are independent — a middle box that drops,
//   corrupts, or fabricates in EITHER direction fails the probe.
//
// Output (one line, machine-readable):
//   CANARY=PASS nonce=<n> ms=<latency> reqsha=<sha>
//   CANARY=FAIL nonce=<n> reason=<no-status|sha-mismatch|nonce-mismatch|no-marker|timeout|connect-failed|exec-error>
// ---------------------------------------------------------------------------

const CANARY_HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,254}$/;

/** Fresh 16-hex canary nonce (injectable for deterministic tests). */
export function generateCanaryNonce() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Build the in-device canary probe script. PURE + injection-safe by
 * construction: host/port/timeout/nonce are validated and interpolated
 * only as literals into a single-quoted-free script body (the script is
 * executed through the same staged-file seam as the tunnel scripts, so the
 * runner's cmdline never contains it).
 */
export function buildT2sCanaryScript({ host, port, timeoutMs, nonce }) {
  if (typeof host !== 'string' || !CANARY_HOST_RE.test(host)) {
    throw new Error('canary host must be a plain hostname/IPv4 (no secrets, no spaces)');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('canary port must be an integer 1-65535');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) throw new Error('canary timeoutMs must be 1000..120000');
  if (typeof nonce !== 'string' || !/^[a-f0-9]{8,64}$/.test(nonce)) throw new Error('canary nonce must be 8..64 lowercase hex');
  const to = Math.max(1, Math.ceil(timeoutMs / 1000));
  return [
    `# ${T2S_CANARY_MARKER}`,
    'set -u',
    `HOST=${host}`,
    `PORT=${port}`,
    `NONCE=${nonce}`,
    `TO=${to}`,
    // 512 random bytes from /dev/urandom, hex-encoded (1024 ASCII chars) —
    // the probe payload. Random per run: a replayed/cached response cannot
    // match a fresh nonce+sha.
    'BODY=$(head -c 512 /dev/urandom | od -An -v -tx1 | tr -d " \\n")',
    'REQSHA=$(printf "%s" "$BODY" | sha256sum | cut -d" " -f1)',
    'START=$(date +%s)',
    'OUT=$(printf "POST /canary HTTP/1.1\\r\\nHost: canary\\r\\nX-Nonce: $NONCE\\r\\nContent-Type: application/octet-stream\\r\\nContent-Length: ${#BODY}\\r\\nConnection: close\\r\\n\\r\\n%s" "$BODY" | timeout "$TO" nc -w "$TO" "$HOST" "$PORT" 2>/dev/null)',
    'RC=$?',
    'END=$(date +%s)',
    'MS=$(( (END-START) * 1000 ))',
    'if [ "$RC" -ge 124 ]; then echo "CANARY=FAIL nonce=$NONCE reason=timeout"; exit 1; fi',
    'if [ -z "$OUT" ]; then echo "CANARY=FAIL nonce=$NONCE reason=connect-failed rc=$RC"; exit 1; fi',
    'case "$OUT" in *"req_sha256="*) ;; *) echo "CANARY=FAIL nonce=$NONCE reason=no-marker"; exit 1 ;; esac',
    'case "$OUT" in *"nonce=$NONCE"*) ;; *) echo "CANARY=FAIL nonce=$NONCE reason=nonce-mismatch"; exit 1 ;; esac',
    'case "$OUT" in *"req_sha256=$REQSHA"*) ;; *) echo "CANARY=FAIL nonce=$NONCE reason=sha-mismatch"; exit 1 ;; esac',
    'case "$OUT" in *"HTTP/1.1 200"*) ;; *) echo "CANARY=FAIL nonce=$NONCE reason=no-status"; exit 1 ;; esac',
    'echo "CANARY=PASS nonce=$NONCE ms=$MS reqsha=$REQSHA"',
    'exit 0',
  ].join('\n');
}

/**
 * Parse the CANARY= line.
 *   PASS → { result:'PASS', nonce, ms, reqsha }
 *   FAIL → { result:'FAIL', nonce, reason }
 *   none → { result:'ERROR', reason:'no-marker' }  (exec seam failure class)
 */
export function parseCanaryOutput(stdout) {
  const s = String(stdout ?? '');
  let m = s.match(/CANARY=PASS nonce=([a-f0-9]{8,64}) ms=(\d+)(?: reqsha=([a-f0-9]{64}))?/);
  if (m) return { result: 'PASS', nonce: m[1], ms: Number(m[2]), reqsha: m[3] ?? null };
  m = s.match(/CANARY=FAIL nonce=([a-f0-9]{8,64}) reason=(\S+)/);
  if (m) return { result: 'FAIL', nonce: m[1], reason: m[2] };
  return { result: 'ERROR', reason: 'no-marker' };
}

/**
 * Map a parsed canary result to { code, pass }:
 *   PASS → { pass:true, code:null }
 *   FAIL reason=timeout → CANARY_TIMEOUT
 *   FAIL other / ERROR → CANARY_FAIL
 */
export function classifyCanary(parsed) {
  if (parsed?.result === 'PASS') return { pass: true, code: null };
  const reason = parsed?.reason ?? 'no-marker';
  return { pass: false, code: reason === 'timeout' ? NET_ERRORS.CANARY_TIMEOUT : NET_ERRORS.CANARY_FAIL, reason };
}

// ---------------------------------------------------------------------------
// Recovery policy (pure decision surface — the service owns the effects).
// ---------------------------------------------------------------------------

export const RECOVERY_DEFAULTS = Object.freeze({
  backoffBaseMs: 15_000,    // delay before recovery attempt #1
  backoffMaxMs: 600_000,    // cap (delay before attempts #n: base*2^(n-1))
  maxRetries: 3,            // total auto-recovery attempts per failure episode
  stallMaxRetries: 1,       // gVisor stall signature: re-provision is (R2 L6h)
                            // useless — ONE auto attempt, then FAILED+manual
  lockLeaseMs: 900_000,     // recovery lock lease (crash-safe expiry)
});

/** Exponential backoff: attempt n (1-based) waits base*2^(n-1), capped. */
export function backoffMs(attempt, cfg = RECOVERY_DEFAULTS) {
  const base = Math.max(1, cfg.backoffBaseMs ?? RECOVERY_DEFAULTS.backoffBaseMs);
  const cap = Math.max(base, cfg.backoffMaxMs ?? RECOVERY_DEFAULTS.backoffMaxMs);
  const n = Math.max(1, Math.floor(attempt));
  // guard 2**n overflow: cap the exponent (2^32 ms is already absurd)
  const shifted = n - 1 >= 32 ? cap : base * 2 ** (n - 1);
  return Math.min(shifted, cap);
}

/**
 * Failure signature for the stall rule (R2 L6h): the gVisor stall =
 * control plane INTACT (process alive, tun0 up, routes correct) + canary
 * dead. Re-provisioning has been live-proven NOT to fix it, so the auto
 * budget for this signature is tiny (default 1) and then we mark manual
 * intervention instead of spinning.
 */
export function isStallSignature(lastErrorCode) {
  return lastErrorCode === NET_ERRORS.CANARY_FAIL || lastErrorCode === NET_ERRORS.CANARY_TIMEOUT;
}

/**
 * Decide the recovery action for a device whose health just failed.
 * Inputs: { netState, recoveries, nextRecoveryAt (persisted backoff anchor,
 *           ms|0), lockHeldBy, lastErrorCode, now } + cfg.
 * Returns (in priority order):
 *   { action:'manual-fail', code }   → transition to FAILED + manual flag
 *   { action:'locked' }              → another holder owns the lock: WAIT (no spin)
 *   { action:'wait', retryAt }       → the persisted backoff anchor is in the future
 *   { action:'recover', attempt }    → proceed with recovery attempt #attempt
 *   { action:'skip' }                → state is not recoverable (STOPPED/FAILED/HEALTHY)
 *
 * Backoff semantics (R3): the anchor is PERSISTED (netNextRecoveryAt) and
 * armed by the watchdog when it observes a failing verify. EVERY attempt —
 * including #1 — must wait for the anchor. This makes the failure state
 * (DEGRADED/BLOCKED) stable and observable (no racing STARTING right after
 * a tick) and crash-safe (the schedule survives an API restart). Manual
 * retry bypasses the anchor by resetting the episode (anchor cleared).
 */
export function computeRecoveryDecision({ netState, recoveries = 0, nextRecoveryAt = 0, lockHeldBy = null, lastErrorCode = null, now = 0 }, cfg = RECOVERY_DEFAULTS) {
  if (!['DEGRADED', 'BLOCKED'].includes(netState)) return { action: 'skip' };
  const maxRetries = Math.max(1, cfg.maxRetries ?? RECOVERY_DEFAULTS.maxRetries);
  const stallMax = Math.max(0, cfg.stallMaxRetries ?? RECOVERY_DEFAULTS.stallMaxRetries);
  // Budget exhausted (stall signature gets the smaller budget).
  if (recoveries >= maxRetries) {
    return { action: 'manual-fail', code: NET_ERRORS.RECOVERY_EXHAUSTED };
  }
  if (isStallSignature(lastErrorCode) && recoveries >= stallMax) {
    return { action: 'manual-fail', code: NET_ERRORS.STALL_REPROVISION_USELESS };
  }
  if (lockHeldBy) return { action: 'locked' };
  const attempt = recoveries + 1;
  // Stable anchor: wait until the persisted schedule time (0 = not armed).
  if (nextRecoveryAt > now) return { action: 'wait', retryAt: nextRecoveryAt };
  return { action: 'recover', attempt };
}

// ---------------------------------------------------------------------------
// View helpers (pure — the service feeds row fields in).
// ---------------------------------------------------------------------------

/**
 * Build the `proxy.network` payload (MD §6.2 shape, adapted to this repo's
 * flat style). STALE rule (MD §5.5): a HEALTHY whose last check is older
 * than staleTtlMs is reported stale + networkReady=false — a dead watchdog
 * must never let a stale HEALTHY stand.
 *
 * ZERO SECRETS by construction: this shape has no proxyUrl field, and the
 * only strings that come from the device are machine-readable status lines
 * (state codes, error codes, canary result/nonce).
 */
export function buildNetPayload(row, { now = Date.now(), staleTtlMs = 60_000, canaryConfigured = false } = {}) {
  const r = row ?? {};
  const state = NET_STATES.includes(r?.netState) ? r.netState : 'STOPPED';
  const checkedAt = r.netCheckedAt ? new Date(r.netCheckedAt).getTime() : null;
  const lastSuccessAt = r.netLastSuccessAt ? new Date(r.netLastSuccessAt).getTime() : null;
  const consecutiveFailures = Number.isInteger(r.netConsecutiveFailures) ? r.netConsecutiveFailures : 0;
  const stale = state === 'HEALTHY' && (checkedAt === null || now - checkedAt > staleTtlMs);
  let lastCanary = null;
  if (r.netLastCanary) {
    const p = parseCanaryOutput(String(r.netLastCanary));
    lastCanary =
      p.result === 'PASS'
        ? { result: 'PASS', latencyMs: p.ms ?? null, nonce: p.nonce }
        : { result: p.result === 'FAIL' ? 'FAIL' : 'ERROR', reason: p.reason };
  }
  const net = {
    state,
    stateSince: r.netStateSince ? new Date(r.netStateSince).toISOString() : null,
    checkedAt: checkedAt !== null ? new Date(checkedAt).toISOString() : null,
    lastSuccessAt: lastSuccessAt !== null ? new Date(lastSuccessAt).toISOString() : null,
    consecutiveFailures,
    recoveries: Number.isInteger(r.netRecoveries) ? r.netRecoveries : 0,
    manualIntervention: r.netManualIntervention === true,
    canaryConfigured,
    stale,
    // R4 consumer gate (task dispatch / UI badge): network work is allowed
    // for THIS device only when the authoritative state is a FRESH HEALTHY.
    networkReady: state === 'HEALTHY' && !stale && consecutiveFailures === 0,
    lastError: r.netLastErrorCode
      ? { code: r.netLastErrorCode, detail: r.netLastErrorDetail || null, at: checkedAt !== null ? new Date(checkedAt).toISOString() : null }
      : null,
    lastCanary,
  };
  return net;
}
