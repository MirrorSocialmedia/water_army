/**
 * ProviderError — classified provider failure (施工 MD §11.7/§11.8).
 *
 * `apiCode` uses the PROVIDER_ERROR vocabulary (or a task-level code such as
 * PROVIDER_NOT_FOUND). RETRYABILITY is decided by RETRYABLE_PROVIDER_ERRORS
 * in task-constants — provider code must never decide retry inline.
 */
import { PROVIDER_ERROR } from './task-constants.js';

export class ProviderError extends Error {
  /**
   * @param {string} code one of PROVIDER_ERROR values (or task-level code)
   * @param {string} message human-safe message (secrets already redacted)
   * @param {{statusCode?: number, cause?: unknown, retryable?: boolean}} [opts]
   */
  constructor(code, message, { statusCode, cause, retryable } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'ProviderError';
    this.apiCode = code;
    this.code = code; // conventional Node error.code — providerErrorToRun() reads this
    this.statusCode = statusCode ?? (code === 'PROVIDER_RATE_LIMITED' ? 429 : code === 'PROVIDER_AUTH' ? 401 : 502);
    if (retryable === undefined) {
      this.retryable =
        code === PROVIDER_ERROR.NETWORK ||
        code === PROVIDER_ERROR.TIMEOUT ||
        code === PROVIDER_ERROR.RATE_LIMITED ||
        code === PROVIDER_ERROR.SERVER;
    } else {
      this.retryable = retryable;
    }
  }
}

export { PROVIDER_ERROR };
