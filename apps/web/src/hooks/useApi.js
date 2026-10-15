import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Data-fetching hook with explicit loading / error / data states.
 * Guards against state updates after unmount (cancelled flag).
 *
 * P6: options (third arg, back-compat — existing callers pass only deps):
 *   - { enabled: false }  → skip fetching (loading=false until enabled flips)
 *   - { intervalMs }      → silent background polling (does NOT flip the
 *     loading state — a 30s badge poll must not flicker the UI)
 */
export function useApi(fetcher, deps = [], opts = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(opts.enabled !== false);
  const [tick, setTick] = useState(0); // manual/dep change → shows loading
  const [poll, setPoll] = useState(0); // background tick → silent refresh
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const enabled = opts.enabled !== false;
  const intervalMs = Number(opts.intervalMs ?? 0);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    // First load + explicit reloads show loading; background polls stay silent.
    if (poll === 0) {
      setLoading(true);
      setError(null);
    }
    Promise.resolve()
      .then(() => fetcherRef.current())
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled && poll === 0) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, poll, enabled]);

  useEffect(() => {
    if (!intervalMs || intervalMs < 1000) return undefined;
    const id = setInterval(() => setPoll((p) => p + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  const reload = useCallback(() => {
    setPoll(0); // a manual reload always counts as a real (loading) fetch
    setTick((t) => t + 1);
  }, []);
  return { data, error, loading, reload };
}
