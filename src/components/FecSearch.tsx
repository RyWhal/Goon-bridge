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
  total_receipts?: number;
  total_disbursements?: number;
  cash_on_hand_end_period?: number;
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
  candidate_name?: string;
  recipient_name?: string;
}

interface ContributionSearchResponse {
  results?: ContributionResult[];
  pagination?: { pages?: number; count?: number; page?: number };
}

type SearchMode = "candidates" | "contributions";

const ELECTION_YEARS = ["2024", "2022", "2020", "2018", "2016"];
const OFFICE_OPTIONS = [
  { value: "", label: "All Offices" },
  { value: "H", label: "House" },
  { value: "S", label: "Senate" },
  { value: "P", label: "President" },
];

export function FecSearch() {
  const [mode, setMode] = useState<SearchMode>("candidates");
  const [candidateQuery, setCandidateQuery] = useState("");
  const [employer, setEmployer] = useState("");
  const [contributorName, setContributorName] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [state, setState] = useState("");
  const [electionYear, setElectionYear] = useState("");
  const [officeFilter, setOfficeFilter] = useState("");
  const [selectedCandidate, setSelectedCandidate] = useState<CandidateResult | null>(null);
  const candidates = useApi<CandidateSearchResponse>();
  const contributions = useApi<ContributionSearchResponse>();
  const candidateContributions = useApi<ContributionSearchResponse>();

  const searchCandidates = () => {
    const params = new URLSearchParams({ limit: "20" });
    if (candidateQuery) params.set("q", candidateQuery);
    if (state) params.set("state", state);
    if (electionYear) params.set("election_year", electionYear);
    if (officeFilter) params.set("office", officeFilter);
    candidates.fetchData(`/api/fec/candidates?${params.toString()}`);
    setSelectedCandidate(null);
  };

  const searchContributions = () => {
    const params = new URLSearchParams({ limit: "20" });
    if (employer) params.set("employer", employer);
    if (contributorName) params.set("contributor_name", contributorName);
    if (minAmount) params.set("min_amount", minAmount);
    if (maxAmount) params.set("max_amount", maxAmount);
    if (state) params.set("state", state);
    contributions.fetchData(`/api/fec/contributions?${params.toString()}`);
  };

  const handleCandidateClick = (c: CandidateResult) => {
    setSelectedCandidate(c);
    if (c.candidate_id) {
      const params = new URLSearchParams({ limit: "20", candidate_id: c.candidate_id });
      candidateContributions.fetchData(`/api/fec/contributions?${params.toString()}`);
    }
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
            onClick={() => { setMode("candidates"); setSelectedCandidate(null); }}
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
          <div className="space-y-2">
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
            <div className="flex flex-col sm:flex-row gap-2">
              <select
                className="select flex-1"
                value={electionYear}
                onChange={(e) => setElectionYear(e.target.value)}
              >
                <option value="">Any Election Year</option>
                {ELECTION_YEARS.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
              <select
                className="select flex-1"
                value={officeFilter}
                onChange={(e) => setOfficeFilter(e.target.value)}
              >
                {OFFICE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {mode === "contributions" && (
          <div className="space-y-2">
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                className="input flex-1"
                placeholder="Contributor name..."
                value={contributorName}
                onChange={(e) => setContributorName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && searchContributions()}
              />
              <input
                type="text"
                className="input flex-1"
                placeholder="Employer name..."
                value={employer}
                onChange={(e) => setEmployer(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && searchContributions()}
              />
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                className="input flex-1"
                placeholder="Min amount $"
                value={minAmount}
                onChange={(e) => setMinAmount(e.target.value)}
              />
              <input
                type="text"
                className="input flex-1"
                placeholder="Max amount $"
                value={maxAmount}
                onChange={(e) => setMaxAmount(e.target.value)}
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
      {mode === "candidates" && candidates.data?.results && !selectedCandidate && (
        <div className="space-y-2">
          <p className="text-xs text-vibe-dim">
            {candidates.data.pagination?.count ?? candidates.data.results.length}{" "}
            results — click a candidate to see their contributions
          </p>
          {candidates.data.results.map((c, i) => (
            <button
              key={i}
              className="card w-full text-left hover:border-vibe-accent/50 transition-colors"
              onClick={() => handleCandidateClick(c)}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">{c.name}</p>
                  <div className="flex flex-wrap items-center gap-2 mt-1 text-xs text-vibe-dim">
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
                <span className="text-xs text-vibe-dim shrink-0">View contributions →</span>
              </div>
            </button>
          ))}
          <JsonViewer data={candidates.data} label="Full API Response" />
        </div>
      )}

      {/* Candidate contributions drill-down */}
      {mode === "candidates" && selectedCandidate && (
        <div className="space-y-3">
          <div className="card border-vibe-money/30">
            <div className="flex items-start justify-between gap-4 mb-3">
              <div>
                <button
                  onClick={() => setSelectedCandidate(null)}
                  className="text-xs text-vibe-dim hover:text-vibe-text mb-2 block"
                >
                  ← Back to results
                </button>
                <h3 className="text-base font-bold">{selectedCandidate.name}</h3>
                <div className="flex flex-wrap items-center gap-2 mt-1 text-xs text-vibe-dim">
                  <span>{selectedCandidate.party_full}</span>
                  <span>{selectedCandidate.state}</span>
                  <span>{selectedCandidate.office_full}</span>
                </div>
                <p className="text-xs text-vibe-dim mt-1">
                  FEC ID: {selectedCandidate.candidate_id}
                </p>
              </div>
            </div>

            <h4 className="text-sm font-semibold text-vibe-money uppercase tracking-wider mb-2">
              Contributions to this candidate
            </h4>

            {candidateContributions.loading && <LoadingRows />}

            {candidateContributions.error && (
              <div className="px-3 py-2 bg-vibe-nay/10 rounded">
                <p className="text-xs text-vibe-nay">{candidateContributions.error}</p>
              </div>
            )}

            {candidateContributions.data?.results &&
              candidateContributions.data.results.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs text-vibe-dim mb-2">
                    Showing {candidateContributions.data.results.length} of{" "}
                    {candidateContributions.data.pagination?.count ?? "?"}
                  </p>
                  {candidateContributions.data.results.map((c, i) => (
                    <div key={i} className="flex items-start justify-between gap-4 px-3 py-2 bg-vibe-surface rounded">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{c.contributor_name}</p>
                        <p className="text-xs text-vibe-dim truncate">
                          {c.contributor_employer}
                          {c.contributor_occupation
                            ? ` | ${c.contributor_occupation}`
                            : ""}
                          {c.contributor_state ? ` | ${c.contributor_state}` : ""}
                        </p>
                        {c.committee?.name && (
                          <p className="text-xs text-vibe-dim truncate">
                            To: {c.committee.name}
                          </p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-bold text-vibe-money">
                          ${c.contribution_receipt_amount?.toLocaleString() ?? "?"}
                        </p>
                        <p className="text-xs text-vibe-dim">
                          {c.contribution_receipt_date}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

            {!candidateContributions.loading &&
              !candidateContributions.error &&
              candidateContributions.data?.results?.length === 0 && (
                <p className="text-xs text-vibe-dim italic">
                  No individual contributions found for this candidate in the FEC database.
                </p>
              )}
          </div>
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
                  {(c.committee?.name || c.candidate_name || c.recipient_name) && (
                    <p className="text-xs text-vibe-dim mt-0.5">
                      To: {c.committee?.name ?? c.candidate_name ?? c.recipient_name}
                    </p>
                  )}
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
