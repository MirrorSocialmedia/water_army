import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import { StateFrame } from '../components/StateFrame';

/**
 * Settings — current identity from the real /api/auth/me endpoint.
 * Provider / system-settings APIs land in P3/P6; until then the request is
 * real and the 404 is shown honestly (no fake settings data).
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
          emptyHint="Provider configuration (base URL, model, masked API key) is delivered in P3. Endpoint /api/providers answers 404 until then."
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
