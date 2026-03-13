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
        setState({ data: null, loading: false, error: errorMsg });
        return null;
      }
      const data = (await resp.json()) as T & { error?: string; detail?: string };

      // The proxy returns 200 even for upstream errors (to prevent
      // Cloudflare from replacing the body with an HTML error page).
      // Detect these by checking for an `error` field.
      if (data && typeof data === "object" && data.error) {
        setState({
          data: null,
          loading: false,
          error: data.detail ? `${data.error}: ${data.detail}` : data.error,
        });
        return null;
      }

      setState({ data, loading: false, error: null });
      return data;
    } catch (e) {
      setState({
        data: null,
        loading: false,
        error: e instanceof Error ? e.message : "Network error",
      });
      return null;
    }
  }, []);

  return { ...state, fetchData };
}
