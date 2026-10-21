/**
 * Tool execution — the worker has NO Docker socket (MD §4 / threat T1).
 * Every tool handler calls the API's P2 endpoints over HTTP with a service
 * token; the API enforces RBAC + the managed gate through DockerService
 * (施工 MD §11.5: tool handler 全行 P2 service 層).
 *
 * Service identity: a fixed non-human UUID with role=operator, minted by the
 * API when the `x-wa-service-token` header matches WORKER_API_TOKEN. The
 * service account CANNOT approve (approvals require a real admin session —
 * the API rejects service identity there), so the AI can never self-approve.
 */
import { TOOL_SAFETY_CLASS, truncateText, safeStringify } from '@water-army/shared';

export class ToolExecutionError extends Error {
  constructor(code, message, { statusCode } = {}) {
    super(message);
    this.name = 'ToolExecutionError';
    this.apiCode = code;
    this.statusCode = statusCode ?? 502;
  }
}

/**
 * Minimal JSON HTTP client for the API (injectable fetch for tests).
 * Maps the API error envelope {error:{code,message,requestId}} to
 * ToolExecutionError so tool results carry stable codes.
 */
export function createApiClient({ baseUrl, serviceToken, timeoutMs = 15_000, fetchImpl, log = console }) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  if (!base) throw new ToolExecutionError('CONFIG_MISSING', 'tool API base URL is not configured (API_INTERNAL_URL)');
  if (!serviceToken) throw new ToolExecutionError('CONFIG_MISSING', 'service token is not configured (WORKER_API_TOKEN)');
  const fetchFn = fetchImpl ?? globalThis.fetch;

  async function request(method, path, { query = undefined, body = undefined } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v != null && v !== '') url.searchParams.set(k, String(v));
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('tool request timeout')), timeoutMs);
    let res;
    try {
      res = await fetchFn(url, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-wa-service-token': serviceToken,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      const aborted = ctrl.signal.aborted;
      throw new ToolExecutionError(
        aborted ? 'TOOL_TIMEOUT' : 'TOOL_UNAVAILABLE',
        aborted ? `tool request timed out after ${timeoutMs}ms` : `API unreachable: ${err?.message ?? err}`,
        { statusCode: aborted ? 504 : 503 },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      if (!res.ok) throw new ToolExecutionError('TOOL_BAD_RESPONSE', `API returned non-JSON (${res.status})`, { statusCode: res.status });
    }
    if (!res.ok) {
      const code = data?.error?.code ?? `HTTP_${res.status}`;
      const message = data?.error?.message ?? `API error ${res.status}`;
      throw new ToolExecutionError(code, message, { statusCode: res.status });
    }
    return data;
  }

  return {
    /** GET /api/health/ready — system.get_health */
    async healthReady() {
      return request('GET', '/api/health/ready');
    },
    /** GET /api/containers */
    async listContainers({ state, managed, q, page, pageSize } = {}) {
      return request('GET', '/api/containers', { query: { state, managed, q, page, pageSize } });
    },
    /** GET /api/containers/:id */
    async inspectContainer(id) {
      return request('GET', `/api/containers/${encodeURIComponent(id)}`);
    },
    /** GET /api/containers/:id/logs */
    async containerLogs(id, { tail } = {}) {
      return request('GET', `/api/containers/${encodeURIComponent(id)}/logs`, { query: { tail } });
    },
    /** POST /api/containers/:id/restart (operator via service token) */
    async restartContainer(id) {
      return request('POST', `/api/containers/${encodeURIComponent(id)}/restart`, { body: {} });
    },
    /** GET /api/devices/redroid/:id — redroid.get_device_status (R4 MD §6.3). */
    async redroidDeviceStatus(idOrName) {
      return request('GET', `/api/devices/redroid/${encodeURIComponent(idOrName)}`);
    },
    // BR-B3: batch container lifecycle (the worker drives containers through
    // these routes with the service token — the worker has no docker socket,
    // MD §4 / threat T1). The API error envelope's stable codes ride the
    // ToolExecutionError status for the engine's retry policy mapping.
    /** POST /api/task-runs/:runId/containers/start (create-or-adopt, idempotent) */
    async batchContainersStart(runId) {
      return request('POST', `/api/task-runs/${encodeURIComponent(runId)}/containers/start`, { body: {} });
    },
    /** GET /api/task-runs/:runId/containers/health (app-layer ADB probe) */
    async batchContainersHealth(runId) {
      return request('GET', `/api/task-runs/${encodeURIComponent(runId)}/containers/health`);
    },
    /** POST /api/task-runs/:runId/containers/stop (reversible — volume kept) */
    async batchContainersStop(runId) {
      return request('POST', `/api/task-runs/${encodeURIComponent(runId)}/containers/stop`, { body: {} });
    },
  };
}

/**
 * Build the P3 tool handlers. Each handler: validates args (done by the
 * engine via validateToolArgs), calls the API, returns a truncated,
 * JSON-serializable result. THROWS ToolExecutionError on failure — the
 * engine converts that into a `tool result error` fed back to the model
 * (a tool failure is NOT a run failure — the model reports it).
 */
export function createToolHandlers({ api, log = console }) {
  return {
    'system.get_health': async () => {
      const r = await api.healthReady();
      return { ok: true, result: r };
    },

    'docker.list_managed_containers': async (args) => {
      const r = await api.listContainers({ state: args.state, managed: 'true', q: args.q, page: args.page, pageSize: args.pageSize });
      // Cap the feedback size: summarize, don't dump every field.
      const items = Array.isArray(r?.containers) ? r.containers : (Array.isArray(r) ? r : []);
      return {
        ok: true,
        result: {
          total: r?.total ?? items.length,
          containers: items.slice(0, 25).map((c) => ({
            id: c.id ?? null,
            name: c.name ?? null,
            image: c.image ?? null,
            state: c.state ?? c.status ?? null,
            status: c.status ?? null,
          })),
        },
      };
    },

    'docker.get_managed_container_status': async (args) => {
      const s = await api.inspectContainer(args.container);
      return {
        ok: true,
        result: {
          id: s.id ?? args.container,
          name: s.name ?? null,
          image: s.image ?? null,
          state: s.state ?? s.status ?? null,
          running: s.running ?? (s.state === 'running' || s.status === 'running'),
          managed: s.managed ?? null,
          startedAt: s.startedAt ?? s.start ?? null,
          restartCount: s.restartCount ?? null,
        },
      };
    },

    'docker.get_managed_container_logs': async (args) => {
      const l = await api.containerLogs(args.container, { tail: args.tail });
      const raw = typeof l?.logs === 'string' ? l.logs : safeStringify(l?.logs ?? l);
      return { ok: true, result: { logs: truncateText(raw, 12_000) } };
    },

    // approval_required — the engine gates this behind a human approval.
    'docker.restart_managed': async (args) => {
      const r = await api.restartContainer(args.container);
      return { ok: true, result: r };
    },

    // R4 (MD §6.3): the worker-side fail-closed signal. The deterministic
    // dispatch gate is `networkReady === true` (HEALTHY + fresh canary +
    // zero consecutive failures) — the worker must never infer "running"
    // from containerState/adbState alone (the legacy green-badge bug).
    // Zero secrets: status vocabulary only, no proxy URL/credential.
    'redroid.get_device_status': async (args) => {
      const r = await api.redroidDeviceStatus(args.device);
      const d = r?.device ?? {};
      const net = d.proxy?.network ?? null;
      return {
        ok: true,
        result: {
          id: d.id ?? null,
          name: d.name ?? null,
          containerState: d.containerState ?? null,
          adbState: d.adbState ?? null,
          network: net
            ? {
                state: net.state,
                stale: net.stale,
                checkedAt: net.checkedAt,
                lastSuccessAt: net.lastSuccessAt,
                consecutiveFailures: net.consecutiveFailures ?? 0,
                lastError: net.lastError ? { code: net.lastError.code, at: net.lastError.at } : null,
                checks: net.checks ?? null,
                dispatch: net.networkReady ? 'ALLOWED' : 'BLOCKED',
              }
            : null,
        },
      };
    },
  };
}

/**
 * Safety-class guard used by the engine (MD §11.4: 其他 class disabled).
 * @returns {{allowed:boolean, reason?:string}}
 */
export function toolGate(tool) {
  if (!tool) return { allowed: false, reason: 'unknown tool' };
  if (tool.safetyClass === TOOL_SAFETY_CLASS.READONLY) return { allowed: true, auto: true };
  if (tool.safetyClass === TOOL_SAFETY_CLASS.APPROVAL_REQUIRED) return { allowed: true, auto: false };
  return { allowed: false, reason: `safety class '${tool.safetyClass}' is not enabled in P3` };
}
