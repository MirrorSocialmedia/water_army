import { useState } from 'react';
import { FileDown, FileJson } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { StateFrame } from '../components/StateFrame';
import { reports } from '../services/batches';
import { CYCLE_STATUS_PILL, pillClass, fmtDateTime, can, shortId, cycleExportable, REPORT_FORMATS } from '../lib/batch-ui';

/**
 * Audit / Report (MD §11.4).
 *
 * Cycles list (viewer) + per-cycle export (operator+/admin): JSON or CSV.
 * The export body is zero-secret by construction on the API side (allow-
 * listed fields + scrub + credential-shape mask + a hard gate that 500s
 * rather than ship a partial report) and every export is audit-logged.
 */
export function BatchReports({ user }) {
  const { data, loading, error, reload } = useApi(() => reports.list());
  const [busy, setBusy] = useState(null); // cycleId+format being downloaded
  const [note, setNote] = useState(null);

  const canExport = can(user?.role, 'export');
  const cycles = data?.cycles ?? [];

  async function download(cycleId, format) {
    setBusy(`${cycleId}:${format}`);
    setNote(null);
    try {
      const res = await reports.download(cycleId, format);
      setNote(`Exported ${res.filename} (${res.size} bytes) — zero-secret guaranteed by the API gate.`);
    } catch (err) {
      setNote(`${err.code ?? 'EXPORT_FAILED'}: ${err.message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <div>
          <h2>Batch Reports</h2>
          <p className="muted">
            <FileDown size={14} style={{ verticalAlign: '-2px' }} /> cycle summaries — export contains no secrets (MD §11.4/§12)
          </p>
        </div>
        <button type="button" className="btn btn-ghost" onClick={reload}>
          Refresh
        </button>
      </div>

      <StateFrame loading={loading} error={error} empty={cycles.length === 0} emptyTitle="No cycles yet" emptyHint="Cycles appear here once batches have been planned (B2) — completed cycles become exportable.">
        <div className="table-wrap">
          <table className="list-table">
            <thead>
              <tr>
                <th>cycle</th>
                <th>status</th>
                <th>batches</th>
                <th>started</th>
                <th>finished</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {cycles.map((c) => {
                const done = cycleExportable(c);
                return (
                  <tr key={c.cycleId}>
                    <td className="mono">{shortId(c.cycleId, 13)}</td>
                    <td>
                      <span className={`pill ${pillClass(CYCLE_STATUS_PILL, c.status)}`}>{c.status}</span>
                    </td>
                    <td>{c.batchCount}</td>
                    <td>{fmtDateTime(c.startedAt)}</td>
                    <td>{fmtDateTime(c.finishedAt)}</td>
                    <td>
                      {canExport ? (
                        <div className="row-actions row-actions-compact">
                          {REPORT_FORMATS.map((f) => (
                            <button
                              key={f.id}
                              type="button"
                              className="btn btn-sm"
                              disabled={busy !== null || !done}
                              title={done ? `Download ${f.label}` : 'cycle not terminal yet'}
                              onClick={() => download(c.cycleId, f.id)}
                            >
                              {f.id === 'csv' ? <FileDown size={12} /> : <FileJson size={12} />} {busy === `${c.cycleId}:${f.id}` ? '…' : f.label}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span className="muted">operator+ only</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {note ? <div className="state"><strong>Export</strong><p>{note}</p></div> : null}
        <p className="muted">
          Export contents: per-identity final state, success/failed/skipped stats, attempts, failure reasons,
          resource peaks, time range (MD §11.4). Downloads are audit-logged with actor + request id.
        </p>
      </StateFrame>
    </div>
  );
}

export default BatchReports;
