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
  { path: '/devices/:id', page: 'devices-detail' },
  { path: '/devices/:id/console', page: 'devices-console' },
  { path: '/tasks', page: 'tasks' },
  { path: '/tasks/:id', page: 'tasks-detail' },
  { path: '/schedules', page: 'schedules' },
  { path: '/batches', page: 'batches' },
  { path: '/monitor', page: 'monitor' },
  { path: '/identities', page: 'identities' },
  { path: '/identities/:id', page: 'identities-detail' },
  { path: '/reports', page: 'reports' },
  { path: '/ram-gate', page: 'ram-gate' },
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
  { path: '/batches', label: 'Batch Planner', icon: 'batches' },
  { path: '/monitor', label: 'Batch Monitor', icon: 'monitor' },
  { path: '/identities', label: 'Identities', icon: 'identities' },
  { path: '/reports', label: 'Batch Reports', icon: 'reports' },
  { path: '/ram-gate', label: 'RAM Gate', icon: 'ramgate' },
  { path: '/settings', label: 'Settings', icon: 'settings' },
];
