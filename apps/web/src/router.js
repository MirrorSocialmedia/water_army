import { useEffect, useState } from 'react';

/**
 * Minimal hash router (dependency-free — keeps the lockfile at the P0 ADR
 * version table; see docs/architecture-decisions.md §7 write-back).
 */
const ROUTES = [
  { path: '/', page: 'dashboard' },
  { path: '/containers', page: 'containers' },
  { path: '/devices', page: 'devices' },
  { path: '/tasks', page: 'tasks' },
  { path: '/schedules', page: 'schedules' },
  { path: '/settings', page: 'settings' },
];

function currentPath() {
  const hash = window.location.hash.replace(/^#/, '');
  return hash || '/';
}

export function useHashRoute() {
  const [pathName, setPathName] = useState(currentPath);
  useEffect(() => {
    const onChange = () => setPathName(currentPath());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const match = ROUTES.find((r) => r.path === pathName);
  return { path: match ? match.path : pathName, page: match ? match.page : 'dashboard' };
}

export function navigate(path) {
  window.location.hash = path;
}

export const NAV_ITEMS = [
  { path: '/', label: 'Dashboard', icon: 'dashboard' },
  { path: '/containers', label: 'Containers', icon: 'container' },
  { path: '/devices', label: 'Devices', icon: 'device' },
  { path: '/tasks', label: 'Tasks', icon: 'tasks' },
  { path: '/schedules', label: 'Schedules', icon: 'schedules' },
  { path: '/settings', label: 'Settings', icon: 'settings' },
];
