import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api, ApiError } from '../api/client';
import { StateFrame } from '../components/StateFrame';

/**
 * RAM Gate — the host-RAM admission gate's admin surface (RAM-G1).
 *
 * DISPLAY-ONLY principle (MD G1: "UI 只係顯示，後端為權威"): this page
 * renders exactly what the backend reports — current MemAvailable, the
 * 16 GiB hard floor, the 18 GiB post-boot target, running/in-progress
 * counts + reservations, whether the NEXT device would be admitted, and the
 * decision trail. The only writes are the operator's explicit actions:
 * editing the policy (PUT config) and forcing a reconcile.
 */

const REFRESH_MS = 10_000;

const fmtMiB = (v) =>
  v === null || v === undefined ? '—' : `${Math.round(Number(v)).toLocaleString('en-US')} MiB`;
const fmtMiBUnits = (mib) => {
  if (mib === null || mib === undefined) return '—';
  return `${fmtMiB(mib)} (${(Number(mib) / 1024).toFixed(2)} GiB)`;
};
const fmtTs = (ms) => {
  if (!Number.isFinite(ms)) return '—';
  return new Date(Number(ms)).toLocaleTimeString('en-GB', { hour12: false });
};
const fmtAge = (ms) => {
  if (ms === null || ms === undefined) return '—';
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`;
};

const REASON_HINTS = {
  ADMITTED: 'all checks passed',
  GATE_DISABLED: 'gate explicitly disabled (RAM_GATE_ENABLED=false) — bypass, labelled',
  MAX_PARALLEL: 'fleet cap reached (running + in-progress + this boot > MAX_PARALLEL)',
  BELOW_HARD_FLOOR: 'MemAvailable is already below the hard floor — booting would break the 16 GiB red line',
  PROJECTED_BELOW_TARGET: 'after charging this boot\u2019s budget, the remainder would fall below the post-boot target',
  METRICS_STALE: 'the /proc/meminfo sample is older than the max age — fail closed',
  METRICS_UNAVAILABLE: 'MemAvailable could not be read — fail closed',
  STORE_UNAVAILABLE: 'the reservation store (redis) is unavailable — fail closed',
  CONFIG_INVALID: 'the gate config failed validation — fail closed',
  INVALID_INPUT: 'malformed admission request',
};

export function RamGate({ user }) {
  const isAdmin = user?.role === 'admin';
  const status = useApi(() => api.get('/api/system/ram-gate'), [], { intervalMs: REFRESH_MS });
  const decisions = useApi(() => api.get('/api/system/ram-gate/decisions?limit=30'), [], { intervalMs: REFRESH_MS });

  const st = status.data ?? {};
  const m = st.metrics ?? {};
  const c = st.config ?? {};
  const counts = st.counts ?? {};
  const next = st.wouldAdmitNext ?? null;

  // ---- operator config form (admin only; the backend validates again) ----
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  useEffect(() => {
    if (st.stored ?? st.config) {
      const base = st.config ?? {};
      setForm({
        maxParallel: base.maxParallel ?? 10,
        hardFloorMiB: base.hardFloorMiB ?? 16384,
        postBootTargetMiB: base.postBootTargetMiB ?? 18432,
        perBootBudgetMiB: base.perBootBudgetMiB ?? 1200,
        metricsMaxAgeMs: base.metricsMaxAgeMs ?? 30000,
        leaseTtlMs: base.leaseTtlMs ?? 86400000,
        enabled: base.enabled ?? true,
      });
    }
  }, [st]);

  const setField = (k) => (e) =>
    setForm((f) => ({ ...f, [k]: k === 'enabled' ? e.target.checked : Number(e.target.value) }));

  const saveConfig = async () => {
    if (!form) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await api.put('/api/system/ram-gate/config', {
        maxParallel: form.maxParallel,
        hardFloorMiB: form.hardFloorMiB,
        postBootTargetMiB: form.postBootTargetMiB,
        perBootBudgetMiB: form.perBootBudgetMiB,
        metricsMaxAgeMs: form.metricsMaxAgeMs,
        leaseTtlMs: form.leaseTtlMs,
        enabled: form.enabled,
      });
      setSaveMsg(`saved — effective config updated (${res?.note ?? 'live'})`);
    } catch (err) {
      setSaveMsg(err instanceof ApiError ? `${err.code}: ${err.message}` : `save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const runReconcile = async () => {
    setSaving(true);
    setSaveMsg('reconcile running…');
    try {
      const r = await api.post('/api/system/ram-gate/reconcile', {});
      setSaveMsg(
        `reconcile done — released ${r.released?.length ?? 0}, renewed ${r.renewed ?? 0}, recovered ${r.recovered ?? 0}` +
          (r.errors?.length ? ` (errors: ${r.errors.join('; ')})` : ''),
      );
      status.reload();
    } catch (err) {
      setSaveMsg(err instanceof ApiError ? `${err.code}: ${err.message}` : `reconcile failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const gateUnavailable =
    !status.loading && status.error && (status.error.status === 503 || status.error.code === 'RAM_GATE_UNAVAILABLE');
  const forbidden = !status.loading && status.error && status.error.status === 403;

  return (
    <div className="stack">
      <h1>RAM Gate</h1>
      <p className="muted">
        Host-RAM admission for redroid boots. The backend is authoritative — this page displays its live verdict
        (auto-refresh {REFRESH_MS / 1000}s). Fail-closed: any missing/stale metrics or store problem DENIES new
        boots; pending work stays queued; nothing is ever deleted.
      </p>

      <section className="card">
        <h2>
          Admission state{' '}
          <em className={`role role-${st.enabled ? 'admin' : 'viewer'}`}>{st.enabled ? 'ENABLED' : 'DISABLED'}</em>
        </h2>
        <StateFrame
          loading={status.loading}
          error={!gateUnavailable && !forbidden ? status.error : null}
          empty={forbidden}
          emptyTitle="Admin access required"
          emptyHint="Sign in as an admin to see the RAM gate."
        >
          {gateUnavailable ? (
            <p className="muted">
              The gate is not constructible in this environment (no redis eval surface) — boot paths run pre-G1.
              In production the gate is always on.
            </p>
          ) : (
            !forbidden &&
            st.enabled !== undefined && (
              <dl className="kv">
                <dt>MemAvailable (now)</dt>
                <dd>
                  <strong>{fmtMiBUnits(m.memAvailableMiB)}</strong>{' '}
                  <span className="muted">
                    (sample age {fmtAge(m.ageMs)}
                    {m.stale ? ' — STALE' : ''}) · load {m.loadAvg?.join(' / ') ?? '—'}
                  </span>
                </dd>
                <dt>Hard floor</dt>
                <dd>{fmtMiBUnits(c.hardFloorMiB)} (MemAvailable must never go below)</dd>
                <dt>Post-boot target</dt>
                <dd>{fmtMiBUnits(c.postBootTargetMiB)} (initial conservative — tune from measurements)</dd>
                <dt>Per-boot budget</dt>
                <dd>{fmtMiB(c.perBootBudgetMiB)} (A10 real device: settled ≈934 / incremental ≈1093 MiB)</dd>
                <dt>Max parallel</dt>
                <dd>{c.maxParallel ?? '—'} (running + in-progress)</dd>
                <dt>Running (RAM-entitled)</dt>
                <dd>{counts.running ?? '—'}</dd>
                <dt>Live leases (reserved)</dt>
                <dd>
                  {counts.liveLeases ?? '—'} × {fmtMiB(c.perBootBudgetMiB)} = {fmtMiB(counts.reservedMiB)}
                  {counts.inProgress ? ` (in-progress: ${counts.inProgress})` : ''}
                </dd>
                <dt>Next boot admitted?</dt>
                <dd>
                  {next ? (
                    next.admitted ? (
                      <strong style={{ color: 'var(--ok, #2e7d32)' }}>
                        YES — projected {fmtMiB(next.projectedMiB)} after the boot
                      </strong>
                    ) : (
                      <strong style={{ color: 'var(--danger, #c62828)' }}>
                        NO — {next.reason}
                      </strong>
                    )
                  ) : (
                    '—'
                  )}
                </dd>
                <dt>Store</dt>
                <dd>redis: {st.store?.redis === true ? 'ok' : st.store?.redis === false ? 'UNAVAILABLE' : '—'}</dd>
              </dl>
            )
          )}
        </StateFrame>
      </section>

      <section className="card">
        <h2>Decision trail</h2>
        <StateFrame
          loading={decisions.loading}
          error={decisions.error && decisions.error.status !== 503 ? decisions.error : null}
          empty={!decisions.loading && (!decisions.data?.decisions || decisions.data.decisions.length === 0)}
          emptyTitle="No decisions yet"
          emptyHint="Admit/deny/release decisions will appear here as boots are requested."
        >
          <table className="list-table">
            <thead>
              <tr>
                <th>time</th>
                <th>action</th>
                <th>kind</th>
                <th>entity</th>
                <th>result</th>
                <th>reason</th>
                <th>MemAvail</th>
                <th>projected</th>
                <th>source</th>
              </tr>
            </thead>
            <tbody>
              {(decisions.data?.decisions ?? []).map((d, i) => (
                <tr key={`${d.ts}-${i}`}>
                  <td>{fmtTs(d.ts)}</td>
                  <td>{d.action}</td>
                  <td>{d.kind ?? '—'}</td>
                  <td>{d.entity ?? '—'}</td>
                  <td>
                    {d.admitted === null || d.admitted === undefined
                      ? '—'
                      : d.admitted
                        ? 'ADMITTED'
                        : 'DENIED'}
                  </td>
                  <td>
                    <title>{REASON_HINTS[d.reason] ?? ''}</title>
                    {d.reason}
                  </td>
                  <td>{fmtMiB(d.currentMiB)}</td>
                  <td>{fmtMiB(d.projectedMiB)}</td>
                  <td>{d.source ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </StateFrame>
      </section>

      {isAdmin ? (
        <section className="card">
          <h2>Policy (operator)</h2>
          <p className="muted">
            Stored as AppSetting <code>ram_gate.config</code>; env <code>RAM_GATE_*</code> overrides win. The gate
            re-reads the config on every decision — changes are live.
          </p>
          {form && (
            <div className="stack">
              <label className="row">
                <input type="checkbox" checked={form.enabled} onChange={setField('enabled')} /> Gate enabled
                (uncheck = emergency bypass, labelled GATE_DISABLED)
              </label>
              <label className="row">
                maxParallel <input type="number" min="1" max="128" value={form.maxParallel} onChange={setField('maxParallel')} />
              </label>
              <label className="row">
                hardFloorMiB <input type="number" min="1024" value={form.hardFloorMiB} onChange={setField('hardFloorMiB')} />
              </label>
              <label className="row">
                postBootTargetMiB <input type="number" min="0" value={form.postBootTargetMiB} onChange={setField('postBootTargetMiB')} />
              </label>
              <label className="row">
                perBootBudgetMiB <input type="number" min="128" value={form.perBootBudgetMiB} onChange={setField('perBootBudgetMiB')} />
              </label>
              <label className="row">
                metricsMaxAgeMs <input type="number" min="1000" value={form.metricsMaxAgeMs} onChange={setField('metricsMaxAgeMs')} />
              </label>
              <label className="row">
                leaseTtlMs <input type="number" min="60000" value={form.leaseTtlMs} onChange={setField('leaseTtlMs')} />
              </label>
              <div className="row">
                <button type="button" className="btn btn-primary" style={{ width: 'auto' }} disabled={saving} onClick={saveConfig}>
                  Save policy
                </button>
                <button type="button" className="btn btn-ghost" style={{ width: 'auto' }} disabled={saving} onClick={runReconcile}>
                  Force reconcile
                </button>
              </div>
              {saveMsg ? <p className="muted">{saveMsg}</p> : null}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

export default RamGate;
