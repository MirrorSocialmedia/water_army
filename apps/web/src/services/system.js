/**
 * WA-UI-SURFACY — system surfaces: providers (masked), the read-only
 * config summary (new GET /api/system/config-summary), task definitions.
 */
import { api } from '../api/client';

export const providers = {
  /** admin only: { providers: [publicProvider] } — keys always masked. */
  list: () => api.get('/api/providers'),
  /** live ping (admin): classified ok/timeout/auth/url_blocked result. */
  test: (name) => api.post(`/api/providers/${encodeURIComponent(name)}/test`),
};

export const systemConfig = {
  /** admin read-only aggregate (redacted): egress / ramGate / registration / sms / fingerprint. */
  summary: () => api.get('/api/system/config-summary'),
};

export const taskDefinitions = {
  /** viewer+: { items[], total } — list + provider binding (no write API yet). */
  list: () => api.get('/api/tasks/definitions'),
};
