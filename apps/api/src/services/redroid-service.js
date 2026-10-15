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
import path from 'node:path';

import { DOCKER_ERROR } from '@water-army/shared';

import { DockerServiceError } from './docker-service.js';
import { checkPortAvailable, } from './preflight.js';
import { createAdbWhitelist } from './adb-whitelist.js';

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
} = {}) {
  const adbEngine = adb ?? createAdbWhitelist({
    adbBinary: config?.redroidAdbBinary,
    timeoutMs: config?.redroidAdbTimeoutMs,
    maxOutputBytes: config?.redroidAdbMaxOutput,
    logcatTailMax: config?.redroidLogcatTailMax,
    logcatTailDefault: config?.redroidLogcatTailDefault,
    log,
  });

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
    let row;
    try {
      row = await db.redroidTemplate.create({ data: t });
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
      details: { name: t.name, image: t.image, gpuMode: t.gpuMode, privileged: t.privileged },
    });
    return publicTemplate(row);
  }

  async function updateTemplate(id, patch, { actorUserId, requestId, ip } = {}) {
    const current = await db.redroidTemplate.findUnique({ where: { id } });
    if (!current) throw fail('REDROID_TEMPLATE_NOT_FOUND', 404, `Template '${id}' not found`);
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
    });
    let row;
    try {
      row = await db.redroidTemplate.update({ where: { id }, data: merged });
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
      details: { name: row.name, changed: Object.keys(patch) },
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
      if (entry?.state === 'done') return { device: entry.result, replay: true, preflight: entry.preflight ?? null };
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
        preflightResult = await preflight({ gpuMode: template.gpuMode === 'host', port: null });
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
            },
          });
          break;
        } catch (err) {
          if (err?.code === 'P2002') {
            if (String(err?.message ?? '').includes('(name)')) {
              throw fail('REDROID_NAME_TAKEN', 409, `Device name '${name}' already exists`);
            }
            if (String(err?.message ?? '').includes('adbPort') && attempt < portAttempts) continue;
            throw err;
          }
          throw err;
        }
      }

      if (idempotencyKey) createIdempotency.set(idempotencyKey, { state: 'pending', at: now });

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

  /** Roll back a failed create: DB row + the fresh data dir (never a pre-existing one). */
  async function rollback(row, dataDir, createdDir) {
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

    await db.device.delete({ where: { id: row.id } });
    await audit({
      actorUserId: actorUserId ?? null,
      action: 'redroid.device.delete',
      resourceType: 'redroid_device',
      resourceId: row.id,
      requestId: requestId ?? null,
      ip: ip ?? null,
      status: containerError ? 'failure' : 'success',
      details: { name: row.name, adbPort: row.adbPort, containerRemoved, removeData: Boolean(removeData), dataRemoved, dataRemoveError: dataRemoveError ?? undefined, containerError: containerError ?? undefined },
    });
    return { deleted: true, name: row.name, containerRemoved, removeData: Boolean(removeData), dataRemoved, dataRemoveError: dataRemoveError ?? undefined, containerError: containerError ?? undefined };
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
    return { device: deviceView(fresh), adbNote };
  }

  // ---- diagnostics (commit 4 builds on this seam) ----------------------------

  /** Run one whitelisted adb op against a device's loopback target (route commit 4). */
  async function runWhitelistedOp(idOrName, params, { actorUserId, requestId, ip } = {}) {
    const row = await findDevice(idOrName);
    if (!row) throw fail('REDROID_DEVICE_NOT_FOUND', 404, `Device '${idOrName}' not found`);
    const target = `127.0.0.1:${row.adbPort}`;
    try {
      const result = await adbEngine.run({ target, ...params });
      await db.device.update({ where: { id: row.id }, data: { lastDiagnosedAt: new Date() } }).catch(() => {});
      return { device: row.name, target, ...result };
    } catch (err) {
      if (err?.name === 'AdbWhitelistError') {
        const e = fail('VALIDATION_ERROR', 400, err.message);
        throw e;
      }
      throw err;
    }
  }

  // ---- preflight (real host check, MD §10.1) ---------------------------------

  async function getPreflight({ gpuMode, port } = {}) {
    if (!preflight) throw fail('REDROID_PREFLIGHT_UNAVAILABLE', 503, 'preflight is not configured on this service');
    try {
      return await preflight({ gpuMode: Boolean(gpuMode), port: Number.isInteger(port) ? port : null });
    } catch (err) {
      throw fail('REDROID_PREFLIGHT_UNAVAILABLE', 503, `preflight failed: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }

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
    runWhitelistedOp,
    getPreflight,
    // test/ops seams
    __allocateAdbPort: allocateAdbPort,
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
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

function deviceView(row, { withDataDir = false } = {}) {
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
    lastDiagnosedAt: row.lastDiagnosedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (withDataDir) view.dataDir = row.dataDir;
  return view;
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
