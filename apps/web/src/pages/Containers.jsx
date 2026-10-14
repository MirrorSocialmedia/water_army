import { useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import { StateFrame } from '../components/StateFrame';
import { ContainerActions as CellActions } from '../components/ContainerActions';
import {
  formatBytes,
  formatPct,
  stateBadgeClass,
  timeAgo,
} from '../components/container-utils';

const PAGE_SIZE = 50;
const STATE_FILTERS = ['', 'running', 'exited', 'paused', 'created', 'dead'];
const MANAGED_FILTERS = ['', 'managed', 'unmanaged'];

export function Containers() {
  const me = useApi(() => api.get('/api/auth/me'));
  const [qInput, setQInput] = useState('');
  const [filters, setFilters] = useState({ q: '', state: '', managed: '', withStats: true, page: 1 });
  const [busy, setBusy] = useState({}); // { 'id:action': true, 'id:delete': true }
  const [errors, setErrors] = useState({}); // { 'id:action': 'CODE: message' }
  const [target, setTarget] = useState(null); // item being deleted
  const [form, setForm] = useState({ confirm: '', removeVolumes: false, force: false });
  const [deleteError, setDeleteError] = useState(null);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.q) p.set('q', filters.q);
    if (filters.state) p.set('state', filters.state);
    if (filters.managed) p.set('managed', filters.managed);
    p.set('page', String(filters.page));
    p.set('pageSize', String(PAGE_SIZE));
    if (filters.withStats) p.set('withStats', 'true');
    return `/api/containers?${p.toString()}`;
  }, [filters]);

  const list = useApi(() => api.get(query), [query]);
  const user = me.data?.user;
  const role = user?.role;
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const page = list.data?.page ?? 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const patch = (part) => setFilters((f) => ({ ...f, ...part, page: part.page ?? 1 }));

  async function runAction(item, action) {
    const key = `${item.id}:${action}`;
    setErrors((m) => ({ ...m, [key]: null }));
    setBusy((m) => ({ ...m, [key]: true }));
    try {
      await api.post(`/api/containers/${encodeURIComponent(item.id)}/${action}`);
      list.reload();
    } catch (err) {
      setErrors((m) => ({ ...m, [key]: `${err.code ?? 'ERROR'} — ${err.message}` }));
    } finally {
      setBusy((m) => ({ ...m, [key]: false }));
    }
  }

  function openDelete(item) {
    setTarget(item);
    setForm({ confirm: '', removeVolumes: false, force: false });
    setDeleteError(null);
  }

  async function confirmDelete() {
    if (!target) return;
    setBusy((m) => ({ ...m, [`${target.id}:delete`]: true }));
    setDeleteError(null);
    try {
      const result = await api.del(`/api/containers/${encodeURIComponent(target.id)}`, {
        confirm: form.confirm.trim(),
        removeVolumes: form.removeVolumes,
        force: form.force,
      });
      if (result?.bindsPreserved) {
        setDeleteError(`Deleted. Bind mounts were preserved (no removeVolumes).`);
        setTarget(null);
      } else {
        setTarget(null);
      }
      list.reload();
    } catch (err) {
      setDeleteError(`${err.code ?? 'ERROR'} — ${err.message}`);
    } finally {
      setBusy((m) => ({ ...m, [`${target.id}:delete`]: false }));
    }
  }

  return (
    <div className="stack">
      <h1>Docker containers</h1>

      <div className="toolbar">
        <form
          className="toolbar-group"
          onSubmit={(e) => {
            e.preventDefault();
            patch({ q: qInput.trim() });
          }}
        >
          <input
            className="input"
            type="search"
            placeholder="Search name / image / id…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            aria-label="Search containers"
          />
          <button className="btn" type="submit">Search</button>
        </form>
        <div className="toolbar-group">
          <select
            className="input"
            value={filters.state}
            onChange={(e) => patch({ state: e.target.value })}
            aria-label="Filter by state"
          >
            {STATE_FILTERS.map((s) => (
              <option key={s || 'all'} value={s}>{s === '' ? 'All states' : s}</option>
            ))}
          </select>
          <select
            className="input"
            value={filters.managed}
            onChange={(e) => patch({ managed: e.target.value })}
            aria-label="Filter by management"
          >
            {MANAGED_FILTERS.map((m) => (
              <option key={m || 'all'} value={m}>{m === '' ? 'All containers' : m === 'managed' ? 'App-managed' : 'Unmanaged'}</option>
            ))}
          </select>
          <label className="check">
            <input
              type="checkbox"
              checked={filters.withStats}
              onChange={(e) => patch({ withStats: e.target.checked })}
            />
            CPU/Mem
          </label>
          <button className="btn" onClick={list.reload} title="Re-fetch from the API">↻</button>
        </div>
      </div>

      <StateFrame
        loading={list.loading}
        error={list.error}
        empty={!list.loading && !list.error && items.length === 0}
        emptyTitle="No containers match"
        emptyHint={filters.q || filters.state || filters.managed ? 'Adjust the search or filters.' : 'The daemon reports no containers.'}
      >
        <div className="table-wrap">
          <table className="list-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Image</th>
                <th>Status</th>
                <th>Ports</th>
                <th>CPU</th>
                <th>Memory</th>
                <th>Managed</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const st = item.stats ?? null;
                const errKey = Object.keys(errors).find((k) => k.startsWith(`${item.id}:`));
                return (
                  <tr key={item.id} className={errKey ? 'row-error' : null}>
                    <td>
                      <a className="link" href={`#/containers/${encodeURIComponent(item.id)}`}>{item.name || '(unnamed)'}</a>
                      <div className="muted mono">{item.shortId}</div>
                    </td>
                    <td className="mono cell-clip" title={item.image}>{item.image}</td>
                    <td>
                      <span className={`pill state-badge ${stateBadgeClass(item.state)}`}>{item.state}</span>
                      {item.status ? <div className="muted cell-clip" title={item.status}>{item.status}</div> : null}
                    </td>
                    <td className="mono cell-clip" title={item.ports}>{item.ports || '—'}</td>
                    <td>{st?.error ? <span className="muted" title={st.error}>{st.error}</span> : formatPct(st?.cpuPercent)}</td>
                    <td>
                      {st?.error ? '—' : `${formatPct(st?.memPercent)}${st?.memUsageBytes ? ` · ${formatBytes(st.memUsageBytes)}` : ''}`}
                    </td>
                    <td>
                      {item.managed ? <span className="pill pill-up">managed</span> : <span className="pill">unmanaged</span>}
                      {item.template ? <div className="muted" title={`created from template ${item.template}`}>{item.template}</div> : null}
                    </td>
                    <td title={item.createdAt ? new Date(item.createdAt).toLocaleString() : ''}>{timeAgo(item.createdAt)}</td>
                    <td>
                      <CellActions item={item} role={role} busy={busy} errors={errors} onAction={runAction} onDelete={openDelete} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="pager">
          <button className="btn" disabled={page <= 1} onClick={() => patch({ page: page - 1 })}>← Prev</button>
          <span className="muted">page {page} of {totalPages} · {total} containers</span>
          <button className="btn" disabled={page >= totalPages} onClick={() => patch({ page: page + 1 })}>Next →</button>
        </div>
      </StateFrame>

      {target ? (
        <div className="card confirm-card" role="alertdialog" aria-label="Confirm container deletion">
          <h2>Delete <code>{target.name || target.shortId}</code>?</h2>
          <p className="muted">
            Admin-only and fully audited. <strong>Bind mounts are preserved by default</strong>; tick
            removeVolumes only to also remove anonymous/managed volumes. A running container needs the force flag.
          </p>
          <div className="confirm-grid">
            <label>
              Type the container name <code>{target.name}</code> to confirm
              <input
                className="input"
                value={form.confirm}
                onChange={(e) => setForm((f) => ({ ...f, confirm: e.target.value }))}
                placeholder={target.name}
                autoFocus
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.removeVolumes}
                onChange={(e) => setForm((f) => ({ ...f, removeVolumes: e.target.checked }))}
              />
              Also remove volumes (removeVolumes) — bind mounts are never touched by the API
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.force}
                onChange={(e) => setForm((f) => ({ ...f, force: e.target.checked }))}
              />
              Force (required for running containers)
            </label>
          </div>
          {deleteError ? <div className="error-box">{deleteError}</div> : null}
          <div className="toolbar-group">
            <button
              className="btn btn-danger"
              disabled={
                form.confirm.trim() !== target.name ||
                (target.state === 'running' && !form.force) ||
                busy[`${target.id}:delete`] === true
              }
              onClick={confirmDelete}
            >
              {busy[`${target.id}:delete`] ? 'Deleting…' : 'Delete permanently'}
            </button>
            <button className="btn btn-ghost" onClick={() => setTarget(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default Containers;
