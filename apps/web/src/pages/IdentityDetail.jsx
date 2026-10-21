import { Fingerprint } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { StateFrame } from '../components/StateFrame';
import { identities } from '../services/batches';
import {
  IDENTITY_PILL,
  RUN_STATUS_PILL,
  BATCH_STATUS_PILL,
  pillClass,
  fmtTime,
  fmtDateTime,
  fmtDuration,
  fmtAge,
  shortId,
} from '../lib/batch-ui';

/**
 * Identity Detail (MD §11.3): stable ID, data dir status, recent tasks,
 * recent error, container ID, last health check.
 *
 * Zero-secret contract: the API returns allow-listed, scrubbed + value-
 * masked fields only (MD §12). This page renders exactly those fields and
 * nothing else — no cookie/token/password/network credentials can appear
 * here by construction.
 */
export function IdentityDetail({ identityId }) {
  const { data, loading, error, reload } = useApi(() => identities.detail(identityId), [identityId]);

  if (!loading && error?.status === 404) {
    return (
      <StateFrame
        loading={false}
        error={null}
        empty
        emptyTitle="Identity not found"
        emptyHint={`No identity with id ${shortId(identityId)} on this database.`}
      />
    );
  }

  return (
    <StateFrame loading={loading} error={error} empty={!data} emptyTitle="No data">
      {data ? (
        <div className="stack">
          <div className="detail-head">
            <div>
              <h2>
                <Fingerprint size={18} style={{ verticalAlign: '-3px' }} /> {data.identity.displayName ?? 'Identity'}
              </h2>
              <p className="muted mono">{data.identity.id}</p>
            </div>
            <div className="row-actions">
              <span className={`pill ${pillClass(IDENTITY_PILL, data.identity.status)}`}>{data.identity.status}</span>
              <button type="button" className="btn btn-ghost" onClick={reload}>
                Refresh
              </button>
            </div>
          </div>

          <div className="cards">
            <div className="card">
              <div className="card-head"><strong>Stable identity</strong></div>
              <dl className="kv">
                <dt>stable id</dt>
                <dd className="mono">{data.identity.id}</dd>
                <dt>external ref</dt>
                <dd className="mono">{data.identity.externalRef ?? '—'}</dd>
                <dt>type</dt>
                <dd>{data.identity.identityType ?? '—'}</dd>
                <dt>created</dt>
                <dd>{fmtDateTime(data.identity.createdAt)}</dd>
                <dt>updated</dt>
                <dd>{fmtDateTime(data.identity.updatedAt)}</dd>
              </dl>
            </div>
            <div className="card">
              <div className="card-head"><strong>Data directory</strong></div>
              <dl className="kv">
                <dt>path</dt>
                <dd className="mono" title={data.dataDir.path}>{data.dataDir.path ?? '—'}</dd>
                <dt>exists</dt>
                <dd className={data.dataDir.exists ? 'status-ok' : 'status-degraded'}>{data.dataDir.exists ? 'yes' : 'no'}</dd>
                <dt>last modified</dt>
                <dd>{data.dataDir.lastModifiedAt ? fmtDateTime(data.dataDir.lastModifiedAt) : '—'}</dd>
              </dl>
              <p className="muted">
                One identity = one persistent dir (MD §4.1). The UI never reads dir contents.
              </p>
            </div>
            <div className="card">
              <div className="card-head"><strong>Container</strong></div>
              {data.container ? (
                <dl className="kv">
                  <dt>container</dt>
                  <dd className="mono" title={data.container.id}>{data.container.shortId}</dd>
                  <dt>state</dt>
                  <dd>{data.container.state}</dd>
                </dl>
              ) : (
                <p className="muted">no live container (not started, already reclaimed, or Docker unavailable)</p>
              )}
            </div>
            <div className="card">
              <div className="card-head"><strong>Last health check</strong></div>
              <div className="big-num">{data.lastHealthCheckAt ? fmtAge(data.lastHealthCheckAt) : '—'}</div>
              <p className="muted">{data.lastHealthCheckAt ? fmtDateTime(data.lastHealthCheckAt) : 'no heartbeat recorded'}</p>
            </div>
          </div>

          {data.lastError ? (
            <div className="state state-error" role="alert">
              <strong>
                Last error{data.lastError.code ? ` — ${data.lastError.code}` : ''}
              </strong>
              <p>{data.lastError.message ?? '(no message)'}</p>
              <p className="muted">
                {data.lastError.at ? fmtDateTime(data.lastError.at) : ''} · run {data.lastError.runId ? shortId(data.lastError.runId) : ''}
              </p>
            </div>
          ) : null}

          <div className="card">
            <div className="card-head">
              <strong>Recent tasks</strong>
              <span className="muted">newest first (max 10)</span>
            </div>
            <div className="table-wrap">
              <table className="list-table">
                <thead>
                  <tr>
                    <th>run</th>
                    <th>status</th>
                    <th>attempt</th>
                    <th>queued</th>
                    <th>started</th>
                    <th>finished</th>
                    <th>duration</th>
                    <th>error</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentRuns.map((r) => (
                    <tr key={r.id} className={r.errorCode || r.errorMessage ? 'row-error' : ''}>
                      <td className="mono">{shortId(r.id)}</td>
                      <td>
                        <span className={`pill ${pillClass(RUN_STATUS_PILL, r.status)}`}>{r.status}</span>
                      </td>
                      <td>
                        {r.attempt}
                        {r.maxAttempts ? `/${r.maxAttempts}` : ''}
                      </td>
                      <td>{fmtTime(r.queuedAt)}</td>
                      <td>{fmtTime(r.startedAt)}</td>
                      <td>{fmtTime(r.finishedAt)}</td>
                      <td>{fmtDuration(r.durationMs)}</td>
                      <td className="cell-clip" title={r.errorMessage ?? ''}>
                        {r.errorMessage ? (
                          <>
                            <code>{r.errorCode ?? ''}</code> {r.errorMessage}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <strong>Batch memberships</strong>
              <span className="muted">cycle history</span>
            </div>
            {data.memberships.length ? (
              <table className="list-table">
                <thead>
                  <tr>
                    <th>batch</th>
                    <th>name</th>
                    <th>position</th>
                    <th>membership</th>
                    <th>batch status</th>
                    <th>skip reason</th>
                  </tr>
                </thead>
                <tbody>
                  {data.memberships.map((m, i) => (
                    <tr key={`${m.batchId}-${i}`}>
                      <td className="mono">
                        {m.batchNo != null ? `#${m.batchNo}` : shortId(m.batchId)}
                      </td>
                      <td className="cell-clip">{m.batchName ?? '—'}</td>
                      <td>{m.position ?? '—'}</td>
                      <td>
                        <span className={`pill ${pillClass(BATCH_STATUS_PILL, m.status)}`}>{m.status}</span>
                      </td>
                      <td>{m.batchStatus ?? '—'}</td>
                      <td className="cell-clip">{m.skipReason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">not yet part of any batch</p>
            )}
          </div>

          {data.identity.metadata && Object.keys(data.identity.metadata).length ? (
            <div className="card">
              <div className="card-head"><strong>Metadata</strong><span className="muted">scrubbed — sensitive keys redacted</span></div>
              <pre className="log-view" style={{ maxHeight: 240 }}>{JSON.stringify(data.identity.metadata, null, 2)}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </StateFrame>
  );
}

export default IdentityDetail;
