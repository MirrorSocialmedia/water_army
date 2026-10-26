/**
 * Test fixtures — in-memory fakes for db/redis/docker + a standard test
 * config. Kept dependency-free so the suite runs anywhere Node ≥22 runs.
 */
import { randomUUID } from 'node:crypto';
import { nextCronRun } from '@water-army/shared';

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
  const notificationRows = new Map(); // by id (P6 flag #3)
  let scheduleSeq = 0;

  // ---- P5 models (in-memory, Prisma-shaped) --------------------------------
  const templateRows = new Map(); // redroid_templates, by id
  const deviceRows = new Map(); // devices, by id
  const identityRows = new Map(); // identities, by id (W1 ADR-025)
  const fingerprintRows = new Map(); // identity_fingerprints, by identityId (W1 ADR-025)
  const interventionRows = new Map(); // manual_interventions, by id (MC P4)
  const historyRows = new Map(); // manual_intervention_history, by id (MC P4)
  let historySeq = 0; // monotonic — (createdAt, id) ordering must be deterministic in tests

  const OPEN_EPISODE_STATUSES = ['open', 'acknowledged', 'in_progress'];

  function interventionMatchWhere(where = {}) {
    return [...interventionRows.values()].filter((row) =>
      Object.entries(where).every(([k, cond]) => {
        const v = row[k];
        if (cond === null) return v === null;
        if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
          if (Array.isArray(cond.in)) return cond.in.includes(v);
          if (cond.not !== undefined) return v !== null && v !== cond.not;
          if (cond.gte !== undefined) return v !== null && v >= cond.gte;
          if (cond.lte !== undefined) return v !== null && v <= cond.lte;
          if (cond.contains !== undefined) return String(v ?? '').includes(cond.contains);
          return true;
        }
        return v === cond;
      }),
    );
  }

  function applyInterventionData(row, data) {
    const clean = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (v && typeof v === 'object' && typeof v.increment === 'number') {
        clean[k] = (row[k] ?? 0) + v.increment;
      } else {
        clean[k] = v;
      }
    }
    return clean;
  }

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
      if (where.id !== undefined) {
        if (where.id.not && r.id === where.id.not) return false; // P6 flag #5
        if (!where.id.not && r.id !== where.id) return false;
      }
      if (where.taskDefinitionId !== undefined) { // P6 flag #5
        if (where.taskDefinitionId.in) {
          if (!where.taskDefinitionId.in.includes(r.taskDefinitionId)) return false;
        } else if (r.taskDefinitionId !== where.taskDefinitionId) return false;
      }
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
      if (where.finishedAt) { // P6 dashboard: 24h windows
        if (where.finishedAt.gte && !(r.finishedAt && new Date(r.finishedAt) >= new Date(where.finishedAt.gte))) return false;
      }
      return true;
    });
  }

  // P5 device where-matching (closure over this db's deviceRows).
  function matchDeviceWhere(where = {}) {
    return [...deviceRows.values()].filter((d) => {
      if (where.id && d.id !== where.id) return false;
      if (where.templateId && d.templateId !== where.templateId) return false;
      if (where.containerState !== undefined && d.containerState !== where.containerState) return false;
      if (where.adbPort !== undefined && d.adbPort !== where.adbPort) return false;
      if (where.gostPort !== undefined && where.gostPort !== null && d.gostPort !== where.gostPort) return false;
      if (where.gostPort === null && d.gostPort !== null) return false;
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
      create: async ({ data }) => {
        const row = { ...data, createdAt: new Date(), updatedAt: new Date() };
        settingRows.set(row.key, row);
        return row;
      },
      deleteMany: async ({ where }) => {
        const existed = settingRows.has(where.key);
        settingRows.delete(where.key);
        return { count: existed ? 1 : 0 };
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
    // ---- P6 flag #3: schedule_notifications (unique runId, isRead flag) ----
    scheduleNotification: {
      findUnique: async ({ where }) => {
        if (where.id && notificationRows.has(where.id)) return { ...notificationRows.get(where.id) };
        if (where.runId) {
          const found = [...notificationRows.values()].find((n) => n.runId === where.runId);
          return found ? { ...found } : null;
        }
        return null;
      },
      findMany: async ({ where = {}, orderBy, take } = {}) => {
        let rows = [...notificationRows.values()].filter((n) => {
          if (where.isRead !== undefined && n.isRead !== where.isRead) return false;
          if (where.scheduleId !== undefined && n.scheduleId !== where.scheduleId) return false;
          return true;
        });
        // newest-first default match: orderBy [{createdAt:'desc'},{id:'asc'}]
        const specs = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [{ createdAt: 'desc' }, { id: 'asc' }];
        rows = applyOrderBy(rows, specs);
        if (Number.isInteger(take)) rows = rows.slice(0, take);
        return rows.map((n) => ({ ...n }));
      },
      count: async ({ where = {} } = {}) =>
        [...notificationRows.values()].filter((n) => {
          if (where.isRead !== undefined && n.isRead !== where.isRead) return false;
          return true;
        }).length,
      create: async ({ data }) => {
        if (data.runId && [...notificationRows.values()].some((n) => n.runId === data.runId)) {
          throw Object.assign(new Error(`Unique constraint failed on the fields: (runId)`), { code: 'P2002' });
        }
        const row = {
          id: data.id ?? `notif${notificationRows.size + 1}`,
          scheduleId: data.scheduleId,
          runId: data.runId,
          status: data.status,
          title: data.title,
          message: data.message ?? null,
          isRead: data.isRead ?? false,
          createdAt: data.createdAt ?? now(),
        };
        notificationRows.set(row.id, row);
        return { ...row };
      },
      update: async ({ where, data }) => {
        const row = notificationRows.get(where.id);
        if (!row) throw Object.assign(new Error('notification not found'), { code: 'P2025' });
        Object.assign(row, data);
        return { ...row };
      },
      updateMany: async ({ where = {}, data }) => {
        let count = 0;
        for (const n of notificationRows.values()) {
          const matches =
            (where.isRead === undefined || n.isRead === where.isRead) &&
            (where.id === undefined || n.id === where.id);
          if (matches) {
            Object.assign(n, data);
            count += 1;
          }
        }
        return { count };
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
    // ---- P5: redroid_templates (DB-backed, unlike P2's app_settings templates) --
    redroidTemplate: {
      findUnique: async ({ where } = {}) => {
        const row = templateRows.get(where?.id) ?? [...templateRows.values()].find((t) => t.name === where?.name) ?? null;
        return row ? { ...row } : null;
      },
      findMany: async () => [...templateRows.values()].map((t) => ({ ...t })),
      create: async ({ data }) => {
        if (data.id !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(data.id))) {
          throw Object.assign(new Error(`invalid input syntax for type uuid: "${data.id}"`), { code: 'P2007' });
        }
        if (data.name && [...templateRows.values()].some((t) => t.name === data.name)) {
          throw Object.assign(new Error(`Unique constraint failed on the fields: (name)`), { code: 'P2002' });
        }
        const ts = now();
        const row = {
          id: data.id ?? randomUUID(), // @db.Uuid — seed rows carry fixed cuid-shape ids
          name: data.name,
          image: data.image,
          androidVersion: data.androidVersion,
          width: data.width ?? 1080,
          height: data.height ?? 1920,
          dpi: data.dpi ?? 440,
          fps: data.fps ?? 30,
          gpuMode: data.gpuMode ?? 'swiftshader_indirect',
          privileged: data.privileged ?? false,
          privilegedReason: data.privilegedReason ?? null,
          isEnabled: data.isEnabled ?? true,
          // R5: resource limits (null = unlimited)
          cpuLimit: data.cpuLimit ?? null,
          memoryLimitBytes: data.memoryLimitBytes ?? null,
          // Stage B: encrypted egress proxy (null = no fleet proxy)
          proxyUrlEncrypted: data.proxyUrlEncrypted ?? null,
          // W1 (ADR-025): static ro override baseline ({} = today's behaviour)
          roOverrides: data.roOverrides ?? {},
          createdAt: ts,
          updatedAt: ts,
        };
        templateRows.set(row.id, row);
        return { ...row };
      },
      update: async ({ where, data }) => {
        const row = templateRows.get(where.id);
        if (!row) throw Object.assign(new Error('redroid template not found'), { code: 'P2025' });
        if (data.name && data.name !== row.name && [...templateRows.values()].some((t) => t.id !== row.id && t.name === data.name)) {
          throw Object.assign(new Error(`Unique constraint failed on the fields: (name)`), { code: 'P2002' });
        }
        // Prisma semantics: `undefined` fields are absent (skipped) — a naive
        // Object.assign would clobber real values with undefined.
        const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
        Object.assign(row, clean, { updatedAt: now() });
        return { ...row };
      },
      delete: async ({ where }) => {
        if (!templateRows.has(where.id)) throw Object.assign(new Error('redroid template not found'), { code: 'P2025' });
        templateRows.delete(where.id);
        return {};
      },
    },
    // ---- P5: devices -----------------------------------------------------
    device: {
      findUnique: async ({ where, include } = {}) => {
        const row = deviceRows.get(where?.id) ?? [...deviceRows.values()].find((d) => d.name === where?.name) ?? null;
        if (!row) return null;
        const out = { ...row };
        if (include?.template) out.template = templateRows.get(row.templateId) ? { ...templateRows.get(row.templateId) } : null;
        return out;
      },
      findFirst: async ({ where = {} } = {}) => {
        const row = matchDeviceWhere(where)[0];
        return row ? { ...row } : null;
      },
      findMany: async ({ where = {}, include, select } = {}) => {
        let rows = matchDeviceWhere(where);
        rows = rows.map((d) => {
          const out = {};
          for (const k of Object.keys(select ?? d)) out[k] = d[k];
          if (include?.template) out.template = templateRows.get(d.templateId) ? { ...templateRows.get(d.templateId) } : null;
          return out;
        });
        return rows;
      },
      count: async ({ where = {} } = {}) => matchDeviceWhere(where).length,
      create: async ({ data }) => {
        if (data.id !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(data.id))) {
          throw Object.assign(new Error(`invalid input syntax for type uuid: "${data.id}"`), { code: 'P2007' });
        }
        if (data.name && [...deviceRows.values()].some((d) => d.name === data.name)) {
          throw Object.assign(new Error(`Unique constraint failed on the fields: (name)`), { code: 'P2002' });
        }
        if (data.adbPort !== undefined && data.adbPort !== null && [...deviceRows.values()].some((d) => d.adbPort === data.adbPort)) {
          throw Object.assign(new Error(`Unique constraint failed on the fields: (adbPort)`), { code: 'P2002' });
        }
        if (data.gostPort !== undefined && data.gostPort !== null && [...deviceRows.values()].some((d) => d.gostPort === data.gostPort)) {
          throw Object.assign(new Error(`Unique constraint failed on the fields: (gostPort)`), { code: 'P2002' });
        }
        const ts = now();
        const row = {
          id: data.id ?? randomUUID(),
          name: data.name,
          templateId: data.templateId,
          adbPort: data.adbPort,
          dataDir: data.dataDir,
          containerName: data.containerName,
          containerId: data.containerId ?? null,
          image: data.image,
          androidVersion: data.androidVersion,
          width: data.width,
          height: data.height,
          dpi: data.dpi,
          fps: data.fps,
          gpuMode: data.gpuMode,
          containerState: data.containerState ?? 'unknown',
          adbState: data.adbState ?? 'unknown',
          gpuStatus: data.gpuStatus ?? 'unknown',
          lastDiagnosedAt: data.lastDiagnosedAt ?? null,
          // Stage B: per-device proxy binding (null trio = no proxy)
          gostPort: data.gostPort ?? null,
          proxyUrlEncrypted: data.proxyUrlEncrypted ?? null,
          proxyState: data.proxyState ?? 'off',
          // R1: tun2socks binary diagnosis
          binaryState: data.binaryState ?? null,
          binaryVersion: data.binaryVersion ?? null,
          // R3: network health state machine (repair MD Phase 3)
          netState: data.netState ?? 'STOPPED',
          netStateSince: data.netStateSince ?? null,
          netCheckedAt: data.netCheckedAt ?? null,
          netLastSuccessAt: data.netLastSuccessAt ?? null,
          netConsecutiveFailures: data.netConsecutiveFailures ?? 0,
          netLastErrorCode: data.netLastErrorCode ?? null,
          netLastErrorDetail: data.netLastErrorDetail ?? null,
          netRecoveries: data.netRecoveries ?? 0,
          netLastRecoveryAt: data.netLastRecoveryAt ?? null,
          netManualIntervention: data.netManualIntervention ?? false,
          netRecoveryLockOwner: data.netRecoveryLockOwner ?? null,
          netRecoveryLockUntil: data.netRecoveryLockUntil ?? null,
          netNextRecoveryAt: data.netNextRecoveryAt ?? null,
          netLastCanary: data.netLastCanary ?? null,
          // W1 (ADR-025): identity binding + injected ro snapshot
          identityId: data.identityId ?? null,
          roOverridesJson: data.roOverridesJson ?? {},
          createdAt: ts,
          updatedAt: ts,
        };
        deviceRows.set(row.id, row);
        return { ...row };
      },
      update: async ({ where, data }) => {
        const row = deviceRows.get(where.id);
        if (!row) throw Object.assign(new Error('device not found'), { code: 'P2025' });
        if (data.adbPort !== undefined && data.adbPort !== null && [...deviceRows.values()].some((d) => d.id !== row.id && d.adbPort === data.adbPort)) {
          throw Object.assign(new Error(`Unique constraint failed on the fields: (adbPort)`), { code: 'P2002' });
        }
        if (data.gostPort !== undefined && data.gostPort !== null && [...deviceRows.values()].some((d) => d.id !== row.id && d.gostPort === data.gostPort)) {
          throw Object.assign(new Error(`Unique constraint failed on the fields: (gostPort)`), { code: 'P2002' });
        }
        const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
        Object.assign(row, clean, { updatedAt: now() });
        return { ...row };
      },
      delete: async ({ where }) => {
        if (!deviceRows.has(where.id)) throw Object.assign(new Error('device not found'), { code: 'P2025' });
        deviceRows.delete(where.id);
        return {};
      },
    },
    // ---- W1 (ADR-025): identities + identity_fingerprints -------------------
    // Minimal Prisma-shaped in-memory models. fingerprint row mirrors the DB
    // unique guards (fingerprint/serial/displayId → P2002) so the service's
    // fail-closed collision path is exercised without postgres.
    identity: {
      create: async ({ data }) => {
        const ts = now();
        const row = {
          id: data.id ?? randomUUID(),
          externalRef: data.externalRef ?? null,
          displayName: data.displayName ?? `id-${(identityRows.size + 1).toString(16)}`,
          identityType: data.identityType ?? 'qa_device',
          status: data.status ?? 'READY',
          dataPath: data.dataPath ?? `/data/wa/id-${identityRows.size + 1}`,
          metadataJson: data.metadataJson ?? {},
          createdAt: ts,
          updatedAt: ts,
        };
        if ([...identityRows.values()].some((r) => r.dataPath === row.dataPath)) {
          throw Object.assign(new Error('Unique constraint failed on the fields: (dataPath)'), { code: 'P2002' });
        }
        identityRows.set(row.id, row);
        return { ...row };
      },
      findUnique: async ({ where } = {}) => {
        const row = identityRows.get(where?.id) ?? [...identityRows.values()].find((r) => r.dataPath === where?.dataPath) ?? null;
        return row ? { ...row } : null;
      },
      findMany: async () => [...identityRows.values()].map((r) => ({ ...r })),
    },
    identityFingerprint: {
      create: async ({ data }) => {
        const uniqueHit = ['fingerprint', 'serial', 'displayId'].find(
          (f) => data[f] !== undefined && [...fingerprintRows.values()].some((r) => r[f] === data[f] && r.identityId !== data.identityId),
        );
        if (uniqueHit) {
          throw Object.assign(new Error(`Unique constraint failed on the fields: (${uniqueHit})`), { code: 'P2002' });
        }
        if (fingerprintRows.has(data.identityId)) {
          throw Object.assign(new Error('Unique constraint failed on the fields: (identityId)'), { code: 'P2002' });
        }
        const ts = now();
        const row = { schemaVersion: 1, createdAt: ts, updatedAt: ts, ...data };
        fingerprintRows.set(row.identityId, row);
        return { ...row };
      },
      findUnique: async ({ where } = {}) => {
        const row = fingerprintRows.get(where?.identityId) ?? null;
        return row ? { ...row } : null;
      },
      findMany: async () => [...fingerprintRows.values()].map((r) => ({ ...r })),
      update: async ({ where, data }) => {
        const row = fingerprintRows.get(where?.identityId);
        if (!row) throw Object.assign(new Error('identity fingerprint not found'), { code: 'P2025' });
        Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)), { updatedAt: now() });
        return { ...row };
      },
    },
    // ---- MC P4: manual_interventions (Mobile Console MD Phase 4 / §6) ------
    // In-memory emulation of the DB contract the production code relies on:
    //  - PARTIAL UNIQUE (dedupe_key) WHERE status IN open-episode: create()
    //    throws P2002 when an open episode with the same key exists — the
    //    service's concurrent-creator fallback path is exercised for real.
    //  - version = CAS counter: updateMany() matches {id, version, status in}
    //    exactly like the production single-statement transitions.
    //  - updatedAt is auto-bumped on create/update (Prisma @updatedAt).
    manualIntervention: {
      findUnique: async ({ where } = {}) => {
        const row = interventionRows.get(where?.id);
        return row ? { ...row } : null;
      },
      findFirst: async ({ where = {} } = {}) => {
        const row = interventionMatchWhere(where)[0];
        return row ? { ...row } : null;
      },
      findMany: async ({ where = {}, orderBy, skip = 0, take } = {}) => {
        let rows = interventionMatchWhere(where).map((r) => ({ ...r }));
        for (const spec of [...(orderBy ?? [])].reverse()) {
          const [k, dir] = Object.entries(spec)[0] ?? [];
          if (!k) continue;
          rows.sort((a, b) => {
            const av = a[k]; const bv = b[k];
            // timestamp columns are Dates — compare numerically (String(Date)
            // has second granularity and is a broken comparator for sub-second diffs)
            if (av instanceof Date || bv instanceof Date) {
              const avn = av instanceof Date ? av.getTime() : -Infinity;
              const bvn = bv instanceof Date ? bv.getTime() : Infinity;
              if (avn === bvn) return 0;
              const r = avn < bvn ? -1 : 1;
              return dir === 'desc' ? -r : r;
            }
            if (av === bv) return 0;
            const r = av === null ? -1 : bv === null ? 1 : String(av) < String(bv) ? -1 : 1;
            return dir === 'desc' ? -r : r;
          });
        }
        return take === undefined ? rows.slice(skip) : rows.slice(skip, skip + take);
      },
      count: async ({ where = {} } = {}) => interventionMatchWhere(where).length,
      create: async ({ data }) => {
        if (data.id !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(data.id))) {
          throw Object.assign(new Error(`invalid input syntax for type uuid: "${data.id}"`), { code: 'P2007' });
        }
        // partial unique: open-episode rows only (MD §6.3 race guard)
        const dup = [...interventionRows.values()].find(
          (r) => r.dedupeKey === data.dedupeKey && OPEN_EPISODE_STATUSES.includes(r.status),
        );
        if (dup) {
          throw Object.assign(new Error(`Unique constraint failed on the fields: (dedupe_key)`), { code: 'P2002' });
        }
        const ts = now();
        const row = {
          id: data.id ?? randomUUID(),
          deviceId: data.deviceId ?? null,
          deviceNameSnapshot: data.deviceNameSnapshot ?? null,
          source: data.source,
          category: data.category,
          severity: data.severity ?? 'warning',
          status: data.status ?? 'open',
          automationDisposition: data.automationDisposition ?? 'not_applicable',
          title: data.title,
          summary: data.summary ?? null,
          evidence: data.evidence ?? null,
          heuristic: data.heuristic ?? false,
          signalCount: data.signalCount ?? 1,
          version: data.version ?? 1,
          resolutionSummary: data.resolutionSummary ?? null,
          createdAt: data.createdAt ?? ts,
          updatedAt: data.updatedAt ?? ts,
          acknowledgedAt: data.acknowledgedAt ?? null,
          resolvedAt: data.resolvedAt ?? null,
          assigneeUserId: data.assigneeUserId ?? null,
          dedupeKey: data.dedupeKey,
          relatedTaskRunId: data.relatedTaskRunId ?? null,
        };
        interventionRows.set(row.id, row);
        return { ...row };
      },
      updateMany: async ({ where = {}, data }) => {
        const matched = interventionMatchWhere(where);
        for (const row of matched) {
          Object.assign(row, applyInterventionData(row, data));
          row.updatedAt = now();
        }
        return { count: matched.length };
      },
      groupBy: async ({ by = [], where = {} } = {}) => {
        const rows = interventionMatchWhere(where);
        const groups = new Map();
        for (const row of rows) {
          const key = by.map((k) => row[k]).join('\u0000');
          if (!groups.has(key)) groups.set(key, { count: 0, keys: by.map((k) => row[k]) });
          groups.get(key).count += 1;
        }
        return [...groups.values()].map((g) => ({
          ...Object.fromEntries(g.keys.map((v, i) => [by[i], v])),
          _count: { _all: g.count },
        }));
      },
    },
    manualInterventionHistory: {
      create: async ({ data }) => {
        const ts = now();
        const row = {
          id: data.id ?? `ih${String(++historySeq).padStart(10, '0')}`,
          interventionId: data.interventionId,
          fromStatus: data.fromStatus ?? null,
          toStatus: data.toStatus,
          action: data.action,
          actorUserId: data.actorUserId ?? null,
          note: data.note ?? null,
          detailsJson: data.detailsJson ?? null,
          createdAt: data.createdAt ?? ts,
        };
        historyRows.set(row.id, row);
        return { ...row };
      },
      findMany: async ({ where = {}, orderBy } = {}) => {
        let rows = [...historyRows.values()].filter((h) => {
          if (where.interventionId !== undefined && h.interventionId !== where.interventionId) return false;
          return true;
        });
        rows = rows.map((r) => ({ ...r }));
        for (const spec of [...(orderBy ?? [])].reverse()) {
          const [k, dir] = Object.entries(spec)[0] ?? [];
          if (!k) continue;
          rows.sort((a, b) => {
            const av = a[k]; const bv = b[k];
            if (av instanceof Date || bv instanceof Date) {
              const avn = av instanceof Date ? av.getTime() : -Infinity;
              const bvn = bv instanceof Date ? bv.getTime() : Infinity;
              if (avn === bvn) return 0;
              const r = avn < bvn ? -1 : 1;
              return dir === 'desc' ? -r : r;
            }
            if (a[k] === b[k]) return 0;
            const r = String(a[k]) < String(b[k]) ? -1 : 1;
            return dir === 'desc' ? -r : r;
          });
        }
        return rows;
      },
      count: async ({ where = {} } = {}) => [...historyRows.values()].filter((h) => (where.interventionId === undefined || h.interventionId === where.interventionId)).length,
    },

    // teardown seam
    $disconnect: async () => {},
    __state: {
      userRows, userById, sessionRows, settingRows, auditRows,
      runRows, eventRows, approvalRows, providerRows,
      scheduleRows, definitionRows, templateRows, deviceRows,
      interventionRows, historyRows,
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
  let schedulerHang = false; // models ioredis offline-queue: the command is
  // accepted but NEVER settles while redis is down (live-verified 2026-10-15
  // — it hung the POST /schedules HTTP request for minutes).
  const hang = () => new Promise(() => {});
  const down = () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:6379 (fake scheduler down)');
    err.code = 'ECONNREFUSED';
    return err;
  };
  // A job reference with the subset of the real BullMQ Job API the code uses.
// Faithful to BullMQ 6 (live-verified 2026-10-15): the Job Scheduler
// materializes the NEXT fire of an enabled non-once scheduler as a
// DELAYED job with id `repeat:<key>:<nextMs>` (job-scheduler.js
// getSchedulerNextJobId). The reconciler's orphan sweep depends on this
// exact shape — a future repeat job is LIVE, only a past one is a
// crash leftover.
const clearRepeatJobs = (key) => {
  for (const [id, j] of jobs) {
    if (j.name === 'schedule-fire' && id.startsWith(`repeat:${key}:`)) jobs.delete(id);
  }
};
const seedRepeatJob = (key, slotMs, template) => {
  const id = `repeat:${key}:${slotMs}`;
  if (!jobs.has(id)) {
    jobs.set(id, {
      id,
      name: template?.name ?? 'schedule-fire',
      data: template?.data ?? {},
      state: 'delayed',
      opts: { delay: slotMs - Date.now() },
    });
  }
  return id;
};

  const wrapJob = (j) => ({
    id: j.id,
    name: j.name,
    data: j.data,
    state: j.state,
    opts: j.opts,
    // Faithful to BullMQ: only waiting/delayed jobs are removable — an
    // active/finished job makes remove() REJECT (callers treat it as a no-op
    // via catch; BR-B2 gen2: the fake previously returned false, which real
    // BullMQ never does — helpers that ignore the return would lie).
    async remove() {
      const jj = jobs.get(j.id);
      if (!jj || (jj.state !== 'waiting' && jj.state !== 'delayed')) {
        throw new Error(`Job with id '${j.id}' cannot be removed (state: ${jj?.state ?? 'gone'})`);
      }
      jobs.delete(j.id);
      removed.push(j.id);
      return true;
    },
    // BullMQ Job.moveToDelayed(ms) — waiting/delayed → delayed (active jobs
    // reject: the worker already owns them). BR-B2 slot-defer path.
    async moveToDelayed(ms) {
      const jj = jobs.get(j.id);
      if (!jj) throw new Error(`Job with id '${j.id}' not found`);
      if (jj.state === 'active') {
        throw new Error(`Job with id '${j.id}' cannot be moved to delayed (state: active)`);
      }
      jj.state = 'delayed';
      jj.opts = { ...jj.opts, delay: ms };
      return wrapJob(jj);
    },
  });
  return {
    enqueued,
    removed,
    jobs,
    schedulers,
    __setSchedulerDown(flag = true) { schedulerDown = Boolean(flag); },
    __isSchedulerDown() { return schedulerDown; },
    __setSchedulerHang(flag = true) { schedulerHang = Boolean(flag); },
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
      if (schedulerHang) return hang();
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
        template: { data: template.data ?? {}, opts: template.opts ?? {} }, // real shape: template holds data+opts only; name is top-level
      });
      // Materialize the next fire (replaces any pending one for this key).
      clearRepeatJobs(key);
      const nextMs = pattern
        ? nextCronRun(pattern, repeatOpts.tz ?? 'UTC', new Date()).getTime()
        : Date.now() + every;
      seedRepeatJob(key, nextMs, template);
    },
    // Test seam: plant a repeat job for an arbitrary (e.g. past) slot —
    // models what BullMQ's internal scheduler add would produce.
    __seedRepeatJob(key, slotMs, data) {
      return seedRepeatJob(key, slotMs, { name: 'schedule-fire', data });
    },
    async getJobSchedulers() {
      if (schedulerHang) return hang();
      if (schedulerDown) throw down();
      return [...schedulers.values()].map((s) => ({ ...s }));
    },
    async getJobSchedulersCount() {
      if (schedulerHang) return hang();
      if (schedulerDown) throw down();
      return schedulers.size;
    },
    async removeJobScheduler(key) {
      if (schedulerHang) return hang();
      if (schedulerDown) throw down();
      clearRepeatJobs(key);
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
  trustProxy: true,
  // Hermetic: no outbound DNS in the suite. The SSRF guard's literal-IP and
  // reserved-name checks still run; the DNS-resolution path is unit-tested
  // separately with an injected resolver (tests/unit/url-guard.test.js).
  providerUrlDnsCheck: false,
};
