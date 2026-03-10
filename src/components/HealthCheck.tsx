import { useEffect } from "react";
import { useApi } from "../hooks/useApi";

interface HealthResponse {
  status: string;
  service: string;
  apis: Record<string, boolean>;
}

export function HealthCheck() {
  const { data, loading, error, fetchData } = useApi<HealthResponse>();

  useEffect(() => {
    fetchData("/api/health");
  }, [fetchData]);

  if (loading) {
    return <span className="text-xs text-vibe-dim">connecting...</span>;
  }

  if (error) {
    return (
      <button
        onClick={() => fetchData("/api/health")}
        className="text-xs text-vibe-nay hover:underline"
        title={error}
      >
        API offline
      </button>
    );
  }

  if (data) {
    const apiCount = Object.values(data.apis).filter(Boolean).length;
    const total = Object.values(data.apis).length;
    return (
      <span
        className="text-xs text-vibe-yea"
        title={Object.entries(data.apis)
          .map(([k, v]) => `${k}: ${v ? "ready" : "no key"}`)
          .join("\n")}
      >
        {apiCount}/{total} APIs ready
      </span>
    );
  }

  return null;
}
