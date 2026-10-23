import { useState } from 'react';
import { AlertTriangle, ExternalLink } from 'lucide-react';

import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import { navigate } from '../router';

/**
 * Needs Attention — human-intervention event center (MD §7.1, Phase 4).
 *
 *  - the open/in_progress queue (default tab) + a full-history "All" tab
 *  - every row: category, severity, device (name snapshot survives device
 *    deletion), time, concise reason, source — heuristic sources are marked
 *    (MD §6.1: 來源必須標記 heuristic)
 *  - blocked_pending_review rows + a page-level banner: "Automation paused —
 *    manual review required" with the allowed follow-up steps (MD §7.1)
 *  - Open device: reuses the EXISTING console (lease/slot acquisition is the
 *    console's job — ADR-020). When the stream slot is full the link is
 *    replaced by an explicit "5/5 — close one first" state + Fleet Console
 *    action; the server stays authoritative (never silently over-allocate,
 *    MD §7.1)
 *  - operator state machine over the API: Acknowledge / Assign to me /
 *    Resolve (note required) / Dismiss (reason required; the service applies
 *    the dismiss policy — external_verification is never dismissible)
 *  - viewer is read-only (MD §11.2): no action buttons, console deep link
 *    opens in viewer mode (?mode=viewer)
 *  - evidence is rendered as the SCRUBBED JSON the API returned — the service
 *    redacts before write (MD §6.2/§13); nothing here can reintroduce it
 *  - 15s silent poll (an operator watching a stuck device needs a live view)
 */

const STATUS_TEXT = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  in_progress: 'In progress',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};
const STATUS_PILL = {
  open: 'pill-down',
  acknowledged: 'pill-disabled',
  in_progress: 'pill-up',
  resolved: 'pill-up',
  dismissed: 'pill-disabled',
};
const ACTIONABLE = ['open', 'acknowledged', 'in_progress'];

function timeOf(d) {
  try {
    return new Date(d).toLocaleString();
  } catch {
    return String(d);
  }
}

/** One expanded intervention: evidence (scrubbed) + full history timeline. */
function InterventionDetail({ id, onBack }) {
  const detail = useApi(() => api.get(`/api/manual-interventions/${encodeURIComponent(id)}`), [id]);
  if (detail.loading) return <p className="muted">載入事件詳情…</p>;
  if (detail.error || !detail.data) return (
    <p className="muted">事件載入失敗：{detail.error?.message ?? 'not found'} <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>返回</button></p>
  );
  const { intervention: iv, history } = detail.data;
  return (
    <div className="stack">
      <div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>← 返回清單</button>
      </div>
      <div className="card">
        <div className="card-head">
          <h3>{iv.title}</h3>
          <span className={`pill ${STATUS_PILL[iv.status] ?? ''}`}>{STATUS_TEXT[iv.status] ?? iv.status}</span>
        </div>
        <dl className="kv">
          <dt>類別</dt><dd>{iv.category}{iv.heuristic ? <span className="muted">（heuristic 來源 — 可誤報，MD §6.1）</span> : null}</dd>
          <dt>來源</dt><dd>{iv.source}</dd>
          <dt>嚴重性</dt><dd className={`sev-${iv.severity}`}>{iv.severity}</dd>
          <dt>裝置</dt>
          <dd>
            {iv.deviceNameSnapshot}
            {iv.deviceId ? (
              <a className="muted" href={`#/devices/${encodeURIComponent(iv.deviceId)}`}> 詳情</a>
            ) : (
              <span className="muted">（裝置已移除 — 保留名稱快照）</span>
            )}
          </dd>
          <dt>建立</dt><dd>{timeOf(iv.createdAt)}</dd>
          <dt>更新</dt><dd>{timeOf(iv.updatedAt)}</dd>
          {iv.assigneeUserId ? <><dt>負責人</dt><dd>{iv.assigneeUserId}</dd></> : null}
          {iv.acknowledgedAt ? <><dt>Acknowledge</dt><dd>{timeOf(iv.acknowledgedAt)}</dd></> : null}
          {iv.resolvedAt ? <><dt>解決</dt><dd>{timeOf(iv.resolvedAt)}</dd></> : null}
          {iv.dedupeKey ? <><dt>Dedupe</dt><dd className="mono">{iv.dedupeKey}</dd></> : null}
        </dl>
        {iv.summary ? <p className="muted">{iv.summary}</p> : null}
      </div>
      <div className="card">
        <div className="card-head"><h3>證據（已 redact — MD §6.2）</h3></div>
        {iv.evidence && Object.keys(iv.evidence).length > 0 ? (
          <pre className="mono att-evidence">{JSON.stringify(iv.evidence, null, 2)}</pre>
        ) : (
          <p className="muted">無證據摘要（系統訊號只存機器碼 — 不含畫面/pixel/鍵盤文字）。</p>
        )}
      </div>
      <div className="card">
        <div className="card-head"><h3>狀態轉換歷史（audit）</h3></div>
        {history.length === 0 ? (
          <p className="muted">無記錄。</p>
        ) : (
          <table className="att-history">
            <thead>
              <tr><th>時間</th><th>動作</th><th>from → to</th><th>操作者</th><th>備註</th></tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td className="muted">{timeOf(h.createdAt)}</td>
                  <td>{h.action}</td>
                  <td>{h.fromStatus ?? '—'} → {h.toStatus ?? '—'}</td>
                  <td className="muted">{h.actorUserId ?? 'system'}</td>
                  <td className="muted">{h.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function Interventions({ user }) {
  const canAct = ['admin', 'operator'].includes(user?.role);
  const canControl = canAct; // console deep link: controller vs viewer mode
  const [tab, setTab] = useState('attention'); // 'attention' | 'all'
  const [severity, setSeverity] = useState('');
  // Deep link from the device detail banner: #/interventions?deviceId=<id>
  // (the hash query is parsed like DeviceConsole's ?mode=viewer).
  const [deviceIdFilter, setDeviceIdFilter] = useState(() => {
    try {
      return new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('deviceId') ?? '';
    } catch {
      return '';
    }
  });
  const [expandedId, setExpandedId] = useState(null);
  const [busy, setBusy] = useState(false); // one action in flight (防連點)

  const qs = `status=${tab === 'attention' ? 'open,acknowledged,in_progress' : 'open,acknowledged,in_progress,resolved,dismissed'}${severity ? `&severity=${severity}` : ''}${deviceIdFilter ? `&deviceId=${encodeURIComponent(deviceIdFilter)}` : ''}&pageSize=50`;
  const list = useApi(() => api.get(`/api/manual-interventions?${qs}`), [tab, severity, deviceIdFilter], { intervalMs: 15_000 });
  // Slot usage for the "Open device" pre-check (server stays authoritative).
  const usage = useApi(() => api.get('/api/device-streams'), [], { intervalMs: 30_000 });

  if (expandedId) return <InterventionDetail id={expandedId} onBack={() => setExpandedId(null)} />;

  const items = list.data?.items ?? [];
  const blocked = items.filter((i) => i.automationDisposition === 'blocked_pending_review' && ACTIONABLE.includes(i.status));
  const atCap = (usage.data?.usage?.active ?? 0) >= (usage.data?.usage?.max ?? 5);

  async function act(id, fn) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      list.reload();
    } catch (e) {
      // surface the server's stable code/message — no silent success
      window.alert(`操作失敗：${e?.code ?? ''} ${e?.message ?? ''}`.trim());
    } finally {
      setBusy(false);
    }
  }

  function doAck(id) {
    act(id, () => api.post(`/api/manual-interventions/${encodeURIComponent(id)}/acknowledge`));
  }
  function doAssign(id) {
    act(id, () => api.post(`/api/manual-interventions/${encodeURIComponent(id)}/assign`, {}));
  }
  function doResolve(id) {
    const summary = window.prompt('Resolve — 結果/備註（必填，MD §6.3）：');
    if (summary === null) return;
    if (!summary.trim()) { window.alert('備註必填 — resolve 必須有結果記錄。'); return; }
    act(id, () => api.post(`/api/manual-interventions/${encodeURIComponent(id)}/resolve`, { summary: summary.trim() }));
  }
  function doDismiss(id) {
    const reason = window.prompt('Dismiss as false positive — 原因（必填，MD §6.3）：');
    if (reason === null) return;
    if (!reason.trim()) { window.alert('原因必填。'); return; }
    act(id, () => api.post(`/api/manual-interventions/${encodeURIComponent(id)}/dismiss`, { reason: reason.trim() }));
  }

  function openDeviceLink(iv) {
    if (!iv.deviceId) return <span className="muted">裝置已移除</span>;
    const href = `#/devices/${encodeURIComponent(iv.deviceId)}/console${canControl ? '' : '?mode=viewer'}`;
    if (usage.data && atCap) {
      // MD §7.1: 沒有 slot 時顯示 5/5 並提供「先關閉一個畫面」動作，不可默默超額
      return (
        <span className="muted">
          串流 5/5 已滿 — <a href="#/devices/fleet">到 Fleet Console 先關閉一個畫面</a>
        </span>
      );
    }
    return (
      <a className="btn btn-ghost btn-sm" href={href} title="取得 lease 後進入該裝置畫面（MD §7.2 step 3）">
        <ExternalLink size={12} /> Open device
      </a>
    );
  }

  return (
    <div className="stack">
      <div className="card-head">
        <h1>Needs Attention — 人工介入事件</h1>
        <div className="att-tabs">
          <button type="button" className={`btn btn-sm ${tab === 'attention' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('attention')}>
            需處理
          </button>
          <button type="button" className={`btn btn-sm ${tab === 'all' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('all')}>
            全部
          </button>
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="按嚴重性篩選">
            <option value="">全部嚴重性</option>
            <option value="critical">critical</option>
            <option value="high">high</option>
            <option value="warning">warning</option>
            <option value="info">info</option>
          </select>
          {deviceIdFilter ? (
            <span className="pill pill-disabled" title="只顯示此裝置的事件">
              裝置：{deviceIdFilter.slice(0, 8)}… <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDeviceIdFilter('')}>清除</button>
            </span>
          ) : null}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => list.reload()} disabled={list.loading}>
            重新整理
          </button>
        </div>
      </div>

      {!canAct ? <p className="muted">唯讀模式（viewer）— 可以查看事件與裝置，但無法執行狀態操作（MD §11.2）。</p> : null}

      {blocked.length > 0 ? (
        <div className="alert-banner critical" role="alert">
          <AlertTriangle size={18} />
          <div>
            <strong>Automation paused — manual review required</strong>（{blocked.length} 個事件被阻塞等待人工審查）
            <p className="muted">
              自動化不會自動恢復（MD §0.6）。後續步驟：Open device 檢查裝置 → Acknowledge → 人工處理後 Resolve。
              第三方驗證/完整性挑戰事件不可 Dismiss，只能由人工確認後 Resolve。
            </p>
          </div>
        </div>
      ) : null}

      {list.loading && !list.data ? <p className="muted">載入中…</p> : null}
      {list.error ? <div className="error-box">載入失敗：{list.error.message} — <button type="button" onClick={() => list.reload()}>重試</button></div> : null}

      {items.length === 0 && !list.loading ? (
        <div className="card"><p className="muted">沒有{tab === 'attention' ? '需處理' : ''}的人工介入事件 — 裝置異常時會自動出現在這裡。</p></div>
      ) : null}

      {items.map((iv) => (
        <div key={iv.id} className={`card att-row ${iv.automationDisposition === 'blocked_pending_review' && ACTIONABLE.includes(iv.status) ? 'att-row-blocked' : ''}`}>
          <div className="att-main">
            <div className="att-line1">
              <span className={`sev-${iv.severity}`}>{iv.severity}</span>
              <button type="button" className="att-title" onClick={() => setExpandedId(iv.id)} title="展開詳情（證據 + 歷史）">
                {iv.title}
              </button>
              {iv.heuristic ? <span className="pill pill-disabled" title="heuristic 來源 — 可能誤報">heuristic</span> : null}
              <span className={`pill ${STATUS_PILL[iv.status] ?? ''}`}>{STATUS_TEXT[iv.status] ?? iv.status}</span>
            </div>
            <div className="att-line2 muted">
              <span className="mono">{iv.category}</span>
              {' · '}
              {iv.deviceNameSnapshot}
              {iv.deviceId ? <a className="muted" href={`#/devices/${encodeURIComponent(iv.deviceId)}`}>（裝置）</a> : '（裝置已移除）'}
              {' · '}
              來源 {iv.source}
              {' · '}
              {timeOf(iv.updatedAt)}
              {iv.signalCount > 1 ? <span title="同一 open episode 收到多次訊號 — dedupe 生效"> · 訊號 ×{iv.signalCount}</span> : null}
            </div>
            {iv.summary ? <p className="att-summary">{iv.summary}</p> : null}
            {iv.automationDisposition === 'blocked_pending_review' && ACTIONABLE.includes(iv.status) ? (
              <div className="att-blocked-note">⛔ Automation paused — 等待人工審查，不可自動恢復</div>
            ) : null}
          </div>
          <div className="att-actions">
            {openDeviceLink(iv)}
            {canAct && iv.status === 'open' ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => doAck(iv.id)} disabled={busy}>
                Acknowledge
              </button>
            ) : null}
            {canAct && ['open', 'acknowledged'].includes(iv.status) ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => doAssign(iv.id)} disabled={busy}>
                Assign to me
              </button>
            ) : null}
            {canAct && ACTIONABLE.includes(iv.status) ? (
              <>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => doResolve(iv.id)} disabled={busy}>
                  Resolve…
                </button>
                <button type="button" className="btn btn-ghost btn-sm danger" onClick={() => doDismiss(iv.id)} disabled={busy}
                  title="僅適用誤報/非問題事件；external_verification 事件不可 dismiss（MD §6.3）">
                  Dismiss…
                </button>
              </>
            ) : null}
          </div>
        </div>
      ))}

      {list.data && list.data.total > items.length ? (
        <p className="muted">顯示 {items.length} / {list.data.total} — 用篩選縮小範圍。</p>
      ) : null}
    </div>
  );
}

export default Interventions;
