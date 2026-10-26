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
  PROXY_UNREACHABLE: 'PROXY_UNREACHABLE',            // gost container down or <device-net gateway>:<gostPort> not accepting TCP (definite)
  CANARY_FAIL: 'CANARY_FAIL',                        // canary ran, verification failed (content/status)
  CANARY_TIMEOUT: 'CANARY_TIMEOUT',                  // canary exceeded its timeout (forward/return data plane dead)
  CANARY_NOT_CONFIGURED: 'CANARY_NOT_CONFIGURED',    // no admin canary target → data plane unverifiable → can never be HEALTHY
  TUNNEL_CHECK_ERROR: 'TUNNEL_CHECK_ERROR',          // netcheck script itself failed (exec seam) — inconclusive
  DOCKER_UNAVAILABLE: 'DOCKER_UNAVAILABLE',          // daemon unreachable during a check — inconclusive
  TUNNEL_SETUP_FAILED: 'TUNNEL_SETUP_FAILED',        // in-device tunnel script stage/run failed (provision aborted) — R6: was referenced but undefined (netLastErrorCode silently dropped)
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
    // T102 (BR-Acceptance C3-S2a, 2026-10-22): EXACT table-100 token match.
    // The bare substring "table 100" also matched Docker per-net tables
    // (user-defined networks get per-net routing tables numbered 1000+; the
    // live C3-S2a capture showed "table 1002" in `ip route get` output with
    // the tunnel dead -> false effective=tunnel). Token semantics: "table
    // 100" must be followed by END-OF-LINE or whitespace, so 1000/1002/
    // 1003/... can never match. POSIX ERE (-E, ($|[[:space:]])): the live
    // captures (toybox) show the token mid-line followed by a space; the $ 
    // branch additionally pins the token-at-EOL shape (e.g. any formatter
    // that prints "table 100" as the last token / on its own line — grep is
    // line-based and never sees the line terminator, so a whitespace-only
    // guard would silently miss EOL). -E and [[:space:]] are supported by
    // toybox/busybox/GNU grep alike. The printf "\\n" normalizes an
    // unterminated final line ($() already stripped the captured trailing
    // newline; grep accepts either).
    'if printf "%s\\n" "$G" | grep -qE "table 100($|[[:space:]])"; then EFFECTIVE=tunnel; elif printf "%s" "$G" | grep -q "dev eth0"; then EFFECTIVE=direct; else EFFECTIVE=unknown; fi',
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
    // Keep nc's stdin OPEN (no EOF) while waiting for the response. toybox nc
    // (redroid's netcat) half-closes — sends FIN — the moment stdin hits EOF,
    // and a plain `printf | nc` pipe EOFs immediately: on a real tunnel that
    // FIN tears the proxy relay down before the echo response can return, so
    // the probe always reads an empty OUT and the canary can only ever PASS on
    // a directly-routable target by a sub-ms race — never on the tunnel path
    // it is supposed to validate (R8 live regression, 2026-10-21: printf|nc
    // empty vs stdin-held-open full sha+nonce PASS on the same tunnel).
    // FIFO seam: nc reads its request from a FIFO whose write end we hold on
    // fd 3 until nc exits — no EOF is ever seen, so no FIN is sent; the probe
    // takes the true RTT (tens of ms), not a TO-long sleep. `timeout TO+1`
    // backstops a stalled relay (RC>=124 → reason=timeout, unchanged).
    'TMPD=/data/local/tmp',
    'IN=$TMPD/wa_canary_in.$$',
    'OUTF=$TMPD/wa_canary_out.$$',
    'rm -f "$IN" "$OUTF"',
    'mkfifo "$IN" 2>/dev/null',
    'timeout $((TO + 1)) nc -w "$TO" "$HOST" "$PORT" < "$IN" > "$OUTF" 2>/dev/null &',
    'NCP=$!',
    'exec 3>"$IN"',
    'printf "POST /canary HTTP/1.1\\r\\nHost: canary\\r\\nX-Nonce: $NONCE\\r\\nContent-Type: application/octet-stream\\r\\nContent-Length: ${#BODY}\\r\\nConnection: close\\r\\n\\r\\n%s" "$BODY" >&3',
    'wait $NCP',
    'RC=$?',
    'exec 3>&-',
    'OUT=$(cat "$OUTF" 2>/dev/null)',
    'rm -f "$IN" "$OUTF"',
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

/** MD §6.2 per-check display vocabulary (one value set for API/worker/UI). */
export const NET_CHECK_VALUES = Object.freeze(['PASS', 'FAIL', 'UNKNOWN']);

// ---------------------------------------------------------------------------
// R4 (MD §6.2): the payload CONTRACT — the exact key set buildNetPayload
// emits. API (device view `proxy.network`), worker (redroid.get_device_status
// projection) and UI (netStateBadge) all read THESE keys; the tests pin the
// set here so drift on any boundary breaks the suite. MD mapping:
//   lastSuccessAt ≙ lastSuccessfulCheckAt (existing name kept).
// ---------------------------------------------------------------------------
export const NET_PAYLOAD_KEYS = Object.freeze([
  'state',
  'stateSince',
  'checkedAt',
  'lastSuccessAt',
  'consecutiveFailures',
  'recoveries',
  'manualIntervention',
  'canaryConfigured',
  'stale',
  'networkReady',
  'checks',
  'lastErrorCode',
  'nextRecoveryAt',
  'recoveryLock',
  'lastError',
  'lastCanary',
  // W3 (ADR-027): identity egress binding sub-payload (null while the W3
  // switch is OFF — byte-identical to today for existing consumers).
  'egress',
]);

/** The five MD §6.2 per-check keys (one vocabulary: PASS/FAIL/UNKNOWN). */
export const NET_CHECK_KEYS = Object.freeze(['binary', 'process', 'interface', 'routePolicy', 'tcpCanary']);

function checkBinary(v) {
  const s = String(v ?? '').toLowerCase();
  if (s === 'ready') return 'PASS';
  if (s === 'missing' || s === 'invalid' || s === 'error') return 'FAIL';
  return 'UNKNOWN'; // null/unknown = never checked (or pre-R1 row)
}

function checkEnum(v, passVals) {
  const s = String(v ?? '').toLowerCase();
  if (!s || s === 'unknown' || s === 'none') return 'UNKNOWN';
  if (passVals.includes(s)) return 'PASS';
  return 'FAIL'; // any definite non-passing value (dead/down/missing/broken...)
}

function checkCanary(v) {
  const s = String(v ?? '').toUpperCase();
  if (s === 'PASS') return 'PASS';
  if (s === 'FAIL' || s === 'ERROR') return 'FAIL';
  return 'UNKNOWN'; // SKIPPED (canary not configured) or missing — fail-closed:
                    // "not verified" is never displayed as a pass
}

/**
 * Derive the MD §6.2 `checks` breakdown from the persisted row. PURE +
 * total: any missing/malformed input degrades to UNKNOWN, never to PASS
 * (fail-closed display). The five keys are fixed — API, worker and UI all
 * read these (one calculation, one schema; docs/audits/r4-state-sources.md §2.1).
 * Zero secrets: values are the status vocabulary only.
 */
export function deriveNetChecks(row) {
  const r = row ?? {};
  let stored = r.netLastChecks ?? null;
  if (typeof stored === 'string') {
    try { stored = JSON.parse(stored); } catch { stored = null; }
  }
  const c = stored && typeof stored === 'object' ? stored : {};
  return {
    binary: checkBinary(r.binaryState ?? c.binary),
    process: checkEnum(c.process, ['alive']),
    interface: checkEnum(c.interface, ['up']),
    routePolicy: checkEnum(c.routePolicy, ['enforced']),
    tcpCanary: checkCanary(c.tcpCanary),
  };
}

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
export function buildNetPayload(row, { now = Date.now(), staleTtlMs = 60_000, canaryConfigured = false, egressGate = false, egressStaleTtlMs = 90_000 } = {}) {
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
    // MD §6.2 per-check breakdown (API/worker/UI — same five keys, same
    // PASS/FAIL/UNKNOWN vocabulary; derived, never free-text).
    checks: deriveNetChecks(r),
    // MD §6.2 flat last-error code (lastError keeps the richer {code,detail,at}).
    lastErrorCode: typeof r.netLastErrorCode === 'string' && r.netLastErrorCode !== '' ? r.netLastErrorCode : null,
    // R3→R4 interface gap: the persisted backoff anchor + recovery-lock
    // summary — the UI can show "next auto attempt at …" and the scheduler
    // can see single-flight state. Owner id is deliberately NOT exposed
    // (process-internal; until+held are the contract).
    nextRecoveryAt: r.netNextRecoveryAt ? new Date(r.netNextRecoveryAt).toISOString() : null,
    recoveryLock: r.netRecoveryLockOwner && r.netRecoveryLockUntil
      ? { held: new Date(r.netRecoveryLockUntil).getTime() > now, until: new Date(r.netRecoveryLockUntil).toISOString() }
      : null,
    lastError: r.netLastErrorCode
      ? { code: r.netLastErrorCode, detail: r.netLastErrorDetail || null, at: checkedAt !== null ? new Date(checkedAt).toISOString() : null }
      : null,
    lastCanary,
    // W3 (ADR-027): identity egress binding view. `null` while the W3 switch
    // is OFF (gate inactive — zero behaviour change). When ON, networkReady
    // below ALSO requires a FRESH VERIFIED egress state (fail-closed).
    egress: egressGate ? buildEgressPayload(r, { now, staleTtlMs: egressStaleTtlMs }) : null,
  };
  // W3 (ADR-027): the egress gate composes INTO the dispatch gate — one
  // number, one source (worker/UI read networkReady exactly as before).
  if (egressGate && !egressReady(r, { gateActive: true, now, staleTtlMs: egressStaleTtlMs })) {
    net.networkReady = false;
  }
  return net;
}

// ===========================================================================
// W3 (ADR-027, 2026-10-26) — identity-level PINNED EGRESS.
//
// The problem (boss-approved W1-W3 sequence): per-identity proxy binding
// exists (Stage B: template proxyUrlEncrypted + device override) but the
// ACTUAL EGRESS IP was never checked or watched. A proxy that silently dies
// or starts exiting from a different IP means the identity keeps operating
// as a "walking corpse" — the highest-risk detection scenario for the fleet.
//
// W3 = binding enforcement + detection:
//  - one pinned egress expectation PER IDENTITY (identity_egress_bindings):
//    an encrypted proxy URL (same AES-256-GCM codec as Stage B) + the
//    expected egress IP (DB-unique — two identities must never share an
//    exit IP).
//  - a device egress state machine (below). A device is dispatch-ready for
//    network work only when the net state is a fresh HEALTHY AND the egress
//    state is a fresh VERIFIED (the two axes are independent: tunnel alive
//    does NOT prove the exit IP is the identity's).
//  - boot-time verification (right after tunnel provisioning) + a runtime
//    drift watchdog (piggybacks the net watchdog tick; same poll interval,
//    same single-flight sweep).
//
// CREDENTIAL DISCIPLINE (structural, not conventional):
//  - The W3 code path NEVER decrypts a proxy URL. "Does this device have a
//    proxy?" is answered by `proxyUrlEncrypted != null` — presence, not
//    content. The egress probe only ever learns the observed EGRESS IP.
//  - identity_egress_bindings.proxy_url_encrypted is ciphertext at rest;
//    proxy_url_hash is a one-way sha256 (change detection only — preimage
//    resistant, exposing it leaks nothing actionable).
//  - probe output is one machine-readable line (ip + reasons only).
//  - The integration suite runs a CANARY credential through the whole flow
//    and asserts zero occurrences on every observable surface.
//
// NOT VERIFIED (NV4): all of this is hermetic (mock exec adapter). Real
// egress verification on real devices against the real internet is a
// separate, explicitly deferred step — see ADR-027 §8 (real-device matrix).
// ===========================================================================

// ---------------------------------------------------------------------------
// State model — six states, one meaning each (names are the contract).
// ---------------------------------------------------------------------------

export const EGRESS_STATES = Object.freeze([
  'UNCHECKED',   // bound + proxy present, but no verified probe has landed yet
  'VERIFIED',    // a probe observed EXACTLY the expected egress IP (fresh)
  'DRIFTED',     // a probe succeeded but observed a DIFFERENT exit IP —
                 // the identity is exiting somewhere it must not
  'UNREACHABLE', // the probe itself failed (timeout / exec error / echo
                 // endpoint down) — exit IP unknown = protection uncertain
  'NO_PROXY',    // explicit: the device has no egress proxy (device or
                 // template) — never naked by default, never dispatch-ready
  'UNBOUND',     // a proxy exists but there is no identity binding to pin
                 // an expected IP against (device unbound, or identity has
                 // no egress binding row)
]);

/**
 * Legal transition table (ADR-027 §3).
 *  - VERIFIED is reachable only from UNCHECKED/DRIFTED/UNREACHABLE and ONLY
 *    with match evidence (observedIp === expectedIp, fresh) — no blind
 *    VERIFIED (the egress twin of "no blind HEALTHY").
 *  - DRIFTED is reachable from any state that can probe (UNCHECKED/VERIFIED/
 *    UNREACHABLE) — a mismatch IS the detection event.
 *  - UNCHECKED is the universal RESET target (operator changed the binding
 *    or proxy → everything re-verifies from scratch).
 *  - NO_PROXY / UNBOUND are configuration states: they only leave via a
 *    reset to UNCHECKED (the config changed back).
 */
export const EGRESS_TRANSITIONS = Object.freeze({
  UNCHECKED: Object.freeze(['VERIFIED', 'DRIFTED', 'UNREACHABLE', 'NO_PROXY', 'UNBOUND', 'UNCHECKED']),
  VERIFIED: Object.freeze(['DRIFTED', 'UNREACHABLE', 'NO_PROXY', 'UNBOUND', 'UNCHECKED']),
  DRIFTED: Object.freeze(['VERIFIED', 'UNREACHABLE', 'NO_PROXY', 'UNBOUND', 'UNCHECKED']),
  UNREACHABLE: Object.freeze(['VERIFIED', 'DRIFTED', 'NO_PROXY', 'UNBOUND', 'UNCHECKED']),
  NO_PROXY: Object.freeze(['UNCHECKED']),
  UNBOUND: Object.freeze(['UNCHECKED']),
});

export class IllegalEgressTransition extends Error {
  constructor(from, to, why) {
    super(`illegal egress transition ${from} -> ${to}${why ? ` (${why})` : ''}`);
    this.name = 'IllegalEgressTransition';
    this.from = from;
    this.to = to;
  }
}

/** Pure: is `from -> to` a legal edge in the egress transition table? */
export function canEnterEgressState(from, to) {
  if (!EGRESS_STATES.includes(from)) return false;
  if (!EGRESS_STATES.includes(to)) return false;
  return EGRESS_TRANSITIONS[from].includes(to);
}

/**
 * Evidence required to ENTER VERIFIED: a probe that observed EXACTLY the
 * expected egress IP in THIS pass. Shape:
 *   { observedIp: <dotted-quad>, expectedIp: <dotted-quad>, at: <finite ms epoch> }
 * with observedIp === expectedIp (strict string equality — the canonical
 * dotted-quad form; no whitespace, no prefix tricks).
 */
export function isEgressMatchEvidence(ev) {
  return (
    Boolean(ev) &&
    typeof ev.observedIp === 'string' &&
    typeof ev.expectedIp === 'string' &&
    validateEgressIp(ev.observedIp).ok &&
    validateEgressIp(ev.expectedIp).ok &&
    ev.observedIp === ev.expectedIp &&
    Number.isFinite(ev.at)
  );
}

/**
 * Validate an egress transition. Throws IllegalEgressTransition on:
 *  - unknown state
 *  - edge not in the table (self-transitions are NOT events — rejected;
 *    callers should no-op instead of calling this)
 *  - to === 'VERIFIED' without fresh match evidence (the "no blind
 *    VERIFIED" invariant)
 */
export function assertEgressTransition(from, to, evidence = {}) {
  if (from === to) throw new IllegalEgressTransition(from, to, 'self-transition is not an event — no-op instead');
  if (!canEnterEgressState(from, to)) throw new IllegalEgressTransition(from, to, 'edge not in transition table');
  if (to === 'VERIFIED' && !isEgressMatchEvidence(evidence.match)) {
    throw new IllegalEgressTransition(from, to, 'VERIFIED requires fresh observed-IP === expected-IP match evidence');
  }
  return { from, to, ok: true };
}

// ---------------------------------------------------------------------------
// Egress IP validation — strict canonical dotted-quad (the expected IP is a
// contract value: ambiguity is a drift-detection killer, so NO leading
// zeros, NO CIDR, NO IPv6, NO whitespace — reject, never normalize).
// ---------------------------------------------------------------------------

export const EGRESS_IP_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * @param {unknown} ip
 * @returns {{ok: true, ip: string} | {ok: false, error: string}}
 */
export function validateEgressIp(ip) {
  if (typeof ip !== 'string') return { ok: false, error: 'expected egress IP must be a string' };
  const m = EGRESS_IP_RE.exec(ip);
  if (!m) return { ok: false, error: `expected egress IP must be canonical dotted-quad IPv4 (got ${JSON.stringify(ip.slice(0, 40))})` };
  for (let i = 1; i <= 4; i++) {
    const part = m[i];
    if (part.length > 1 && part.startsWith('0')) return { ok: false, error: `expected egress IP octet has a leading zero: '${part}'` };
    const n = Number(part);
    if (Number.isNaN(n) || n < 0 || n > 255) return { ok: false, error: `expected egress IP octet out of range: '${part}'` };
  }
  return { ok: true, ip };
}

// ---------------------------------------------------------------------------
// Machine-readable egress error codes (persisted in egress_last_error_code —
// never a proxy URL, never free text from the device beyond the reason vocab).
// ---------------------------------------------------------------------------

export const EGRESS_ERRORS = Object.freeze({
  PROBE_TIMEOUT: 'EGRESS_PROBE_TIMEOUT',          // in-device probe exceeded its timeout
  PROBE_FAILED: 'EGRESS_PROBE_FAILED',            // probe ran but could not be verified (no marker / bad IP / nonce mismatch / connect failed / exec error)
  IP_DRIFT: 'EGRESS_IP_DRIFT',                    // probe verified but the exit IP != the identity's expected IP
  ECHO_NOT_CONFIGURED: 'EGRESS_ECHO_NOT_CONFIGURED', // W3 ON but no admin IP-echo endpoint → unverifiable → can never be VERIFIED
  NO_PROXY: 'EGRESS_NO_PROXY',                    // no egress proxy (device or template) — explicit state
  UNBOUND: 'EGRESS_UNBOUND',                      // proxy present but no identity binding to pin against
});

// ---------------------------------------------------------------------------
// The in-device egress probe script (the W3 twin of the R3 canary).
//
// Protocol: GET /ip?nonce=<16-hex> against the admin-configured IP-echo
// endpoint THROUGH THE TUNNEL. A conforming endpoint answers
//   HTTP/1.1 200 + a body containing `probe=OK nonce=<n> client_ip=<ip>`.
// The nonce makes a cached/replayed answer useless (same replay argument as
// the canary); the status line check rejects proxies that answer 200 with
// an error page.
//
// Output (one line, machine-readable):
//   EGRESS=OK nonce=<n> ip=<dotted-quad>
//   EGRESS=FAIL nonce=<n> reason=<timeout|connect-failed|no-marker|bad-ip|nonce-mismatch|no-status>
//
// FIFO stdin pattern = the canary's (toybox nc half-closes on stdin EOF —
// the R8 lesson; a held-open fd 3 means no FIN before the answer returns).
// ---------------------------------------------------------------------------

export const T2S_EGRESS_MARKER = 'wa-egress-v1';
const EGRESS_HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,254}$/;
// The temp dir the probe stages its FIFO into (production = the Android
// device path /data/local/tmp). Test injection (hermetic host run) must stay
// a plain absolute path — no spaces, no shell metacharacters.
const EGRESS_TMPDIR_RE = /^\/[A-Za-z0-9._\/-]+$/; // leading slash: must be absolute

/** Fresh 16-hex probe nonce (replay protection; injectable in tests). */
export function generateEgressNonce() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Build the in-device egress probe script. PURE + injection-safe by
 * construction: host/port/timeout validated, interpolated as literals only
 * into a script body that contains no other interpolations.
 */
export function buildT2sEgressScript({ host, port, timeoutMs, nonce, tmpDir = '/data/local/tmp' }) {
  if (typeof host !== 'string' || !EGRESS_HOST_RE.test(host)) {
    throw new Error('egress echo host must be a plain hostname/IPv4 (no secrets, no spaces)');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('egress echo port must be an integer 1-65535');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) throw new Error('egress timeoutMs must be 1000..120000');
  if (typeof nonce !== 'string' || !/^[a-f0-9]{8,64}$/.test(nonce)) throw new Error('egress nonce must be 8..64 lowercase hex');
  if (typeof tmpDir !== 'string' || !EGRESS_TMPDIR_RE.test(tmpDir)) {
    throw new Error('egress tmpDir must be a plain absolute path (no spaces or shell metacharacters)');
  }
  const to = Math.max(1, Math.ceil(timeoutMs / 1000));
  return [
    `# ${T2S_EGRESS_MARKER}`,
    'set -u',
    `HOST=${host}`,
    `PORT=${port}`,
    `NONCE=${nonce}`,
    `TO=${to}`,
    `TMPD=${tmpDir}`,
    'IN=$TMPD/wa_egress_in.$$',
    'OUTF=$TMPD/wa_egress_out.$$',
    'rm -f "$IN" "$OUTF"',
    'mkfifo "$IN" 2>/dev/null',
    'timeout $((TO + 1)) nc -w "$TO" "$HOST" "$PORT" < "$IN" > "$OUTF" 2>/dev/null &',
    'NCP=$!',
    'exec 3>"$IN"',
    'printf "GET /ip?nonce=$NONCE HTTP/1.1\\r\\nHost: probe\\r\\nConnection: close\\r\\n\\r\\n" >&3',
    // Keep nc's stdin OPEN (no EOF) until nc exits — the R8 fix (see the
    // canary script above): toybox nc half-closes the instant stdin hits
    // EOF, the FIN tears the gost relay down before the echo response can
    // return, and the probe reads an empty OUT (live A/B on redroid
    // 2026-10-26, real-device campaign: FIFO-closed 3/3 empty vs
    // FIFO-held 3/3 full 200 + client_ip). Closing before `wait` made the
    // egress probe fail 100% on a live tunnel while the canary passed.
    'wait $NCP',
    'RC=$?',
    'exec 3>&-',
    'OUT=$(cat "$OUTF" 2>/dev/null)',
    'rm -f "$IN" "$OUTF"',
    'if [ "$RC" -ge 124 ]; then echo "EGRESS=FAIL nonce=$NONCE reason=timeout"; exit 1; fi',
    'if [ -z "$OUT" ]; then echo "EGRESS=FAIL nonce=$NONCE reason=connect-failed rc=$RC"; exit 1; fi',
    'case "$OUT" in *"HTTP/1.1 200"*) ;; *) echo "EGRESS=FAIL nonce=$NONCE reason=no-status"; exit 1 ;; esac',
    'IP=$(printf "%s" "$OUT" | grep -o "client_ip=[0-9.]*" | head -n1 | cut -d= -f2)',
    'if [ -z "$IP" ]; then echo "EGRESS=FAIL nonce=$NONCE reason=no-marker"; exit 1; fi',
    'case "$IP" in *.*.*.*) ;; *) echo "EGRESS=FAIL nonce=$NONCE reason=bad-ip"; exit 1 ;; esac',
    'case "$OUT" in *"nonce=$NONCE"*) ;; *) echo "EGRESS=FAIL nonce=$NONCE reason=nonce-mismatch"; exit 1 ;; esac',
    'echo "EGRESS=OK nonce=$NONCE ip=$IP"',
    'exit 0',
  ].join('\n');
}

/**
 * Parse the EGRESS= line.
 *   OK   → { result:'OK',   nonce, ip }
 *   FAIL → { result:'FAIL', nonce, reason }
 *   none → { result:'ERROR', reason:'no-marker' }  (exec seam failure class)
 */
export function parseEgressOutput(stdout) {
  const s = String(stdout ?? '');
  let m = s.match(/EGRESS=OK nonce=([a-f0-9]{8,64}) ip=([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/);
  if (m) return { result: 'OK', nonce: m[1], ip: m[2] };
  m = s.match(/EGRESS=FAIL nonce=([a-f0-9]{8,64}) reason=([a-z-]+)/);
  if (m) return { result: 'FAIL', nonce: m[1], reason: m[2] };
  return { result: 'ERROR', reason: 'no-marker' };
}

/**
 * Classify a parsed probe against the identity's expected egress IP.
 *   OK   + ip === expected → { verdict:'MATCH',      observedIp, code:null }
 *   OK   + ip != expected  → { verdict:'DRIFT',      observedIp, code:EGRESS_IP_DRIFT }
 *   FAIL/ERROR             → { verdict:'PROBE_FAIL', observedIp:null,
 *                              code: timeout? PROBE_TIMEOUT : PROBE_FAILED }
 * PURE — no state, no effects. The decision (state + intervention) is
 * computeEgressDecision's job.
 */
export function classifyEgressProbe(parsed, expectedIp) {
  if (parsed?.result === 'OK' && validateEgressIp(parsed.ip).ok) {
    if (parsed.ip === expectedIp) return { verdict: 'MATCH', observedIp: parsed.ip, expectedIp: null, code: null };
    return { verdict: 'DRIFT', observedIp: parsed.ip, expectedIp: typeof expectedIp === 'string' ? expectedIp : null, code: EGRESS_ERRORS.IP_DRIFT };
  }
  const reason = parsed?.reason ?? 'no-marker';
  return {
    verdict: 'PROBE_FAIL',
    observedIp: null,
    expectedIp: typeof expectedIp === 'string' ? expectedIp : null,
    code: reason === 'timeout' ? EGRESS_ERRORS.PROBE_TIMEOUT : EGRESS_ERRORS.PROBE_FAILED,
  };
}

/**
 * The pure decision surface (ADR-027 §4). Inputs: the device's current
 * egress state + the probe classification + the persisted consecutive-failure
 * counter + the configured threshold. Output: the target state, the new
 * counter, and (possibly) an intervention event to raise.
 *
 * Semantics (fail-closed, explicit):
 *  - MATCH      → VERIFIED, counter reset to 0, never an event.
 *  - DRIFT      → DRIFTED (immediate — a wrong exit IP is the worst case),
 *                 event ONLY on the transition INTO DRIFTED (an open
 *                 episode already exists while it persists; the shared
 *                 writer dedupes anyway).
 *  - PROBE_FAIL → UNREACHABLE (immediate — unknown exit = not usable),
 *                 counter incremented; the event fires EXACTLY once, on the
 *                 tick the counter crosses the threshold (noise control:
 *                 a dead echo endpoint must not spam an intervention per
 *                 tick; a fresh episode still opens within
 *                 threshold × poll-interval).
 */
export function computeEgressDecision({ state, probe, consecutiveFailures = 0, failThreshold = 2 }) {
  const cur = EGRESS_STATES.includes(state) ? state : 'UNCHECKED';
  const cf = Number.isInteger(consecutiveFailures) && consecutiveFailures > 0 ? consecutiveFailures : 0;
  const threshold = Math.max(1, Number.isInteger(failThreshold) ? failThreshold : 2);
  if (probe?.verdict === 'MATCH') {
    return { target: 'VERIFIED', consecutiveFailures: 0, event: null };
  }
  if (probe?.verdict === 'DRIFT') {
    return {
      target: 'DRIFTED',
      consecutiveFailures: cf,
      event: cur === 'DRIFTED'
        ? null
        : { kind: 'drift', severity: 'critical', observedIp: probe.observedIp, expectedIp: probe.expectedIp ?? null, code: probe.code ?? null },
    };
  }
  // PROBE_FAIL (or unknown verdict — fail-closed: treat as failure)
  const next = cf + 1;
  return {
    target: 'UNREACHABLE',
    consecutiveFailures: next,
    event: next === threshold
      ? { kind: 'unreachable', severity: 'high', observedIp: null, expectedIp: probe?.expectedIp ?? null, code: probe?.code ?? null, consecutiveFailures: next }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Readiness / staleness — the dispatch gate inputs (pure).
// ---------------------------------------------------------------------------

/**
 * A VERIFIED egress goes STALE when its last verified match is older than
 * staleTtlMs — a dead watchdog must never let a stale VERIFIED stand (MD §5.5
 * stale rule, egress twin). Non-VERIFIED states have no freshness concept
 * (they are never ready, period).
 */
export function egressStale(state, lastMatchAtMs, checkedAtMs, now, staleTtlMs) {
  if (state !== 'VERIFIED') return false;
  const anchor = lastMatchAtMs ?? checkedAtMs;
  if (anchor === null || anchor === undefined || !Number.isFinite(anchor)) return true; // never matched = not fresh
  return now - anchor > staleTtlMs;
}

/**
 * Is the device's egress axis dispatch-ready?
 *  - gateActive=false (W3 switch OFF) → ALWAYS true (today's behaviour).
 *  - gateActive=true → ONLY a FRESH VERIFIED passes (fail-closed).
 */
export function egressReady(row, { gateActive = false, now = Date.now(), staleTtlMs = 90_000 } = {}) {
  if (!gateActive) return true;
  const r = row ?? {};
  const state = EGRESS_STATES.includes(r.egressState) ? r.egressState : 'UNCHECKED';
  const lastMatchAtMs = r.egressLastMatchAt ? new Date(r.egressLastMatchAt).getTime() : null;
  const checkedAtMs = r.egressCheckedAt ? new Date(r.egressCheckedAt).getTime() : null;
  return state === 'VERIFIED' && !egressStale(state, lastMatchAtMs, checkedAtMs, now, staleTtlMs);
}

/**
 * The `network.egress` sub-payload (the MD §6.2-style flat contract for the
 * egress axis). Values are the state vocabulary + IPs + timestamps only —
 * zero secrets by construction (no URL, no credential, ever).
 */
export const EGRESS_PAYLOAD_KEYS = Object.freeze([
  'state',
  'stale',
  'ready',
  'checkedAt',
  'lastMatchAt',
  'consecutiveFailures',
  'lastErrorCode',
  'lastObservedIp',
]);

export function buildEgressPayload(row, { now = Date.now(), staleTtlMs = 90_000 } = {}) {
  const r = row ?? {};
  const state = EGRESS_STATES.includes(r.egressState) ? r.egressState : 'UNCHECKED';
  const lastMatchAtMs = r.egressLastMatchAt ? new Date(r.egressLastMatchAt).getTime() : null;
  const checkedAtMs = r.egressCheckedAt ? new Date(r.egressCheckedAt).getTime() : null;
  return {
    state,
    stale: egressStale(state, lastMatchAtMs, checkedAtMs, now, staleTtlMs),
    ready: state === 'VERIFIED' && !egressStale(state, lastMatchAtMs, checkedAtMs, now, staleTtlMs),
    checkedAt: checkedAtMs !== null ? new Date(checkedAtMs).toISOString() : null,
    lastMatchAt: lastMatchAtMs !== null ? new Date(lastMatchAtMs).toISOString() : null,
    consecutiveFailures: Number.isInteger(r.egressConsecutiveFailures) && r.egressConsecutiveFailures > 0 ? r.egressConsecutiveFailures : 0,
    lastErrorCode: typeof r.egressLastErrorCode === 'string' && r.egressLastErrorCode !== '' ? r.egressLastErrorCode : null,
    // The OBSERVED exit IP (egress metadata, not a credential) — diagnostic
    // gold for drift: "exiting from X instead of Y".
    lastObservedIp: typeof r.egressLastObservedIp === 'string' && r.egressLastObservedIp !== '' ? r.egressLastObservedIp : null,
  };
}

// ---------------------------------------------------------------------------
// Expectation resolution — "what SHOULD this device exit from?" (pure).
// Deliberately operates on PRESENCE flags only: `hasDeviceProxy` /
// `hasTemplateProxy` are booleans derived from `proxyUrlEncrypted != null`
// — the W3 path never decrypts (see the header discipline note).
// ---------------------------------------------------------------------------

/**
 * @param {object} p
 * @param {boolean} p.hasDeviceProxy    device-level proxy override present
 * @param {boolean} p.hasTemplateProxy  template proxy present (fallback)
 * @param {boolean} p.hasIdentityId     device is bound to an identity
 * @param {object|null} p.binding       the identity's egress binding row
 *                                      ({ expectedEgressIp } or null)
 * @returns {{status:'BOUND', expectedIp:string} | {status:'NO_PROXY'} | {status:'UNBOUND', reason:string}}
 */
export function resolveEgressExpectation({ hasDeviceProxy, hasTemplateProxy, hasIdentityId, binding }) {
  if (!hasDeviceProxy && !hasTemplateProxy) return { status: 'NO_PROXY' };
  if (!hasIdentityId) return { status: 'UNBOUND', reason: 'device-not-bound-to-identity' };
  if (!binding || typeof binding.expectedEgressIp !== 'string' || !EGRESS_IP_RE.test(binding.expectedEgressIp)) {
    return { status: 'UNBOUND', reason: 'identity-egress-binding-missing' };
  }
  return { status: 'BOUND', expectedIp: binding.expectedEgressIp };
}

// ---------------------------------------------------------------------------
// Defensive masking (defense-in-depth): the W3 paths never hold a proxy URL,
// but anything that COULD receive one funnels through this. Never throws,
// never echoes a credential fragment.
// ---------------------------------------------------------------------------

export function maskProxyUrl(url) {
  try {
    const s = String(url ?? '');
    if (!s) return '';
    const m = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:([^@/]*@)?)?([^/]+)(.*)$/);
    if (!m) return s.replace(/[^:@\/ ]+:[^@\/ ]+@/, '***:***@');
    const scheme = m[1];
    const hadCred = Boolean(m[2]);
    const host = m[3];
    const rest = m[4] ?? '';
    return `${scheme}://${hadCred ? '***:***@' : ''}${host}${rest}`;
  } catch {
    return '<unparseable-url-redacted>';
  }
}
