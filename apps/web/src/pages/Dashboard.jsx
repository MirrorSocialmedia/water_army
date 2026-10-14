import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import { StateFrame } from '../components/StateFrame';

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

/**
 * Dashboard — every number comes from the real /api/health/ready endpoint.
 * No hardcoded demo data (施工 MD §6.1).
 */
export function Dashboard() {
  const { data, error, loading, reload } = useApi(() => api.get('/api/health/ready'));
  return (
    <StateFrame loading={loading} error={error} empty={false} emptyTitle="No data" emptyHint="Health endpoint returned nothing.">
      <h1>Dashboard</h1>
      <p className="muted">
        System status: <strong className={data?.status === 'ok' ? 'status-ok' : 'status-degraded'}>{data?.status ?? '—'}</strong>
        {' '}· process uptime {data?.uptimeSeconds != null ? `${Math.round(data.uptimeSeconds)}s` : '—'}
      </p>
      <div className="cards">
        {DEPS.map(([key, label, purpose]) => (
          <DepCard key={key} label={label} purpose={purpose} dep={data?.dependencies?.[key]} />
        ))}
      </div>
      <p className="muted">
        Container / task / schedule counters arrive with P2–P4 (all from real APIs, never mocked).
      </p>
      <button type="button" className="btn" onClick={reload}>
        Refresh
      </button>
    </StateFrame>
  );
}

export default Dashboard;
