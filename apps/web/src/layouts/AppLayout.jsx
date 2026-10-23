import {
  Activity,
  AlertTriangle,
  CalendarClock,
  Container,
  Cpu,
  FileDown,
  Fingerprint,
  LayoutDashboard,
  ListTree,
  LogOut,
  Settings,
  Smartphone,
  Workflow,
} from 'lucide-react';
import { NAV_ITEMS, useHashRoute } from '../router';
import { NotificationBell } from '../components/NotificationBell';
import { api } from '../api/client';
import { useApi } from '../hooks/useApi';

const ICONS = {
  dashboard: LayoutDashboard,
  container: Container,
  device: Smartphone,
  attention: AlertTriangle,
  tasks: Workflow,
  schedules: CalendarClock,
  batches: ListTree,
  monitor: Activity,
  identities: Fingerprint,
  reports: FileDown,
  ramgate: Cpu,
  settings: Settings,
};

// Detail pages report their parent's title in the topbar.
const PAGE_TITLES = {
  dashboard: 'Dashboard',
  containers: 'Containers',
  'containers-detail': 'Container',
  devices: 'Devices',
  'devices-detail': 'Device',
  'devices-fleet': 'Fleet Console',
  interventions: 'Needs Attention',
  tasks: 'Tasks',
  'tasks-detail': 'Task',
  schedules: 'Schedules',
  batches: 'Batch Planner',
  monitor: 'Batch Monitor',
  identities: 'Identities',
  'identities-detail': 'Identity',
  reports: 'Batch Reports',
  'ram-gate': 'RAM Gate',
  settings: 'Settings',
};

export function AppLayout({ user, onLogout, children }) {
  const { page, path } = useHashRoute();
  const canMarkRead = user?.role === 'admin' || user?.role === 'operator';
  // P4: open human-intervention count (MD §7.1 badge) — open + in_progress
  // only; 30s silent poll, same pattern as the schedule notification bell.
  // A failed poll keeps the last known count (useApi never clobbers data).
  const att = useApi(() => api.get('/api/manual-interventions/needs-attention-count'), [], { intervalMs: 30_000 });
  const attCount = att.data?.count ?? 0;
  // P6 fix: NAV_ITEMS 原本冇 page 欄 — active 高亮從來唔亮。由 path 推 base page
  // （detail 頁跟母項高亮）。
  const basePage = (p) => (p === '/' ? 'dashboard' : p.slice(1));
  const isActive = (item) => {
    const base = basePage(item.path);
    return page === base || page === `${base}-detail` || (item.path !== '/' && path === item.path);
  };
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <strong>Water Army</strong>
          <span className="muted">Docker + AI control</span>
        </div>
        <nav>
          {NAV_ITEMS.map((item) => {
            const Icon = ICONS[item.icon];
            const active = isActive(item);
            return (
              <a key={item.path} href={`#${item.path}`} className={active ? 'nav-link active' : 'nav-link'}>
                <Icon size={16} />
                <span>{item.label}</span>
                {item.path === '/interventions' && attCount > 0 ? (
                  <span className="nav-badge" title={`${attCount} 個需處理的人工介入事件`}>{attCount > 99 ? '99+' : attCount}</span>
                ) : null}
              </a>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="user-chip">
            <span>{user.username}</span>
            <em className={`role role-${user.role}`}>{user.role}</em>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onLogout}>
            <LogOut size={14} />
            Sign out
          </button>
        </div>
      </aside>
      <div className="main-col">
        <header className="topbar">
          <span className="topbar-title">{PAGE_TITLES[page] ?? 'Dashboard'}</span>
          <div className="topbar-actions">
            {/* P4 (MD §7.1): the Needs Attention entry lives in the topbar —
                open count badge + deep link to the event center. */}
            <a
              className={`att-chip ${page === 'interventions' ? 'active' : ''}`}
              href="#/interventions"
              title="需人工處理的事件（open / in progress）"
            >
              <AlertTriangle size={14} />
              <span>Needs Attention</span>
              {attCount > 0 ? <span className="att-badge">{attCount > 99 ? '99+' : attCount}</span> : null}
            </a>
            <NotificationBell canMarkRead={canMarkRead} />
          </div>
        </header>
        <main className="main">{children}</main>
      </div>
    </div>
  );
}

export default AppLayout;
