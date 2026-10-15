/**
 * DockerService — all Dockerode access for the API (施工 MD §9).
 * Routes talk to this service only; no route touches dockerode directly.
 *
 * Hard rules implemented here (MD §9.1 / §9.3 / §9.4, ADR §3-2-7):
 *  - Error classification: ONLY a definitive 404 / "no such container" is
 *    CONTAINER_NOT_FOUND. Daemon-down (socket errno), permission (EACCES) and
 *    timeout are distinct codes — never conflated with not-found.
 *  - State-mutating ops (start/stop/restart/pause/unpause): read current
 *    state first → already-at-target = idempotent success (no daemon call) →
 *    perform op → inspect AGAIN to confirm. Op API success with unchanged
 *    state = OPERATION_PENDING error, never a fake success.
 *  - Logs: bounded tail (default 500, max 5000) + byte cap (default 1 MiB).
 *  - Stats: a single container's sampling failure is a per-item partial
 *    error, never a 500 on the whole page.
 *  - Secrets: container env is masked server-side before it reaches a route.
 *
 * Injectable for tests: the `docker` wrapper (plugin shape
 * {disabled, client, ping}) may carry a fake dockerode-shaped client.
 */
import { DOCKER_ERROR, DOCKER_ERROR_STATUS, SENSITIVE_ENV_KEY, APP_LABELS } from '@water-army/shared';

/**
 * Service-level error carrying a stable API code + HTTP status.
 * The app-level error handler passes `apiCode` straight through.
 */
export class DockerServiceError extends Error {
  /**
   * @param {object} p
   * @param {string} p.code    stable API code (DOCKER_ERROR.* or route-level code)
   * @param {number} [p.status] HTTP status (defaults from DOCKER_ERROR_STATUS)
   * @param {string} [p.message]
   * @param {object} [p.details]
   */
  constructor({ code, status, message, details }) {
    super(message ?? code);
    this.name = 'DockerServiceError';
    this.apiCode = code;
    this.statusCode = status ?? DOCKER_ERROR_STATUS[code] ?? 500;
    this.details = details ?? undefined;
    this.statusCodeNum = this.statusCode;
  }
}

// ---------------------------------------------------------------------------
// Error classification (MD §9.1 unit-tested surface)
// ---------------------------------------------------------------------------

const SOCKET_ERRNO = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOENT',
  'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED', 'EISDIR',
]);
const SOCKET_MSG =
  /connect (ECONNREFUSED|ENOENT|EISDIR)|dial unix|use of closed network connection|client connection lost|broken pipe|EOF/i;
const PERMISSION_MSG = /permission denied|EACCES/i;
const TIMEOUT_MSG = /timed? ?out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i;
const NOT_FOUND_MSG = /no such (container|network|volume|image|object|task|exec|node)|not found/i;

/**
 * Classify a raw Dockerode/socket error into a stable code.
 *
 * Precedence (MD §9.1 hard rule — only a DEFINITIVE 404 is not-found;
 * socket/permission/timeout must never be read as "container gone"):
 *   1. daemon answered 404 (or "No such container") → CONTAINER_NOT_FOUND
 *   2. permission denied on the socket            → PERMISSION_DENIED
 *   3. socket-level failure (daemon down/path)    → DAEMON_UNAVAILABLE
 *   4. timeout                                    → TIMEOUT
 *   5. anything else                              → GENERIC
 *
 * @param {Error & {statusCode?: number, code?: string}} err
 * @returns {{code:string, status:number, message:string}}
 */
export function classifyDockerError(err) {
  const message = (err?.message ?? String(err ?? '')).trim() || 'docker error';

  // 1. definitive not-found: daemon answered 404, or its canonical wording.
  if (err?.statusCode === 404 || (err?.statusCode && err.statusCode < 500 && NOT_FOUND_MSG.test(message))) {
    return { code: DOCKER_ERROR.CONTAINER_NOT_FOUND, status: 404, message: `Container not found: ${message}` };
  }
  // 2. permission (EACCES on the socket — api missing docker group).
  if (err?.code === 'EACCES' || PERMISSION_MSG.test(message)) {
    return { code: DOCKER_ERROR.PERMISSION_DENIED, status: 502, message: 'Docker socket permission denied — check api docker group membership' };
  }
  // 3. daemon unavailable (socket connect failures).
  if (SOCKET_ERRNO.has(err?.code) || SOCKET_MSG.test(message)) {
    return { code: DOCKER_ERROR.DAEMON_UNAVAILABLE, status: 503, message: 'Docker daemon unavailable — socket not reachable (daemon down or wrong path)' };
  }
  // 4. timeout.
  if (err?.code === 'ETIMEDOUT' || err?.code === 'ESOCKETTIMEDOUT' || err?.statusCode === 408 || TIMEOUT_MSG.test(message)) {
    return { code: DOCKER_ERROR.TIMEOUT, status: 504, message: 'Docker operation timed out' };
  }
  // 5. unclassified — keep the original message (no secrets in engine errors).
  return { code: DOCKER_ERROR.GENERIC, status: 502, message };
}

/** Wrap a raw dockerode error in a DockerServiceError (context-stamped). */
function toServiceError(err, { operation, containerId } = {}) {
  if (err instanceof DockerServiceError) return err;
  const { code, status, message } = classifyDockerError(err);
  const e = new DockerServiceError({ code, status, message });
  e.operation = operation;
  e.containerId = containerId ?? null;
  e.cause = err;
  return e;
}

// ---------------------------------------------------------------------------
// Container env masking (MD §6.3 — sensitive values never leave the server)
// ---------------------------------------------------------------------------

/**
 * @param {string[] | Record<string,string>} env docker-style array or object
 * @returns {Array<{key:string, value:string, sensitive:boolean}>}
 */
export function maskContainerEnv(env) {
  const entries = Array.isArray(env)
    ? env.map((line) => {
        const eq = line.indexOf('=');
        return eq === -1 ? { key: line, value: '' } : { key: line.slice(0, eq), value: line.slice(eq + 1) };
      })
    : Object.entries(env ?? {}).map(([key, value]) => ({ key, value: String(value) }));

  return entries.map(({ key, value }) => {
    const sensitive = SENSITIVE_ENV_KEY.test(key);
    return {
      key,
      sensitive,
      // Non-sensitive values pass through; sensitive ones keep only shape (length).
      value: sensitive ? `••• (${String(value).length} chars)` : value,
    };
  });
}

// ---------------------------------------------------------------------------
// Log demux (docker multiplexed stream: 8-byte header frames)
// ---------------------------------------------------------------------------

/**
 * Decode a docker logs() Buffer. Handles the multiplexed 8-byte-header frame
 * format (stdout=1/stderr=2) and plain-text fallback.
 * @param {Buffer} buf
 * @returns {{lines: string[], truncated?: boolean}}
 */
export function demuxDockerLogs(buf) {
  const lines = [];
  if (!buf || buf.length === 0) return { lines };

  /** Push a chunk's lines; keep a leading empty line only if the result is still empty. */
  const pushChunk = (text) => {
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].length > 0 || (lines.length === 0 && i === 0)) lines.push(parts[i]);
    }
  };

  const framed = buf.length >= 8 && [0, 1, 2].includes(buf[0]) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!framed) {
    pushChunk(buf.toString('utf8'));
    return { lines };
  }

  let offset = 0;
  while (offset + 8 <= buf.length) {
    const streamId = buf[offset];
    const len = buf.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + len > buf.length) break; // torn frame after head-truncation — stop
    const chunk = buf.subarray(offset, offset + len);
    if (streamId === 1 || streamId === 2) pushChunk(chunk.toString('utf8'));
    offset += len;
  }
  return { lines };
}

// ---------------------------------------------------------------------------
// Stats summarization (single sample; MD §9.4)
// ---------------------------------------------------------------------------

/**
 * @param {object} s one docker stats({stream:false}) sample
 * @returns {{cpuPercent:number|null, memPercent:number|null, memUsageBytes:number, memLimitBytes:number, onlineCpus:number}}
 */
export function summarizeStats(s) {
  const cs = s?.cpu_stats ?? {};
  const pre = s?.precpu_stats ?? {};
  const cpuDelta = (cs.cpu_usage?.total_usage ?? 0) - (pre.cpu_usage?.total_usage ?? 0);
  const sysDelta = (cs.system_cpu_usage ?? 0) - (pre.system_cpu_usage ?? 0);
  const onlineCpus = cs.online_cpus ?? cs.cpu_usage?.percpu_usage?.length ?? 1;
  let cpuPercent = null;
  if (cpuDelta > 0 && sysDelta > 0) cpuPercent = Math.min(999.99, (cpuDelta / sysDelta) * onlineCpus * 100);

  const mem = s?.memory_stats ?? {};
  const memUsageBytes = mem.usage ?? 0;
  const memLimitBytes = mem.limit ?? 0;
  const memPercent = memLimitBytes > 0 ? Math.min(999.99, (memUsageBytes / memLimitBytes) * 100) : null;

  return {
    cpuPercent: cpuPercent === null ? null : Number(cpuPercent.toFixed(2)),
    memPercent: memPercent === null ? null : Number(memPercent.toFixed(2)),
    memUsageBytes,
    memLimitBytes,
    onlineCpus,
  };
}

// ---------------------------------------------------------------------------
// Managed rules (MD §11.2/§9.2 — app-managed only; admin exceptions)
// ---------------------------------------------------------------------------

const APP_SETTINGS_KEYS = Object.freeze({
  TEMPLATES: 'docker.templates',
  MANAGED_EXCEPTIONS: 'docker.managed_exceptions',
});

/**
 * Is this container modifiable by the app?
 *   - label app.managed=true → managed (created by this app via template)
 *   - else an admin-granted exception for its id/name → managed by exception
 * @param {object} p
 * @param {Record<string,string>} p.labels container labels
 * @param {string} [p.containerId]
 * @param {string} [p.name]
 * @param {Record<string, object>} [p.exceptions] exceptions map (id-or-name → grant)
 */
export function isManaged({ labels, containerId, name, exceptions }) {
  if (String(labels?.[APP_LABELS.MANAGED]) === 'true') {
    return { managed: true, byException: false };
  }
  const hit =
    (containerId && exceptions?.[containerId]) ||
    (name && exceptions?.[name]);
  return { managed: Boolean(hit), byException: Boolean(hit), grant: hit ?? null };
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {{disabled:boolean, client:object|null, ping:Function}} deps.docker
 * @param {object} deps.db      prisma client (appSetting for templates/exceptions)
 * @param {object} deps.config  API config (P2 docker knobs)
 * @param {object} [deps.log]   pino logger
 * @param {Function} [deps.audit] writeAudit (must be a no-op-safe function)
 */
export function createDockerService({ docker, db, config, log = { info() {}, warn() {}, error() {} }, audit = async () => {} }) {
  const client = docker?.client;

  function requireClient() {
    if (docker?.disabled) {
      throw new DockerServiceError({
        code: DOCKER_ERROR.DISABLED,
        message: 'Docker integration disabled via config (DOCKER_SOCKET_PATH empty)',
      });
    }
    if (!client) throw new DockerServiceError({ code: DOCKER_ERROR.DAEMON_UNAVAILABLE, message: 'Docker client not configured' });
    return client;
  }

  /** Run a dockerode call, classifying + logging any failure (MD §9.1). */
  async function call(op, fn, containerId) {
    try {
      return await fn();
    } catch (err) {
      const e = toServiceError(err, { operation: op, containerId });
      log.error(
        { op, containerId: containerId ?? null, code: e.apiCode, error: err?.message ?? String(err) },
        'docker operation failed',
      );
      throw e;
    }
  }

  /** app_settings JSON read (missing row → null). */
  async function readSetting(key, fallback) {
    try {
      const row = await db.appSetting.findUnique({ where: { key } });
      if (!row) return fallback;
      return row.valueJson ?? fallback;
    } catch (err) {
      log.error({ key, error: err.message }, 'app_setting read failed');
      return fallback;
    }
  }

  async function writeSetting(key, value, userId) {
    await db.appSetting.upsert({
      where: { key },
      update: { valueJson: value, updatedBy: userId ?? null },
      create: { key, valueJson: value, updatedBy: userId ?? null },
    });
  }

  // ---- read path -----------------------------------------------------------

  /**
   * List containers (MD §8). Filters: state (single or comma list),
   * managed ('true'/'false'), q (name/image/id substring). Server-side
   * pagination. withStats → per-container stats with bounded timeout and
   * per-item partial errors (MD §9.4).
   */
  async function listContainers({ state, managed, q, page = 1, pageSize = 50, withStats = false } = {}) {
    if (!Number.isInteger(page) || page < 1) {
      throw new DockerServiceError({ code: 'VALIDATION_ERROR', status: 400, message: 'page must be a positive integer' });
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      throw new DockerServiceError({ code: 'VALIDATION_ERROR', status: 400, message: 'pageSize must be an integer between 1 and 200' });
    }
    const c = requireClient();
    const raw = await call('list', () => c.listContainers({ all: true }));

    // P6 (flag #1): managed = label OR admin exception (MD §11.2) — the SAME
    // rule the mutation gate applies. The managed=true/false filter must use
    // this computed value, or the list contradicts the gate (P3 carry-over:
    // the list filtered label-only while start/stop/delete honored
    // exceptions).
    const entries = await listExceptions();
    let items = raw.map((r) => {
      const base = summarizeListItem(r);
      const m = isManaged({ labels: r.Labels ?? {}, containerId: base.id, name: base.name, exceptions: entries });
      return { ...base, managed: m.managed, managedByException: m.byException };
    });

    if (state) {
      const states = String(state).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (states.length) items = items.filter((i) => states.includes(i.state));
    }
    if (managed === true || managed === 'true') items = items.filter((i) => i.managed);
    if (managed === false || managed === 'false') items = items.filter((i) => !i.managed);
    if (q) {
      const needle = String(q).toLowerCase();
      items = items.filter(
        (i) =>
          i.name.toLowerCase().includes(needle) ||
          i.image.toLowerCase().includes(needle) ||
          i.id.toLowerCase().includes(needle) ||
          i.shortId.toLowerCase().includes(needle),
      );
    }

    items.sort((a, b) => a.name.localeCompare(b.name));

    const total = items.length;
    const start = (page - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);

    if (withStats) {
      await Promise.all(
        pageItems.map(async (item) => {
          item.stats = await statsForListItem(item, c);
        }),
      );
    }

    return { items: pageItems, page, pageSize, total };
  }

  async function statsForListItem(item, c) {
    const timeoutMs = config.dockerStatsTimeoutMs ?? 3000;
    try {
      const sample = await withTimeout(
        call('stats', () => c.getContainer(item.id).stats({ stream: false }), item.id),
        timeoutMs,
        `stats for ${item.name}`,
      );
      return summarizeStats(typeof sample === 'string' ? safeJsonParse(sample) : sample);
    } catch (err) {
      // MD §9.4: one container's stats failure must not 500 the page.
      const code = err instanceof DockerServiceError ? err.apiCode : classifyDockerError(err).code;
      return { error: code };
    }
  }

  /**
   * Inspect summary (MD §6.3 Overview). Env is masked (MD §6.3/§13.3).
   */
  async function inspectSummary(idOrName) {
    const c = requireClient();
    const info = await call('inspect', () => c.getContainer(idOrName).inspect(), idOrName);
    const labels = info?.Config?.Labels ?? {};
    const state = info?.State ?? {};
    const mounts = (info?.Mounts ?? []).map((m) => ({
      type: m.Type,
      source: m.Source ?? null,
      destination: m.Destination,
      readOnly: Boolean(m.RW === false),
    }));
    return {
      id: info?.Id ?? idOrName,
      shortId: String(info?.Id ?? idOrName).slice(0, 12),
      name: String(info?.Name ?? '').replace(/^\//, ''),
      image: info?.Config?.Image ?? info?.Image ?? 'unknown',
      state: {
        status: state.Status ?? 'unknown',
        running: Boolean(state.Running),
        paused: Boolean(state.Paused),
        restarting: Boolean(state.Restarting),
        dead: Boolean(state.Dead),
        startedAt: state.StartedAt ?? null,
        finishedAt: state.FinishedAt ?? null,
        exitCode: state.ExitCode ?? null,
        health: state.Health ? { status: state.Health.Status ?? 'none' } : null,
      },
      created: info?.Created ?? null,
      command: info?.Config?.Cmd ?? null,
      restartCount: state.RestartCount ?? 0,
      // P6 (flag #1): service-level managed = label OR exception (same rule
      // as list + mutation gate) — the route no longer re-derives it.
      ...managedSummary(labels, String(info?.Id ?? idOrName), String(info?.Name ?? '').replace(/^\//, ''), await listExceptions()),
      template: labels[APP_LABELS.TEMPLATE] ?? null,
      createdBy: labels[APP_LABELS.CREATED_BY] ?? null,
      ports: summarizePorts(info?.NetworkSettings?.Ports),
      networkMode: info?.HostConfig?.NetworkMode ?? 'default',
      privileged: Boolean(info?.HostConfig?.Privileged),
      mounts,
      env: maskContainerEnv(info?.Config?.Env),
      labels,
    };
  }

  /**
   * Container logs (MD §9.4): bounded tail + byte cap + optional since.
   * @returns {{lines:string[], truncated:boolean, byteLength:number, container:{id:string, name:string}}}
   */
  async function getLogs(idOrName, { tail, since } = {}) {
    const c = requireClient();
    const requestedTail = tail ?? config.dockerLogTailDefault ?? 500;
    const tailCap = config.dockerLogTailMax ?? 5000;
    const byteLimit = config.dockerLogByteLimit ?? 1_048_576;
    if (!Number.isInteger(requestedTail) || requestedTail < 1) {
      throw new DockerServiceError({ code: 'VALIDATION_ERROR', status: 400, message: 'tail must be a positive integer' });
    }
    const safeTail = Math.min(requestedTail, tailCap);
    const sinceArg = normalizeSince(since);

    // Resolve name→id first (inspect classifies 404 correctly).
    const info = await call('inspect', () => c.getContainer(idOrName).inspect(), idOrName);
    const rawBuf = await call(
      'logs',
      () =>
        c
          .getContainer(info.Id)
          .logs({ tail: safeTail, stdout: true, stderr: true, since: sinceArg }),
      info.Id,
    );

    let buf = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf);
    let truncated = false;
    if (buf.length > byteLimit) {
      buf = buf.subarray(buf.length - byteLimit); // keep the TAIL (newest)
      truncated = true;
    }
    const { lines } = demuxDockerLogs(buf);
    return {
      lines,
      truncated,
      byteLength: buf.length,
      container: { id: info.Id, name: String(info?.Name ?? '').replace(/^\//, '') },
    };
  }

  /**
   * One stats sample for a container. Throws classified DockerServiceError
   * (timeout etc.) — callers decide whether that is fatal (single fetch) or
   * partial (list withStats).
   */
  async function getStats(idOrName) {
    const c = requireClient();
    const sample = await call('stats', () => c.getContainer(idOrName).stats({ stream: false }), idOrName);
    return summarizeStats(typeof sample === 'string' ? safeJsonParse(sample) : sample);
  }

  // ---- managed mutations (MD §9.3 idempotent ops) --------------------------

  /**
   * Perform start/stop/restart/pause/unpause with the §9.3 protocol:
   * inspect → (already at target? idempotent success) → op → inspect confirm
   * → unchanged? OPERATION_PENDING.
   *
   * @param {string} idOrName
   * @param {'start'|'stop'|'restart'|'pause'|'unpause'} action
   * @returns {Promise<{id:string, name:string, state:string, idempotent:boolean, action:string}>}
   */
  async function runAction(idOrName, action) {
    const c = requireClient();
    const info = await call('inspect', () => c.getContainer(idOrName).inspect(), idOrName);
    const id = info.Id;
    const name = String(info?.Name ?? '').replace(/^\//, '');
    const current = info?.State?.Status ?? 'unknown';
    const target = TARGET_STATE[action];
    if (!target) throw new DockerServiceError({ code: 'VALIDATION_ERROR', status: 400, message: `unknown action: ${action}` });

    const container = () => c.getContainer(id);

    // Restart semantics: always performs (its point is to restart), but a
    // dead container cannot be restarted by the engine — fail clearly.
    if (action === 'restart') {
      if (current === 'dead') {
        throw new DockerServiceError({
          code: DOCKER_ERROR.GENERIC,
          status: 409,
          message: `Container '${name}' is in state 'dead' — it cannot be restarted; delete and recreate it`,
        });
      }
      await call('restart', () => container().restart({ t: config.dockerStopTimeoutSec ?? 10 }), id);
      const after = await call('inspect', () => container().inspect(), id);
      const state = after.State.Status;
      if (state !== 'running') throw pendingError(name, 'restart', state);
      return { id, name, state, idempotent: false, action };
    }

    // start/stop/pause/unpause: idempotent when already at target.
    if (action === 'start' && current === 'running') return { id, name, state: current, idempotent: true, action };
    if ((action === 'stop') && (current === 'exited' || current === 'dead')) return { id, name, state: current, idempotent: true, action };
    if (action === 'pause' && current === 'paused') return { id, name, state: current, idempotent: true, action };
    if (action === 'unpause' && current === 'running') return { id, name, state: current, idempotent: true, action };

    // Guard the preconditions the engine would reject opaquely.
    if (action === 'start' && current === 'dead') {
      throw new DockerServiceError({ code: DOCKER_ERROR.GENERIC, status: 409, message: `Container '${name}' is in state 'dead' — delete and recreate it` });
    }
    if (action === 'pause' && current !== 'running') {
      throw new DockerServiceError({ code: DOCKER_ERROR.GENERIC, status: 409, message: `Cannot pause: container '${name}' is ${current}, not running` });
    }
    if (action === 'unpause' && current !== 'paused') {
      throw new DockerServiceError({ code: DOCKER_ERROR.GENERIC, status: 409, message: `Cannot unpause: container '${name}' is ${current}, not paused` });
    }

    if (action === 'stop') {
      await call('stop', () => container().stop({ t: config.dockerStopTimeoutSec ?? 10 }), id);
    } else if (action === 'start') {
      await call('start', () => container().start(), id);
    } else if (action === 'pause') {
      await call('pause', () => container().pause(), id);
    } else if (action === 'unpause') {
      await call('unpause', () => container().unpause(), id);
    }

    const after = await call('inspect', () => container().inspect(), id);
    const state = after.State.Status;
    if (state !== target) throw pendingError(name, action, state);
    return { id, name, state, idempotent: false, action };
  }

  /**
   * Delete (MD §9 / §13.2 admin-only, called by the admin-guarded route).
   * Binds are NEVER removed by docker rm (only with explicit flag do
   * anonymous/named volumes go). confirm must echo the container name or id.
   */
  async function deleteContainer(idOrName, { confirm, removeVolumes = false, force = false }) {
    const c = requireClient();
    const info = await call('inspect', () => c.getContainer(idOrName).inspect(), idOrName);
    const id = info.Id;
    const name = String(info?.Name ?? '').replace(/^\//, '');

    const confirmValue = String(confirm ?? '').trim();
    if (!confirmValue || (confirmValue !== name && confirmValue !== id)) {
      throw new DockerServiceError({
        code: 'VALIDATION_ERROR',
        status: 400,
        message: 'confirm must repeat the container name or id exactly (two-step confirmation)',
      });
    }

    const hadBinds = (info?.Mounts ?? []).some((m) => m.Type === 'bind');
    await call('remove', () => c.getContainer(id).remove({ v: Boolean(removeVolumes), force: Boolean(force) }), id);

    // Confirm deletion: a successful inspect afterwards = it is still there.
    let gone = false;
    try {
      await c.getContainer(id).inspect();
    } catch (err) {
      gone = err?.statusCode === 404 || NOT_FOUND_MSG.test(err?.message ?? '');
    }
    if (!gone) {
      throw new DockerServiceError({
        code: DOCKER_ERROR.OPERATION_PENDING,
        message: `Delete API succeeded but container '${name}' still inspects — verify in daemon`,
      });
    }
    return { id, name, deleted: true, removeVolumes: Boolean(removeVolumes), bindsPreserved: hadBinds && !removeVolumes };
  }

  // ---- templates + create (MD §9.2) ----------------------------------------

  /**
   * Validate a template definition (MD §9.2). Exported for unit tests.
   * Throws DockerServiceError (VALIDATION_ERROR, 400) on any violation.
   */
  function validateTemplate(t, { existingNetworks = null } = {}) {
    const problems = [];
    const fail = (msg) => problems.push(msg);

    if (!t || typeof t !== 'object') fail('template must be an object');
    const id = String(t?.id ?? '');
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) fail('id must be 1-40 chars, lowercase alnum/_/-, starting alnum');
    const displayName = String(t?.displayName ?? '');
    if (!displayName.trim() || displayName.length > 60 || displayName !== displayName.trim()) {
      fail('displayName must be 1-60 chars with no leading/trailing whitespace');
    }

    const image = String(t?.image ?? '');
    if (!/^[a-z0-9][a-z0-9._/-]*(:[a-z0-9][a-z0-9._-]*)?(@sha256:[a-f0-9]{64})?$/.test(image)) {
      fail('image must be a valid explicit image reference');
    } else {
      // The tail after the last '/' may only carry tag/digest separators
      // (registry ports always precede a '/').
      const tail = image.slice(image.lastIndexOf('/') + 1);
      if (!/[:@]/.test(tail)) {
        fail('image must be explicitly tagged (e.g. alpine:3.20) or digest-pinned — no untagged/implicit latest');
      } else if (/(^|:)latest$/i.test(tail)) {
        fail('image tag "latest" is not allowed — pin an explicit version (MD §2-2)');
      }
    }

    const cpu = t?.cpuLimit;
    if (cpu !== undefined && (!Number.isFinite(cpu) || cpu <= 0 || cpu > 128)) fail('cpuLimit must be a number > 0 (cores, ≤128)');
    const mem = t?.memoryLimitBytes;
    if (mem !== undefined && (!Number.isInteger(mem) || mem < 8 * 1024 * 1024 || mem > 512 * 1024 ** 3)) {
      fail('memoryLimitBytes must be an integer between 8 MiB and 512 GiB');
    }

    // Ports: fixed container ports + host-port ranges.
    const ports = t?.ports ?? [];
    if (!Array.isArray(ports)) fail('ports must be an array');
    const seenContainerPorts = new Set();
    for (const p of ports) {
      const cp = p?.containerPort;
      const proto = String(p?.protocol ?? 'tcp');
      if (!Number.isInteger(cp) || cp < 1 || cp > 65535) {
        fail('ports[].containerPort must be an integer 1-65535');
        continue;
      }
      if (!['tcp', 'udp'].includes(proto)) fail('ports[].protocol must be tcp or udp');
      const key = `${cp}/${proto}`;
      if (seenContainerPorts.has(key)) fail(`duplicate ports entry ${key}`);
      seenContainerPorts.add(key);
      const min = p?.hostPortMin ?? 1;
      const max = p?.hostPortMax ?? 65535;
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 65535 || min > max) {
        fail(`ports[] hostPortMin/hostPortMax must be integers 1-65535 with min ≤ max (got ${min}-${max})`);
      }
    }

    // Env allowlist: exact keys.
    const envKeys = t?.allowedEnvKeys ?? [];
    if (!Array.isArray(envKeys) || envKeys.some((k) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(String(k)))) {
      fail('allowedEnvKeys must be an array of valid env key names');
    }

    // Command override.
    if (t?.command !== undefined && !Array.isArray(t.command)) fail('command must be an array of strings when set');
    if (t?.allowCommandOverride !== undefined && typeof t.allowCommandOverride !== 'boolean') {
      fail('allowCommandOverride must be a boolean');
    }

    // Volumes (MD §9.2: no /, no docker.sock, no /proc or unapproved host dirs).
    const FORBIDDEN_HOST_PATHS = ['/', '/var/run/docker.sock', '/proc', '/dev', '/sys', '/boot', '/root', '/etc', '/home', '/var/lib/docker'];
    const allowedHostPaths = t?.allowedHostPaths ?? [];
    if (!Array.isArray(allowedHostPaths)) fail('allowedHostPaths must be an array');
    for (const hp of allowedHostPaths) {
      if (typeof hp !== 'string' || !hp.startsWith('/')) fail(`allowedHostPaths entries must be absolute paths (got ${String(hp)})`);
      else if (FORBIDDEN_HOST_PATHS.includes(hp)) fail(`allowedHostPaths entry '${hp}' is forbidden (MD §9.2)`);
    }

    const volumes = t?.volumes ?? [];
    if (!Array.isArray(volumes)) fail('volumes must be an array');
    for (const v of volumes) {
      const cp = v?.containerPath;
      if (typeof cp !== 'string' || !cp.startsWith('/')) fail('volumes[].containerPath must be an absolute path');
      const type = v?.type ?? 'volume';
      if (!['volume', 'bind'].includes(type)) fail("volumes[].type must be 'volume' or 'bind'");
      if (type === 'volume' && v?.name !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}$/.test(String(v.name))) {
        fail('volumes[].name must be a valid named-volume name');
      }
      if (type === 'bind') {
        const hp = String(v?.hostPath ?? '');
        if (!hp.startsWith('/')) fail('bind volumes require an absolute hostPath');
        else if (FORBIDDEN_HOST_PATHS.includes(hp)) fail(`bind hostPath '${hp}' is forbidden (MD §9.2)`);
        else if (!allowedHostPaths.includes(hp)) fail(`bind hostPath '${hp}' is not in this template's allowedHostPaths`);
      }
      if (v?.readOnly !== undefined && typeof v.readOnly !== 'boolean') fail('volumes[].readOnly must be a boolean');
    }

    // Network (MD §9.2: host PID/network never; redroid-class special
    // privileges only via explicit privileged + reason).
    const network = t?.network ?? 'bridge';
    if (typeof network !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(network)) {
      fail('network must be a valid docker network name (default: bridge)');
    } else if (network === 'host' || network === 'none') {
      fail(`network '${network}' is not allowed for managed templates`);
    } else if (existingNetworks && network !== 'bridge' && !existingNetworks.includes(network)) {
      fail(`network '${network}' does not exist on this daemon`);
    }

    if (t?.privileged !== undefined && typeof t.privileged !== 'boolean') fail('privileged must be a boolean');
    const privilegedReason = String(t?.privilegedReason ?? '').trim();
    if (t?.privileged === true && (privilegedReason.length < 10 || privilegedReason.length > 200)) {
      fail('privileged=true requires a privilegedReason of 10-200 chars (redroid-class exception, MD §9.2)');
    }
    // host PID is never expressible in managed templates (no field for it).
    if (t?.pidMode !== undefined) fail('pidMode is not allowed in managed templates (host PID forbidden)');

    if (problems.length) {
      throw new DockerServiceError({ code: 'VALIDATION_ERROR', status: 400, message: problems.join('; ') });
    }

    // Normalized copy — the ONLY shape that gets stored/used (no stray keys).
    return {
      id,
      displayName: String(t.displayName),
      image,
      cpuLimit: cpu === undefined ? null : cpu,
      memoryLimitBytes: mem === undefined ? null : mem,
      ports: ports.map((p) => ({
        containerPort: p.containerPort,
        protocol: String(p.protocol ?? 'tcp'),
        hostPortMin: p.hostPortMin ?? 1,
        hostPortMax: p.hostPortMax ?? 65535,
      })),
      allowedEnvKeys: [...envKeys].map(String),
      command: Array.isArray(t.command) ? t.command.map(String) : null,
      allowCommandOverride: Boolean(t.allowCommandOverride),
      volumes: volumes.map((v) => ({
        containerPath: v.containerPath,
        type: v.type ?? 'volume',
        name: v.name !== undefined ? String(v.name) : null,
        hostPath: v.hostPath !== undefined ? String(v.hostPath) : null,
        readOnly: Boolean(v.readOnly),
      })),
      allowedHostPaths: [...allowedHostPaths].map(String),
      network,
      privileged: Boolean(t.privileged),
      privilegedReason: t.privileged ? privilegedReason : null,
    };
  }

  async function listTemplates() {
    const doc = await readSetting(APP_SETTINGS_KEYS.TEMPLATES, { version: 1, templates: [] });
    return doc?.templates ?? [];
  }

  /**
   * Upsert a template (admin). Validates against the live daemon's network
   * list when the daemon is reachable; daemon down → network existence is
   * skipped but nothing else is relaxed.
   * @returns {{template:object, created:boolean}}
   */
  async function upsertTemplate(input, { actorUserId, requestId, ip, auditAction } = {}) {
    let existingNetworks = null;
    try {
      const c = requireClient();
      existingNetworks = (await c.listNetworks()).map((n) => n.Name);
    } catch (err) {
      if (!(err instanceof DockerServiceError && err.apiCode === DOCKER_ERROR.DISABLED)) {
        log.warn({ error: err?.message }, 'listNetworks unavailable — template network check skipped');
      }
    }
    const template = validateTemplate(input, { existingNetworks });

    const doc = await readSetting(APP_SETTINGS_KEYS.TEMPLATES, { version: 1, templates: [] });
    const templates = doc?.templates ?? [];
    const idx = templates.findIndex((t) => t.id === template.id);
    const created = idx === -1;
    if (created) templates.push(template);
    else templates[idx] = { ...templates[idx], ...template };
    await writeSetting(APP_SETTINGS_KEYS.TEMPLATES, { version: 1, templates }, actorUserId);

    await audit({
      actorUserId: actorUserId ?? null,
      action: auditAction ?? (created ? 'template.create' : 'template.update'),
      resourceType: 'template',
      resourceId: template.id,
      requestId: requestId ?? null,
      ip: ip ?? null,
      status: 'success',
      details: { templateId: template.id, image: template.image, privileged: template.privileged },
    });
    return { template, created };
  }

  async function getTemplate(templateId) {
    const templates = await listTemplates();
    return templates.find((t) => t.id === templateId) ?? null;
  }

  // ---- managed exceptions (admin) ------------------------------------------

  async function listExceptions() {
    const doc = await readSetting(APP_SETTINGS_KEYS.MANAGED_EXCEPTIONS, { version: 1, entries: {} });
    return doc?.entries ?? {};
  }

  async function grantException({ containerId, name, note }, { actorUserId, requestId, ip } = {}) {
    const entries = await listExceptions();
    // Prefer the daemon id; fall back to the given name as the key.
    const key = containerId || name;
    if (!key) throw new DockerServiceError({ code: 'VALIDATION_ERROR', status: 400, message: 'containerId or name required' });
    entries[key] = { containerId: containerId ?? null, name: name ?? null, note: String(note ?? '').slice(0, 200), grantedBy: actorUserId ?? null, grantedAt: new Date().toISOString() };
    await writeSetting(APP_SETTINGS_KEYS.MANAGED_EXCEPTIONS, { version: 1, entries }, actorUserId);
    await audit({
      actorUserId: actorUserId ?? null,
      action: 'docker.exception.grant',
      resourceType: 'container',
      resourceId: key,
      requestId: requestId ?? null,
      ip: ip ?? null,
      status: 'success',
      details: { key, note: entries[key].note },
    });
    return entries[key];
  }

  async function revokeException(key, { actorUserId, requestId, ip } = {}) {
    const entries = await listExceptions();
    if (!entries[key]) {
      throw new DockerServiceError({ code: 'NOT_FOUND', status: 404, message: `No managed exception for '${key}'` });
    }
    delete entries[key];
    await writeSetting(APP_SETTINGS_KEYS.MANAGED_EXCEPTIONS, { version: 1, entries }, actorUserId);
    await audit({
      actorUserId: actorUserId ?? null,
      action: 'docker.exception.revoke',
      resourceType: 'container',
      resourceId: key,
      requestId: requestId ?? null,
      ip: ip ?? null,
      status: 'success',
      details: {},
    });
    return true;
  }

  // ---- container creation from template (MD §9.2) -------------------------

  /**
   * Idempotency registry for create (MD §9.2 防雙擊). In-process Map with
   * TTL — an API restart loses keys, and the name-collision check is the
   * durable backstop (docker container names are unique).
   */
  const createIdempotency = new Map(); // key → {state:'pending'|'done', at, result?}

  function sweepIdempotency(now) {
    for (const [k, v] of createIdempotency) {
      if (now - v.at > (config.dockerIdempotencyTtlMs ?? 600_000)) createIdempotency.delete(k);
    }
  }

  /**
   * Create a container STRICTLY from a template (MD §9.2):
   *  - no arbitrary Docker payload / HostConfig ever reaches this function
   *  - name + ports validated server-side, uniqueness + conflict checks
   *  - labels app.managed=true / app.template / app.created-by
   *  - idempotency key → double-click replay returns the original result
   * @returns {Promise<{container:object, replay:boolean}>}
   */
  async function createContainerFromTemplate(input, { actorUserId, requestId, ip } = {}) {
    const { templateId, name, ports, env, command, idempotencyKey } = input;
    const now = Date.now();
    sweepIdempotency(now);

    const entry = createIdempotency.get(idempotencyKey);
    if (entry?.state === 'done') {
      return { container: entry.result, replay: true };
    }
    if (entry?.state === 'pending' && now - entry.at <= (config.dockerIdempotencyTtlMs ?? 600_000)) {
      throw new DockerServiceError({
        code: 'CREATE_IN_PROGRESS',
        status: 409,
        message: 'A container creation with this idempotency key is still in progress — wait for it to finish',
      });
    }

    const template = await getTemplate(templateId);
    if (!template) {
      throw new DockerServiceError({ code: 'TEMPLATE_NOT_FOUND', status: 404, message: `Template '${templateId}' does not exist` });
    }

    // --- field validation against the template allowlist ---
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name)) {
      throw new DockerServiceError({ code: 'VALIDATION_ERROR', status: 400, message: 'Invalid container name' });
    }

    const wantedPorts = Array.isArray(ports) ? ports : [];
    for (const p of wantedPorts) {
      const allowed = template.ports.find((t) => t.containerPort === p.containerPort && t.protocol === (p.protocol ?? 'tcp'));
      if (!allowed) {
        throw new DockerServiceError({
          code: 'VALIDATION_ERROR',
          status: 400,
          message: `Port ${p.containerPort}/${p.protocol ?? 'tcp'} is not allowed by template '${templateId}'`,
        });
      }
      if (p.hostPort < allowed.hostPortMin || p.hostPort > allowed.hostPortMax) {
        throw new DockerServiceError({
          code: 'VALIDATION_ERROR',
          status: 400,
          message: `Host port ${p.hostPort} outside template range ${allowed.hostPortMin}-${allowed.hostPortMax} for container port ${p.containerPort}`,
        });
      }
    }

    const envEntries = Object.entries(env ?? {});
    for (const [k] of envEntries) {
      if (!template.allowedEnvKeys.includes(k)) {
        throw new DockerServiceError({ code: 'VALIDATION_ERROR', status: 400, message: `Env key '${k}' is not in template '${templateId}' allowlist` });
      }
    }

    if (command !== undefined) {
      if (!template.allowCommandOverride) {
        throw new DockerServiceError({ code: 'VALIDATION_ERROR', status: 400, message: `Template '${templateId}' does not allow command override` });
      }
      if (!Array.isArray(command) || command.some((c) => typeof c !== 'string')) {
        throw new DockerServiceError({ code: 'VALIDATION_ERROR', status: 400, message: 'command must be an array of strings' });
      }
    }

    const c = requireClient();

    // --- name + port collision checks against the live daemon ---
    const existing = await call('list', () => c.listContainers({ all: true }));
    if (existing.some((r) => { const n = String(r.Names?.[0] ?? '').replace(/^\//, ''); return n === name; })) {
      throw new DockerServiceError({ code: 'NAME_TAKEN', status: 409, message: `Container name '${name}' is already in use` });
    }
    const usedHostPorts = new Set();
    for (const r of existing) for (const p of r.Ports ?? []) if (p.PublicPort) usedHostPorts.add(String(p.PublicPort));
    for (const p of wantedPorts) {
      if (usedHostPorts.has(String(p.hostPort))) {
        throw new DockerServiceError({ code: 'PORT_IN_USE', status: 409, message: `Host port ${p.hostPort} is already published by another container` });
      }
    }

    // --- build the config from the allowlist ONLY (MD §13.1) ---
    const HostConfig = {};
    if (template.cpuLimit) HostConfig.NanoCpus = Math.round(template.cpuLimit * 1e9);
    if (template.memoryLimitBytes) HostConfig.Memory = template.memoryLimitBytes;
    if (wantedPorts.length) {
      HostConfig.PortBindings = {};
      for (const p of wantedPorts) {
        HostConfig.PortBindings[`${p.containerPort}/${p.protocol ?? 'tcp'}`] = [{ HostPort: String(p.hostPort) }];
      }
    }
    if (template.volumes.length) {
      HostConfig.Mounts = template.volumes.map((v) => ({
        Type: v.type,
        Source: v.type === 'bind' ? v.hostPath : v.name ?? null,
        Target: v.containerPath,
        ReadOnly: Boolean(v.readOnly),
      }));
    }
    HostConfig.NetworkMode = template.network;
    if (template.privileged) HostConfig.Privileged = true;

    const dockerConfig = {
      Image: template.image,
      Name: name,
      Env: envEntries.map(([k, v]) => `${k}=${v}`),
      Cmd: command ?? template.command,
      Labels: {
        'app.managed': 'true',
        'app.template': template.id,
        'app.created-by': String(actorUserId ?? 'unknown'),
        'app.idempotency-key': idempotencyKey,
      },
      HostConfig,
    };
    if (template.network !== 'bridge') {
      dockerConfig.NetworkingConfig = { EndpointsConfig: { [template.network]: {} } };
    }

    // --- execute (idempotency window open) ---
    // NOTE 1: dockerode 5.x `createContainer` resolves with a Container
    //         INSTANCE (`.id` lowercase) — not the v3/v4 `{Id, Warnings}` body.
    // NOTE 2: the Docker Engine reads the container NAME from the lowercase
    //         query parameter (?name=...) — a body-level `Name` is IGNORED
    //         by the daemon (verified live, docker 29.x, 2026-10-14).
    //         docker-modem: `opts._query` → querystring, `opts._body` → JSON body.
    const createBody = { ...dockerConfig };
    delete createBody.Name;
    createIdempotency.set(idempotencyKey, { state: 'pending', at: now });
    let created;
    try {
      created = await call('create', () => c.createContainer({ _query: { name }, _body: createBody }), name);
    } catch (err) {
      createIdempotency.delete(idempotencyKey);
      if (err instanceof DockerServiceError) {
        // Map engine 409 name conflict to our stable code (race with pre-check).
        if (err.apiCode === DOCKER_ERROR.GENERIC && /already in use|name already/i.test(err.message ?? '')) {
          throw new DockerServiceError({ code: 'NAME_TAKEN', status: 409, message: `Container name '${name}' is already in use` });
        }
        if (err.apiCode === DOCKER_ERROR.GENERIC && /port is already allocated|address already in use/i.test(err.message ?? '')) {
          throw new DockerServiceError({ code: 'PORT_IN_USE', status: 409, message: `Host port conflict: ${err.message}` });
        }
      }
      throw err;
    }

    if (!created || typeof created.id !== 'string' || created.id.length < 12) {
      // Defensive: dockerode 5.x must resolve a Container instance with .id.
      // Anything else = broken adapter/daemon response — never store a bad id.
      createIdempotency.delete(idempotencyKey);
      throw new DockerServiceError({
        code: DOCKER_ERROR.GENERIC,
        message: `Docker create returned no container id (got ${created === undefined ? 'undefined' : Object.keys(created)})`,
      });
    }

    // Start best-effort: creation is the contract; a failed start is
    // reported (container stays, user can start via the UI).
    // A late failure must not leave the key stuck in 'pending' — the client
    // may then retry honestly (name-conflict check answers 409 if needed).
    let state = 'created';
    let startError = null;
    try {
      await call('start', () => c.getContainer(created.id).start(), created.id);
      state = 'running';
    } catch (err) {
      startError = { code: err.apiCode ?? 'DOCKER_ERROR', message: err.message };
    }

    let finalState = state;
    try {
      const info = await c.getContainer(created.id).inspect();
      finalState = info.State?.Status ?? state;
    } catch {
      /* keep best-effort state */
    }

    const result = { id: created.id, shortId: created.id.slice(0, 12), name, templateId: template.id, state: finalState, startError };
    createIdempotency.set(idempotencyKey, { state: 'done', at: Date.now(), result });

    await audit({
      actorUserId: actorUserId ?? null,
      action: 'container.create',
      resourceType: 'container',
      resourceId: created.id,
      requestId: requestId ?? null,
      ip: ip ?? null,
      status: startError ? 'failure' : 'success',
      // env KEYS only — never values (MD §13.3)
      details: {
        name,
        templateId: template.id,
        image: template.image,
        ports: wantedPorts.map((p) => `${p.hostPort}->${p.containerPort}/${p.protocol ?? 'tcp'}`),
        envKeys: envEntries.map(([k]) => k),
        startError: startError ?? undefined,
      },
    });

    return { container: result, replay: false };
  }

  // ---- SSE events (MD §9.4) --------------------------------------------------

  let sseActive = 0;

  /**
   * Open a docker events stream (container type only).
   * Enforces the process-level parallel cap (MD §9.4).
   * Returns {stream, release} — release MUST be called on disconnect.
   */
  async function openEventStream({ since, maxConcurrent } = {}) {
    const c = requireClient();
    const cap = maxConcurrent ?? config.dockerSseMaxConcurrent ?? 10;
    if (sseActive >= cap) {
      throw new DockerServiceError({
        code: 'SSE_LIMIT',
        status: 503,
        message: `Too many concurrent event streams (max ${cap}) — try again shortly`,
      });
    }
    sseActive += 1;
    try {
      const stream = await call('events', () => c.getEvents({ filters: JSON.stringify({ type: ['container'] }), since: since || undefined }));
      let released = false;
      const release = () => {
        if (released) return; // idempotent — the route may call it from req and res close
        released = true;
        sseActive = Math.max(0, sseActive - 1);
        try {
          stream.destroy?.();
        } catch {
          /* already gone */
        }
      };
      stream.on?.('error', () => {
        release();
      });
      return { stream, release };
    } catch (err) {
      sseActive = Math.max(0, sseActive - 1);
      throw err;
    }
  }

  /** Currently-open SSE streams (tests/ops visibility). */
  const sseStats = () => ({ active: sseActive });

  return {
    // reads
    ping: () => (docker.disabled ? Promise.reject(new DockerServiceError({ code: DOCKER_ERROR.DISABLED, message: 'Docker disabled' })) : call('ping', () => docker.ping())),
    listContainers,
    inspectSummary,
    getLogs,
    getStats,
    // mutations
    runAction,
    deleteContainer,
    createContainerFromTemplate,
    // templates / exceptions
    listTemplates,
    getTemplate,
    upsertTemplate,
    listExceptions,
    grantException,
    revokeException,
    // sse
    openEventStream,
    sseStats,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const TARGET_STATE = Object.freeze({
  start: 'running',
  stop: 'exited',
  restart: 'running',
  pause: 'paused',
  unpause: 'running',
});

function pendingError(name, action, actual) {
  return new DockerServiceError({
    code: DOCKER_ERROR.OPERATION_PENDING,
    message: `Docker accepted '${action}' for '${name}' but state is now '${actual}' — the operation may still be settling; re-check before retrying`,
  });
}

/**
 * P6 (flag #1): managed flag that honours admin exceptions — the single
 * computation used by list + inspect (the mutation gate applies isManaged
 * directly on the freshly-fetched labels).
 */
function managedSummary(labels, containerId, name, exceptions) {
  const m = isManaged({ labels, containerId, name, exceptions });
  return { managed: m.managed, managedByException: m.byException };
}

/** Flatten a docker listContainers row (MD §6.2 columns). */
function summarizeListItem(r) {
  const labels = r.Labels ?? {};
  const name = Array.isArray(r.Names) ? String(r.Names[0] ?? '').replace(/^\//, '') : String(r.Name ?? '').replace(/^\//, '');
  const id = r.Id ?? '';
  const ports = summarizePorts(r.Ports);
  return {
    id,
    shortId: id.slice(0, 12),
    name,
    image: r.Image ?? 'unknown',
    state: String(r.State ?? 'unknown').toLowerCase(),
    status: r.Status ?? '',
    ports,
    managed: String(labels[APP_LABELS.MANAGED]) === 'true',
    template: labels[APP_LABELS.TEMPLATE] ?? null,
    createdBy: labels[APP_LABELS.CREATED_BY] ?? null,
    createdAt: typeof r.Created === 'number' ? new Date(r.Created * 1000).toISOString() : null,
  };
}

/** docker Ports array → compact unique 'host->container/proto' string. */
function summarizePorts(ports) {
  if (!Array.isArray(ports) || ports.length === 0) return '';
  const out = new Set();
  for (const p of ports) {
    if (p?.PrivatePort) {
      out.add(p.PublicPort ? `${p.PublicPort}->${p.PrivatePort}/${p.Type ?? 'tcp'}` : `${p.PrivatePort}/${p.Type ?? 'tcp'}`);
    }
  }
  return [...out].sort().join(', ');
}

/** since param: unix seconds | ISO string | undefined. */
function normalizeSince(since) {
  if (since === undefined || since === null || since === '') return undefined;
  if (typeof since === 'number' && Number.isFinite(since) && since > 0) return since;
  const n = Number(since);
  if (Number.isFinite(n) && n > 0) return n;
  const d = new Date(since);
  if (!Number.isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
  throw new DockerServiceError({ code: 'VALIDATION_ERROR', status: 400, message: 'since must be unix seconds or an ISO timestamp' });
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Promise timeout wrapper (stats bounded sampling, MD §9.4). */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
