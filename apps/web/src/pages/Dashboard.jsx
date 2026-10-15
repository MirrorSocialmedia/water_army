import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import { StateFrame } from '../components/StateFrame';

const STATUS_PILL = {
  succeeded: 'pill-up',
  failed: 'pill-down',
  timed_out: 'pill-down',
  cancelled: 'pill-disabled',
  skipped: 'pill-disabled',
};

const DEPS = [
  ['postgres', 'PostgreSQL', 'Settings, tasks, runs, schedules, audit'],
  ['redis', 'Redis (BullMQ)', 'Job queue + scheduler index'],
  ['docker', 'Docker Engine', 'Container / device control (api only)'],
];

function DepCard({ label, purpose, dep }) {
  const up = dep?.status === 'up';
  const disabled = dep?.status === 'disabled';
  return (
    <div className={`card dep-card ${up ? 'dep-up' : disabled ? 'dep-disabled' : 'dep-down'}`}>
      <div className="card-head">
        <strong>{label}</strong>
        <span className={`pill ${up ? 'pill-up' : disabled ? 'pill-disabled' : 'pill-down'}`}>
          {dep ? dep.status : 'unknown'}
        </span>
      </div>
      <p className="muted">{purpose}</p>
      {dep?.error ? <code className="dep-error">{dep.error}</code> : null}
    </div>
  );
}

function Stat({ label, value, tone, hint }) {
  return (
    <div className="card stat-card">
      <div className="card-head">
        <strong>{label}</strong>
      </div>
      <div className={`stat-value ${tone ?? ''}`}>{value ?? '—'}</div>
      {hint ? <p className="muted stat-hint">{hint}</p> : null}
    </div>
  );
}

/**
 * Dashboard — every number comes from the real API (施工 MD §6.1, P6):
 *   GET /api/dashboard/summary  → fleet / task / schedule / notification counts
 *   GET /api/health/ready       → dependency detail (pg / redis / docker)
 * No hardcoded demo data anywhere.
 */
export function Dashboard() {
  const health = useApi(() => api.get('/api/health/ready'));
  const summary = useApi(() => api.get('/api/dashboard/summary'));
  const loading = health.loading || summary.loading;
  const error = summary.error ?? health.error;
  const reload = () => {
    health.reload();
    summary.reload();
  };

  const s = summary.data;
  const c = s?.containers;

  return (
    <StateFrame
      loading={loading}
      error={error}
      empty={!s && !error}
      emptyTitle="No data"
      emptyHint="The dashboard endpoint returned nothing — check the API logs."
    >
      <h1>Dashboard</h1>
      <p className="muted">
        System status:{' '}
        <strong className={health.data?.status === 'ok' ? 'status-ok' : health.data?.status ? 'status-degraded' : ''}>
          {health.data?.status ?? (health.error ? 'unreachable' : '—')}
        </strong>
        {health.data?.uptimeSeconds != null ? ` · API uptime ${Math.round(health.data.uptimeSeconds)}s` : ''}
        {' '}· 每 30 秒自動更新（右上角鈴聲為排程通知）
      </p>

      <h2 className="section-title">Managed fleet</h2>
      {c && !c.available ? (
        <div className="card warn-banner">
          <strong>Docker 連線不可用</strong> — 計數器暫緩（{c.reason ?? 'unknown'}）。容器頁 / 裝置頁會顯示同樣狀態；
          <a href="#containers">查看 Containers</a>。
        </div>
      ) : (
        <div className="cards">
          <Stat label="Managed containers" value={c?.total} hint="label 或 admin exception 納入（同一條規則）" />
          <Stat label="Running" value={c?.running} tone="stat-ok" />
          <Stat label="Stopped" value={c?.stopped} hint="exited / created / removing" />
          <Stat label="Needs attention" value={c?.attention} tone={c?.attention ? 'stat-err' : 'stat-ok'} hint="dead / restarting" />
        </div>
      )}

      <h2 className="section-title">Tasks（24 小時）</h2>
      <div className="cards">
        <Stat label="Active now" value={s?.taskRuns?.active} hint="queued / running / needs approval" />
        <Stat label="Succeeded" value={s?.taskRuns?.succeeded24h} tone="stat-ok" />
        <Stat label="Failed" value={s?.taskRuns?.failed24h} tone={s?.taskRuns?.failed24h ? 'stat-err' : 'stat-ok'} hint="failed + timed out" />
      </div>
      {s && s.taskRuns.recentFailed.length > 0 && (
        <div className="card">
          <div className="card-head">
            <strong>最近失敗</strong>
            <a className="muted" href="#tasks">全部 Tasks →</a>
          </div>
          <ul className="recent-failed">
            {s.taskRuns.recentFailed.map((r) => (
              <li key={r.id}>
                <a href={`#tasks/${encodeURIComponent(r.id)}`}>{r.id.slice(0, 8)}</a>
                <span className={`pill ${STATUS_PILL[r.status] ?? 'pill-disabled'}`}>{r.status}</span>
                {r.errorCode ? <code className="muted">{r.errorCode}</code> : null}
                <time className="muted">{r.finishedAt ? new Date(r.finishedAt).toLocaleString() : '—'}</time>
              </li>
            ))}
          </ul>
        </div>
      )}

      <h2 className="section-title">Schedules &amp; notifications</h2>
      <div className="cards">
        <Stat label="Schedules" value={s?.schedules?.total} hint={`${s?.schedules?.enabled ?? 0} enabled`} />
        <Stat
          label="Unread notifications"
          value={s?.notifications?.unread}
          tone={s?.notifications?.unread ? 'stat-warn' : 'stat-ok'}
          hint="排程完成/失敗通知（右上角鈴聲）"
        />
      </div>

      <h2 className="section-title">Dependencies</h2>
      <div className="cards">
        {DEPS.map(([key, label, purpose]) => (
          <DepCard key={key} label={label} purpose={purpose} dep={health.data?.dependencies?.[key]} />
        ))}
      </div>

      <button type="button" className="btn" onClick={reload} disabled={loading}>
        Refresh
      </button>
    </StateFrame>
  );
}

export default Dashboard;
