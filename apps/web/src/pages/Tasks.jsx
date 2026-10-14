import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import { StateFrame } from '../components/StateFrame';
import { navigate } from '../router';
import {
  TASK_RUN_STATUS,
  taskStatusBadgeClass,
  taskStatusLabel,
  safetyClassLabel,
  formatDuration,
} from '../components/task-utils';
import { timeAgo, formatDateTime } from '../components/container-utils';

const PAGE_SIZE = 25;
const STATUS_FILTERS = ['', ...TASK_RUN_STATUS];

const EMPTY_FORM = {
  prompt: '',
  title: '',
  provider: '',
  tools: [],
  timeoutSec: 300,
  maxAttempts: 3,
  mode: 'approved_tools',
};

// ------------------------------------------------------------------ create form

function CreateRunCard({ onClose, onCreated, toolsData }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const tools = toolsData?.tools ?? [];
  const set = (part) => setForm((f) => ({ ...f, ...part }));
  const toggleTool = (name) =>
    setForm((f) => ({
      ...f,
      tools: f.tools.includes(name) ? f.tools.filter((t) => t !== name) : [...f.tools, name],
    }));

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = { prompt: form.prompt.trim() };
      if (form.title.trim()) body.title = form.title.trim();
      if (form.provider.trim()) body.provider = form.provider.trim();
      if (form.tools.length) body.tools = form.tools;
      const timeoutMs = Math.round(Number(form.timeoutSec) * 1000);
      if (Number.isFinite(timeoutMs) && timeoutMs >= 1000) body.timeoutMs = timeoutMs;
      const maxAttempts = Math.round(Number(form.maxAttempts));
      if (Number.isFinite(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 5) body.maxAttempts = maxAttempts;
      body.mode = form.mode;
      const res = await api.post('/api/tasks/runs', body);
      onCreated(res.taskRun?.id);
    } catch (err) {
      setError(`${err.code ?? 'ERROR'} — ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card confirm-card" role="dialog" aria-label="Create task run">
      <h2>New task run</h2>
      <p className="muted">
        Submits to the queue and returns immediately (202). The provider is resolved server-side —
        leave blank to use the server default (<code>AI_PROVIDER</code> env).
      </p>
      <div className="confirm-grid">
        <label>
          Prompt <strong>*</strong>
          <textarea
            className="input"
            rows={4}
            value={form.prompt}
            onChange={(e) => set({ prompt: e.target.value })}
            placeholder="What should the AI do? (max 20 000 chars)"
            maxLength={20000}
            autoFocus
          />
        </label>
        <label>
          Title (optional)
          <input
            className="input"
            value={form.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="Short label for the list view"
            maxLength={200}
          />
        </label>
        <label>
          Provider
          <input
            className="input"
            list="provider-names"
            value={form.provider}
            onChange={(e) => set({ provider: e.target.value })}
            placeholder="(blank = server default)"
          />
          <datalist id="provider-names">
            <option value="mock" />
          </datalist>
        </label>
        <label>
          Timeout (seconds, max per system cap)
          <input
            className="input"
            type="number"
            min={1}
            max={3600}
            value={form.timeoutSec}
            onChange={(e) => set({ timeoutSec: e.target.value })}
          />
        </label>
        <label>
          Max attempts (1–5)
          <input
            className="input"
            type="number"
            min={1}
            max={5}
            value={form.maxAttempts}
            onChange={(e) => set({ maxAttempts: e.target.value })}
          />
        </label>
        <label>
          Mode
          <select className="input" value={form.mode} onChange={(e) => set({ mode: e.target.value })}>
            <option value="approved_tools">approved_tools — analysis + approval-gated tools</option>
            <option value="analysis_only">analysis_only — no tools offered</option>
          </select>
        </label>
        <div>
          <span className="muted">Tools allowlist (blank = all enabled tools)</span>
          <div className="toolbar-group" style={{ marginTop: 6 }}>
            {tools.length ? (
              tools.map((t) => (
                <label key={t.name} className="check" title={t.description}>
                  <input
                    type="checkbox"
                    checked={form.tools.includes(t.name)}
                    onChange={() => toggleTool(t.name)}
                  />
                  <code>{t.name}</code>{' '}
                  <span className="pill pill-disabled">{safetyClassLabel(t.safetyClass)}</span>
                </label>
              ))
            ) : (
              <span className="muted">loading tool registry…</span>
            )}
          </div>
        </div>
      </div>
      {error ? <div className="error-box">{error}</div> : null}
      <div className="toolbar-group">
        <button className="btn btn-primary" disabled={busy || form.prompt.trim() === ''} onClick={submit}>
          {busy ? 'Submitting…' : 'Create run'}
        </button>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------- page

export function Tasks() {
  const me = useApi(() => api.get('/api/auth/me'));
  const tools = useApi(() => api.get('/api/tools'));
  const [providerOptions, setProviderOptions] = useState([]);
  const [filters, setFilters] = useState({ status: '', provider: '', page: 1 });
  const [showCreate, setShowCreate] = useState(false);

  const user = me.data?.user;
  const role = user?.role;
  const canCreate = role === 'operator' || role === 'admin';

  // Admins see configured provider names (names only — keys never leave the API).
  useEffect(() => {
    if (role !== 'admin') return undefined;
    let cancelled = false;
    api
      .get('/api/providers')
      .then((res) => {
        if (!cancelled) setProviderOptions((res.providers ?? []).map((p) => p.name));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [role]);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.status) p.set('status', filters.status);
    if (filters.provider) p.set('provider', filters.provider);
    p.set('page', String(filters.page));
    p.set('pageSize', String(PAGE_SIZE));
    return `/api/tasks/runs?${p.toString()}`;
  }, [filters]);

  const list = useApi(() => api.get(query), [query]);
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const page = list.data?.page ?? 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const patch = (part) => setFilters((f) => ({ ...f, ...part, page: part.page ?? 1 }));

  return (
    <div className="stack">
      <div className="detail-head">
        <div>
          <h1>AI task runs</h1>
          <div className="muted">Queued AI work with tool calls, approvals, and full event history.</div>
        </div>
        {canCreate ? (
          <div className="toolbar-group">
            <button className="btn btn-primary" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? 'Close' : '+ New task run'}
            </button>
          </div>
        ) : (
          <span className="muted" title="Creating task runs requires the operator role">
            read-only (viewer)
          </span>
        )}
      </div>

      {showCreate && canCreate ? (
        <CreateRunCard
          toolsData={tools.data}
          onClose={() => setShowCreate(false)}
          onCreated={(runId) => {
            setShowCreate(false);
            navigate(`/tasks/${encodeURIComponent(runId)}`);
          }}
        />
      ) : null}

      <div className="toolbar">
        <div className="toolbar-group">
          <select
            className="input"
            value={filters.status}
            onChange={(e) => patch({ status: e.target.value })}
            aria-label="Filter by status"
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s || 'all'} value={s}>{s === '' ? 'All statuses' : s}</option>
            ))}
          </select>
          <input
            className="input"
            type="search"
            list="provider-filter-names"
            placeholder="Filter provider (name)"
            value={filters.provider}
            onChange={(e) => patch({ provider: e.target.value })}
            aria-label="Filter by provider"
          />
          <datalist id="provider-filter-names">
            <option value="mock" />
            {providerOptions.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <button className="btn" onClick={list.reload} title="Re-fetch from the API">↻</button>
        </div>
      </div>

      <StateFrame
        loading={list.loading}
        error={list.error}
        empty={!list.loading && !list.error && items.length === 0}
        emptyTitle="No task runs match"
        emptyHint={filters.status || filters.provider ? 'Adjust the filters.' : 'Create the first run with “New task run”.'}
      >
        <div className="table-wrap">
          <table className="list-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Provider</th>
                <th>Status</th>
                <th>Attempt</th>
                <th>Duration</th>
                <th>Requested by</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <a className="link" href={`#/tasks/${encodeURIComponent(r.id)}`}>
                      {r.title || r.promptPreview || '(untitled)'}
                    </a>
                    {r.title ? (
                      <div className="muted cell-clip" title={r.promptPreview}>
                        {r.promptPreview}
                      </div>
                    ) : null}
                    <div className="muted mono">{r.id}</div>
                  </td>
                  <td className="mono">{r.provider ?? '—'}</td>
                  <td>
                    <span className={`pill state-badge ${taskStatusBadgeClass(r.status)}`}>{taskStatusLabel(r.status)}</span>
                    {r.errorCode ? (
                      <div className="muted cell-clip" title={r.errorMessage}>
                        {r.errorCode}
                      </div>
                    ) : null}
                  </td>
                  <td>{r.attempt ?? 1}</td>
                  <td>{formatDuration(r.durationMs)}</td>
                  <td className="mono cell-clip">{r.requestedBy ?? '—'}</td>
                  <td title={r.createdAt ? formatDateTime(r.createdAt) : ''}>{timeAgo(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="pager">
          <button className="btn" disabled={page <= 1} onClick={() => patch({ page: page - 1 })}>← Prev</button>
          <span className="muted">page {page} of {totalPages} · {total} runs</span>
          <button className="btn" disabled={page >= totalPages} onClick={() => patch({ page: page + 1 })}>Next →</button>
        </div>
      </StateFrame>
    </div>
  );
}

export default Tasks;
