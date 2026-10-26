/**
 * API runtime configuration — env-driven with fail-fast validation.
 * Reads a local .env (repo root / CWD) for local dev; in compose the values
 * arrive as real process env (compose interpolation) and .env is ignored.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { IDENTITY_DATA_ROOT_DEFAULT, parsePortRange } from '@water-army/shared';

function loadDotEnv(file) {
  const target = path.resolve(file);
  if (!fs.existsSync(target)) return;
  const text = fs.readFileSync(target, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function requireInt(env, name, fallback) {
  const raw = env[name] ?? fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`config error: ${name} must be a positive integer (got ${String(raw)})`);
  }
  return value;
}

/** Optional positive int (P2 docker knobs) — absent → fallback, garbage → hard fail. */
function optInt(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`config error: ${name} must be a positive integer (got ${String(raw)})`);
  }
  return value;
}

/**
 * BR-B3: parse the env image-allowlist fallback. JSON array (strings or
 * entry objects) or comma-separated image refs. Absent → [] (the AppSetting
 * is then authoritative; NEITHER present → fail closed at create time).
 * Garbage → hard fail at boot (a typo must not silently open the door).
 */
function parseContainerImageAllowlist(raw) {
  if (raw === undefined || raw === '') return [];
  let list;
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      list = JSON.parse(trimmed);
    } catch {
      throw new Error('config error: BATCH_CONTAINER_ALLOWED_IMAGES must be a JSON array or comma-separated image refs');
    }
  } else {
    list = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(list)) throw new Error('config error: BATCH_CONTAINER_ALLOWED_IMAGES must be an array');
  for (const entry of list) {
    if (typeof entry === 'string') {
      if (entry.length === 0 || entry.length > 512) throw new Error('config error: BATCH_CONTAINER_ALLOWED_IMAGES entry must be a 1..512 char image ref');
    } else if (entry && typeof entry === 'object' && typeof entry.image === 'string') {
      if (entry.image.length === 0 || entry.image.length > 512) throw new Error('config error: BATCH_CONTAINER_ALLOWED_IMAGES entry.image must be a 1..512 char image ref');
    } else {
      throw new Error('config error: BATCH_CONTAINER_ALLOWED_IMAGES entries must be image-ref strings or { image, ... } objects');
    }
  }
  return list;
}

function requireSecret(env, name) {
  const value = env[name];
  if (!value || value.length < 32 || value.startsWith('REPLACE_WITH')) {
    throw new Error(
      `config error: ${name} must be set to a real secret (>=32 chars, not a placeholder). ` +
        'Generate one with: openssl rand -hex 32',
    );
  }
  return value;
}

/**
 * @param {object} [env] environment map (injectable for tests)
 * @param {object} [opts]
 * @param {string} [opts.envFile] path to .env (default: CWD/.env)
 */
export function loadConfig(env = process.env, opts = {}) {
  if (opts.envFile !== false) loadDotEnv(opts.envFile ?? '.env');
  const e = env === process.env ? process.env : { ...process.env, ...env };

  const nodeEnv = e.NODE_ENV ?? 'production';
  const host = e.APP_HOST ?? '127.0.0.1';
  const port = requireInt(e, 'APP_PORT', 3000);
  const publicUrl = e.APP_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
  const sessionTtlHours = Number(e.SESSION_TTL_HOURS ?? 12);

  const taskDefaultTimeoutMs = requireInt(e, 'TASK_DEFAULT_TIMEOUT_MS', 120_000);
  const taskMaxTimeoutMs = requireInt(e, 'TASK_MAX_TIMEOUT_MS', 900_000);
  const taskDefaultAttempts = requireInt(e, 'TASK_DEFAULT_ATTEMPTS', 3);
  const taskMaxConcurrency = requireInt(e, 'TASK_MAX_CONCURRENCY', 4);
  // P3 task SSE knobs (MD §8 SSE: heartbeat + 並行 cap).
  const taskSseMaxConcurrent = optInt(e, 'TASK_SSE_MAX_CONCURRENT', 10);
  const taskSsePollMs = optInt(e, 'TASK_SSE_POLL_MS', 1_000);
  const taskSseHeartbeatMs = optInt(e, 'TASK_SSE_HEARTBEAT_MS', 25_000);
  // P4 schedule knobs (MD §12.2: 過高頻率 400 — configurable minimum interval).
  const scheduleMinIntervalMs = optInt(e, 'SCHEDULE_MIN_INTERVAL_MS', 10_000);
  const scheduleMaxIntervalMs = optInt(e, 'SCHEDULE_MAX_INTERVAL_MS', 7 * 24 * 3_600_000);
  // P5 redroid knobs (工單 P5 / 施工 MD §10).
  const redroidAdbRangeStart = optInt(e, 'REDROID_ADB_RANGE_START', 15000);
  const redroidAdbRangeEnd = optInt(e, 'REDROID_ADB_RANGE_END', 15999);
  if (redroidAdbRangeStart > redroidAdbRangeEnd) {
    throw new Error('config error: REDROID_ADB_RANGE_START must be <= REDROID_ADB_RANGE_END');
  }
  let redroidAdapter = (e.REDROID_ADAPTER ?? 'real').toLowerCase();
  if (!['real', 'mock'].includes(redroidAdapter)) {
    throw new Error("config error: REDROID_ADAPTER must be 'real' or 'mock'");
  }
  if (nodeEnv === 'production' && redroidAdapter === 'mock') {
    redroidAdapter = 'real'; // the mock must never run a production host
  }

  // W1 (ADR-025): identity fingerprint ro.* injection — OFF by default. Until
  // the V3 real-device matrix passes, flipping this ON is an explicit operator
  // opt-in (WA_REDROID_RO_OVERRIDES_ENABLED=true) — devices booted with it are
  // experimental by definition.
  const redroidRoOverridesEnabled = ['1', 'true', 'yes', 'on'].includes(String(e.WA_REDROID_RO_OVERRIDES_ENABLED ?? 'false').toLowerCase());

  const databaseUrl = e.DATABASE_URL ?? '';
  if (!databaseUrl.startsWith('postgresql://')) {
    throw new Error('config error: DATABASE_URL must be a postgresql:// connection string');
  }
  const redisUrl = e.REDIS_URL ?? '';
  if (!redisUrl.startsWith('redis://') && !redisUrl.startsWith('rediss://')) {
    throw new Error('config error: REDIS_URL must be a redis:// or rediss:// connection string');
  }
  if (!Number.isFinite(sessionTtlHours) || sessionTtlHours <= 0) {
    throw new Error('config error: SESSION_TTL_HOURS must be > 0');
  }
  if (taskMaxTimeoutMs < taskDefaultTimeoutMs) {
    throw new Error('config error: TASK_MAX_TIMEOUT_MS must be >= TASK_DEFAULT_TIMEOUT_MS');
  }

  const config = {
    nodeEnv,
    host,
    port,
    publicUrl,
    sessionSecret: requireSecret(e, 'SESSION_SECRET'),
    encryptionKey: requireSecret(e, 'APP_ENCRYPTION_KEY'),
    sessionTtlMs: Math.round(sessionTtlHours * 3600 * 1000),
    cookieSecure: e.SESSION_COOKIE_SECURE === 'true',
    databaseUrl,
    redisUrl,
    // Empty string = Docker checks disabled (local dev without a daemon).
    dockerSocketPath: e.DOCKER_SOCKET_PATH ?? '/var/run/docker.sock',
    // P2 docker service knobs (施工 MD §9.3/§9.4)
    dockerLogTailDefault: optInt(e, 'DOCKER_LOG_TAIL_DEFAULT', 500),
    dockerLogTailMax: optInt(e, 'DOCKER_LOG_TAIL_MAX', 5000),
    dockerLogByteLimit: optInt(e, 'DOCKER_LOG_BYTE_LIMIT', 1_048_576),
    dockerStatsTimeoutMs: optInt(e, 'DOCKER_STATS_TIMEOUT_MS', 3000),
    dockerStopTimeoutSec: optInt(e, 'DOCKER_STOP_TIMEOUT_SEC', 10),
    dockerSseMaxConcurrent: optInt(e, 'DOCKER_SSE_MAX_CONCURRENT', 10),
    dockerSseHeartbeatMs: optInt(e, 'DOCKER_SSE_HEARTBEAT_MS', 25000),
    dockerIdempotencyTtlMs: optInt(e, 'DOCKER_IDEMPOTENCY_TTL_MS', 600_000),
    defaultTimezone: e.DEFAULT_TIMEZONE ?? 'Asia/Taipei',
    taskDefaultTimeoutMs,
    taskMaxTimeoutMs,
    taskDefaultAttempts,
    taskMaxConcurrency,
    taskSseMaxConcurrent,
    taskSsePollMs,
    taskSseHeartbeatMs,
    scheduleMinIntervalMs,
    scheduleMaxIntervalMs,
    // P5 redroid (工單: 127.0.0.1-only ADB, pinned images, 診斷白名單).
    redroidAdapter,
    redroidRoOverridesEnabled,
    redroidDataRoot: e.REDROID_DATA_ROOT ?? '/var/lib/water-army/redroid',
    redroidAdbRangeStart,
    redroidAdbRangeEnd,
    redroidAdbBinary: e.REDROID_ADB_BINARY ?? '/usr/bin/adb',
    redroidAdbTimeoutMs: optInt(e, 'REDROID_ADB_TIMEOUT_MS', 20_000),
    redroidAdbMaxOutput: optInt(e, 'REDROID_ADB_MAX_OUTPUT', 262_144),
    redroidLogcatTailDefault: optInt(e, 'REDROID_LOGCAT_TAIL_DEFAULT', 200),
    redroidLogcatTailMax: optInt(e, 'REDROID_LOGCAT_TAIL_MAX', 5000),
    redroidPreflightTimeoutMs: optInt(e, 'REDROID_PREFLIGHT_TIMEOUT_MS', 5000),
    redroidPreflightMaxOutput: optInt(e, 'REDROID_PREFLIGHT_MAX_OUTPUT', 65_536),
    redroidIdempotencyTtlMs: optInt(e, 'REDROID_IDEMPOTENCY_TTL_MS', 600_000),
    // R3 network health / fail-closed watchdog (repair MD Phase 3).
    // pollMs=0 disables the interval (tests drive __tickOnceHealth explicitly).
    redroidHealthPollMs: optInt(e, 'REDROID_HEALTH_POLL_MS', 30_000),
    redroidHealthStaleMs: optInt(e, 'REDROID_HEALTH_STALE_MS', 60_000),
    redroidNetcheckTimeoutMs: optInt(e, 'REDROID_NETCHECK_TIMEOUT_MS', 20_000),
    // Boot wait for provisionTunnel + the watchdog stuck-starting guard share
    // this knob (R3 live-found 2026-10-20: fresh-/data first boot on a loaded
    // host took >14 min — the unmapped 600s default killed healthy boots). A
    // slow-but-healthy boot must not be mistaken for a stuck one.
    // R6 calibration (R5 live evidence): a REAL fresh boot took ~24min on the
    // live host (2026-10-20, 23:17:24 → 23:41 adb 'device' + boot_completed=1;
    // documented range 14–20min + margin), and a RECREATE boots ≈ cold boot
    // (R5 finding). The old 600s default hard-failed healthy-but-slow boots
    // with REDROID_TUNNEL_BOOT_TIMEOUT; the R4 live host already ran
    // REDROID_TUNNEL_BOOT_TIMEOUT_MS=2400000 via env, so 2400s becomes the
    // honest default. Fast hosts may lower it via env.
    redroidTunnelBootTimeoutMs: optInt(e, 'REDROID_TUNNEL_BOOT_TIMEOUT_MS', 2_400_000),
    // provisionTunnel boot-wait poll interval (adb getprop get sys.boot_completed
    // between deadline checks). R7 (2026-10-21): same unmapped-knob defect R6
    // fixed for REDROID_TUNNEL_BOOT_TIMEOUT_MS — the service read
    // config.redroidTunnelPollMs with a `?? 5000` fallback but config.js never
    // mapped the env var, so the knob silently did not exist. Wired here with
    // the same 5000 default (behavior-identical); operators may lower it on
    // fast hosts or raise it on loaded hosts.
    redroidTunnelPollMs: optInt(e, 'REDROID_TUNNEL_POLL_MS', 5_000),
    // Data-plane canary: TCP bidirectional payload probe target. UNCONFIGURED
    // (empty host) = the data plane is unverifiable = the device can never be
    // (stay) HEALTHY (fail-closed — MD §5.3/§5.5).
    redroidCanaryHost: e.REDROID_CANARY_HOST ?? '',
    redroidCanaryPort: optInt(e, 'REDROID_CANARY_PORT', 0),
    redroidCanaryTimeoutMs: optInt(e, 'REDROID_CANARY_TIMEOUT_MS', 10_000),
    redroidCanaryFailThreshold: optInt(e, 'REDROID_CANARY_FAIL_THRESHOLD', 2),
    // Recovery policy: backoff + max retries (MD §5.4.4/§5.5).
    redroidRecoveryBackoffBaseMs: optInt(e, 'REDROID_RECOVERY_BACKOFF_BASE_MS', 15_000),
    redroidRecoveryBackoffMaxMs: optInt(e, 'REDROID_RECOVERY_BACKOFF_MAX_MS', 600_000),
    redroidRecoveryMaxRetries: optInt(e, 'REDROID_RECOVERY_MAX_RETRIES', 3),
    redroidRecoveryLockLeaseMs: optInt(e, 'REDROID_RECOVERY_LOCK_LEASE_MS', 900_000),
    // BR-B3 batch container lifecycle (MD Phase 3 — lane A).
    // Data root: B1 identity dataPath rows are written under this root, so
    // the default must stay aligned with IDENTITY_DATA_ROOT_DEFAULT.
    batchContainerDataRoot: e.BATCH_CONTAINER_DATA_ROOT ?? IDENTITY_DATA_ROOT_DEFAULT,
    // env fallback for the admin image allowlist (AppSetting wins). JSON
    // array of "image" strings or { image, privileged?, reason?, memoryBytes?,
    // nanoCpus?, cmd? } objects; garbage = hard fail (fail closed, MD §12).
    batchContainerAllowedImages: parseContainerImageAllowlist(e.BATCH_CONTAINER_ALLOWED_IMAGES),
    // ADB host-port pool (127.0.0.1 only; MD §5.2 bounded range).
    batchAdbHostPortRange: (() => {
      const raw = e.BATCH_ADB_HOST_PORT_RANGE ?? '16370-16419';
      if (!parsePortRange(raw)) {
        throw new Error(`config error: BATCH_ADB_HOST_PORT_RANGE must be 'start-end' (got '${raw}')`);
      }
      return raw;
    })(),
    batchPortLeaseTtlMs: optInt(e, 'BATCH_PORT_LEASE_TTL_MS', 1_800_000),
    batchContainerStopTimeoutSec: optInt(e, 'BATCH_CONTAINER_STOP_TIMEOUT_SEC', 10),
    // container name prefix (docker-name-safe; br-b3- is the smoke prefix).
    batchContainerNamePrefix: (() => {
      const p = e.BATCH_CONTAINER_NAME_PREFIX ?? 'wa-batch-';
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(p)) {
        throw new Error(`config error: BATCH_CONTAINER_NAME_PREFIX must be docker-name-safe (got '${p}')`);
      }
      return p;
    })(),
    // boot health = ADB handshake wait (MD §8.2: app layer, not docker state).
    batchContainerHealthTimeoutMs: optInt(e, 'BATCH_CONTAINER_HEALTH_TIMEOUT_MS', 60_000),
    batchContainerHealthPollMs: optInt(e, 'BATCH_CONTAINER_HEALTH_POLL_MS', 1_000),
    batchContainerHealthProbeTimeoutMs: optInt(e, 'BATCH_CONTAINER_HEALTH_PROBE_TIMEOUT_MS', 3_000),
    // MC P1 (Mobile Console MD §4.1): global concurrent device stream cap.
    // Raw env passed through UNRESOLVED on purpose: the service resolves it at
    // boot (default 5, hard cap 5, invalid → fail-safe 5 + explicit config
    // error log — MD §4.1 「非法值拒絕啟動或安全降至 5，並產生明確設定錯誤，
    // 不可默默變成無上限」). optInt would hard-crash, which MD does not require.
    maxConcurrentDeviceStreamsRaw: e.MAX_CONCURRENT_DEVICE_STREAMS ?? '',
    // MC P1 stream ticket (MD §11.8): HMAC-SHA256 secret. Empty = ticketing
    // unavailable → stream endpoints fail closed with 503
    // STREAM_TICKET_UNAVAILABLE (never fall back to a guessable secret).
    streamTicketSecret: e.STREAM_TICKET_SECRET ?? '',
    // MC P1 stream lease TTL (server time; the client must heartbeat before
    // expiry or the lease is reaped).
    streamLeaseTtlMs: optInt(e, 'STREAM_LEASE_TTL_MS', 30_000),
    // MC P1 expiry reconcile sweep interval (0 = disabled; tests drive
    // reconcileExpired explicitly).
    streamReconcileIntervalMs: (() => {
      const raw = e.STREAM_RECONCILE_INTERVAL_MS;
      if (raw === undefined || raw === '') return 15_000;
      const v = Number(raw);
      if (!Number.isInteger(v) || v < 0) {
        throw new Error(`config error: STREAM_RECONCILE_INTERVAL_MS must be an integer >= 0 (got ${String(raw)})`);
      }
      return v;
    })(),
    // MC P2 (console streaming) — sidecar process management (ADR-019 §19.12).
    // Token: >=32 chars required when console streaming is enabled; empty =
    // sidecar disabled + WS endpoints fail closed with 503
    // STREAM_SIDECAR_UNAVAILABLE (never start a sidecar without a token).
    streamSidecarToken: e.STREAM_SIDECAR_TOKEN ?? '',
    streamSidecarPort: optInt(e, 'SIDECAR_PORT', 16550),
    streamSidecarMaxSessions: optInt(e, 'SIDECAR_MAX_SESSIONS', 5),
    streamZeroFrameMs: optInt(e, 'SIDECAR_ZERO_FRAME_MS', 10_000),
    // VIDEO_SOURCE (MD §4.2 degraded path + ADR-019 §19.9 + ADR-020 — boss
    // decision 2026-10-23 12:40): DEFAULT = 'screencap' (the stable, PoC-
    // verified path on the pinned redroid image). 'scrcpy' forces H.264; 'auto'
    // keeps the try-H.264-then-fallback-to-screencap behaviour for the future
    // auto-upgrade phase (ADR-020 req 5 — only after H.264 passes single +
    // five-stream acceptance with an explicit health check). Backward
    // compatible: both documented values (scrcpy|screencap) keep working
    // (ADR-020 req 7).
    streamVideoSource: (() => {
      const v = (e.STREAM_VIDEO_SOURCE ?? 'screencap').toLowerCase();
      if (!['auto', 'scrcpy', 'screencap'].includes(v)) {
        throw new Error(`config error: STREAM_VIDEO_SOURCE must be auto|scrcpy|screencap (got '${v}')`);
      }
      return v;
    })(),
    streamQuality: (() => {
      const v = (e.STREAM_QUALITY ?? 'medium').toLowerCase();
      if (!['low', 'medium', 'high'].includes(v)) {
        throw new Error(`config error: STREAM_QUALITY must be low|medium|high (got '${v}')`);
      }
      return v;
    })(),
    // scrcpy-server jar (pinned sha256 — ADR-019 §19.10). Path is env so the
    // jar itself never has to live in the repo.
    scrcpyJar: e.SCRCPY_JAR ?? '/tmp/scrcpy-server-v5.0.1',
    scrcpyJarSha256: (e.SCRCPY_JAR_SHA256 ?? '').toLowerCase(),
    scrcpyJarRemote: e.SCRCPY_JAR_REMOTE ?? '/data/local/tmp/scrcpy-server.jar',
    // P3 service identity: worker→API token (empty = service auth disabled).
    serviceToken: e.WORKER_API_TOKEN ?? '',
    // P3 provider default when POST /api/tasks/runs omits body.provider.
    aiProvider: e.AI_PROVIDER ?? '',
    logLevel: e.LOG_LEVEL ?? (nodeEnv === 'production' ? 'info' : 'debug'),
    // The shipped topology puts the api behind the web reverse proxy, so the
    // real client IP arrives in X-Forwarded-For (the web proxy overwrites it
    // with the socket peer — a client cannot spoof it). Trusting that header
    // is what makes per-client login rate limiting work; without it every
    // request appears to come from the proxy and one flooder locks out all
    // users. Set TRUST_PROXY=false only if the api is exposed directly.
    trustProxy: e.TRUST_PROXY === 'false' ? false : true,
    // Provider baseUrl SSRF guard also resolves DNS names and range-checks the
    // result. Set false only in environments without outbound DNS (the literal
    // IP / reserved-name checks still apply regardless).
    providerUrlDnsCheck: e.PROVIDER_URL_DNS_CHECK === 'false' ? false : true,
  };

  const origins = new Set();
  try {
    origins.add(new URL(config.publicUrl).origin);
  } catch {
    /* invalid APP_PUBLIC_URL — fall through to loopback entries */
  }
  origins.add(`http://127.0.0.1:${port}`);
  origins.add(`http://localhost:${port}`);
  config.allowedOrigins = [...origins];

  return config;
}
