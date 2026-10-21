/**
 * BR-B3 (gen2, S4) — the real batch CONTAINER adapter (MD Phase 3).
 *
 * The worker never touches the Docker socket (MD §4 / threat T1). This
 * adapter drives the container through the API's lifecycle routes with
 * the service token (operator identity):
 *
 *   POST /api/task-runs/:id/containers/start   — create-or-ADOPT (idempotent;
 *                                                the crash-window container of
 *                                                the same run is adopted, never
 *                                                re-created → no double-start),
 *                                                127.0.0.1 port lease, /data
 *                                                bind, ADB health wait
 *   GET  /api/task-runs/:id/containers/health  — app-layer probe (not docker state)
 *   POST /api/task-runs/:id/containers/stop    — reversible: container exits,
 *                                                VOLUME + identity data stay,
 *                                                port lease released
 *
 * Failure semantics are carried by the API's stable error codes (MD §10) —
 * the adapter does NOT re-judge them, it preserves the HTTP status on the
 * AdapterError so the engine's existing policy mapping applies as designed:
 *
 *   404 CONTAINER_OP_FAILED (image not found) → non-retryable → FAILED_FINAL
 *   503 PORT_POOL_EXHAUSTED / PORT_BIND_FAILED / daemon down / health timeout
 *                                             → retryable → RETRY_WAIT (cap → FAILED_FINAL)
 *   409 (state/ownership/mount conflicts)     → non-retryable → FAILED_FINAL
 *                                                (a human + reconcile own these)
 *
 * Hold window: after a healthy start the adapter holds the container for
 * CONTAINER_ADAPTER_HOLD_MS (default 1500ms; 100..3600000) — the batch
 * "work" for B3 is the occupation window itself (rotation); B4/B6 add the
 * in-window work. During the hold the app-layer health is re-probed every
 * CONTAINER_ADAPTER_HEALTH_POLL_MS (default 15000ms; 500..600000); an
 * unhealthy probe fails the run RETRYABLE (the container is probably dead
 * or wedged — a fresh attempt re-creates).
 *
 * Container disposition at run end (all paths keep the VOLUME):
 *   success           → stop (slot freed for the next rotation, data intact)
 *   abort (cancel /
 *     timeout / slot-lost)
 *                     → best-effort stop, AbortError propagates (the engine
 *                       owns the run's terminal state)
 *   adapter failure   → best-effort stop (log-only), error propagates; if the
 *                       stop itself fails the container is LEFT for
 *                       reconcile (fix=true) — never force-removed here
 */
import { AdapterError, abortableSleep } from './adapter-registry.js';

function clampInt(raw, min, max, dflt) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
}

/**
 * @param {object} deps
 * @param {object} deps.api  the worker→API client (createApiClient) — must
 *                           expose batchContainersStart/Health/Stop
 * @param {object} [deps.env]
 * @param {object} [deps.log]
 */
export function createContainerAdapter({ api, env = process.env, log = console } = {}) {
  if (!api?.batchContainersStart || !api?.batchContainersHealth || !api?.batchContainersStop) {
    throw new TypeError('createContainerAdapter: an api client with the batch container methods is required');
  }
  const holdMs = clampInt(env.CONTAINER_ADAPTER_HOLD_MS, 100, 3_600_000, 1_500);
  const healthPollMs = clampInt(env.CONTAINER_ADAPTER_HEALTH_POLL_MS, 500, 600_000, 15_000);

  /**
   * The API maps lifecycle errors to HTTP 4xx/5xx with stable codes; the
   * client throws ToolExecutionError{code,message,status}. Re-cast to
   * AdapterError so the engine's policy mapping (retryable 502/503/504 vs
   * permanent 4xx) sees the correct status — no re-judgement here.
   */
  function toAdapterError(err, phase) {
    if (err instanceof AdapterError) return err;
    const status = Number.isInteger(err?.status) ? err.status : (Number.isInteger(err?.statusCode) ? err.statusCode : 500);
    return new AdapterError(err?.apiCode ?? 'ADAPTER_ERROR', `${phase} failed: ${String(err?.message ?? err).slice(0, 500)}`, { status });
  }

  return {
    name: 'container',

    /**
     * @param {{runId:string, attempt?:number, identityId?:string, batchId?:string,
     *          signal:AbortSignal, deadlineMs?:number|null, log?:object}} ctx
     */
    async run({ runId, signal, log: runLog } = {}) {
      const slog = runLog ?? log;

      // 1) start — idempotent adoption; the API is the single source of
      //    ownership truth (labels + DB bind) and it refuses divergent state.
      const started = await api.batchContainersStart(runId).catch((err) => {
        throw toAdapterError(err, 'container start');
      });
      const containerId = started?.containerId ?? null;
      slog?.info?.({ runId, containerId: String(containerId ?? '').slice(0, 12), hostPort: started?.hostPort, adopted: started?.adopted }, 'container adapter: start ok');

      const bestEffortStop = async (why) => {
        try {
          await api.batchContainersStop(runId);
          slog?.info?.({ runId, why }, 'container adapter: container stopped (volume kept)');
        } catch (err) {
          // Never mask the primary error; the reconcile (fix=true) is the
          // backstop for a container that would not stop.
          slog?.warn?.({ runId, why, error: String(err?.message ?? err).slice(0, 200) }, 'container adapter: best-effort stop failed — reconcile owns this container');
        }
      };

      try {
        // 2) hold window with app-layer health re-probes (the probe is the
        //    ADB handshake — the honest "is the device alive" signal).
        let healthChecks = 0;
        const deadline = Date.now() + holdMs;
        while (Date.now() < deadline) {
          const sleepMs = Math.min(healthPollMs, deadline - Date.now());
          await abortableSleep(sleepMs, signal);
          if (Date.now() >= deadline) break;
          const h = await api.batchContainersHealth(runId);
          healthChecks += 1;
          if (!h?.healthy) {
            // 503: a dead/wedged device is retryable — a fresh attempt
            // sweeps this container and re-creates (S2 sweep path).
            throw new AdapterError('CONTAINER_UNHEALTHY', `container unhealthy during hold (state: ${h?.state ?? 'unknown'})`, { status: 503, retryable: true });
          }
        }

        // 3) success: release the slot (stop keeps the volume — the next
        //    rotation re-mounts the same identity data dir).
        await api.batchContainersStop(runId).catch((err) => {
          throw toAdapterError(err, 'container stop');
        });
        return {
          resultText: `container ok (held ${holdMs}ms, ${healthChecks} health checks)`,
          resultJson: { containerId, hostPort: started?.hostPort ?? null, adopted: Boolean(started?.adopted), heldMs: holdMs, healthChecks },
        };
      } catch (err) {
        if (err?.name === 'AbortError') {
          // cancel / hard timeout / slot-lost: the engine owns the run's
          // terminal state; we just do not leak the container + port lease.
          await bestEffortStop(`abort: ${String(err?.reason ?? 'aborted')}`);
          throw err;
        }
        await bestEffortStop(err?.apiCode ?? 'adapter failure');
        throw err instanceof AdapterError ? err : toAdapterError(err, 'container run');
      }
    },

    /** MD §6.2 inspect seam: this adapter touches the outside world. */
    async inspect() {
      return { sideEffects: true, detail: 'container: starts/stops managed redroid containers via the API lifecycle routes (volumes kept)' };
    },
  };
}
