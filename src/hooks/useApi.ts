import { useState, useCallback } from "react";

interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export function useApi<T>() {
  const [state, setState] = useState<ApiState<T>>({
    data: null,
    loading: false,
    error: null,
  });

  const fetchData = useCallback(async (url: string) => {
    setState({ data: null, loading: true, error: null });
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        setState({
          data: null,
          loading: false,
          error: (err as { error?: string }).error ?? `HTTP ${resp.status}`,
        });
        return;
      }
      const data = (await resp.json()) as T;
      setState({ data, loading: false, error: null });
    } catch (e) {
      setState({
        data: null,
        loading: false,
        error: e instanceof Error ? e.message : "Network error",
      });
    }
  }, []);

  return { ...state, fetchData };
}
