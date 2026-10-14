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

const ICONS = {
  dashboard: LayoutDashboard,
  container: Container,
  device: Smartphone,
  tasks: Workflow,
  schedules: CalendarClock,
  settings: Settings,
};

export function AppLayout({ user, onLogout, children }) {
  const { page } = useHashRoute();
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
            const active = item.page === page;
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
      <main className="main">{children}</main>
    </div>
  );
}
