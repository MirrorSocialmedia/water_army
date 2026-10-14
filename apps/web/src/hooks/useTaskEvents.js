import { useEffect, useRef, useState } from 'react';

/**
 * Live task event stream (SSE) for one run — P3.
 *
 * Server contract (GET /api/tasks/runs/:id/events):
 *   - first message is a `run_snapshot` event (current run row)
 *   - then every stored event, replayed in order (id = event uuid)
 *   - heartbeats while quiet, and the stream closes with a `done` event
 *     once the run reaches a terminal state
 *   - ?after=<eventUuid> resumes from a cursor (no re-send of ≤ cursor)
 *
 * The browser EventSource auto-retries network drops but resends the
 * Last-Event-Id HEADER — our API cursor is a QUERY param, so when we hold a
 * cursor we close and reopen with ?after= to avoid re-delivery.
 *
 * @param {string} runId
 * @param {object} [opts]
 * @param {boolean} [opts.enabled] gate the connection (default true)
 */
export function useTaskEvents(runId, { enabled = true } = {}) {
  const [events, setEvents] = useState([]);
  const [snapshot, setSnapshot] = useState(null);
  const [linkState, setLinkState] = useState('connecting'); // connecting|live|closed
  const lastIdRef = useRef(null);

  useEffect(() => {
    if (!enabled || !runId) return undefined;
    let es = null;
    let disposed = false;

    function append(data) {
      if (!data || !data.id) return;
      setEvents((prev) => (prev.some((e) => e.id === data.id) ? prev : [...prev, data]));
    }

    function connect(after) {
      const url = `/api/tasks/runs/${runId}/events${after ? `?after=${encodeURIComponent(after)}` : ''}`;
      es = new EventSource(url);
      es.onopen = () => { if (!disposed) setLinkState('live'); };
      es.onerror = () => {
        if (disposed || !es) return;
        if (lastIdRef.current) {
          // Cursor held → reopen with ?after= (server resumes cleanly).
          es.close();
          es = null;
          if (!disposed) connect(lastIdRef.current);
        } else {
          // No cursor yet — let EventSource's native retry take over.
          setLinkState('reconnecting');
        }
      };
      es.addEventListener('run_snapshot', (e) => {
        try { setSnapshot(JSON.parse(e.data)); } catch { /* ignore */ }
      });
      es.addEventListener('done', () => {
        if (disposed) return;
        es.close();
        setLinkState('closed');
      });
      const onEvent = (e) => {
        let data = null;
        try { data = JSON.parse(e.data); } catch { return; }
        if (data?.id) lastIdRef.current = data.id;
        append(data);
      };
      for (const name of [
        'queued', 'attempt_started', 'provider_request', 'provider_response',
        'tool_call', 'tool_result', 'waiting_approval', 'approval_resolved',
        'status', 'retry_requested', 'succeeded', 'failed', 'cancelled',
        'timed_out', 'output', 'error',
      ]) {
        es.addEventListener(name, onEvent);
      }
    }

    connect(undefined);
    return () => {
      disposed = true;
      es?.close();
    };
  }, [runId, enabled]);

  return { events, snapshot, linkState };
}
