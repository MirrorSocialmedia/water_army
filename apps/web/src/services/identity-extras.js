/**
 * WA-UI-SURFACY — identity-side service groups (fingerprint W1/W1b,
 * pinned egress W3, account lifecycle T5). Thin wrappers over the api
 * client; zero-secret contract on the API side (bindingView / vault are
 * already masked — never echo proxyUrl/password here).
 */
import { api } from '../api/client';

const enc = encodeURIComponent;

export const fingerprints = {
  /** stored profile (viewer+): { profile: {...}|null }. */
  get: (id) => api.get(`/api/identities/${enc(id)}/fingerprint`),
  /** ensure/regenerate + drift check (admin) — idempotent, 409 on collision. */
  ensure: (id) => api.post(`/api/identities/${enc(id)}/fingerprint`),
  /** fleet-wide pairwise collision audit (admin). */
  collisions: () => api.get('/api/identities/fingerprints/collisions'),
};

export const egress = {
  /** one identity's binding (viewer+): { binding: bindingView|null }. */
  get: (id) => api.get(`/api/identities/${enc(id)}/egress`),
  /** fleet binding list (viewer+): { bindings: [...] }. */
  list: () => api.get('/api/identities/egress'),
  /** create/update (admin, idempotent). proxyUrl never echoed back. */
  put: (id, body) => api.put(`/api/identities/${enc(id)}/egress`, body),
  /** remove (admin) — resets bound devices to fail-closed UNCHECKED. */
  del: (id) => api.del(`/api/identities/${enc(id)}/egress`),
};

export const accountLifecycle = {
  /** lifecycle state + masked vault (viewer+): { account, vault }. */
  get: (id) => api.get(`/api/identities/${enc(id)}/account`),
  /** transition audit, newest first (viewer+). */
  audit: (id, limit = 50) => api.get(`/api/identities/${enc(id)}/account/audit?limit=${limit}`),
  /** manual override (operator+; matrix-checked server-side, 409 on illegal). */
  transition: (id, to, reasonCode) =>
    api.post(`/api/identities/${enc(id)}/account/transition`, { to, ...(reasonCode ? { reasonCode } : {}) }),
  /** one driver provision touch (operator+; 503 GMAIL_PROVISION_DISABLED off). */
  provision: (id) => api.post(`/api/identities/${enc(id)}/account/provision`),
};
