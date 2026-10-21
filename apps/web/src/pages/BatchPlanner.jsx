import { useEffect, useMemo, useState } from 'react';
import { ListTree, PlayCircle } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { StateFrame } from '../components/StateFrame';
import { monitor, identities as identitySvc, control } from '../services/batches';
import { summarizePlan, can } from '../lib/batch-ui';

const DEFAULT_BATCH_SIZE = 50; // MD §3.1 default
const MAX_IDENTITIES_FETCH = 1000; // planner horizon (paged list)
const PREVIEW_DEBOUNCE_MS = 250;

/**
 * UI failurePolicy → server enum (MD §3.3: 'stop_batch' | 'continue_and_report').
 * The UI keeps the short labels; the mapping lives at this single boundary.
 */
const FAILURE_POLICY_TO_API = Object.freeze({
  continue: 'continue_and_report',
  stop: 'stop_batch',
});

/**
 * Batch Planner (MD §11.1) — B6 real-API integration.
 *
 * Preview sources (honest, in priority order):
 *   1. OPERATOR/ADMIN: `POST /api/batches/preview` (B2 server dry-run — the
 *      authoritative plan: same planner, plus capacity + unknown-id report +
 *      network-policy note, ZERO side effects).
 *   2. FALLBACK: the shared planner (planCycle) computed client-side over the
 *      same live `GET /api/identities` data. Used for viewers (the preview
 *      endpoint is operator-gated) and when the API is pre-B2 (404) or 5xx.
 *      The UI labels the source explicitly — never fake data, never an
 *      unlabelled fallback.
 *
 * Start = explicit two-step confirmation → `POST /api/batches` (idempotency
 * key) → `POST /api/batches/:first/start`. Batch 2..N auto-advance via the
 * scheduler's predecessor gate (B2); the UI never double-starts.
 */
export function BatchPlanner({ user }) {
  const [batchSize, setBatchSize] = useState(DEFAULT_BATCH_SIZE);
  const [maxActive, setMaxActive] = useState('');
  const [failurePolicy, setFailurePolicy] = useState('continue');
  const [identityQuery, setIdentityQuery] = useState('');
  const [previewTick, setPreviewTick] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [started, setStarted] = useState(null);

  const metrics = useApi(() => monitor.metrics());
  const identities = useApi(
    () =>
      identitySvc
        .list({ pageSize: Math.min(MAX_IDENTITIES_FETCH, 200) })
        .then((res) => res?.items ?? []),
    [],
  );
  const loading = metrics.loading || identities.loading;
  const error = identities.error ?? metrics.error;

  const globalCap = metrics.data?.detail?.globalMaxActiveContainers ?? null;
  const effectiveMaxActive =
    maxActive !== '' && Number.isInteger(Number(maxActive)) && Number(maxActive) >= 1 ? Number(maxActive) : globalCap;
  const capSource =
    maxActive !== '' && Number.isInteger(Number(maxActive)) && Number(maxActive) >= 1
      ? 'manual'
      : globalCap
        ? 'global cap'
        : null;

  const filtered = useMemo(() => {
    const list = Array.isArray(identities.data) ? identities.data : [];
    const q = identityQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (i) =>
        (i.displayName ?? '').toLowerCase().includes(q) ||
        (i.externalRef ?? '').toLowerCase().includes(q) ||
        (i.id ?? '').toLowerCase().includes(q),
    );
  }, [identities.data, identityQuery]);

  // ----------------------------------------------------------------- preview
  // Local plan (always computed — it is also the viewer/fallback source).
  const localPlan = useMemo(
    () => summarizePlan(filtered, { batchSize, maxActiveContainers: effectiveMaxActive }),
    [filtered, batchSize, effectiveMaxActive],
  );

  const isOp = can(user?.role, 'start');
  const [serverPreview, setServerPreview] = useState({ status: 'idle', data: null, reason: null });

  const idsKey = useMemo(() => filtered.map((i) => i.id).join(','), [filtered]);
  const debouncedIds = useDebounced(idsKey, PREVIEW_DEBOUNCE_MS);

  useEffect(() => {
    if (!isOp) {
      setServerPreview({ status: 'n/a', data: null, reason: 'viewer role — preview endpoint is operator-gated (MD §12)' });
      return undefined;
    }
    if (debouncedIds === null || debouncedIds === '') {
      setServerPreview({ status: 'idle', data: null, reason: null });
      return undefined;
    }
    if (effectiveMaxActive === null || effectiveMaxActive === undefined) {
      setServerPreview({ status: 'blocked', data: null, reason: 'max active containers unresolved — set it here or configure the global cap' });
      return undefined;
    }
    const idList = debouncedIds.split(',');
    let cancelled = false;
    setServerPreview((s) => ({ ...s, status: 'loading' }));
    control
      .preview({
        identities: idList,
        batchSize,
        maxActiveContainers: effectiveMaxActive,
        failurePolicy: FAILURE_POLICY_TO_API[failurePolicy],
      })
      .then((data) => {
        if (cancelled) return;
        setServerPreview({ status: 'ok', data, reason: null });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.status === 404) {
          setServerPreview({ status: 'fallback', data: null, reason: 'POST /api/batches/preview not available (pre-B2 API) — showing the local estimate' });
        } else if (err.status >= 500) {
          setServerPreview({ status: 'fallback', data: null, reason: `server preview failed (${err.code ?? err.status}) — showing the local estimate` });
        } else {
          setServerPreview({ status: 'error', data: null, reason: `${err.code ?? 'ERROR'}: ${err.message}` });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedIds, isOp, batchSize, effectiveMaxActive, failurePolicy, previewTick]);

  const serverData = serverPreview.data;
  const displayPlan = serverData?.plan ?? (localPlan.ok ? localPlan : null);
  const previewSource =
    serverPreview.status === 'ok' ? 'server' : serverPreview.status === 'n/a' ? 'local-viewer' : 'local-fallback';

  const canStart = isOp && displayPlan?.ok !== false && displayPlan?.total > 0 && effectiveMaxActive != null && !busy;

  // ------------------------------------------------------------------- start
  async function handleStart() {
    setBusy(true);
    setActionError(null);
    try {
      const idem = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      // MD §10: create (idempotency key, explicit identity list) → start the
      // first batch; the scheduler's predecessor gate advances the rest.
      const created = await control.create({
        name: `ui-cycle-${new Date().toISOString().replace(/[:.]/g, '-')}`,
        idempotencyKey: idem,
        identities: filtered.map((i) => i.id),
        batchSize,
        maxActiveContainers: effectiveMaxActive,
        failurePolicy: FAILURE_POLICY_TO_API[failurePolicy],
      });
      let firstStart = null;
      if (!created.replay) {
        const batches = Array.isArray(created.batches) ? [...created.batches].sort((a, b) => (a.batchNo ?? 0) - (b.batchNo ?? 0)) : [];
        const first = batches[0] ?? null;
        if (first) {
          firstStart = await control.start(first.id);
        }
      }
      setStarted({
        ok: true,
        text: created.replay
          ? `Idempotency key already used — replayed the original cycle ${created.cycleId} (nothing new created).`
          : `Cycle ${created.cycleId} created: ${created.batches?.length ?? 0} batch(es).` +
            (firstStart
              ? ` Batch 1 started (${firstStart.dispatch?.dispatched ?? 0} dispatched, ${firstStart.dispatch?.reused ?? 0} reused) — the scheduler auto-advances the remaining batches as each completes.`
              : ' Created but not started (no batch rows returned).'),
      });
      setConfirming(false);
      setConfirmText('');
    } catch (err) {
      if (err.status === 404 || err.status === 501) {
        setStarted({
          ok: 'pending',
          text: `${err.code ?? 'Endpoint'} — POST /api/batches (B2) is not available on this API; nothing was created.`,
        });
      } else {
        setActionError(`${err.code ?? 'ERROR'}: ${err.message}`);
      }
    } finally {
      setBusy(false);
    }
  }

  const estContainers = displayPlan ? (serverData ? serverData.estimate?.identitiesIncluded : displayPlan.ready) : 0;
  const estBatches = displayPlan ? (serverData ? serverData.estimate?.batchesPlanned : displayPlan.batchCount) : 0;
  const skippedDisabled = displayPlan
    ? serverData
      ? countSkipped(serverData.plan, 'identity disabled')
      : displayPlan.skippedDisabled
    : 0;
  const skippedOther = displayPlan
    ? serverData
      ? displayPlan.stats.skipped - skippedDisabled
      : displayPlan.skippedOther
    : 0;

  return (
    <div className="stack">
      <div className="toolbar">
        <div>
          <h2>Batch Planner</h2>
          <p className="muted">
            <ListTree size={14} style={{ verticalAlign: '-2px' }} /> Preview is the default action — dry-run, zero side effects.
          </p>
        </div>
      </div>

      <StateFrame loading={loading} error={error} empty={displayPlan?.ok !== false && displayPlan?.total === 0} emptyTitle="No identities" emptyHint="Nothing to plan — add identities first.">
        {displayPlan && displayPlan.ok !== false ? (
          <>
            {/* planning parameters */}
            <div className="card">
              <div className="card-head"><strong>Plan parameters</strong></div>
              <div className="confirm-grid" style={{ maxWidth: 'none' }}>
                <label className="check">
                  Identities to include:
                  <input
                    type="search"
                    className="input"
                    placeholder="filter by name / external ref / id (empty = all)"
                    value={identityQuery}
                    onChange={(e) => setIdentityQuery(e.target.value)}
                  />
                </label>
                <label className="check">
                  Batch size (identities per batch)
                  <input
                    type="number"
                    className="input"
                    min="1"
                    value={batchSize}
                    onChange={(e) => setBatchSize(Number(e.target.value))}
                  />
                </label>
                <label className="check">
                  Max active containers per batch
                  <input
                    type="number"
                    className="input"
                    min="1"
                    placeholder={globalCap ? `default: ${globalCap}` : 'required when no global cap is set'}
                    value={maxActive}
                    onChange={(e) => setMaxActive(e.target.value)}
                  />
                </label>
                <label className="check">
                  Failure policy
                  <select className="input" value={failurePolicy} onChange={(e) => setFailurePolicy(e.target.value)}>
                    <option value="continue">continue — keep the cycle going past failures</option>
                    <option value="stop">stop — pause the cycle on first failure</option>
                  </select>
                </label>
                <button type="button" className="btn btn-ghost" style={{ width: 'auto', alignSelf: 'end' }} onClick={() => setPreviewTick((t) => t + 1)}>
                  Refresh preview
                </button>
              </div>
              {capSource === null && displayPlan.total > 0 ? (
                <p className="muted">No global cap configured — set “Max active containers” to plan and start.</p>
              ) : null}
            </div>

            {/* preview source (honest label, MD §11.1) */}
            <div className={`state ${serverPreview.status === 'error' ? 'state-error' : ''}`}>
              {serverPreview.status === 'ok' ? (
                <>
                  <strong>Server preview (dry-run — POST /api/batches/preview)</strong>
                  <p>
                    Capacity: effective {serverData.capacity?.effectiveCap} concurrent ({serverData.capacity?.batchCap} batch cap
                    {serverData.capacity?.globalCap ? `, global cap ${serverData.capacity.globalCap}` : ', no global cap'}) ·
                    unknown ids: {serverData.unknown?.length ?? 0} · {serverData.networkPolicy?.note}
                  </p>
                </>
              ) : serverPreview.status === 'error' ? (
                <>
                  <strong>Server preview failed</strong>
                  <p>{serverPreview.reason}</p>
                </>
              ) : (
                <>
                  <strong>Local estimate (shared planner over live data)</strong>
                  <p>{serverPreview.reason ?? 'Computed client-side; identical math to the server preview (planCycle).'}</p>
                </>
              )}
            </div>

            {/* preview (MD §11.1 fields) */}
            <div className="cards">
              <div className="card">
                <div className="card-head"><strong>Total identities</strong></div>
                <div className="big-num">{displayPlan.stats ? displayPlan.stats.total : displayPlan.total}</div>
              </div>
              <div className="card">
                <div className="card-head"><strong>Batches</strong></div>
                <div className="big-num">{estBatches}</div>
                <p className="muted">per batch: {(displayPlan.perBatch ?? displayPlan.batches.map((b) => b.size)).join(' / ')}</p>
              </div>
              <div className="card">
                <div className="card-head"><strong>Available capacity</strong></div>
                <div className="big-num">{effectiveMaxActive ?? '—'}</div>
                <p className="muted">
                  {capSource === 'manual'
                    ? 'manually set for this plan'
                    : capSource === 'global cap'
                      ? `configured global cap (batch.global_max_active_containers)`
                      : 'unset — start is disabled until it is set'}
                </p>
              </div>
              <div className="card">
                <div className="card-head"><strong>Estimated resources</strong></div>
                <div className="big-num">{estContainers}</div>
                <p className="muted">
                  containers across the cycle · peak {serverData?.estimate?.peakConcurrentContainers ?? displayPlan.peakConcurrent} concurrent
                </p>
              </div>
              <div className="card">
                <div className="card-head"><strong>Disabled / skipped</strong></div>
                <div className="big-num">{skippedDisabled + skippedOther}</div>
                <p className="muted">{skippedDisabled} disabled · {skippedOther} other non-ready</p>
              </div>
            </div>

            {/* validation errors (MD §11.1) */}
            {skippedDisabled > 0 ? (
              <div className="state">
                <strong>{skippedDisabled} disabled identities</strong>
                <p>will be SKIPPED in the plan (reported per-identity in the cycle export).</p>
              </div>
            ) : null}
            {serverData && (serverData.unknown?.length ?? 0) > 0 ? (
              <div className="state state-error">
                <strong>{serverData.unknown.length} unknown identity ids</strong>
                <p>the server does not know these ids; they are reported, not silently dropped.</p>
              </div>
            ) : null}

            {/* start — explicit two-step confirmation (MD §11.1) */}
            <div className="card">
              <div className="card-head">
                <strong>Start cycle</strong>
                <span className="pill pill-disabled">{isOp ? 'operator / admin' : 'read-only (viewer)'}</span>
              </div>
              {!isOp ? (
                <p className="muted">Preview only — starting a cycle requires the operator or admin role (MD §12).</p>
              ) : !confirming ? (
                <button type="button" className="btn" disabled={!canStart} onClick={() => { setConfirming(true); setActionError(null); }}>
                  <PlayCircle size={14} /> Preview → confirm start
                </button>
              ) : (
                <div className="confirm-grid">
                  <p>
                    This will create <strong>{estContainers}</strong> containers across <strong>{estBatches}</strong> batch(es)
                    {effectiveMaxActive ? ` with at most ${effectiveMaxActive} active at once` : ''}.
                  </p>
                  <input
                    type="text"
                    placeholder={`type "start" to confirm`}
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                  />
                  <div className="row-actions">
                    <button type="button" className="btn btn-primary" style={{ width: 'auto' }} disabled={!canStart || confirmText.trim() !== 'start'} onClick={handleStart}>
                      {busy ? 'Starting…' : `Start — creates ${estContainers} containers`}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => { setConfirming(false); setConfirmText(''); }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {actionError ? <code className="dep-error">{actionError}</code> : null}
              {started ? (
                <div className="state">
                  <strong>{started.ok === true ? 'Started' : 'Preview (B2 pending)'}</strong>
                  <p>{started.text}</p>
                </div>
              ) : null}
            </div>

            <p className="muted">
              Preview math = shared planner (planCycle) — server-side via <code>POST /api/batches/preview</code> (operator),
              client-side fallback for viewers / pre-B2 APIs. Live data from <code>GET /api/identities</code>.
            </p>
          </>
        ) : (
          <div className="state state-error" role="alert">
            <strong>Invalid plan</strong>
            <p>{displayPlan?.error ?? 'Plan could not be computed.'}</p>
          </div>
        )}
      </StateFrame>
    </div>
  );
}

/** Count members skipped with the exact reason (server plan shape). */
function countSkipped(plan, reason) {
  if (!plan?.batches) return 0;
  return plan.batches.flatMap((b) => b.members ?? []).filter((m) => m.state === 'SKIPPED' && m.skipReason === reason).length;
}

/** Debounce a derived string key (null until the first value settles). */
function useDebounced(value, ms) {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

export default BatchPlanner;
