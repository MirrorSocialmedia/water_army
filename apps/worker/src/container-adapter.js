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
 * unhealthy probe (the API ANSWERED) fails the run RETRYABLE (the container
 * is probably dead or wedged — a fresh attempt re-creates).
 *
 * Probe grace (B6 gen3, E2E run-3: the restart wave's 6 runs all went
 * FAILED_FINAL during a ~5s API rolling restart): a probe that cannot even
 * REACH the API (transport failure) means the device state is UNKNOWN, not
 * dead. Consecutive transport failures are tolerated for up to
 * CONTAINER_ADAPTER_PROBE_GRACE_MS (default 15000ms; 0..600000; 0 = legacy
 * fail-fast) before the hold fails RETRYABLE. Fail-closed is preserved —
 * the grace only bounds the blind window, it never masks an unhealthy
 * ANSWER, and cancel/timeout still abort the hold immediately.
 *
 * Lifecycle timeouts (B6 gen3, E2E run-4: 2/6 broken-image runs ended
 * TOOL_TIMEOUT after the worker-side 15s while the API was still inside its
 * boot-health window): start/stop ride CONTAINER_ADAPTER_LIFECYCLE_TIMEOUT_MS
 * (default 360000ms; 15000..1800000) so a slow boot is filed as the API's
 * honest error (HEALTH_TIMEOUT), not a worker give-up.
 *
 * Window relationship (F-RDFA-3, WA-RDFA-FIX S3): the worker client timeout
 * must be ≥ the API boot-health window (default 300000ms), else a concurrent
 * real MTG boot (>120s measured, p2-43) times out on the worker side first
 * and attempt-2 adoption 304's. Both values come from shared
 * (BATCH_BOOT_HEALTH_WINDOW_MS / BATCH_LIFECYCLE_CLIENT_TIMEOUT_MS) so the
 * relationship is structurally enforced — real MTG cold boot 115–125s,
 * 3-concurrent >120s (docs/audits/realdevice-final/p2/p2-43, p2-48).
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
import { BATCH_LIFECYCLE_CLIENT_TIMEOUT_MS } from '@water-army/shared';
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
  // B6 gen3: start/stop are long-lived (create + engine start + the API's
  // boot-health window, default 300s) — they must not ride the 15s client
  // default (E2E run-4: slow boot misfiled as TOOL_TIMEOUT).
  // F-RDFA-3: default = API window (300s) + 60s margin (360s) — the worker
  // must never abandon the API's wait mid-window (v8 304 double-fail shape).
  const lifecycleTimeoutMs = clampInt(env.CONTAINER_ADAPTER_LIFECYCLE_TIMEOUT_MS, 15_000, 1_800_000, BATCH_LIFECYCLE_CLIENT_TIMEOUT_MS);
  // B6 gen3: bounded grace for consecutive probe TRANSPORT failures inside
  // the hold (control-plane blip ≠ device death). 0 = legacy fail-fast.
  const probeGraceMs = clampInt(env.CONTAINER_ADAPTER_PROBE_GRACE_MS, 0, 600_000, 15_000);

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
      //    Long-lived call: the API runs create + start + boot-health here.
      const started = await api.batchContainersStart(runId, { timeoutMs: lifecycleTimeoutMs }).catch((err) => {
        throw toAdapterError(err, 'container start');
      });
      const containerId = started?.containerId ?? null;
      slog?.info?.({ runId, containerId: String(containerId ?? '').slice(0, 12), hostPort: started?.hostPort, adopted: started?.adopted }, 'container adapter: start ok');

      const bestEffortStop = async (why) => {
        try {
          await api.batchContainersStop(runId, { timeoutMs: lifecycleTimeoutMs });
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
        let unreachableMs = 0; // consecutive probe transport failures (grace)
        const deadline = Date.now() + holdMs;
        while (Date.now() < deadline) {
          const sleepMs = Math.min(healthPollMs, deadline - Date.now());
          await abortableSleep(sleepMs, signal);
          if (Date.now() >= deadline) break;
          let h;
          try {
            h = await api.batchContainersHealth(runId);
            unreachableMs = 0;
          } catch (err) {
            // The grace is ONLY for transport-class failures (the API could
            // not be reached at all — rolling restart, network flap): the
            // device state is then unknown, not dead. An error the API
            // ANSWERED (404 run gone, 409 mismatch, …) keeps its original
            // identity — the engine's policy mapping (4xx permanent, 5xx
            // retryable) applies as designed; no re-judgement here.
            const transportClass = err?.apiCode === 'TOOL_TIMEOUT' || err?.apiCode === 'TOOL_UNAVAILABLE';
            if (!transportClass) throw err;
            // Control-plane blip: a transport failure gets a bounded grace
            // so our own API restart cannot kill healthy in-flight runs.
            // Once the grace is exhausted the failure becomes a retryable
            // adapter error — fail-closed is preserved.
            unreachableMs += healthPollMs;
            if (unreachableMs >= probeGraceMs) {
              throw new AdapterError('CONTAINER_PROBE_UNREACHABLE', `API unreachable for ${unreachableMs}ms during hold (grace ${probeGraceMs}ms) — treating device as unknown (fail-closed)`, { status: 503, retryable: true });
            }
            slog?.warn?.({ runId, unreachableMs, graceMs: probeGraceMs, error: String(err?.message ?? err).slice(0, 200) }, 'container adapter: health probe unreachable — grace window, holding');
            continue;
          }
          healthChecks += 1;
          if (!h?.healthy) {
            // 503: a dead/wedged device is retryable — a fresh attempt
            // sweeps this container and re-creates (S2 sweep path).
            throw new AdapterError('CONTAINER_UNHEALTHY', `container unhealthy during hold (state: ${h?.state ?? 'unknown'})`, { status: 503, retryable: true });
          }
        }

        // 3) success: release the slot (stop keeps the volume — the next
        //    rotation re-mounts the same identity data dir).
        await api.batchContainersStop(runId, { timeoutMs: lifecycleTimeoutMs }).catch((err) => {
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
