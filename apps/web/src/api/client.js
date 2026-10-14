/**
 * API client — same-origin fetch with the standard error envelope.
 * Every non-2xx response is normalised to an ApiError carrying the backend's
 * { code, message, requestId } (施工 MD §8).
 */
export class ApiError extends Error {
  constructor({ status, code, message, requestId }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
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
    });
  }
  return payload;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  del: (path) => request(path, { method: 'DELETE' }),
};
