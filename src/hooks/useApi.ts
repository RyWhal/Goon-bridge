import { useState, useCallback } from "react";

interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

interface FetchOptions {
  force?: boolean;
  ttlMs?: number;
}

type CacheEntry = {
  data: unknown;
  expiresAt: number;
};

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const responseCache = new Map<string, CacheEntry>();
const inflightRequests = new Map<string, Promise<unknown | null>>();

export function useApi<T>() {
  const [state, setState] = useState<ApiState<T>>({
    data: null,
    loading: false,
    error: null,
  });

  const fetchData = useCallback(async (url: string, options?: FetchOptions) => {
    const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    const cached = responseCache.get(url);
    if (!options?.force && cached && cached.expiresAt > Date.now()) {
      const cachedData = cached.data as T;
      setState({ data: cachedData, loading: false, error: null });
      return cachedData;
    }

    setState((current) => ({ data: current.data, loading: true, error: null }));

    const existingRequest = inflightRequests.get(url);
    if (existingRequest && !options?.force) {
      const sharedData = (await existingRequest) as T | null;
      if (sharedData) {
        setState({ data: sharedData, loading: false, error: null });
      } else {
        setState((current) => ({ data: current.data, loading: false, error: current.error }));
      }
      return sharedData;
    }

    const request = (async () => {
      try {
        const resp = await fetch(url);
        if (!resp.ok) {
          // Read body as text first, then try to parse as JSON.
          // This avoids losing the error detail when the body isn't JSON
          // (e.g. Cloudflare HTML error pages).
          const text = await resp.text().catch(() => "");
          let errorMsg = `HTTP ${resp.status}`;
          try {
            const err = JSON.parse(text) as Record<string, unknown>;
            errorMsg =
              (err.error as string) ||
              (err.detail as string) ||
              (err.message as string) ||
              errorMsg;
          } catch {
            // Not JSON — include raw text snippet so we can see what came back
            if (text) {
              const snippet = text.replace(/<[^>]*>/g, " ").trim().slice(0, 200);
              if (snippet) errorMsg += `: ${snippet}`;
            }
          }
          setState((current) => ({ data: current.data, loading: false, error: errorMsg }));
          return null;
        }
        const data = (await resp.json()) as T & { error?: string; detail?: string };

        // The proxy returns 200 even for upstream errors (to prevent
        // Cloudflare from replacing the body with an HTML error page).
        // Detect these by checking for an `error` field.
        if (data && typeof data === "object" && data.error) {
          const errorMessage = data.detail ? `${data.error}: ${data.detail}` : data.error ?? null;
          setState((current) => ({
            data: current.data,
            loading: false,
            error: errorMessage,
          }));
          return null;
        }

        responseCache.set(url, {
          data,
          expiresAt: Date.now() + ttlMs,
        });
        setState({ data, loading: false, error: null });
        return data;
      } catch (e) {
        setState((current) => ({
          data: current.data,
          loading: false,
          error: e instanceof Error ? e.message : "Network error",
        }));
        return null;
      } finally {
        inflightRequests.delete(url);
      }
    })();

    inflightRequests.set(url, request);
    try {
      return (await request) as T | null;
    } catch {
      return null;
    }
  }, []);

  const setData = useCallback((data: T) => {
    setState({ data, loading: false, error: null });
  }, []);

  const setError = useCallback((error: string) => {
    setState({ data: null, loading: false, error });
  }, []);

  const setLoading = useCallback(() => {
    setState({ data: null, loading: true, error: null });
  }, []);

  return { ...state, fetchData, setData, setError, setLoading };
}
