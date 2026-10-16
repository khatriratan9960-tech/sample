import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Fetch once on mount.
 * Returns { data, loading, error, reload }.
 * loading is true ONLY for the first attempt - background retries never
 * flip the page back to a spinner (that was the "stuck on Loading..." bug:
 * every retry set loading=true again, so the UI flickered back to the
 * loader instead of showing data or an error).
 */
export function useApi(fetcher, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const mounted = useRef(true);
  // Read inside the retry loop without re-triggering the effect.
  const errorRef = useRef(null);
  const dataRef = useRef(null);

  errorRef.current = error;
  dataRef.current = data;

  const load = useCallback(async ({ silent = false } = {}) => {
    const isFirst = dataRef.current === null;
    if (isFirst && !silent) setLoading(true);
    try {
      const res = await fetcher();
      if (mounted.current) {
        setData(res);
        setError(null);
      }
    } catch (e) {
      if (mounted.current) setError(e.message || 'Something went wrong');
    } finally {
      if (mounted.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    mounted.current = true;
    load();

    // A brief API restart shouldn't leave the page permanently errored.
    // Retry with a growing delay, stopping as soon as a call succeeds.
    // First retry fires ~1s after mount so a slow first paint (cold start)
    // recovers well inside the 5s budget instead of waiting ~4.5s.
    let attempts = 0;
    let timer;

    const tick = async () => {
      if (!mounted.current) return;
      attempts += 1;
      await new Promise((r) => setTimeout(r, 1000 * attempts));
      if (!mounted.current) return;
      // Silent background retry: never flip back to the full-page loader.
      await load({ silent: true });
        // Keep retrying until we have data - cold starts can take >4s on
      // serverless, so don't give up after just 5 error retries. Retry
      // whenever there's no successful payload yet, up to 12 attempts.
      if (mounted.current && attempts < 12 && (errorRef.current || dataRef.current === null)) {
        timer = setTimeout(tick, 0);
      }
    };

    timer = setTimeout(tick, 1000);

    return () => {
      mounted.current = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  return { data, loading, error, reload: load };
}

/**
 * Poll an endpoint on an interval. Keeps the last good payload on
 * failure so the page never flashes empty (matters if the paid API
 * has an outage at 3am).
 */
export function usePolling(fetcher, intervalMs = 15000, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetcher();
      if (!mounted.current) return;
      setData(res);
      setError(null);
      setLastUpdate(new Date());
    } catch (e) {
      if (!mounted.current) return;
      // Keep previous data; only record the error.
      setError(e.message || 'Poll failed');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    mounted.current = true;
    load();

    // Fast initial polling: every 1s for the first 5 attempts so a cold
    // start (slow first /live-result.php) recovers inside ~5s instead of
    // waiting the full 15s interval. Then back off to intervalMs.
    let fastCount = 0;
    const fastTimer = setInterval(() => {
      if (!mounted.current || fastCount >= 5) {
        clearInterval(fastTimer);
        return;
      }
      fastCount += 1;
      load();
    }, 1000);

    const id = setInterval(load, intervalMs);
    return () => {
      mounted.current = false;
      clearInterval(id);
      clearInterval(fastTimer);
    };
  }, [load, intervalMs]);

  return { data, error, lastUpdate, reload: load };
}
