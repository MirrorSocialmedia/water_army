import { Fragment, useEffect, useRef, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import { StateFrame } from '../components/StateFrame';
import {
  flowSteps,
  isTerminalStatus,
  taskStatusBadgeClass,
  taskStatusLabel,
  formatClock,
  formatDuration,
} from '../components/task-utils';
import { formatDateTime } from '../components/container-utils';

/**
 * Task run detail (P3 — MD §8 tasks 段):
 *  - state-machine visualisation (queued → running → terminal, branch badges)
 *  - live SSE event stream (snapshot + replay + live, deduped by event id)
 *  - output / result display, prompt echo
 *  - cancel / retry (operator+), approvals approve/reject (admin only)
 */

/** SSE event types the server may emit (mirrors shared TASK_EVENT + frame types). */
const SSE_EVENT_TYPES = [
  'queued', 'attempt_started', 'provider_request', 'provider_response', 'tool_call',
  'tool_result', 'waiting_approval', 'approval_resolved', 'retry', 'retry_requested',
  'status', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'timed_out', 'output',
];

const RETRYABLE_STATUSES = ['failed', 'cancelled', 'timed_out'];

function byTime(a, b) {
  if (a.createdAt === b.createdAt) return a.id < b.id ? -1 : 1;
  return a.createdAt < b.createdAt ? -1 : 1;
}

function approvalBadgeClass(status) {
  if (status === 'pending') return 'state-paused';
  if (status === 'approved') return 'state-running';
  if (status === 'rejected') return 'state-dead';
  return 'state-exited'; // expired
}

// ------------------------------------------------------------------ SSE stream

function useTaskEventStream(taskId) {
  const [streamState, setStreamState] = useState('connecting');
  const [events, setEvents] = useState([]);
  const [liveRun, setLiveRun] = useState(null);
  const seenIds = useRef(new Set());

  const addEvents = (rows) => {
    if (!Array.isArray(rows) || !rows.length) return;
    const fresh = rows.filter((e) => e && e.id && !seenIds.current.has(e.id));
    if (!fresh.length) return;
    fresh.forEach((e) => seenIds.current.add(e.id));
    setEvents((prev) => [...prev, ...fresh].sort(byTime));
  };

  useEffect(() => {
    const es = new EventSource(`/api/tasks/runs/${encodeURIComponent(taskId)}/events`);
    es.onopen = () => setStreamState('open');
    es.onerror = () => setStreamState((s) => (s === 'closed' ? 'closed' : 'reconnecting'));

    const onSnapshot = (e) => {
      try { setLiveRun(JSON.parse(e.data)); } catch { /* ignore */ }
    };
    const onEvent = (e) => {
      try { addEvents([JSON.parse(e.data)]); } catch { /* ignore */ }
    };
    const onDone = (e) => {
      let status = null;
      try { status = JSON.parse(e.data)?.status ?? null; } catch { /* ignore */ }
      setStreamState('closed');
      setLiveRun((r) => (r && status ? { ...r, status } : r));
      es.close(); // terminal — never leave the stream open (MD §9.4)
    };

    es.addEventListener('run_snapshot', onSnapshot);
    for (const t of SSE_EVENT_TYPES) es.addEventListener(t, onEvent);
    es.addEventListener('done', onDone);
    return () => {
      es.close();
      setStreamState('off');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  return { streamState, events, addEvents, liveRun, setLiveRun };
}

// ----------------------------------------------------------------- event list

function EventTimeline({ events }) {
  const listRef = useRef(null);
  const stickRef = useRef(true);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  if (!events.length) {
    return <p className="muted">No events yet.</p>;
  }
  return (
    <ul className="event-list" ref={listRef} onScroll={onScroll} aria-label="Task event timeline">
      {events.map((e) => (
        <li key={e.id} className="event-row">
          <span className="event-time">{formatClock(e.createdAt)}</span>
          <span className="event-type">{e.eventType}</span>
          <div className="event-body">
            {e.message ? <div className="event-msg">{e.message}</div> : null}
            {e.payload !== null && e.payload !== undefined ? (
              <details>
                <summary className="muted">payload</summary>
                <pre className="event-payload">{JSON.stringify(e.payload, null, 2)}</pre>
              </details>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------- page

export function TaskDetail({ taskId }) {
  const me = useApi(() => api.get('/api/auth/me'));
  const detail = useApi(() => api.get(`/api/tasks/runs/${encodeURIComponent(taskId)}`), [taskId]);
  const { streamState, events, addEvents, liveRun, setLiveRun } = useTaskEventStream(taskId);

  const [busy, setBusy] = useState({});
  const [actionError, setActionError] = useState(null);
  const [approvalNotes, setApprovalNotes] = useState({});

  const role = me.data?.user?.role;
  const canOperate = role === 'operator' || role === 'admin';
  const isAdmin = role === 'admin';

  const restRun = detail.data?.run ?? null;
  const run = liveRun ?? restRun;
  const status = run?.status ?? null;
  const terminal = isTerminalStatus(status);
  const flow = flowSteps(status);
  const approvals = detail.data?.approvals ?? [];
  const pendingApprovals = approvals.filter((a) => a.status === 'pending');

  // Seed the timeline from the REST fetch (SSE continues live on top).
  useEffect(() => {
    addEvents(detail.data?.events);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data]);

  async function doAction(action) {
    const key = `${taskId}:${action}`;
    if (busy[key]) return;
    setBusy((m) => ({ ...m, [key]: true }));
    setActionError(null);
    try {
      await api.post(`/api/tasks/runs/${encodeURIComponent(taskId)}/${action}`);
      setLiveRun(null); // REST becomes source of truth again
      detail.reload();
    } catch (err) {
      setActionError(`${action}: ${err.code ?? 'ERROR'} — ${err.message}`);
    } finally {
      setBusy((m) => ({ ...m, [key]: false }));
    }
  }

  async function reviewApproval(approval, decision) {
    const key = `${approval.id}:${decision}`;
    if (busy[key]) return;
    setBusy((m) => ({ ...m, [key]: true }));
    setActionError(null);
    try {
      const note = (approvalNotes[approval.id] ?? '').trim();
      await api.post(
        `/api/approvals/${encodeURIComponent(approval.id)}/${decision === 'approved' ? 'approve' : 'reject'}`,
        note ? { note } : {},
      );
      setLiveRun(null);
      detail.reload();
    } catch (err) {
      setActionError(`approval ${decision}: ${err.code ?? 'ERROR'} — ${err.message}`);
    } finally {
      setBusy((m) => ({ ...m, [key]: false }));
    }
  }

  return (
    <div className="stack">
      <div className="detail-head">
        <div>
          <h1>
            <a className="link back-link" href="#/tasks">←</a>{' '}
            {run?.title || (run?.promptPreview ? run.promptPreview.slice(0, 60) : 'Task run')}
          </h1>
          <div className="muted mono">{taskId}</div>
        </div>
        <div className="toolbar-group">
          {run ? (
            <span className={`pill state-badge ${taskStatusBadgeClass(status)}`}>{taskStatusLabel(status)}</span>
          ) : null}
          {run ? <span className="muted">attempt {run.attempt ?? 1}{run.maxAttempts ? ` / ${run.maxAttempts}` : ''}</span> : null}
        </div>
      </div>

      {actionError ? (
        <div className="error-box" role="alert">
          {actionError}{' '}
          <button className="btn btn-ghost btn-sm" onClick={() => setActionError(null)}>dismiss</button>
        </div>
      ) : null}

      <StateFrame
        loading={detail.loading}
        error={detail.error}
        empty={!detail.loading && !detail.error && !run}
        emptyTitle="Task run not found"
        emptyHint="It may not exist on this instance."
      >
        {run ? (
          <>
            {/* -------------------------------------------- state machine */}
            <section className="card">
              <div className="card-head">
                <h3>State machine</h3>
                <span className={`pill ${streamState === 'open' ? 'pill-up' : streamState === 'off' ? '' : 'pill-disabled'}`}>
                  stream: {streamState}
                </span>
              </div>
              <div className="flow" role="img" aria-label={`status: ${status}`}>
                {flow.steps.map((s, i) => (
                  <Fragment key={s.id}>
                    {i > 0 ? <span className="flow-arrow">→</span> : null}
                    <span className={`flow-step ${s.state}`}>{s.label}</span>
                  </Fragment>
                ))}
                {flow.branch === 'needs_approval' ? (
                  <span className="pill state-paused">⏸ awaiting approval</span>
                ) : null}
                {flow.branch === 'cancel_requested' ? (
                  <span className="pill state-paused">✕ cancelling…</span>
                ) : null}
              </div>
              {run.errorCode ? (
                <div className="error-box">
                  <strong>{run.errorCode}</strong> — {run.errorMessage || 'no message'}
                </div>
              ) : null}
            </section>

            {/* -------------------------------------------------- actions */}
            {canOperate ? (
              <div className="row-actions">
                <button
                  className="btn"
                  disabled={terminal || status === 'cancel_requested' || busy[`${taskId}:cancel`] === true}
                  title={
                    terminal
                      ? 'Run already finished — cancel is a no-op'
                      : status === 'cancel_requested'
                        ? 'Cancel already requested (idempotent)'
                        : 'Request cancellation (real stop: the worker stops emitting output)'
                  }
                  onClick={() => doAction('cancel')}
                >
                  {busy[`${taskId}:cancel`] ? 'Cancelling…' : 'Cancel'}
                </button>
                <button
                  className="btn"
                  disabled={!RETRYABLE_STATUSES.includes(status) || busy[`${taskId}:retry`] === true}
                  title={
                    RETRYABLE_STATUSES.includes(status)
                      ? 'Start a new attempt (previous output is preserved in the event stream)'
                      : `Retry is only available when failed / cancelled / timed out (now: ${status})`
                  }
                  onClick={() => doAction('retry')}
                >
                  {busy[`${taskId}:retry`] ? 'Retrying…' : 'Retry'}
                </button>
                <span className="muted">operator role required · actions are audited</span>
              </div>
            ) : null}

            {/* -------------------------------------------------- approvals */}
            <section className="card">
              <div className="card-head">
                <h3>Approvals</h3>
                {pendingApprovals.length ? <span className="pill state-paused">{pendingApprovals.length} pending</span> : null}
              </div>
              {approvals.length ? (
                approvals
                  .slice()
                  .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))
                  .map((a) => (
                    <div key={a.id} className="approval-item">
                      <div className="toolbar-group">
                        <code>{a.toolName}</code>
                        <span className={`pill state-badge ${approvalBadgeClass(a.status)}`}>{a.status}</span>
                        <span className="muted">{formatDateTime(a.requestedAt)}</span>
                      </div>
                      {a.arguments ? (
                        <pre className="event-payload">{JSON.stringify(a.arguments, null, 2)}</pre>
                      ) : null}
                      {a.reviewedBy ? (
                        <p className="muted">
                          {a.reviewedAt ? formatDateTime(a.reviewedAt) : ''} · by {a.reviewedBy}
                          {a.reviewNote ? ` · “${a.reviewNote}”` : ''}
                        </p>
                      ) : null}
                      {a.status === 'pending' && isAdmin ? (
                        <div className="toolbar-group">
                          <input
                            className="input"
                            placeholder="Review note (optional)"
                            value={approvalNotes[a.id] ?? ''}
                            onChange={(e) =>
                              setApprovalNotes((m) => ({ ...m, [a.id]: e.target.value }))
                            }
                            maxLength={500}
                          />
                          <button
                            className="btn btn-primary"
                            disabled={busy[`${a.id}:approved`] === true}
                            onClick={() => reviewApproval(a, 'approved')}
                          >
                            {busy[`${a.id}:approved`] ? '…' : 'Approve'}
                          </button>
                          <button
                            className="btn btn-danger"
                            disabled={busy[`${a.id}:rejected`] === true}
                            onClick={() => reviewApproval(a, 'rejected')}
                          >
                            {busy[`${a.id}:rejected`] ? '…' : 'Reject'}
                          </button>
                        </div>
                      ) : null}
                      {a.status === 'pending' && !isAdmin ? (
                        <p className="muted">Waiting for an admin to approve or reject.</p>
                      ) : null}
                    </div>
                  ))
              ) : (
                <p className="muted">No approval requests for this run.</p>
              )}
            </section>

            {/* ------------------------------------------------------ meta */}
            <section className="card">
              <h3>Run details</h3>
              <dl className="kv">
                <dt>Provider</dt><dd className="mono">{run.provider ?? '—'}</dd>
                <dt>Mode</dt><dd>{run.mode ?? '—'}</dd>
                <dt>Tools</dt><dd className="mono">{Array.isArray(run.tools) && run.tools.length ? run.tools.join(', ') : 'all enabled'}</dd>
                <dt>Timeout</dt><dd>{run.timeoutMs ? `${run.timeoutMs} ms` : 'server default'}</dd>
                <dt>Requested by</dt><dd className="mono">{run.requestedBy ?? '—'}</dd>
                <dt>Queued</dt><dd>{formatDateTime(run.queuedAt)}</dd>
                <dt>Started</dt><dd>{formatDateTime(run.startedAt)}</dd>
                <dt>Finished</dt><dd>{formatDateTime(run.finishedAt)}</dd>
                <dt>Duration</dt><dd>{formatDuration(run.durationMs)}</dd>
                {run.idempotencyKey ? (
                  <><dt>Idempotency key</dt><dd className="mono">{run.idempotencyKey}</dd></>
                ) : null}
              </dl>
              {run.prompt ? (
                <>
                  <h3>Prompt</h3>
                  <pre className="log-view">{run.prompt}</pre>
                </>
              ) : null}
            </section>

            {/* ---------------------------------------------------- output */}
            <section className="card">
              <h3>Output</h3>
              {run.resultText ? (
                <pre className="log-view">{run.resultText}</pre>
              ) : (
                !terminal ? <p className="muted">No output yet — the run is still in flight.</p> : <p className="muted">No output captured.</p>
              )}
              {run.resultJson !== null && run.resultJson !== undefined ? (
                <>
                  <h3>Result (structured)</h3>
                  <pre className="event-payload">{JSON.stringify(run.resultJson, null, 2)}</pre>
                </>
              ) : null}
            </section>

            {/* ---------------------------------------------------- events */}
            <section className="card">
              <div className="card-head">
                <h3>Event timeline</h3>
                <span className="muted">{events.length} events · live via SSE</span>
              </div>
              <EventTimeline events={events} />
            </section>
          </>
        ) : null}
      </StateFrame>
    </div>
  );
}

export default TaskDetail;
