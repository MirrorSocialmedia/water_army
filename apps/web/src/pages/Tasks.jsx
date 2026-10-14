import { useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import { StateFrame } from '../components/StateFrame';
import { timeAgo } from '../components/container-utils';
import {
  TASK_STATUSES,
  canCancel,
  canRetry,
  formatDuration,
  isTerminalStatus,
  taskBadgeClass,
} from '../components/task-utils';

const PAGE_SIZE = 20;

/**
 * P3 — AI task runs: list + create + pending approvals queue.
 * RBAC (mirrors the API): viewer = read, operator = create/cancel/retry,
 * admin = approvals review + provider management.
 */
export function Tasks() {
  const me = useApi(() => api.get('/api/auth/me'));
  const role = me.data?.user?.role ?? 'viewer';
  const canAct = role === 'admin' || role === 'operator';

  const [qInput, setQInput] = useState('');
  const [filters, setFilters] = useState({ status: '', provider: '', page: 1 });
  const [busy, setBusy] = useState({}); // { 'id:cancel': true, ... }
  const [errors, setErrors] = useState({}); // { 'id:cancel': 'CODE — msg' }
  const [newForm, setNewForm] = useState({ prompt: '', provider: 'mock', timeoutMs: '' });
  const [newError, setNewError] = useState(null);
  const [creating, setCreating] = useState(false);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.status) p.set('status', filters.status);
    if (filters.provider) p.set('provider', filters.provider);
    p.set('page', String(filters.page));
    p.set('pageSize', String(PAGE_SIZE));
    return `/api/tasks/runs?${p.toString()}`;
  }, [filters]);

  const list = useApi(() => api.get(query), [query]);
  const approvals = useApi(() => api.get('/api/approvals?status=pending'), [list.data?.page]);
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const page = list.data?.page ?? 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pending = approvals.data?.items ?? [];

  const patch = (part) => setFilters((f) => ({ ...f, ...part, page: part.page ?? 1 }));

  async function runAction(item, action) {
    const key = `${item.id}:${action}`;
    setErrors((m) => ({ ...m, [key]: null }));
    setBusy((m) => ({ ...m, [key]: true }));
    try {
      await api.post(`/api/tasks/runs/${encodeURIComponent(item.id)}/${action}`);
      list.reload();
      approvals.reload();
    } catch (err) {
      setErrors((m) => ({ ...m, [key]: `${err.code ?? 'ERROR'} — ${err.message}` }));
    } finally {
      setBusy((m) => ({ ...m, [key]: false }));
    }
  }

  async function submitNew(e) {
    e.preventDefault();
    setNewError(null);
    setCreating(true);
    try {
      const body = { prompt: newForm.prompt.trim(), provider: newForm.provider.trim() || 'mock' };
      if (newForm.timeoutMs) body.timeoutMs = Number(newForm.timeoutMs);
      const res = await api.post('/api/tasks/runs', body);
      window.location.hash = `/tasks/${res.taskRun.id}`;
    } catch (err) {
      setNewError(`${err.code ?? 'ERROR'} — ${err.message}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="stack">
      <h1>AI task runs</h1>

      {pending.length > 0 ? (
        <div className="card approval-card" role="alert">
          <h2>{pending.length} approval{pending.length > 1 ? 's' : ''} waiting</h2>
          {pending.map((a) => (
            <div className="approval-item" key={a.id}>
              <div className="toolbar-group">
                <span className={`pill task-approval`}>{a.toolName}</span>
                <span className="muted">{JSON.stringify(a.arguments ?? {})}</span>
                <span className="muted">· requested {timeAgo(a.requestedAt)}</span>
                <a className="link" href={`#/tasks/${a.taskRunId}`}>view run</a>
              </div>
              {role === 'admin' ? (
                <div className="toolbar-group">
                  <button className="btn" onClick={() => approvals.reload()}>open detail to review</button>
                </div>
              ) : (
                <p className="muted">Review requires an admin session.</p>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {canAct ? (
        <form className="card confirm-card" onSubmit={submitNew} aria-label="Create task run">
          <h2>New task run</h2>
          <div className="confirm-grid">
            <label>
              Prompt
              <textarea
                className="input"
                rows={2}
                value={newForm.prompt}
                onChange={(e) => setNewForm((f) => ({ ...f, prompt: e.target.value }))}
                placeholder="What should the AI do? (tools are registry-bound; sensitive tools need approval)"
              />
            </label>
            <label>
              Provider
              <input
                className="input"
                value={newForm.provider}
                onChange={(e) => setNewForm((f) => ({ ...f, provider: e.target.value }))}
                placeholder="mock"
              />
            </label>
            <label>
              Timeout (ms, optional)
              <input
                className="input"
                type="number"
                min={1000}
                step={1000}
                value={newForm.timeoutMs}
                onChange={(e) => setNewForm((f) => ({ ...f, timeoutMs: e.target.value }))}
                placeholder="default"
              />
            </label>
          </div>
          {newError ? <div className="error-box">{newError}</div> : null}
          <div className="toolbar-group">
            <button className="btn" type="submit" disabled={creating || !newForm.prompt.trim()}>
              {creating ? 'Queuing…' : 'Queue run'}
            </button>
          </div>
        </form>
      ) : null}

      <div className="toolbar">
        <form
          className="toolbar-group"
          onSubmit={(e) => { e.preventDefault(); patch({ page: 1 }); }}
        >
          <select
            className="input"
            value={filters.status}
            onChange={(e) => patch({ status: e.target.value })}
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            {TASK_STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
          <input
            className="input"
            type="text"
            placeholder="Provider…"
            value={filters.provider}
            onChange={(e) => setFilters((f) => ({ ...f, provider: e.target.value, page: 1 }))}
            aria-label="Filter by provider"
          />
          <button className="btn" onClick={list.reload} title="Re-fetch from the API">↻</button>
        </form>
      </div>

      <StateFrame
        loading={list.loading}
        error={list.error}
        empty={!list.loading && !list.error && items.length === 0}
        emptyTitle="No task runs"
        emptyHint={canAct ? 'Queue the first run above.' : 'Ask an operator to queue a run.'}
      >
        <div className="table-wrap">
          <table className="list-table">
            <thead>
              <tr>
                <th>Created</th>
                <th>Prompt</th>
                <th>Status</th>
                <th>Provider</th>
                <th>Attempt</th>
                <th>Duration</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const errKey = Object.keys(errors).find((k) => k.startsWith(`${item.id}:`));
                return (
                  <tr key={item.id} className={errKey ? 'row-error' : null}>
                    <td title={item.createdAt ? new Date(item.createdAt).toLocaleString() : ''}>{timeAgo(item.createdAt)}</td>
                    <td>
                      <a className="link" href={`#/tasks/${encodeURIComponent(item.id)}`}>
                        {(item.promptPreview ?? '(no prompt)').slice(0, 80)}
                      </a>
                      <div className="muted mono">{item.id.slice(0, 8)}…</div>
                    </td>
                    <td>
                      <span className={`pill state-badge ${taskBadgeClass(item.status)}`}>{item.status.replace('_', ' ')}</span>
                      {item.errorCode ? <div className="muted cell-clip" title={item.errorMessage}>{item.errorCode}</div> : null}
                    </td>
                    <td className="mono">{item.provider ?? '—'}</td>
                    <td>{item.attempt}</td>
                    <td>{formatDuration(item.durationMs)}</td>
                    <td>
                      <div className="toolbar-group">
                        <a className="btn btn-ghost" href={`#/tasks/${encodeURIComponent(item.id)}`}>Detail</a>
                        {canAct && canCancel(item.status) ? (
                          <button
                            className="btn"
                            disabled={busy[`${item.id}:cancel`]}
                            onClick={() => runAction(item, 'cancel')}
                          >
                            {busy[`${item.id}:cancel`] ? 'Cancelling…' : 'Cancel'}
                          </button>
                        ) : null}
                        {canAct && canRetry(item.status) ? (
                          <button
                            className="btn"
                            disabled={busy[`${item.id}:retry`]}
                            onClick={() => runAction(item, 'retry')}
                          >
                            {busy[`${item.id}:retry`] ? 'Retrying…' : 'Retry'}
                          </button>
                        ) : null}
                      </div>
                      {errKey ? <div className="error-box small">{errors[errKey]}</div> : null}
                    </td>
                  </tr>
                );
              })}
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
