/**
 * API client — same-origin fetch with the standard error envelope.
 * Every non-2xx response is normalised to an ApiError carrying the backend's
 * { code, message, requestId } (施工 MD §8).
 */
export class ApiError extends Error {
  constructor({ status, code, message, requestId, retryAfterMs = null }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    // NV5b(c): Retry-After (seconds) from 429 responses — the client must
    // honour it (wait out the window instead of dying on the backoff ladder).
    this.retryAfterMs = retryAfterMs;
  }
}

/** Parse a Retry-After header (delay-seconds form; HTTP-date tolerated via Date parse). */
function parseRetryAfterMs(res) {
  const raw = res.headers?.get?.('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

async function request(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Network-level failure (api down / proxy gone) — not a backend error envelope.
    throw new ApiError({
      status: 0,
      code: 'NETWORK_ERROR',
      message: `Cannot reach the API (${err.message})`,
      requestId: null,
    });
  }

  if (res.status === 204) return null;

  let payload = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const errBody = payload?.error;
    throw new ApiError({
      status: res.status,
      code: errBody?.code ?? 'UNKNOWN',
      message: errBody?.message ?? res.statusText,
      requestId: errBody?.requestId ?? null,
      retryAfterMs: parseRetryAfterMs(res),
    });
  }
  return payload;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  del: (path, body) => request(path, { method: 'DELETE', body }),
};
