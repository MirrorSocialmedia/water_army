import { useEffect, useState } from 'react';

/**
 * Minimal hash router (dependency-free — keeps the lockfile at the P0 ADR
 * version table; see docs/architecture-decisions.md §7 write-back).
 *
 * P2: supports `:param` segments (e.g. /containers/:id) via matchRoute().
 */
const ROUTES = [
  { path: '/', page: 'dashboard' },
  { path: '/containers', page: 'containers' },
  { path: '/containers/:id', page: 'containers-detail' },
  { path: '/devices', page: 'devices' },
  { path: '/tasks', page: 'tasks' },
  { path: '/tasks/:id', page: 'tasks-detail' },
  { path: '/tasks/:id', page: 'tasks-detail' },
  { path: '/schedules', page: 'schedules' },
  { path: '/settings', page: 'settings' },
];

function currentPath() {
  const hash = window.location.hash.replace(/^#/, '');
  return hash || '/';
}

function matchRoute(pathName) {
  const urlParts = pathName.split('/');
  for (const route of ROUTES) {
    const routeParts = route.path.split('/');
    if (routeParts.length !== urlParts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < routeParts.length; i += 1) {
      if (routeParts[i].startsWith(':')) {
        const value = urlParts[i];
        if (!value) { ok = false; break; }
        params[routeParts[i].slice(1)] = decodeURIComponent(value);
      } else if (routeParts[i] !== urlParts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { page: route.page, params };
  }
  return null;
}

export function useHashRoute() {
  const [pathName, setPathName] = useState(currentPath);
  useEffect(() => {
    const onChange = () => setPathName(currentPath());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const match = matchRoute(pathName);
  return { path: pathName, page: match ? match.page : 'dashboard', params: match ? match.params : {} };
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
