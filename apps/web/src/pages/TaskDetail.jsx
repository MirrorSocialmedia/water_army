import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import { StateFrame } from '../components/StateFrame';
import { formatDateTime } from '../components/container-utils';
import { useTaskEvents } from '../hooks/useTaskEvents';
import {
  canCancel,
  canRetry,
  flowSteps,
  formatDuration,
  isTerminalStatus,
  taskBadgeClass,
} from '../components/task-utils';

/**
 * P3 — task run detail: state-machine strip, live SSE event stream,
 * approvals review (admin), cancel / retry (operator+).
 */
export function TaskDetail({ runId }) {
  const me = useApi(() => api.get('/api/auth/me'));
  const role = me.data?.user?.role ?? 'viewer';
  const canAct = role === 'admin' || role === 'operator';
  const detail = useApi(() => api.get(`/api/tasks/runs/${encodeURIComponent(runId)}`), [runId]);
  const run = detail.data?.run ?? null;
  const terminal = run ? isTerminalStatus(run.status) : false;

  const { events, linkState } = useTaskEvents(runId, { enabled: true });
  const sawApproval = useMemo(
    () => events.some((e) => ['waiting_approval', 'approval_resolved'].includes(e.eventType)),
    [events],
  );
  // SSE is the live source of truth for run state. The detail fetch can lag
  // behind the DB (page opens mid-run, or a state change lands after the
  // initial fetch) — in which case the status badge / flow strip / approval
  // cards stay stale until something re-fetches. Every state-changing event
  // (approval gate entry/exit, status flips, terminal) therefore triggers one
  // detail refresh per event id; the refresh self-terminates because the
  // re-fetched row already reflects the new state.
  const reloadRef = useRef(detail.reload);
  reloadRef.current = detail.reload;
  const seenRefreshRef = useRef(null);
  useEffect(() => {
    const last = events[events.length - 1];
    if (!last || seenRefreshRef.current === last.id) return;
    const STATE_EVENTS = [
      'waiting_approval', 'approval_resolved', 'status', 'retry_requested',
      'succeeded', 'failed', 'cancelled', 'timed_out',
    ];
    if (STATE_EVENTS.includes(last.eventType) && run && !isTerminalStatus(run.status)) {
      seenRefreshRef.current = last.id;
      reloadRef.current();
    }
  }, [events, run]);
  // The SSE stream is the live source of truth; merge with the detail fetch
  // (deduped by event id) so the page shows history even before events land.
  const allEvents = useMemo(() => {
    const map = new Map();
    for (const e of detail.data?.events ?? []) if (e?.id) map.set(e.id, e);
    for (const e of events) if (e?.id) map.set(e.id, e);
    return [...map.values()].sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
    );
  }, [detail.data, events]);

  const [busy, setBusy] = useState({});
  const [errors, setErrors] = useState({});
  const [notes, setNotes] = useState({}); // approvalId -> note

  const listRef = useRef(null);
  const stickRef = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [allEvents.length]);

  async function runAction(action) {
    const key = `${action}`;
    setErrors((m) => ({ ...m, [key]: null }));
    setBusy((m) => ({ ...m, [key]: true }));
    try {
      await api.post(`/api/tasks/runs/${encodeURIComponent(runId)}/${action}`);
      detail.reload();
    } catch (err) {
      setErrors((m) => ({ ...m, [key]: `${err.code ?? 'ERROR'} — ${err.message}` }));
    } finally {
      setBusy((m) => ({ ...m, [key]: false }));
    }
  }

  async function review(approval, decision) {
    const key = `approve:${approval.id}`;
    setErrors((m) => ({ ...m, [key]: null }));
    setBusy((m) => ({ ...m, [key]: true }));
    try {
      await api.post(`/api/approvals/${encodeURIComponent(approval.id)}/${decision}`, {
        note: (notes[approval.id] ?? '').trim() || null,
      });
      detail.reload();
    } catch (err) {
      setErrors((m) => ({ ...m, [key]: `${err.code ?? 'ERROR'} — ${err.message}` }));
    } finally {
      setBusy((m) => ({ ...m, [key]: false }));
    }
  }

  if (detail.error?.status === 404) {
    return (
      <StateFrame
        error={{ code: 'NOT_FOUND', message: `Task run ${runId} not found.` }}
      />
    );
  }

  const pendingApprovals = (detail.data?.approvals ?? []).filter((a) => a.status === 'pending');

  return (
    <div className="stack">
      <div className="toolbar">
        <a className="btn btn-ghost" href="#/tasks">← All runs</a>
        <h1 style={{ margin: 0 }}>Task run</h1>
        {run ? <span className={`pill state-badge ${taskBadgeClass(run.status)}`}>{run.status.replace('_', ' ')}</span> : null}
        <span className="muted mono">{runId.slice(0, 8)}…</span>
        <span className={`muted mono`}>
          stream: {linkState === 'closed' ? (terminal ? 'closed (terminal)' : 'closed') : linkState}
        </span>
      </div>

      <StateFrame loading={detail.loading} error={detail.error}>
        {run ? (
          <>
            {/* state-machine visualisation */}
            <div className="card">
              <div className="flow">
                {flowSteps(run.status, sawApproval).map((s, i) => (
                  <span key={s.label} className="flow-group">
                    <span
                      className={`flow-step${s.state === 'done' ? ' done' : ''}${s.state === 'current' ? ` current${s.tone ? ` tone-${s.tone}` : ''}` : ''}`}
                    >
                      {s.label}
                    </span>
                    {i < flowSteps(run.status, sawApproval).length - 1 ? <span className="flow-arrow">→</span> : null}
                  </span>
                ))}
              </div>
              <div className="toolbar-group" style={{ marginTop: 10 }}>
                <span className="muted">provider <code>{run.provider ?? '—'}</code></span>
                <span className="muted">attempt {run.attempt}</span>
                <span className="muted">timeout {formatDuration(run.timeoutMs)}</span>
                <span className="muted">created {formatDateTime(run.createdAt)}</span>
                <span className="muted">duration {formatDuration(run.durationMs)}</span>
                {run.errorCode ? (
                  <span className="pill task-err" title={run.errorMessage}>{run.errorCode}</span>
                ) : null}
              </div>
              {canAct ? (
                <div className="toolbar-group" style={{ marginTop: 10 }}>
                  {canCancel(run.status) ? (
                    <button className="btn btn-danger" disabled={busy.cancel} onClick={() => runAction('cancel')}>
                      {busy.cancel ? 'Cancelling…' : 'Cancel run'}
                    </button>
                  ) : null}
                  {canRetry(run.status) ? (
                    <button className="btn" disabled={busy.retry} onClick={() => runAction('retry')}>
                      {busy.retry ? 'Retrying…' : 'Retry (new attempt)'}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {Object.entries(errors).filter(([k]) => k === 'cancel' || k === 'retry').map(([k, v]) => (
                <div className="error-box small" key={k}>{v}</div>
              ))}
            </div>

            {/* approvals */}
            {pendingApprovals.length > 0 ? (
              <div className="card approval-card">
                <h2>Pending approvals</h2>
                {pendingApprovals.map((a) => (
                  <div className="approval-item" key={a.id}>
                    <div className="toolbar-group">
                      <span className="pill task-approval">{a.toolName}</span>
                      <code>{JSON.stringify(a.arguments ?? {})}</code>
                      <span className="muted">requested {formatDateTime(a.requestedAt)}</span>
                    </div>
                    {role === 'admin' ? (
                      <div className="confirm-grid" style={{ marginTop: 8 }}>
                        <label>
                          Review note (optional)
                          <input
                            className="input"
                            value={notes[a.id] ?? ''}
                            onChange={(e) => setNotes((m) => ({ ...m, [a.id]: e.target.value }))}
                          />
                        </label>
                        <div className="toolbar-group">
                          <button
                            className="btn"
                            disabled={busy[`approve:${a.id}`]}
                            onClick={() => review(a, 'approve')}
                          >
                            Approve
                          </button>
                          <button
                            className="btn btn-danger"
                            disabled={busy[`approve:${a.id}`]}
                            onClick={() => review(a, 'reject')}
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="muted">Reviewing requires an admin session.</p>
                    )}
                    {errors[`approve:${a.id}`] ? <div className="error-box small">{errors[`approve:${a.id}`]}</div> : null}
                  </div>
                ))}
              </div>
            ) : null}

            {/* result / error */}
            {run.resultText || run.errorCode ? (
              <div className="card">
                <h2>{run.resultText ? 'Result' : 'Error'}</h2>
                {run.resultText ? <pre className="event-payload" style={{ whiteSpace: 'pre-wrap' }}>{run.resultText}</pre> : null}
                {run.errorCode ? (
                  <p className="error-box">{run.errorCode} — {run.errorMessage ?? ''}</p>
                ) : null}
              </div>
            ) : null}

            {/* live event stream */}
            <div className="card">
              <h2>Event stream {terminal ? '' : '(live)'}</h2>
              <ul
                className="event-list"
                ref={listRef}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                }}
              >
                {allEvents.length === 0 ? (
                  <li className="event-row"><span className="event-msg muted">no events yet</span></li>
                ) : (
                  allEvents.map((e) => (
                    <li className="event-row" key={e.id}>
                      <span className="event-time">{new Date(e.createdAt).toLocaleTimeString()}</span>
                      <span className="event-type">{e.eventType}</span>
                      <span className="event-body">
                        <div className="event-msg">{e.message}</div>
                        {e.payload && Object.keys(e.payload).length > 0 ? (
                          <pre className="event-payload">{JSON.stringify(e.payload, null, 1)}</pre>
                        ) : null}
                      </span>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </>
        ) : null}
      </StateFrame>
    </div>
  );
}

export default TaskDetail;
