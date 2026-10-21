/**
 * Batch cycle audit report (BR-B5, 施工 MD §11.4/§12).
 *
 * A cycle report is the FINAL, exportable summary of one batch cycle:
 * per-identity terminal state, success/failure/skip statistics, attempt
 * counts, failure reasons, resource peak (observed max concurrency from run
 * intervals) and the time range.
 *
 * ZERO-SECRETS is a hard contract (MD §11.4: 匯出資料不得包含秘密值):
 *  1. the builder only copies allowlisted, non-credential fields — identity
 *     `metadataJson` is NEVER copied wholesale (it is refused credential keys
 *     at the boundary, but the report adds defence in depth by taking only
 *     an explicit safe subset: none by default);
 *  2. the finished object passes `scrubObject` (shared secret scrubber);
 *  3. `assertNoSecrets` re-scans keys + obvious credential-shaped values and
 *     throws — the API route treats a trip as a 500 (a report that leaks is
 *     worse than one that fails).
 *
 * Pure module: rows are injected; no I/O, no npm dependencies.
 */
import { scrubObject } from './scrub.js';

export const REPORT_SCHEMA = 'water-army/batch-cycle-report/v1';

const FAILURE_SUMMARY_MAX = 200;
const REASON_MAX = 200;

/**
 * Build one cycle's report (MD §11.4).
 *
 * @param {object} input
 * @param {string} input.cycleId
 * @param {Array<object>} input.batches batch rows of this cycle (any order — sorted by batchNo)
 * @param {Array<object>} input.memberships batch_identity rows (all cycles or this cycle; filtered here)
 * @param {Array<object>} input.identities identity rows (id, externalRef, displayName, identityType, status, dataPath)
 * @param {Array<object>} input.runs task_run rows (all batch-linked; filtered to the cycle's batches here)
 * @param {Date|number} input.now
 * @returns {{schema:string, cycleId:string, generatedAt:string, ...}}
 */
export function buildCycleReport({ cycleId, batches = [], memberships = [], identities = [], runs = [], now }) {
  if (typeof cycleId !== 'string' || cycleId.length === 0) {
    throw new TypeError('buildCycleReport: cycleId is required');
  }
  const batchList = [...batches].sort((a, b) => a.batchNo - b.batchNo);
  if (batchList.length === 0) {
    throw new TypeError(`buildCycleReport: cycle ${cycleId} has no batches`);
  }
  const batchIds = new Set(batchList.map((b) => b.id));
  const members = memberships.filter((m) => batchIds.has(m.batchId));
  const memberIdentityIds = new Set(members.map((m) => m.identityId).filter(Boolean));
  const identityById = new Map(identities.filter((i) => memberIdentityIds.has(i.id)).map((i) => [i.id, i]));
  const cycleRuns = runs.filter((r) => r?.batchId && batchIds.has(r.batchId));

  const started = minDate(batchList.map((b) => b.startedAt).filter(Boolean));
  const finished = maxDate(batchList.map((b) => b.finishedAt).filter(Boolean));

  const batchesOut = batchList.map((b) => {
    const batchMembers = members.filter((m) => m.batchId === b.id).sort((x, y) => x.position - y.position);
    const batchRuns = cycleRuns.filter((r) => r.batchId === b.id);
    const byStatus = {};
    let retries = 0;
    for (const r of batchRuns) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      if (Number(r.attempt ?? 1) > 1) retries += 1;
    }
    const peak = maxConcurrentFromIntervalsSafe(batchRuns);

    const memberOut = batchMembers.map((m) => {
      const identity = identityById.get(m.identityId);
      const memberRuns = batchRuns.filter((r) => r.identityId === m.identityId);
      const failedRun = lastTerminalFailure(memberRuns);
      const latest = memberRuns.length
        ? memberRuns.reduce((a, r) => (new Date(r.finishedAt ?? r.createdAt ?? 0) > new Date(a.finishedAt ?? a.createdAt ?? 0) ? r : a))
        : null;
      const attempts = memberRuns.length ? Math.max(...memberRuns.map((r) => Number(r.attempt ?? 1))) : 0;
      // terminal state: the identity row is the source of truth (MD §3.3);
      // the membership status mirrors it but may lag between transitions.
      const finalStatus = identity?.status ?? m.status;
      return {
        position: m.position,
        identityId: m.identityId,
        externalRef: identity?.externalRef ?? null,
        displayName: identity?.displayName ?? null,
        finalStatus,
        attempts,
        durationMs: latest?.durationMs ?? null,
        failure: failedRun
          ? { code: failedRun.errorCode ?? null, summary: cap(failedRun.errorMessage), at: iso(failedRun.finishedAt ?? failedRun.updatedAt) }
          : null,
        skipReason: m.skipReason ? cap(m.skipReason, REASON_MAX) : null,
        containerId: shortContainerId(latest?.containerId ?? null),
        startedAt: iso(latest?.startedAt ?? null),
        finishedAt: iso(latest?.finishedAt ?? null),
      };
    });

    const completed = memberOut.filter((m) => m.finalStatus === 'COMPLETED').length;
    const failedFinal = memberOut.filter((m) => m.finalStatus === 'FAILED_FINAL').length;
    const skipped = memberOut.filter((m) => m.finalStatus === 'SKIPPED' || m.finalStatus === 'CANCELLED').length;
    const nonTerminal = memberOut.length - completed - failedFinal - skipped;

    return {
      id: b.id,
      batchNo: b.batchNo,
      name: b.name,
      status: b.status,
      batchSize: b.batchSize,
      maxActiveContainers: b.maxActiveContainers,
      failurePolicy: b.failurePolicy,
      startedAt: iso(b.startedAt),
      finishedAt: iso(b.finishedAt),
      stats: {
        members: memberOut.length,
        completed,
        failedFinal,
        skipped,
        nonTerminal,
        retries,
        peakActiveContainers: peak,
        byRunStatus: byStatus,
      },
      members: memberOut,
    };
  });

  const allMembers = batchesOut.flatMap((b) => b.members);
  const totals = {
    identities: allMembers.length,
    completed: allMembers.filter((m) => m.finalStatus === 'COMPLETED').length,
    failedFinal: allMembers.filter((m) => m.finalStatus === 'FAILED_FINAL').length,
    skipped: allMembers.filter((m) => m.finalStatus === 'SKIPPED' || m.finalStatus === 'CANCELLED').length,
    nonTerminal: allMembers.length -
      allMembers.filter((m) => m.finalStatus === 'COMPLETED' || m.finalStatus === 'FAILED_FINAL' || m.finalStatus === 'SKIPPED' || m.finalStatus === 'CANCELLED').length,
    successRate: allMembers.length ? round2(allMembers.filter((m) => m.finalStatus === 'COMPLETED').length / allMembers.length) : null,
    totalRunAttempts: cycleRuns.length,
    retries: cycleRuns.filter((r) => Number(r.attempt ?? 1) > 1).length,
    timeouts: cycleRuns.filter((r) => r.status === 'timed_out').length,
  };

  const resourcePeaks = {
    peakActiveContainers: maxConcurrentFromIntervalsSafe(cycleRuns),
    batchCaps: batchList.map((b) => ({ batchNo: b.batchNo, maxActiveContainers: b.maxActiveContainers })),
  };

  const report = {
    schema: REPORT_SCHEMA,
    cycleId,
    generatedAt: new Date(now).toISOString(),
    timeRange: { startedAt: iso(started), finishedAt: iso(finished) },
    batches: batchesOut,
    totals,
    resourcePeaks,
  };

  // Defence in depth: scrub, then hard-verify (MD §11.4 零秘密).
  const scrubbed = scrubObject(report, 4000);
  assertNoSecrets(scrubbed);
  return scrubbed;
}

/**
 * CSV rendering of a cycle report (MD §11.4 export). One row per identity
 * membership; header first. Standard RFC-4180 escaping (quote when the field
 * contains comma / quote / newline; quotes doubled).
 *
 * @param {object} report from buildCycleReport
 * @returns {string}
 */
export function renderCycleReportCsv(report) {
  const header = [
    'cycle_id', 'batch_no', 'batch_id', 'position', 'identity_id', 'external_ref',
    'display_name', 'final_status', 'attempts', 'failure_code', 'failure_summary',
    'skip_reason', 'container_id', 'started_at', 'finished_at', 'duration_ms',
  ];
  const lines = [csvRow(header)];
  for (const b of report.batches ?? []) {
    for (const m of b.members ?? []) {
      lines.push(
        csvRow([
          report.cycleId, b.batchNo, b.id, m.position, m.identityId, m.externalRef ?? '',
          m.displayName ?? '', m.finalStatus, m.attempts, m.failure?.code ?? '',
          m.failure?.summary ?? '', m.skipReason ?? '', m.containerId ?? '',
          m.startedAt ?? '', m.finishedAt ?? '', m.durationMs ?? '',
        ]),
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function csvRow(fields) {
  return fields.map((f) => {
    const s = f == null ? '' : String(f);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}

// ------------------------------------------------------------------ scanning
/**
 * Hard zero-secret gate. Scans:
 *  - every object key against the shared sensitive-key pattern (same
 *    over-approximating regex as scrub.js — parity, no drift);
 *  - every string value against a small set of credential-shaped value
 *    patterns (JWT, PEM, common "label: value" credential assignments).
 * Throws on the FIRST hit — the caller turns that into a 500.
 *
 * @param {unknown} value
 */
export function assertNoSecrets(value) {
  const SENSITIVE_KEY = /(^|[_\-.]|(?<=[a-z0-9])[A-Z])((authorization|auth|api[-_]?key|access[-_]?key|secret|token|password|passwd|credential|private[-_]?key|session[-_]?cookie|bearer|client[-_]?secret))(?:[_\-.]|(?=[A-Z])|$)/i;
  const VALUE_PATTERNS = [
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b(?:password|passwd|secret|token|api_?key|authorization|cookie)\s*[:=]\s*\S{6,}/i,
  ];
  const walk = (v, path) => {
    if (v == null) return;
    if (typeof v === 'string') {
      for (const re of VALUE_PATTERNS) {
        if (re.test(v)) throw new Error(`report contains credential-shaped value at ${path}`);
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (typeof v === 'object') {
      for (const [k, item] of Object.entries(v)) {
        if (SENSITIVE_KEY.test(k)) throw new Error(`report contains sensitive key '${k}' at ${path}`);
        walk(item, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(value, '$');
}

// ------------------------------------------------------------------ helpers
function lastTerminalFailure(runs) {
  const failed = runs.filter((r) => r.status === 'failed' || r.status === 'timed_out' || r.errorCode);
  if (failed.length === 0) return null;
  return failed.reduce((a, r) => (new Date(r.finishedAt ?? r.createdAt ?? 0) >= new Date(a.finishedAt ?? a.createdAt ?? 0) ? r : a));
}

function maxConcurrentFromIntervalsSafe(runs) {
  const pts = [];
  for (const r of runs) {
    const s = r?.startedAt ? new Date(r.startedAt).getTime() : null;
    const f = r?.finishedAt ? new Date(r.finishedAt).getTime() : null;
    if (s == null || f == null || f < s) continue;
    pts.push([s, 1], [f, -1]);
  }
  if (pts.length === 0) return null;
  pts.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  let cur = 0;
  let peak = 0;
  for (const [, d] of pts) {
    cur += d;
    if (cur > peak) peak = cur;
  }
  return peak;
}

function minDate(list) {
  if (!list.length) return null;
  return list.reduce((a, b) => (new Date(a) <= new Date(b) ? a : b));
}
function maxDate(list) {
  if (!list.length) return null;
  return list.reduce((a, b) => (new Date(a) >= new Date(b) ? a : b));
}
function iso(d) {
  if (d == null) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}
function cap(s, n = FAILURE_SUMMARY_MAX) {
  if (s == null) return null;
  const str = String(s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
}
function shortContainerId(id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  return id.slice(0, 12);
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
