import { useEffect, useMemo, useState } from "react";
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

interface ContributionPagination {
  pages?: number;
  count?: number;
  page?: number;
  last_indexes?: Record<string, string | number>;
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
  pagination?: ContributionPagination;
}

interface SummaryDonationPoint {
  contribution_amount: number;
  contributor_name: string | null;
  contributor_employer: string | null;
  contribution_date: string | null;
  committee_name: string | null;
}

interface SummaryTopDonor {
  donor_name: string;
  donation_count: number;
  total_donation_amount: number;
  largest_single_donation: number;
}

interface CandidateContributionSummaryResponse {
  candidate_id: string;
  two_year_period: number;
  summary: {
    donation_count: number;
    total_donation_amount: number;
    average_donation_amount: number | null;
    mean_donation_amount: number | null;
    median_donation_amount: number | null;
    largest_donation: SummaryDonationPoint | null;
    smallest_donation: SummaryDonationPoint | null;
    highest_donation_by_employer: {
      employer: string;
      contribution_amount: number;
      contributor_name: string | null;
      contribution_date: string | null;
      committee_name: string | null;
    } | null;
  };
  top_donors: {
    top_5: SummaryTopDonor[];
    top_10: SummaryTopDonor[];
    top_20: SummaryTopDonor[];
    selected_top_n: SummaryTopDonor[];
  };
}

type SearchMode = "candidates" | "contributions";
type DonationSort = "high_to_low" | "low_to_high";
type ContributionCursor = Partial<
  Pick<
    Record<string, string>,
    | "last_index"
    | "last_contribution_receipt_amount"
    | "last_contribution_receipt_date"
    | "sort_null_only"
  >
>;

function toApiAmountSort(sort: DonationSort): string {
  return sort === "high_to_low" ? "amount_desc" : "amount_asc";
}

const ELECTION_YEARS = ["2024", "2022", "2020", "2018", "2016"];
const OFFICE_OPTIONS = [
  { value: "", label: "All Offices" },
  { value: "H", label: "House" },
  { value: "S", label: "Senate" },
  { value: "P", label: "President" },
];

const PAGE_SIZE = 20;

function cursorFromLastIndexes(
  lastIndexes?: Record<string, string | number>
): ContributionCursor | null {
  if (!lastIndexes) return null;

  const cursor: ContributionCursor = {};
  if (lastIndexes.last_index != null) cursor.last_index = String(lastIndexes.last_index);
  if (lastIndexes.last_contribution_receipt_amount != null) {
    cursor.last_contribution_receipt_amount = String(lastIndexes.last_contribution_receipt_amount);
  }
  if (lastIndexes.last_contribution_receipt_date != null) {
    cursor.last_contribution_receipt_date = String(lastIndexes.last_contribution_receipt_date);
  }
  if (lastIndexes.sort_null_only != null) cursor.sort_null_only = String(lastIndexes.sort_null_only);

  return Object.keys(cursor).length ? cursor : null;
}

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
  const [contributionsSort, setContributionsSort] = useState<DonationSort>("high_to_low");
  const [candidateTopN, setCandidateTopN] = useState<5 | 10 | 20>(10);
  const [selectedCandidate, setSelectedCandidate] = useState<CandidateResult | null>(null);
  const [contributionsPage, setContributionsPage] = useState(1);
  const [contributionsCursors, setContributionsCursors] = useState<Record<number, ContributionCursor | null>>({
    1: null,
  });
  const candidates = useApi<CandidateSearchResponse>();
  const contributions = useApi<ContributionSearchResponse>();
  const candidateSummary = useApi<CandidateContributionSummaryResponse>();

  const searchCandidates = () => {
    const params = new URLSearchParams({ limit: "20" });
    if (candidateQuery) params.set("q", candidateQuery);
    if (state) params.set("state", state);
    if (electionYear) params.set("election_year", electionYear);
    if (officeFilter) params.set("office", officeFilter);
    candidates.fetchData(`/api/fec/candidates?${params.toString()}`);
    setSelectedCandidate(null);
  };

  const fetchContributionsPage = (page: number) => {
    let cursor = page > 1 ? contributionsCursors[page] ?? null : null;

    // If we're moving forward one page and haven't stored the cursor yet,
    // use the current response's last_indexes directly.
    if (
      !cursor &&
      page > 1 &&
      contributions.data?.pagination?.page === page - 1
    ) {
      cursor = cursorFromLastIndexes(contributions.data.pagination.last_indexes);
    }

    if (page > 1 && !cursor) return;

    setContributionsPage(page);
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      page: String(page),
      sort: toApiAmountSort(contributionsSort),
    });
    if (cursor?.last_index) params.set("last_index", cursor.last_index);
    if (cursor?.last_contribution_receipt_amount) {
      params.set("last_contribution_receipt_amount", cursor.last_contribution_receipt_amount);
    }
    if (cursor?.last_contribution_receipt_date) {
      params.set("last_contribution_receipt_date", cursor.last_contribution_receipt_date);
    }
    if (cursor?.sort_null_only) params.set("sort_null_only", cursor.sort_null_only);
    if (employer) params.set("employer", employer);
    if (contributorName) params.set("contributor_name", contributorName);
    if (minAmount) params.set("min_amount", minAmount);
    if (maxAmount) params.set("max_amount", maxAmount);
    if (state) params.set("state", state);
    contributions.fetchData(`/api/fec/contributions?${params.toString()}`);
  };

  const searchContributions = () => {
    setContributionsCursors({ 1: null });
    fetchContributionsPage(1);
  };

  const handleCandidateClick = (c: CandidateResult) => {
    setSelectedCandidate(c);
    setCandidateTopN(10);
  };

  useEffect(() => {
    if (!selectedCandidate?.candidate_id) return;
    const params = new URLSearchParams({ top_n: String(candidateTopN) });
    candidateSummary.fetchData(
      `/api/fec/candidates/${selectedCandidate.candidate_id}/summary?${params.toString()}`
    );
  }, [candidateTopN, selectedCandidate?.candidate_id]);

  useEffect(() => {
    if (mode !== "contributions") return;
    if (!contributions.data?.results) return;
    setContributionsCursors({ 1: null });
    fetchContributionsPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contributionsSort]);

  useEffect(() => {
    if (mode !== "contributions") return;

    const page = contributions.data?.pagination?.page ?? contributionsPage;
    const nextCursor = cursorFromLastIndexes(contributions.data?.pagination?.last_indexes);
    if (!nextCursor) return;

    setContributionsCursors((prev) => {
      const nextPage = page + 1;
      const existing = prev[nextPage];
      const unchanged =
        existing &&
        existing.last_index === nextCursor.last_index &&
        existing.last_contribution_receipt_amount ===
          nextCursor.last_contribution_receipt_amount &&
        existing.last_contribution_receipt_date ===
          nextCursor.last_contribution_receipt_date &&
        existing.sort_null_only === nextCursor.sort_null_only;
      if (unchanged) return prev;

      return { ...prev, [nextPage]: nextCursor };
    });
  }, [mode, contributions.data?.pagination, contributionsPage]);

  const contributionResults = contributions.data?.results ?? [];
  const contributionsAverage = useMemo(() => {
    if (!contributionResults.length) return null;
    const sum = contributionResults.reduce(
      (acc, row) => acc + (row.contribution_receipt_amount ?? 0),
      0
    );
    return sum / contributionResults.length;
  }, [contributionResults]);

  const contributionsCurrentPage = contributions.data?.pagination?.page ?? contributionsPage;
  const contributionsTotalPages = contributions.data?.pagination?.pages ?? 1;
  const contributionsNextCursor =
    contributionsCursors[contributionsCurrentPage + 1] ??
    cursorFromLastIndexes(contributions.data?.pagination?.last_indexes);
  const contributionsNextDisabled =
    contributionsCurrentPage >= contributionsTotalPages || !contributionsNextCursor;

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
            onClick={() => {
              setMode("contributions");
              setContributionsPage(1);
              setContributionsCursors({ 1: null });
            }}
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
                <span className="text-xs text-vibe-dim shrink-0">View summary →</span>
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
              Contribution summary
            </h4>

            {candidateSummary.loading && <LoadingRows />}

            {candidateSummary.error && (
              <div className="px-3 py-2 bg-vibe-nay/10 rounded">
                <p className="text-xs text-vibe-nay">{candidateSummary.error}</p>
              </div>
            )}

            {candidateSummary.data && (
              <div className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  <SummaryStat
                    label="Donation count"
                    value={candidateSummary.data.summary.donation_count.toLocaleString()}
                  />
                  <SummaryStat
                    label="Largest donation"
                    value={`$${candidateSummary.data.summary.largest_donation?.contribution_amount?.toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    }) ?? "0"}`}
                  />
                  <SummaryStat
                    label="Smallest donation"
                    value={`$${candidateSummary.data.summary.smallest_donation?.contribution_amount?.toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    }) ?? "0"}`}
                  />
                  <SummaryStat
                    label="Average donation"
                    value={`$${candidateSummary.data.summary.average_donation_amount?.toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    }) ?? "0"}`}
                  />
                  <SummaryStat
                    label="Mean donation"
                    value={`$${candidateSummary.data.summary.mean_donation_amount?.toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    }) ?? "0"}`}
                  />
                  <SummaryStat
                    label="Median donation"
                    value={`$${candidateSummary.data.summary.median_donation_amount?.toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    }) ?? "0"}`}
                  />
                </div>

                <div className="px-3 py-2 bg-vibe-surface rounded">
                  <p className="text-xs text-vibe-dim uppercase tracking-wider mb-1">
                    Highest donation by employer
                  </p>
                  {candidateSummary.data.summary.highest_donation_by_employer ? (
                    <p className="text-sm">
                      <span className="text-vibe-money font-semibold">
                        $
                        {candidateSummary.data.summary.highest_donation_by_employer.contribution_amount.toLocaleString()}
                      </span>{" "}
                      from {candidateSummary.data.summary.highest_donation_by_employer.employer}
                      {candidateSummary.data.summary.highest_donation_by_employer.contributor_name
                        ? ` (${candidateSummary.data.summary.highest_donation_by_employer.contributor_name})`
                        : ""}
                    </p>
                  ) : (
                    <p className="text-sm text-vibe-dim">No employer data available.</p>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-vibe-dim uppercase tracking-wider">
                      Top donors by total amount
                    </p>
                    <select
                      className="select text-xs py-1"
                      value={candidateTopN}
                      onChange={(e) => setCandidateTopN(Number(e.target.value) as 5 | 10 | 20)}
                    >
                      <option value={5}>Top 5</option>
                      <option value={10}>Top 10</option>
                      <option value={20}>Top 20</option>
                    </select>
                  </div>
                  {candidateSummary.data.top_donors.selected_top_n.map((donor, i) => (
                    <div key={i} className="flex items-start justify-between gap-3 px-3 py-2 bg-vibe-surface rounded">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{donor.donor_name}</p>
                        <p className="text-xs text-vibe-dim">
                          {donor.donation_count.toLocaleString()} donation(s) · largest single $
                          {donor.largest_single_donation.toLocaleString(undefined, {
                            maximumFractionDigits: 2,
                          })}
                        </p>
                      </div>
                      <p className="text-sm font-bold text-vibe-money">
                        ${donor.total_donation_amount.toLocaleString(undefined, {
                          maximumFractionDigits: 2,
                        })}
                      </p>
                    </div>
                  ))}
                  {candidateSummary.data.top_donors.selected_top_n.length === 0 && (
                    <p className="text-xs text-vibe-dim italic">No donor records available.</p>
                  )}
                </div>

                <JsonViewer data={candidateSummary.data} label="Candidate Summary API" />
              </div>
            )}

            {!candidateSummary.loading &&
              !candidateSummary.error &&
              candidateSummary.data?.summary.donation_count === 0 && (
                <p className="text-xs text-vibe-dim italic">
                  No contribution records found for this candidate in the selected period.
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-vibe-dim">
              {contributions.data.pagination?.count ?? contributions.data.results.length}{" "}
              total results · Avg donation:{" "}
              <span className="text-vibe-money font-medium">
                ${contributionsAverage?.toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                }) ?? "0"}
              </span>
            </p>
            <select
              className="select text-xs py-1"
              value={contributionsSort}
              onChange={(e) => setContributionsSort(e.target.value as DonationSort)}
            >
              <option value="high_to_low">Amount: High → Low</option>
              <option value="low_to_high">Amount: Low → High</option>
            </select>
          </div>
          <PaginationControls
            page={contributionsCurrentPage}
            pages={contributionsTotalPages}
            onPageChange={fetchContributionsPage}
            disableNext={contributionsNextDisabled}
          />
          {contributionResults.map((c, i) => (
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

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2 bg-vibe-surface rounded">
      <p className="text-xs text-vibe-dim uppercase tracking-wider">{label}</p>
      <p className="text-sm font-semibold text-vibe-money">{value}</p>
    </div>
  );
}

function PaginationControls({
  page,
  pages,
  onPageChange,
  disableNext,
}: {
  page: number;
  pages: number;
  onPageChange: (page: number) => void;
  disableNext?: boolean;
}) {
  if (!pages || pages <= 1) return null;

  return (
    <div className="flex items-center gap-2">
      <button
        className="btn btn-ghost text-xs"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        ← Prev
      </button>
      <p className="text-xs text-vibe-dim">
        Page {page} of {pages}
      </p>
      <button
        className="btn btn-ghost text-xs"
        disabled={disableNext ?? page >= pages}
        onClick={() => onPageChange(page + 1)}
      >
        Next →
      </button>
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
