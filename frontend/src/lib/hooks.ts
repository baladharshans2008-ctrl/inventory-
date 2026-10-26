import { useCallback, useEffect, useRef, useState } from "react";

interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
}

/**
 * Runs an async loader, exposing loading/error/data and a manual refresh.
 * The loader identity is captured in a ref so callers can pass inline
 * closures without causing an infinite re-fetch loop.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true });
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true }));
    try {
      const data = await loaderRef.current();
      if (mounted.current) setState({ data, error: null, loading: false });
      return data;
    } catch (err) {
      if ((err as Error).name === "AbortError") return null;
      if (mounted.current) setState({ data: null, error: err as Error, loading: false });
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ...state, refresh: run, setData: (data: T) => setState({ data, error: null, loading: false }) };
}

/** Polls an async function on an interval; stops automatically when the tab is hidden. */
export function usePolling<T>(loader: () => Promise<T>, intervalMs: number, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const result = await loaderRef.current();
        if (cancelled) return;
        setData(result);
        setError(null);
        setLastUpdated(new Date());
      } catch (err) {
        if (cancelled) return;
        if ((err as Error).name !== "AbortError") setError(err as Error);
      }
      if (!cancelled) timer = window.setTimeout(tick, intervalMs);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [intervalMs, enabled]);

  return { data, error, lastUpdated };
}

/** Ticks once per second and returns the remaining seconds against a target ISO time. */
export function useCountdown(targetIso: string | null | undefined, onElapsed?: () => void) {
  const [remaining, setRemaining] = useState<number>(() => secondsUntil(targetIso));
  const firedRef = useRef(false);
  const onElapsedRef = useRef(onElapsed);
  onElapsedRef.current = onElapsed;

  useEffect(() => {
    firedRef.current = false;
    setRemaining(secondsUntil(targetIso));
    if (!targetIso) return;

    const id = window.setInterval(() => {
      const next = secondsUntil(targetIso);
      setRemaining(next);
      if (next <= 0 && !firedRef.current) {
        firedRef.current = true;
        onElapsedRef.current?.();
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [targetIso]);

  return remaining;
}

function secondsUntil(targetIso: string | null | undefined): number {
  if (!targetIso) return 0;
  const normalised = /[zZ]|[+-]\d{2}:\d{2}$/.test(targetIso) ? targetIso : `${targetIso}Z`;
  const target = new Date(normalised).getTime();
  if (Number.isNaN(target)) return 0;
  return Math.max(0, Math.round((target - Date.now()) / 1000));
}

/** Debounces a fast-changing value (used by the seat-availability search box). */
export function useDebounced<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/** Copy-to-clipboard with a short-lived "copied" flag. */
export function useCopy(timeoutMs = 1600) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    async (value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), timeoutMs);
        return true;
      } catch {
        return false;
      }
    },
    [timeoutMs],
  );

  return { copied, copy };
}
