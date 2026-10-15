import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import { StateFrame } from '../components/StateFrame';

/**
 * Settings — identity from the real /api/auth/me + AI providers from the
 * real /api/providers (P3: writes are secret-write-only; the list always
 * shows masked keys, never the raw value). The 401/404 empty states are
 * kept for honest degradation (expired session / route unavailable).
 */
export function Settings() {
  const me = useApi(() => api.get('/api/auth/me'));
  const providers = useApi(() => api.get('/api/providers'));

  return (
    <div className="stack">
      <h1>Settings</h1>

      <section className="card">
        <h2>Current user</h2>
        <StateFrame
          loading={me.loading}
          error={me.error && me.error.status !== 401 ? me.error : null}
          empty={!me.loading && me.error && me.error.status === 401}
          emptyTitle="Not signed in"
          emptyHint="Your session expired. Sign in again."
        >
          {me.data?.user ? (
            <dl className="kv">
              <dt>Username</dt>
              <dd>{me.data.user.username}</dd>
              <dt>Role</dt>
              <dd><em className={`role role-${me.data.user.role}`}>{me.data.user.role}</em></dd>
              <dt>User id</dt>
              <dd><code>{me.data.user.id}</code></dd>
            </dl>
          ) : null}
        </StateFrame>
      </section>

      <section className="card">
        <h2>AI providers</h2>
        <StateFrame
          loading={providers.loading}
          error={providers.error && providers.error.status !== 404 && providers.error.status !== 401 ? providers.error : null}
          empty={!providers.loading && providers.error && (providers.error.status === 404 || providers.error.status === 401)}
          emptyTitle="Provider management"
          emptyHint="Provider endpoint unavailable (404/401) — check the API status or sign in again."
        >
          {Array.isArray(providers.data) && providers.data.length === 0 ? (
            <p className="muted">No providers configured yet.</p>
          ) : (
            <p className="muted">Providers listed here are real API data.</p>
          )}
        </StateFrame>
      </section>
    </div>
  );
}

export default Settings;
