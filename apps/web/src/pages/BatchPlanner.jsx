import { useMemo, useState } from 'react';
import { ListTree, PlayCircle } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { StateFrame } from '../components/StateFrame';
import { monitor, identities as identitySvc, control } from '../services/batches';
import { summarizePlan, can } from '../lib/batch-ui';

const DEFAULT_BATCH_SIZE = 50; // MD §3.1 default
const MAX_IDENTITIES_FETCH = 1000; // planner horizon (paged list)

/**
 * Batch Planner (MD §11.1).
 *
 * Preview is the DEFAULT action and is dry-run (zero side effects). While
 * POST /api/batches/preview (B2) is not on main, the preview is computed
 * client-side from REAL read data (GET /api/identities + the configured
 * capacity) with the same shared planner (planCycle) — the numbers match
 * B2's server-side preview. A real Start requires an explicit two-step
 * confirmation and shows how many containers will be created.
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

  const plan = useMemo(
    () => summarizePlan(filtered, { batchSize, maxActiveContainers: effectiveMaxActive }),
    [filtered, batchSize, effectiveMaxActive],
  );

  const isOp = can(user?.role, 'start');
  const canStart = isOp && plan.ok && plan.ready > 0 && !busy;

  async function handleStart() {
    setBusy(true);
    setActionError(null);
    try {
      const idem = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      // MD §10: create (idempotency key) → start; B2 owns both endpoints.
      await control.create({
        batchSize,
        maxActiveContainers: effectiveMaxActive ?? undefined,
        failurePolicy,
        identityFilter: identityQuery.trim() || undefined,
        idempotencyKey: idem,
      });
      setStarted({ ok: true, text: 'Batch created (B2) — start it from the monitor once B6 integration lands.' });
      setConfirming(false);
      setConfirmText('');
    } catch (err) {
      if (err.status === 404 || err.status === 501) {
        setStarted({
          ok: 'pending',
          text: `Preview computed locally from real data. ${err.code ?? 'Endpoint'} — POST /api/batches (B2) is not on main yet; this action goes live with B6 integration.`,
        });
      } else {
        setActionError(`${err.code ?? 'ERROR'}: ${err.message}`);
      }
    } finally {
      setBusy(false);
    }
  }

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

      <StateFrame loading={loading} error={error} empty={plan.ok && plan.total === 0} emptyTitle="No identities" emptyHint="Nothing to plan — add identities first.">
        {plan.ok ? (
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
                    placeholder={globalCap ? `default: ${globalCap}` : 'default: none configured'}
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
              </div>
            </div>

            {/* preview (MD §11.1 fields) */}
            <div className="cards">
              <div className="card">
                <div className="card-head"><strong>Total identities</strong></div>
                <div className="big-num">{plan.total}</div>
              </div>
              <div className="card">
                <div className="card-head"><strong>Batches</strong></div>
                <div className="big-num">{plan.batchCount}</div>
                <p className="muted">per batch: {plan.perBatch.join(' / ')}</p>
              </div>
              <div className="card">
                <div className="card-head"><strong>Available capacity</strong></div>
                <div className="big-num">{effectiveMaxActive ?? '—'}</div>
                <p className="muted">
                  {globalCap
                    ? `configured global cap (batch.global_max_active_containers)`
                    : 'no global cap configured — the preflight check will use per-batch defaults'}
                </p>
              </div>
              <div className="card">
                <div className="card-head"><strong>Estimated resources</strong></div>
                <div className="big-num">{plan.estimatedContainers}</div>
                <p className="muted">
                  containers across the cycle · peak {plan.peakConcurrent} concurrent
                </p>
              </div>
              <div className="card">
                <div className="card-head"><strong>Disabled / skipped</strong></div>
                <div className="big-num">{plan.skippedDisabled + plan.skippedOther}</div>
                <p className="muted">{plan.skippedDisabled} disabled · {plan.skippedOther} other non-ready</p>
              </div>
            </div>

            {/* validation errors (MD §11.1) */}
            {plan.skippedDisabled > 0 ? (
              <div className="state">
                <strong>{plan.skippedDisabled} disabled identities</strong>
                <p>will be SKIPPED in the plan (reported per-identity in the cycle export).</p>
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
                <button type="button" className="btn" disabled={!canStart || !plan.ok} onClick={() => { setConfirming(true); setActionError(null); }}>
                  <PlayCircle size={14} /> Preview → confirm start
                </button>
              ) : (
                <div className="confirm-grid">
                  <p>
                    This will create <strong>{plan.estimatedContainers}</strong> containers across <strong>{plan.batchCount}</strong> batch(es)
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
                      {busy ? 'Starting…' : `Start — creates ${plan.estimatedContainers} containers`}
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
              Preview math = shared planner (planCycle) over live <code>GET /api/identities</code> data —
              identical to the server-side <code>POST /api/batches/preview</code> once B2 lands (B6 integration).
            </p>
          </>
        ) : (
          <div className="state state-error" role="alert">
            <strong>Invalid plan</strong>
            <p>{plan.error}</p>
          </div>
        )}
      </StateFrame>
    </div>
  );
}

export default BatchPlanner;
