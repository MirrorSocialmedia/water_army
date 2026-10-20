import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import { StateFrame } from '../components/StateFrame';
import { timeAgo, stateBadgeClass, formatDateTime } from '../components/container-utils';
import {
  gpuStatusBadge,
  adbStateBadge,
  zoneBadge,
  deviceActionsForState,
  adbPortLabel,
  netStateBadge,
  netCheckBadge,
} from '../components/redroid-utils';

/**
 * Redroid device detail + diagnostics page (MD §6.4 — FOUR independent
 * result zones; 工單 硬驗收 1: zero fake "已驗證").
 *
 * Rendering rules (the UI's honesty contract):
 *  - every zone renders its OWN executed/status — zones are independent
 *  - executed=false → 未驗證 (not executed) badge + the note, never a pass
 *  - gpuVerification shows the backend status verbatim (未驗證 / software)
 *  - ADB target is always shown as 127.0.0.1:<port> (localhost only)
 */

function ZoneCard({ title, zone, renderDetail }) {
  const badge = zoneBadge(zone);
  return (
    <div className={`card zone-card zone-${String(zone?.status ?? 'not-executed').toLowerCase()}`}>
      <div className="card-head">
        <h3>{title}</h3>
        <span className={`pill ${badge.cls}`}>{badge.label}</span>
      </div>
      {renderDetail ? renderDetail(zone) : null}
    </div>
  );
}

export function DeviceDetail({ deviceId }) {
  const me = useApi(() => api.get('/api/auth/me'));
  const role = me.data?.user?.role;
  const canWrite = role === 'admin' || role === 'operator';

  const detail = useApi(() => api.get(`/api/devices/redroid/${encodeURIComponent(deviceId)}`), [deviceId]);
  const device = detail.data?.device ?? null;

  const [diag, setDiag] = useState(null); // last diagnostics result
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagError, setDiagError] = useState(null);
  const [busy, setBusy] = useState({});
  const [errors, setErrors] = useState({});

  const [logcatTail, setLogcatTail] = useState('200');
  const [logcat, setLogcat] = useState(null);
  const [logcatLoading, setLogcatLoading] = useState(false);
  const [logcatError, setLogcatError] = useState(null);

  const [target, setTarget] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [removeData, setRemoveData] = useState(false);

  async function runDiagnostics() {
    setDiagLoading(true);
    setDiagError(null);
    try {
      const res = await api.post(`/api/devices/redroid/${encodeURIComponent(deviceId)}/diagnostics`);
      setDiag(res);
      detail.reload(); // lastDiagnosedAt changed
    } catch (err) {
      setDiagError(`${err.code ?? 'ERROR'} — ${err.message}`);
    } finally {
      setDiagLoading(false);
    }
  }

  async function runAction(action) {
    const key = action;
    setErrors((m) => ({ ...m, [key]: null }));
    setBusy((m) => ({ ...m, [key]: true }));
    try {
      await api.post(`/api/devices/redroid/${encodeURIComponent(deviceId)}/${action}`);
      detail.reload();
    } catch (err) {
      setErrors((m) => ({ ...m, [key]: `${err.code ?? 'ERROR'} — ${err.message}` }));
    } finally {
      setBusy((m) => ({ ...m, [key]: false }));
    }
  }

  // R4 (MD §6.3): manual intervention for the network recovery policy.
  // Allowed by the API only from FAILED/BLOCKED/DEGRADED; the attempt still
  // ends in VERIFYING + canary (never a blind HEALTHY).
  async function runNetworkRetry() {
    setErrors((m) => ({ ...m, netRetry: null }));
    setBusy((m) => ({ ...m, netRetry: true }));
    try {
      await api.post(`/api/devices/redroid/${encodeURIComponent(deviceId)}/proxy/retry`);
      detail.reload();
    } catch (err) {
      setErrors((m) => ({ ...m, netRetry: `${err.code ?? 'ERROR'} — ${err.message}` }));
    } finally {
      setBusy((m) => ({ ...m, netRetry: false }));
    }
  }

  async function fetchLogcat() {
    setLogcatLoading(true);
    setLogcatError(null);
    try {
      const res = await api.get(`/api/devices/redroid/${encodeURIComponent(deviceId)}/logcat?tail=${encodeURIComponent(logcatTail)}`);
      setLogcat(res);
    } catch (err) {
      setLogcatError(`${err.code ?? 'ERROR'} — ${err.message}`);
    } finally {
      setLogcatLoading(false);
    }
  }

  async function confirmDelete() {
    if (!device || confirm.trim() !== device.name) return;
    setBusy((m) => ({ ...m, delete: true }));
    setErrors((m) => ({ ...m, delete: null }));
    try {
      await api.del(`/api/devices/redroid/${encodeURIComponent(deviceId)}`, { confirm: device.name, removeData });
      window.location.hash = '/devices';
    } catch (err) {
      setErrors((m) => ({ ...m, delete: `${err.code ?? 'ERROR'} — ${err.message}` }));
    } finally {
      setBusy((m) => ({ ...m, delete: false }));
    }
  }

  const acts = device ? deviceActionsForState(device.containerState) : null;
  const zones = diag?.diagnostics ?? null;
  // R4: the authoritative network payload (R3 state machine projection) —
  // the ONLY source for everything in the Network card.
  const net = device?.proxy?.network ?? null;
  const netBadge = netStateBadge(net);

  return (
    <div className="stack">
      <StateFrame loading={detail.loading} error={detail.error} empty={!detail.loading && !detail.error && !device} emptyTitle="Device not found">
        {device ? (
          <>
            <div className="card-head">
              <h1>{device.name}</h1>
              <span className={`pill state-badge ${stateBadgeClass(device.containerState)}`}>{device.containerState}</span>
            </div>

            <div className="cards">
              <div className="card">
                <div className="card-head"><h3>Container</h3></div>
                <dl className="kv">
                  <dt>Image (pinned)</dt><dd className="mono">{device.image}</dd>
                  <dt>Android</dt><dd>{device.androidVersion}</dd>
                  <dt>Template</dt><dd>{device.templateName ?? '—'}</dd>
                  <dt>Container id</dt><dd className="mono">{device.containerId ?? '—'}</dd>
                  <dt>Created</dt><dd>{formatDateTime(device.createdAt)}</dd>
                </dl>
              </div>
              <div className="card">
                <div className="card-head"><h3>ADB (localhost only)</h3></div>
                <dl className="kv">
                  <dt>Target</dt><dd className="mono" title="Published on 127.0.0.1 only — the API never publishes ADB publicly">{adbPortLabel(device.adbPort, device.adbBind)}</dd>
                  <dt>State</dt><dd><span className={`pill ${adbStateBadge(device.adbState).cls}`}>{adbStateBadge(device.adbState).label}</span></dd>
                </dl>
              </div>
              <div className="card">
                <div className="card-head"><h3>Display / GPU</h3></div>
                <dl className="kv">
                  <dt>Resolution</dt><dd className="mono">{device.width}×{device.height} · {device.dpi} dpi · {device.fps} fps</dd>
                  <dt>GPU mode</dt><dd className="mono">{device.gpuMode}</dd>
                  <dt>GPU health</dt><dd><span className={`pill ${gpuStatusBadge(device.gpuStatus).cls}`}>{gpuStatusBadge(device.gpuStatus).label}</span></dd>
                </dl>
              </div>
            </div>

            {/* ------- R4 (MD §6.3): authoritative network state card -------
                The R3 state machine is the ONLY network truth. Everything
                here is TEXT (state names, not just colours); a stale check
                is shown as STALE and treated as unhealthy; "recovering"
                (VERIFYING) is never rendered as the old green badge. The
                dispatch line mirrors the worker gate (networkReady) so the
                console and the task dispatcher can never disagree. */}
            <div className="card">
              <div className="card-head">
                <h3>Network / egress (fail-closed)</h3>
                {net ? <span className={`pill ${netBadge.cls}`}>{netBadge.label}</span> : <span className="pill">no egress proxy bound</span>}
              </div>
              {net ? (
                <div className="net-card">
                  <dl className="kv">
                    <dt>State (authoritative)</dt>
                    <dd className="mono">{net.state}</dd>
                    <dt>Worker dispatch gate</dt>
                    <dd>
                      <span className={`pill ${netBadge.dispatch === 'ALLOWED' ? 'pill-up' : 'pill-down'}`}>
                        {netBadge.dispatch === 'ALLOWED' ? 'ALLOWED (networkReady)' : 'BLOCKED (not usable for network tasks)'}
                      </span>
                    </dd>
                    <dt>Last check</dt>
                    <dd title={net.checkedAt ?? 'never'}>{net.checkedAt ? `${timeAgo(net.checkedAt)} (${formatDateTime(net.checkedAt)})` : 'never'}</dd>
                    <dt>Last success</dt>
                    <dd title={net.lastSuccessAt ?? 'never'}>{net.lastSuccessAt ? `${timeAgo(net.lastSuccessAt)} (${formatDateTime(net.lastSuccessAt)})` : 'never'}</dd>
                    <dt>Consecutive failures</dt><dd className="mono">{net.consecutiveFailures}</dd>
                    <dt>Auto recoveries</dt><dd className="mono">{net.recoveries}</dd>
                    {net.nextRecoveryAt ? <><dt>Next auto attempt</dt><dd className="mono" title={net.nextRecoveryAt}>{formatDateTime(net.nextRecoveryAt)}</dd></> : null}
                    {net.recoveryLock ? <><dt>Recovery lock</dt><dd>{net.recoveryLock.held ? `held — until ${formatDateTime(net.recoveryLock.until)}` : 'released (expired)'}</dd></> : null}
                    <dt>Checks (last pass)</dt>
                    <dd>
                      <span className="net-checks">
                        <span className="net-check"><span className="muted">binary</span> <span className={`pill ${netCheckBadge(net.checks?.binary).cls}`}>{netCheckBadge(net.checks?.binary).label}</span></span>
                        <span className="net-check"><span className="muted">process</span> <span className={`pill ${netCheckBadge(net.checks?.process).cls}`}>{netCheckBadge(net.checks?.process).label}</span></span>
                        <span className="net-check"><span className="muted">interface</span> <span className={`pill ${netCheckBadge(net.checks?.interface).cls}`}>{netCheckBadge(net.checks?.interface).label}</span></span>
                        <span className="net-check"><span className="muted">routePolicy</span> <span className={`pill ${netCheckBadge(net.checks?.routePolicy).cls}`}>{netCheckBadge(net.checks?.routePolicy).label}</span></span>
                        <span className="net-check"><span className="muted">tcpCanary</span> <span className={`pill ${netCheckBadge(net.checks?.tcpCanary).cls}`}>{netCheckBadge(net.checks?.tcpCanary).label}</span></span>
                      </span>
                    </dd>
                    {net.lastError ? <>
                      <dt>Last error</dt>
                      <dd className="mono">{net.lastError.code}{net.lastError.detail ? ` — ${net.lastError.detail}` : ''} {net.lastError.at ? `(at ${formatDateTime(net.lastError.at)})` : ''}</dd>
                    </> : null}
                  </dl>
                  {net.stale ? <p className="pf-warn">STALE: the last health check is older than the freshness window — this device is treated as UNHEALTHY until a new check passes.</p> : null}
                  {net.manualIntervention ? <p className="pf-warn">Manual intervention is required — auto recovery is exhausted for this failure episode.</p> : null}
                  {canWrite && ['FAILED', 'BLOCKED', 'DEGRADED'].includes(String(net.state).toUpperCase()) ? (
                    <div className="toolbar-group">
                      <button className="btn" onClick={runNetworkRetry} disabled={busy.netRetry}>
                        {busy.netRetry ? 'Retrying…' : 'Manual network retry (resets episode + forced attempt)'}
                      </button>
                      <span className="muted">The attempt still ends in VERIFYING + canary — never a blind green.</span>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="muted">This device has no egress proxy bound — there is no network state to display (container-only).</p>
              )}
            </div>

            {canWrite ? (
              <div className="toolbar-group">
                <button className="btn" disabled={!acts.start || busy.start} onClick={() => runAction('start')}>▶ Start</button>
                <button className="btn" disabled={!acts.stop || busy.stop} onClick={() => runAction('stop')}>■ Stop</button>
                <button className="btn" disabled={!acts.restart || busy.restart} onClick={() => runAction('restart')}>↻ Restart</button>
                <button className="btn" onClick={runDiagnostics} disabled={diagLoading}>
                  {diagLoading ? 'Running diagnostics…' : 'Run 4-zone diagnostics'}
                </button>
                <span className="muted" title={device.lastDiagnosedAt ?? 'never'}>
                  last diagnosed: {device.lastDiagnosedAt ? timeAgo(device.lastDiagnosedAt) : '未診斷'}
                </span>
              </div>
            ) : null}
            {Object.values(errors).some(Boolean) ? <div className="error-box">{Object.values(errors).filter(Boolean).join(' · ')}</div> : null}

            {/* ------- diagnostics: 4 INDEPENDENT zones (MD §6.4) ------- */}
            <h2>Diagnostics</h2>
            {diagError ? <div className="error-box">{diagError}</div> : null}
            {!zones ? (
              <div className="state state-empty">
                <p>{canWrite ? 'No diagnostics run yet — click "Run 4-zone diagnostics".' : 'Diagnostics are operator+ only.'}</p>
                {diag ? <p className="muted">Checked at {formatDateTime(diag.checkedAt)}</p> : null}
              </div>
            ) : (
              <>
                <p className="muted">Checked at {formatDateTime(diag.checkedAt)} — each zone is independent; a zone that was not executed shows 未驗證, never a pass.</p>
                <div className="cards">
                  <ZoneCard
                    title="1 · Kernel prerequisites"
                    zone={zones.kernel}
                    renderDetail={(z) => (
                      <div>
                        {z.mock ? <p className="muted">⚠ mock preflight — deterministic simulation, not a real host check</p> : null}
                        {(z.summary ?? []).map((w, i) => <p key={i} className="pf-warn">{w}</p>)}
                        <dl className="kv">
                          <dt>binder_linux</dt><dd className="mono">{z.details?.binder?.modules?.binder_linux ?? '—'}</dd>
                          <dt>ashmem_linux</dt><dd className="mono">{z.details?.binder?.modules?.ashmem_linux ?? '—'}</dd>
                          <dt>/dev/binder</dt><dd className="mono">{z.details?.binder?.devices?.['/dev/binder'] ? 'present' : 'absent'}</dd>
                          <dt>docker</dt><dd className="mono">{z.details?.docker?.available ? 'available' : `unavailable${z.details?.docker?.error ? ` (${z.details.docker.error})` : ''}`}</dd>
                          <dt>data root</dt><dd className="mono">{z.details?.disk?.dataRoot ?? '—'} {z.details?.disk?.exists ? '' : '(missing)'}</dd>
                        </dl>
                        {(z.details?.binder?.suggestions ?? []).length ? (
                          <ul className="suggestions">{z.details.binder.suggestions.map((s, i) => <li key={i}>{s}</li>)}</ul>
                        ) : null}
                      </div>
                    )}
                  />
                  <ZoneCard
                    title="2 · Container logs"
                    zone={zones.containerLogs}
                    renderDetail={(z) => (
                      <div>
                        {z.status === 'ok' ? (
                          <>
                            <p className="muted">Last {z.tail} line(s){z.truncated ? ' — truncated by the output cap' : ''}.</p>
                            <pre className="log-viewer">{(z.lines ?? []).join('\n')}</pre>
                          </>
                        ) : (
                          <p>{z.note ?? z.status}</p>
                        )}
                      </div>
                    )}
                  />
                  <ZoneCard
                    title="3 · ADB connectivity"
                    zone={zones.adbConnectivity}
                    renderDetail={(z) => (
                      <div>
                        {z.executed === false ? <p>{z.note}</p> : (
                          <>
                            <dl className="kv">
                              <dt>Target</dt><dd className="mono">{z.target} (localhost only)</dd>
                              <dt>Connect attempted</dt><dd>{z.connectAttempted ? 'yes (once)' : 'no'}</dd>
                              {z.timedOut ? <><dt>Timed out</dt><dd>yes</dd></> : null}
                            </dl>
                            {z.evidence ? <pre className="log-viewer">{z.evidence}</pre> : null}
                            {z.note ? <p className="muted">{z.note}</p> : null}
                          </>
                        )}
                      </div>
                    )}
                  />
                  <ZoneCard
                    title="4 · GPU verification"
                    zone={zones.gpuVerification}
                    renderDetail={(z) => (
                      <div>
                        <p>{z.note}</p>
                        <p className="muted">DeviceRequests configured ≠ GPU working (MD §2.4). P5 has no in-device render check, so host mode stays 未驗證.</p>
                      </div>
                    )}
                  />
                </div>
              </>
            )}

            {/* ----------------------- logcat (capped) ----------------------- */}
            <h2>Logcat</h2>
            <div className="toolbar-group">
              <select className="input" value={logcatTail} onChange={(e) => setLogcatTail(e.target.value)} aria-label="Logcat tail">
                {['100', '200', '500', '1000', '5000'].map((n) => <option key={n} value={n}>last {n} lines</option>)}
              </select>
              <button className="btn" onClick={fetchLogcat} disabled={logcatLoading}>{logcatLoading ? 'Fetching…' : 'Fetch logcat'}</button>
              <span className="muted">tail is capped server-side (default 200, max 5000) — the platform never streams an uncapped logcat.</span>
            </div>
            {logcatError ? <div className="error-box">{logcatError}</div> : null}
            {logcat ? (
              <div className="card">
                <p className="muted">
                  {logcat.lines.length} line(s) of tail {logcat.tail} (cap {logcat.tailCap})
                  {logcat.truncated ? ' — <strong>truncated by the output byte cap</strong>' : ''}
                  {!logcat.truncated && logcat.mayHaveMore ? ' — the buffer may hold older lines beyond this window' : ''}
                  {logcat.timedOut ? ' — timed out' : ''}
                </p>
                <pre className="log-viewer">{logcat.lines.join('\n')}</pre>
              </div>
            ) : null}

            {role === 'admin' ? (
              <div className="card confirm-card danger-zone">
                <h2>Delete device</h2>
                <p className="muted">
                  Removes the container (audited). The per-device <code>/data</code> directory is kept unless you tick removeData.
                </p>
                {target ? (
                  <div className="confirm-grid">
                    <label>Type <code>{device.name}</code> to confirm
                      <input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={device.name} autoFocus />
                    </label>
                    <label className="check">
                      <input type="checkbox" checked={removeData} onChange={(e) => setRemoveData(e.target.checked)} />
                      Also remove the /data directory
                    </label>
                    <div className="toolbar-group">
                      <button className="btn btn-danger" disabled={confirm.trim() !== device.name || busy.delete} onClick={confirmDelete}>
                        {busy.delete ? 'Deleting…' : 'Delete permanently'}
                      </button>
                      <button className="btn btn-ghost" onClick={() => { setTarget(false); setConfirm(''); setRemoveData(false); }}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button className="btn btn-danger" onClick={() => setTarget(true)}>Delete {device.name}</button>
                )}
              </div>
            ) : null}
          </>
        ) : null}
      </StateFrame>
    </div>
  );
}

export default DeviceDetail;
