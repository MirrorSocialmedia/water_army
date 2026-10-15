import { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';

import { api } from '../api/client';
import { useApi } from '../hooks/useApi';

/**
 * Topbar notification bell (P6 flag #3 UI — 施工 MD 尾段「排程執行完成/失敗
 * → UI 通知」).
 *
 *  - unread badge polls /unread-count every 30s (SILENT — no loading flicker)
 *  - panel fetches the 10 most recent when opened (newest first)
 *  - 標記全部已讀 is operator+ only (strict RBAC, matches the API matrix)
 *  - each item deep-links to its run detail (#tasks/:runId)
 *  - no double-submit: the read-all button disables while its call is in
 *    flight (防連點)
 */
const STATUS_PILL = {
  succeeded: 'pill-up',
  failed: 'pill-down',
  timed_out: 'pill-down',
  cancelled: 'pill-disabled',
  skipped: 'pill-disabled',
};

export function NotificationBell({ canMarkRead }) {
  const [open, setOpen] = useState(false);
  const [marking, setMarking] = useState(false);
  const boxRef = useRef(null);

  const count = useApi(() => api.get('/api/schedule-notifications/unread-count'), [], { intervalMs: 30_000 });
  const list = useApi(() => api.get('/api/schedule-notifications?limit=10'), [], { enabled: open });
  const unread = count.data?.count ?? 0;

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const markAll = async () => {
    if (marking || unread === 0) return; // 防連點
    setMarking(true);
    try {
      await api.post('/api/schedule-notifications/read-all');
      await Promise.all([count.reload(), list.reload()]);
    } catch {
      // 403/5xx — leave the panel as-is; the badge keeps polling so a later
      // refresh self-heals. (No alert(): one failure must not take the app down.)
    } finally {
      setMarking(false);
    }
  };

  return (
    <div className="bell" ref={boxRef}>
      <button
        type="button"
        className="bell-btn"
        aria-label={`通知 (${unread} 未讀)`}
        title="排程通知"
        onClick={() => setOpen((v) => !v)}
      >
        <Bell size={16} />
        {unread > 0 && <span className="bell-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="bell-panel card">
          <div className="card-head">
            <strong>排程通知</strong>
            {canMarkRead ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={markAll} disabled={marking || unread === 0}>
                標記全部已讀
              </button>
            ) : (
              <span className="muted" title="viewer 只讀 — 需要 operator 以上權限">只讀</span>
            )}
          </div>
          {list.loading || !list.data ? (
            <p className="muted bell-hint">載入中…</p>
          ) : list.error ? (
            <p className="muted bell-hint">載入失敗 — 重開面板或重新整理頁面。</p>
          ) : list.data.items.length === 0 ? (
            <p className="muted bell-hint">暫無通知 — 排程首次完成/失敗後會出現在這裡。</p>
          ) : (
            <ul className="bell-list">
              {list.data.items.map((n) => (
                <li key={n.id} className={n.isRead ? 'bell-item' : 'bell-item unread'}>
                  <a className="bell-title" href={`#/tasks/${encodeURIComponent(n.runId)}`} onClick={() => setOpen(false)}>
                    <span className={`pill ${STATUS_PILL[n.status] ?? 'pill-disabled'}`}>{n.status}</span>
                    <span className="bell-title-text">{n.title}</span>
                  </a>
                  {n.message ? <div className="muted bell-msg">{n.message}</div> : null}
                  <time className="muted bell-time">{new Date(n.createdAt).toLocaleString()}</time>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default NotificationBell;
