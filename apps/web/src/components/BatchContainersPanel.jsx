import { useState } from 'react';
import { RefreshCw, ScanSearch, ShieldAlert, Square, Trash2 } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { batchContainers } from '../services/batches';
import { shortId } from '../lib/batch-ui';

/**
 * Batch container inventory (BR-B3 lifecycle surface, wired in B6).
 *
 * Data: GET /api/batch-containers (operator+ — one row per label-managed
 * container with run/identity lineage, docker state, host ports, lease).
 * Actions (MD Phase 3): reconcile classify (operator) / reconcile fix
 * (admin human) / per-run stop (reversible, volume stays) / per-run remove
 * (container goes, VOLUME + identity data stay — only purge wipes).
 *
 * Destructive ops are two-step confirmed (MD §11.2) and re-verified server-
 * side (ownership labels x DB; a disagreement refuses + audits).
 */
export function BatchContainersPanel({ isOp, isAdmin, busy, onNote, onErr }) {
  const { data, loading, reload } = useApi(() => batchContainers.list(), [], { intervalMs: 10_000 });
  const [reconcileOut, setReconcileOut] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind: 'reconcile-fix' | 'stop' | 'remove', runId?, label }
  const [acting, setActing] = useState(false);
  const [note, setNote] = useState(null);
  const [err, setErr] = useState(null);

  if (!isOp) return null; // the list endpoint is operator-gated — no 403 noise for viewers

  const rows = data?.containers ?? [];

  async function act(kind, target = null) {
    setActing(true);
    setErr(null);
    setNote(null);
    try {
      let out = null;
      if (kind === 'reconcile') out = await batchContainers.reconcile(false);
      else if (kind === 'reconcile-fix') out = await batchContainers.reconcile(true);
      else if (kind === 'stop') out = await batchContainers.stop(target.runId);
      else if (kind === 'remove') out = await batchContainers.remove(target.runId);
      if (kind === 'reconcile' || kind === 'reconcile-fix') {
        setReconcileOut(out);
        setNote(
          `Reconcile ${kind === 'reconcile-fix' ? 'fix' : '(classify)'}: scanned ${out.scanned} — ` +
            Object.entries(out.counts ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'scanned 0',
        );
      } else {
        setNote(`${kind} acknowledged for run ${shortId(target.runId)} — volume + identity data retained.`);
      }
      onNote?.(null); // no page-level note needed; panel note carries it
      reload();
    } catch (e) {
      setErr(`${e.code ?? 'ERROR'}: ${e.message}`);
      onErr?.(null);
    } finally {
      setActing(false);
      setConfirm(null);
    }
  }

  const fixableCount = (reconcileOut?.items ?? []).filter((i) => i.fixable).length;

  return (
    <div className="card">
      <div className="card-head">
        <strong>Batch containers (B3 lifecycle)</strong>
        <span className="row-actions row-actions-compact" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-sm btn-ghost" disabled={acting} onClick={() => act('reconcile')} title="Classify DB × docker state (read-only)">
            <ScanSearch size={13} /> Reconcile
          </button>
          {isAdmin ? (
            <button type="button" className="btn btn-sm" disabled={acting} onClick={() => setConfirm({ kind: 'reconcile-fix' })} title="Stop orphans / stale-running (admin, destructive)">
              <ShieldAlert size={13} /> Reconcile fix
            </button>
          ) : null}
          <button type="button" className="btn btn-sm btn-ghost" disabled={acting} onClick={reload}>
            <RefreshCw size={13} /> Refresh
          </button>
        </span>
      </div>
      {loading && !data ? (
        <p className="muted">loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No label-managed batch containers right now.</p>
      ) : (
        <div className="table-wrap">
          <table className="list-table">
            <thead>
              <tr>
                <th>container</th>
                <th>image</th>
                <th>docker state</th>
                <th>run</th>
                <th>identity</th>
                <th>batch</th>
                <th>host port</th>
                <th>lease</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.containerId}>
                  <td className="mono" title={r.containerId}>{shortId(r.containerId)}{r.name ? <span className="muted"> {r.name}</span> : null}</td>
                  <td className="cell-clip" title={r.image}>{r.image ?? '—'}</td>
                  <td><span className={`pill ${r.state === 'running' ? 'pill-up' : 'pill-disabled'}`}>{r.state}</span></td>
                  <td><span className="mono" title={r.runId}>{shortId(r.runId)}</span>{r.runStatus ? <span className="muted"> ({r.runStatus})</span> : null}</td>
                  <td className="mono" title={r.identityId}>{r.identityId ? shortId(r.identityId) : '—'}</td>
                  <td className="mono" title={r.batchId}>{r.batchId ? shortId(r.batchId) : '—'}</td>
                  <td>{Object.values(r.hostPorts ?? {}).filter(Boolean).join(', ') || '—'}</td>
                  <td>{r.leaseAlive == null ? '—' : r.leaseAlive ? <span className="status-ok">alive</span> : <span className="status-degraded">expired</span>}</td>
                  <td>
                    <div className="row-actions row-actions-compact">
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={acting}
                        title="Stop (reversible — volume + data stay)"
                        onClick={() => setConfirm({ kind: 'stop', runId: r.runId, label: shortId(r.containerId) })}
                      >
                        <Square size={13} /> Stop
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={acting}
                        title="Remove container (volume + identity data RETAIN — only purge wipes)"
                        onClick={() => setConfirm({ kind: 'remove', runId: r.runId, label: shortId(r.containerId) })}
                      >
                        <Trash2 size={13} /> Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {reconcileOut ? (
        <p className="muted">
          Last reconcile: scanned {reconcileOut.scanned} · {Object.entries(reconcileOut.counts ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')}
          {reconcileOut.items?.some((i) => i.state === 'mismatch') ? (
            <span className="status-degraded"> — mismatches were refused (ownership disagreement; human judgement required)</span>
          ) : null}
          {reconcileOut.items?.some((i) => i.fixed) ? <span className="status-ok"> — {reconcileOut.items.filter((i) => i.fixed).length} fixed</span> : null}
          {fixableCount > 0 && reconcileOut.counts ? null : null}
        </p>
      ) : null}
      {note ? <div className="state"><strong>Note</strong><p>{note}</p></div> : null}
      {err ? <code className="dep-error">{err}</code> : null}

      {confirm ? (
        <div className="modal-backdrop" role="presentation" onClick={() => !acting && setConfirm(null)}>
          <div className="card confirm-card" role="alertdialog" onClick={(e) => e.stopPropagation()}>
            <div className="card-head">
              <strong>
                {confirm.kind === 'reconcile-fix' && 'Reconcile fix — stop orphans / stale-running containers'}
                {confirm.kind === 'stop' && `Stop container ${confirm.label}`}
                {confirm.kind === 'remove' && `Remove container ${confirm.label}`}
              </strong>
            </div>
            <div className="confirm-grid">
              {confirm.kind === 'reconcile-fix' ? (
                <p>
                  Containers whose DB/label ownership disagrees are REFUSED (audited), never touched. Fixable items
                  (orphans, stale-running) are stopped; orphans are also removed. Nothing is ever STARTED. Recorded in the audit log.
                </p>
              ) : confirm.kind === 'stop' ? (
                <p>
                  The container exits and its port lease is released. The identity volume and data are KEPT — the run can be
                  re-dispatched and re-mounted on the same data.
                </p>
              ) : (
                <p>
                  The container is removed. The identity volume and data are KEPT — only <em>purge</em> (admin, from the identity
                  page) may wipe identity data.
                </p>
              )}
              <div className="row-actions">
                <button type="button" className="btn btn-primary" style={{ width: 'auto' }} disabled={acting || busy} onClick={() => act(confirm.kind, confirm)}>
                  {acting ? 'Working…' : confirm.kind === 'remove' ? 'Remove container' : confirm.kind === 'stop' ? 'Stop container' : 'Run reconcile fix'}
                </button>
                <button type="button" className="btn btn-ghost" disabled={acting} onClick={() => setConfirm(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default BatchContainersPanel;
