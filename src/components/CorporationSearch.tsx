import { useEffect, useMemo, useState } from "react";
import { useApi } from "../hooks/useApi";
import { JsonViewer } from "./JsonViewer";

interface ContributionResult {
  contributor_name?: string;
  contributor_employer?: string;
  contributor_occupation?: string;
  contributor_state?: string;
  contribution_receipt_amount?: number;
  contribution_receipt_date?: string;
  candidate_name?: string;
  recipient_name?: string;
  committee?: { name?: string };
}

interface ContributionSearchResponse {
  results?: ContributionResult[];
  pagination?: {
    pages?: number;
    count?: number;
    page?: number;
    last_indexes?: Record<string, string | number>;
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

interface UsaSpendingResult {
  symbol: string;
  recipientName: string | null;
  recipientParentName: string | null;
  country: string | null;
  totalValue: number | null;
  actionDate: string | null;
  performanceStartDate: string | null;
  performanceEndDate: string | null;
  awardingAgencyName: string | null;
  awardingSubAgencyName: string | null;
  awardingOfficeName: string | null;
  performanceCountry: string | null;
  performanceCity: string | null;
  performanceCounty: string | null;
  performanceState: string | null;
  performanceZipCode: string | null;
  performanceCongressionalDistrict: string | null;
  awardDescription: string | null;
  naicsCode: string | null;
  permalink: string | null;
  awardId?: string | null;
  awardType?: string | null;
}

interface UsaSpendingSearchResponse {
  symbol: string;
  company?: string | null;
  from: string;
  to: string;
  count: number;
  summary: {
    totalValue: number;
    averageAwardValue: number;
    agencyCount: number;
    topAgencyName: string | null;
    topAgencyValue: number | null;
  };
  data: UsaSpendingResult[];
}

type ContributionCursor = Partial<
  Pick<
    Record<string, string>,
    | "last_index"
    | "last_contribution_receipt_amount"
    | "last_contribution_receipt_date"
    | "sort_null_only"
  >
>;

const DONATION_PAGE_SIZE = 10;
const USA_SPENDING_DIRECT_FIELDS = [
  "Award ID",
  "Recipient Name",
  "Award Amount",
  "Base Obligation Date",
  "Start Date",
  "End Date",
  "Awarding Agency",
  "Awarding Sub Agency",
  "Contract Award Type",
  "Description",
  "pop_city_name",
  "pop_state_code",
  "Place of Performance Zip5",
  "naics_code",
  "generated_internal_id",
];
const USA_SPENDING_CONTRACT_CODES = ["A", "B", "C", "D"];

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stripCorporateSuffixes(value: string): string {
  return value
    .replace(/\b(inc|incorporated|corp|corporation|company|co|llc|ltd|limited|plc|holdings|holding|group)\b\.?/gi, "")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildRecipientSearchTerms(companyName: string, symbol: string): string[] {
  return [...new Set([companyName, stripCorporateSuffixes(companyName), symbol].filter(Boolean))];
}

function buildUsaSpendingAwardUrl(generatedInternalId: string | null): string | null {
  if (!generatedInternalId) return null;
  return `https://www.usaspending.gov/award/${encodeURIComponent(generatedInternalId)}`;
}

function normalizeUsaSpendingResponse(
  symbol: string,
  company: string,
  from: string,
  to: string,
  raw: { results?: Array<Record<string, unknown>>; page_metadata?: { count?: number } }
): UsaSpendingSearchResponse {
  const data = Array.isArray(raw.results) ? raw.results : [];
  const records = data
    .map((item) => ({
      symbol,
      recipientName: asTrimmedString(item["Recipient Name"]),
      recipientParentName: null,
      country: null,
      totalValue: asFiniteNumber(item["Award Amount"]),
      actionDate: asTrimmedString(item["Base Obligation Date"]),
      performanceStartDate: asTrimmedString(item["Start Date"]),
      performanceEndDate: asTrimmedString(item["End Date"]),
      awardingAgencyName: asTrimmedString(item["Awarding Agency"]),
      awardingSubAgencyName: asTrimmedString(item["Awarding Sub Agency"]),
      awardingOfficeName: null,
      performanceCountry: null,
      performanceCity: asTrimmedString(item["pop_city_name"]),
      performanceCounty: null,
      performanceState: asTrimmedString(item["pop_state_code"]),
      performanceZipCode: asTrimmedString(item["Place of Performance Zip5"]),
      performanceCongressionalDistrict: null,
      awardDescription: asTrimmedString(item["Description"]),
      naicsCode: asTrimmedString(item["naics_code"]),
      permalink: buildUsaSpendingAwardUrl(asTrimmedString(item["generated_internal_id"])),
      awardId: asTrimmedString(item["Award ID"]),
      awardType: asTrimmedString(item["Contract Award Type"]),
    }))
    .sort((a, b) => {
      const aTime = a.actionDate ? Date.parse(`${a.actionDate}T00:00:00Z`) : 0;
      const bTime = b.actionDate ? Date.parse(`${b.actionDate}T00:00:00Z`) : 0;
      return bTime - aTime;
    });

  const totalValue = records.reduce((sum, item) => sum + (item.totalValue ?? 0), 0);
  const agenciesByValue = new Map<string, number>();
  for (const record of records) {
    const agency = record.awardingAgencyName ?? "Unknown";
    agenciesByValue.set(agency, (agenciesByValue.get(agency) ?? 0) + (record.totalValue ?? 0));
  }
  const topAgencyEntry = [...agenciesByValue.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;

  return {
    symbol,
    company,
    from,
    to,
    count: raw.page_metadata?.count ?? records.length,
    summary: {
      totalValue,
      averageAwardValue: records.length ? totalValue / records.length : 0,
      agencyCount: agenciesByValue.size,
      topAgencyName: topAgencyEntry?.[0] ?? null,
      topAgencyValue: topAgencyEntry?.[1] ?? null,
    },
    data: records,
  };
}

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

export function CorporationSearch() {
  const [searchInput, setSearchInput] = useState("");
  const [from, setFrom] = useState(defaultStartDate);
  const [to, setTo] = useState(defaultEndDate);
  const [searchMessage, setSearchMessage] = useState<string | null>(null);
  const [resolvedSymbol, setResolvedSymbol] = useState<string | null>(null);
  const [resolvedCompanyName, setResolvedCompanyName] = useState<string | null>(null);
  const [donationsPage, setDonationsPage] = useState(1);
  const [donationCursors, setDonationCursors] = useState<Record<number, ContributionCursor | null>>({
    1: null,
  });
  const [lobbyingPage, setLobbyingPage] = useState(1);
  const [spendingPage, setSpendingPage] = useState(1);
  const [sectionsExpanded, setSectionsExpanded] = useState({
    donations: true,
    lobbying: true,
    spending: true,
  });
  const donations = useApi<ContributionSearchResponse>();
  const symbolLookup = useApi<SymbolLookupResponse>();
  const lobbying = useApi<LobbyingSearchResponse>();
  const spending = useApi<UsaSpendingSearchResponse>();

  const normalizedSearchInput = searchInput.trim();

  const fetchSpendingData = async (symbol: string, companyName: string, fromDate: string, toDate: string) => {
    const spendingParams = new URLSearchParams({
      symbol,
      company: companyName,
      from: fromDate,
      to: toDate,
    });

    const proxied = await spending.fetchData(`/api/usaspending/awards?${spendingParams.toString()}`);
    if (proxied) return;

    const recipientSearchText = buildRecipientSearchTerms(companyName, symbol);
    let lastError = spending.error ?? "Failed to fetch from USAspending API";

    for (const term of recipientSearchText) {
      try {
        const resp = await fetch("https://api.usaspending.gov/api/v2/search/spending_by_award/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filters: {
              recipient_search_text: [term],
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
          lastError = text || `USAspending direct request failed (${resp.status})`;
          continue;
        }

        const raw = (await resp.json()) as {
          results?: Array<Record<string, unknown>>;
          page_metadata?: { count?: number };
        };
        spending.setData(normalizeUsaSpendingResponse(symbol, companyName, fromDate, toDate, raw));
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    spending.setError(lastError);
  };

  const fetchDonationsPage = (page: number) => {
    if (!resolvedCompanyName) return;

    let cursor = page > 1 ? donationCursors[page] ?? null : null;

    if (!cursor && page > 1 && donations.data?.pagination?.page === page - 1) {
      cursor = cursorFromLastIndexes(donations.data.pagination.last_indexes);
    }

    if (page > 1 && !cursor) return;

    setDonationsPage(page);
    const params = new URLSearchParams({
      employer: resolvedCompanyName,
      limit: String(DONATION_PAGE_SIZE),
      sort: "amount_desc",
      page: String(page),
    });
    if (cursor?.last_index) params.set("last_index", cursor.last_index);
    if (cursor?.last_contribution_receipt_amount) {
      params.set("last_contribution_receipt_amount", cursor.last_contribution_receipt_amount);
    }
    if (cursor?.last_contribution_receipt_date) {
      params.set("last_contribution_receipt_date", cursor.last_contribution_receipt_date);
    }
    if (cursor?.sort_null_only) params.set("sort_null_only", cursor.sort_null_only);

    void donations.fetchData(`/api/fec/contributions?${params.toString()}`);
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
    setDonationsPage(1);
    setDonationCursors({ 1: null });
    setLobbyingPage(1);
    setSpendingPage(1);

    const donationParams = new URLSearchParams({
      employer: companyName,
      limit: String(DONATION_PAGE_SIZE),
      sort: "amount_desc",
      page: "1",
    });
    const lobbyingParams = new URLSearchParams({
      symbol,
      from,
      to,
    });

    void donations.fetchData(`/api/fec/contributions?${donationParams.toString()}`);
    void lobbying.fetchData(`/api/finnhub/lobbying?${lobbyingParams.toString()}`);
    void fetchSpendingData(symbol, companyName, from, to);
  };

  const donationResults = donations.data?.results ?? [];
  const donationAverage = useMemo(() => {
    if (!donationResults.length) return null;
    const total = donationResults.reduce(
      (sum, row) => sum + (row.contribution_receipt_amount ?? 0),
      0
    );
    return total / donationResults.length;
  }, [donationResults]);

  const loading = symbolLookup.loading || donations.loading || lobbying.loading || spending.loading;
  const hasDonationResponse = donations.loading || !!donations.error || !!donations.data;
  const hasLobbyingResponse = lobbying.loading || !!lobbying.error || !!lobbying.data;
  const hasSpendingResponse = spending.loading || !!spending.error || !!spending.data;
  const donationsCurrentPage = donations.data?.pagination?.page ?? donationsPage;
  const donationsTotalPages = donations.data?.pagination?.pages ?? 1;
  const donationsNextCursor =
    donationCursors[donationsCurrentPage + 1] ??
    cursorFromLastIndexes(donations.data?.pagination?.last_indexes);
  const donationsNextDisabled =
    donationsCurrentPage >= donationsTotalPages || !donationsNextCursor;
  const lobbyingResults = lobbying.data?.data ?? [];
  const lobbyingTotalPages = Math.max(1, Math.ceil(lobbyingResults.length / DONATION_PAGE_SIZE));
  const visibleLobbyingResults = lobbyingResults.slice(
    (lobbyingPage - 1) * DONATION_PAGE_SIZE,
    lobbyingPage * DONATION_PAGE_SIZE
  );
  const spendingResults = spending.data?.data ?? [];
  const spendingTotalPages = Math.max(1, Math.ceil(spendingResults.length / DONATION_PAGE_SIZE));
  const visibleSpendingResults = spendingResults.slice(
    (spendingPage - 1) * DONATION_PAGE_SIZE,
    spendingPage * DONATION_PAGE_SIZE
  );

  useEffect(() => {
    const page = donations.data?.pagination?.page;
    const nextCursor = cursorFromLastIndexes(donations.data?.pagination?.last_indexes);
    if (!page || !nextCursor) return;

    setDonationCursors((prev) => {
      const nextPage = page + 1;
      const existing = prev[nextPage];
      const unchanged =
        existing &&
        existing.last_index === nextCursor.last_index &&
        existing.last_contribution_receipt_amount ===
          nextCursor.last_contribution_receipt_amount &&
        existing.last_contribution_receipt_date === nextCursor.last_contribution_receipt_date &&
        existing.sort_null_only === nextCursor.sort_null_only;

      if (unchanged) return prev;
      return { ...prev, [nextPage]: nextCursor };
    });
  }, [donations.data?.pagination]);

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
            donations and lobbying, and USAspending provides the contract award data.
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

      {resolvedCompanyName && hasDonationResponse && (
        <section className="space-y-3">
          <SectionHeader
            title="Employer-Matched Candidate Donations"
            expanded={sectionsExpanded.donations}
            onToggle={() =>
              setSectionsExpanded((current) => ({ ...current, donations: !current.donations }))
            }
            aside={
              donations.data?.pagination?.count != null
                ? `${donations.data.pagination.count.toLocaleString()} matching receipts`
                : null
            }
          />

          {sectionsExpanded.donations && (
            <>
              <p className="text-xs text-vibe-dim">
                This is not direct corporate giving. It is individual federal contributions whose employer field matches
                <span className="text-vibe-text"> {resolvedCompanyName}</span>.
              </p>

              {donations.error && (
                <div className="card border-vibe-nay/30">
                  <p className="text-sm text-vibe-nay">{donations.error}</p>
                </div>
              )}

              {donations.data && (
                <>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    <SummaryStat
                      label="Search term"
                      value={resolvedCompanyName}
                    />
                    <SummaryStat
                      label="Total receipts"
                      value={(donations.data.pagination?.count ?? donationResults.length).toLocaleString()}
                    />
                    <SummaryStat
                      label="Avg on page"
                      value={`$${donationAverage?.toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                      }) ?? "0"}`}
                    />
                  </div>

                  <PaginationControls
                    page={donationsCurrentPage}
                    pages={donationsTotalPages}
                    onPageChange={fetchDonationsPage}
                    disableNext={donationsNextDisabled}
                  />

                  {donationResults.length === 0 ? (
                    <div className="card">
                      <p className="text-sm text-vibe-dim">
                        No employer-matched contributions found for this search term.
                      </p>
                    </div>
                  ) : (
                    donationResults.map((item, index) => (
                      <div key={`${item.contributor_name ?? "unknown"}-${index}`} className="card">
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium">{item.contributor_name ?? "Unknown donor"}</p>
                            <p className="text-xs text-vibe-dim mt-0.5">
                              {item.contributor_employer ?? "No employer"}
                              {item.contributor_occupation ? ` | ${item.contributor_occupation}` : ""}
                              {item.contributor_state ? ` | ${item.contributor_state}` : ""}
                            </p>
                            {(item.candidate_name || item.recipient_name || item.committee?.name) && (
                              <p className="text-xs text-vibe-dim mt-0.5">
                                Recipient: {item.candidate_name ?? item.recipient_name ?? item.committee?.name}
                              </p>
                            )}
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-sm font-bold text-vibe-money">
                              ${item.contribution_receipt_amount?.toLocaleString() ?? "?"}
                            </p>
                            <p className="text-xs text-vibe-dim">{item.contribution_receipt_date ?? "Unknown date"}</p>
                          </div>
                        </div>
                      </div>
                    ))
                  )}

                  <JsonViewer data={donations.data} label="Employer-Matched Donation Response" />
                </>
              )}
            </>
          )}
        </section>
      )}

      {resolvedSymbol && (hasLobbyingResponse || hasSpendingResponse) && (
        <>
          <section className="space-y-3">
            <SectionHeader
              title="Lobbying Filings"
              expanded={sectionsExpanded.lobbying}
              onToggle={() =>
                setSectionsExpanded((current) => ({ ...current, lobbying: !current.lobbying }))
              }
              aside={`${from} to ${to}`}
            />

            {sectionsExpanded.lobbying && (
              <>
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
                          className="card"
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
                        </div>
                      ))
                    )}

                    <JsonViewer data={lobbying.data} label="Lobbying Response" />
                  </>
                )}
              </>
            )}
          </section>

          <section className="space-y-3">
            <SectionHeader
              title="Government Contract Activity"
              expanded={sectionsExpanded.spending}
              onToggle={() =>
                setSectionsExpanded((current) => ({ ...current, spending: !current.spending }))
              }
              aside="Direct USAspending contract awards"
            />

            {sectionsExpanded.spending && (
              <>
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
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function SectionHeader({
  title,
  expanded,
  onToggle,
  aside,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  aside?: string | null;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between gap-3 text-left"
    >
      <span className="flex items-center gap-2">
        <Chevron expanded={expanded} />
        <span className="text-sm font-semibold uppercase tracking-wider text-vibe-money">
          {title}
        </span>
      </span>
      {aside ? <span className="text-xs text-vibe-dim">{aside}</span> : null}
    </button>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className={`h-4 w-4 text-vibe-dim transition-transform ${expanded ? "rotate-0" : "-rotate-90"}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 7.5 10 12.5 15 7.5" />
    </svg>
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
