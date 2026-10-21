/**
 * Batch Rotation metrics + monitor snapshot service (BR-B5, MD §13/§11.2).
 *
 * The repo's monitoring convention is "queryable endpoint + pino" (no
 * Prometheus): this service owns the FETCH side (db / docker / host / deps),
 * delegates the math to the pure shared core (batch-metrics.js), and adds
 * the alert side-effects — pino error/warn + audit event with dedup
 * (in-process fingerprint → first-seen map; re-audit at most hourly).
 * No alert channel exists in this repo (documented in runbook).
 *
 * Everything external is injectable (db, dockerService, redisPing,
 * dockerPing, os, fs, now) so the route integration tests run hermetically.
 */
import os from 'node:os';
import { stat, statfs } from 'node:fs/promises';

import {
  computeBatchMetrics,
  alertFingerprint,
  DEFAULT_ALERT_LIMITS,
  APP_SETTING_BATCH_GLOBAL_MAX_ACTIVE,
  scrubObject,
  maskCredentialShapedValues,
  buildCycleReport,
  BatchError,
} from '@water-army/shared';

const HEALTH_CHECK_TIMEOUT_MS = 2500;
const TASK_TABLE_MAX = 200; // monitor task list cap (newest first)
const START_EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const START_EVENT_TAKE = 500;
const ERROR_MESSAGE_MAX = 300; // masked + capped for the monitor table
const REAUDIT_INTERVAL_MS = 60 * 60 * 1000; // alert re-audit interval
const CYCLE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function withTimeout(promise, ms) {
  let timer;
  const p = Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    }),
  ]);
  return p.finally(() => clearTimeout(timer));
}

export function createBatchMetricsService({
  db,
  dockerService,
  log = console,
  audit,
  now = () => new Date(),
  redisPing,
  dockerPing,
  osProbe = null,
  fsProbe = null,
  diskPath = process.env.WA_METRICS_DISK_PATH || '/data/water_army',
  limits = {},
} = {}) {
  // A db without the B1 batch delegates (pre-B1 deployment, or the plain
  // API fakes used by the non-batch suites) degrades to a zeroed snapshot —
  // NEVER throw here: a construction throw aborts buildApp before the
  // onClose hook is registered, which leaks the real task-queue handle in
  // tests (retries redis forever, the process never exits).
  const batchProvisioned = Boolean(
    db?.batch?.findMany &&
    db?.batchIdentity?.findMany &&
    db?.resourceLease?.count &&
    db?.identity?.findMany &&
    db?.identity?.findUnique &&
    db?.stateEvent?.findMany &&
    db?.taskRun?.findMany &&
    db?.taskRun?.count &&
    db?.appSetting?.findUnique,
  );
  if (typeof redisPing !== 'function' || typeof dockerPing !== 'function') {
    throw new TypeError('createBatchMetricsService: redisPing + dockerPing probes are required');
  }
  const lim = { ...DEFAULT_ALERT_LIMITS, ...limits };
  const osm = osProbe ?? {
    freemem: () => os.freemem(),
    totalmem: () => os.totalmem(),
    loadavg: () => os.loadavg(),
  };
  const fsm = fsProbe ?? { stat, statfs };
  /** alert dedup: fingerprint → { firstSeen, lastAudited } (per process). */
  const alertState = new Map();

  // ------------------------------------------------------------- probes ----
  async function probe(name, fn) {
    try {
      await withTimeout(fn(), HEALTH_CHECK_TIMEOUT_MS);
      return 'up';
    } catch (err) {
      return err?.code === 'DOCKER_DISABLED' ? 'disabled' : 'down';
    }
  }

  async function probeDeps() {
    const [postgres, redis, docker] = await Promise.all([
      probe('postgres', () => db.$queryRaw`SELECT 1`),
      probe('redis', () => redisPing()),
      probe('docker', () => dockerPing()),
    ]);
    return { postgres, redis, docker };
  }

  async function probeHost() {
    try {
      const [memoryAvailableBytes, memoryTotalBytes, loadavg, disk] = await Promise.all([
        Promise.resolve(osm.freemem()),
        Promise.resolve(osm.totalmem()),
        Promise.resolve(osm.loadavg()),
        (async () => {
          try {
            const s = await fsm.statfs(diskPath);
            return Number(s.bavail) * Number(s.bsize);
          } catch {
            return null; // data root not mounted on this host — degrade, don't fail
          }
        })(),
      ]);
      return {
        memoryAvailableBytes,
        memoryTotalBytes,
        cpuLoad1m: loadavg?.[0] ?? null,
        cpuLoad5m: loadavg?.[1] ?? null,
        diskAvailableBytes: disk,
        diskPath,
      };
    } catch (err) {
      log.warn?.({ error: err.message }, 'batch metrics: host probe failed');
      return null;
    }
  }

  /** Identity data-dir probe (MD §11.3 — existence + mtime only, never content). */
  async function probeDataDir(path) {
    try {
      const st = await fsm.stat(path);
      return { exists: true, lastModifiedAt: st.mtime ? st.mtime.toISOString() : null };
    } catch {
      return { exists: false, lastModifiedAt: null };
    }
  }

  /**
   * Running managed containers (the managed flag is the label-OR-admin-
   * exception rule — same as the list/gate, P6 flag #1). Orphan = running +
   * managed but no valid DB owner (no identity label / unknown / disabled)
   * → MD §13 alert condition 7.
   */
  async function probeContainers() {
    try {
      const { items, total } = await dockerService.listContainers({ managed: true, pageSize: 200 });
      const running = items.filter((c) => c.state === 'running');
      const labelled = [...new Set(running.map((c) => c.identityId).filter((id) => typeof id === 'string' && id.length > 0))];
      let known = null; // null = ownership unverifiable (db not batch-provisioned)
      if (labelled.length && batchProvisioned) {
        const rows = await db.identity.findMany({ where: { id: { in: labelled } }, select: { id: true, status: true } });
        known = new Set();
        for (const r of rows) if (r.status !== 'DISABLED') known.add(r.id);
      }
      // unverifiable ownership is not an orphan — never false-positive
      const orphans = known
        ? running.filter((c) => !(c.identityId && known.has(c.identityId))).map((c) => c.shortId || c.id)
        : [];
      const byBatch = {};
      for (const c of running) {
        if (c.batchId) byBatch[c.batchId] = (byBatch[c.batchId] ?? 0) + 1;
      }
      return { available: true, running: running.length, total, byBatch, orphans };
    } catch (err) {
      log.debug?.({ error: err.message }, 'batch metrics: container probe unavailable');
      return null; // Docker down ≠ API failure (health/ready reports the detail)
    }
  }

  /**
   * Container start durations from state_event details (B2/B3 write seam —
   * detailsJson.startDurationMs on task_run events). Null until the first
   * event carries it (the metric degrades to null, never a fake 0).
   */
  async function probeStartDurations() {
    if (!batchProvisioned) return null;
    try {
      const since = new Date(now().getTime() - START_EVENT_WINDOW_MS);
      const events = await db.stateEvent.findMany({
        where: { entityType: 'task_run', createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: START_EVENT_TAKE,
        select: { detailsJson: true },
      });
      const list = [];
      for (const e of events) {
        const v = e.detailsJson?.startDurationMs;
        if (Number.isFinite(v) && v >= 0) list.push(v);
      }
      return list.length ? list : null;
    } catch (err) {
      log.debug?.({ error: err.message }, 'batch metrics: start-duration probe unavailable');
      return null;
    }
  }

  async function globalMaxActive() {
    if (!batchProvisioned) return null;
    try {
      const row = await db.appSetting.findUnique({ where: { key: APP_SETTING_BATCH_GLOBAL_MAX_ACTIVE } });
      const v = row?.valueJson;
      return Number.isInteger(v) && v >= 1 ? v : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------- data fetch ----
  async function fetchBatchData() {
    if (!batchProvisioned) return { batches: [], runs: [], expiredLeases: 0 };
    const since = new Date(now().getTime() - 90 * 24 * 60 * 60 * 1000); // 90-day horizon
    const [batches, runs, leaseCount] = await Promise.all([
      db.batch.findMany({ where: { createdAt: { gte: since } } }),
      db.taskRun.findMany({ where: { batchId: { not: null } }, orderBy: { createdAt: 'desc' }, take: 5000 }),
      db.resourceLease.count({ where: { leaseExpiresAt: { lte: now() } } }),
    ]);
    // Prisma count → number; the test fake returns {count} (normalise both)
    const expiredLeases = typeof leaseCount === 'number' ? leaseCount : leaseCount?.count ?? 0;
    return { batches, runs, expiredLeases };
  }

  // ----------------------------------------------------------- snapshot ----
  /**
   * Full monitor snapshot (MD §11.2) + metrics (MD §13).
   * @returns {Promise<object>}
   */
  async function snapshot() {
    const [deps, host, containers, startDurations, data, globalCap] = await Promise.all([
      probeDeps(),
      probeHost(),
      probeContainers(),
      probeStartDurations(),
      fetchBatchData(),
      globalMaxActive(),
    ]);
    const { batches, runs, expiredLeases } = data;

    const computed = computeBatchMetrics(
      { now: now(), batches, runs, expiredLeases, startDurationsMs: startDurations, containers, host, deps },
      { ...lim, globalMaxActiveContainers: globalCap ?? lim.globalMaxActiveContainers },
    );
    // the configured cap travels into detail so the UI can show it
    computed.detail.globalMaxActiveContainers = globalCap;

    const current = currentBatch(batches);
    computed.detail.batchMaxActiveContainers = current?.maxActiveContainers ?? null;

    attachAlertMeta(computed.alerts);

    let cycle = null;
    let cycleBatches = [];
    if (current) {
      cycleBatches = batches.filter((b) => b.cycleId === current.cycleId).sort((a, b) => a.batchNo - b.batchNo);
      cycle = cycleSummary(cycleBatches);
    }

    // task table (newest first, capped, masked)
    const identityIds = [...new Set(runs.map((r) => r.identityId).filter(Boolean))];
    const identities = identityIds.length
      ? await db.identity.findMany({ where: { id: { in: identityIds } }, select: { id: true, displayName: true, externalRef: true } })
      : [];
    const identityLabel = new Map(identities.map((i) => [i.id, i.displayName || i.externalRef || i.id]));
    const batchNo = new Map(batches.map((b) => [b.id, b.batchNo]));
    const t = now().getTime();
    const tasks = runs.slice(0, TASK_TABLE_MAX).map((r) => {
      const age = r.heartbeatAt ? t - new Date(r.heartbeatAt).getTime() : null;
      return {
        id: r.id,
        identityId: r.identityId ?? null,
        identityLabel: r.identityId ? identityLabel.get(r.identityId) ?? null : null,
        batchId: r.batchId ?? null,
        batchNo: r.batchId ? batchNo.get(r.batchId) ?? null : null,
        status: r.status,
        attempt: r.attempt ?? 1,
        maxAttempts: r.maxAttempts ?? null,
        startedAt: r.startedAt ?? null,
        heartbeatAt: r.heartbeatAt ?? null,
        finishedAt: r.finishedAt ?? null,
        lastError: r.errorCode || r.errorMessage ? { code: r.errorCode ?? null, message: capMessage(r.errorMessage) } : null,
        stuck: r.status === 'running' && (age == null || age > lim.workerHeartbeatStaleMs),
        unknown: r.status === 'unknown',
      };
    });

    const cycleRuns = current ? runs.filter((r) => r.batchId && cycleBatches.some((b) => b.id === r.batchId)) : [];

    return {
      batchProvisioned,
      generatedAt: computed.generatedAt,
      currentBatch: current
        ? {
            id: current.id,
            name: current.name,
            batchNo: current.batchNo,
            cycleId: current.cycleId,
            status: current.status,
            maxActiveContainers: current.maxActiveContainers,
            startedAt: current.startedAt ?? null,
          }
        : null,
      cycle,
      cycleBatches: current
        ? cycleBatches.map((b) => ({ id: b.id, batchNo: b.batchNo, name: b.name, status: b.status, startedAt: b.startedAt ?? null, finishedAt: b.finishedAt ?? null }))
        : [],
      counts: { global: runCounts(runs), cycle: current ? runCounts(cycleRuns) : null },
      capacity: {
        globalMaxActiveContainers: globalCap,
        batchMaxActiveContainers: current?.maxActiveContainers ?? null,
        activeContainersNow: containers?.available ? containers.running : null,
      },
      tasks,
      metrics: computed.metrics,
      detail: computed.detail,
      alerts: computed.alerts,
      host: computed.detail.host,
      deps,
      containers: computed.detail.containers,
    };
  }

  // ------------------------------------------------------------- alerts ----
  /**
   * Attach `since` (first-seen, in-process) to each alert and run the
   * side-effects: pino error/warn + audit event (dedup: new fingerprint or
   * re-audit interval elapsed). Resolved fingerprints are evicted so a
   * re-fired alert starts a fresh window + fresh audit.
   */
  function attachAlertMeta(alerts) {
    const t = now().getTime();
    const live = new Set();
    for (const a of alerts) {
      const fp = alertFingerprint(a);
      live.add(fp);
      const seen = alertState.get(fp);
      if (!seen) {
        alertState.set(fp, { firstSeen: t, lastAudited: 0 });
        a.since = new Date(t).toISOString();
        emitAlert(a, t, true);
      } else {
        a.since = new Date(seen.firstSeen).toISOString();
        if (t - seen.lastAudited >= REAUDIT_INTERVAL_MS) {
          seen.lastAudited = t;
          emitAlert(a, t, false);
        }
      }
    }
    for (const fp of [...alertState.keys()]) if (!live.has(fp)) alertState.delete(fp);
  }

  function emitAlert(alert, t, isNew) {
    const line = { alertId: alert.id, severity: alert.severity, message: alert.message, firstSeen: new Date(t).toISOString() };
    if (alert.severity === 'critical') log.error?.(line, 'batch rotation alert (critical)');
    else log.warn?.(line, 'batch rotation alert (warning)');
    if (typeof audit === 'function') {
      const p = audit({
        action: isNew ? 'batch.alert_raised' : 'batch.alert_ongoing',
        resourceType: 'batch_metric',
        resourceId: alert.id,
        status: alert.severity,
        details: scrubObject({ message: alert.message, new: isNew }, 1000),
      });
      p?.catch?.((err) => log.error?.({ error: err.message }, 'batch alert audit write failed'));
    }
  }

  // ----------------------------------------------------------- helpers ----
  /** Current batch = newest RUNNING, else newest PLANNED in a non-fully-terminal cycle. */
  function currentBatch(batches) {
    const running = batches.filter((b) => b.status === 'RUNNING');
    if (running.length) return [...running].sort((a, b) => new Date(b.startedAt ?? b.createdAt) - new Date(a.startedAt ?? a.createdAt))[0];
    const terminal = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED']);
    const activeCycles = new Set(batches.filter((b) => !terminal.has(b.status)).map((b) => b.cycleId));
    const planned = batches.filter((b) => b.status === 'PLANNED' && activeCycles.has(b.cycleId));
    if (planned.length) return [...planned].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    return null;
  }

  function cycleSummary(batches) {
    const terminal = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED']);
    const statuses = batches.map((b) => b.status);
    const allTerminal = statuses.every((s) => terminal.has(s));
    const anyError = statuses.includes('COMPLETED_WITH_ERRORS') || statuses.includes('PAUSED');
    return {
      cycleId: batches[0].cycleId,
      batchCount: batches.length,
      status: allTerminal ? (anyError ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED') : statuses.includes('RUNNING') ? 'RUNNING' : anyError ? 'PAUSED' : 'PLANNED',
      startedAt: minDate(batches.map((b) => b.startedAt)),
      finishedAt: maxDate(batches.map((b) => b.finishedAt)),
    };
  }

  function runCounts(runs) {
    const c = { active: 0, queued: 0, completed: 0, failed: 0, other: 0 };
    for (const r of runs) {
      if (r.status === 'queued' || r.status === 'needs_approval') c.queued += 1;
      else if (r.status === 'running' || r.status === 'cancel_requested') c.active += 1;
      else if (r.status === 'succeeded') c.completed += 1;
      else if (r.status === 'failed' || r.status === 'timed_out') c.failed += 1;
      else c.other += 1;
    }
    return c;
  }

  function capMessage(msg) {
    if (msg == null) return null;
    // value-level redact first (credential-shaped substrings), then key-level
    // scrub, then truncation (MD §12: no secrets in API responses)
    const s = maskCredentialShapedValues(String(msg));
    const scrubbed = scrubObject({ m: s }, 4000).m;
    return scrubbed.length > ERROR_MESSAGE_MAX ? `${scrubbed.slice(0, ERROR_MESSAGE_MAX)}…` : scrubbed;
  }

  function minDate(list) {
    const d = list.filter(Boolean);
    return d.length ? d.reduce((a, b) => (new Date(a) <= new Date(b) ? a : b)) : null;
  }
  function maxDate(list) {
    const d = list.filter(Boolean);
    return d.length ? d.reduce((a, b) => (new Date(a) >= new Date(b) ? a : b)) : null;
  }

  // -------------------------------------------------------- public api ----
  /** The metrics endpoint payload (MD §13) — no task table (size control). */
  async function getMetrics() {
    const snap = await snapshot();
    return {
      generatedAt: snap.generatedAt,
      metrics: snap.metrics,
      detail: snap.detail,
      alerts: snap.alerts,
    };
  }

  /**
   * Build a cycle report (MD §11.4). The pure builder enforces zero-secrets
   * (scrub + hard gate). @throws BatchError 400/404/409/500.
   */
  async function getCycleReport(cycleId, { requireTerminal = false } = {}) {
    if (typeof cycleId !== 'string' || !CYCLE_ID_RE.test(cycleId)) {
      throw new BatchError('VALIDATION_ERROR', 'Invalid cycle id (expected uuid)', { status: 400 });
    }
    if (!batchProvisioned) {
      throw new BatchError('CYCLE_NOT_FOUND', 'Batch rotation is not provisioned on this database', { status: 404 });
    }
    const batches = (await db.batch.findMany({ where: { cycleId } })).sort((a, b) => a.batchNo - b.batchNo);
    if (!batches.length) throw new BatchError('CYCLE_NOT_FOUND', `Cycle ${cycleId} not found`, { status: 404 });

    const batchIds = batches.map((b) => b.id);
    const [memberships, runs] = await Promise.all([
      db.batchIdentity.findMany({ where: { batchId: { in: batchIds } } }),
      db.taskRun.findMany({ where: { batchId: { in: batchIds } } }),
    ]);
    const identityIds = [...new Set(memberships.map((m) => m.identityId).filter(Boolean))];
    const identities = identityIds.length ? await db.identity.findMany({ where: { id: { in: identityIds } } }) : [];

    if (requireTerminal) {
      const terminal = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED']);
      if (!batches.every((b) => terminal.has(b.status))) {
        throw new BatchError('CYCLE_NOT_COMPLETE', 'Cycle still has non-terminal batches; export again after it finishes', { status: 409 });
      }
    }

    await attachContainerIds(runs);

    // Boundary masking (MD §12): free-text fields (error messages, skip
    // reasons) are value-masked BEFORE the pure builder — the builder itself
    // stays strict-fail-closed (assertNoSecrets tripping = a masking gap,
    // surfaced as REPORT_SECRET_TRIP, never a partial report).
    for (const r of runs) {
      if (typeof r.errorMessage === 'string') r.errorMessage = maskCredentialShapedValues(r.errorMessage);
    }
    for (const m of memberships) {
      if (typeof m.skipReason === 'string') m.skipReason = maskCredentialShapedValues(m.skipReason);
    }

    try {
      return buildCycleReport({ cycleId, batches, memberships, identities, runs, now: now() });
    } catch (err) {
      // a zero-secret gate trip is a hard failure — never ship a partial report
      if (/sensitive key|credential-shaped/.test(String(err?.message))) {
        throw new BatchError('REPORT_SECRET_TRIP', 'Refusing to export: report contains a credential-shaped field (see server log)', { status: 500 });
      }
      if (err instanceof TypeError) throw new BatchError('REPORT_BUILD_FAILED', 'Could not build the cycle report', { status: 500 });
      throw err;
    }
  }

  /** Best-effort container-id backfill from the live label index (MD §11.3). */
  async function attachContainerIds(runs) {
    try {
      const { items } = await dockerService.listContainers({ managed: true, pageSize: 200 });
      const byRun = new Map(items.filter((c) => c.taskRunId).map((c) => [c.taskRunId, c.id]));
      for (const r of runs) {
        if (!r.containerId && byRun.has(r.id)) r.containerId = byRun.get(r.id);
      }
    } catch {
      /* docker down → container ids stay null (degraded, not failed) */
    }
  }

  /** Cycles list for the reports page (viewer) — newest first. */
  async function listCycles() {
    if (!batchProvisioned) return [];
    const batches = await db.batch.findMany({ orderBy: { createdAt: 'desc' }, take: 1000 });
    const byCycle = new Map();
    for (const b of batches) {
      if (!byCycle.has(b.cycleId)) byCycle.set(b.cycleId, []);
      byCycle.get(b.cycleId).push(b);
    }
    const cycles = [...byCycle.entries()].map(([cycleId, list]) => {
      const sorted = [...list].sort((a, b) => a.batchNo - b.batchNo);
      return { cycleId, ...cycleSummary(sorted) };
    });
    cycles.sort((a, b) => new Date(b.startedAt ?? 0) - new Date(a.startedAt ?? 0));
    return cycles;
  }

  return {
    snapshot,
    getMetrics,
    getCycleReport,
    listCycles,
    probeDataDir,
    /** test seam: inspect/flush the alert dedup state */
    __alertState: alertState,
  };
}
