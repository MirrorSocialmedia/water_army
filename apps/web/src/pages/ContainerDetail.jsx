import { useEffect, useState } from 'react';
import { Fragment } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import { StateFrame } from '../components/StateFrame';
import { ContainerActions } from '../components/ContainerActions';
import {
  formatBytes,
  formatDateTime,
  formatPct,
  stateBadgeClass,
} from '../components/container-utils';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'logs', label: 'Logs' },
  { id: 'stats', label: 'Stats' },
  { id: 'config', label: 'Configuration' },
];

function initialTab() {
  const hash = window.location.hash; // #/containers/<id>?tab=logs
  const qi = hash.indexOf('?');
  if (qi === -1) return 'overview';
  const t = new URLSearchParams(hash.slice(qi + 1)).get('tab');
  return TABS.some((x) => x.id === t) ? t : 'overview';
}

// ------------------------------------------------------------------ Logs tab

function LogsTab({ id, name }) {
  const [tail, setTail] = useState(500);
  const [search, setSearch] = useState('');
  const [live, setLive] = useState(true);
  const [liveState, setLiveState] = useState('connecting');
  const [lastEvent, setLastEvent] = useState(null);

  const logs = useApi(
    () => api.get(`/api/containers/${encodeURIComponent(id)}/logs?tail=${tail}`),
    [id, tail],
  );
  const reload = logs.reload;

  // SSE live tracking (MD §6.3): on a container event for THIS container,
  // refresh logs. The stream is closed on stop/unmount — never left open.
  useEffect(() => {
    if (!live) {
      setLiveState('off');
      return undefined;
    }
    const es = new EventSource('/api/containers/events');
    setLiveState('connecting');
    es.onopen = () => setLiveState('open');
    es.onerror = () => setLiveState('reconnecting'); // EventSource retries by itself
    const onEvent = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.id === id || (name && data.name === name)) {
          setLastEvent(data);
          reload();
        }
      } catch {
        /* non-JSON frame — ignore */
      }
    };
    es.addEventListener('container', onEvent);
    return () => {
      es.close(); // MD §6.3: 停止/斷線時正確關閉 stream
      setLiveState('off');
    };
  }, [live, id, name, reload]);

  const lines = logs.data?.lines ?? [];
  const needle = search.trim().toLowerCase();
  const shown = needle ? lines.filter((l) => l.toLowerCase().includes(needle)) : lines;

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="toolbar-group">
          <label className="muted">Tail</label>
          <select className="input" value={tail} onChange={(e) => setTail(Number(e.target.value))} aria-label="Log tail lines">
            {[100, 500, 2000, 5000].map((n) => (
              <option key={n} value={n}>{n} lines</option>
            ))}
          </select>
          <input
            className="input"
            type="search"
            placeholder="Search in loaded lines…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search logs"
          />
          <button className="btn" onClick={reload} title="Re-fetch logs from the API">↻ Reload</button>
        </div>
        <div className="toolbar-group">
          <label className="check">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            Live (SSE)
          </label>
          <span className={`pill ${liveState === 'open' ? 'pill-up' : liveState === 'off' ? '' : 'pill-disabled'}`}>
            {liveState === 'open' ? 'live' : liveState}
          </span>
          {lastEvent ? <span className="muted">last event: {lastEvent.action} @ {lastEvent.timestamp}</span> : null}
        </div>
      </div>

      <StateFrame
        loading={logs.loading}
        error={logs.error}
        empty={!logs.loading && !logs.error && lines.length === 0}
        emptyTitle="No log lines"
        emptyHint="The daemon returned an empty log for this tail."
      >
        {logs.data?.truncated ? <p className="muted">Truncated: showing the last {shown.length} of ≥{tail} lines ({logs.data.byteLength} bytes loaded).</p> : null}
        {needle ? <p className="muted">{shown.length} of {lines.length} lines match “{search.trim()}”.</p> : null}
        <pre className="log-view">{shown.length ? shown.join('\n') : '—'}</pre>
      </StateFrame>
    </div>
  );
}

// ----------------------------------------------------------------- Stats tab

function StatsTab({ id }) {
  const [auto, setAuto] = useState(true);
  const stats = useApi(() => api.get(`/api/containers/${encodeURIComponent(id)}/stats`), [id]);
  const reload = stats.reload;

  useEffect(() => {
    if (!auto) return undefined;
    const t = setInterval(() => reload(), 5000);
    return () => clearInterval(t);
  }, [auto, reload]);

  const s = stats.data?.stats;
  return (
    <div className="stack">
      <div className="toolbar toolbar-group">
        <label className="check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          Auto-refresh every 5 s
        </label>
        <button className="btn" onClick={reload}>↻ Refresh now</button>
        <span className="muted">point sample from the daemon (not a cumulative average)</span>
      </div>
      <StateFrame loading={stats.loading} error={stats.error} empty={!stats.loading && !stats.error && !s} emptyTitle="No stats" emptyHint="The daemon returned no stats for this container.">
        {s ? (
          <div className="cards">
            <div className="card">
              <div className="card-head"><h3>CPU</h3><span className="muted">{s.onlineCpus} online CPU</span></div>
              <div className="big-num">{formatPct(s.cpuPercent)}</div>
            </div>
            <div className="card">
              <div className="card-head"><h3>Memory</h3><span className="muted">of {formatBytes(s.memLimitBytes)} limit</span></div>
              <div className="big-num">{formatPct(s.memPercent)}</div>
              <p className="muted">{formatBytes(s.memUsageBytes)} in use</p>
            </div>
          </div>
        ) : null}
      </StateFrame>
    </div>
  );
}

// --------------------------------------------------------------- Overview tab

function OverviewTab({ info }) {
  const st = info.state ?? {};
  return (
    <div className="stack">
      <div className="cards">
        <div className="card">
          <div className="card-head"><h3>State</h3><span className={`pill state-badge ${stateBadgeClass(st.status)}`}>{st.status}</span></div>
          <dl className="kv">
            <dt>Started</dt><dd>{formatDateTime(st.startedAt)}</dd>
            <dt>Finished</dt><dd>{formatDateTime(st.finishedAt)}</dd>
            <dt>Exit code</dt><dd>{st.exitCode ?? '—'}</dd>
            <dt>Health</dt><dd>{st.health?.status ?? 'none'}</dd>
            <dt>Restart count</dt><dd>{info.restartCount ?? 0}</dd>
          </dl>
        </div>
        <div className="card">
          <div className="card-head"><h3>Network</h3></div>
          <dl className="kv">
            <dt>Mode</dt><dd>{info.networkMode || 'default'}</dd>
            <dt>Ports</dt><dd className="mono">{info.ports || '—'}</dd>
            <dt>Privileged</dt><dd>{info.privileged ? 'yes (see template reason)' : 'no'}</dd>
          </dl>
        </div>
      </div>

      <section className="card">
        <h3>Mounts</h3>
        {info.mounts?.length ? (
          <table className="list-table">
            <thead><tr><th>Type</th><th>Source</th><th>Destination</th><th>Read-only</th></tr></thead>
            <tbody>
              {info.mounts.map((m, i) => (
                <tr key={i}>
                  <td>{m.type}</td>
                  <td className="mono">{m.source ?? '(anonymous)'}</td>
                  <td className="mono">{m.destination}</td>
                  <td>{m.readOnly ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No mounts.</p>
        )}
      </section>

      <section className="card">
        <h3>App metadata</h3>
        <dl className="kv">
          <dt>Managed by app</dt>
          <dd>{info.managed ? `yes${info.managedByException ? ' (via admin exception)' : ''}` : 'no — unmanaged containers are read-only in this UI'}</dd>
          <dt>Template</dt><dd>{info.template ?? '—'}</dd>
          <dt>Created by</dt><dd>{info.createdBy ?? '—'}</dd>
          <dt>Created</dt><dd>{formatDateTime(info.created)}</dd>
          <dt>Image</dt><dd className="mono">{info.image}</dd>
        </dl>
        {Object.keys(info.labels ?? {}).length ? (
          <>
            <h3>Labels</h3>
            <dl className="kv">
              {Object.entries(info.labels).map(([k, v]) => (
                <Fragment key={k}><dt className="mono">{k}</dt><dd className="mono">{v}</dd></Fragment>
              ))}
            </dl>
          </>
        ) : null}
      </section>
    </div>
  );
}

// ------------------------------------------------------------ Configuration tab

function ConfigTab({ info }) {
  const env = info.env ?? [];
  return (
    <div className="stack">
      <section className="card">
        <h3>Environment</h3>
        <p className="muted">
          Sensitive values are masked <strong>server-side</strong> before leaving the API — the browser never
          sees plaintext secrets (MD §6.3 / §13).
        </p>
        {env.length ? (
          <table className="list-table">
            <thead><tr><th>Name</th><th>Value</th></tr></thead>
            <tbody>
              {env.map((e) => {
                const i = e.indexOf('=');
                return (
                  <tr key={e.slice(0, i === -1 ? undefined : i)}>
                    <td className="mono">{i === -1 ? e : e.slice(0, i)}</td>
                    <td className="mono">{i === -1 ? '(no value)' : e.slice(i + 1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="muted">No environment variables.</p>
        )}
      </section>

      <section className="card">
        <h3>Runtime configuration</h3>
        <dl className="kv">
          <dt>Image</dt><dd className="mono">{info.image}</dd>
          <dt>Command</dt><dd className="mono">{Array.isArray(info.command) ? info.command.join(' ') : '—'}</dd>
          <dt>Network mode</dt><dd>{info.networkMode || 'default'}</dd>
          <dt>Privileged</dt><dd>{info.privileged ? 'yes' : 'no'}</dd>
          <dt>Ports</dt><dd className="mono">{info.ports || '—'}</dd>
        </dl>
      </section>
    </div>
  );
}

// -------------------------------------------------------------------- page

export function ContainerDetail({ containerId }) {
  const me = useApi(() => api.get('/api/auth/me'));
  const info = useApi(() => api.get(`/api/containers/${encodeURIComponent(containerId)}`), [containerId]);
  const [tab, setTab] = useState(initialTab);
  const [busy, setBusy] = useState({});
  const [target, setTarget] = useState(null);
  const [form, setForm] = useState({ confirm: '', removeVolumes: false, force: false });
  const [deleteError, setDeleteError] = useState(null);

  const user = me.data?.user;
  const role = user?.role;
  const data = info.data;
  const [actionError, setActionError] = useState(null);

  async function runAction(item, action) {
    const key = `${item.id}:${action}`;
    setBusy((m) => ({ ...m, [key]: true }));
    setActionError(null);
    try {
      await api.post(`/api/containers/${encodeURIComponent(item.id)}/${action}`);
      info.reload();
    } catch (err) {
      setActionError(`${action}: ${err.code ?? 'ERROR'} — ${err.message}`);
    } finally {
      setBusy((m) => ({ ...m, [key]: false }));
    }
  }

  async function confirmDelete() {
    if (!data) return;
    setBusy((m) => ({ ...m, [`${data.id}:delete`]: true }));
    setDeleteError(null);
    try {
      await api.del(`/api/containers/${encodeURIComponent(data.id)}`, {
        confirm: form.confirm.trim(),
        removeVolumes: form.removeVolumes,
        force: form.force,
      });
      setTarget(null);
      window.location.hash = '/containers';
    } catch (err) {
      setDeleteError(`${err.code ?? 'ERROR'} — ${err.message}`);
    } finally {
      setBusy((m) => ({ ...m, [`${data.id}:delete`]: false }));
    }
  }

  return (
    <div className="stack">
      <div className="detail-head">
        <div>
          <h1>
            <a className="link back-link" href="#/containers">←</a>{' '}
            {data?.name ?? containerId}
          </h1>
          <div className="muted mono">{data?.shortId ?? containerId}</div>
        </div>
        {data ? (
          <div className="toolbar-group">
            <span className={`pill state-badge ${stateBadgeClass(data.state?.status)}`}>{data.state?.status}</span>
            {data.managed
              ? <span className="pill pill-up" title={data.managedByException ? 'via admin exception' : 'app-managed label'}>managed</span>
              : <span className="pill">unmanaged (read-only)</span>}
          </div>
        ) : null}
      </div>

      {actionError ? (
        <div className="error-box" role="alert">
          {actionError}{' '}
          <button className="btn btn-ghost btn-sm" onClick={() => setActionError(null)}>dismiss</button>
        </div>
      ) : null}

      <StateFrame
        loading={info.loading}
        error={info.error}
        empty={!info.loading && !info.error && !data}
        emptyTitle="Container not found"
        emptyHint="It may have been deleted."
      >
        {data ? (
          <>
            <div className="row-actions row-actions-compact">
              <ContainerActions
                item={{ id: data.id, name: data.name, state: data.state?.status }}
                role={role}
                busy={busy}
                errors={{}}
                onAction={runAction}
                onDelete={() => {
                  setTarget(data);
                  setForm({ confirm: '', removeVolumes: false, force: false });
                  setDeleteError(null);
                }}
                compact
              />
            </div>

            <div className="tabs" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  className={`tab${tab === t.id ? ' active' : ''}`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {tab === 'overview' ? <OverviewTab info={data} /> : null}
            {tab === 'logs' ? <LogsTab id={data.id} name={data.name} /> : null}
            {tab === 'stats' ? <StatsTab id={data.id} /> : null}
            {tab === 'config' ? <ConfigTab info={data} /> : null}
          </>
        ) : null}
      </StateFrame>

      {target ? (
        <div className="card confirm-card" role="alertdialog" aria-label="Confirm container deletion">
          <h2>Delete <code>{target.name || target.shortId}</code>?</h2>
          <p className="muted">
            Admin-only and fully audited. Bind mounts are preserved by default. A running container needs the force flag.
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
              Also remove volumes (removeVolumes)
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
                (target.state?.status === 'running' && !form.force) ||
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

export default ContainerDetail;
