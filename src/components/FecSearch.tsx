import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

interface SummaryTopEmployer {
  employer: string;
  donation_count: number;
  total_donation_amount: number;
  largest_single_donation: number | null;
}

interface CandidateContributionSummaryResponse {
  candidate_id: string;
  two_year_period: number;
  summary_pending?: boolean;
  message?: string;
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
  top_employers: {
    top_5: SummaryTopEmployer[];
    top_10: SummaryTopEmployer[];
    top_20: SummaryTopEmployer[];
    selected_top_n: SummaryTopEmployer[];
  };
}

interface LobbyingResult {
  symbol: string;
  name: string | null;
  description: string | null;
  country: string | null;
  uuid: string | null;
  year: number | null;
  period: string | null;
  type: string | null;
  documentUrl: string | null;
  income: number | null;
  expenses: number | null;
  postedName: string | null;
  dtPosted: string | null;
  clientId: string | null;
  registrantId: string | null;
  senateId: string | null;
  houseRegistrantId: string | null;
  chambers: string[];
  chamberLabel: string;
}

interface LobbyingSearchResponse {
  symbol: string;
  from: string;
  to: string;
  count: number;
  summary: {
    senateCount: number;
    houseCount: number;
    dualFiledCount: number;
  };
  data: LobbyingResult[];
}

type SearchMode = "candidates" | "contributions" | "lobbying";
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
const SUMMARY_MIN_REQUEST_GAP_MS = 2500;
const SUMMARY_PENDING_RETRY_DELAY_MS = 3000;
const SUMMARY_PENDING_MAX_RETRIES = 6;

function formatDateInput(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function defaultLobbyingStartDate(): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 2);
  return formatDateInput(date);
}

function defaultLobbyingEndDate(): string {
  return formatDateInput(new Date());
}

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
  const [includeRefunds, setIncludeRefunds] = useState(false);
  const [contributionsSort, setContributionsSort] = useState<DonationSort>("high_to_low");
  const [lobbyingSymbol, setLobbyingSymbol] = useState("");
  const [lobbyingFrom, setLobbyingFrom] = useState(defaultLobbyingStartDate);
  const [lobbyingTo, setLobbyingTo] = useState(defaultLobbyingEndDate);
  const [candidateTopN, setCandidateTopN] = useState<5 | 10 | 20>(10);
  const [selectedCandidate, setSelectedCandidate] = useState<CandidateResult | null>(null);
  const [contributionsPage, setContributionsPage] = useState(1);
  const [contributionsCursors, setContributionsCursors] = useState<Record<number, ContributionCursor | null>>({
    1: null,
  });
  const summaryRequestInFlightRef = useRef(false);
  const summaryLastRequestAtRef = useRef(0);
  const summaryLastAutoRequestKeyRef = useRef("");
  const summaryPendingRetryTimerRef = useRef<number | null>(null);
  const summaryPendingRetryAttemptsRef = useRef<Record<string, number>>({});
  const candidates = useApi<CandidateSearchResponse>();
  const contributions = useApi<ContributionSearchResponse>();
  const candidateSummary = useApi<CandidateContributionSummaryResponse>();
  const lobbying = useApi<LobbyingSearchResponse>();

  const fetchCandidateSummary = useCallback(
    async (
      candidateId: string,
      topN: 5 | 10 | 20,
      options?: { force?: boolean }
    ) => {
      const force = options?.force ?? false;
      const now = Date.now();
      if (!force && summaryRequestInFlightRef.current) return;
      if (!force && now - summaryLastRequestAtRef.current < SUMMARY_MIN_REQUEST_GAP_MS) return;

      summaryRequestInFlightRef.current = true;
      summaryLastRequestAtRef.current = now;
      const params = new URLSearchParams({ top_n: String(topN) });
      try {
        await candidateSummary.fetchData(
          `/api/fec/candidates/${candidateId}/summary?${params.toString()}`
        );
      } finally {
        summaryRequestInFlightRef.current = false;
      }
    },
    [candidateSummary.fetchData]
  );

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
    if (includeRefunds) params.set("include_refunds", "true");
    contributions.fetchData(`/api/fec/contributions?${params.toString()}`);
  };

  const searchContributions = () => {
    setContributionsCursors({ 1: null });
    fetchContributionsPage(1);
  };

  const searchLobbying = () => {
    const symbol = lobbyingSymbol.trim().toUpperCase();
    if (!symbol || !lobbyingFrom || !lobbyingTo) return;

    const params = new URLSearchParams({
      symbol,
      from: lobbyingFrom,
      to: lobbyingTo,
    });
    lobbying.fetchData(`/api/finnhub/lobbying?${params.toString()}`);
  };

  const handleCandidateClick = (c: CandidateResult) => {
    summaryLastAutoRequestKeyRef.current = "";
    summaryPendingRetryAttemptsRef.current = {};
    if (summaryPendingRetryTimerRef.current != null) {
      window.clearTimeout(summaryPendingRetryTimerRef.current);
      summaryPendingRetryTimerRef.current = null;
    }
    setSelectedCandidate(c);
    setCandidateTopN(10);
  };

  useEffect(() => {
    if (!selectedCandidate?.candidate_id) return;
    const requestKey = `${selectedCandidate.candidate_id}:${candidateTopN}`;
    if (summaryLastAutoRequestKeyRef.current === requestKey) return;
    summaryLastAutoRequestKeyRef.current = requestKey;
    void fetchCandidateSummary(selectedCandidate.candidate_id, candidateTopN, { force: true });
  }, [candidateTopN, selectedCandidate?.candidate_id, fetchCandidateSummary]);

  useEffect(() => {
    return () => {
      if (summaryPendingRetryTimerRef.current != null) {
        window.clearTimeout(summaryPendingRetryTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!selectedCandidate?.candidate_id) return;

    const requestKey = `${selectedCandidate.candidate_id}:${candidateTopN}`;
    const isPending = candidateSummary.data?.summary_pending === true;

    if (!isPending) {
      summaryPendingRetryAttemptsRef.current[requestKey] = 0;
      if (summaryPendingRetryTimerRef.current != null) {
        window.clearTimeout(summaryPendingRetryTimerRef.current);
        summaryPendingRetryTimerRef.current = null;
      }
      return;
    }

    const attempts = summaryPendingRetryAttemptsRef.current[requestKey] ?? 0;
    if (attempts >= SUMMARY_PENDING_MAX_RETRIES) return;

    if (summaryPendingRetryTimerRef.current != null) {
      window.clearTimeout(summaryPendingRetryTimerRef.current);
    }

    summaryPendingRetryTimerRef.current = window.setTimeout(() => {
      summaryPendingRetryAttemptsRef.current[requestKey] = attempts + 1;
      void fetchCandidateSummary(selectedCandidate.candidate_id!, candidateTopN);
    }, SUMMARY_PENDING_RETRY_DELAY_MS);

    return () => {
      if (summaryPendingRetryTimerRef.current != null) {
        window.clearTimeout(summaryPendingRetryTimerRef.current);
        summaryPendingRetryTimerRef.current = null;
      }
    };
  }, [
    candidateSummary.data?.summary_pending,
    candidateTopN,
    fetchCandidateSummary,
    selectedCandidate?.candidate_id,
  ]);

  useEffect(() => {
    if (mode !== "contributions") return;
    if (!contributions.data?.results) return;
    setContributionsCursors({ 1: null });
    fetchContributionsPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contributionsSort, includeRefunds]);

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
          <button
            onClick={() => {
              setMode("lobbying");
              setSelectedCandidate(null);
            }}
            className={`btn ${mode === "lobbying" ? "btn-primary" : "btn-ghost"}`}
          >
            Lobbying
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
            <label className="flex items-center gap-2 text-xs text-vibe-dim">
              <input
                type="checkbox"
                checked={includeRefunds}
                onChange={(e) => setIncludeRefunds(e.target.checked)}
              />
              Show refunds and negative adjustments
            </label>
          </div>
        )}

        {mode === "lobbying" && (
          <div className="space-y-2">
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                className="input sm:max-w-[180px]"
                placeholder="Ticker (AAPL)"
                value={lobbyingSymbol}
                onChange={(e) => setLobbyingSymbol(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === "Enter" && searchLobbying()}
              />
              <input
                type="date"
                className="input flex-1"
                value={lobbyingFrom}
                onChange={(e) => setLobbyingFrom(e.target.value)}
              />
              <input
                type="date"
                className="input flex-1"
                value={lobbyingTo}
                onChange={(e) => setLobbyingTo(e.target.value)}
              />
              <button onClick={searchLobbying} className="btn btn-primary">
                Search
              </button>
            </div>
            <p className="text-xs text-vibe-dim">
              Finnhub aggregates Lobbying Disclosure Act filings keyed by company ticker.
            </p>
          </div>
        )}

        <p className="text-xs text-vibe-dim mt-2">
          Source: {mode === "lobbying"
            ? "Finnhub lobbying data, sourced from public House and Senate disclosure records."
            : "OpenFEC (Federal Election Commission). All data is public record."}
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

            {candidateSummary.data?.summary_pending && (
              <div className="px-3 py-2 bg-vibe-border/40 rounded">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-vibe-dim">
                    {candidateSummary.data.message ??
                      "Summary is being prepared. Use Retry now in a few seconds to refresh."}
                  </p>
                  <button
                    className="btn btn-ghost text-xs py-1"
                    onClick={() => {
                      if (!selectedCandidate?.candidate_id) return;
                      void fetchCandidateSummary(selectedCandidate.candidate_id, candidateTopN, {
                        force: true,
                      });
                    }}
                  >
                    Retry now
                  </button>
                </div>
              </div>
            )}

            {candidateSummary.data && !candidateSummary.data.summary_pending && (
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
                    label="Total donations"
                    value={`$${candidateSummary.data.summary.total_donation_amount.toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    })}`}
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

                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-vibe-dim uppercase tracking-wider">
                      Top employers by total amount
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
                  {(candidateSummary.data.top_employers?.selected_top_n ?? []).map((employer, i) => (
                    <div key={i} className="flex items-start justify-between gap-3 px-3 py-2 bg-vibe-surface rounded">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{employer.employer}</p>
                        <p className="text-xs text-vibe-dim">
                          {employer.donation_count.toLocaleString()} donation(s) · largest single $
                          {employer.largest_single_donation == null
                            ? "N/A"
                            : employer.largest_single_donation.toLocaleString(undefined, {
                                maximumFractionDigits: 2,
                              })}
                        </p>
                      </div>
                      <p className="text-sm font-bold text-vibe-money">
                        ${employer.total_donation_amount.toLocaleString(undefined, {
                          maximumFractionDigits: 2,
                        })}
                      </p>
                    </div>
                  ))}
                  {(candidateSummary.data.top_employers?.selected_top_n?.length ?? 0) === 0 && (
                    <p className="text-xs text-vibe-dim italic">No employer records available.</p>
                  )}
                </div>

                <JsonViewer data={candidateSummary.data} label="Candidate Summary API" />
              </div>
            )}

            {!candidateSummary.loading &&
              !candidateSummary.error &&
              !candidateSummary.data?.summary_pending &&
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

      {mode === "lobbying" && lobbying.loading && <LoadingRows />}
      {mode === "lobbying" && lobbying.error && (
        <div className="card border-vibe-nay/30">
          <p className="text-sm text-vibe-nay">{lobbying.error}</p>
        </div>
      )}
      {mode === "lobbying" && lobbying.data && (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryStat label="Ticker" value={lobbying.data.symbol} />
            <SummaryStat label="Filings" value={lobbying.data.count.toLocaleString()} />
            <SummaryStat
              label="Senate-linked"
              value={lobbying.data.summary.senateCount.toLocaleString()}
            />
            <SummaryStat
              label="House-linked"
              value={lobbying.data.summary.houseCount.toLocaleString()}
            />
          </div>

          <p className="text-xs text-vibe-dim">
            Window: {lobbying.data.from} to {lobbying.data.to} · Dual-filed records:{" "}
            {lobbying.data.summary.dualFiledCount.toLocaleString()}
          </p>

          {lobbying.data.data.length === 0 ? (
            <div className="card">
              <p className="text-sm text-vibe-dim">
                No lobbying filings matched this ticker and date range.
              </p>
            </div>
          ) : (
            lobbying.data.data.map((record) => (
              <div key={record.uuid ?? `${record.symbol}-${record.year}-${record.type}-${record.clientId}`} className="card">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{record.name ?? record.symbol}</p>
                      <span className="badge bg-vibe-border text-vibe-text">
                        {record.chamberLabel}
                      </span>
                      {record.type && (
                        <span className="badge bg-vibe-money/20 text-vibe-money">
                          {record.type}
                        </span>
                      )}
                    </div>
                    {record.description && (
                      <p className="text-xs text-vibe-dim mt-1">{record.description}</p>
                    )}
                    <p className="text-xs text-vibe-dim mt-1">
                      {record.year ?? "Unknown year"}
                      {record.period ? ` · ${record.period.replace(/_/g, " ")}` : ""}
                      {record.country ? ` · ${record.country}` : ""}
                    </p>
                    <p className="text-xs text-vibe-dim mt-1">
                      Senate ID: {record.senateId ?? "N/A"} | House ID: {record.houseRegistrantId ?? "N/A"}
                    </p>
                    {record.documentUrl && (
                      <a
                        href={record.documentUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-vibe-accent hover:underline inline-block mt-2"
                      >
                        View filing →
                      </a>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-vibe-money">
                      {formatLobbyingAmount(record.income, record.expenses)}
                    </p>
                    <p className="text-xs text-vibe-dim">
                      income / expenses
                    </p>
                  </div>
                </div>
              </div>
            ))
          )}

          <JsonViewer data={lobbying.data} label="Full API Response" />
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

function formatLobbyingAmount(income: number | null, expenses: number | null): string {
  const incomeText = income == null ? "-" : `$${income.toLocaleString()}`;
  const expensesText = expenses == null ? "-" : `$${expenses.toLocaleString()}`;
  return `${incomeText} / ${expensesText}`;
}
