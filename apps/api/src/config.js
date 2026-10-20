/**
 * API runtime configuration — env-driven with fail-fast validation.
 * Reads a local .env (repo root / CWD) for local dev; in compose the values
 * arrive as real process env (compose interpolation) and .env is ignored.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

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
    redroidTunnelBootTimeoutMs: optInt(e, 'REDROID_TUNNEL_BOOT_TIMEOUT_MS', 600_000),
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
