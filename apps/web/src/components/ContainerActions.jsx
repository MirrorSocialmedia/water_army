import { navigate } from '../router';
import { actionsForState } from './container-utils';

/**
 * Per-container action buttons (MD §6.2): Inspect / Logs / Stats / Start /
 * Stop / Restart (+Pause/Unpause by state) / Delete (admin).
 * Disabled by state and role; in-flight actions show '…' and are locked
 * against double-clicks.
 */
export function ContainerActions({ item, role, busy, errors, onAction, onDelete, compact }) {
  const acts = actionsForState(item.state);
  const canOperate = role === 'operator' || role === 'admin';
  const link = (tab) => () => navigate(`/containers/${encodeURIComponent(item.id)}${tab ? `?tab=${tab}` : ''}`);
  const btn = (action, label) => (
    <button
      key={action}
      className="btn btn-ghost btn-sm"
      disabled={!canOperate || acts[action] === false || busy[`${item.id}:${action}`] === true}
      title={
        !canOperate
          ? 'Requires operator role'
          : acts[action] === false
            ? `Not applicable in state '${item.state}'`
            : `Send ${action} to the API`
      }
      onClick={() => onAction(item, action)}
    >
      {busy[`${item.id}:${action}`] ? '…' : label}
    </button>
  );
  return (
    <div className={`row-actions${compact ? ' row-actions-compact' : ''}`}>
      <button className="btn btn-ghost btn-sm" title="Open detail (Overview tab)" onClick={link(null)}>Inspect</button>
      <button className="btn btn-ghost btn-sm" title="Open detail (Logs tab)" onClick={link('logs')}>Logs</button>
      <button className="btn btn-ghost btn-sm" title="Open detail (Stats tab)" onClick={link('stats')}>Stats</button>
      {btn('start', 'Start')}
      {btn('stop', 'Stop')}
      {btn('restart', 'Restart')}
      {item.state === 'running' ? btn('pause', 'Pause') : null}
      {item.state === 'paused' ? btn('unpause', 'Unpause') : null}
      {role === 'admin' ? (
        <button
          className="btn btn-ghost btn-sm btn-danger"
          disabled={busy[`${item.id}:delete`] === true}
          title="Admin only — requires typing the container name"
          onClick={() => onDelete(item)}
        >
          {busy[`${item.id}:delete`] ? '…' : 'Delete'}
        </button>
      ) : null}
    </div>
  );
}
