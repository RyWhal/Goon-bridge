import { useEffect, useMemo, useState } from "react";
import { useApi } from "../hooks/useApi";
import { resolveMemberImageUrl } from "../lib/congress";

interface CorrelationMemberResponse {
  member?: {
    bioguide_id?: string;
    name?: string;
    direct_order_name?: string | null;
    party?: string | null;
    state?: string | null;
    chamber?: string | null;
    image_url?: string | null;
  };
}

interface CorrelationEvidenceItem {
  type?: string;
  sourceTable?: string;
  sourceRowId?: string;
  daysFromTrade?: number | null;
  committeeName?: string;
  matchedFields?: string[];
  actionDate?: string | null;
  dtPosted?: string | null;
  totalValue?: number | null;
  awardingAgencyName?: string | null;
  awardingSubAgencyName?: string | null;
  awardingOfficeName?: string | null;
  awardDescription?: string | null;
  permalink?: string | null;
  factDate?: string | null;
  details?: Record<string, unknown>;
}

interface CorrelationCase {
  id: number;
  case_type: string;
  summary: string;
  event_date: string | null;
  time_window_days: number | null;
  status: string;
  organization: {
    id: number | null;
    name: string | null;
    ticker: string | null;
  } | null;
  evidence: CorrelationEvidenceItem[];
}

interface CorrelationCasesResponse {
  bioguide_id: string;
  count: number;
  cases: CorrelationCase[];
}

interface RecentCorrelationCase extends CorrelationCase {
  bioguide_id: string;
  member_name: string | null;
}

interface RecentCorrelationCasesResponse {
  count: number;
  cases: RecentCorrelationCase[];
}

function normalizeParty(party?: string | null) {
  const value = (party ?? "").trim().toUpperCase();
  if (value === "D" || value === "DEMOCRAT" || value === "DEMOCRATIC") return "D";
  if (value === "R" || value === "REPUBLICAN") return "R";
  if (value === "I" || value === "INDEPENDENT") return "I";
  return null;
}

function normalizeChamber(chamber?: string | null) {
  const value = (chamber ?? "").trim().toLowerCase();
  if (value.includes("house")) return "House";
  if (value.includes("senate")) return "Senate";
  return null;
}

function formatDate(value?: string | null) {
  if (!value) return "Unknown date";
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatCurrency(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatCaseType(caseType: string) {
  return caseType.replace(/_/g, " ");
}

function formatTransactionType(value?: string | null) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized ? `${normalized[0].toUpperCase()}${normalized.slice(1)}` : null;
}

function getTradeEvidence(evidence: CorrelationEvidenceItem[]) {
  return evidence.find((item) => item.type === "member_trade") ?? null;
}

function countEvidenceByType(evidence: CorrelationEvidenceItem[], type: string) {
  return evidence.filter((item) => item.type === type).length;
}

function buildCaseHeadline(entry: CorrelationCase) {
  const trade = getTradeEvidence(entry.evidence);
  const tradeDetails = trade?.details ?? {};
  const transactionType = formatTransactionType(
    typeof tradeDetails.transactionType === "string" ? tradeDetails.transactionType : null
  );
  const tradeDate = typeof trade?.factDate === "string" ? formatDate(trade.factDate) : null;
  return [transactionType, tradeDate].filter((value): value is string => !!value).join(" · ");
}

function buildCaseSubline(entry: CorrelationCase) {
  const trade = getTradeEvidence(entry.evidence);
  const tradeDetails = trade?.details ?? {};
  const amountRange = typeof tradeDetails.amountRange === "string" ? tradeDetails.amountRange : null;
  const contractCount = countEvidenceByType(entry.evidence, "contract_award");
  const lobbyingCount = countEvidenceByType(entry.evidence, "lobbying_filing");
  return [
    amountRange,
    contractCount ? `${contractCount} contract${contractCount === 1 ? "" : "s"}` : null,
    lobbyingCount ? `${lobbyingCount} lobbying filing${lobbyingCount === 1 ? "" : "s"}` : null,
    entry.time_window_days != null ? `${entry.time_window_days} day window` : null,
  ].filter((value): value is string => !!value).join(" · ");
}

function summarizeEvidence(item: CorrelationEvidenceItem) {
  if (item.type === "committee_match") {
    return {
      title: item.committeeName ?? "Committee match",
      detail: item.matchedFields?.length
        ? `Matched on ${item.matchedFields.join(", ")}`
        : "Matched committee evidence",
      link: null as string | null,
    };
  }

  if (item.type === "contract_award") {
    const lines = [
      item.actionDate ? formatDate(item.actionDate) : null,
      item.daysFromTrade != null ? `${item.daysFromTrade} days from trade` : null,
      item.awardingAgencyName,
      item.awardingSubAgencyName,
      item.awardingOfficeName,
      formatCurrency(item.totalValue),
    ].filter((value): value is string => !!value);
    return {
      title: item.awardDescription || "Contract award",
      detail: lines.join(" · "),
      link: item.permalink ?? null,
    };
  }

  if (item.type === "lobbying_filing") {
    return {
      title: "Lobbying filing",
      detail: [
        item.dtPosted ? formatDate(item.dtPosted) : null,
        item.daysFromTrade != null ? `${item.daysFromTrade} days from trade` : null,
        item.sourceRowId,
      ].filter((value): value is string => !!value).join(" · "),
      link: null as string | null,
    };
  }

  if (item.type === "member_trade" || item.type === "member_contribution") {
    const details = item.details ?? {};
    const date = typeof item.factDate === "string" ? item.factDate : null;
    const transactionType = typeof details.transactionType === "string" ? details.transactionType : null;
    const amountRange = typeof details.amountRange === "string" ? details.amountRange : null;
    const amount = typeof details.contributionAmount === "number"
      ? formatCurrency(details.contributionAmount)
      : null;
    const label = item.type === "member_trade" ? "Member trade" : "Member contribution";
    return {
      title: label,
      detail: [
        transactionType,
        date ? formatDate(date) : null,
        amountRange,
        amount,
      ].filter((value): value is string => !!value).join(" · ") || "Direct finance evidence",
      link: null as string | null,
    };
  }

  return {
    title: item.type?.replace(/_/g, " ") ?? "Evidence",
    detail: item.sourceTable ?? "Structured evidence",
    link: null as string | null,
  };
}

function PartyBadge({ party }: { party?: string | null }) {
  const normalized = normalizeParty(party);
  if (normalized === "D") return <span className="badge badge-d">D</span>;
  if (normalized === "R") return <span className="badge badge-r">R</span>;
  if (normalized === "I") return <span className="badge badge-i">I</span>;
  return <span className="badge bg-vibe-border text-vibe-dim">?</span>;
}

export function CorrelationExplorer() {
  const [query, setQuery] = useState("");
  const [selectedBioguideId, setSelectedBioguideId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [expandedCaseIds, setExpandedCaseIds] = useState<number[]>([]);

  const member = useApi<CorrelationMemberResponse>();
  const cases = useApi<CorrelationCasesResponse>();
  const recentCases = useApi<RecentCorrelationCasesResponse>();

  useEffect(() => {
    void recentCases.fetchData("/api/correlation/cases/recent?limit=24");
  }, [recentCases.fetchData]);

  const loadMemberCases = async (bioguideId: string) => {
    setSelectedBioguideId(bioguideId);
    setRefreshError(null);
    setRefreshMessage(null);
    await Promise.all([
      member.fetchData(`/api/correlation/member/${bioguideId}`),
      cases.fetchData(`/api/correlation/member/${bioguideId}/cases`),
    ]);
  };

  const refreshCases = async () => {
    if (!selectedBioguideId) return;
    setRefreshing(true);
    setRefreshError(null);
    setRefreshMessage(null);

    try {
      const response = await fetch(`/api/correlation/refresh/member/${selectedBioguideId}/cases`, {
        method: "POST",
      });
      const payload = await response.json().catch(() => ({} as Record<string, unknown>));
      if (!response.ok || (payload && typeof payload === "object" && "error" in payload)) {
        const errorMessage =
          (typeof payload.error === "string" && payload.error)
          || (typeof payload.detail === "string" && payload.detail)
          || `HTTP ${response.status}`;
        setRefreshError(errorMessage);
        setRefreshing(false);
        return;
      }

      const factCount = typeof payload.factCount === "number" ? payload.factCount : null;
      const caseCount = typeof payload.caseCount === "number" ? payload.caseCount : null;
      setRefreshMessage(
        [
          "Materialized correlations refreshed",
          factCount != null ? `${factCount} facts` : null,
          caseCount != null ? `${caseCount} cases` : null,
        ].filter((value): value is string => !!value).join(" · ")
      );
      await Promise.all([
        cases.fetchData(`/api/correlation/member/${selectedBioguideId}/cases`),
        recentCases.fetchData("/api/correlation/cases/recent?limit=24"),
      ]);
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "Failed to refresh correlations");
    } finally {
      setRefreshing(false);
    }
  };

  const selectedMember = member.data?.member;
  const selectedMemberImageUrl = resolveMemberImageUrl(selectedMember?.image_url);
  const foundMembers = useMemo(() => {
    const byMember = new Map<string, { bioguideId: string; memberName: string; count: number; latestDate: string | null }>();
    for (const entry of recentCases.data?.cases ?? []) {
      const current = byMember.get(entry.bioguide_id);
      if (!current) {
        byMember.set(entry.bioguide_id, {
          bioguideId: entry.bioguide_id,
          memberName: entry.member_name ?? entry.bioguide_id,
          count: 1,
          latestDate: entry.event_date,
        });
        continue;
      }
      current.count += 1;
      if ((entry.event_date ?? "") > (current.latestDate ?? "")) {
        current.latestDate = entry.event_date;
      }
    }
    return [...byMember.values()].sort((left, right) =>
      (right.latestDate ?? "").localeCompare(left.latestDate ?? "") || right.count - left.count
    );
  }, [recentCases.data?.cases]);

  const toggleCaseExpanded = (caseId: number) => {
    setExpandedCaseIds((current) =>
      current.includes(caseId)
        ? current.filter((id) => id !== caseId)
        : [...current, caseId]
    );
  };

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-vibe-dim uppercase tracking-wider">
              Correlation Explorer
            </h2>
            <p className="text-sm text-vibe-dim mt-2 max-w-2xl">
              Pick a member and inspect materialized overlaps where a stock trade lands within 30 days of the same organization's contract or lobbying activity.
            </p>
          </div>
          <span className="badge bg-vibe-accent/20 text-vibe-accent uppercase tracking-wider">
            Phase 2
          </span>
        </div>

        <div className="mt-4">
          <input
            type="text"
            className="input w-full"
            placeholder="Filter found members or organizations..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <p className="text-xs text-vibe-dim mt-3">
          This view reads the materialized Supabase casefeed. Use refresh after you have ingested new trades, contracts, or lobbying activity.
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[360px_minmax(0,1fr)] gap-4">
        <div className="card">
          <div className="flex items-center justify-between gap-3 mb-3">
            <p className="text-xs text-vibe-dim uppercase tracking-wider">Members With Hits</p>
            <p className="text-[11px] text-vibe-dim">
              {`${foundMembers.length} found`}
            </p>
          </div>

          {recentCases.error && <p className="text-sm text-vibe-nay">{recentCases.error}</p>}
          {recentCases.loading && <div className="shimmer h-40 w-full" />}

          {!recentCases.loading && !recentCases.error && (
            <div className="space-y-2 max-h-[680px] overflow-y-auto pr-1">
              {foundMembers
                .filter((entry) => {
                  const normalizedQuery = query.trim().toLowerCase();
                  if (!normalizedQuery) return true;
                  return entry.memberName.toLowerCase().includes(normalizedQuery)
                    || entry.bioguideId.toLowerCase().includes(normalizedQuery)
                    || (recentCases.data?.cases ?? []).some((item) =>
                      item.bioguide_id === entry.bioguideId
                      && (item.organization?.name ?? "").toLowerCase().includes(normalizedQuery)
                    );
                })
                .map((entry) => {
                  const isActive = selectedBioguideId === entry.bioguideId;
                  return (
                    <button
                      key={entry.bioguideId}
                      type="button"
                      onClick={() => void loadMemberCases(entry.bioguideId)}
                      className={`w-full rounded-lg border p-3 text-left transition-colors ${
                        isActive
                          ? "border-vibe-accent/50 bg-vibe-accent/10"
                          : "border-vibe-border bg-vibe-surface/60 hover:border-vibe-accent/30"
                      }`}
                    >
                      <p className="text-sm font-medium">{entry.memberName}</p>
                      <div className="mt-2 flex items-center gap-2">
                        <span className="badge bg-vibe-cosmic/20 text-vibe-cosmic">
                          {entry.count} case{entry.count === 1 ? "" : "s"}
                        </span>
                        <span className="text-xs text-vibe-dim">{formatDate(entry.latestDate)}</span>
                      </div>
                    </button>
                  );
                })}

              {foundMembers.length === 0 && (
                <p className="text-sm text-vibe-dim">No materialized correlations found yet.</p>
              )}
            </div>
          )}
        </div>

        <div className="space-y-4">
          {!selectedBioguideId && (
            <div className="space-y-3">
              <div className="card">
                <p className="text-sm text-vibe-dim">
                  Recent materialized cases across all members. Click any card or member to open the full member casefeed.
                </p>
              </div>

              {!recentCases.loading && !recentCases.error && (recentCases.data?.cases?.length ?? 0) > 0 && (
                <div className="space-y-3">
                  {recentCases.data?.cases.map((entry) => (
                    <button
                      key={`recent:${entry.id}`}
                      type="button"
                      onClick={() => void loadMemberCases(entry.bioguide_id)}
                      className="card w-full border-vibe-accent/20 text-left hover:border-vibe-accent/40"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="badge bg-vibe-cosmic/20 text-vibe-cosmic">
                          {formatCaseType(entry.case_type)}
                        </span>
                        {entry.organization?.ticker && (
                          <span className="badge bg-vibe-money/20 text-vibe-money">
                            {entry.organization.ticker}
                          </span>
                        )}
                        <span className="text-xs text-vibe-dim">{buildCaseHeadline(entry)}</span>
                      </div>
                      <p className="mt-3 text-sm font-medium">
                        {entry.member_name ?? entry.bioguide_id} · {entry.organization?.name ?? "Unknown organization"}
                      </p>
                      <p className="mt-2 text-sm text-vibe-dim">{buildCaseSubline(entry)}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {selectedBioguideId && (
            <>
              <div className="card">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex items-center gap-3">
                    {selectedMemberImageUrl && (
                      <img
                        src={selectedMemberImageUrl}
                        alt=""
                        className="h-14 w-14 rounded-lg bg-vibe-border object-cover"
                      />
                    )}
                    <div>
                      <h3 className="text-lg font-semibold">
                        {selectedMember?.direct_order_name ?? selectedMember?.name ?? selectedBioguideId}
                      </h3>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <PartyBadge party={selectedMember?.party} />
                        {selectedMember?.chamber && (
                          <span className="badge bg-vibe-border text-vibe-dim">
                            {normalizeChamber(selectedMember.chamber) ?? selectedMember.chamber}
                          </span>
                        )}
                        {selectedMember?.state && (
                          <span className="text-sm text-vibe-dim">{selectedMember.state}</span>
                        )}
                        <span className="text-xs text-vibe-dim">{selectedBioguideId}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void refreshCases()}
                      disabled={refreshing}
                      className={`btn ${refreshing ? "btn-ghost opacity-60 cursor-not-allowed" : "btn-primary"}`}
                    >
                      {refreshing ? "Refreshing..." : "Refresh Cases"}
                    </button>
                  </div>
                </div>

                {refreshMessage && <p className="mt-3 text-sm text-vibe-accent">{refreshMessage}</p>}
                {refreshError && <p className="mt-3 text-sm text-vibe-nay">{refreshError}</p>}
              </div>

              {cases.loading && (
                <div className="card">
                  <div className="shimmer h-56 w-full" />
                </div>
              )}

              {cases.error && (
                <div className="card border-vibe-nay/30">
                  <p className="text-sm text-vibe-nay">{cases.error}</p>
                </div>
              )}

              {!cases.loading && !cases.error && (cases.data?.cases?.length ?? 0) === 0 && (
                <div className="card">
                  <p className="text-sm text-vibe-dim">
                    No materialized cases for this member yet. If you have already ingested related trades, contracts, or lobbying activity, try refreshing cases.
                  </p>
                </div>
              )}

              {(cases.data?.cases?.length ?? 0) > 0 && (
                <div className="space-y-3">
                  <div className="card">
                    <p className="text-xs uppercase tracking-wider text-vibe-dim">
                      {cases.data?.count ?? 0} cases
                    </p>
                  </div>

                  {cases.data?.cases.map((entry) => (
                    <article key={entry.id} className="card border-vibe-accent/20">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="badge bg-vibe-cosmic/20 text-vibe-cosmic">
                              {formatCaseType(entry.case_type)}
                            </span>
                            {entry.organization?.ticker && (
                              <span className="badge bg-vibe-money/20 text-vibe-money">
                                {entry.organization.ticker}
                              </span>
                            )}
                            <span className="text-xs text-vibe-dim">{buildCaseHeadline(entry)}</span>
                          </div>
                          <h4 className="mt-3 text-base font-semibold">
                            {entry.organization?.name ?? "Unknown organization"}
                          </h4>
                          <p className="mt-2 text-sm text-vibe-text/90">{buildCaseSubline(entry)}</p>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => toggleCaseExpanded(entry.id)}
                            className="btn btn-ghost"
                          >
                            {expandedCaseIds.includes(entry.id) ? "Less info" : "More info"}
                          </button>
                        </div>
                      </div>

                      {expandedCaseIds.includes(entry.id) && (
                        <div className="mt-4 border-t border-vibe-border/70 pt-4">
                          <p className="text-xs uppercase tracking-wider text-vibe-dim mb-2">
                            Evidence
                          </p>
                          <div className="space-y-2">
                            {entry.evidence.map((evidence, index) => {
                              const summary = summarizeEvidence(evidence);
                              return (
                                <div
                                  key={`${entry.id}:${index}:${summary.title}`}
                                  className="rounded-lg border border-vibe-border/70 bg-vibe-surface/60 p-3"
                                >
                                  <div className="flex items-start justify-between gap-3">
                                    <div>
                                      <p className="text-sm font-medium">{summary.title}</p>
                                      <p className="mt-1 text-xs text-vibe-dim">{summary.detail}</p>
                                    </div>
                                    {summary.link && (
                                      <a
                                        href={summary.link}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-xs text-vibe-accent hover:underline"
                                      >
                                        Source
                                      </a>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
