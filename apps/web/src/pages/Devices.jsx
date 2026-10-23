import { useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import { navigate } from '../router';
import { StateFrame } from '../components/StateFrame';
import { timeAgo, stateBadgeClass } from '../components/container-utils';
import {
  gpuStatusBadge,
  adbStateBadge,
  netStateBadge,
  deviceActionsForState,
  adbPortLabel,
} from '../components/redroid-utils';

/**
 * Redroid devices list (MD §6.4, 工單 P5 scope 7).
 *
 * Honest-by-construction:
 *  - ADB port is always rendered as `127.0.0.1:<port>` — the UI never
 *    implies a public binding (MD §1.2)
 *  - GPU health shows the backend's gpuStatus verbatim (未驗證 stays 未驗證)
 *  - 最後診斷時間 comes from lastDiagnosedAt — null shows 未診斷, not a guess
 */
export function Devices() {
  const me = useApi(() => api.get('/api/auth/me'));
  const user = me.data?.user;
  const role = user?.role;
  const list = useApi(() => api.get('/api/devices/redroid'), []);
  const templates = useApi(() => api.get('/api/redroid/templates'), []);
  const preflight = useApi(() => api.get('/api/redroid/preflight'), []);

  const [form, setForm] = useState({ name: '', templateName: '' });
  const [busy, setBusy] = useState({});
  const [errors, setErrors] = useState({});
  const [target, setTarget] = useState(null);
  const [confirm, setConfirm] = useState('');
  const [removeData, setRemoveData] = useState(false);

  const items = list.data?.devices ?? [];
  const tplList = templates.data?.templates ?? [];
  const canWrite = role === 'admin' || role === 'operator';

  const pf = preflight.data ?? null;
  const pfSupported = pf?.overall === 'supported';
  const pfUnsupported = pf?.overall === 'unsupported';

  const query = useMemo(() => `/api/devices/redroid`, []);
  void query;

  async function runAction(item, action) {
    const key = `${item.id}:${action}`;
    setErrors((m) => ({ ...m, [key]: null }));
    setBusy((m) => ({ ...m, [key]: true }));
    try {
      await api.post(`/api/devices/redroid/${encodeURIComponent(item.id)}/${action}`);
      list.reload();
    } catch (err) {
      setErrors((m) => ({ ...m, [key]: `${err.code ?? 'ERROR'} — ${err.message}` }));
    } finally {
      setBusy((m) => ({ ...m, [key]: false }));
    }
  }

  async function createDevice(e) {
    e.preventDefault();
    if (!form.name.trim() || !form.templateName) return;
    setBusy((m) => ({ ...m, create: true }));
    setErrors((m) => ({ ...m, create: null }));
    try {
      await api.post('/api/devices/redroid', {
        name: form.name.trim(),
        templateName: form.templateName,
        idempotencyKey: `ui-${Date.now()}`,
      });
      setForm({ name: '', templateName: '' });
      list.reload();
    } catch (err) {
      setErrors((m) => ({ ...m, create: `${err.code ?? 'ERROR'} — ${err.message}` }));
    } finally {
      setBusy((m) => ({ ...m, create: false }));
    }
  }

  async function confirmDelete() {
    if (!target || confirm.trim() !== target.name) return;
    const key = `${target.id}:delete`;
    setBusy((m) => ({ ...m, [key]: true }));
    setErrors((m) => ({ ...m, [key]: null }));
    try {
      await api.del(`/api/devices/redroid/${encodeURIComponent(target.id)}`, {
        confirm: target.name,
        removeData,
      });
      setTarget(null);
      setConfirm('');
      setRemoveData(false);
      list.reload();
    } catch (err) {
      setErrors((m) => ({ ...m, [key]: `${err.code ?? 'ERROR'} — ${err.message}` }));
    } finally {
      setBusy((m) => ({ ...m, [key]: false }));
    }
  }

  return (
    <div className="stack">
      <div className="card-head">
        <h1>Redroid devices</h1>
        <button
          type="button"
          className="console-open-btn"
          onClick={() => navigate('/devices/fleet')}
          title="Fleet Console — 同時開啟 1–5 路裝置串流（MD §14 Phase 3）"
        >
          Fleet Console（1–5 路）
        </button>
      </div>

      {preflight.error ? (
        <div className="error-box">Preflight unavailable: {preflight.error.message}</div>
      ) : pf ? (
        <div className={`card pf-banner ${pfSupported ? 'pf-ok' : pfUnsupported ? 'pf-bad' : 'pf-warn'}`}>
          <strong>Host preflight: {pf.overall}</strong>
          <span className="muted">
            {' '}
            {pf.mock ? '(mock adapter — not a real host check) — ' : ''}
            binder_linux={pf.binder?.modules?.binder_linux ?? 'unknown'} ·
            ashmem_linux={pf.binder?.modules?.ashmem_linux ?? 'unknown'} ·
            GPU={pf.gpu ? (pf.gpu.available ? `present (${pf.gpu.gpus?.length ?? 0}, verified=${pf.gpu.verified})` : 'absent') : 'n/a'}
          </span>
          {pfUnsupported ? (
            <p>
              This host cannot run real Redroid (missing binder_linux/ashmem_linux). Device creation still
              proceeds as a <em>mock/managed</em> path — the platform never pretends the kernel is ready.
            </p>
          ) : null}
        </div>
      ) : null}

      {canWrite ? (
        <form className="card toolbar" onSubmit={createDevice}>
          <div className="toolbar-group">
            <label className="muted">Template
              <select
                className="input"
                value={form.templateName}
                onChange={(e) => setForm((f) => ({ ...f, templateName: e.target.value }))}
              >
                <option value="">— select a Redroid template —</option>
                {tplList.filter((t) => t.isEnabled !== false).map((t) => (
                  <option key={t.id} value={t.name}>
                    {t.name}{t.privileged ? ' (privileged)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="muted">Device name
              <input
                className="input"
                value={form.name}
                placeholder="redroid-dev1"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <button className="btn" type="submit" disabled={busy.create || !form.name.trim() || !form.templateName}>
              {busy.create ? 'Creating…' : 'Create device'}
            </button>
          </div>
          {errors.create ? <div className="error-box">{errors.create}</div> : null}
        </form>
      ) : (
        <p className="muted">Read-only role ({role}). Devices are created from admin/operator templates.</p>
      )}

      <StateFrame
        loading={list.loading}
        error={list.error}
        empty={!list.loading && !list.error && items.length === 0}
        emptyTitle="No Redroid devices"
        emptyHint="Create one from a Redroid template above."
      >
        <div className="table-wrap">
          <table className="list-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Image</th>
                <th>Android</th>
                <th>ADB (localhost only)</th>
                <th>Container</th>
                <th>Network (fail-closed)</th>
                <th>ADB state</th>
                <th>Resolution</th>
                <th>DPI</th>
                <th>FPS</th>
                <th>GPU health</th>
                <th>Last diagnosed</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const acts = deviceActionsForState(item.containerState);
                const adb = adbStateBadge(item.adbState);
                const gpu = gpuStatusBadge(item.gpuStatus);
                const errKey = Object.keys(errors).find((k) => k.startsWith(`${item.id}:`));
                return (
                  <tr key={item.id} className={errKey ? 'row-error' : null}>
                    <td>
                      <a className="link" href={`#/devices/${encodeURIComponent(item.id)}`}>{item.name}</a>
                      <div className="muted mono">{item.templateName}</div>
                    </td>
                    <td className="mono cell-clip" title={item.image}>{item.image}</td>
                    <td>{item.androidVersion}</td>
                    <td className="mono" title="ADB is published on 127.0.0.1 only — never public">{adbPortLabel(item.adbPort, item.adbBind)}</td>
                    <td><span className={`pill state-badge ${stateBadgeClass(item.containerState)}`}>{item.containerState}</span></td>
                    <td title={item.proxy?.network ? `state=${item.proxy.network.state} · checked ${item.proxy.network.checkedAt ?? 'never'} · ${item.proxy.network.stale ? 'STALE (treated as unhealthy)' : 'fresh'}` : 'no egress proxy bound'}>
                      {(() => { const nb = netStateBadge(item.proxy?.network ?? null); return <span className={`pill ${nb.cls}`}>{nb.label}</span>; })()}
                    </td>
                    <td><span className={`pill ${adb.cls}`}>{adb.label}</span></td>
                    <td className="mono">{item.width}×{item.height}</td>
                    <td className="mono">{item.dpi}</td>
                    <td className="mono">{item.fps}</td>
                    <td title={item.gpuMode ? `mode: ${item.gpuMode}` : ''}><span className={`pill ${gpu.cls}`}>{gpu.label}</span></td>
                    <td title={item.lastDiagnosedAt ? new Date(item.lastDiagnosedAt).toLocaleString() : 'never diagnosed'}>
                      {item.lastDiagnosedAt ? timeAgo(item.lastDiagnosedAt) : <span className="muted">未診斷</span>}
                    </td>
                    <td>
                      {canWrite ? (
                        <div className="row-actions">
                          <button className="btn btn-ghost" disabled={!acts.start || busy[`${item.id}:start`]} onClick={() => runAction(item, 'start')} title="Start">▶</button>
                          <button className="btn btn-ghost" disabled={!acts.stop || busy[`${item.id}:stop`]} onClick={() => runAction(item, 'stop')} title="Stop">■</button>
                          <button className="btn btn-ghost" disabled={!acts.restart || busy[`${item.id}:restart`]} onClick={() => runAction(item, 'restart')} title="Restart">↻</button>
                          <button className="btn btn-ghost btn-danger" onClick={() => { setTarget(item); setConfirm(''); setRemoveData(false); }} title="Delete (admin)">🗑</button>
                        </div>
                      ) : <span className="muted">—</span>}
                      {errKey ? <div className="error-box">{errors[errKey]}</div> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </StateFrame>

      {target ? (
        <div className="card confirm-card" role="alertdialog" aria-label="Confirm device deletion">
          <h2>Delete <code>{target.name}</code>?</h2>
          <p className="muted">
            Admin-only and fully audited. The container is removed; the per-device
            <code> /data</code> directory is kept unless you tick removeData.
          </p>
          <div className="confirm-grid">
            <label>
              Type the device name <code>{target.name}</code> to confirm
              <input
                className="input"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={target.name}
                autoFocus
              />
            </label>
            <label className="check">
              <input type="checkbox" checked={removeData} onChange={(e) => setRemoveData(e.target.checked)} />
              Also remove the device's /data directory (removeData)
            </label>
          </div>
          <div className="toolbar-group">
            <button
              className="btn btn-danger"
              disabled={confirm.trim() !== target.name || busy[`${target.id}:delete`] === true}
              onClick={confirmDelete}
            >
              {busy[`${target.id}:delete`] ? 'Deleting…' : 'Delete permanently'}
            </button>
            <button className="btn btn-ghost" onClick={() => setTarget(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default Devices;
