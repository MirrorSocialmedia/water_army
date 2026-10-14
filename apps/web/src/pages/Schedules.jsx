import { useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import { StateFrame } from '../components/StateFrame';
import { timeAgo } from '../components/container-utils';
import { formatDuration, taskBadgeClass } from '../components/task-utils';

/**
 * P4 — Schedules: cron / interval / once, persisted in PostgreSQL and synced
 * idempotently to BullMQ job schedulers (施工 MD §1.4 / §8 / §12).
 *
 * RBAC mirrors the API: viewer = read, operator = write (create/edit/
 * pause/resume/run-now/sync/delete). A `sync_error` schedule is flagged with
 * a retry control (MD §6.6 — the DB row is authoritative; BullMQ is derived).
 */

const PAGE_SIZE = 20;
const TYPES = [
  { value: 'cron', label: 'Cron' },
  { value: 'interval', label: 'Interval' },
  { value: 'once', label: 'Once' },
];
const POLICIES = [
  { value: 'skip_if_running', label: 'Skip if a run is active' },
  { value: 'queue', label: 'Queue behind the active run' },
];

function typeLabel(s) {
  return s.scheduleType === 'cron'
    ? `cron · ${s.cronExpression}`
    : s.scheduleType === 'interval'
      ? `every ${formatDuration(s.intervalMs)}`
      : 'once';
}

/** Convert a datetime-local value (naive wall clock) to an ISO string. */
function localToIso(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

/** Empty form state (create). */
const EMPTY_FORM = {
  name: '',
  taskDefinitionId: '',
  scheduleType: 'cron',
  cronExpression: '0 9 * * *',
  intervalMs: '3600000',
  runAt: '',
  timezone: 'Asia/Taipei',
  overlapPolicy: 'skip_if_running',
};

function formFromSchedule(s) {
  return {
    name: s.name,
    taskDefinitionId: s.taskDefinitionId,
    scheduleType: s.scheduleType,
    cronExpression: s.cronExpression ?? '',
    intervalMs: s.intervalMs != null ? String(s.intervalMs) : '3600000',
    runAt: s.nextRunAt ? new Date(s.nextRunAt).toISOString().slice(0, 16) : '',
    timezone: s.timezone ?? 'Asia/Taipei',
    overlapPolicy: s.overlapPolicy ?? 'skip_if_running',
  };
}

/**
 * Create/edit form (shared). `onSubmit(body)` returns a promise; the form
 * owns its busy/error state and the backend next-run preview.
 */
function ScheduleForm({ initial, defaults, defs, editing, onSubmit, onCancel, submitLabel }) {
  const [form, setForm] = useState({ ...defaults, ...initial });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const set = (part) => setForm((f) => ({ ...f, ...part }));

  async function doPreview(e) {
    e.preventDefault();
    setError(null);
    setPreviewBusy(true);
    try {
      const body = {
        scheduleType: form.scheduleType,
        timezone: form.timezone.trim() || 'Asia/Taipei',
      };
      if (form.scheduleType === 'cron') body.cronExpression = form.cronExpression.trim();
      if (form.scheduleType === 'interval') body.intervalMs = Number(form.intervalMs);
      if (form.scheduleType === 'once') body.runAt = localToIso(form.runAt);
      const res = await api.post('/api/schedules/preview', body);
      setPreview(res);
    } catch (err) {
      setPreview(null);
      setError(`${err.code ?? 'ERROR'} — ${err.message}`);
    } finally {
      setPreviewBusy(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = {
        name: form.name.trim(),
        taskDefinitionId: form.taskDefinitionId,
        scheduleType: form.scheduleType,
        timezone: form.timezone.trim() || 'Asia/Taipei',
        overlapPolicy: form.overlapPolicy,
      };
      if (form.scheduleType === 'cron') body.cronExpression = form.cronExpression.trim();
      if (form.scheduleType === 'interval') body.intervalMs = Number(form.intervalMs);
      if (form.scheduleType === 'once') body.runAt = localToIso(form.runAt);
      await onSubmit(body);
    } catch (err) {
      setError(`${err.code ?? 'ERROR'} — ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card confirm-card" onSubmit={submit} aria-label={editing ? 'Edit schedule' : 'Create schedule'}>
      <h2>{editing ? `Edit “${editing.name}”` : 'New schedule'}</h2>
      <div className="confirm-grid">
        <label>
          Name
          <input
            className="input"
            required
            maxLength={100}
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="e.g. Nightly fleet check"
          />
        </label>
        <label>
          Task definition
          <select
            className="input"
            required
            value={form.taskDefinitionId}
            onChange={(e) => set({ taskDefinitionId: e.target.value })}
          >
            <option value="" disabled>Select a task…</option>
            {defs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}{d.providerEnabled ? '' : ' (provider disabled)'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Type
          <select className="input" value={form.scheduleType} onChange={(e) => set({ scheduleType: e.target.value })}>
            {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>
        {form.scheduleType === 'cron' ? (
          <label>
            Cron (5 fields, in the schedule's timezone)
            <input
              className="input mono"
              required
              value={form.cronExpression}
              onChange={(e) => set({ cronExpression: e.target.value })}
              placeholder="0 9 * * *"
            />
          </label>
        ) : null}
        {form.scheduleType === 'interval' ? (
          <label>
            Interval (ms)
            <input
              className="input mono"
              type="number"
              min={1}
              step={1000}
              required
              value={form.intervalMs}
              onChange={(e) => set({ intervalMs: e.target.value })}
            />
          </label>
        ) : null}
        {form.scheduleType === 'once' ? (
          <label>
            Run at (local time)
            <input
              className="input"
              type="datetime-local"
              required
              value={form.runAt}
              onChange={(e) => set({ runAt: e.target.value })}
            />
          </label>
        ) : null}
        <label>
          Timezone (IANA)
          <input
            className="input mono"
            required
            maxLength={64}
            value={form.timezone}
            onChange={(e) => set({ timezone: e.target.value })}
            placeholder="Asia/Taipei"
          />
        </label>
        <label>
          Overlap policy
          <select className="input" value={form.overlapPolicy} onChange={(e) => set({ overlapPolicy: e.target.value })}>
            {POLICIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>
      </div>

      <div className="toolbar-group" style={{ marginTop: '8px' }}>
        <button className="btn btn-ghost" type="submit" onClick={doPreview} disabled={previewBusy || !form.taskDefinitionId}>
          {previewBusy ? 'Checking…' : 'Preview next run'}
        </button>
        {preview ? (
          <span className="muted">
            {preview.description ?? '—'}
            {preview.nextRunAt ? ` · ${new Date(preview.nextRunAt).toLocaleString()}` : ''}
          </span>
        ) : null}
      </div>

      {error ? <div className="error-box">{error}</div> : null}
      <div className="toolbar-group">
        <button className="btn" type="submit" disabled={busy || !form.name.trim() || !form.taskDefinitionId}>
          {busy ? 'Saving…' : submitLabel}
        </button>
        {onCancel ? (
          <button className="btn btn-ghost" type="button" onClick={onCancel}>Cancel</button>
        ) : null}
      </div>
    </form>
  );
}

export function Schedules() {
  const me = useApi(() => api.get('/api/auth/me'));
  const role = me.data?.user?.role ?? 'viewer';
  const canAct = role === 'admin' || role === 'operator';

  const [filters, setFilters] = useState({ enabled: '', page: 1 });
  const [editing, setEditing] = useState(null); // schedule row being edited
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [busy, setBusy] = useState({});
  const [errors, setErrors] = useState({});

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.enabled) p.set('enabled', filters.enabled);
    p.set('page', String(filters.page));
    p.set('pageSize', String(PAGE_SIZE));
    return `/api/schedules?${p.toString()}`;
  }, [filters]);

  const list = useApi(() => api.get(query), [query]);
  const defs = useApi(() => api.get('/api/tasks/definitions'), [list.data?.page]);
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const page = list.data?.page ?? 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const defList = defs.data?.items ?? [];
  const patch = (part) => setFilters((f) => ({ ...f, ...part, page: part.page ?? 1 }));

  async function withBusy(key, fn) {
    setErrors((m) => ({ ...m, [key]: null }));
    setBusy((m) => ({ ...m, [key]: true }));
    try {
      await fn();
    } catch (err) {
      setErrors((m) => ({ ...m, [key]: `${err.code ?? 'ERROR'} — ${err.message}` }));
      throw err;
    } finally {
      setBusy((m) => ({ ...m, [key]: false }));
    }
  }

  async function act(item, action) {
    const key = `${item.id}:${action}`;
    await withBusy(key, async () => {
      await api.post(`/api/schedules/${encodeURIComponent(item.id)}/${action}`);
      list.reload();
    });
  }

  async function doRunNow(item) {
    if (!window.confirm(`Fire “${item.name}” now? This creates a run immediately (independent of the next slot).`)) return;
    const key = `${item.id}:run_now`;
    await withBusy(key, async () => {
      const res = await api.post(`/api/schedules/${encodeURIComponent(item.id)}/run-now`, {});
      window.alert(
        res?.replay
          ? `Already queued for this action — run ${res.run?.id?.slice(0, 8)}… (no duplicate)`
          : `Queued run ${res.run?.id?.slice(0, 8)}… (status ${res.run?.status})`,
      );
      list.reload();
    });
  }

  async function doSync(item) {
    const key = `${item.id}:sync`;
    await withBusy(key, async () => {
      const res = await api.post(`/api/schedules/${encodeURIComponent(item.id)}/sync`);
      list.reload();
      if (res?.schedule?.syncStatus === 'synced') {
        window.alert(`“${item.name}” is now in sync with the queue.`);
      }
    });
  }

  async function doDelete(item) {
    const key = `${item.id}:delete`;
    await withBusy(key, async () => {
      await api.del(`/api/schedules/${encodeURIComponent(item.id)}`);
      setConfirmDelete(null);
      list.reload();
    });
  }

  async function createSchedule(body) {
    await api.post('/api/schedules', body);
    list.reload();
  }

  async function updateSchedule(body) {
    await api.patch(`/api/schedules/${encodeURIComponent(editing.id)}`, body);
    setEditing(null);
    list.reload();
  }

  return (
    <div className="stack">
      <h1>Schedules</h1>
      <p className="muted">
        Cron / interval / one-time schedules. PostgreSQL is the source of truth; each is synced
        idempotently to a BullMQ job scheduler under a stable key, so a worker restart never
        duplicates a fire.
      </p>

      {canAct && !editing ? (
        <ScheduleForm
          defaults={EMPTY_FORM}
          defs={defList}
          onSubmit={createSchedule}
          submitLabel="Create schedule"
        />
      ) : null}

      {canAct && editing ? (
        <ScheduleForm
          key={editing.id}
          initial={formFromSchedule(editing)}
          defaults={EMPTY_FORM}
          defs={defList}
          editing={editing}
          onSubmit={updateSchedule}
          onCancel={() => setEditing(null)}
          submitLabel="Save changes"
        />
      ) : null}

      <div className="toolbar">
        <form className="toolbar-group" onSubmit={(e) => { e.preventDefault(); patch({ page: 1 }); }}>
          <select className="input" value={filters.enabled} onChange={(e) => patch({ enabled: e.target.value })} aria-label="Filter by state">
            <option value="">All</option>
            <option value="true">Active</option>
            <option value="false">Paused</option>
          </select>
          <button className="btn" onClick={list.reload} title="Re-fetch from the API">↻</button>
        </form>
      </div>

      <StateFrame
        loading={list.loading}
        error={list.error}
        empty={!list.loading && !list.error && items.length === 0}
        emptyTitle="No schedules"
        emptyHint={canAct ? 'Create the first schedule above.' : 'Ask an operator to create a schedule.'}
      >
        <div className="table-wrap">
          <table className="list-table">
            <thead>
              <tr>
                <th>Schedule</th>
                <th>Cadence</th>
                <th>Next run</th>
                <th>Last run</th>
                <th>State</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => {
                const errKey = Object.keys(errors).find((k) => k.startsWith(`${s.id}:`));
                const syncErr = s.syncStatus === 'sync_error';
                return (
                  <tr key={s.id} className={errKey ? 'row-error' : null}>
                    <td>
                      <strong>{s.name}</strong>
                      <div className="muted">{s.taskDefinition?.title ?? '—'}</div>
                    </td>
                    <td>
                      <span className="pill">{s.scheduleType}</span>
                      <div className="muted mono" style={{ marginTop: '4px' }}>{typeLabel(s)}</div>
                      <div className="muted mono">{s.timezone}</div>
                    </td>
                    <td>
                      {s.isEnabled && s.nextRunAt ? (
                        <>
                          {new Date(s.nextRunAt).toLocaleString()}
                          {s.nextRunDescription ? <div className="muted">{s.nextRunDescription}</div> : null}
                        </>
                      ) : (
                        <span className="muted">{s.isEnabled ? '—' : 'paused'}</span>
                      )}
                    </td>
                    <td>
                      {s.lastRunAt ? (
                        <>
                          {timeAgo(s.lastRunAt)}
                          <div>
                            <span className={`pill state-badge ${taskBadgeClass(s.lastStatus ?? 'unknown')}`}>
                              {(s.lastStatus ?? '—').replace('_', ' ')}
                            </span>
                          </div>
                          {s.lastRun?.delayMs != null ? (
                            <div className="muted" title="actual start − scheduled slot">
                              delay {formatDuration(s.lastRun.delayMs)}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <span className="muted">never</span>
                      )}
                    </td>
                    <td>
                      <div className="toolbar-group">
                        <span className={`pill ${s.isEnabled ? 'pill-up' : 'pill-disabled'}`}>
                          {s.isEnabled ? 'active' : 'paused'}
                        </span>
                        <span className={`pill ${syncErr ? 'pill-down' : 'pill-up'}`}>
                          {syncErr ? 'sync error' : 'synced'}
                        </span>
                      </div>
                      {syncErr ? (
                        <div className="error-box small" style={{ marginTop: '6px' }}>
                          The queue side is out of date (BullMQ write failed). The DB row is
                          authoritative — retry the sync, or let the worker's reconcile pass
                          self-heal it.
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <div className="toolbar-group">
                        {canAct ? (
                          <>
                            <button
                              className="btn"
                              disabled={busy[`${s.id}:pause`] || busy[`${s.id}:resume`]}
                              onClick={() => act(s, s.isEnabled ? 'pause' : 'resume')}
                            >
                              {s.isEnabled ? 'Pause' : 'Resume'}
                            </button>
                            <button className="btn btn-ghost" disabled={busy[`${s.id}:run_now`]} onClick={() => doRunNow(s)}>
                              {busy[`${s.id}:run_now`] ? 'Firing…' : 'Run now'}
                            </button>
                            {syncErr ? (
                              <button className="btn" disabled={busy[`${s.id}:sync`]} onClick={() => doSync(s)}>
                                {busy[`${s.id}:sync`] ? 'Syncing…' : 'Retry sync'}
                              </button>
                            ) : null}
                            <button className="btn btn-ghost" onClick={() => setEditing(s)}>Edit</button>
                            <button
                              className="btn btn-ghost"
                              onClick={() => (confirmDelete ? doDelete(s) : setConfirmDelete(s))}
                            >
                              {confirmDelete?.id === s.id ? 'Confirm?' : 'Delete'}
                            </button>
                          </>
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
          <span className="muted">page {page} of {totalPages} · {total} schedules</span>
          <button className="btn" disabled={page >= totalPages} onClick={() => patch({ page: page + 1 })}>Next →</button>
        </div>
      </StateFrame>
    </div>
  );
}

export default Schedules;
