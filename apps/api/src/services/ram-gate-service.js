/**
 * ram-gate-service.js — API-side construction of the host-RAM admission
 * gate (RAM-G1).
 *
 * The pure gate (createRamGate, @water-army/shared) is wired here to the
 * API's environment:
 *   - config:   AppSetting 'ram_gate.config'  (operator patch)
 *               + RAM_GATE_* env  +  built-in constants  (env > AppSetting)
 *   - entityState / expectedEntities: the DB view of what actually holds
 *               RAM (device containerState / task-run containerId) — the
 *               reconciliation inputs (MD G1 §6: lease 過期 + reconcile)
 *   - decisionSink: in-memory ring (UI /decisions) + audit rows for
 *               denials/recoveries (persistent trail)
 *
 * The gate is constructed ONLY when the redis client supports eval()
 * (real ioredis does; hermetic test fakes do not → the gate is null and
 * the boot paths behave exactly as pre-G1 — the documented zero-regression
 * isolation). In production the gate is ALWAYS on unless explicitly
 * disabled (RAM_GATE_ENABLED=false) — denials are the safe behaviour.
 *
 * Vantage note: /proc/meminfo inside the api container is NOT namespaced —
 * it reports the host (verified G1 A2: container read == host read).
 */
import {
  createHostMetrics,
  createRamGate,
  RAM_GATE_APP_SETTING_KEY,
} from '@water-army/shared';

/** Device container states that consume host RAM (lease-entitled). */
export const RAM_ENTITLED_DEVICE_STATES = ['running', 'created', 'provisioning', 'paused'];

/**
 * @param {object} deps
 * @param {object} deps.db      prisma client (device/taskRun/appSetting delegates optional)
 * @param {object} deps.redis   ioredis (needs eval) — null gate when absent
 * @param {object} [deps.config]
 * @param {object} deps.log
 * @param {(e:object) => Promise<void>} [deps.audit]
 * @param {object} [deps.metrics]  test seam: {sample} override (default: host /proc)
 * @param {object} [deps.now]
 * @returns {Promise<{gate:object|null, skipped:string|null}>}
 */
export async function buildRamGateService({ db, redis, config = {}, log = { warn() {} }, audit = null, metrics = null, now = null } = {}) {
  if (!redis || typeof redis.eval !== 'function') {
    return { gate: null, skipped: 'redis without eval() — gate disabled (hermetic/isolated environment)' };
  }

  const metricsProvider = metrics ?? createHostMetrics({ procDir: config.ramGateProcDir ?? '/proc' });

  /** Operator config patch (AppSetting valueJson) — null when absent. */
  const configSource = db?.appSetting
    ? async () => {
        const row = await db.appSetting.findUnique({ where: { key: RAM_GATE_APP_SETTING_KEY } });
        return row?.valueJson ?? null;
      }
    : null;

  /**
   * What is THIS lease's entity actually doing? (reconcile input)
   *   'running' — entitled, keep + renew
   *   'booting' — in progress, keep + renew
   *   'gone'    — release (the lease is stale)
   * Conservative on error: 'running' (a lookup blip must never mass-release).
   */
  const entityState = async (v) => {
    try {
      if (v?.k === 'device') {
        if (!db?.device) return 'running';
        const row = await db.device.findFirst({ where: { name: v.e }, select: { containerState: true } });
        if (!row) return 'gone';
        const st = row.containerState;
        if (st === 'running' || st === 'paused') return 'running';
        if (st === 'provisioning' || st === 'created') return 'booting';
        return 'gone';
      }
      if (v?.k === 'run') {
        if (!db?.taskRun) return 'running';
        const run = await db.taskRun.findUnique({ where: { id: v.e }, select: { status: true, containerId: true } });
        if (!run || !run.containerId) return 'gone';
        if (run.status === 'running') return 'running';
        if (run.status === 'queued') return 'booting';
        return 'gone';
      }
      return 'gone';
    } catch (err) {
      log.warn?.({ error: err.message, lease: v?.e }, 'ram-gate: entityState lookup failed — treating as running (conservative)');
      return 'running';
    }
  };

  /** Everything entitled to a lease RIGHT NOW (recovery input). */
  const expectedEntities = async () => {
    const out = [];
    try {
      if (db?.device) {
        const devices = await db.device.findMany({
          where: { containerState: { in: RAM_ENTITLED_DEVICE_STATES } },
          select: { name: true },
        });
        for (const d of devices) out.push({ kind: 'device', entityKey: d.name, entityName: d.name });
      }
      if (db?.taskRun) {
        const runs = await db.taskRun.findMany({
          where: { status: 'running', containerId: { not: null } },
          select: { id: true },
        });
        for (const r of runs) out.push({ kind: 'run', entityKey: r.id, entityName: `run:${r.id}` });
      }
    } catch (err) {
      log.warn?.({ error: err.message }, 'ram-gate: expectedEntities lookup failed (recovery skipped this cycle)');
    }
    return out;
  };

  /**
   * DB-view "running" count for the UI: RAM-entitled devices (containerState
   * in the entitled set) + batch runs that are running WITH a container
   * (a run without a container holds no RAM). Both populations are exactly
   * the ones that hold/should hold a lease.
   */
  const runningCount = db?.device || db?.taskRun
    ? async () => {
        let n = 0;
        if (db.device) {
          n += await db.device.count({ where: { containerState: { in: RAM_ENTITLED_DEVICE_STATES } } });
        }
        if (db.taskRun) {
          try {
            const runs = await db.taskRun.findMany({
              where: { status: 'running' },
              select: { id: true, containerId: true },
            });
            n += runs.filter((r) => r.containerId).length;
          } catch {
            /* keep the device-only count — display metric, never gate input */
          }
        }
        return n;
      }
    : null;

  // UI decision ring (bounded) + persistent audit for denials/recoveries.
  const decisions = [];
  const DECISION_RING_MAX = 300;
  const decisionSink = (d) => {
    decisions.push(d);
    if (decisions.length > DECISION_RING_MAX) decisions.splice(0, decisions.length - DECISION_RING_MAX);
    if (d.action !== 'deny' && d.action !== 'recover') return;
    if (!audit) return;
    Promise.resolve(
      audit({
        actorUserId: null,
        action: d.action === 'deny' ? 'ramgate.admission_denied' : 'ramgate.lease_recovered',
        resourceType: 'ram_gate',
        resourceId: `${d.kind}:${d.entity}`,
        status: 'success',
        details: {
          action: d.action,
          kind: d.kind,
          entity: d.entity,
          reason: d.reason,
          currentMiB: d.currentMiB ?? null,
          liveCount: d.liveCount ?? null,
          projectedMiB: d.projectedMiB ?? null,
          source: d.source ?? null,
        },
      }),
    ).catch((err) => log.warn?.({ error: err.message }, 'ram-gate: audit write failed'));
  };

  const gate = createRamGate({
    redis,
    metrics: metricsProvider,
    configSource,
    entityState,
    expectedEntities,
    runningCount,
    decisionSink,
    env: process.env,
    now: now ?? undefined, // null (unspecified) → the gate's own default clock
    log,
  });

  // Periodic jobs (unref'd — never hold the process open):
  //   metrics publish every 5s (stale-visible in status), reconcile every 5min.
  gate.start({ metricsIntervalMs: 5_000, reconcileIntervalMs: 300_000 });

  return {
    gate,
    skipped: null,
    /** The UI /decisions source (newest last). */
    decisions: () => decisions.slice(-200).reverse(),
  };
}
