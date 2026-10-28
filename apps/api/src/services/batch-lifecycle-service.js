/**
 * Batch container lifecycle service (BR-B3, MD Phase 3 — lane A).
 *
 * OWNERSHIP MODEL (MD §4.3 — 雙重所有權驗證):
 *   A container operation is legal only when BOTH sources agree:
 *     1. the container's com.mirrorsocialmedia.water-army.* labels
 *        (identity-id / batch-id / task-run-id / managed)
 *     2. the DB task_run row (batch lineage + containerId column, B3)
 *   A disagreement is REFUSED (CONTAINER_OWNERSHIP_MISMATCH) and audited —
 *   the container is never touched on trust of a single source.
 *
 * ISOLATION MODEL (MD §4.1/§4.2/§8):
 *   - data volume: <dataRoot>/<identityId>/data, string-validated (B1) AND
 *     fs-validated here (realpath containment, 0700 dirs, duplicate writable
 *     mount-source scan across ALL live managed containers)
 *   - network: ADB published on 127.0.0.1:<hostPort> for humans/adb-CLI
 *     (the port is a ResourceLease — atomic across processes, MD §5.2, from a
 *     bounded admin range). The HEALTH PROBE does NOT ride that publish:
 *     it reaches adbd over L2 on the device network (container bridge IP),
 *     because the api container's loopback has no view of host-published
 *     ports (F-RDFA-2, docs/audits/rdfa-fix-report.md).
 *   - image: admin allowlist only (AppSetting, env fallback) — fail closed
 *   - privileged: only when the allowlist entry explicitly opts in (+reason)
 *
 * FAILURE MODEL (MD §8/§10 — fail closed, never a silent success):
 *   - daemon down / permission denied → 503/502 DOCKER_DAEMON_UNAVAILABLE,
 *     nothing is claimed to have happened, no DB write, leases released
 *   - boot health = a GENUINE ADB CNXN handshake answered by adbd (app
 *     layer, MD §8.2) — a "running" docker state, a bare TCP connect, or an
 *     unanswered handshake are all NEVER reported as healthy
 *   - every destructive action re-verifies ownership IMMEDIATELY before
 *     acting (TOCTOU window covered by label re-inspect)
 *
 * The worker has NO docker socket (threat model T1): it reaches this service
 * over HTTP with the service token, exactly like the AI tool handler.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BATCH_LIFECYCLE_ERROR as E,
  BatchLifecycleError,
  APP_SETTING_BATCH_CONTAINER_IMAGE_ALLOWLIST,
  containerNameForRun,
  parsePortRange,
  ownershipVerdict,
  reconcileVerdict,
  CONTAINER_LABELS,
  buildContainerLabels,
  IDENTITY_DATA_ROOT_DEFAULT,
  validateIdentityDataPath,
  findDuplicateMountSources,
  IDENTITY_TERMINAL,
  IDENTITY_ACTIVE_RUN_STATUSES,
  effectiveHealthProbe,
  DOCKER_ERROR,
} from '@water-army/shared';

import { classifyDockerError } from './docker-service.js';
import { deviceNetwork, ensureDeviceNetwork } from './device-network.js';
import { adbCnxnProbe } from './adb-cnxn-probe.js';

/** Docker port-key shape for the probe port (container side). */
function portKey(containerPort) {
  return `${Number(containerPort)}/tcp`;
}

/** True for the classic socket-level daemon errors (fail-closed class). */
function isDaemonLevelError(code) {
  return code === DOCKER_ERROR.DAEMON_UNAVAILABLE || code === DOCKER_ERROR.PERMISSION_DENIED;
}

/**
 * @param {object} deps
 * @param {object} deps.db prisma client
 * @param {object} deps.docker docker plugin ({ disabled, client, ping })
 * @param {object} deps.config API config (batchContainer* knobs)
 * @param {object} deps.lease lease service (shared createLeaseService)
 * @param {(entry:object)=>Promise<void>} deps.audit writeAudit
 * @param {object} [deps.log] pino logger
 * @param {() => Date} [deps.clock]
 * @param {(host:string, port:number, timeoutMs:number) => Promise<{healthy:boolean, detail:string|null, version?:string|null}>} [deps.healthProbe] hermetic seam
 * @param {object} [deps.fs] fs seam (default node:fs)
 */
export function createBatchLifecycleService({
  db,
  docker,
  config,
  lease,
  audit,
  log = { info() {}, warn() {}, error() {} },
  clock = () => new Date(),
  healthProbe,
  fsOps,
  // RAM-G1: host-RAM admission gate (null = pre-G1 behaviour — hermetic
  // suites never see a gate; production always constructs one when redis
  // has eval()). kind='run', entity = task-run id; lease held until
  // stop/remove (the container's RAM is held for the run's lifetime).
  ramGate: injectedRamGate,
}) {
  const ramGate = injectedRamGate ?? null;
  const fso = fsOps ?? fs.promises;
  const client = docker?.client ?? null;
  const dataRoot = () => config?.batchContainerDataRoot ?? IDENTITY_DATA_ROOT_DEFAULT;

  // ------------------------------------------------------------ fs seams
  async function requireClient() {
    if (docker?.disabled || !client) {
      throw new BatchLifecycleError(E.CONTAINER_OP_FAILED, 'Docker integration disabled — lifecycle unavailable', {
        status: 503,
        details: { dockerCode: DOCKER_ERROR.DISABLED },
      });
    }
    return client;
  }

  /** Run a dockerode call, classifying failures into lifecycle errors (fail closed). */
  async function dcall(op, fn, containerId = null) {
    try {
      return await fn();
    } catch (err) {
      const { code, status, message } = classifyDockerError(err);
      // Two engine patterns classifyDockerError leaves as GENERIC but that
      // the lifecycle MUST treat differently (bounded, deterministic retries):
      const raw = String(err?.message ?? '');
      let kind = null;
      if (/port is already allocated|address already in use/i.test(raw)) kind = 'PORT_ALLOCATED';
      else if (/Conflict|already in use/i.test(raw) && /container name/i.test(raw)) kind = 'NAME_CONFLICT';
      if (isDaemonLevelError(code)) {
        log.error({ op, containerId, dockerCode: code }, 'batch lifecycle: docker daemon-level failure (fail closed)');
        throw new BatchLifecycleError(E.CONTAINER_OP_FAILED, `Docker daemon unavailable during '${op}' — failing closed (nothing claimed to have happened)`, {
          status: code === DOCKER_ERROR.PERMISSION_DENIED ? 502 : 503,
          details: { dockerCode: code, retryable: true },
        });
      }
      throw new BatchLifecycleError(E.CONTAINER_OP_FAILED, message, {
        status,
        details: { dockerCode: code, kind, retryable: code === DOCKER_ERROR.TIMEOUT, op },
      });
    }
  }

  async function audited(entry) {
    try {
      await audit(entry);
    } catch (err) {
      log.error({ action: entry.action, error: err.message }, 'batch lifecycle: audit write failed (non-fatal)');
    }
  }

  // ------------------------------------------------------------ image allowlist
  /**
   * Admin allowlist (MD §12 — 明確啟用): AppSetting JSON takes priority;
   * env fallback. Entry shape:
   *   "image" (string) | { image, privileged?, reason?, memoryBytes?, nanoCpus?, cmd? }
   * NO entries at all → IMAGE_ALLOWLIST_UNAVAILABLE (fail closed).
   */
  async function resolveImageEntry(image) {
    let entries = null;
    try {
      const row = await db.appSetting.findUnique({ where: { key: APP_SETTING_BATCH_CONTAINER_IMAGE_ALLOWLIST } });
      entries = row?.valueJson ?? null;
    } catch (err) {
      log.error({ error: err.message }, 'batch lifecycle: allowlist read failed');
      throw new BatchLifecycleError(E.IMAGE_ALLOWLIST_UNAVAILABLE, 'Image allowlist could not be read — failing closed', { details: {} });
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      entries = config?.batchContainerAllowedImages;
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new BatchLifecycleError(
        E.IMAGE_ALLOWLIST_UNAVAILABLE,
        'No container image allowlist configured (AppSetting or env) — refusing by default (MD §12)',
        { details: { appSettingKey: APP_SETTING_BATCH_CONTAINER_IMAGE_ALLOWLIST } },
      );
    }
    for (const raw of entries) {
      const entry = typeof raw === 'string' ? { image: raw } : raw;
      if (entry && entry.image === image) {
        if (entry.privileged && !entry.reason) {
          throw new BatchLifecycleError(E.IMAGE_NOT_ALLOWLISTED, 'Allowlist entry requests privileged without a reason — fix the allowlist (MD §12)', { details: { image } });
        }
        return entry;
      }
    }
    throw new BatchLifecycleError(E.IMAGE_NOT_ALLOWLISTED, `Image '${image}' is not on the admin allowlist (MD §12: fail closed)`, { details: { image } });
  }

  // ------------------------------------------------------------ volume safety (MD item 1)
  /**
   * fs-level validation of the identity data volume BEFORE any mount:
   *   1. string contract (B1 validator, re-checked — the row is hostile input)
   *   2. every existing ancestor must realpath-inside the data root
   *      (symlink escape → VOLUME_SYMLINK_ESCAPE, a security event)
   *   3. create the data dir 0700 if absent (mkdir -p semantics)
   *   4. the final realpath must stay inside the data root
   * Returns the RESOLVED absolute path to mount (never the raw string).
   */
  async function resolveVolumeSource(identity) {
    const root = path.resolve(dataRoot());
    const raw = identity.dataPath;
    const v = validateIdentityDataPath(root, raw);
    if (!v.ok) {
      throw new BatchLifecycleError(E.VOLUME_PATH_INVALID, `identity.dataPath failed validation: ${v.reason}`, { details: { identityId: identity.id, reason: v.reason } });
    }
    const candidate = path.resolve(root, raw.startsWith(root + path.sep) ? raw.slice(root.length + path.sep.length) : raw);
    // Walk existing ancestors; each must resolve inside the root.
    let cursor = path.dirname(candidate);
    const rootReal = await fso.realpath(root);
    const inside = (p) => p === rootReal || p.startsWith(rootReal + path.sep);
    while (cursor.length > rootReal.length && cursor !== path.dirname(cursor)) {
      const statCur = await fso.stat(cursor).catch(() => null);
      if (statCur) {
        const real = await fso.realpath(cursor);
        if (!inside(real)) {
          await audited({
            actorUserId: null,
            action: 'batch_volume.symlink_escape_blocked',
            resourceType: 'identity',
            resourceId: identity.id,
            status: 'blocked',
            details: { path: cursor, resolved: real, root: rootReal },
          });
          throw new BatchLifecycleError(E.VOLUME_SYMLINK_ESCAPE, `data path component '${cursor}' escapes the data root via symlink — refused (MD §4.1)`, { details: { component: cursor, resolved: real } });
        }
      }
      cursor = path.dirname(cursor);
    }
    const stCandidate = await fso.stat(candidate).catch(() => null);
    if (!stCandidate) {
      await fso.mkdir(candidate, { recursive: true, mode: 0o750 });
      // 0700 on the leaf: identity data is secret-shaped (MD §2).
      await fso.chmod(candidate, 0o700);
    } else {
      if (!stCandidate.isDirectory()) {
        throw new BatchLifecycleError(E.VOLUME_PATH_INVALID, `identity.dataPath exists but is not a directory`, { details: { identityId: identity.id } });
      }
    }
    const resolved = await fso.realpath(candidate);
    if (!inside(resolved)) {
      await audited({
        actorUserId: null,
        action: 'batch_volume.symlink_escape_blocked',
        resourceType: 'identity',
        resourceId: identity.id,
        status: 'blocked',
        details: { path: candidate, resolved, root: rootReal },
      });
      throw new BatchLifecycleError(E.VOLUME_SYMLINK_ESCAPE, `data path '${candidate}' resolves outside the data root — refused (MD §4.1)`, { details: { path: candidate, resolved } });
    }
    return resolved;
  }

  /** All live managed containers (label-scanned client-side — the fake and real clients both support listContainers). */
  async function listManagedContainers() {
    const c = await requireClient();
    const raw = await dcall('list', () => c.listContainers({ all: true }));
    return raw.filter((r) => r.Labels?.[CONTAINER_LABELS.MANAGED] === 'true' && r.Labels?.[CONTAINER_LABELS.TASK_RUN_ID]);
  }

  /** Writable bind-mount sources of live managed containers, keyed by the
   *  container's identity label (the duplicate check's row shape, MD §4.1). */
  async function liveWritableMountRows(excludeContainerId = null) {
    const c = await requireClient();
    const managed = await listManagedContainers();
    const rows = [];
    for (const item of managed) {
      if (excludeContainerId && item.Id === excludeContainerId) continue;
      const identityId = item.Labels?.[CONTAINER_LABELS.IDENTITY_ID] ?? null;
      try {
        const info = await c.getContainer(item.Id).inspect();
        for (const m of info.Mounts ?? []) {
          if (m.Type === 'bind' && !m.RO && m.Source) rows.push({ id: identityId ?? `unknown-${item.Id.slice(0, 8)}`, dataPath: m.Source, containerId: item.Id });
        }
      } catch { /* container vanished mid-scan — the next sweep owns it */ }
    }
    return rows;
  }

  // ------------------------------------------------------------ port lease (MD item: 127.0.0.1 + bounded range)
  async function liveOccupiedPorts() {
    const c = await requireClient();
    const raw = await dcall('list', () => c.listContainers({ all: false }));
    const ports = new Set();
    for (const item of raw) {
      for (const p of item.Ports ?? []) {
        if (p.PublicPort) ports.add(p.PublicPort);
      }
    }
    return ports;
  }

  /**
   * Atomically lease the next free host port. Tries ports in order; a
   * HELD lease (cross-process race) moves to the next candidate. The
   * engine-level "port already allocated" (pre-check vs create race) is
   * handled by the caller re-invoking with the losing port blocked.
   */
  async function acquirePortLease(runId, blockedPorts = new Set()) {
    const range = parsePortRange(config?.batchAdbHostPortRange ?? '16370-16419');
    if (!range) {
      throw new BatchLifecycleError(E.PORT_POOL_EXHAUSTED, `BATCH_ADB_HOST_PORT_RANGE is malformed ('${config?.batchAdbHostPortRange}') — refusing to guess (fail closed)`, { status: 500 });
    }
    const leases = await db.resourceLease.findMany({ where: { resourceType: 'port' } });
    const taken = new Set(leases.filter((l) => l.leaseExpiresAt.getTime() > clock().getTime()).map((l) => Number(String(l.resourceKey).replace(/^port:/, ''))));
    const occupied = await liveOccupiedPorts();
    for (let port = range.start; port <= range.end; port += 1) {
      if (taken.has(port) || occupied.has(port) || blockedPorts.has(port)) continue;
      const res = await lease.acquire({
        resourceType: 'port',
        resourceKey: `port:${port}`,
        ownerRunId: runId,
        ownerLabel: 'batch-lifecycle',
        ttlMs: config?.batchPortLeaseTtlMs ?? 30 * 60_000,
        now: clock(),
      });
      if (res.acquired) return port;
      // HELD / RACE_LOST — another process owns it; try the next port.
    }
    throw new BatchLifecycleError(E.PORT_POOL_EXHAUSTED, `No free ADB host port in ${range.start}-${range.end} (leased or occupied)`, { details: { range: `${range.start}-${range.end}` } });
  }

  async function releasePortLease(runId, port) {
    if (port == null) return;
    try {
      await lease.release({ resourceType: 'port', resourceKey: `port:${port}`, ownerRunId: runId });
    } catch (err) {
      log.warn({ runId, port, error: err.message }, 'batch lifecycle: port lease release failed (ttl will expire it)');
    }
  }

  // ------------------------------------------------------------ run / adapter spec
  async function loadBatchRun(runId) {
    const run = await db.taskRun.findUnique({ where: { id: runId } });
    if (!run) throw new BatchLifecycleError(E.RUN_NOT_FOUND, `task run ${runId} not found`);
    if (!run.batchId || !run.identityId) {
      throw new BatchLifecycleError(E.RUN_NOT_FOUND, `task run ${runId} is not a batch run (no batch/identity lineage) — lifecycle ops are batch-only`, { status: 409 });
    }
    return run;
  }

  /** adapter spec for a run = its batch's configJson.adapter (validated shape). */
  async function adapterSpecForRun(run) {
    const batch = await db.batch.findUnique({ where: { id: run.batchId } });
    const spec = batch?.configJson?.adapter;
    if (!batch || !spec || spec.type !== 'container') {
      throw new BatchLifecycleError(E.RUN_STATE_INVALID, `batch ${run.batchId} has no 'container' adapter spec — lifecycle ops unavailable for this run`, { status: 409 });
    }
    return spec;
  }

  function assertIdentityCreatable(identity) {
    const blocked = ['DISABLED', ...IDENTITY_TERMINAL, 'CANCELLING', 'RETRY_WAIT'];
    if (!identity || IDENTITY_TERMINAL.includes(identity.status) || blocked.includes(identity.status)) {
      throw new BatchLifecycleError(E.IDENTITY_INVALID, `identity ${identity?.id} is not in a creatable state ('${identity?.status}')`, { status: 409 });
    }
  }

  /** Ownership gate for every op. Returns { run, container, verdict } or throws. */
  async function gate(runId, { allowLabelOnly = false } = {}) {
    const run = await loadBatchRun(runId);
    const c = await requireClient();
    // Resolve the container: prefer the DB-recorded id; fall back to the
    // deterministic name sweep (crash window where the DB write never landed).
    let info = null;
    let containerId = null;
    if (run.containerId) {
      try {
        info = await dcall('inspect', () => c.getContainer(run.containerId).inspect(), run.containerId);
        containerId = info.Id;
      } catch (err) {
        if (err.apiCode === E.CONTAINER_OP_FAILED && err.details?.dockerCode === DOCKER_ERROR.CONTAINER_NOT_FOUND) {
          info = null; // vanished — the name sweep may still find a different one
        } else if (isDaemonLevelError(err.details?.dockerCode)) throw err;
        else throw err;
      }
    }
    if (!info) {
      const managed = await listManagedContainers();
      for (const item of managed) {
        if (item.Labels?.[CONTAINER_LABELS.TASK_RUN_ID] === run.id) {
          try {
            info = await c.getContainer(item.Id).inspect();
            containerId = info.Id;
            break;
          } catch { /* gone */ }
        }
      }
    }
    if (!info) return { run, container: null, containerId: null, verdict: 'absent' };
    const v = ownershipVerdict(info.Config?.Labels ?? {}, run, containerId);
    if (v.verdict === 'mismatch') {
      await audited({
        actorUserId: null,
        action: 'batch_container.ownership_mismatch',
        resourceType: 'container',
        resourceId: containerId,
        status: 'refused',
        details: { runId: run.id, problems: v.problems },
      });
      throw new BatchLifecycleError(E.CONTAINER_OWNERSHIP_MISMATCH, `Refusing op on container ${String(containerId).slice(0, 12)}: label/DB disagreement (${v.problems.join('; ')})`, { details: { problems: v.problems } });
    }
    if (v.verdict === 'label-only' && !allowLabelOnly) {
      throw new BatchLifecycleError(E.CONTAINER_OWNERSHIP_MISMATCH, 'Container labels agree but the run row never recorded the containerId (crash window) — only the start/bind path may act on this', { status: 409, details: { problems: v.problems } });
    }
    return { run, container: info, containerId, verdict: v.verdict };
  }

  // ------------------------------------------------------------ health (app layer, MD §8.2)
  // Default probe = a genuine ADB CNXN handshake (apps/api/src/services/adb-cnxn-probe.js).
  // It is invoked with the DEVICE CONTAINER's bridge IP + container-side ADB
  // port (L2 on the device network) — never 127.0.0.1 (the api container's
  // loopback cannot see host-published ports; that publish is the human path).
  const probe = healthProbe ?? adbCnxnProbe;

  /**
   * Device-network self-attach (F-RDFA-2). The probe reaches adbd over L2 on
   * the device network, so the api container must ride that network too.
   * Self-attach at boot is IDEMPOTENT and LIVE (`docker network connect`
   * on a running container needs no restart) and SELF-HEALING: compose
   * recreates drop any manual attachment, the next boot re-attaches.
   *
   * Own-container lookup = the running container whose Config.Hostname
   * equals os.hostname() (compose sets the container hostname to the
   * container name; we read the same value back from inside).
   *
   * Failures are LOGGED, never fatal: the app must boot regardless; the
   * probe then fails closed with an actionable detail (no device-network
   * endpoint) instead of a silent healthy.
   */
  async function ensureDeviceNetworkSelfAttachment() {
    let c;
    try { c = await requireClient(); } catch { return; } // docker disabled — nothing to attach
    let name;
    try { name = await ensureDeviceNetwork(c, { log }); }
    catch (err) { log.error({ error: err.message }, 'batch lifecycle: device network ensure failed — L2 probe will fail closed'); return; }
    let self = null;
    try {
      const running = await c.listContainers({ all: false });
      const hn = os.hostname();
      self = running.find((ct) => ct.Config?.Hostname === hn) ?? null;
    } catch (err) { log.error({ error: err.message }, 'batch lifecycle: self-attach lookup failed'); return; }
    if (!self) {
      log.warn('batch lifecycle: could not locate own container (hostname match) — L2 probe will fail closed until the api container is on the device network');
      return;
    }
    try {
      const ins = await c.getContainer(self.Id).inspect();
      if (ins.NetworkSettings?.Networks?.[name]) return; // already attached (idempotent)
      await c.getNetwork(name).connect({ Container: self.Id });
      log.info({ container: String(self.Id).slice(0, 12), network: name }, 'batch lifecycle: api container attached to device network (L2 ADB probe path)');
    } catch (err) {
      log.error({ error: err.message, container: String(self.Id).slice(0, 12), network: name }, 'batch lifecycle: device network self-attach failed — L2 probe will fail closed');
    }
  }
  void ensureDeviceNetworkSelfAttachment();

  // ------------------------------------------------------------ CREATE (start path)
  /**
   * Sweep the run's PRIOR containers before creating (MD item 5: no
   * double-start). Verdict per prior container (ownershipVerdict):
   *   mismatch        → audit + ABORT (never touch a foreign container)
   *   ok / label-only → ours. Exactly one → ADOPT it (the crash-window
   *                  recovery: same identity, same volume, no double-start).
   *                  Zero  → fresh create below.
   *                  Two+  → ABORT (a one-run-two-live-containers state is
   *                  a bug; fail closed + audit, let a human reconcile).
   */
  async function sweepPriorAttempts(run) {
    const c = await requireClient();
    const managed = await listManagedContainers();
    const ours = [];
    for (const item of managed) {
      if (item.Labels?.[CONTAINER_LABELS.TASK_RUN_ID] !== run.id) continue;
      const v = ownershipVerdict(item.Labels ?? {}, run, item.Id);
      if (v.verdict === 'mismatch') {
        await audited({ actorUserId: null, action: 'batch_container.ownership_mismatch', resourceType: 'container', resourceId: item.Id, status: 'refused', details: { runId: run.id, problems: v.problems } });
        throw new BatchLifecycleError(E.CONTAINER_OWNERSHIP_MISMATCH, `Pre-create sweep found a mismatched container for run ${run.id} (${v.problems.join('; ')}) — refusing`, { details: { problems: v.problems } });
      }
      ours.push(item);
    }
    if (ours.length > 1) {
      await audited({ actorUserId: null, action: 'batch_container.sweep_aborted', resourceType: 'container', resourceId: null, status: 'refused', details: { runId: run.id, count: ours.length, ids: ours.map((x) => x.Id) } });
      throw new BatchLifecycleError(E.CONTAINER_OWNERSHIP_MISMATCH, `Run ${run.id} has ${ours.length} live containers claiming it — refusing to guess (reconcile required)`, { details: { ids: ours.map((x) => x.Id) } });
    }
    if (ours.length === 1) {
      const item = ours[0];
      // bind the DB half if the crash happened between create and the DB write
      if (run.containerId !== item.Id) {
        await db.taskRun.update({ where: { id: run.id }, data: { containerId: item.Id } });
        log.warn({ runId: run.id, containerId: String(item.Id).slice(0, 12) }, 'batch lifecycle: adopted crash-window container (created but DB-unbound)');
      }
      return { adopted: item };
    }
    return { adopted: null };
  }

  /**
   * Full start (MD Phase 3 item 3): sweep → volume safety → duplicate
   * mount check → port lease → create(labels) → DB bind → engine start →
   * app-layer health wait. Every failure path releases the port lease;
   * a made-but-unbound container is removed — nothing half-bound survives.
   * Port engine-collisions re-roll to the next pool port, bounded by the
   * pool size (never an unbounded loop).
   */
  async function startForRun(runId, actor = { label: 'worker' }) {
    const run = await loadBatchRun(runId);
    const spec = await adapterSpecForRun(run);
    const identity = await db.identity.findUnique({ where: { id: run.identityId } });
    if (!identity) throw new BatchLifecycleError(E.IDENTITY_INVALID, `identity ${run.identityId} not found`, { status: 404 });
    assertIdentityCreatable(identity);

    // RAM-G1: host-RAM admission — BEFORE the sweep/port-lease/docker create.
    // 503 RAM_GATE_DENIED → worker retry policy = RETRY_WAIT (pending kept,
    // nothing deleted, re-admit on the next attempt with fresh metrics).
    if (ramGate) {
      const adm = await ramGate.admit({ kind: 'run', entityKey: run.id, entityName: `run:${run.id}`, source: 'batch-start' });
      if (!adm.admitted) {
        await audited({
          actorUserId: actor.userId ?? null,
          action: 'batch_container.start_denied_ram',
          resourceType: 'container',
          resourceId: run.id,
          status: 'denied',
          details: { runId: run.id, identityId: run.identityId, reason: adm.reason, currentMiB: adm.currentMiB ?? null, projectedMiB: adm.projectedMiB ?? null, liveCount: adm.liveCount ?? null },
        });
        throw new BatchLifecycleError(
          E.RAM_GATE_DENIED,
          `host-RAM admission denied (${adm.reason}) — MemAvailable ${Math.round(adm.currentMiB ?? 0)} MiB, projected ${Math.round(adm.projectedMiB ?? 0)} MiB; run goes RETRY_WAIT and re-admits on the next attempt (MD G1: stop new boots, keep pending)`,
          { status: 503, details: { reason: adm.reason, currentMiB: adm.currentMiB ?? null, projectedMiB: adm.projectedMiB ?? null } },
        );
      }
    }

    const imageEntry = await resolveImageEntry(spec.image);
    const healthCfg = effectiveHealthProbe(spec);
    const c = await requireClient();
    const name = containerNameForRun(run.id, run.attempt ?? 1, config?.batchContainerNamePrefix ?? 'wa-batch-');

    // 1) sweep (FIRST — prior-attempt containers must not masquerade as
    //    "another identity's live mount" in the duplicate check below).
    const { adopted } = await sweepPriorAttempts(run);

    // 2) volume safety (MD item 1) — before anything touches docker.
    const source = await resolveVolumeSource(identity);

    // 3) duplicate writable mount source (MD §4.1): only a collision with a
    //    DIFFERENT identity is a conflict (same-identity leftovers were swept).
    const liveRows = await liveWritableMountRows();
    const dups = findDuplicateMountSources([{ id: identity.id, dataPath: source }, ...liveRows]);
    const conflict = dups.some((p) => p === source && liveRows.some((r) => r.dataPath === p && r.id !== identity.id));
    if (conflict) {
      await audited({
        actorUserId: null,
        action: 'batch_volume.mount_conflict_blocked',
        resourceType: 'identity',
        resourceId: identity.id,
        status: 'blocked',
        details: { duplicates: dups },
      });
      throw new BatchLifecycleError(E.MOUNT_SOURCE_CONFLICT, `Another identity's live container already mounts ${source} writable — two identities must never share one writable volume (MD §4.1)`, { details: { duplicates: dups } });
    }

    // 4) port lease + create + bind + start + health, bounded re-roll.
    const range = parsePortRange(config?.batchAdbHostPortRange ?? '16370-16419');
    if (!range) {
      throw new BatchLifecycleError(E.PORT_POOL_EXHAUSTED, `BATCH_ADB_HOST_PORT_RANGE is malformed ('${config?.batchAdbHostPortRange}') — refusing to guess (fail closed)`, { status: 500 });
    }
    const poolSize = range.end - range.start + 1;
    const tried = new Set();
    for (;;) {
      const port = await acquirePortLease(run.id, tried);
      try {
        return await createAndStart({ run, spec, identity, imageEntry, healthCfg, source, port, name, actor, c, adopted });
      } catch (err) {
        await releasePortLease(run.id, port);
        if (err?.apiCode === E.PORT_BIND_FAILED) {
          tried.add(port);
          if (tried.size >= poolSize) {
            throw new BatchLifecycleError(E.PORT_POOL_EXHAUSTED, `Every port in ${range.start}-${range.end} collided at the engine — pool exhausted`, { details: { range: `${range.start}-${range.end}` } });
          }
          continue; // next free port
        }
        throw err;
      }
    }
  }

  /** One create+start+health attempt on a leased port. */
  async function createAndStart({ run, spec, identity, imageEntry, healthCfg, source, port, name, actor, c, adopted }) {
    let createdId = null;
    if (adopted) {
      createdId = adopted.Id;
    } else {
      // BR-B6 G2: batch devices ride the DEDICATED device network — never
      // the default bridge (idempotent ensure; fail closed on engine error).
      await ensureDeviceNetwork(c, { log });
      const body = {
        Image: spec.image,
        Labels: buildContainerLabels({ identityId: run.identityId, batchId: run.batchId, taskRunId: run.id, createdBy: actor.label ?? 'batch-lifecycle' }),
        // (no NetworkMode — the explicit device-network endpoint wins)
        NetworkingConfig: { EndpointsConfig: { [deviceNetwork.name]: {} } },
        HostConfig: {
          PortBindings: { [portKey(healthCfg.containerPort)]: [{ HostIp: '127.0.0.1', HostPort: String(port) }] },
          Mounts: [{ Type: 'bind', Source: source, Target: '/data', ReadOnly: false }],
          Privileged: imageEntry.privileged === true,
        },
      };
      if (imageEntry.memoryBytes) body.HostConfig.Memory = Number(imageEntry.memoryBytes);
      if (imageEntry.nanoCpus) body.HostConfig.NanoCpus = Math.round(Number(imageEntry.nanoCpus) * 1e9);
      if (Array.isArray(imageEntry.cmd) && imageEntry.cmd.length > 0) body.Cmd = imageEntry.cmd;
      createdId = await doCreate(c, body, name, spec.image);
    }

    // DB bind — the second ownership half. If THIS write fails we must not
    // leave a managed container unbound: fail closed (remove + rethrow).
    try {
      await db.taskRun.update({ where: { id: run.id }, data: { containerId: createdId } });
    } catch (err) {
      log.error({ runId: run.id, error: err.message }, 'batch lifecycle: containerId bind failed — failing closed (removing the container)');
      await c.getContainer(createdId).stop().catch(() => {});
      await c.getContainer(createdId).remove({ force: true }).catch(() => {});
      throw new BatchLifecycleError(E.CONTAINER_OP_FAILED, 'DB bind of containerId failed — container removed, nothing claimed started', { status: 500, details: {} });
    }

    // engine start (a created-but-never-started container is not "started").
    try {
      await dcall('start', () => c.getContainer(createdId).start(), createdId);
    } catch (err) {
      await c.getContainer(createdId).remove({ force: true }).catch(() => {});
      await db.taskRun.update({ where: { id: run.id }, data: { containerId: null } }).catch(() => {});
      throw new BatchLifecycleError(E.CONTAINER_OP_FAILED, `engine start failed: ${err.message}`, { status: 502, details: { dockerCode: err.details?.dockerCode, retryable: true } });
    }

    // app-layer health wait (MD §8.2) — bounded; the container is LEFT on
    // timeout (the adapter's finally / reconcile owns the cleanup, and the
    // DB row keeps containerId so they can verify + remove it).
    const healthy = await waitHealthy(run, createdId, port, healthCfg);
    if (!healthy) {
      throw new BatchLifecycleError(E.CONTAINER_OP_FAILED, 'container started but the ADB handshake did not answer within the health window (boot failed or too slow)', { status: 503, details: { dockerCode: 'HEALTH_TIMEOUT', retryable: true, containerId: createdId, hostPort: port } });
    }

    await audited({
      actorUserId: null,
      action: 'batch_container.started',
      resourceType: 'container',
      resourceId: createdId,
      status: 'ok',
      details: { runId: run.id, identityId: run.identityId, batchId: run.batchId, image: spec.image, hostPort: port, privileged: imageEntry.privileged === true, name, adopted: Boolean(adopted) },
    });
    return { containerId: createdId, hostPort: port, name, healthy: true, adopted: Boolean(adopted) };
  }

  /** Engine create with the two deterministic retry paths (name race, port race). */
  async function doCreate(c, body, name, image) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const created = await dcall('create', () => c.createContainer({ _query: { name }, _body: body }), name);
        const id = typeof created?.id === 'string' ? created.id : created?.Id ?? null;
        if (!id || String(id).length < 12) throw new BatchLifecycleError(E.CONTAINER_OP_FAILED, 'create returned no container id', { status: 502, details: {} });
        return id;
      } catch (err) {
        if (err instanceof BatchLifecycleError && err.apiCode === E.CONTAINER_OP_FAILED) {
          const kind = err.details?.kind;
          if (kind === 'NAME_CONFLICT' && attempt === 0) continue; // one honest re-try (concurrent create race)
          if (kind === 'PORT_ALLOCATED') {
            throw new BatchLifecycleError(E.PORT_BIND_FAILED, 'host port collided at engine create time (pre-check vs create race)', { status: 503, details: { retryable: true } });
          }
          if (err.details?.dockerCode === DOCKER_ERROR.IMAGE_NOT_FOUND) {
            throw new BatchLifecycleError(E.CONTAINER_OP_FAILED, err.message, { status: 404, details: { dockerCode: DOCKER_ERROR.IMAGE_NOT_FOUND, retryable: false, image } });
          }
          if (kind === 'NAME_CONFLICT') {
            throw new BatchLifecycleError(E.CONTAINER_OP_FAILED, `container name '${name}' is held by a container this run does not own — refusing (reconcile required)`, { status: 409, details: { dockerCode: DOCKER_ERROR.GENERIC, retryable: false } });
          }
        }
        throw err;
      }
    }
    throw new BatchLifecycleError(E.CONTAINER_OP_FAILED, 'unreachable: create retry loop exited without a result', { status: 500, details: {} });
  }

  /** Bounded app-layer health wait. Also fails fast if the container dies mid-boot. */
  async function waitHealthy(run, containerId, port, healthCfg) {
    const c = await requireClient();
    const deadline = clock().getTime() + (config?.batchContainerHealthTimeoutMs ?? 60_000);
    const pollMs = config?.batchContainerHealthPollMs ?? 1_000;
    for (;;) {
      if (healthCfg.kind === 'none') return true;
      let state = 'unknown';
      let ip = null;
      try {
        const info = await c.getContainer(containerId).inspect();
        state = info.State?.Status ?? 'unknown';
        ip = info.NetworkSettings?.Networks?.[deviceNetwork.name]?.IPAddress ?? null;
      } catch { state = 'gone'; }
      if (state === 'exited' || state === 'dead' || state === 'gone') {
        log.error({ runId: run.id, containerId: String(containerId).slice(0, 12), state }, 'batch lifecycle: container died during boot health wait');
        return false;
      }
      if (!ip) {
        // Structural: running but NOT on the device network (a pre-G2
        // container handed to the batch adapter). Polling cannot fix this.
        log.error({ runId: run.id, containerId: String(containerId).slice(0, 12), network: deviceNetwork.name }, 'batch lifecycle: container has no device-network endpoint — cannot L2-probe');
        return false;
      }
      const r = await probe(ip, healthCfg.containerPort, config?.batchContainerHealthProbeTimeoutMs ?? 3_000);
      if (r.healthy) return true;
      if (clock().getTime() >= deadline) return false;
      await new Promise((res) => setTimeout(res, pollMs));
    }
  }

  // ------------------------------------------------------------ health (single probe)
  async function healthForRun(runId) {
    const { run, container, containerId, verdict } = await gate(runId);
    if (!container) {
      return { healthy: false, state: run.containerId ? 'gone' : 'unbound', detail: run.containerId ? 'recorded container no longer exists' : 'run has no containerId yet' };
    }
    const state = container.State?.Status ?? 'unknown';
    if (state !== 'running') return { healthy: false, state, detail: null, containerId };
    const spec = await adapterSpecForRun(run);
    const healthCfg = effectiveHealthProbe(spec);
    // host port binding — kept in the response for observability (the
    // human/adb-CLI path on 127.0.0.1). The PROBE itself goes over L2 to
    // the container's device-network IP (F-RDFA-2).
    const binds = container.HostConfig?.PortBindings ?? {};
    const bind = binds[portKey(healthCfg.containerPort)] ?? Object.values(binds)[0];
    const hostPort = bind?.[0]?.HostPort ? Number(bind[0].HostPort) : null;
    if (!hostPort) return { healthy: false, state, detail: 'no host port binding found', containerId };
    if (healthCfg.kind === 'none') {
      return { healthy: verdict === 'ok', state, detail: null, version: null, containerId, hostPort };
    }
    const ip = container.NetworkSettings?.Networks?.[deviceNetwork.name]?.IPAddress ?? null;
    if (!ip) return { healthy: false, state, detail: `container has no endpoint on '${deviceNetwork.name}' — cannot L2-probe`, containerId, hostPort };
    const r = await probe(ip, healthCfg.containerPort, config?.batchContainerHealthProbeTimeoutMs ?? 3_000);
    return { healthy: Boolean(r.healthy) && verdict === 'ok', state, detail: r.detail ?? null, version: r.version ?? null, containerId, hostPort };
  }

  // ------------------------------------------------------------ stop (reversible)
  async function stopForRun(runId, actor = { label: 'worker' }) {
    const { run, container, containerId, verdict } = await gate(runId, { allowLabelOnly: true });
    if (!container) return { stopped: false, wasRunning: false, detail: 'no container found for this run (already removed or never created)' };
    const c = await requireClient();
    const wasRunning = container.State?.Running === true;
    if (wasRunning) {
      await dcall('stop', () => c.getContainer(containerId).stop({ t: config?.batchContainerStopTimeoutSec ?? 10 }), containerId);
    }
    const port = boundHostPort(container);
    await releasePortLease(run.id, port);
    // RAM-G1: the container stopped → its RAM is freed → release the lease
    // (a fresh startForRun re-admits against fresh metrics).
    if (ramGate) {
      await ramGate.releaseByKey({ kind: 'run', entityKey: run.id, reason: 'stop-for-run' }).catch((err) => log.warn?.({ error: err.message }, 'ram-gate: release on stop failed'));
    }
    await audited({ actorUserId: actor.userId ?? null, action: 'batch_container.stopped', resourceType: 'container', resourceId: containerId, status: 'ok', details: { runId: run.id, wasRunning, volumeRetained: true, by: actor.label } });
    void verdict;
    return { stopped: true, wasRunning, containerId, volumeRetained: true };
  }

  function boundHostPort(container) {
    const binds = container.HostConfig?.PortBindings ?? {};
    for (const bindsList of Object.values(binds)) {
      if (Array.isArray(bindsList) && bindsList[0]?.HostPort) return Number(bindsList[0].HostPort);
    }
    return null;
  }

  // ------------------------------------------------------------ remove (container gone, volume kept)
  async function removeForRun(runId, actor = { label: 'worker' }) {
    const { run, container, containerId } = await gate(runId, { allowLabelOnly: true });
    if (!container) return { removed: false, detail: 'no container found for this run' };
    const c = await requireClient();
    if (container.State?.Running) {
      try {
        await c.getContainer(containerId).stop({ t: config?.batchContainerStopTimeoutSec ?? 10 });
      } catch (err) {
        if (!isDaemonLevelError(err?.details?.dockerCode)) throw err;
      }
    }
    await dcall('remove', () => c.getContainer(containerId).remove({ force: true }), containerId);
    const port = boundHostPort(container);
    await releasePortLease(run.id, port);
    // RAM-G1: the container is gone → release the lease (the identity DATA
    // volume is untouched — the gate never deletes data).
    if (ramGate) {
      await ramGate.releaseByKey({ kind: 'run', entityKey: run.id, reason: 'remove-for-run' }).catch((err) => log.warn?.({ error: err.message }, 'ram-gate: release on remove failed'));
    }
    const identity = await db.identity.findUnique({ where: { id: run.identityId } }).catch(() => null);
    await audited({
      actorUserId: actor.userId ?? null,
      action: 'batch_container.removed',
      resourceType: 'container',
      resourceId: containerId,
      status: 'ok',
      details: { runId: run.id, identityId: run.identityId, dataPath: identity?.dataPath ?? null, volumeRetained: true, by: actor.label },
    });
    return { removed: true, containerId, volumeRetained: true, dataPath: identity?.dataPath ?? null };
  }

  // ------------------------------------------------------------ purge (admin, human, dry-run + confirm)
  async function purgeIdentity(identityId, { dryRun = false, confirm, actor } = {}) {
    const identity = await db.identity.findUnique({ where: { id: identityId } });
    if (!identity) throw new BatchLifecycleError(E.IDENTITY_INVALID, `identity ${identityId} not found`, { status: 404 });
    // in-use guard: an active run on this identity forbids the data wipe.
    const active = await db.taskRun.findMany({ where: { identityId, status: { in: IDENTITY_ACTIVE_RUN_STATUSES } } });
    if (active.length > 0) {
      throw new BatchLifecycleError(E.RUN_STATE_INVALID, `identity has ${active.length} active run(s) — stop/cancel them before purging (MD §4.2)`, { status: 409, details: { runIds: active.map((r) => r.id) } });
    }
    const c = await requireClient();
    const managed = await listManagedContainers();
    const mine = managed.filter((m) => m.Labels?.[CONTAINER_LABELS.IDENTITY_ID] === identityId);
    const containers = [];
    for (const m of mine) {
      let info = null;
      try { info = await c.getContainer(m.Id).inspect(); } catch { /* gone */ }
      containers.push({ containerId: m.Id, name: (m.Names?.[0] ?? '').replace(/^\//, ''), state: info?.State?.Status ?? m.State ?? 'unknown', running: info?.State?.Running === true });
    }
    const dataPath = identity.dataPath;
    const rootReal = await fso.realpath(path.resolve(dataRoot()));
    const resolved = await fso.realpath(dataPath).catch(() => null);
    const inside = resolved != null && (resolved === rootReal || resolved.startsWith(rootReal + path.sep));
    if (dryRun) {
      let sizeBytes = 0;
      let fileCount = 0;
      let truncated = false;
      if (inside) {
        ({ sizeBytes, fileCount, truncated } = await measureDir(resolved));
      }
      return {
        dryRun: true,
        identityId,
        dataPath,
        dataExists: inside,
        dataInsideRoot: inside,
        sizeBytes,
        fileCount,
        truncated,
        containers,
        willDo: inside ? 'stop+remove containers, then rm -rf the data dir' : 'stop+remove containers ONLY — data dir is outside the data root (refused for deletion, reported)',
      };
    }
    if (confirm !== identityId) {
      throw new BatchLifecycleError(E.PURGE_CONFIRM_REQUIRED, 'purge requires confirm === identityId (MD §4.2: 確認參數必須等於被操作 object)', { status: 400 });
    }
    // execute: containers first (ownership-gated per run), then the data dir.
    for (const m of mine) {
      const runRow = await db.taskRun.findUnique({ where: { id: m.Labels[CONTAINER_LABELS.TASK_RUN_ID] } }).catch(() => null);
      const v = runRow ? ownershipVerdict(m.Labels ?? {}, runRow, m.Id) : { verdict: 'mismatch', problems: ['run row missing'] };
      if (v.verdict === 'mismatch') {
        await audited({ actorUserId: actor?.userId ?? null, action: 'batch_identity.purge_refused', resourceType: 'identity', resourceId: identityId, status: 'refused', details: { containerId: m.Id, problems: v.problems } });
        throw new BatchLifecycleError(E.CONTAINER_OWNERSHIP_MISMATCH, `Purge refused: container ${String(m.Id).slice(0, 12)} disagrees with its run row (${v.problems.join('; ')})`, { details: { problems: v.problems } });
      }
      const ct = c.getContainer(m.Id);
      if (m.State === 'running') await ct.stop({ t: config?.batchContainerStopTimeoutSec ?? 10 }).catch((err) => { if (!isDaemonLevelError(err?.details?.dockerCode)) throw err; });
      await ct.remove({ force: true });
    }
    let removed = false;
    let sizeBytes = 0;
    let fileCount = 0;
    if (inside && resolved) {
      ({ sizeBytes, fileCount } = await measureDir(resolved));
      await fso.rm(resolved, { recursive: true, force: true });
      removed = true;
    }
    await audited({
      actorUserId: actor?.userId ?? null,
      action: 'batch_identity.purged',
      resourceType: 'identity',
      resourceId: identityId,
      status: 'ok',
      details: { dataPath, removed, sizeBytes, fileCount, containers: containers.map((x) => x.containerId), by: actor?.label ?? 'admin' },
    });
    return { dryRun: false, identityId, dataPath, removed, sizeBytes, fileCount, containers: containers.map((x) => x.containerId) };
  }

  /** Recursive size walk with a file-count cap (bounded wall time). */
  async function measureDir(dir, cap = 200_000) {
    let sizeBytes = 0;
    let fileCount = 0;
    let truncated = false;
    async function walk(d) {
      let entries;
      try {
        entries = await fso.readdir(d, { withFileTypes: true });
      } catch { return; }
      for (const e of entries) {
        if (fileCount >= cap) { truncated = true; return; }
        const p = path.join(d, e.name);
        try {
          if (e.isDirectory()) await walk(p);
          else if (e.isFile()) {
            const st = await fso.stat(p);
            sizeBytes += st.size;
            fileCount += 1;
          }
        } catch { /* unreadable file — count nothing, keep going */ }
      }
    }
    await walk(dir);
    return { sizeBytes, fileCount, truncated };
  }

  // ------------------------------------------------------------ reconcile (MD item 3/5)
  /**
   * DB ↔ docker reconciliation. NEVER starts anything (no double-start,
   * MD item 5) — it only classifies, and with fix=true (admin) STOPS
   * orphans / stale containers. Mismatches are reported + audited, never
   * touched.
   */
  async function reconcile({ fix = false, actor = { label: 'reconciler' } } = {}) {
    const c = await requireClient();
    const managed = await listManagedContainers();
    const items = [];
    const seenRuns = new Set();
    for (const m of managed) {
      const runId = m.Labels[CONTAINER_LABELS.TASK_RUN_ID];
      seenRuns.add(runId);
      const run = await db.taskRun.findUnique({ where: { id: runId } }).catch(() => null);
      const problems = run ? ownershipVerdict(m.Labels ?? {}, run, m.Id).problems : ['run row missing'];
      const leaseAlive = run ? run.leaseExpiresAt != null && run.leaseExpiresAt.getTime() > clock().getTime() : false;
      // (let, not const: the TOCTOU re-check below may re-grade the verdict
      // to mismatch — a const here would throw inside the try and hide the
      // refusal behind a generic "fix failed" with no audit trail.)
      let v = reconcileVerdict({ run, containerRunning: m.State === 'running', leaseAlive, ownershipProblems: problems });
      let fixed = false;
      let fixedDetail = null;
      if (fix && v.fixable) {
        try {
          // TOCTOU: re-verify ownership right before the stop/remove.
          const info = await c.getContainer(m.Id).inspect();
          const re = run ? ownershipVerdict(info.Config?.Labels ?? {}, run, info.Id) : { verdict: 'mismatch', problems: ['run row missing'] };
          if (re.verdict === 'mismatch') {
            await audited({ actorUserId: actor.userId ?? null, action: 'batch_reconcile.fix_refused', resourceType: 'container', resourceId: m.Id, status: 'refused', details: { runId, problems: re.problems } });
            v = { ...v, state: 'mismatch', fixable: false, reason: `re-check at fix time: ${re.problems.join('; ')}` };
          } else {
            const ct = c.getContainer(m.Id);
            if (info.State?.Running) await ct.stop({ t: config?.batchContainerStopTimeoutSec ?? 10 });
            if (v.state === 'orphan') await ct.remove({ force: true });
            // BR-B6 (E2E run-4 leak): this IS a stop/remove path — every
            // stop must release the container's ADB host-port lease. The
            // sweep stops/removes directly (not via stopForRun/removeForRun,
            // which release the lease); bypassing them leaked 6 live port
            // leases in E2E run-4 (run-4 P5: ports=6), pinning pool ports
            // until the 30-min TTL.
            if (run) {
              for (const bindsList of Object.values(info.HostConfig?.PortBindings ?? {})) {
                if (Array.isArray(bindsList) && bindsList[0]?.HostPort) {
                  await releasePortLease(runId, Number(bindsList[0].HostPort));
                }
              }
            }
            fixed = true;
            fixedDetail = v.state === 'orphan' ? 'stopped+removed' : 'stopped';
            await audited({ actorUserId: actor.userId ?? null, action: 'batch_reconcile.fixed', resourceType: 'container', resourceId: m.Id, status: 'ok', details: { runId, state: v.state, fixedDetail } });
          }
        } catch (err) {
          fixedDetail = `fix failed: ${String(err?.message ?? err).slice(0, 160)}`;
          log.error({ runId, containerId: String(m.Id).slice(0, 12), error: err.message }, 'batch reconcile: fix action failed');
        }
      }
      items.push({
        containerId: m.Id,
        name: (m.Names?.[0] ?? '').replace(/^\//, ''),
        runId,
        identityId: m.Labels?.[CONTAINER_LABELS.IDENTITY_ID] ?? null,
        state: v.state,
        fixable: v.fixable,
        fixed,
        fixedDetail,
        reason: v.reason,
      });
    }
    // reverse pass: runs that point at containers docker doesn't know (db_only)
    // + active runs with no containerId at all (unbound — crash window).
    const runningRuns = await db.taskRun.findMany({ where: { status: { in: ['running'] }, containerId: { not: null } } });
    for (const r of runningRuns) {
      if (seenRuns.has(r.id)) continue;
      items.push({ containerId: r.containerId, name: null, runId: r.id, identityId: r.identityId, state: 'db_only', fixable: false, fixed: false, fixedDetail: null, reason: 'run is running and records a container docker no longer lists (removed out-of-band) — re-dispatch owns the re-run' });
    }
    const unbound = await db.taskRun.findMany({ where: { status: { in: ['running'] }, containerId: null } });
    for (const r of unbound) {
      if (seenRuns.has(r.id)) continue;
      items.push({ containerId: null, name: null, runId: r.id, identityId: r.identityId, state: 'unbound', fixable: false, fixed: false, fixedDetail: null, reason: 'run is running without a containerId (crash window) — the next attempt\u2019s create-sweep owns the cleanup' });
    }
    const counts = {};
    for (const it of items) counts[it.state] = (counts[it.state] ?? 0) + 1;
    await audited({ actorUserId: actor.userId ?? null, action: 'batch_reconcile.scanned', resourceType: 'batch', resourceId: null, status: 'ok', details: { scanned: items.length, counts, fix, by: actor.label } });
    return { scanned: items.length, counts, items };
  }

  // ------------------------------------------------------------ list (UI/B6)
  async function list() {
    const c = await requireClient();
    const managed = await listManagedContainers();
    const rows = [];
    for (const m of managed) {
      const runId = m.Labels?.[CONTAINER_LABELS.TASK_RUN_ID];
      const run = await db.taskRun.findUnique({ where: { id: runId } }).catch(() => null);
      const binds = {};
      try {
        const info = await c.getContainer(m.Id).inspect();
        for (const [k, list] of Object.entries(info.HostConfig?.PortBindings ?? {})) binds[k] = list?.[0]?.HostPort != null ? Number(list[0].HostPort) : null;
      } catch { /* vanished */ }
      rows.push({
        containerId: m.Id,
        name: (m.Names?.[0] ?? '').replace(/^\//, ''),
        image: m.Image ?? null,
        state: m.State,
        hostPorts: binds,
        runId,
        identityId: m.Labels?.[CONTAINER_LABELS.IDENTITY_ID] ?? null,
        batchId: m.Labels?.[CONTAINER_LABELS.BATCH_ID] ?? null,
        runStatus: run?.status ?? null,
        leaseAlive: run ? run.leaseExpiresAt != null && run.leaseExpiresAt.getTime() > clock().getTime() : null,
        createdSec: m.Created ?? null,
      });
    }
    return rows;
  }

  return {
    startForRun,
    healthForRun,
    stopForRun,
    removeForRun,
    purgeIdentity,
    reconcile,
    list,
    // test seams
    __probe: probe,
    __resolveVolumeSource: resolveVolumeSource,
    __acquirePortLease: acquirePortLease,
  };
}
