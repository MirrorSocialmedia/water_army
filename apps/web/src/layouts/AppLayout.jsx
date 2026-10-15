import {
  CalendarClock,
  Container,
  LayoutDashboard,
  LogOut,
  Settings,
  Smartphone,
  Workflow,
} from 'lucide-react';
import { NAV_ITEMS, useHashRoute } from '../router';
import { NotificationBell } from '../components/NotificationBell';

const ICONS = {
  dashboard: LayoutDashboard,
  container: Container,
  device: Smartphone,
  tasks: Workflow,
  schedules: CalendarClock,
  settings: Settings,
};

// Detail pages report their parent's title in the topbar.
const PAGE_TITLES = {
  dashboard: 'Dashboard',
  containers: 'Containers',
  'containers-detail': 'Container',
  devices: 'Devices',
  'devices-detail': 'Device',
  tasks: 'Tasks',
  'tasks-detail': 'Task',
  schedules: 'Schedules',
  settings: 'Settings',
};

export function AppLayout({ user, onLogout, children }) {
  const { page, path } = useHashRoute();
  const canMarkRead = user?.role === 'admin' || user?.role === 'operator';
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
          <NotificationBell canMarkRead={canMarkRead} />
        </header>
        <main className="main">{children}</main>
      </div>
    </div>
  );
}

export default AppLayout;
