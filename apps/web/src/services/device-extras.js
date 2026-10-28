/**
 * WA-UI-SURFACY — device-side + fleet service groups (W2 device apps,
 * redroid templates, network dispatch policy). Thin wrappers; honest
 * 503-switch / 403-role frames are the caller's job (surfacy-ui helpers).
 */
import { api } from '../api/client';

const enc = encodeURIComponent;

export const deviceApps = {
  /** pm list packages (viewer+): { device, count, truncated, packages[] }. */
  list: (id, filter) =>
    api.get(`/api/devices/redroid/${enc(id)}/apps${filter ? `?filter=${enc(filter)}` : ''}`),
  /** version/existence (viewer+): { installed, versionCode?, versionName? }. */
  info: (id, pkg) => api.get(`/api/devices/redroid/${enc(id)}/apps/${enc(pkg)}`),
  /** managed-dir APK install (operator+): { fileName: 'x.apk' }. */
  install: (id, fileName) => api.post(`/api/devices/redroid/${enc(id)}/apps/install`, { fileName }),
  /** pm uninstall (operator+). */
  uninstall: (id, pkg) => api.del(`/api/devices/redroid/${enc(id)}/apps/${enc(pkg)}`),
};

export const redroidTemplates = {
  /** fleet template list (viewer+): { templates: [...] } — read-only in UI. */
  list: () => api.get('/api/redroid/templates'),
};

export const networkPolicy = {
  /** EFFECTIVE dispatch policy + AppSetting rows (ADMIN only, read AND write). */
  get: () => api.get('/api/network-policy'),
  /** allowlist zones (admin; null = remove DB row, [] = clear). */
  putAllowlists: (body) => api.put('/api/network-policy/allowlists', body),
  /** task types { ai, adhoc } both required (admin). */
  putTaskTypes: (body) => api.put('/api/network-policy/task-types', body),
};
