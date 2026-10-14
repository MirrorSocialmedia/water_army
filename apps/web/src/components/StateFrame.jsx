import { AlertTriangle, Inbox, Loader2 } from 'lucide-react';

/**
 * Universal page state frame — loading / error / empty / success.
 * No page may render hardcoded demo data (施工 MD §0-3); every page funnels
 * real API results through this component.
 */
export function StateFrame({ loading, error, empty, emptyTitle, emptyHint, children }) {
  if (loading) {
    return (
      <div className="state state-loading" role="status">
        <Loader2 size={20} className="spin" />
        <span>Loading…</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="state state-error" role="alert">
        <AlertTriangle size={20} />
        <div>
          <strong>{error.code ?? 'ERROR'}</strong>
          <p>{error.message}</p>
          {error.requestId ? <code>request {error.requestId}</code> : null}
        </div>
      </div>
    );
  }
  if (empty) {
    return (
      <div className="state state-empty">
        <Inbox size={20} />
        <div>
          <strong>{emptyTitle ?? 'No data'}</strong>
          {emptyHint ? <p>{emptyHint}</p> : null}
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
