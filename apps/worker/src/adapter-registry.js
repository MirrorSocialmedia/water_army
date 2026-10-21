/**
 * Batch adapter registry (BR-B2 gen2, MD §9 "adapter registry allowlist").
 *
 * A batch run's work is delegated to a named ADAPTER (the B1 constant
 * `BATCH_ADAPTER_REGISTRY` is the allowlist of adapter NAMES; this module
 * maps names → implementations). Fail-closed (MD §12.3 誠實):
 *
 *   - adapter name unset/null        → ADAPTER_NOT_CONFIGURED (nothing to run)
 *   - name NOT on the allowlist      → ADAPTER_NOT_ALLOWED (never constructed)
 *   - name allowed, no implementation→ ADAPTER_NOT_CONFIGURED
 *
 * No implicit default adapter, no network access here — adapters are the
 * seam where B3 plugs real container drivers. The noop adapter is the
 * Phase-2 workhorse: it burns `durationMs` of wall clock (so the GLOBAL
 * slot cap is the thing under test), reports `{ sideEffects: false }` for
 * MD §6.2 reconciliation, and can be scripted to fail for retry/timeout
 * tests (NOOP_OUTCOME env, test-only).
 */
import { BATCH_ADAPTER_REGISTRY } from '@water-army/shared';

export class AdapterError extends Error {
  constructor(code, message, { status = 500, retryable = false } = {}) {
    super(message);
    this.name = 'AdapterError';
    this.apiCode = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const NOOP_OUTCOMES = new Set(['ok', 'fail', 'fail_retryable']);

function clampInt(raw, min, max, dflt) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
}

/**
 * Abortable sleep: resolves after `ms` unless the signal fires first
 * (cancel / timeout / slot-lost all converge on `abort()`).
 */
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError', reason: signal.abortReason ?? 'aborted' }));
      return;
    }
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(Object.assign(new Error(`aborted: ${signal.abortReason ?? 'aborted'}`), { name: 'AbortError', reason: signal.abortReason ?? 'aborted' }));
    };
    const cleanup = () => {
      clearTimeout(t);
      signal?.removeEventListener?.('abort', onAbort);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * The Phase-2 noop adapter (allowlisted since B1 as `BATCH_ADAPTER_REGISTRY`).
 * Env (test/smoke knobs — production B3 adapters ignore them):
 *   NOOP_DURATION_MS    wall-clock burn per run (default 1500, 50..600000)
 *   NOOP_OUTCOME        'ok' | 'fail' | 'fail_retryable' (default 'ok')
 */
export function createNoopAdapter({ env = process.env } = {}) {
  const durationMs = clampInt(env.NOOP_DURATION_MS, 50, 600_000, 1_500);
  const outcome = NOOP_OUTCOMES.has(env.NOOP_OUTCOME) ? env.NOOP_OUTCOME : 'ok';
  return {
    name: 'noop',
    async run({ signal } = {}) {
      await abortableSleep(durationMs, signal);
      if (outcome === 'fail') {
        throw new AdapterError('ADAPTER_FAILED', 'noop adapter: deterministic failure (NOOP_OUTCOME=fail)', { status: 500 });
      }
      if (outcome === 'fail_retryable') {
        throw new AdapterError('ADAPTER_FAILED_RETRYABLE', 'noop adapter: retryable failure (NOOP_OUTCOME=fail_retryable)', { status: 503, retryable: true });
      }
      return { resultText: `noop ok (${durationMs}ms)`, resultJson: { durationMs, outcome: 'ok' } };
    },
    /** MD §6.2 inspect seam: did this adapter touch the outside world? */
    async inspect() {
      return { sideEffects: false, detail: 'noop: in-memory only' };
    },
  };
}

/**
 * @returns {{
 *   isAllowed: (name?: string) => boolean,
 *   run: (name: string|null|undefined, ctx: object) => Promise<object>,
 *   inspect: (name: string|null|undefined) => Promise<{sideEffects:boolean, detail?:string}>,
 *   allowed: () => string[],
 * }}
 */
export function createAdapterRegistry({ env = process.env, log = console } = {}) {
  // The shared constant is the BASE allowlist (B1 owns it); operators may
  // extend at deploy time (B3 adapters) but never subtract.
  const extra = String(env.BATCH_ADAPTER_ALLOWLIST_EXTRA ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowed = new Set([...BATCH_ADAPTER_REGISTRY, ...extra]);

  const factories = new Map([[ 'noop', () => createNoopAdapter({ env, log }) ]]);
  const instances = new Map();

  function getInstance(name) {
    if (!instances.has(name)) {
      const factory = factories.get(name);
      if (typeof factory !== 'function') return null;
      instances.set(name, factory());
    }
    return instances.get(name) ?? null;
  }

  return {
    allowed: () => [...allowed],
    isAllowed: (name) => typeof name === 'string' && name.length > 0 && allowed.has(name),

    /**
     * Run the named adapter (fail-closed error mapping above).
     * ctx = { runId, attempt, identityId, batchId, signal, deadlineMs, log }
     */
    async run(name, ctx = {}) {
      if (name == null || name === '') {
        throw new AdapterError('ADAPTER_NOT_CONFIGURED', 'no adapter configured for this batch (configJson.adapter is empty)', { status: 409 });
      }
      if (!allowed.has(name)) {
        throw new AdapterError('ADAPTER_NOT_ALLOWED', `adapter '${name}' is not on the allowlist [${[...allowed].join(', ')}] — fail-closed`, { status: 409 });
      }
      const adapter = getInstance(name);
      if (!adapter) {
        throw new AdapterError('ADAPTER_NOT_CONFIGURED', `adapter '${name}' is allowlisted but has no implementation registered`, { status: 409 });
      }
      return adapter.run(ctx);
    },

    /**
     * MD §6.2 side-effect inspection (reconciliation seam). Unknown/absent
     * adapters report sideEffects: true (conservative — the reconciler will
     * ISOLATE rather than auto re-run; honest over clever).
     */
    async inspect(name) {
      if (name != null && name !== '' && allowed.has(name)) {
        const adapter = getInstance(name);
        if (adapter && typeof adapter.inspect === 'function') return adapter.inspect();
        return { sideEffects: true, detail: `adapter '${name}' has no inspect() — assume side effects` };
      }
      return { sideEffects: name == null || name === '' ? false : true, detail: name == null || name === '' ? 'no adapter (nothing ran)' : `unknown adapter '${name}' — assume side effects` };
    },
  };
}
