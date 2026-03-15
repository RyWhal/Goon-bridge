import { useEffect } from "react";
import { useApi } from "../hooks/useApi";

interface HealthResponse {
  status: string;
  service: string;
  apis: Record<string, boolean | string>;
  version?: {
    version: string;
    commit: string;
    deployed_at: string;
    version_id: string;
  };
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
    const apiCount = Object.values(data.apis).filter((value) => value === true).length;
    const total = Object.values(data.apis).length;
    const versionLabel = data.version
      ? `${data.version.version}+${data.version.commit.slice(0, 7)}`
      : null;
    return (
      <span
        className="text-xs text-vibe-yea"
        title={[
          data.version
            ? `version: ${data.version.version_id}\ndeployed: ${data.version.deployed_at}`
            : null,
          ...Object.entries(data.apis).map(([k, v]) => `${k}: ${typeof v === "string" ? v : v ? "ready" : "no key"}`),
        ]
          .filter(Boolean)
          .join("\n")}
      >
        {apiCount}/{total} APIs ready{versionLabel ? ` · ${versionLabel}` : ""}
      </span>
    );
  }

  return null;
}
