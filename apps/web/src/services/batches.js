/**
 * Batch Rotation service layer (BR-B5, MD §10/§11).
 *
 * Two groups:
 *  - B5 endpoints (live now): monitor summary, metrics, identities, reports.
 *  - B2 control endpoints (MD §10 contract — on main after B2 merge / B6
 *    integration). The signatures follow the contract exactly; until then
 *    the API answers 404 NOT_FOUND and the UI renders an honest "not yet
 *    available" state (same pattern as FutureApiPage — never fake data).
 *
 * Zero-secret contract (MD §12): every field returned by these calls is
 * already allow-listed + masked on the API side; this layer adds nothing
 * sensitive and never serialises cookies/tokens/passwords.
 */
import { api } from '../api/client';

// ------------------------------------------------------------- B5 (live) ---
export const monitor = {
  /** MD §11.2 — full live monitor snapshot (viewer+). */
  summary: () => api.get('/api/batch-monitor/summary'),
  /** MD §13 — metrics + alerts payload (viewer+). */
  metrics: () => api.get('/api/batches/metrics'),
};

export const identities = {
  /** MD §10 — paginated list. qs: status / q / page / pageSize. */
  list: (qs = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(qs)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
    const s = p.toString();
    return api.get(`/api/identities${s ? `?${s}` : ''}`);
  },
  /** MD §11.3 — identity detail (viewer+). */
  detail: (id) => api.get(`/api/identities/${encodeURIComponent(id)}`),
};

export const reports = {
  /** MD §11.4 — completed/in-progress cycles (viewer+). */
  list: () => api.get('/api/batch-reports'),
  /** Export URL (operator+). The download is a raw blob fetch (not JSON). */
  exportUrl: (cycleId, format = 'json') => `/api/batch-reports/${encodeURIComponent(cycleId)}?format=${format}`,
  /** Raw blob download (operator+) — JSON or CSV, zero-secret by API gate. */
  async download(cycleId, format = 'json') {
    const res = await fetch(reports.exportUrl(cycleId, format), { credentials: 'same-origin' });
    if (!res.ok) {
      let body = null;
      try {
        body = await res.json();
      } catch {
        /* non-JSON error body */
      }
      const err = new Error(body?.error?.message ?? `Export failed (${res.status})`);
      err.status = res.status;
      err.code = body?.error?.code ?? 'EXPORT_FAILED';
      err.requestId = body?.error?.requestId ?? null;
      throw err;
    }
    const blob = await res.blob();
    const name = `batch-cycle-${cycleId}.${format === 'csv' ? 'csv' : 'json'}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return { filename: name, size: blob.size };
  },
};

// ------------------------------------------- B2 control (MD §10 contract) ---
/**
 * Control-plane endpoints owned by B2 (scheduler/queue). Not on main yet —
 * every call 404s until B6 integration. The UI gates the buttons on RBAC
 * (MD §12) and shows the 404 as an honest "delivered in B6" state.
 */
export const control = {
  /** Dry-run — zero side effects (MD §11.1: Preview is the default action). */
  preview: (body) => api.post('/api/batches/preview', body),
  /** Create confirmed batch (requires idempotency key per MD §10). */
  create: (body) => api.post('/api/batches', body),
  get: (id) => api.get(`/api/batches/${encodeURIComponent(id)}`),
  start: (id, body = {}) => api.post(`/api/batches/${encodeURIComponent(id)}/start`, body),
  pause: (id) => api.post(`/api/batches/${encodeURIComponent(id)}/pause`),
  resume: (id) => api.post(`/api/batches/${encodeURIComponent(id)}/resume`),
  cancel: (id, body = {}) => api.post(`/api/batches/${encodeURIComponent(id)}/cancel`, body),
  retryRun: (runId) => api.post(`/api/task-runs/${encodeURIComponent(runId)}/retry`),
  cancelRun: (runId) => api.post(`/api/task-runs/${encodeURIComponent(runId)}/cancel`),
  runLogs: (runId, cursor) =>
    api.get(`/api/task-runs/${encodeURIComponent(runId)}/logs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
};
