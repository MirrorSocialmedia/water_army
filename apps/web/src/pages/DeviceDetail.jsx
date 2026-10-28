import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import { navigate } from '../router';
import { StateFrame } from '../components/StateFrame';
import { deviceApps, redroidTemplates, networkPolicy } from '../services/device-extras';
import { isSwitchDisabled, conflictText, errorText, LONG_TEXT_CLASS, zonesFromPolicyRows, zonesToBody, zonesMatchServer } from '../lib/surfacy-ui';
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
  const canControl = ['admin', 'operator'].includes(me.data?.user?.role);
  const role = me.data?.user?.role;
  const canWrite = role === 'admin' || role === 'operator';
  // WA-UI-SURFACY (s3): tabbed surface for the formerly headless device
  // features (W2 device-apps / redroid templates / network dispatch policy).
  const [tab, setTab] = useState('overview');

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
              {device.containerState === 'running' ? (
                <button
                  type="button"
                  className="console-open-btn"
                  onClick={() => { navigate(`/devices/${encodeURIComponent(device.id)}/console${canControl ? '' : '?mode=viewer'}`); }}
                  title="Mobile Console — 串流畫面 + 手動操作 (MD §3.2)"
                >
                  開啟控制台
                </button>
              ) : (
                <span className="muted" title="裝置未在運行 — 先啟動才能串流">控制台需裝置運行中</span>
              )}
            </div>

            <div className="tabs" role="tablist">
              {[
                ['overview', '總覽 Overview'],
                ['apps', '應用 Apps'],
                ['templates', '模板 Templates'],
                ['policy', '派發策略 Policy'],
              ].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  className={`tab${tab === id ? ' active' : ''}`}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === 'apps' ? <DeviceAppsPanel deviceId={deviceId} canWrite={canWrite} /> : null}
            {tab === 'templates' ? <TemplatesPanel /> : null}
            {tab === 'policy' ? <PolicyPanel role={role} /> : null}

            {tab === 'overview' ? (<>
            {/* P4 (MD §7.1): event banner — an open human-intervention episode
                on THIS device. openInterventions = open/ack/in_progress count
                (null = unknown — the banner stays hidden, never a fake 0). */}
            {typeof device.openInterventions === 'number' && device.openInterventions > 0 ? (
              <div className="alert-banner critical">
                <AlertTriangle size={18} />
                <div>
                  <strong>{device.openInterventions} 個未解決人工介入事件</strong>
                  <p className="muted">此裝置有需人工處理的事件（被阻塞的事件不會自動恢復，MD §0.6/§7.1）。</p>
                </div>
                <a className="btn btn-sm" href={`#/interventions?deviceId=${encodeURIComponent(device.id)}`}>到 Needs Attention 處理</a>
              </div>
            ) : null}

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
          </>) : null}
          </>
        ) : null}
      </StateFrame>
    </div>
  );
}


/**
 * WA-UI-SURFACY s3 — W2 device-apps panel (ADR-026).
 * Reads (pm list packages / package info) = viewer+; install/uninstall =
 * operator+. Install takes a managed-dir flat file name only — the backend
 * owns the APK allowlist dir; no path traversal is even expressible here.
 * 503 APP_OPS_DISABLED renders an honest switch-off card (never a crash).
 */
function DeviceAppsPanel({ deviceId, canWrite }) {
  const [filter, setFilter] = useState('');
  const pkgs = useApi(() => deviceApps.list(deviceId, filter.trim() || undefined), [deviceId, filter]);
  const disabled = isSwitchDisabled(pkgs.error, 'APP_OPS_DISABLED');
  const [installName, setInstallName] = useState('');
  const [busy, setBusy] = useState(null); // 'install' | pkg name | null
  const [note, setNote] = useState(null);
  const [info, setInfo] = useState(null); // { pkg, ...result } | null
  const [armed, setArmed] = useState(null); // pkg awaiting uninstall confirm

  async function doInstall() {
    if (busy) return; // double-submit guard
    setBusy('install');
    setNote(null);
    try {
      const res = await deviceApps.install(deviceId, installName.trim());
      setNote({ kind: 'ok', text: `installed ${installName.trim()}: ${JSON.stringify(res).slice(0, 160)}` });
      setInstallName('');
      pkgs.reload();
    } catch (e) {
      setNote({ kind: 'err', text: conflictText(e) ?? errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  async function doUninstall(pkg) {
    if (busy) return;
    if (armed !== pkg) {
      setArmed(pkg); // first click arms, second confirms (typo-proof two-step)
      return;
    }
    setBusy(pkg);
    setNote(null);
    try {
      await deviceApps.uninstall(deviceId, pkg);
      setNote({ kind: 'ok', text: `uninstalled ${pkg}` });
      pkgs.reload();
    } catch (e) {
      setNote({ kind: 'err', text: conflictText(e) ?? errorText(e) });
    } finally {
      setBusy(null);
      setArmed(null);
    }
  }

  async function showInfo(pkg) {
    setNote(null);
    try {
      const res = await deviceApps.info(deviceId, pkg);
      setInfo({ pkg, ...res });
    } catch (e) {
      setNote({ kind: 'err', text: errorText(e) });
    }
  }

  if (disabled) {
    return (
      <div className="card" role="region" aria-label="Device apps">
        <div className="card-head"><strong>應用 (W2 — ADR-026)</strong></div>
        <p className="muted">
          Disabled on this host — <code className="mono">APP_OPS_DISABLED</code> (503).
          Set WA_APP_OPS_ENABLED=true after reviewing ADR-026 (real-device matrix NOT VERIFIED).
        </p>
      </div>
    );
  }

  const list = pkgs.data?.packages ?? [];
  return (
    <div className="card" role="region" aria-label="Device apps">
      <div className="card-head">
        <strong>應用 (W2 — ADR-026)</strong>
        <span className="muted">pm list packages — the device is the truth</span>
      </div>
      <div className="row-actions" style={{ marginBottom: 8 }}>
        <input
          type="text"
          className="input"
          style={{ maxWidth: 280 }}
          placeholder="package filter (exact pkg name)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="button" className="btn btn-ghost" onClick={pkgs.reload} disabled={pkgs.loading}>Reload</button>
        {pkgs.data ? (
          <span className="muted">
            {pkgs.data.count} package(s){pkgs.data.truncated ? ' — truncated by output cap' : ''}
          </span>
        ) : null}
      </div>
      <StateFrame
        loading={pkgs.loading}
        error={pkgs.error}
        empty={!pkgs.loading && !pkgs.error && list.length === 0}
        emptyTitle="No packages"
        emptyHint={filter ? 'No package matches the filter.' : 'Device reports no packages.'}
      >
        <div className="table-wrap">
          <table className="list-table">
            <thead><tr><th>package</th><th>actions</th></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p}>
                  <td className={LONG_TEXT_CLASS}>{p}</td>
                  <td>
                    <div className="row-actions">
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => showInfo(p)} disabled={busy !== null}>info</button>
                      {canWrite ? (
                        <button
                          type="button"
                          className={`btn btn-sm ${armed === p ? 'btn-danger' : 'btn-ghost'}`}
                          disabled={busy !== null}
                          onClick={() => doUninstall(p)}
                        >
                          {busy === p ? 'Removing…' : armed === p ? 'confirm uninstall' : 'uninstall'}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </StateFrame>
      {info ? (
        <p className="muted">
          <code className="mono">{info.pkg}</code>: {info.installed ? 'installed' : 'NOT installed'}
          {info.versionName ? ` · versionName ${info.versionName}` : ''}
          {info.versionCode ? ` · versionCode ${info.versionCode}` : ''}
          {info.truncated ? ' — dumpsys truncated (version fields may be cut off)' : ''}
        </p>
      ) : null}
      {note ? <code className={note.kind === 'ok' ? 'status-ok' : 'dep-error'}>{note.text}</code> : null}
      {canWrite ? (
        <div className="row-actions" style={{ marginTop: 10 }}>
          <input
            type="text"
            className="input"
            style={{ maxWidth: 320 }}
            placeholder="managed-dir file name — e.g. app.apk"
            value={installName}
            onChange={(e) => setInstallName(e.target.value)}
          />
          <button
            type="button"
            className="btn"
            disabled={busy !== null || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.apk$/.test(installName.trim())}
            onClick={doInstall}
          >
            {busy === 'install' ? 'Installing…' : '安裝 APK (managed dir)'}
          </button>
          <span className="muted">only flat .apk names from the server-managed dir are accepted (backend-validated).</span>
        </div>
      ) : (
        <p className="muted">Read-only role — 安裝/移除 needs operator+.</p>
      )}
    </div>
  );
}

/**
 * WA-UI-SURFACY s3 — redroid templates list (read-only; writes stay admin
 * on the API but the UI surfaces list/detail only, per work order).
 * proxy presence is a { configured } flag — the URL never travels.
 */
function TemplatesPanel() {
  const tpl = useApi(() => redroidTemplates.list(), []);
  const rows = tpl.data?.templates ?? [];
  return (
    <div className="card" role="region" aria-label="Redroid templates">
      <div className="card-head">
        <strong>Redroid 模板 (read-only)</strong>
        <button type="button" className="btn btn-sm btn-ghost" onClick={tpl.reload} disabled={tpl.loading}>Reload</button>
      </div>
      <StateFrame
        loading={tpl.loading}
        error={tpl.error}
        empty={!tpl.loading && !tpl.error && rows.length === 0}
        emptyTitle="No templates"
        emptyHint="Create templates via the admin API (pinned image refs only — no latest)."
      >
        <div className="table-wrap">
          <table className="list-table">
            <thead>
              <tr>
                <th>name</th><th>image (pinned)</th><th>Android</th><th>display</th>
                <th>gpu</th><th>privileged</th><th>limits</th><th>proxy</th><th>enabled</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td className="mono">{t.name}</td>
                  <td className={LONG_TEXT_CLASS} title={t.image}>{t.image}</td>
                  <td>{t.androidVersion}</td>
                  <td className="mono">{t.width}×{t.height}·{t.dpi}·{t.fps}fps</td>
                  <td>{t.gpuMode}</td>
                  <td>{t.privileged ? `yes — ${t.privilegedReason ?? ''}` : 'no'}</td>
                  <td className="mono">{t.cpuLimit ?? '—'}c / {t.memoryLimitBytes ? `${Math.round(t.memoryLimitBytes / 1073741824)} GiB` : '∞'}</td>
                  <td>{t.proxy?.configured ? 'bound (URL hidden)' : '—'}</td>
                  <td className={t.isEnabled ? 'status-ok' : 'status-degraded'}>{t.isEnabled ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </StateFrame>
      <p className="muted" style={{ marginTop: 8 }}>
        建/改/刪 templates = admin API 專屬（UI 只讀 — privileged 只可存在於專用 template）。
      </p>
    </div>
  );
}

/**
 * WA-UI-SURFACY s3 — network dispatch policy (BR-B6). ADMIN ONLY read AND
 * write on the backend — a viewer sees an honest 403 frame, never fake data.
 * Writes echo the EFFECTIVE policy (live on next dispatch; empty+empty env =
 * unavailable = fail-closed emergency stop, reported as such).
 */
function PolicyPanel({ role }) {
  const isAdmin = role === 'admin';
  const pol = useApi(() => networkPolicy.get(), [], { enabled: isAdmin });
  const [zones, setZones] = useState(null); // { allowlist, allowlistInternal } textarea text
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);

  // F4 fix: re-seed the textareas whenever SERVER state changes (first load,
  // Reload button, or a save's follow-up reload). defaultValue-only textareas
  // kept stale user text across reloads — reload must show server truth.
  const rows = pol.data?.appSettings ?? null;
  const serverSig = rows ? JSON.stringify(zonesFromPolicyRows(rows)) : null;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    setZones(zonesFromPolicyRows(rowsRef.current));
  }, [serverSig]);

  async function saveZones() {
    if (busy) return; // double-submit guard
    if (!zones) return; // nothing painted yet — honest no-op (F4 empty-save guard)
    if (zonesMatchServer(zones, rowsRef.current)) return; // no-op save never fires (was: backend 400 "nothing to update")
    const body = zonesToBody(zones); // always BOTH keys — never {}
    setBusy('zones');
    setNote(null);
    try {
      const res = await networkPolicy.putAllowlists(body);
      setNote({ kind: 'ok', text: `saved — available=${res.available}${res.reason ? ` (${res.reason})` : ''}; effective on NEXT dispatch` });
      pol.reload(); // re-seeds textareas from fresh server state (effect on serverSig)
    } catch (e) {
      setNote({ kind: 'err', text: conflictText(e) ?? errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  async function saveTaskTypes(ai, adhoc) {
    if (busy) return;
    setBusy('taskTypes');
    setNote(null);
    try {
      const res = await networkPolicy.putTaskTypes({ ai, adhoc });
      setNote({ kind: 'ok', text: `task types saved — available=${res.available}` });
      pol.reload();
    } catch (e) {
      setNote({ kind: 'err', text: conflictText(e) ?? errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  if (!isAdmin) {
    return (
      <div className="card" role="region" aria-label="Network policy">
        <div className="card-head"><strong>派發網絡策略 (BR-B6)</strong></div>
        <p className="muted">
          403 — the dispatch allowlist is security-critical state: admin-only read <em>and</em> write.
          Your role ({role}) sees this honest frame, not fake data.
        </p>
      </div>
    );
  }

  const eff = pol.data?.effective ?? null;
  const tt = eff?.taskTypes ?? null;
  const unchanged = !zones || zonesMatchServer(zones, rowsRef.current);

  return (
    <div className="card" role="region" aria-label="Network policy">
      <div className="card-head">
        <strong>派發網絡策略 (BR-B6 — admin only)</strong>
        <button type="button" className="btn btn-sm btn-ghost" onClick={pol.reload} disabled={pol.loading}>Reload</button>
      </div>
      <StateFrame loading={pol.loading} error={pol.error} empty={!pol.loading && !pol.error && !pol.data} emptyTitle="No data">
        {pol.data ? (
          <>
            <p>
              available:{' '}
              <span className={`pill ${pol.data.available ? 'pill-up' : 'pill-down'}`}>
                {pol.data.available ? 'yes' : `no — ${pol.data.reason}`}
              </span>
            </p>
            {eff ? (
              <dl className="kv">
                {Object.entries(eff.entries ?? {}).map(([zone, list]) => (
                  <div key={zone}>
                    <dt>{zone} ({Array.isArray(list) ? list.length : 0})</dt>
                    <dd className={LONG_TEXT_CLASS}>{Array.isArray(list) && list.length ? list.map((e) => (typeof e === 'string' ? e : e?.entry ?? JSON.stringify(e))).join(' · ') : '(empty — env-only / cleared)'}</dd>
                  </div>
                ))}
                <dt>task types gated</dt>
                <dd className="mono">{JSON.stringify(eff.taskTypes ?? {})}</dd>
              </dl>
            ) : null}
            <p className="muted">
              env side: public={pol.data.env?.public ? 'set' : 'empty'} · internal={pol.data.env?.internal ? 'set' : 'empty'} —
              empty DB + empty env = unavailable = every run fails closed (supported emergency stop).
            </p>
            <div className="row-actions" style={{ margin: '8px 0' }}>
              <label className="check"><input type="checkbox" checked={tt?.ai ?? false} disabled={busy !== null} onChange={(e) => saveTaskTypes(e.target.checked, tt?.adhoc ?? false)} /> AI tasks gated</label>
              <label className="check"><input type="checkbox" checked={tt?.adhoc ?? false} disabled={busy !== null} onChange={(e) => saveTaskTypes(tt?.ai ?? false, e.target.checked)} /> ad-hoc tasks gated</label>
            </div>
            <div className="stack" style={{ gap: 8 }}>
              {['allowlist', 'allowlistInternal'].map((key) => (
                <label key={key} className="stack" style={{ gap: 2 }}>
                  <span className="muted">{key} — one entry per line (empty clears the DB zone; backend re-validates with the gate parser)</span>
                  <textarea
                    className="input"
                    rows={4}
                    style={{ fontFamily: 'monospace', fontSize: 12 }}
                    value={zones?.[key] ?? ''}
                    onChange={(e) => setZones((z) => ({ ...(z ?? { allowlist: '', allowlistInternal: '' }), [key]: e.target.value }))}
                  />
                </label>
              ))}
              <div className="row-actions">
                <button type="button" className="btn" disabled={busy !== null || unchanged} onClick={saveZones}>
                  {busy === 'zones' ? 'Saving…' : unchanged ? 'No changes' : 'Save allowlists (PUT)'}
                </button>
              </div>
            </div>
            {note ? <code className={note.kind === 'ok' ? 'status-ok' : 'dep-error'}>{note.text}</code> : null}
            <p className="muted" style={{ marginTop: 8 }}>
              Writes are audited (updatedBy + audit row) and live on the next dispatch attempt.
            </p>
          </>
        ) : null}
      </StateFrame>
    </div>
  );
}

export default DeviceDetail;
