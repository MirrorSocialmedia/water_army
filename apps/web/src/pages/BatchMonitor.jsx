import { useState } from 'react';
import { AlertTriangle, Pause, Play, RotateCcw, Square } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { StateFrame } from '../components/StateFrame';
import { monitor } from '../services/batches';
import { control } from '../services/batches';
import { DEFAULT_ALERT_LIMITS } from '@water-army/shared/batch-metrics';
import {
  BATCH_STATUS_PILL,
  RUN_STATUS_PILL,
  CYCLE_STATUS_PILL,
  pillClass,
  can,
  fmtTime,
  fmtAge,
  fmtBytes,
  hostHealth,
  alertClass,
  taskFlags,
  shortId,
} from '../lib/batch-ui';

const REFRESH_MS = 5000; // MD §11.2 — live monitor, silent background polling

function Pill({ map, status }) {
  return <span className={`pill ${pillClass(map, status)}`}>{status ?? 'unknown'}</span>;
}

function Stat({ label, value, tone, hint }) {
  return (
    <div className="card">
      <div className="card-head"><strong>{label}</strong></div>
      <div className={`big-num ${tone ?? ''}`}>{value ?? '—'}</div>
      {hint ? <p className="muted">{hint}</p> : null}
    </div>
  );
}

/**
 * Live Monitor (MD §11.2).
 *
 * Data: GET /api/batch-monitor/summary (B5, live) — current batch,
 * active/queued/completed/failed counts, active containers, host CPU/RAM/
 * disk, per-task state/attempt/start/heartbeat/last error, stuck/UNKNOWN
 * warnings, alerts (MD §13). Control actions (Pause/Resume/Stop/Retry) are
 * B2 endpoints — shown per RBAC (MD §12), two-step confirmed, and rendered
 * honestly as "B6 integration pending" until they are on main.
 */
export function BatchMonitor({ user }) {
  const { data: snap, loading, error, reload } = useApi(() => monitor.summary(), [], { intervalMs: REFRESH_MS });
  const [confirm, setConfirm] = useState(null); // { kind: 'pause'|'resume'|'cancel'|'retry', ... }
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [actionNote, setActionNote] = useState(null);

  const isOp = can(user?.role, 'pause');
  const now = Date.now();
  const counts = snap?.counts?.global;
  const cycle = snap?.cycle;
  const current = snap?.currentBatch;
  const cap = snap?.capacity;
  const host = snap?.host;
  const deps = snap?.deps;
  const containers = snap?.containers;
  const alerts = snap?.alerts ?? [];
  const tasks = snap?.tasks ?? [];
  const diskLow = DEFAULT_ALERT_LIMITS.diskAvailableBytesFloor; // same floor the server alerts on
  const hh = hostHealth(host, diskLow);

  const stuck = tasks.filter((t) => taskFlags(t).stuck);
  const unknowns = tasks.filter((t) => taskFlags(t).unknown);

  async function runControl(kind, target) {
    setBusy(true);
    setActionError(null);
    setActionNote(null);
    try {
      if (kind === 'pause') await control.pause(target.id);
      else if (kind === 'resume') await control.resume(target.id);
      else if (kind === 'cancel') await control.cancel(target.id, { reason: target.reason || 'requested from monitor UI' });
      else if (kind === 'retry') await control.retryRun(target.runId);
      setConfirm(null);
      setActionNote(`${kind} acknowledged — watching for the state change…`);
      reload();
    } catch (err) {
      if (err.status === 404 || err.status === 501) {
        setActionNote(`Control endpoint ${err.code ?? 'not found'} — ${kind} is delivered with B2 (B6 integration). The batch state above is live.`);
      } else {
        setActionError(`${err.code ?? 'ERROR'}: ${err.message}`);
      }
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }

  const batchActions = current
    ? [
        current.status === 'RUNNING' && isOp
          ? { kind: 'pause', label: 'Pause', icon: <Pause size={14} />, cls: 'btn' }
          : null,
        current.status === 'PAUSED' && isOp
          ? { kind: 'resume', label: 'Resume', icon: <Play size={14} />, cls: 'btn' }
          : null,
        isOp && !['CANCELLED', 'COMPLETED', 'COMPLETED_WITH_ERRORS'].includes(current.status)
          ? { kind: 'cancel', label: 'Stop', icon: <Square size={14} />, cls: 'btn btn-danger' }
          : null,
      ].filter(Boolean)
    : [];

  return (
    <div className="stack">
      <div className="toolbar">
        <div>
          <h2>Live Monitor</h2>
          <p className="muted">
            {snap ? `updated ${fmtAge(snap.generatedAt, now)} · ` : ''}auto-refresh {REFRESH_MS / 1000}s
          </p>
        </div>
        <div className="toolbar-group">
          {batchActions.map((a) => (
            <button
              key={a.kind}
              type="button"
              className={a.cls}
              disabled={busy}
              onClick={() => setConfirm({ kind: a.kind, id: current.id, status: current.status })}
            >
              {a.icon} {a.label}
            </button>
          ))}
          <button type="button" className="btn btn-ghost" onClick={reload}>
            <RotateCcw size={14} /> Refresh
          </button>
        </div>
      </div>

      {/* alerts (MD §13) — critical first */}
      {alerts.length > 0 ? (
        <div className="stack">
          {[...alerts].sort((a, b) => (a.severity === 'critical' ? -1 : 1) - (b.severity === 'critical' ? -1 : 1)).map((a) => (
            <div key={a.id} className={alertClass(a)} role="alert">
              <AlertTriangle size={16} />
              <div>
                <strong>
                  [{a.severity}] {a.message}
                </strong>
                <div className="muted">first seen {fmtAge(a.since, now)}</div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* stuck / unknown warnings (MD §11.2) */}
      {stuck.length > 0 || unknowns.length > 0 ? (
        <div className="state state-error" role="alert">
          <AlertTriangle size={20} />
          <div>
            <strong>{stuck.length} stuck / {unknowns.length} UNKNOWN task(s)</strong>
            <p>
              {stuck.length
                ? `heartbeat stale: ${stuck.slice(0, 5).map((t) => `${shortId(t.identityId ?? t.id)} (${t.status})`).join(', ')}${stuck.length > 5 ? ` +${stuck.length - 5} more` : ''}. `
                : ''}
              {unknowns.length ? 'A worker lost track of a run — it will be reconciled by lease expiry.' : ''}
            </p>
          </div>
        </div>
      ) : null}

      <StateFrame loading={loading} error={error} empty={!snap} emptyTitle="No batch activity" emptyHint="No batches on this database yet.">
        {snap ? (
          <>
            {/* current batch + cycle (MD §11.2) */}
            <div className="cards">
              <div className="card">
                <div className="card-head">
                  <strong>Current batch</strong>
                  <Pill map={BATCH_STATUS_PILL} status={current?.status} />
                </div>
                {current ? (
                  <>
                    <div className="big-num mono">{current.name ?? shortId(current.id)}</div>
                    <p className="muted">
                      batch #{current.batchNo} · cycle {shortId(current.cycleId, 12)} · started {fmtTime(current.startedAt)}
                    </p>
                  </>
                ) : (
                  <p className="muted">no active batch</p>
                )}
              </div>
              <div className="card">
                <div className="card-head">
                  <strong>Cycle</strong>
                  <Pill map={CYCLE_STATUS_PILL} status={cycle?.status} />
                </div>
                {cycle ? (
                  <>
                    <div className="big-num">
                      {snap.cycleBatches.filter((b) => ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED'].includes(b.status)).length} / {cycle.batchCount} batches
                    </div>
                    <p className="muted">
                      {snap.cycleBatches.map((b) => (
                        <span key={b.id} className={`flow-step ${b.status === 'RUNNING' ? 'current' : ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED'].includes(b.status) ? 'done' : ''}`} style={{ marginRight: 4 }}>
                          #{b.batchNo}
                        </span>
                      ))}
                    </p>
                  </>
                ) : (
                  <p className="muted">no cycle in progress</p>
                )}
              </div>
              <div className="card">
                <div className="card-head"><strong>Counts (global)</strong></div>
                <div className="kv">
                  <dt>active</dt>
                  <dd>{counts?.active ?? '—'}</dd>
                  <dt>queued</dt>
                  <dd>{counts?.queued ?? '—'}</dd>
                  <dt>completed</dt>
                  <dd className="status-ok">{counts?.completed ?? '—'}</dd>
                  <dt>failed</dt>
                  <dd className={counts?.failed ? 'status-degraded' : ''}>{counts?.failed ?? '—'}</dd>
                </div>
              </div>
              <div className="card">
                <div className="card-head"><strong>Containers</strong></div>
                <div className="kv">
                  <dt>active now</dt>
                  <dd>{containers?.available ? containers.running : '—'}</dd>
                  <dt>batch cap</dt>
                  <dd>{cap?.batchMaxActiveContainers ?? '—'}</dd>
                  <dt>global cap</dt>
                  <dd>{cap?.globalMaxActiveContainers ?? '—'}</dd>
                </div>
              </div>
              <div className="card">
                <div className="card-head"><strong>Host</strong></div>
                <div className="kv">
                  <dt>CPU load</dt>
                  <dd>{host ? `${host.cpuLoad1m ?? '—'} / ${host.cpuLoad5m ?? '—'}` : '—'}</dd>
                  <dt>RAM free</dt>
                  <dd className={hh.memory === 'low' ? 'status-degraded' : ''}>
                    {host ? `${fmtBytes(host.memoryAvailableBytes)} / ${fmtBytes(host.memoryTotalBytes)}` : '—'}
                  </dd>
                  <dt>disk free</dt>
                  <dd className={hh.disk === 'low' ? 'status-degraded' : ''}>
                    {host ? `${fmtBytes(host.diskAvailableBytes)} ${host.diskPath ? `@ ${host.diskPath}` : ''}` : '—'}
                  </dd>
                </div>
              </div>
              <div className="card">
                <div className="card-head"><strong>Dependencies</strong></div>
                <div className="kv">
                  <dt>postgres</dt>
                  <dd>{deps ? <Pill map={{ up: 'pill-up', down: 'pill-down', disabled: 'pill-disabled' }} status={deps.postgres} /> : '—'}</dd>
                  <dt>redis</dt>
                  <dd>{deps ? <Pill map={{ up: 'pill-up', down: 'pill-down', disabled: 'pill-disabled' }} status={deps.redis} /> : '—'}</dd>
                  <dt>docker</dt>
                  <dd>{deps ? <Pill map={{ up: 'pill-up', down: 'pill-down', disabled: 'pill-disabled' }} status={deps.docker} /> : '—'}</dd>
                </div>
              </div>
            </div>

            {containers?.orphans?.length ? (
              <div className="state" role="alert">
                <strong>{containers.orphans.length} orphan container(s)</strong>
                <p>
                  running + managed but no valid identity owner: {containers.orphans.map((o) => <code key={o}>{o}</code>).join(' ')}
                </p>
              </div>
            ) : null}

            {/* task table (MD §11.2: state / attempt / start / heartbeat / last error) */}
            <div className="card">
              <div className="card-head">
                <strong>Tasks</strong>
                <span className="muted">{tasks.length} shown (newest first)</span>
              </div>
              <div className="table-wrap">
                <table className="list-table">
                  <thead>
                    <tr>
                      <th>identity</th>
                      <th>batch</th>
                      <th>status</th>
                      <th>attempt</th>
                      <th>started</th>
                      <th>heartbeat</th>
                      <th>last error</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((t) => {
                      const f = taskFlags(t);
                      return (
                        <tr key={t.id} className={f.stuck || f.unknown ? 'row-error' : ''}>
                          <td className="cell-clip">
                            <a className="link" href={`#/identities/${encodeURIComponent(t.identityId ?? '')}`} onClick={(e) => !t.identityId && e.preventDefault()}>
                              {t.identityLabel ?? shortId(t.identityId ?? t.id)}
                            </a>
                            {f.stuck ? <span className="pill pill-down" style={{ marginLeft: 6 }}>stuck</span> : null}
                            {f.unknown ? <span className="pill pill-disabled" style={{ marginLeft: 6 }}>unknown</span> : null}
                          </td>
                          <td>{t.batchNo != null ? `#${t.batchNo}` : '—'}</td>
                          <td>
                            <Pill map={RUN_STATUS_PILL} status={t.status} />
                          </td>
                          <td>
                            {t.attempt}
                            {t.maxAttempts ? `/${t.maxAttempts}` : ''}
                          </td>
                          <td>{fmtTime(t.startedAt)}</td>
                          <td>{t.heartbeatAt ? fmtAge(t.heartbeatAt, now) : '—'}</td>
                          <td className="cell-clip" title={t.lastError?.message ?? ''}>
                            {t.lastError ? (
                              <>
                                <code>{t.lastError.code ?? ''}</code> {t.lastError.message}
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td>
                            <div className="row-actions row-actions-compact">
                              {isOp && (t.status === 'failed' || t.status === 'timed_out') ? (
                                <button type="button" className="btn btn-sm" disabled={busy} title={`Retry run ${t.id}`} onClick={() => setConfirm({ kind: 'retry', runId: t.id, status: t.status })}>
                                  Retry
                                </button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {actionError ? <code className="dep-error">{actionError}</code> : null}
            {actionNote ? <div className="state"><strong>Note</strong><p>{actionNote}</p></div> : null}
          </>
        ) : null}
      </StateFrame>

      {/* two-step confirmation (MD §12 destructive-action rule) */}
      {confirm ? (
        <div className="modal-backdrop" role="presentation" onClick={() => !busy && setConfirm(null)}>
          <div className="card confirm-card" role="alertdialog" onClick={(e) => e.stopPropagation()}>
            <div className="card-head">
              <strong>
                {confirm.kind === 'pause' && 'Pause the current batch'}
                {confirm.kind === 'resume' && 'Resume the paused batch'}
                {confirm.kind === 'cancel' && 'Stop the current batch'}
                {confirm.kind === 'retry' && `Retry run ${shortId(confirm.runId)}`}
              </strong>
            </div>
            <div className="confirm-grid">
              {confirm.kind === 'cancel' ? (
                <>
                  <p>All active containers will be stopped and remaining runs cancelled. This is recorded in the audit log.</p>
                  <input
                    type="text"
                    placeholder="reason (required, audited)"
                    value={confirm.reason ?? ''}
                    onChange={(e) => setConfirm((c) => ({ ...c, reason: e.target.value }))}
                  />
                </>
              ) : confirm.kind === 'retry' ? (
                <p>The failed run will be re-queued (next attempt, backoff per policy).</p>
              ) : (
                <p>{confirm.kind === 'pause' ? 'No new containers will be started until resumed.' : 'The scheduler will continue dispatching queued runs.'}</p>
              )}
              <div className="row-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ width: 'auto' }}
                  disabled={busy || (confirm.kind === 'cancel' && !(confirm.reason ?? '').trim())}
                  onClick={() => runControl(confirm.kind, confirm)}
                >
                  {busy ? 'Working…' : confirm.kind === 'cancel' ? 'Stop batch' : confirm.kind}
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirm(null)}>
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

export default BatchMonitor;
