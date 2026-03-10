import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { JsonViewer } from "./JsonViewer";

interface CandidateResult {
  candidate_id?: string;
  name?: string;
  party_full?: string;
  state?: string;
  office_full?: string;
  election_years?: number[];
  incumbent_challenge_full?: string;
}

interface CandidateSearchResponse {
  results?: CandidateResult[];
  pagination?: { pages?: number; count?: number; page?: number };
}

interface ContributionResult {
  contributor_name?: string;
  contributor_employer?: string;
  contributor_occupation?: string;
  contributor_state?: string;
  contribution_receipt_amount?: number;
  contribution_receipt_date?: string;
  committee?: { name?: string };
}

interface ContributionSearchResponse {
  results?: ContributionResult[];
  pagination?: { pages?: number; count?: number; page?: number };
}

type SearchMode = "candidates" | "contributions";

export function FecSearch() {
  const [mode, setMode] = useState<SearchMode>("candidates");
  const [candidateQuery, setCandidateQuery] = useState("");
  const [employer, setEmployer] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [state, setState] = useState("");
  const candidates = useApi<CandidateSearchResponse>();
  const contributions = useApi<ContributionSearchResponse>();

  const searchCandidates = () => {
    const params = new URLSearchParams({ limit: "20" });
    if (candidateQuery) params.set("q", candidateQuery);
    if (state) params.set("state", state);
    candidates.fetchData(`/api/fec/candidates?${params.toString()}`);
  };

  const searchContributions = () => {
    const params = new URLSearchParams({ limit: "20" });
    if (employer) params.set("employer", employer);
    if (minAmount) params.set("min_amount", minAmount);
    if (state) params.set("state", state);
    contributions.fetchData(`/api/fec/contributions?${params.toString()}`);
  };

  return (
    <div className="space-y-4">
      <div className="card">
        <h2 className="text-sm font-semibold text-vibe-dim uppercase tracking-wider mb-3">
          Federal Election Commission Data
        </h2>

        {/* Mode toggle */}
        <div className="flex gap-2 mb-3">
          <button
            onClick={() => setMode("candidates")}
            className={`btn ${mode === "candidates" ? "btn-primary" : "btn-ghost"}`}
          >
            Candidates
          </button>
          <button
            onClick={() => setMode("contributions")}
            className={`btn ${mode === "contributions" ? "btn-primary" : "btn-ghost"}`}
          >
            Contributions
          </button>
        </div>

        {mode === "candidates" && (
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              className="input flex-1"
              placeholder="Search candidate name..."
              value={candidateQuery}
              onChange={(e) => setCandidateQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && searchCandidates()}
            />
            <input
              type="text"
              className="input w-20"
              placeholder="State"
              maxLength={2}
              value={state}
              onChange={(e) => setState(e.target.value.toUpperCase())}
            />
            <button onClick={searchCandidates} className="btn btn-primary">
              Search
            </button>
          </div>
        )}

        {mode === "contributions" && (
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              className="input flex-1"
              placeholder="Employer name..."
              value={employer}
              onChange={(e) => setEmployer(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && searchContributions()}
            />
            <input
              type="text"
              className="input w-28"
              placeholder="Min $"
              value={minAmount}
              onChange={(e) => setMinAmount(e.target.value)}
            />
            <input
              type="text"
              className="input w-20"
              placeholder="State"
              maxLength={2}
              value={state}
              onChange={(e) => setState(e.target.value.toUpperCase())}
            />
            <button onClick={searchContributions} className="btn btn-primary">
              Search
            </button>
          </div>
        )}

        <p className="text-xs text-vibe-dim mt-2">
          Source: OpenFEC (Federal Election Commission). All data is public record.
        </p>
      </div>

      {/* Candidate results */}
      {mode === "candidates" && candidates.loading && <LoadingRows />}
      {mode === "candidates" && candidates.error && (
        <div className="card border-vibe-nay/30">
          <p className="text-sm text-vibe-nay">{candidates.error}</p>
        </div>
      )}
      {mode === "candidates" && candidates.data?.results && (
        <div className="space-y-2">
          <p className="text-xs text-vibe-dim">
            {candidates.data.pagination?.count ?? candidates.data.results.length}{" "}
            results
          </p>
          {candidates.data.results.map((c, i) => (
            <div key={i} className="card">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">{c.name}</p>
                  <div className="flex items-center gap-2 mt-1 text-xs text-vibe-dim">
                    <span>{c.party_full}</span>
                    <span>{c.state}</span>
                    <span>{c.office_full}</span>
                    {c.incumbent_challenge_full && (
                      <span className="badge bg-vibe-border text-vibe-text">
                        {c.incumbent_challenge_full}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-vibe-dim mt-1">
                    FEC ID: {c.candidate_id}
                    {c.election_years?.length
                      ? ` | Elections: ${c.election_years.slice(-3).join(", ")}`
                      : ""}
                  </p>
                </div>
              </div>
            </div>
          ))}
          <JsonViewer data={candidates.data} label="Full API Response" />
        </div>
      )}

      {/* Contribution results */}
      {mode === "contributions" && contributions.loading && <LoadingRows />}
      {mode === "contributions" && contributions.error && (
        <div className="card border-vibe-nay/30">
          <p className="text-sm text-vibe-nay">{contributions.error}</p>
        </div>
      )}
      {mode === "contributions" && contributions.data?.results && (
        <div className="space-y-2">
          <p className="text-xs text-vibe-dim">
            {contributions.data.pagination?.count ?? contributions.data.results.length}{" "}
            total results
          </p>
          {contributions.data.results.map((c, i) => (
            <div key={i} className="card">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{c.contributor_name}</p>
                  <p className="text-xs text-vibe-dim mt-0.5">
                    {c.contributor_employer}
                    {c.contributor_occupation
                      ? ` | ${c.contributor_occupation}`
                      : ""}
                    {c.contributor_state ? ` | ${c.contributor_state}` : ""}
                  </p>
                  <p className="text-xs text-vibe-dim mt-0.5">
                    To: {c.committee?.name}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-bold text-vibe-money">
                    $
                    {c.contribution_receipt_amount?.toLocaleString() ?? "?"}
                  </p>
                  <p className="text-xs text-vibe-dim">
                    {c.contribution_receipt_date}
                  </p>
                </div>
              </div>
            </div>
          ))}
          <JsonViewer data={contributions.data} label="Full API Response" />
        </div>
      )}
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2">
      {[...Array(3)].map((_, i) => (
        <div key={i} className="card">
          <div className="shimmer h-4 w-48 mb-2" />
          <div className="shimmer h-3 w-32" />
        </div>
      ))}
    </div>
  );
}
