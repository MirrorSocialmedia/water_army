/**
 * Shared helpers for the AI task-run pages (P3 — MD §7/§8 tasks 段).
 * Pure functions only — no React, so they stay trivially testable.
 *
 * Status names mirror packages/shared/src/task-constants.js (TASK_RUN_STATUS)
 * — the API is the source of truth; these are presentation-only.
 */

/** Task run lifecycle states (mirror of shared TASK_RUN_STATUS). */
export const TASK_RUN_STATUS = [
  'queued',
  'running',
  'needs_approval',
  'succeeded',
  'failed',
  'cancel_requested',
  'cancelled',
  'timed_out',
  'skipped',
];

/** Terminal states (mirror of shared TASK_RUN_TERMINAL). */
export const TASK_TERMINAL = ['succeeded', 'failed', 'cancelled', 'timed_out', 'skipped'];

export function isTerminalStatus(status) {
  return TASK_TERMINAL.includes(status);
}

/** Reuse the container badge palette: active→green, waiting→amber, terminal-fail→red. */
const TASK_BADGE = {
  queued: 'state-created',
  running: 'state-running',
  needs_approval: 'state-paused',
  cancel_requested: 'state-paused',
  succeeded: 'state-running',
  failed: 'state-dead',
  cancelled: 'state-exited',
  timed_out: 'state-dead',
  skipped: 'state-exited',
};

export function taskStatusBadgeClass(status) {
  return TASK_BADGE[status] ?? 'state-unknown';
}

const TASK_STATUS_LABEL = {
  queued: 'queued',
  running: 'running',
  needs_approval: 'needs approval',
  cancel_requested: 'cancelling…',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  timed_out: 'timed out',
  skipped: 'skipped',
};

export function taskStatusLabel(status) {
  return TASK_STATUS_LABEL[status] ?? (status ?? '—');
}

const TERMINAL_LABEL = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  timed_out: 'Timed out',
  skipped: 'Skipped',
};

/**
 * Steps for the state-machine visualisation (MD §11.3).
 *
 * `needs_approval` and `cancel_requested` are branch states, not linear
 * steps — they render as a side badge (`branch`) instead. A cancel that
 * fires while still queued skips the Running step visually; the event
 * timeline always shows the true path.
 */
export function flowSteps(status) {
  const branch =
    status === 'needs_approval' ? 'needs_approval'
    : status === 'cancel_requested' ? 'cancel_requested'
    : null;
  const terminal = TASK_TERMINAL.includes(status);

  let queuedState = 'pending';
  let runningState = 'pending';
  let terminalState = 'pending';
  if (terminal) {
    queuedState = 'done';
    runningState = 'done';
    terminalState = 'current';
  } else if (status === 'queued') {
    queuedState = 'current';
  } else if (status === 'cancel_requested') {
    // Cancel while queued: show Queued as the active (cancelling) step.
    queuedState = 'current';
  } else {
    // running / needs_approval
    queuedState = 'done';
    runningState = 'current';
  }

  return {
    branch,
    steps: [
      { id: 'queued', label: 'Queued', state: queuedState },
      { id: 'running', label: 'Running', state: runningState },
      { id: 'terminal', label: terminal ? (TERMINAL_LABEL[status] ?? 'Finished') : 'Finished', state: terminalState },
    ],
  };
}

/** Human label for a tool safety class (MD §13). */
export function safetyClassLabel(safetyClass) {
  if (safetyClass === 'readonly') return 'readonly · auto';
  if (safetyClass === 'approval_required') return 'approval required';
  return `disabled (${safetyClass})`;
}

/** '1m 23s' style duration. */
export function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return '—';
  const n = Number(ms);
  if (n < 1000) return `${Math.round(n)} ms`;
  const secs = Math.floor(n / 1000);
  if (secs < 60) return `${(n / 1000).toFixed(1)} s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

/** HH:MM:SS local time for event timelines. */
export function formatClock(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString();
}

/** Truncate long text with an ellipsis marker (event payload previews). */
export function truncateText(text, max = 400) {
  if (typeof text !== 'string') return text;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
