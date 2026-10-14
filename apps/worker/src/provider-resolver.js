/**
 * Provider resolver (worker side) — run.inputJson.provider → provider instance.
 *
 * The BullMQ job payload is deliberately secret-free ({runId, attempt}); the
 * worker resolves the provider from its own DB (provider_configs) and
 * decrypts the key with APP_ENCRYPTION_KEY (compose passes the SAME key to
 * api + worker; it is NOT sent over the queue). PROVIDER_ENCRYPTION_KEY is
 * accepted as a legacy fallback for the worker env only.
 *
 * Provider selection (MD §17 P3: 切換唔需要改 code):
 *   run.inputJson.provider = 'mock'  → mock provider (AI_MOCK_SCRIPT)
 *   run.inputJson.provider = <name>  → provider_configs row (openai-compatible)
 *   (run without provider → mock, with a warning event-free log)
 *
 * Fail-closed: unknown provider name / missing config / undecryptable key →
 * ProviderError → the run fails with a precise error_code (never "silently
 * mock").
 */
import {
  ProviderError,
  PROVIDER_ERROR,
  decryptSecret,
  resolveProviderKey,
} from '@water-army/shared';

import { createProvider } from './providers/index.js';

/**
 * @param {object} opts
 * @param {object} opts.db prisma client (providerConfig model)
 * @param {object} opts.run TaskRun row (inputJson.provider is the source of truth)
 * @param {object} [opts.env] process.env
 * @param {object} [opts.log]
 */
export async function resolveProviderForRun({ db, run, env = process.env, log = console }) {
  const name = run?.inputJson?.provider;
  if (typeof name !== 'string' || name.length === 0) {
    log?.warn?.({ runId: run?.id }, 'run has no provider in inputJson; defaulting to mock');
    return createProvider({ name: 'mock', mockScript: env.AI_MOCK_SCRIPT, log });
  }
  if (name === 'mock') {
    return createProvider({ name: 'mock', mockScript: env.AI_MOCK_SCRIPT, log });
  }

  const pc = await db.providerConfig.findUnique({ where: { name } });
  if (!pc || !pc.isEnabled) {
    throw new ProviderError(
      PROVIDER_ERROR.NOT_CONFIGURED,
      `provider '${name}' is not configured or disabled`,
    );
  }
  let key;
  try {
    key = resolveProviderKey(env.APP_ENCRYPTION_KEY ?? env.PROVIDER_ENCRYPTION_KEY);
  } catch (e) {
    throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, `cannot resolve APP_ENCRYPTION_KEY: ${e.message}`);
  }
  if (!pc.encryptedApiKey) {
    throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, `provider '${name}' has no API key configured`);
  }
  let apiKey;
  try {
    apiKey = decryptSecret(pc.encryptedApiKey, key);
  } catch (e) {
    // Never log the ciphertext — it may be the user's real secret.
    log?.error?.({ provider: name }, 'provider key failed to decrypt (wrong APP_ENCRYPTION_KEY or tampered row)');
    throw new ProviderError(PROVIDER_ERROR.NOT_CONFIGURED, `provider '${name}' key cannot be decrypted`);
  }
  return createProvider({
    name: 'openai-compatible',
    baseUrl: pc.baseUrl,
    apiKey,
    model: pc.modelId,
    requestTimeoutMs: pc.timeoutMs,
    log,
  });
}
