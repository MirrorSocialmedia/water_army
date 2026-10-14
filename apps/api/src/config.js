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
    defaultTimezone: e.DEFAULT_TIMEZONE ?? 'Asia/Taipei',
    taskDefaultTimeoutMs,
    taskMaxTimeoutMs,
    taskDefaultAttempts,
    taskMaxConcurrency,
    logLevel: e.LOG_LEVEL ?? (nodeEnv === 'production' ? 'info' : 'debug'),
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
