/**
 * Provider factory (施工 MD §17 Phase 3).
 *
 * `provider: 'mock'` → orchestratable mock (script from AI_MOCK_SCRIPT).
 * Anything else is a provider_configs name (baseUrl/apiKey/model, key
 * decrypted by the caller — see provider-resolver.js).
 */
import { createMockProvider, resolveMockScript, MOCK_BUILTIN_SCRIPTS } from './mock.js';
import { createOpenAICompatibleProvider } from './openai-compatible.js';

export { createMockProvider, resolveMockScript, MOCK_BUILTIN_SCRIPTS } from './mock.js';
export { createOpenAICompatibleProvider } from './openai-compatible.js';

/**
 * @param {object} opts
 * @param {string} [opts.name] 'mock' or a provider_configs name
 * @param {string} [opts.mockScript] AI_MOCK_SCRIPT raw value (mock only)
 * @param {string} [opts.baseUrl] (non-mock)
 * @param {string} [opts.apiKey] (non-mock; caller has already decrypted)
 * @param {string} [opts.model] (non-mock)
 * @param {object} [opts.log]
 */
export function createProvider({ name = 'mock', mockScript, baseUrl, apiKey, model, log } = {}) {
  const n = String(name ?? 'mock').trim();
  if (n === 'mock') {
    return createMockProvider({ scriptName: mockScript, log });
  }
  return createOpenAICompatibleProvider({ baseUrl, apiKey, model, log });
}

export { createProvider as default };
