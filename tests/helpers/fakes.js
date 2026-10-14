/**
 * Test fixtures — in-memory fakes for db/redis/docker + a standard test
 * config. Kept dependency-free so the suite runs anywhere Node ≥22 runs.
 */
import { randomUUID } from 'node:crypto';

/**
 * Sort rows by a Prisma-style orderBy spec. Accepts BOTH forms Prisma allows:
 *   object:  { createdAt: 'desc' }                       (single key)
 *   array:   [{ createdAt: 'asc' }, { id: 'asc' }]       (multi-key, stable)
 * The P3 API routes emit the object form; older tests used the array form.
 * Supporting both keeps the fake honest against real Prisma.
 * @param {object[]} rows
 * @param {object|Array<object>} [orderBy]
 */
function applyOrderBy(rows, orderBy) {
  if (!orderBy) return rows;
  const specs = Array.isArray(orderBy)
    ? orderBy
    : Object.entries(orderBy).map(([k, dir]) => ({ [k]: dir }));
  if (!specs.length) return rows;
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      for (const [k, dir] of Object.entries(spec)) {
        const av = a[k];
        const bv = b[k];
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
      }
    }
    return 0;
  });
}

/**
 * @param {object} [opts]
 * @param {Array<{id?:string, username:string, passwordHash:string, role?:string, isActive?:boolean}>} [opts.users]
 */
export function makeFakeDb({ users = [] } = {}) {
  const userRows = new Map(); // by username
  const userById = new Map();
  for (const u of users) {
    const row = {
      id: u.id ?? `u${userRows.size + 1}`,
      username: u.username,
      passwordHash: u.passwordHash,
      role: u.role ?? 'viewer',
      isActive: u.isActive ?? true,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastLoginAt: null,
    };
    userRows.set(row.username, row);
    userById.set(row.id, row);
  }

  const sessionRows = new Map(); // by tokenHash
  const settingRows = new Map(); // by key (P2: templates / managed exceptions)
  const auditRows = [];
  let sessionSeq = 0;

  // ---- P4 models (in-memory, Prisma-shaped) --------------------------------
  const scheduleRows = new Map(); // by id
  const definitionRows = new Map(); // by id
  let scheduleSeq = 0;

  // ---- P3 models (in-memory, Prisma-shaped) --------------------------------
  const runRows = new Map(); // by id
  const eventRows = []; // append-only (createdAt ordered by push order)
  const approvalRows = new Map(); // by id
  const providerRows = new Map(); // by id
  let runSeq = 0;
  let eventSeq = 0;
  let approvalSeq = 0;
  let providerSeq = 0;
  let eventClock = 0; // monotonic-ish ms clock so (createdAt, seq) ordering is deterministic

  const now = () => new Date();

  function matchRunWhere(where = {}) {
    return [...runRows.values()].filter((r) => {
      if (where.id && r.id !== where.id) return false;
      if (where.idempotencyKey !== undefined && r.idempotencyKey !== where.idempotencyKey) return false;
      if (where.scheduleId !== undefined && where.scheduleId !== null) {
        if (Array.isArray(where.scheduleId) || where.scheduleId.in) {
          const list = Array.isArray(where.scheduleId) ? where.scheduleId : where.scheduleId.in;
          if (!list.includes(r.scheduleId)) return false;
        } else if (r.scheduleId !== where.scheduleId) return false;
      }
      if (where.status !== undefined) {
        let statusOk = false;
        if (Array.isArray(where.status)) statusOk = where.status.includes(r.status);
        else if (where.status.in) statusOk = where.status.in.includes(r.status);
        else statusOk = where.status === r.status;
        if (!statusOk) return false;
      }
      if (where.updatedAt) {
        if (where.updatedAt.lt && !(new Date(r.updatedAt) < new Date(where.updatedAt.lt))) return false;
      }
      return true;
    });
  }

  const db = {
    user: {
      findUnique: async ({ where }) =>
        typeof where.username === 'string' ? userRows.get(where.username) ?? null : userById.get(where.id) ?? null,
      create: async ({ data }) => {
        const row = {
          id: data.id ?? `u${userRows.size + 1}`,
          username: data.username,
          passwordHash: data.passwordHash,
          role: data.role ?? 'viewer',
          isActive: data.isActive ?? true,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastLoginAt: null,
        };
        userRows.set(row.username, row);
        userById.set(row.id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = userById.get(where.id);
        if (row) Object.assign(row, data);
        return row ?? {};
      },
      count: async () => userRows.size,
    },
    session: {
      findUnique: async ({ where }) => {
        const row = sessionRows.get(where.tokenHash);
        if (!row) return null;
        // mimic prisma include: { user: true }
        return { ...row, user: userById.get(row.userId) ?? null };
      },
      create: async ({ data }) => {
        sessionSeq += 1;
        const row = {
          id: `s${sessionSeq}`,
          tokenHash: data.tokenHash,
          userId: data.userId,
          expiresAt: data.expiresAt,
          createdAt: new Date(),
          lastSeenAt: new Date(),
        };
        sessionRows.set(row.tokenHash, row);
        return row;
      },
      delete: async ({ where }) => {
        for (const [k, v] of sessionRows) if (v.id === where.id) sessionRows.delete(k);
        return {};
      },
      update: async ({ where, data }) => {
        for (const v of sessionRows.values()) if (v.id === where.id) Object.assign(v, data);
        return {};
      },
    },
    auditEvent: {
      create: async ({ data }) => {
        const row = { id: `a${auditRows.length + 1}`, createdAt: new Date(), ...data };
        auditRows.push(row);
        return row;
      },
      findMany: async ({ where = {}, orderBy, skip, take } = {}) => {
        let rows = [...auditRows].filter((a) => {
          if (where.action && a.action !== where.action) return false;
          if (where.actorUserId && a.actorUserId !== where.actorUserId) return false;
          if (where.resourceType && a.resourceType !== where.resourceType) return false;
          if (where.createdAt) {
            if (where.createdAt.gte && !(new Date(a.createdAt) >= new Date(where.createdAt.gte))) return false;
            if (where.createdAt.lte && !(new Date(a.createdAt) <= new Date(where.createdAt.lte))) return false;
          }
          return true;
        });
        rows = applyOrderBy(rows, orderBy);
        if (skip) rows = rows.slice(skip);
        if (take !== undefined) rows = rows.slice(0, take);
        return rows.map((r) => ({ ...r }));
      },
      count: async ({ where = {} } = {}) =>
        [...auditRows].filter((a) => {
          if (where.action && a.action !== where.action) return false;
          if (where.actorUserId && a.actorUserId !== where.actorUserId) return false;
          if (where.resourceType && a.resourceType !== where.resourceType) return false;
          if (where.createdAt) {
            if (where.createdAt.gte && !(new Date(a.createdAt) >= new Date(where.createdAt.gte))) return false;
            if (where.createdAt.lte && !(new Date(a.createdAt) <= new Date(where.createdAt.lte))) return false;
          }
          return true;
        }).length,
    },
    appSetting: {
      findUnique: async ({ where }) => settingRows.get(where.key) ?? null,
      upsert: async ({ where, update, create }) => {
        const existing = settingRows.get(where.key);
        const row = existing
          ? { ...existing, ...update, updatedAt: new Date() }
          : { key: where.key, ...create, createdAt: new Date(), updatedAt: new Date() };
        settingRows.set(where.key, row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = settingRows.get(where.key);
        if (row) {
          settingRows.set(where.key, { ...row, ...data, updatedAt: new Date() });
          return settingRows.get(where.key);
        }
        return null;
      },
    },
    // health/ready probe
    $queryRaw: async () => [{}],
    // ---- P3: task_run ----------------------------------------------------
    taskRun: {
      findUnique: async ({ where }) => {
        if (where.id) return runRows.get(where.id) ?? null;
        if (where.idempotencyKey) return [...runRows.values()].find((r) => r.idempotencyKey === where.idempotencyKey) ?? null;
        return null;
      },
      findMany: async ({ where, orderBy, skip, take } = {}) => {
        let rows = matchRunWhere(where);
        rows = applyOrderBy(rows, orderBy);
        if (skip) rows = rows.slice(skip);
        if (take !== undefined) rows = rows.slice(0, take);
        return rows.map((r) => ({ ...r }));
      },
      count: async ({ where } = {}) => matchRunWhere(where).length,
      findFirst: async ({ where } = {}) => {
        const rows = matchRunWhere(where);
        if (!rows.length) return null;
        // Prisma findFirst without orderBy is non-deterministic; tests that
        // rely on it use the status.in overlap query (first match is fine).
        return { ...rows[0] };
      },
      create: async ({ data }) => {
        runSeq += 1;
        const ts = now();
        const row = {
          // UUID by default (matches the real @db.Uuid column + route param
          // minLength) so API-route tests exercise the same id shape.
          id: data.id ?? randomUUID(),
          taskDefinitionId: data.taskDefinitionId ?? null,
          scheduleId: data.scheduleId ?? null,
          status: data.status ?? 'queued',
          inputJson: data.inputJson ?? null,
          resultJson: data.resultJson ?? null,
          resultText: data.resultText ?? null,
          errorCode: data.errorCode ?? null,
          errorMessage: data.errorMessage ?? null,
          attempt: data.attempt ?? 1,
          queuedAt: data.queuedAt ?? null,
          startedAt: data.startedAt ?? null,
          finishedAt: data.finishedAt ?? null,
          durationMs: data.durationMs ?? null,
          requestedBy: data.requestedBy ?? null,
          idempotencyKey: data.idempotencyKey ?? null,
          createdAt: ts,
          updatedAt: ts,
        };
        runRows.set(row.id, row);
        return { ...row };
      },
      update: async ({ where, data }) => {
        const row = runRows.get(where.id);
        if (!row) throw Object.assign(new Error('run not found'), { code: 'P2025' });
        // Honour an explicit updatedAt (tests age rows); otherwise bump like Prisma @updatedAt.
        const { updatedAt: explicit, ...rest } = data;
        Object.assign(row, rest, { updatedAt: explicit ?? now() });
        runRows.set(row.id, row);
        return { ...row };
      },
    },
    // ---- P3: task_run_events ---------------------------------------------
    taskRunEvent: {
      create: async ({ data }) => {
        eventSeq += 1;
        eventClock += 1;
        // UUID by default — faithful to the schema (@db.Uuid). The SSE
        // ?after= cursor is a uuid, so the fake must produce uuids or the
        // route's cursor validation (correctly) rejects fake ids.
        const row = {
          id: data.id ?? randomUUID(),
          taskRunId: data.taskRunId,
          eventType: data.eventType,
          message: data.message ?? null,
          payloadJson: data.payloadJson ?? null,
          createdAt: new Date(Date.now() + eventClock), // strictly increasing
          _seq: eventSeq,
        };
        eventRows.push(row);
        return { ...row };
      },
      findMany: async ({ where = {}, orderBy, skip, take } = {}) => {
        let rows = eventRows.filter((e) => {
          if (where.taskRunId && e.taskRunId !== where.taskRunId) return false;
          if (where.id && e.id !== where.id) return false;
          // SSE cursor: OR [createdAt > c, createdAt = c AND id > cid] (ISO strings compare correctly)
          if (where.OR) {
            const [gt, eq] = where.OR;
            const a = gt?.createdAt?.gt !== undefined ? e.createdAt > new Date(gt.createdAt.gt) : false;
            const b = eq?.createdAt !== undefined && eq?.id?.gt !== undefined
              ? e.createdAt.getTime() === new Date(eq.createdAt).getTime() && e.id > eq.id.gt
              : false;
            if (!(a || b)) return false;
          }
          return true;
        });
        rows = applyOrderBy(rows, orderBy);
        if (skip) rows = rows.slice(skip);
        if (take !== undefined) rows = rows.slice(0, take);
        return rows.map(({ _seq, ...rest }) => rest);
      },
    },
    // ---- P3: approval_requests -------------------------------------------
    approvalRequest: {
      findUnique: async ({ where }) => approvalRows.get(where.id) ?? null,
      findMany: async ({ where = {} } = {}) =>
        [...approvalRows.values()].filter((a) => {
          if (where.status && a.status !== where.status) return false;
          if (where.taskRunId && a.taskRunId !== where.taskRunId) return false;
          return true;
        }),
      create: async ({ data }) => {
        approvalSeq += 1;
        const row = {
          id: data.id ?? randomUUID(),
          taskRunId: data.taskRunId,
          toolName: data.toolName,
          argumentsJson: data.argumentsJson ?? null,
          status: data.status ?? 'pending',
          requestedAt: now(),
          reviewedBy: data.reviewedBy ?? null,
          reviewedAt: data.reviewedAt ?? null,
          reviewNote: data.reviewNote ?? null,
        };
        approvalRows.set(row.id, row);
        return { ...row };
      },
      update: async ({ where, data }) => {
        const row = approvalRows.get(where.id);
        if (!row) throw Object.assign(new Error('approval not found'), { code: 'P2025' });
        Object.assign(row, data);
        return { ...row };
      },
    },
    // ---- P3: provider_configs ---------------------------------------------
    providerConfig: {
      findUnique: async ({ where }) => {
        if (where.id) return providerRows.get(where.id) ?? null;
        if (where.name) return [...providerRows.values()].find((p) => p.name === where.name) ?? null;
        return null;
      },
      findMany: async () => [...providerRows.values()].map((p) => ({ ...p })),
      create: async ({ data }) => {
        providerSeq += 1;
        const dupName = [...providerRows.values()].find((p) => p.name === data.name);
        if (dupName) {
          throw Object.assign(new Error(`Unique constraint failed on the fields: (name)`), { code: 'P2002' });
        }
        const ts = now();
        const row = {
          id: data.id ?? `prov${providerSeq}`,
          name: data.name,
          providerType: data.providerType,
          baseUrl: data.baseUrl,
          modelId: data.modelId ?? null,
          encryptedApiKey: data.encryptedApiKey ?? null,
          timeoutMs: data.timeoutMs ?? 120000,
          isEnabled: data.isEnabled ?? true,
          capabilitiesJson: data.capabilitiesJson ?? null,
          createdAt: ts,
          updatedAt: ts,
        };
        providerRows.set(row.id, row);
        return { ...row };
      },
      update: async ({ where, data }) => {
        const row = providerRows.get(where.id);
        if (!row) throw Object.assign(new Error('provider not found'), { code: 'P2025' });
        Object.assign(row, data, { updatedAt: now() });
        return { ...row };
      },
    },
    // ---- P4: schedules -------------------------------------------------------
    schedule: {
      findUnique: async ({ where }) => {
        if (where.id && scheduleRows.has(where.id)) return { ...scheduleRows.get(where.id) };
        if (where.name) {
          const found = [...scheduleRows.values()].find((s) => s.name === where.name);
          return found ? { ...found } : null;
        }
        return null;
      },
      findMany: async ({ where = {} } = {}) =>
        [...scheduleRows.values()].filter((s) => {
          if (where.isEnabled !== undefined && s.isEnabled !== where.isEnabled) return false;
          if (where.taskDefinitionId && s.taskDefinitionId !== where.taskDefinitionId) return false;
          return true;
        }).map((s) => ({ ...s })),
      count: async ({ where = {} } = {}) =>
        [...scheduleRows.values()].filter((s) => {
          if (where.isEnabled !== undefined && s.isEnabled !== where.isEnabled) return false;
          if (where.taskDefinitionId && s.taskDefinitionId !== where.taskDefinitionId) return false;
          return true;
        }).length,
      create: async ({ data }) => {
        scheduleSeq += 1;
        if (data.name && [...scheduleRows.values()].some((s) => s.name === data.name)) {
          throw Object.assign(new Error(`Unique constraint failed on the fields: (name)`), { code: 'P2002' });
        }
        const ts = now();
        const row = {
          id: data.id ?? randomUUID(), // @db.Uuid in the real schema — keeps downstream uuid validation honest
          name: data.name,
          taskDefinitionId: data.taskDefinitionId,
          scheduleType: data.scheduleType,
          cronExpression: data.cronExpression ?? null,
          intervalMs: data.intervalMs ?? null,
          timezone: data.timezone ?? 'Asia/Taipei',
          overlapPolicy: data.overlapPolicy ?? 'skip_if_running',
          isEnabled: data.isEnabled ?? true,
          nextRunAt: data.nextRunAt ?? null,
          lastRunAt: data.lastRunAt ?? null,
          lastStatus: data.lastStatus ?? null,
          bullmqSchedulerId: data.bullmqSchedulerId ?? null,
          syncStatus: data.syncStatus ?? 'synced',
          createdAt: ts,
          updatedAt: ts,
        };
        scheduleRows.set(row.id, row);
        return { ...row };
      },
      update: async ({ where, data }) => {
        const row = scheduleRows.get(where.id);
        if (!row) throw Object.assign(new Error('schedule not found'), { code: 'P2025' });
        if (data.name && data.name !== row.name && [...scheduleRows.values()].some((s) => s.id !== row.id && s.name === data.name)) {
          throw Object.assign(new Error(`Unique constraint failed on the fields: (name)`), { code: 'P2002' });
        }
        Object.assign(row, data, { updatedAt: now() });
        return { ...row };
      },
      delete: async ({ where }) => {
        if (!scheduleRows.has(where.id)) throw Object.assign(new Error('schedule not found'), { code: 'P2025' });
        scheduleRows.delete(where.id);
        return {};
      },
    },
    // ---- P4: task_definitions (read path for schedules UI + run-now) --------
    taskDefinition: {
      findUnique: async ({ where, include } = {}) => {
        const row = where.id ? definitionRows.get(where.id) : null;
        if (!row) return null;
        const out = { ...row };
        if (include?.providerConfig) {
          out.providerConfig = providerRows.get(row.providerConfigId)
            ? { ...providerRows.get(row.providerConfigId) }
            : null;
        }
        return out;
      },
      findMany: async () => [...definitionRows.values()].map((d) => ({ ...d })),
      create: async ({ data }) => {
        const ts = now();
        const row = {
          id: data.id ?? `def${definitionRows.size + 1}`,
          title: data.title,
          description: data.description ?? null,
          taskType: data.taskType ?? 'ai',
          providerConfigId: data.providerConfigId,
          promptTemplate: data.promptTemplate,
          mode: data.mode ?? 'analysis_only',
          inputSchemaJson: data.inputSchemaJson ?? null,
          outputSchemaJson: data.outputSchemaJson ?? null,
          timeoutMs: data.timeoutMs ?? 120000,
          maxAttempts: data.maxAttempts ?? 3,
          concurrencyKey: data.concurrencyKey ?? null,
          requiresApproval: data.requiresApproval ?? false,
          createdBy: data.createdBy ?? null,
          createdAt: ts,
          updatedAt: ts,
        };
        definitionRows.set(row.id, row);
        return { ...row };
      },
    },
    // teardown seam
    $disconnect: async () => {},
    __state: {
      userRows, userById, sessionRows, settingRows, auditRows,
      runRows, eventRows, approvalRows, providerRows,
      scheduleRows, definitionRows,
    },
  };
  return db;
}

export const fakeRedisOk = () => ({
  ping: async () => 'PONG',
  on: () => {},
  quit: async () => {},
});

/**
 * Fake BullMQ Queue — records enqueue/remove calls so hermetic tests can
 * assert on queue traffic without Redis. add() mimics BullMQ's JobExistsError
 * on duplicate jobId (idempotent enqueue relies on this).
 *
 * P4: also fakes the BullMQ 6 Job Scheduler API (upsertJobScheduler /
 * getJobSchedulers / removeJobScheduler) with the same parameter validation
 * as the real thing (exactly one of pattern/every), plus a `__schedulerDown`
 * seam to simulate redis writes failing mid-sync (sync_error path).
 */
export function makeFakeQueue() {
  const enqueued = [];
  const removed = [];
  const jobs = new Map(); // id -> {id, name, data, state}
  const schedulers = new Map(); // key -> {key, name, pattern, every, tz, data, opts}
  let schedulerDown = false;
  const down = () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:6379 (fake scheduler down)');
    err.code = 'ECONNREFUSED';
    return err;
  };
  // A job reference with the subset of the real BullMQ Job API the code uses.
  const wrapJob = (j) => ({
    id: j.id,
    name: j.name,
    data: j.data,
    state: j.state,
    opts: j.opts,
    async remove() {
      const jj = jobs.get(j.id);
      if (jj && (jj.state === 'waiting' || jj.state === 'delayed')) {
        jobs.delete(j.id);
        removed.push(j.id);
        return true;
      }
      return false;
    },
  });
  return {
    enqueued,
    removed,
    jobs,
    schedulers,
    __setSchedulerDown(flag = true) { schedulerDown = Boolean(flag); },
    __isSchedulerDown() { return schedulerDown; },
    async add(name, data, opts = {}) {
      const id = opts.jobId ?? `job${enqueued.length + 1}`;
      // Faithful to BullMQ: custom job ids may NOT contain ':' (real BullMQ
      // throws "Custom Id cannot contain :" — caught live 2026-10-15).
      if (opts.jobId && String(opts.jobId).includes(':')) {
        throw new Error('Custom Id cannot contain :');
      }
      if (jobs.has(id)) {
        const err = new Error(`Job with id '${id}' already exists`);
        err.name = 'JobExistsError';
        throw err;
      }
      const job = { id, name, data, state: opts.delay > 0 ? 'delayed' : 'waiting', opts };
      jobs.set(id, job);
      enqueued.push({ id, name, data });
      return { id };
    },
    async getJob(id) {
      const j = jobs.get(id);
      return j ? wrapJob(j) : null;
    },
    // Real BullMQ Queue.getJobs(states) — the reconciler's orphan sweep uses
    // ['delayed'] to find stranded once-fire jobs.
    async getJobs(states = ['waiting', 'delayed']) {
      return [...jobs.values()].filter((j) => states.includes(j.state)).map(wrapJob);
    },
    async removeJob(id) {
      const j = jobs.get(id);
      if (j && (j.state === 'waiting' || j.state === 'delayed')) {
        jobs.delete(id);
        removed.push(id);
        return true;
      }
      return false;
    },
    // ---- P4: BullMQ 6 Job Scheduler API (same validation as the real one) --
    async upsertJobScheduler(key, repeatOpts, template = {}) {
      if (schedulerDown) throw down();
      const { pattern, every } = repeatOpts ?? {};
      if (pattern && every) throw new Error('Both .pattern and .every options are defined for this repeatable job');
      if (!pattern && !every) throw new Error('Either .pattern or .every options must be defined for this repeatable job');
      schedulers.set(key, {
        key,
        name: template.name ?? key,
        pattern: pattern ?? null,
        every: every ?? null,
        tz: repeatOpts.tz ?? null,
        limit: repeatOpts.limit ?? null,
        // Real BullMQ getJobSchedulers() shape (template holds name/data/opts).
        template: { name: template.name ?? key, data: template.data ?? {}, opts: template.opts ?? {} },
      });
    },
    async getJobSchedulers() {
      if (schedulerDown) throw down();
      return [...schedulers.values()].map((s) => ({ ...s }));
    },
    async getJobSchedulersCount() {
      if (schedulerDown) throw down();
      return schedulers.size;
    },
    async removeJobScheduler(key) {
      if (schedulerDown) throw down();
      return schedulers.delete(key);
    },
    __markActive(id) { const j = jobs.get(id); if (j) j.state = 'active'; },
    async close() {},
    on() {},
  };
}

export const fakeRedisDown = () => ({
  ping: async () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:6379');
    err.code = 'ECONNREFUSED';
    throw err;
  },
  on: () => {},
  quit: async () => {},
});

export const fakeDockerOk = () => ({ disabled: false, client: null, ping: async () => 'PONG' });

export const fakeDockerDown = () => ({
  disabled: false,
  client: null,
  ping: async () => {
    const err = new Error('connect ENOENT /var/run/docker.sock');
    err.code = 'ENOENT';
    throw err;
  },
});

export const fakeDockerDisabled = () => ({
  disabled: true,
  client: null,
  ping: async () => {
    const err = new Error('Docker checks disabled via config (DOCKER_SOCKET_PATH empty)');
    err.code = 'DOCKER_DISABLED';
    throw err;
  },
});

export function dbDownFake() {
  return {
    user: {},
    session: {},
    auditEvent: {},
    $queryRaw: async () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:5432');
      err.code = 'ECONNREFUSED';
      throw err;
    },
    $disconnect: async () => {},
  };
}

/** Standard hermetic config (no env access). */
export const testConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  publicUrl: 'http://127.0.0.1:3012',
  sessionSecret: 'a'.repeat(48),
  encryptionKey: 'b'.repeat(48),
  sessionTtlMs: 3_600_000,
  cookieSecure: false,
  databaseUrl: 'postgresql://x:y@127.0.0.1:1/x',
  redisUrl: 'redis://127.0.0.1:1',
  dockerSocketPath: '/nonexistent',
  // P2 docker service knobs (施工 MD §9.3/§9.4) — explicit in tests
  dockerLogTailDefault: 500,
  dockerLogTailMax: 5000,
  dockerLogByteLimit: 1_048_576,
  dockerStatsTimeoutMs: 3000,
  dockerStopTimeoutSec: 10,
  dockerSseMaxConcurrent: 10,
  dockerSseHeartbeatMs: 25000,
  dockerIdempotencyTtlMs: 600_000,
  defaultTimezone: 'Asia/Taipei',
  taskDefaultTimeoutMs: 120_000,
  taskMaxTimeoutMs: 900_000,
  taskDefaultAttempts: 3,
  taskMaxConcurrency: 4,
  logLevel: 'silent',
  allowedOrigins: ['http://127.0.0.1:3012', 'http://127.0.0.1:3000', 'http://localhost:3000'],
};
