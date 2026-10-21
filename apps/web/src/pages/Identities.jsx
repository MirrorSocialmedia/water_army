import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { StateFrame } from '../components/StateFrame';
import { identities } from '../services/batches';
import { IDENTITY_STATUS } from '@water-army/shared/batch-constants';
import { IDENTITY_PILL, pillClass, fmtDateTime, shortId } from '../lib/batch-ui';

const PAGE_SIZES = [20, 50, 100];

/**
 * Identity list (MD §10 GET /api/identities — paginated + status filter).
 * Rows link to the Identity Detail page (MD §11.3).
 */
export function Identities() {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState('');

  // debounce the search box into the query
  useEffect(() => {
    const id = setTimeout(() => setSearch(q), 300);
    return () => clearTimeout(id);
  }, [q]);

  const { data, loading, error, reload } = useApi(
    () => identities.list({ status: status || undefined, q: search || undefined, page, pageSize }),
    [status, search, page, pageSize],
  );

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="stack">
      <div className="toolbar">
        <div>
          <h2>Identities</h2>
          <p className="muted">
            <Users size={14} style={{ verticalAlign: '-2px' }} /> stable IDs, one persistent data dir each (MD §4.1)
          </p>
        </div>
        <div className="toolbar-group">
          <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">all statuses</option>
            {IDENTITY_STATUS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input type="search" className="input" placeholder="search name / ref / id" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <select className="input" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-ghost" onClick={reload}>
            Refresh
          </button>
        </div>
      </div>

      <StateFrame loading={loading} error={error} empty={total === 0} emptyTitle="No identities" emptyHint="Identities are created by the batch planner (B2) — none on this database yet.">
        <div className="table-wrap">
          <table className="list-table">
            <thead>
              <tr>
                <th>id</th>
                <th>name</th>
                <th>external ref</th>
                <th>type</th>
                <th>status</th>
                <th>data dir</th>
                <th>updated</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <a className="link mono" href={`#/identities/${encodeURIComponent(i.id)}`}>
                      {shortId(i.id)}
                    </a>
                  </td>
                  <td className="cell-clip">{i.displayName ?? '—'}</td>
                  <td className="cell-clip">{i.externalRef ?? '—'}</td>
                  <td>{i.identityType ?? '—'}</td>
                  <td>
                    <span className={`pill ${pillClass(IDENTITY_PILL, i.status)}`}>
                      {i.status}
                    </span>
                  </td>
                  <td className="cell-clip mono" title={i.dataPath}>
                    {i.dataPath ?? '—'}
                  </td>
                  <td>{fmtDateTime(i.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pager">
          <span className="muted">
            {total} identities · page {page} / {pages}
          </span>
          <div className="row-actions">
            <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              Prev
            </button>
            <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>
              Next
            </button>
          </div>
        </div>
      </StateFrame>
    </div>
  );
}

export default Identities;
