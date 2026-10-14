import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import { StateFrame } from './StateFrame';

/**
 * Page shell for endpoints that land in a later phase (P2–P5).
 *
 * The request is REAL — it hits the actual API. Until the phase ships the
 * endpoint, the API answers 404 {code: NOT_FOUND} and this component renders
 * an honest "not yet available" empty state (never fake data). A 401 renders
 * a login prompt. From P2+ the same component renders live lists once the
 * endpoint exists (empty array → empty state, data → children).
 */
export function FutureApiPage({ endpoint, phase, title, description }) {
  const { data, error, loading, reload } = useApi(() => api.get(endpoint));

  const notYet = !loading && error && (error.status === 404 || error.status === 501);
  const authRequired = !loading && error && error.status === 401;
  const realEmpty = !loading && !error && Array.isArray(data) && data.length === 0;

  let emptyTitle = 'No data';
  let emptyHint = 'No records yet.';
  if (notYet) {
    emptyTitle = title;
    emptyHint = `${description} The endpoint ${endpoint} is delivered in ${phase}. This request was sent to the real API (404 until then).`;
  } else if (authRequired) {
    emptyTitle = 'Login required';
    emptyHint = 'Sign in, then reload this page.';
  }

  return (
    <StateFrame
      loading={loading}
      error={!loading && error && !notYet && !authRequired ? error : null}
      empty={!loading && (notYet || authRequired || realEmpty)}
      emptyTitle={emptyTitle}
      emptyHint={emptyHint}
    >
      {Array.isArray(data) ? (
        <table className="list-table">
          <thead>
            <tr>
              <th>id</th>
              <th>name</th>
            </tr>
          </thead>
          <tbody>
            {data.map((item) => (
              <tr key={item.id ?? JSON.stringify(item)}>
                <td><code>{item.id}</code></td>
                <td>{item.name ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p className="muted">
        Endpoint: <code>{endpoint}</code> · last response {data !== null || (error && !notYet) ? 'received' : 'pending'}
      </p>
      <button type="button" className="btn" onClick={reload}>
        Refresh
      </button>
    </StateFrame>
  );
}
