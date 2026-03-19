import { useState, useEffect, useRef } from "react";
import { useApi } from "../hooks/useApi";
import { JsonViewer } from "./JsonViewer";
import {
  normalizeUsaSpendingAwardResponse,
  USA_SPENDING_CONTRACT_CODES,
  USA_SPENDING_DIRECT_FIELDS,
  type UsaSpendingAwardSearchResponse,
} from "../lib/usaspending";

interface LobbyingIssue {
  code: string | null;
  specificIssue: string | null;
}

interface LobbyingLobbyist {
  firstName: string | null;
  lastName: string | null;
  coveredOfficialPosition: string | null;
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
  issues: LobbyingIssue[];
  lobbyists: LobbyingLobbyist[];
}

interface LdaActivity {
  generalIssueAreaCode: string | null;
  specificIssues: string | null;
  lobbyists: LobbyingLobbyist[];
}

interface LdaFilingDetail {
  uuid: string;
  activities: LdaActivity[];
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

interface SymbolLookupResponse {
  query: string;
  count: number;
  bestMatch: {
    symbol: string | null;
    displaySymbol: string | null;
    description: string | null;
    type: string | null;
    score: number;
  } | null;
  candidates: Array<{
    symbol: string | null;
    displaySymbol: string | null;
    description: string | null;
    type: string | null;
    score: number;
  }>;
}

const PAGE_SIZE = 10;
function formatDateInput(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function defaultStartDate(): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 2);
  return formatDateInput(date);
}

function defaultEndDate(): string {
  return formatDateInput(new Date());
}

type CorporateSubTab = "lobbying" | "contracts";

const CORPORATE_SUB_TABS: { id: CorporateSubTab; label: string }[] = [
  { id: "lobbying", label: "Lobbying Filings" },
  { id: "contracts", label: "Gov Contracts" },
];

export function CorporationSearch() {
  const [searchInput, setSearchInput] = useState("");
  const [from, setFrom] = useState(defaultStartDate);
  const [to, setTo] = useState(defaultEndDate);
  const [searchMessage, setSearchMessage] = useState<string | null>(null);
  const [resolvedSymbol, setResolvedSymbol] = useState<string | null>(null);
  const [resolvedCompanyName, setResolvedCompanyName] = useState<string | null>(null);
  const [lobbyingPage, setLobbyingPage] = useState(1);
  const [spendingPage, setSpendingPage] = useState(1);
  const [activeSubTab, setActiveSubTab] = useState<CorporateSubTab>("lobbying");
  const [ldaByUuid, setLdaByUuid] = useState<Map<string, LdaFilingDetail>>(new Map());
  const fetchingUuids = useRef<Set<string>>(new Set());
  const symbolLookup = useApi<SymbolLookupResponse>();
  const lobbying = useApi<LobbyingSearchResponse>();
  const spending = useApi<UsaSpendingAwardSearchResponse>();

  const normalizedSearchInput = searchInput.trim();

  const fetchSpendingData = async (
    symbol: string,
    companyName: string,
    fromDate: string,
    toDate: string
  ) => {
    const spendingParams = new URLSearchParams({
      symbol,
      company: companyName,
      from: fromDate,
      to: toDate,
    });
    const proxied = await spending.fetchData(`/api/usaspending/awards?${spendingParams.toString()}`);
    if (proxied) return;

    try {
      const resp = await fetch("https://api.usaspending.gov/api/v2/search/spending_by_award/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters: {
            recipient_search_text: [companyName],
            time_period: [{ start_date: fromDate, end_date: toDate }],
            award_type_codes: USA_SPENDING_CONTRACT_CODES,
          },
          fields: USA_SPENDING_DIRECT_FIELDS,
          page: 1,
          limit: 100,
          sort: "Base Obligation Date",
          order: "desc",
        }),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        spending.setError(text || `USAspending direct request failed (${resp.status})`);
        return;
      }

      const raw = (await resp.json()) as {
        results?: Array<Record<string, unknown>>;
        page_metadata?: { count?: number };
      };

      spending.setData(
        normalizeUsaSpendingAwardResponse(
          symbol,
          companyName,
          fromDate,
          toDate,
          companyName,
          raw
        )
      );
    } catch (error) {
      spending.setError(error instanceof Error ? error.message : String(error));
    }
  };

  const runSearch = async () => {
    if (!normalizedSearchInput) {
      setSearchMessage("Enter a company name or ticker.");
      return;
    }

    setSearchMessage(null);

    setResolvedCompanyName(null);
    setResolvedSymbol(null);

    const lookupParams = new URLSearchParams({ q: normalizedSearchInput });
    const lookup = await symbolLookup.fetchData(`/api/finnhub/symbol-lookup?${lookupParams.toString()}`);
    const bestMatch = lookup?.bestMatch;

    if (!bestMatch?.symbol) {
      setSearchMessage(`No US ticker match found for "${normalizedSearchInput}".`);
      return;
    }

    const symbol = (bestMatch.displaySymbol ?? bestMatch.symbol).toUpperCase();
    const companyName = bestMatch.description?.trim() || normalizedSearchInput;

    setResolvedCompanyName(companyName);
    setResolvedSymbol(symbol);
    setLobbyingPage(1);
    setSpendingPage(1);

    const lobbyingParams = new URLSearchParams({
      symbol,
      from,
      to,
    });

    void lobbying.fetchData(`/api/finnhub/lobbying?${lobbyingParams.toString()}`);
    void fetchSpendingData(symbol, companyName, from, to);
  };

  const loading =
    symbolLookup.loading ||
    lobbying.loading ||
    spending.loading;
  const hasLobbyingResponse = lobbying.loading || !!lobbying.error || !!lobbying.data;
  const hasSpendingResponse = spending.loading || !!spending.error || !!spending.data;
  const lobbyingResults = lobbying.data?.data ?? [];
  const lobbyingTotalPages = Math.max(1, Math.ceil(lobbyingResults.length / PAGE_SIZE));
  const visibleLobbyingResults = lobbyingResults.slice(
    (lobbyingPage - 1) * PAGE_SIZE,
    lobbyingPage * PAGE_SIZE
  );

  // Fetch Senate LDA details for each visible lobbying filing that has a UUID.
  // Results are cached in ldaByUuid; fetchingUuids prevents duplicate requests.
  useEffect(() => {
    const uuids = visibleLobbyingResults
      .map((r) => r.uuid)
      .filter((uuid): uuid is string => !!uuid && !ldaByUuid.has(uuid) && !fetchingUuids.current.has(uuid));

    if (uuids.length === 0) return;

    uuids.forEach((uuid) => fetchingUuids.current.add(uuid));

    Promise.allSettled(
      uuids.map((uuid) =>
        fetch(`/api/lda/filing?uuid=${encodeURIComponent(uuid)}`)
          .then((r) => (r.ok ? (r.json() as Promise<LdaFilingDetail>) : null))
          .catch(() => null)
      )
    ).then((results) => {
      setLdaByUuid((prev) => {
        const next = new Map(prev);
        results.forEach((result, i) => {
          const uuid = uuids[i];
          if (result.status === "fulfilled" && result.value) {
            next.set(uuid, result.value);
          }
          fetchingUuids.current.delete(uuid);
        });
        return next;
      });
    });
  // visibleLobbyingResults identity changes on every page turn; that's the desired trigger
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleLobbyingResults]);

  const spendingResults = spending.data?.data ?? [];
  const spendingTotalPages = Math.max(1, Math.ceil(spendingResults.length / PAGE_SIZE));
  const visibleSpendingResults = spendingResults.slice(
    (spendingPage - 1) * PAGE_SIZE,
    spendingPage * PAGE_SIZE
  );

  return (
    <div className="space-y-4">
      <div className="card">
        <h2 className="text-sm font-semibold text-vibe-dim uppercase tracking-wider mb-3">
          Corporate Influence
        </h2>

        <div className="space-y-2">
          <input
            type="text"
            className="input w-full"
            placeholder="Company name or ticker (Apple or AAPL)"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void runSearch()}
          />
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="date"
              className="input flex-1"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <input
              type="date"
              className="input flex-1"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
            <button onClick={() => void runSearch()} className="btn btn-primary">
              Search
            </button>
          </div>
        </div>

        <div className="mt-3 space-y-1 text-xs text-vibe-dim">
          <p>
            Enter a company name or ticker. Finnhub resolves the US listing automatically before loading
            lobbying filings and USAspending contract award data.
          </p>
        </div>

        {symbolLookup.data?.bestMatch && (
          <div className="mt-3 rounded bg-vibe-surface px-3 py-2 text-xs text-vibe-dim">
            Resolved to{" "}
            <span className="text-vibe-text">
              {symbolLookup.data.bestMatch.displaySymbol ?? symbolLookup.data.bestMatch.symbol}
            </span>
            {symbolLookup.data.bestMatch.description
              ? ` · ${symbolLookup.data.bestMatch.description}`
              : ""}
          </div>
        )}

        {searchMessage && (
          <div className="mt-3 rounded bg-vibe-cosmic/10 px-3 py-2 text-xs text-vibe-cosmic">
            {searchMessage}
          </div>
        )}
      </div>

      {loading && <LoadingRows />}

      {resolvedSymbol && (hasLobbyingResponse || hasSpendingResponse) && (
        <>
          {/* Sub-tab navigation */}
          <div className="border-b border-vibe-border">
            <div className="flex gap-1">
              {CORPORATE_SUB_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveSubTab(tab.id)}
                  className={`px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px ${
                    activeSubTab === tab.id
                      ? "border-vibe-money text-vibe-money"
                      : "border-transparent text-vibe-dim hover:text-vibe-text"
                  }`}
                >
                  {tab.label}
                  {tab.id === "lobbying" && lobbying.data
                    ? ` (${lobbying.data.count})`
                    : ""}
                  {tab.id === "contracts" && spending.data
                    ? ` (${spending.data.count})`
                    : ""}
                </button>
              ))}
            </div>
          </div>

          {/* Lobbying Filings sub-tab */}
          {activeSubTab === "lobbying" && (
            <section className="space-y-3">
              {lobbying.error && (
                <div className="card border-vibe-nay/30">
                  <p className="text-sm text-vibe-nay">{lobbying.error}</p>
                </div>
              )}

              {lobbying.data && (
                <>
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

                  <PaginationControls
                    page={lobbyingPage}
                    pages={lobbyingTotalPages}
                    onPageChange={setLobbyingPage}
                  />

                  {lobbying.data.data.length === 0 ? (
                    <div className="card">
                      <p className="text-sm text-vibe-dim">
                        No lobbying filings matched this ticker and date range.
                      </p>
                    </div>
                  ) : (
                    visibleLobbyingResults.map((record, index) => (
                      <div
                        key={
                          record.uuid ??
                          [
                            record.symbol,
                            record.year ?? "unknown",
                            record.type ?? "unknown",
                            record.clientId ?? "no-client",
                            record.registrantId ?? "no-registrant",
                            record.dtPosted ?? "no-date",
                            index,
                          ].join("-")
                        }
                        className="card space-y-2"
                      >
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
                            <p className="text-xs text-vibe-dim">income / expenses</p>
                          </div>
                        </div>

                        {/* Senate LDA detail: issue areas + lobbyists */}
                        {record.uuid && (() => {
                          const lda = ldaByUuid.get(record.uuid);
                          if (!lda) {
                            return (
                              <p className="text-xs text-vibe-dim border-t border-vibe-border pt-2">
                                Loading issue areas &amp; lobbyists…
                              </p>
                            );
                          }
                          if (lda.activities.length === 0) return null;
                          return (
                            <div className="border-t border-vibe-border pt-2 space-y-3">
                              {lda.activities.map((activity, ai) => (
                                <div key={ai} className="space-y-1">
                                  {/* Issue area header */}
                                  <div className="flex flex-wrap items-center gap-2">
                                    {activity.generalIssueAreaCode && (
                                      <span className="badge bg-vibe-accent/20 text-vibe-accent">
                                        {activity.generalIssueAreaCode}
                                      </span>
                                    )}
                                    {activity.specificIssues && (
                                      <p className="text-xs text-vibe-text">{activity.specificIssues}</p>
                                    )}
                                  </div>
                                  {/* Lobbyists for this issue area */}
                                  {activity.lobbyists.length > 0 && (
                                    <div className="grid gap-1 sm:grid-cols-2">
                                      {activity.lobbyists.map((lobbyist, li) => {
                                        const fullName = [lobbyist.firstName, lobbyist.lastName]
                                          .filter(Boolean)
                                          .join(" ");
                                        return (
                                          <div key={li} className="rounded bg-vibe-surface px-2 py-1">
                                            <p className="text-xs font-medium text-vibe-text">
                                              {fullName || "Unknown"}
                                            </p>
                                            {lobbyist.coveredOfficialPosition && (
                                              <p className="text-xs text-vibe-dim mt-0.5">
                                                {lobbyist.coveredOfficialPosition}
                                              </p>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                    ))
                  )}

                  <JsonViewer data={lobbying.data} label="Lobbying Response" />
                </>
              )}
            </section>
          )}

          {/* Gov Contracts sub-tab */}
          {activeSubTab === "contracts" && (
            <section className="space-y-3">
              {spending.error && (
                <div className="card border-vibe-nay/30">
                  <p className="text-sm text-vibe-nay">{spending.error}</p>
                </div>
              )}

              {spending.data && (
                <>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    <SummaryStat label="Awards" value={spending.data.count.toLocaleString()} />
                    <SummaryStat
                      label="Total value"
                      value={`$${spending.data.summary.totalValue.toLocaleString(undefined, {
                        maximumFractionDigits: 0,
                      })}`}
                    />
                    <SummaryStat
                      label="Avg award"
                      value={`$${spending.data.summary.averageAwardValue.toLocaleString(undefined, {
                        maximumFractionDigits: 0,
                      })}`}
                    />
                    <SummaryStat
                      label="Top agency"
                      value={spending.data.summary.topAgencyName ?? "N/A"}
                    />
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    <SummaryStat
                      label="Search mode"
                      value="Name search"
                    />
                    <SummaryStat
                      label="Recipient"
                      value={spending.data.recipient.recipientName ?? resolvedCompanyName ?? "N/A"}
                    />
                    <SummaryStat
                      label="Recipient ID"
                      value={spending.data.recipient.recipientId ?? "N/A"}
                    />
                  </div>

                  <PaginationControls
                    page={spendingPage}
                    pages={spendingTotalPages}
                    onPageChange={setSpendingPage}
                  />

                  {spending.data.data.length === 0 ? (
                    <div className="card">
                      <p className="text-sm text-vibe-dim">
                        No recent USAspending awards matched this company and date range.
                      </p>
                    </div>
                  ) : (
                    visibleSpendingResults.map((record, index) => (
                      <div key={`${record.permalink ?? record.actionDate ?? "award"}-${index}`} className="card">
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-medium">
                                {record.recipientName ?? record.recipientParentName ?? record.symbol}
                              </p>
                              {record.awardingAgencyName && (
                                <span className="badge bg-vibe-border text-vibe-text">
                                  {record.awardingAgencyName}
                                </span>
                              )}
                            </div>
                            {record.awardDescription && (
                              <p className="text-xs text-vibe-dim mt-1">{record.awardDescription}</p>
                            )}
                            <p className="text-xs text-vibe-dim mt-1">
                              Action: {record.actionDate ?? "Unknown"}
                              {record.performanceState ? ` · ${record.performanceState}` : ""}
                              {record.performanceCity ? ` · ${record.performanceCity}` : ""}
                              {record.naicsCode ? ` · NAICS ${record.naicsCode}` : ""}
                            </p>
                            {(record.awardId || record.awardType) && (
                              <p className="text-xs text-vibe-dim mt-1">
                                {record.awardId ? `Award ID: ${record.awardId}` : "Award ID: N/A"}
                                {record.awardType ? ` · ${record.awardType}` : ""}
                              </p>
                            )}
                            <p className="text-xs text-vibe-dim mt-1">
                              {record.awardingSubAgencyName ?? "Unknown sub-agency"}
                              {record.awardingOfficeName ? ` · ${record.awardingOfficeName}` : ""}
                            </p>
                            {record.permalink && (
                              <a
                                href={record.permalink}
                                target="_blank"
                                rel="noreferrer"
                                className="text-xs text-vibe-accent hover:underline inline-block mt-2"
                              >
                                View award →
                              </a>
                            )}
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-sm font-bold text-vibe-money">
                              {record.totalValue == null
                                ? "N/A"
                                : `$${record.totalValue.toLocaleString(undefined, {
                                    maximumFractionDigits: 0,
                                  })}`}
                            </p>
                            <p className="text-xs text-vibe-dim">award value</p>
                          </div>
                        </div>
                      </div>
                    ))
                  )}

                  <JsonViewer data={spending.data} label="USASpending Response" />
                </>
              )}
            </section>
          )}
        </>
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
