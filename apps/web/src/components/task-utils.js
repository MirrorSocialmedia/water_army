/**
 * Shared helpers for the P3 task-run pages. Pure functions only — no React,
 * so they stay trivially testable (same convention as container-utils.js).
 */

/** Terminal run statuses (施工 MD §11.3 state machine). */
export const TASK_TERMINAL = Object.freeze(['succeeded', 'failed', 'cancelled', 'timed_out']);

/** All known run statuses (filter dropdown). */
export const TASK_STATUSES = Object.freeze([
  'queued', 'running', 'needs_approval', 'cancel_requested',
  'succeeded', 'failed', 'cancelled', 'timed_out',
]);

export function isTerminalStatus(status) {
  return TASK_TERMINAL.includes(status);
}

/**
 * Cancel is possible from any non-terminal state. From cancel_requested the
 * request is already in flight (the API is idempotent) so the button idles.
 */
export function canCancel(status) {
  return !isTerminalStatus(status) && status !== 'cancel_requested';
}

/** Manual retry is only legal from terminal failure states (MD §11.3). */
export function canRetry(status) {
  return ['failed', 'cancelled', 'timed_out'].includes(status);
}

/** Badge colour class per status (see app.css .task-* rules). */
export function taskBadgeClass(status) {
  switch (status) {
    case 'queued': return 'task-queued';
    case 'running': return 'task-running';
    case 'needs_approval': return 'task-approval';
    case 'cancel_requested': return 'task-cancelling';
    case 'succeeded': return 'task-ok';
    case 'failed': return 'task-err';
    case 'cancelled': return 'task-err';
    case 'timed_out': return 'task-warn';
    default: return 'task-unknown';
  }
}

/**
 * Lifecycle strip for the detail page (state-machine visualisation).
 *
 *   queued → running → (needs_approval) → <terminal>
 *
 * @param {string} status current run status
 * @param {boolean} sawApproval true when the run passed through the
 *   approval gate (a waiting_approval / approval event exists)
 * @returns {Array<{label:string, state:'done'|'current'|'todo', tone?:string}>}
 */
export function flowSteps(status, sawApproval = false) {
  const steps = [
    { label: 'queued', state: 'todo' },
    { label: 'running', state: 'todo' },
  ];
  if (sawApproval || status === 'needs_approval') {
    steps.push({ label: 'needs approval', state: 'todo' });
  }
  const mainIdx = { queued: 0, running: 1, needs_approval: 2, cancel_requested: 1 }[status] ?? -1;

  steps.forEach((s, i) => {
    if (isTerminalStatus(status)) {
      s.state = 'done';
    } else if (i < mainIdx) {
      s.state = 'done';
    } else if (i === mainIdx) {
      s.state = 'current';
    }
  });

  if (isTerminalStatus(status)) {
    const tone = status === 'succeeded' ? 'ok' : status === 'timed_out' ? 'warn' : 'err';
    steps.push({ label: status.replace('_', ' '), state: 'current', tone });
  }
  return steps;
}

/** Human duration from ms (null → '—'). */
export function formatDuration(ms) {
  if (ms == null || Number.isNaN(Number(ms))) return '—';
  const n = Number(ms);
  if (n < 1000) return `${n} ms`;
  const s = n / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} m ${Math.round(s % 60)} s`;
}
