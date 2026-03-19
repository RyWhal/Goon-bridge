import { useState, useCallback, useRef } from "react";
import {
  CONGRESS_JOBS,
  CORRELATION_JOBS,
  getDisclosureAdvancedJobs,
  getDisclosurePrimaryJobs,
  type JobConfig,
} from "../lib/admin-jobs";

interface LogEntry {
  timestamp: string;
  jobId: string;
  jobLabel: string;
  status: "running" | "success" | "error";
  message: string;
  detail?: unknown;
}

function buildUrl(endpoint: string, params: Record<string, string>): string {
  let url = endpoint;

  // Replace URL path params like {symbol} or {bioguideId}
  for (const [key, value] of Object.entries(params)) {
    if (url.includes(`{${key}}`)) {
      url = url.replace(`{${key}}`, encodeURIComponent(value));
    }
  }

  // Remaining params go as query string
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (!endpoint.includes(`{${key}}`) && value) {
      query.set(key, value);
    }
  }

  const qs = query.toString();
  return qs ? `${url}?${qs}` : url;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function JobCard({
  job,
  onRun,
  running,
}: {
  job: JobConfig;
  onRun: (job: JobConfig, params: Record<string, string>) => void;
  running: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({});

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onRun(job, values);
  };

  return (
    <form onSubmit={handleSubmit} className="card p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-vibe-text">{job.label}</h3>
        <p className="text-xs text-vibe-dim mt-0.5">{job.description}</p>
        {job.helperText && <p className="text-[11px] text-vibe-dim/80 mt-1">{job.helperText}</p>}
      </div>

      {job.params && job.params.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {job.params.map((param) => (
            <label key={param.name} className="flex flex-col gap-0.5">
              <span className="text-[10px] uppercase tracking-wider text-vibe-dim">
                {param.label}
                {param.required && <span className="text-vibe-nay">*</span>}
              </span>
              {param.type === "select" ? (
                <select
                  value={values[param.name] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [param.name]: e.target.value }))}
                  required={param.required}
                  className="input text-sm py-1 px-2"
                >
                  <option value="">--</option>
                  {param.options?.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={param.type === "date" ? "date" : param.type === "number" ? "number" : "text"}
                  value={values[param.name] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [param.name]: e.target.value }))}
                  placeholder={param.placeholder}
                  required={param.required}
                  className="input text-sm py-1 px-2 w-36"
                />
              )}
            </label>
          ))}
        </div>
      )}

      <button
        type="submit"
        disabled={running}
        className={`btn text-xs ${running ? "btn-ghost opacity-60 cursor-not-allowed" : "btn-primary"}`}
      >
        {running ? "Running..." : "Run"}
      </button>
    </form>
  );
}

export function AdminPanel() {
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem("admin_api_key") ?? "");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [runningJobs, setRunningJobs] = useState<Set<string>>(new Set());
  const logRef = useRef<HTMLDivElement>(null);
  const primaryDisclosureJobs = getDisclosurePrimaryJobs();
  const advancedDisclosureJobs = getDisclosureAdvancedJobs();

  const appendLog = useCallback((entry: LogEntry) => {
    setLogs((prev) => [...prev, entry]);
    requestAnimationFrame(() => {
      logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
    });
  }, []);

  const runJob = useCallback(
    async (job: JobConfig, params: Record<string, string>) => {
      if (runningJobs.has(job.id)) return;

      setRunningJobs((s) => new Set(s).add(job.id));
      const url = buildUrl(job.endpoint, params);

      appendLog({
        timestamp: formatTime(new Date()),
        jobId: job.id,
        jobLabel: job.label,
        status: "running",
        message: `POST ${url}`,
      });

      try {
        const headers: Record<string, string> = {};
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
        const resp = await fetch(url, { method: "POST", headers });
        const body = await resp.json().catch(() => null);

        if (resp.ok && body && typeof body === "object" && !("error" in body)) {
          appendLog({
            timestamp: formatTime(new Date()),
            jobId: job.id,
            jobLabel: job.label,
            status: "success",
            message: `Completed (${resp.status})`,
            detail: body,
          });
        } else {
          const errorMsg =
            body && typeof body === "object" && "error" in body
              ? String((body as Record<string, unknown>).error)
              : `HTTP ${resp.status}`;
          appendLog({
            timestamp: formatTime(new Date()),
            jobId: job.id,
            jobLabel: job.label,
            status: "error",
            message: errorMsg,
            detail: body,
          });
        }
      } catch (err) {
        appendLog({
          timestamp: formatTime(new Date()),
          jobId: job.id,
          jobLabel: job.label,
          status: "error",
          message: err instanceof Error ? err.message : "Network error",
        });
      } finally {
        setRunningJobs((s) => {
          const next = new Set(s);
          next.delete(job.id);
          return next;
        });
      }
    },
    [runningJobs, appendLog, apiKey],
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-bold text-vibe-text tracking-tight">Admin Panel</h2>
        <p className="text-xs text-vibe-dim mt-1">Batch operations for data ingestion and processing</p>
        <div className="mt-3 flex items-center gap-2">
          <label className="text-[10px] uppercase tracking-wider text-vibe-dim shrink-0">API Key</label>
          <input
            type="password"
            className="input text-sm py-1 px-2 flex-1 max-w-xs"
            placeholder="Enter admin API key"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              sessionStorage.setItem("admin_api_key", e.target.value);
            }}
          />
          {apiKey && <span className="text-[10px] text-vibe-yea">Set</span>}
        </div>
      </div>

      <section className="space-y-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-vibe-dim">Disclosure Imports</h3>
          <p className="mt-1 text-xs text-vibe-dim">
            Use these for normal House and Senate disclosure ingestion. These are the daily-driver actions.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {primaryDisclosureJobs.map((job) => (
            <JobCard key={job.id} job={job} onRun={runJob} running={runningJobs.has(job.id)} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <details className="card">
          <summary className="cursor-pointer list-none select-none">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-vibe-dim">Advanced Disclosure Tools</h3>
              <p className="mt-1 text-xs text-vibe-dim">
                Bulk catch-up and filing-specific repair actions. Use these when standard imports are not enough.
              </p>
            </div>
          </summary>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {advancedDisclosureJobs.map((job) => (
              <JobCard key={job.id} job={job} onRun={runJob} running={runningJobs.has(job.id)} />
            ))}
          </div>
        </details>
      </section>

      {/* Correlation Jobs */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-vibe-dim">Correlations</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {CORRELATION_JOBS.map((job) => (
            <JobCard key={job.id} job={job} onRun={runJob} running={runningJobs.has(job.id)} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-vibe-dim">Congress</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {CONGRESS_JOBS.map((job) => (
            <JobCard key={job.id} job={job} onRun={runJob} running={runningJobs.has(job.id)} />
          ))}
        </div>
      </section>

      {/* Log Output */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-vibe-dim">Log Output</h3>
          {logs.length > 0 && (
            <button
              type="button"
              onClick={() => setLogs([])}
              className="text-[10px] uppercase tracking-wider text-vibe-dim hover:text-vibe-text transition-colors"
            >
              Clear
            </button>
          )}
        </div>
        <div
          ref={logRef}
          className="card bg-vibe-bg border border-vibe-border rounded-lg p-3 h-72 overflow-y-auto font-mono text-xs space-y-1"
        >
          {logs.length === 0 && (
            <p className="text-vibe-dim italic">No output yet. Run a job above.</p>
          )}
          {logs.map((entry, i) => (
            <div key={i}>
              <div className="flex gap-2">
                <span className="text-vibe-dim shrink-0">{entry.timestamp}</span>
                <span
                  className={
                    entry.status === "success"
                      ? "text-vibe-yea"
                      : entry.status === "error"
                        ? "text-vibe-nay"
                        : "text-vibe-accent"
                  }
                >
                  [{entry.status.toUpperCase()}]
                </span>
                <span className="text-vibe-text font-semibold">{entry.jobLabel}</span>
                <span className="text-vibe-dim">{entry.message}</span>
              </div>
              {entry.detail != null && (
                <pre className="ml-16 mt-0.5 text-[11px] text-vibe-dim whitespace-pre-wrap break-all">
                  {JSON.stringify(entry.detail, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
