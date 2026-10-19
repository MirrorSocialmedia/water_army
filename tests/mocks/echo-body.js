/**
 * echo-body.js — DETERMINISTIC echo response body (pure, shared).
 *
 * Used by BOTH sides of the bidirectional payload verification:
 *   - tests/mocks/mock-echo.js        (the server renders it)
 *   - scripts/wa-r2-dataspike.mjs     (the harness predicts it)
 *
 * The device's captured response must byte-for-byte equal
 * buildEchoBody(<what the server logged receiving>), which is what makes
 * the return direction verifiable without trusting any in-transit claim.
 */

export function buildEchoBody({ nonce, method, url, bytes, sha256 }) {
  return [
    'MOCK-ECHO-1',
    `nonce=${nonce ?? '-'}`,
    `method=${method}`,
    `url=${url}`,
    `req_bytes=${bytes}`,
    `req_sha256=${sha256}`,
    '',
  ].join('\n');
}
