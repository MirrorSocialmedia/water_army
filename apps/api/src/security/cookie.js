/**
 * Cookie helpers (dependency-free). Session cookie is HttpOnly + SameSite=Lax
 * (施工 MD §13.2). Secure flag is deployment-driven (SESSION_COOKIE_SECURE).
 */
import { SESSION_COOKIE } from '@water-army/shared';

/** @param {string|undefined} header raw Cookie header @returns {Record<string,string>} */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

/**
 * @param {string} token opaque session token (plaintext — hash lives in DB)
 * @param {{maxAgeSeconds:number, secure?:boolean}} opts
 */
export function serializeSessionCookie(token, { maxAgeSeconds, secure = false }) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
