/**
 * ram-gate.js — product-grade host-RAM admission gate (RAM-G1, boss MD 2026-10-22).
 *
 * WHAT IT IS
 *   A fail-closed admission gate for RAM-heavy redroid device boots. Every
 *   boot (single device create/start/restart AND batch container start) must
 *   be ADMITTED here before any side effect (data dir, DB row, docker
 *   create). The API is the single boot authority (the worker never holds
 *   the docker socket), so all admission converges here; concurrency is
 *   enforced atomically in one Redis Lua script.
 *
 * MODEL (locked, G1)
 *   A lease = "this entity is committed to one PER_BOOT_BUDGET of host RAM".
 *   A lease is taken at admission and lives until the entity stops:
 *     - kind 'device': entity = device NAME. Held from create/start until
 *       stop/delete (the RAM is held for the device's whole lifetime —
 *       A10 measured the fleet settled footprint, not a boot spike).
 *     - kind 'run'   : entity = task-run ID (batch containers). Held from
 *       start until stop/remove.
 *   Because every RAM-consuming entity holds exactly one lease, the atomic
 *   `live leases + 1 <= maxParallel` check IS the MD's
 *   `(running + in_progress + 1) <= MAX_PARALLEL` condition — running
 *   devices and in-progress boots are the same counted population.
 *
 * ADMISSION (MD formula, exact):
 *   projected = current − (in_progress + 1) × budget − reservations
 *   admit  ⇔  (live + 1) ≤ maxParallel
 *        AND projected ≥ postBootTargetMiB
 *        AND current   ≥ hardFloorMiB
 *   where `current` = fresh /proc/meminfo MemAvailable (MiB, timestamped),
 *   `in_progress` = live leases (each charged the FULL budget — deliberately
 *   conservative: a boot that has already consumed part of its budget is
 *   charged the rest again), and `reservations` = extra committed RAM beyond
 *   per-boot budgets (default 0; reserved for future pre-commits).
 *
 * CONSTANTS (defaults — configurable via AppSetting 'ram_gate.config' and
 * RAM_GATE_* env overrides; env > AppSetting > constant):
 *   MAX_PARALLEL        = 10       (hard fleet cap)
 *   HARD_FLOOR          = 16384 MiB (MemAvailable never goes below)
 *   POST_BOOT_TARGET    = 18432 MiB (initial conservative post-boot budget
 *                                    target — NOT a universal optimum; tune
 *                                    from real measurements)
 *   PER_BOOT_BUDGET     = 1200 MiB  (from A10 real-device data: settled
 *                                    ≈934 MiB/device, 5→10 incremental
 *                                    ≈1093 MiB → conservative integer above
 *                                    both; full-fleet average observed
 *                                    ≈1408 MiB — see docs/ram-gate.md §3)
 *   METRICS_MAX_AGE     = 30 s      (stale sample = DENY)
 *   LEASE_TTL           = 24 h      (backstop only — the reconciler +
 *                                    lifecycle releases are the normal path)
 *
 * FAIL-CLOSED (MD G1): metrics missing / unreadable / stale, reservation
 * store unavailable, or any computation error → DENY. The gate never
 * defaults to allow. When disabled explicitly (RAM_GATE_ENABLED=false —
 * dev/test only) admits bypass and are labelled GATE_DISABLED.
 *
 * NEVER (safety invariants, MD G1):
 *   - no automatic deletion of any Identity dataDir
 *   - no killing of any other container
 *   - no restart/stop/reconfigure of SGLang
 *   - on memory pressure: STOP NEW BOOTS; pending work stays queued
 *
 * Zero npm dependencies (same house style as lease-service.js).
 */
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------- constants

export const RAM_GATE_DEFAULTS = Object.freeze({
  enabled: true,
  maxParallel: 10,
  hardFloorMiB: 16384,
  postBootTargetMiB: 18432,
  perBootBudgetMiB: 1200,
  metricsMaxAgeMs: 30_000,
  leaseTtlMs: 86_400_000,
});

/** env override names (RAM_GATE_*). */
export const RAM_GATE_ENV = Object.freeze({
  enabled: 'RAM_GATE_ENABLED',
  maxParallel: 'RAM_GATE_MAX_PARALLEL',
  hardFloorMiB: 'RAM_GATE_HARD_FLOOR_MIB',
  postBootTargetMiB: 'RAM_GATE_POST_BOOT_TARGET_MIB',
  perBootBudgetMiB: 'RAM_GATE_PER_BOOT_BUDGET_MIB',
  metricsMaxAgeMs: 'RAM_GATE_METRICS_MAX_AGE_MS',
  leaseTtlMs: 'RAM_GATE_LEASE_TTL_MS',
});

/** AppSetting key holding the operator config (partial object, valueJson). */
export const RAM_GATE_APP_SETTING_KEY = 'ram_gate.config';

/** Stable decision reasons (UI + tests key on these). */
export const RAM_GATE_REASON = Object.freeze({
  ADMITTED: 'ADMITTED',
  GATE_DISABLED: 'GATE_DISABLED',
  MAX_PARALLEL: 'MAX_PARALLEL',
  BELOW_HARD_FLOOR: 'BELOW_HARD_FLOOR',
  PROJECTED_BELOW_TARGET: 'PROJECTED_BELOW_TARGET',
  METRICS_STALE: 'METRICS_STALE',
  METRICS_UNAVAILABLE: 'METRICS_UNAVAILABLE',
  STORE_UNAVAILABLE: 'STORE_UNAVAILABLE',
  CONFIG_INVALID: 'CONFIG_INVALID',
  INVALID_INPUT: 'INVALID_INPUT',
});

const VALID_REASONS = new Set(Object.values(RAM_GATE_REASON));

// ---------------------------------------------------------------- config

const INT_RANGE = {
  maxParallel: [1, 128],
  hardFloorMiB: [1024, 4194304],
  postBootTargetMiB: [0, 4194304],
  perBootBudgetMiB: [128, 65536],
  metricsMaxAgeMs: [1_000, 600_000],
  leaseTtlMs: [60_000, 86_400_000 * 7],
};

function parseTriState(raw) {
  const s = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return null;
}

/**
 * Merge constants + operator patch + env into a validated config.
 * @returns {{ok:boolean, config?:object, errors?:string[]}}
 * (ok=false with CONFIG_INVALID is fail-closed by the caller)
 */
export function resolveRamGateConfig(patch = null, env = process.env) {
  const cfg = { ...RAM_GATE_DEFAULTS };
  const errors = [];

  // operator patch (AppSetting / PUT body)
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in cfg)) {
        errors.push(`unknown config key '${k}'`);
        continue;
      }
      if (k === 'enabled') {
        if (typeof v !== 'boolean') errors.push('enabled must be a boolean');
        else cfg.enabled = v;
      } else if (typeof v !== 'number' || !Number.isInteger(v)) {
        errors.push(`${k} must be an integer`);
      } else cfg[k] = v;
    }
  }

  // env overrides (highest priority)
  for (const [k, envKey] of Object.entries(RAM_GATE_ENV)) {
    const raw = env[envKey];
    if (raw === undefined || String(raw).trim() === '') continue;
    if (k === 'enabled') {
      const b = parseTriState(raw);
      if (b === null) errors.push(`${envKey} must be a boolean-ish value (got '${raw}')`);
      else cfg.enabled = b;
    } else {
      const n = Number(raw);
      if (!Number.isInteger(n)) errors.push(`${envKey} must be an integer (got '${raw}')`);
      else cfg[k] = n;
    }
  }

  // range validation
  for (const [k, [lo, hi]] of Object.entries(INT_RANGE)) {
    if (!Number.isInteger(cfg[k]) || cfg[k] < lo || cfg[k] > hi) {
      errors.push(`${k}=${cfg[k]} outside allowed range [${lo}, ${hi}]`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: cfg };
}

// ---------------------------------------------------------------- pure math

/**
 * The MD admission formula (exact, unit-testable without any store).
 *
 * @param {object} p
 * @param {number} p.currentMiB      fresh MemAvailable (MiB)
 * @param {number} p.liveLeases      live RAM leases held right now
 * @param {number} p.maxParallel     MAX_PARALLEL
 * @param {number} p.hardFloorMiB    HARD_FLOOR
 * @param {number} p.postBootTargetMiB POST_BOOT_TARGET
 * @param {number} p.perBootBudgetMiB PER_BOOT_BUDGET
 * @param {number} [p.reservationsMiB] extra committed RAM (default 0)
 */
export function computeAdmission({
  currentMiB,
  liveLeases,
  maxParallel,
  hardFloorMiB,
  postBootTargetMiB,
  perBootBudgetMiB,
  reservationsMiB = 0,
}) {
  const projectedMiB = Math.round(currentMiB - (liveLeases + 1) * perBootBudgetMiB - reservationsMiB);
  // reason precedence: the MOST BINDING constraint is reported.
  if (liveLeases + 1 > maxParallel) {
    return { admitted: false, reason: RAM_GATE_REASON.MAX_PARALLEL, projectedMiB };
  }
  if (currentMiB < hardFloorMiB) {
    return { admitted: false, reason: RAM_GATE_REASON.BELOW_HARD_FLOOR, projectedMiB };
  }
  if (projectedMiB < postBootTargetMiB) {
    return { admitted: false, reason: RAM_GATE_REASON.PROJECTED_BELOW_TARGET, projectedMiB };
  }
  return { admitted: true, reason: RAM_GATE_REASON.ADMITTED, projectedMiB };
}

// ---------------------------------------------------------------- Lua

/**
 * The atomic admission: prune dead leases, count, run the MD checks, and —
 * only if admitted — write the lease + set membership in ONE script. Two
 * concurrent admits cannot both see `live + 1 <= maxParallel` and both
 * commit: the script runs atomically on the redis server.
 *
 * Self-renewal rule: if the entity ALREADY holds a lease (retry of a failed
 * start), the count excludes its own lease — the admission is a renewal,
 * not a new commitment (a retry storm must not self-deadlock at the cap).
 * The projection still charges (others+1)×budget: this boot's RAM is
 * committed either way.
 *
 * KEYS[1] live set key, KEYS[2] new lease key
 * ARGV[1] ttl_ms, ARGV[2] max_parallel, ARGV[3] hard_floor_mib,
 *      ARGV[4] post_boot_target_mib, ARGV[5] per_boot_budget_mib,
 *      ARGV[6] current_mem_available_mib, ARGV[7] reservations_mib,
 *      ARGV[8] lease value (json)
 * → [decision(0/1), live_after, projected_mib, reason]
 */
export const ADMIT_LUA = `
local live = KEYS[1]
local newkey = KEYS[2]
local ttl_ms = tonumber(ARGV[1])
local max_parallel = tonumber(ARGV[2])
local hard_floor = tonumber(ARGV[3])
local target = tonumber(ARGV[4])
local budget = tonumber(ARGV[5])
local current = tonumber(ARGV[6])
local reservations = tonumber(ARGV[7])
local value = ARGV[8]

local own = redis.call('EXISTS', newkey) == 1
local n = redis.call('SCARD', live)
if n > 0 then
  local members = redis.call('SMEMBERS', live)
  local c = 0
  for _, m in ipairs(members) do
    if redis.call('EXISTS', m) == 1 then c = c + 1
    else redis.call('SREM', live, m) end
  end
  n = c
end
local others = n - (own and 1 or 0)

if others + 1 > max_parallel then
  return {0, n, current - (others + 1) * budget - reservations, 'MAX_PARALLEL'}
end
if current < hard_floor then
  return {0, n, current - (others + 1) * budget - reservations, 'BELOW_HARD_FLOOR'}
end
local projected = current - (others + 1) * budget - reservations
if projected < target then
  return {0, n, projected, 'PROJECTED_BELOW_TARGET'}
end

redis.call('SET', newkey, value, 'PX', ttl_ms)
redis.call('SADD', live, newkey)
return {1, others + 1, projected, 'ADMITTED'}
`;

/** Same checks, NO write (the UI "next device" preview). */
export const DRY_RUN_LUA = `
local live = KEYS[1]
local max_parallel = tonumber(ARGV[1])
local hard_floor = tonumber(ARGV[2])
local target = tonumber(ARGV[3])
local budget = tonumber(ARGV[4])
local current = tonumber(ARGV[5])
local reservations = tonumber(ARGV[6])

local n = redis.call('SCARD', live)
if n > 0 then
  local members = redis.call('SMEMBERS', live)
  local c = 0
  for _, m in ipairs(members) do
    if redis.call('EXISTS', m) == 1 then c = c + 1
    else redis.call('SREM', live, m) end
  end
  n = c
end

local projected = current - (n + 1) * budget - reservations
if n + 1 > max_parallel then
  return {0, n, projected, 'MAX_PARALLEL'}
end
if current < hard_floor then
  return {0, n, projected, 'BELOW_HARD_FLOOR'}
end
if projected < target then
  return {0, n, projected, 'PROJECTED_BELOW_TARGET'}
end
return {1, n, projected, 'ADMITTED'}
`;

/** Owner-checked release (admissionId must match — a stale stop must never
 *  delete a FRESH lease for the same entity). → 1 released / 0 no-op. */
export const RELEASE_LUA = `
-- no require('cjson'): Redis >= 7.1 sandboxes block require. The lease value
-- is our own JSON with admissionId as the first key, so a bounded match is
-- safe and dependency-free.
local val = redis.call('GET', KEYS[2])
if val then
  local id = string.match(val, '"a":"([^"]+)"')
  if id and id == ARGV[1] then
    redis.call('DEL', KEYS[2])
    redis.call('SREM', KEYS[1], KEYS[2])
    return 1
  end
end
return 0
`;

/** Authority release (reconciler / lifecycle without the admissionId):
 *  deletes whatever lease the entity key holds. → [released(0/1), value]. */
export const RELEASE_BY_KEY_LUA = `
local val = redis.call('GET', KEYS[2])
if val then
  redis.call('DEL', KEYS[2])
  redis.call('SREM', KEYS[1], KEYS[2])
  return {1, val}
end
return {0, ''}
`;

/** Renewal (reconciler heartbeat while the entity is still entitled). */
export const RENEW_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  redis.call('PEXPIRE', KEYS[2], ARGV[1])
  return 1
end
return 0
`;

/** Live-lease count with prune. → [count]. */
export const COUNT_LUA = `
local live = KEYS[1]
local n = redis.call('SCARD', live)
if n > 0 then
  local members = redis.call('SMEMBERS', live)
  local c = 0
  for _, m in ipairs(members) do
    if redis.call('EXISTS', m) == 1 then c = c + 1
    else redis.call('SREM', live, m) end
  end
  n = c
end
return {n}
`;

/**
 * @param {object} deps
 * @param {object} deps.redis   ioredis-shaped: eval(script, [keys], [args]),
 *                              get/set/del/ping/sadd/smembers/mget, rpush/ltrim
 * @param {object} deps.metrics { sample: () => Promise<{ts, memAvailableMiB, ...}> }
 * @param {() => Promise<object|null>} [deps.configSource] operator patch (AppSetting)
 * @param {(lease:object) => Promise<'running'|'booting'|'gone'>} [deps.entityState] reconcile input
 * @param {() => Promise<Array<{kind:string, entityKey:string, entityName?:string}>>} [deps.expectedEntities] recovery input
 * @param {() => Promise<number>} [deps.runningCount] display count (DB view)
 * @param {(d:object) => void|Promise<void>} [deps.decisionSink] decision log sink
 * @param {object} [deps.env]
 * @param {() => number} [deps.now]
 * @param {object} [deps.log]
 */
export function createRamGate({
  redis,
  metrics,
  configSource = null,
  entityState = null,
  expectedEntities = null,
  runningCount = null,
  decisionSink = null,
  env = process.env,
  now = () => Date.now(),
  log = { warn() {}, error() {}, info() {} },
} = {}) {
  if (!redis || typeof redis.eval !== 'function') {
    throw new TypeError('createRamGate: redis with eval() is required');
  }
  if (!metrics || typeof metrics.sample !== 'function') {
    throw new TypeError('createRamGate: metrics.sample() is required');
  }

  const keys = {
    live: 'ramgate:live',
    metrics: 'ramgate:metrics',
    decisions: 'ramgate:decisions',
    lease: (kind, entityKey) => `ramgate:lease:${kind}:${entityKey}`,
  };

  async function evalScript(script, keyList, argList) {
    // ioredis-native convention: eval(script, numkeys, ...keys, ...args).
    // The check+write in a single atomic script is the whole point — see docs.
    return redis.eval(script, keyList.length, ...keyList, ...argList);
  }

  async function effectiveConfig() {
    let patch = null;
    if (configSource) {
      try {
        patch = await configSource();
      } catch (err) {
        // config store blip: fall back to env+constants (still fail-closed
        // on the METRICS/STORE paths — this is not an admission path bypass)
        log.warn?.({ error: err.message }, 'ram-gate: config source unavailable — using env+constants');
      }
    }
    const resolved = resolveRamGateConfig(patch, env);
    if (!resolved.ok) {
      // Nonsense config = fail closed (MD): report + deny everything.
      log.error?.({ errors: resolved.errors }, 'ram-gate: invalid config — gate FAILS CLOSED');
      return { cfg: null, errors: resolved.errors };
    }
    return { cfg: resolved.config, errors: null };
  }

  /** Log one decision (decisionSink = ring buffer + audit in the API glue). */
  function record(d) {
    try {
      const out = { ts: d.ts ?? now(), ...d };
      const r = decisionSink ? decisionSink(out) : null;
      if (r && typeof r.catch === 'function') r.catch((err) => log.warn?.({ error: err.message }, 'ram-gate: decision sink failed'));
    } catch {
      /* sink must never break the decision path */
    }
    const line = {
      action: d.action,
      kind: d.kind,
      entity: d.entity,
      admitted: d.admitted,
      reason: d.reason,
      currentMiB: d.currentMiB ?? null,
      liveCount: d.liveCount ?? null,
      projectedMiB: d.projectedMiB ?? null,
      source: d.source ?? null,
    };
    if (d.admitted) log.info?.(line, 'ram-gate decision');
    else log.warn?.(line, 'ram-gate decision (DENY)');
  }

  /**
   * Admit one boot. NEVER throws for a legitimate denial.
   * @returns {Promise<{admitted:boolean, reason:string, bypass?:boolean, admissionId?:string,
   *   currentMiB?:number, liveCount?:number, projectedMiB?:number, config?:object, details?:object}>}
   */
  async function admit({ kind, entityKey, entityName = null, source = 'unknown' } = {}) {
    const ts = now();
    if (typeof kind !== 'string' || !['device', 'run'].includes(kind) || typeof entityKey !== 'string' || entityKey.length === 0) {
      const d = { ts, action: 'deny', kind: kind ?? null, entity: entityKey ?? null, admitted: false, reason: RAM_GATE_REASON.INVALID_INPUT, source };
      record(d);
      return { admitted: false, reason: RAM_GATE_REASON.INVALID_INPUT };
    }
    const { cfg, errors } = await effectiveConfig();
    if (errors) {
      const d = { ts, action: 'deny', kind, entity: entityKey, admitted: false, reason: RAM_GATE_REASON.CONFIG_INVALID, details: { errors }, source };
      record(d);
      return { admitted: false, reason: RAM_GATE_REASON.CONFIG_INVALID, details: { errors } };
    }
    if (!cfg.enabled) {
      const d = { ts, action: 'admit', kind, entity: entityKey, admitted: true, reason: RAM_GATE_REASON.GATE_DISABLED, bypass: true, source };
      record(d);
      return { admitted: true, reason: RAM_GATE_REASON.GATE_DISABLED, bypass: true, config: cfg };
    }

    // 1) fresh metrics (fail-closed on any problem)
    let m;
    try {
      m = await metrics.sample();
    } catch (err) {
      const d = { ts, action: 'deny', kind, entity: entityKey, admitted: false, reason: RAM_GATE_REASON.METRICS_UNAVAILABLE, details: { error: String(err?.message ?? err).slice(0, 300) }, source };
      record(d);
      return { admitted: false, reason: RAM_GATE_REASON.METRICS_UNAVAILABLE, details: { error: d.details.error } };
    }
    if (!Number.isFinite(m?.memAvailableMiB) || m.memAvailableMiB < 0) {
      const d = { ts, action: 'deny', kind, entity: entityKey, admitted: false, reason: RAM_GATE_REASON.METRICS_UNAVAILABLE, details: { error: 'sample missing memAvailableMiB' }, source };
      record(d);
      return { admitted: false, reason: RAM_GATE_REASON.METRICS_UNAVAILABLE, details: { error: 'sample missing memAvailableMiB' } };
    }
    if (ts - Number(m.ts ?? ts) > cfg.metricsMaxAgeMs) {
      const d = { ts, action: 'deny', kind, entity: entityKey, admitted: false, reason: RAM_GATE_REASON.METRICS_STALE, currentMiB: m.memAvailableMiB, details: { sampleTs: m.ts, maxAgeMs: cfg.metricsMaxAgeMs }, source };
      record(d);
      return { admitted: false, reason: RAM_GATE_REASON.METRICS_STALE, currentMiB: m.memAvailableMiB, details: d.details };
    }

    // 2) atomic check + reserve
    const admissionId = randomUUID();
    const leaseValue = JSON.stringify({
      a: admissionId,
      k: kind,
      e: entityKey,
      n: entityName ?? null,
      s: source,
      t: ts,
      b: cfg.perBootBudgetMiB,
    });
    const leaseKey = keys.lease(kind, entityKey);
    let out;
    try {
      out = await evalScript(
        ADMIT_LUA,
        [keys.live, leaseKey],
        [
          cfg.leaseTtlMs,
          cfg.maxParallel,
          cfg.hardFloorMiB,
          cfg.postBootTargetMiB,
          cfg.perBootBudgetMiB,
          m.memAvailableMiB,
          0,
          leaseValue,
        ],
      );
    } catch (err) {
      const d = { ts, action: 'deny', kind, entity: entityKey, admitted: false, reason: RAM_GATE_REASON.STORE_UNAVAILABLE, currentMiB: m.memAvailableMiB, details: { error: String(err?.message ?? err).slice(0, 300) }, source };
      record(d);
      return { admitted: false, reason: RAM_GATE_REASON.STORE_UNAVAILABLE, currentMiB: m.memAvailableMiB, details: { error: d.details.error } };
    }
    const [decision, liveCount, projectedMiB, reason] = Array.isArray(out) ? out : [0, 0, null, 'STORE_UNAVAILABLE'];
    const admitted = Number(decision) === 1;
    record({ ts, action: admitted ? 'admit' : 'deny', kind, entity: entityKey, admitted, reason: String(reason), currentMiB: m.memAvailableMiB, liveCount: Number(liveCount) || 0, projectedMiB: Number.isFinite(projectedMiB) ? Number(projectedMiB) : null, source });
    return {
      admitted,
      reason: String(reason),
      admissionId: admitted ? admissionId : null,
      currentMiB: m.memAvailableMiB,
      liveCount: Number(liveCount) || 0,
      projectedMiB: Number.isFinite(projectedMiB) ? Number(projectedMiB) : null,
      config: cfg,
    };
  }

  /** Preview without reserving (the UI "next device?" answer). */
  async function dryRun() {
    const { cfg } = await effectiveConfig();
    if (!cfg) return { admitted: false, reason: RAM_GATE_REASON.CONFIG_INVALID };
    if (!cfg.enabled) return { admitted: true, reason: RAM_GATE_REASON.GATE_DISABLED, bypass: true };
    let m;
    try {
      m = await metrics.sample();
    } catch {
      return { admitted: false, reason: RAM_GATE_REASON.METRICS_UNAVAILABLE };
    }
    if (ts_age_stale(m)) return { admitted: false, reason: RAM_GATE_REASON.METRICS_STALE };
    try {
      const out = await evalScript(
        DRY_RUN_LUA,
        [keys.live],
        [cfg.maxParallel, cfg.hardFloorMiB, cfg.postBootTargetMiB, cfg.perBootBudgetMiB, m.memAvailableMiB, 0],
      );
      const [decision, liveCount, projectedMiB, reason] = Array.isArray(out) ? out : [0, 0, null, 'STORE_UNAVAILABLE'];
      return { admitted: Number(decision) === 1, reason: String(reason), liveCount: Number(liveCount) || 0, projectedMiB: Number.isFinite(projectedMiB) ? Number(projectedMiB) : null, currentMiB: m.memAvailableMiB, config: cfg };
    } catch {
      return { admitted: false, reason: RAM_GATE_REASON.STORE_UNAVAILABLE };
    }
    function ts_age_stale(mm) {
      return Number.isFinite(mm?.ts) && now() - Number(mm.ts) > cfg.metricsMaxAgeMs;
    }
  }

  /** Owner-checked release (lifecycle normal path). */
  async function release({ kind, entityKey, admissionId, reason = 'lifecycle' } = {}) {
    if (!admissionId) return { released: false, reason: 'no-admission-id' };
    const out = await evalScript(RELEASE_LUA, [keys.live, keys.lease(kind, entityKey)], [admissionId]);
    const released = Number(out) === 1;
    if (released) {
      record({ ts: now(), action: 'release', kind, entity: entityKey, admitted: null, reason, source: 'release' });
    }
    return { released };
  }

  /** Authority release (reconciler / stop without admissionId). */
  async function releaseByKey({ kind, entityKey, reason = 'authority' } = {}) {
    const out = await evalScript(RELEASE_BY_KEY_LUA, [keys.live, keys.lease(kind, entityKey)], []);
    const arr = Array.isArray(out) ? out : [0, ''];
    const released = Number(arr[0]) === 1;
    if (released) {
      record({ ts: now(), action: 'release', kind, entity: entityKey, admitted: null, reason, source: 'release-by-key' });
    }
    return { released, value: arr[1] ? safeDecode(arr[1]) : null };
  }

  /** Reconciler renewal (entity still entitled). */
  async function renewLease({ kind, entityKey, ttlMs } = {}) {
    const out = await evalScript(RENEW_LUA, [keys.live, keys.lease(kind, entityKey)], [Number(ttlMs) || 300_000]);
    return { renewed: Number(out) === 1 };
  }

  /** All live leases (pruned) with decoded values. */
  async function listLeases() {
    const members = await redis.smembers(keys.live);
    const clean = [];
    for (const m of members) {
      const exists = await redis.exists(m);
      if (!Number(exists)) {
        await redis.srem(keys.live, m).catch?.(() => {});
        continue;
      }
      clean.push(m);
    }
    if (clean.length === 0) return [];
    const values = await redis.mget(...clean);
    return clean.map((k, i) => ({ key: k, value: safeDecode(values[i]) ?? null }));
  }

  /** Live lease count (pruned) — the admission-side number. */
  async function liveCount() {
    const out = await evalScript(COUNT_LUA, [keys.live], []);
    const n = Array.isArray(out) ? Number(out[0]) : Number(out);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Reconciliation (MD §6.2 style; G1): lease ↔ entity state, both ways.
   *   - lease with a GONE entity   → release (stale, e.g. after crash)
   *   - lease with a live entity   → renew (TTL backstop refresh)
   *   - entitled entity, no lease  → recover (e.g. after redis flush)
   * @returns {Promise<{released:Array, renewed:number, recovered:number, errors:Array}>}
   */
  async function reconcile({ ttlMs } = {}) {
    const { cfg } = await effectiveConfig();
    const summary = { released: [], renewed: 0, recovered: 0, errors: [] };
    if (!cfg) {
      summary.errors.push('config invalid — reconcile skipped (fail closed)');
      return summary;
    }
    if (typeof entityState !== 'function') return summary;

    let leases;
    try {
      leases = await listLeases();
    } catch (err) {
      summary.errors.push(`listLeases: ${err.message}`);
      return summary;
    }
    const seen = new Set();
    for (const l of leases) {
      const v = l.value;
      seen.add(v?.e ? `${v.k}:${v.e}` : l.key);
      if (!v?.k || !v?.e) {
        summary.errors.push(`undecodable lease key ${l.key} (left for TTL)`) ;
        continue;
      }
      let state;
      try {
        state = await entityState(v);
      } catch (err) {
        summary.errors.push(`entityState(${v.k}:${v.e}): ${err.message}`);
        continue;
      }
      if (state === 'gone') {
        try {
          const r = await release({ kind: v.k, entityKey: v.e, admissionId: v.a, reason: 'reconcile:entity-gone' });
          if (r.released) summary.released.push(`${v.k}:${v.e}`);
        } catch (err) {
          summary.errors.push(`release(${v.k}:${v.e}): ${err.message}`);
        }
      } else {
        try {
          const r = await renewLease({ kind: v.k, entityKey: v.e, ttlMs: ttlMs ?? cfg.leaseTtlMs });
          if (r.renewed) summary.renewed += 1;
        } catch (err) {
          summary.errors.push(`renew(${v.k}:${v.e}): ${err.message}`);
        }
      }
    }

    // recovery direction: entitled entities without a lease
    if (typeof expectedEntities === 'function') {
      let expected = [];
      try {
        expected = (await expectedEntities()) ?? [];
      } catch (err) {
        summary.errors.push(`expectedEntities: ${err.message}`);
      }
      for (const e of expected) {
        if (!e?.kind || !e?.entityKey) continue;
        if (seen.has(`${e.kind}:${e.entityKey}`)) continue;
        try {
          const admissionId = randomUUID();
          const val = JSON.stringify({ a: admissionId, k: e.kind, e: e.entityKey, n: e.entityName ?? null, s: 'reconcile-recovery', t: now(), b: cfg.perBootBudgetMiB });
          const leaseKey = keys.lease(e.kind, e.entityKey);
          // recovery = unconditional create (the entity ALREADY consumes RAM —
          // admission math is not re-run; the count cap is enforced on the
          // next admission, which sees this lease)
          await redis.set(leaseKey, val, 'PX', ttlMs ?? cfg.leaseTtlMs);
          await redis.sadd(keys.live, leaseKey);
          summary.recovered += 1;
          record({ ts: now(), action: 'recover', kind: e.kind, entity: e.entityKey, admitted: null, reason: 'reconcile:lease-missing', source: 'reconcile' });
        } catch (err) {
          summary.errors.push(`recover(${e.kind}:${e.entityKey}): ${err.message}`);
        }
      }
    }
    return summary;
  }

  /** Latest metrics sample (fresh) + age, for the status endpoint. */
  async function metricsNow() {
    try {
      const m = await metrics.sample();
      const ageMs = Number.isFinite(m.ts) ? Math.max(0, now() - Number(m.ts)) : null;
      return { ok: true, ...m, ageMs, stale: ageMs !== null && ageMs > (await effectiveConfigSafe()).metricsMaxAgeMs };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err).slice(0, 300) };
    }
  }

  async function effectiveConfigSafe() {
    const { cfg, errors } = await effectiveConfig();
    return cfg ?? { ...RAM_GATE_DEFAULTS, errors };
  }

  /** Full status payload (the UI source of truth). */
  async function status() {
    const { cfg, errors } = await effectiveConfig();
    const metrics = await metricsNow();
    let counts = { liveLeases: null, running: null, inProgress: 0, runningWithLease: 0, reservedMiB: 0 };
    let wouldAdmitNext = null;
    let storeOk = null;
    if (cfg) {
      try {
        storeOk = (await redis.ping()) === 'PONG';
      } catch {
        storeOk = false;
      }
      if (storeOk) {
        try {
          const leases = await listLeases();
          counts.liveLeases = leases.length;
          counts.reservedMiB = leases.length * cfg.perBootBudgetMiB;
          for (const l of leases) {
            const v = l.value;
            if (!v?.k || !v?.e) continue;
            try {
              const st = await entityState?.(v);
              if (st === 'running') counts.runningWithLease += 1;
              else if (st === 'booting') counts.inProgress += 1;
            } catch {
              /* per-entity blip — skip classification */
            }
          }
        } catch {
          counts.liveLeases = null;
        }
        try {
          if (typeof runningCount === 'function') counts.running = await runningCount();
        } catch {
          counts.running = null;
        }
        try {
          wouldAdmitNext = await dryRun();
        } catch {
          wouldAdmitNext = { admitted: false, reason: RAM_GATE_REASON.STORE_UNAVAILABLE };
        }
      }
    }
    return {
      enabled: cfg ? cfg.enabled : false,
      config: cfg ?? null,
      configErrors: errors ?? null,
      metrics,
      counts,
      wouldAdmitNext,
      store: { redis: storeOk },
      ts: now(),
    };
  }

  /** Periodic jobs: metrics publish + reconcile (start/stop by the host app). */
  let timers = null;
  function start({ metricsIntervalMs = 5_000, reconcileIntervalMs = 300_000, publishMetrics = true } = {}) {
    if (timers) return;
    const publish = async () => {
      try {
        const m = await metrics.sample();
        await redis.set(keys.metrics, JSON.stringify(m), 'EX', 60);
      } catch (err) {
        log.warn?.({ error: err.message }, 'ram-gate: metrics publish failed');
      }
    };
    const tickReconcile = async () => {
      try {
        const s = await reconcile();
        if (s.released.length || s.recovered) {
          log.info?.({ ...s }, 'ram-gate: reconcile action');
        }
      } catch (err) {
        log.warn?.({ error: err.message }, 'ram-gate: reconcile failed');
      }
    };
    if (publishMetrics) void publish();
    void tickReconcile();
    timers = {
      m: setInterval(() => void publish(), metricsIntervalMs),
      r: setInterval(() => void tickReconcile(), reconcileIntervalMs),
    };
    timers.m.unref?.();
    timers.r.unref?.();
  }
  function stop() {
    if (!timers) return;
    clearInterval(timers.m);
    clearInterval(timers.r);
    timers = null;
  }

  return { admit, dryRun, release, releaseByKey, renewLease, listLeases, liveCount, reconcile, status, metricsNow, start, stop, keys, reasons: RAM_GATE_REASON };
}

function safeDecode(s) {
  try {
    return JSON.parse(String(s));
  } catch {
    return null;
  }
}
