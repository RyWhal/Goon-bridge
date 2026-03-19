import { useEffect, useMemo, useState } from "react";
import { useApi } from "../hooks/useApi";

interface MemberRecord {
  bioguide_id?: string;
  name?: string;
  direct_order_name?: string | null;
  party?: string | null;
  state?: string | null;
  chamber?: string | null;
  image_url?: string | null;
}

interface TradeRecord {
  id: number;
  bioguide_id: string;
  source_type: string;
  source_row_key: string;
  symbol: string | null;
  asset_name: string | null;
  normalized_asset_name: string | null;
  transaction_date: string | null;
  disclosure_date: string | null;
  transaction_type: string | null;
  amount_range: string | null;
  estimated_trade_value: number | null;
  execution_close_price: number | null;
  share_count: number | null;
  owner_label: string | null;
  owner_type: string | null;
  asset_type: string | null;
  parse_confidence: string | null;
  trade_date_close_price: number | null;
  trade_date_price_source: string | null;
  current_price: number | null;
  current_price_as_of: string | null;
  price_change_since_trade: number | null;
  price_change_percent_since_trade: number | null;
  organization: {
    id: number | null;
    name: string | null;
    ticker: string | null;
  } | null;
  filing: {
    id: number;
    document_url: string | null;
    filed_date: string | null;
  } | null;
  member: MemberRecord | null;
}

interface TradesResponse {
  count: number;
  limit?: number;
  offset?: number;
  trades: TradeRecord[];
}

type TransactionFilter = "all" | "purchase" | "sale" | "exchange";

type FilterState = {
  from: string;
  to: string;
  member: string;
  symbol: string;
  transactionType: TransactionFilter;
};

const EMPTY_FILTERS: FilterState = {
  from: "",
  to: "",
  member: "",
  symbol: "",
  transactionType: "all",
};

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
  if (!value) return "Unknown";
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatCompactTradeDate(value?: string | null) {
  if (!value) return { primary: "Unknown", secondary: "" };
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return { primary: value, secondary: "" };
  }

  return {
    primary: parsed.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    }),
    secondary: parsed.toLocaleDateString(undefined, {
      year: "numeric",
    }),
  };
}

function formatDateTime(value?: string | null) {
  if (!value) return "Unknown";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTradeType(value?: string | null) {
  if (!value) return "Trade";
  const normalized = value.replace(/_/g, " ");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatCurrency(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "N/A";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

function formatPercent(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "N/A";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function buildTradesUrl(filters: FilterState) {
  const hasFilters = Boolean(
    filters.from || filters.to || filters.member.trim() || filters.symbol.trim() || filters.transactionType !== "all",
  );

  if (!hasFilters) {
    return "/api/disclosures/trades/recent?limit=20";
  }

  const params = new URLSearchParams({ limit: "20", offset: "0" });
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.member.trim()) params.set("member", filters.member.trim());
  if (filters.symbol.trim()) params.set("symbol", filters.symbol.trim().toUpperCase());
  if (filters.transactionType !== "all") params.set("transaction_type", filters.transactionType);
  return `/api/disclosures/trades/search?${params.toString()}`;
}

function PartyBadge({ party }: { party?: string | null }) {
  const normalized = normalizeParty(party);
  if (normalized === "D") return <span className="badge badge-d">D</span>;
  if (normalized === "R") return <span className="badge badge-r">R</span>;
  if (normalized === "I") return <span className="badge badge-i">I</span>;
  return <span className="badge bg-vibe-border text-vibe-dim">?</span>;
}

function TradeTypeBadge({ value }: { value?: string | null }) {
  const type = value?.toLowerCase() ?? "";
  if (type === "purchase") return <span className="badge bg-vibe-yea/20 text-vibe-yea">Purchase</span>;
  if (type === "sale") return <span className="badge bg-vibe-nay/20 text-vibe-nay">Sale</span>;
  if (type === "exchange") return <span className="badge bg-vibe-cosmic/20 text-vibe-cosmic">Exchange</span>;
  return <span className="badge bg-vibe-border text-vibe-dim">{formatTradeType(value)}</span>;
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "default" | "positive" | "negative";
}) {
  const toneClass = tone === "positive"
    ? "text-vibe-yea"
    : tone === "negative"
      ? "text-vibe-nay"
      : "text-vibe-text";

  return (
    <div className="rounded-xl border border-vibe-border bg-vibe-surface/70 p-3">
      <div className="text-[11px] uppercase tracking-[0.2em] text-vibe-dim">{label}</div>
      <div className={`mt-2 text-xl font-bold ${toneClass}`}>{value}</div>
    </div>
  );
}

export function StockTradeExplorer() {
  const [draftFilters, setDraftFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [selectedTradeId, setSelectedTradeId] = useState<number | null>(null);

  const trades = useApi<TradesResponse>();

  useEffect(() => {
    void trades.fetchData(buildTradesUrl(appliedFilters), { force: true, ttlMs: 60_000 });
  }, [appliedFilters, trades.fetchData]);

  useEffect(() => {
    const rows = trades.data?.trades ?? [];
    if (!rows.length) {
      setSelectedTradeId(null);
      return;
    }

    if (selectedTradeId == null || !rows.some((trade) => trade.id === selectedTradeId)) {
      setSelectedTradeId(rows[0]?.id ?? null);
    }
  }, [selectedTradeId, trades.data?.trades]);

  const selectedTrade = useMemo(
    () => (trades.data?.trades ?? []).find((trade) => trade.id === selectedTradeId) ?? null,
    [selectedTradeId, trades.data?.trades],
  );
  const hasActiveFilters = Boolean(
    appliedFilters.from
      || appliedFilters.to
      || appliedFilters.member.trim()
      || appliedFilters.symbol.trim()
      || appliedFilters.transactionType !== "all",
  );

  const handleDraftChange = <K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    setDraftFilters((current) => ({ ...current, [key]: value }));
  };

  const applyFilters = () => {
    setAppliedFilters({
      from: draftFilters.from,
      to: draftFilters.to,
      member: draftFilters.member,
      symbol: draftFilters.symbol.trim().toUpperCase(),
      transactionType: draftFilters.transactionType,
    });
  };

  const resetFilters = () => {
    setDraftFilters(EMPTY_FILTERS);
    setAppliedFilters(EMPTY_FILTERS);
  };

  const countLabel = trades.data?.count ?? 0;
  const selectedMemberName = selectedTrade?.member?.direct_order_name ?? selectedTrade?.member?.name ?? selectedTrade?.bioguide_id;
  const selectedChamber = normalizeChamber(selectedTrade?.member?.chamber);

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-vibe-dim uppercase tracking-wider">
              Member Stock Trades
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-vibe-dim">
              Browse the latest normalized congressional stock trades with server-side filtering and cached stock pricing from Finnhub.
            </p>
          </div>
          <span className="badge bg-vibe-money/20 text-vibe-money uppercase tracking-wider">
            Disclosures
          </span>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-[180px_180px_minmax(0,1.1fr)_180px_180px_auto]">
          <label className="space-y-1">
            <span className="text-[11px] uppercase tracking-[0.18em] text-vibe-dim">From</span>
            <input
              type="date"
              className="input w-full"
              value={draftFilters.from}
              onChange={(event) => handleDraftChange("from", event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-[11px] uppercase tracking-[0.18em] text-vibe-dim">To</span>
            <input
              type="date"
              className="input w-full"
              value={draftFilters.to}
              onChange={(event) => handleDraftChange("to", event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-[11px] uppercase tracking-[0.18em] text-vibe-dim">Member</span>
            <input
              type="text"
              className="input w-full"
              placeholder="Search member name..."
              value={draftFilters.member}
              onChange={(event) => handleDraftChange("member", event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-[11px] uppercase tracking-[0.18em] text-vibe-dim">Trade Type</span>
            <select
              className="select h-10 w-full appearance-none"
              value={draftFilters.transactionType}
              onChange={(event) => handleDraftChange("transactionType", event.target.value as TransactionFilter)}
            >
              <option value="all">All trades</option>
              <option value="purchase">Purchases</option>
              <option value="sale">Sales</option>
              <option value="exchange">Exchanges</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[11px] uppercase tracking-[0.18em] text-vibe-dim">Ticker</span>
            <input
              type="text"
              className="input w-full uppercase"
              placeholder="NVDA"
              value={draftFilters.symbol}
              onChange={(event) => handleDraftChange("symbol", event.target.value.toUpperCase())}
            />
          </label>
          <div className="flex items-end gap-2">
            <button type="button" onClick={applyFilters} className="btn btn-primary">
              Apply
            </button>
            <button type="button" onClick={resetFilters} className="btn btn-ghost">
              Reset
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-vibe-border pb-3">
            <div>
              <h3 className="text-xs uppercase tracking-[0.2em] text-vibe-dim">Trade Feed</h3>
              <p className="mt-1 text-sm text-vibe-dim">
                {hasActiveFilters ? "Filtered trade results from the disclosure cache." : "Latest 20 trades by default."}
              </p>
            </div>
            <span className="text-sm text-vibe-dim">{countLabel} match{countLabel === 1 ? "" : "es"}</span>
          </div>

          {trades.loading && <div className="py-6 text-sm text-vibe-dim">Loading trades…</div>}
          {trades.error && !trades.loading && (
            <div className="mt-4 rounded-xl border border-vibe-nay/30 bg-vibe-nay/10 p-3 text-sm text-vibe-nay">
              {trades.error}
            </div>
          )}

          {!trades.loading && !trades.error && !(trades.data?.trades.length) && (
            <div className="py-6 text-sm text-vibe-dim">
              No trades matched the current filters.
            </div>
          )}

          {!trades.loading && !trades.error && (trades.data?.trades.length ?? 0) > 0 && (
            <div className="mt-4">
              <table className="w-full table-fixed border-separate border-spacing-0 text-left">
                <thead>
                  <tr className="text-[11px] uppercase tracking-[0.18em] text-vibe-dim">
                    <th className="w-[10%] border-b border-vibe-border px-2.5 py-2 font-medium">Trade Date</th>
                    <th className="w-[26%] border-b border-vibe-border px-2.5 py-2 font-medium">Member</th>
                    <th className="w-[13%] border-b border-vibe-border px-2.5 py-2 font-medium">Type</th>
                    <th className="w-[10%] border-b border-vibe-border px-2.5 py-2 font-medium">Ticker</th>
                    <th className="w-[20%] border-b border-vibe-border px-2.5 py-2 font-medium">Amount</th>
                    <th className="w-[10%] border-b border-vibe-border px-2.5 py-2 font-medium">Trade-Day</th>
                    <th className="w-[11%] border-b border-vibe-border px-2.5 py-2 font-medium">Current</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.data?.trades.map((trade) => {
                    const isSelected = trade.id === selectedTradeId;
                    const compactTradeDate = formatCompactTradeDate(trade.transaction_date);
                    return (
                      <tr
                        key={trade.id}
                        onClick={() => setSelectedTradeId(trade.id)}
                        className={`cursor-pointer transition-colors ${
                          isSelected ? "bg-vibe-accent/10" : "hover:bg-vibe-surface/60"
                        }`}
                      >
                        <td className="border-b border-vibe-border px-2.5 py-3 text-sm text-vibe-text">
                          <div className="whitespace-nowrap font-medium">{compactTradeDate.primary}</div>
                          <div className="whitespace-nowrap text-xs text-vibe-dim">{compactTradeDate.secondary}</div>
                        </td>
                        <td className="border-b border-vibe-border px-2.5 py-3 text-sm text-vibe-text">
                          <div className="truncate font-medium">
                            {trade.member?.direct_order_name ?? trade.member?.name ?? trade.bioguide_id}
                          </div>
                          <div className="mt-1 truncate text-xs text-vibe-dim">
                            {[trade.member?.state, normalizeChamber(trade.member?.chamber)].filter(Boolean).join(" • ")}
                          </div>
                        </td>
                        <td className="border-b border-vibe-border px-2.5 py-3 text-sm">
                          <TradeTypeBadge value={trade.transaction_type} />
                        </td>
                        <td className="whitespace-nowrap border-b border-vibe-border px-2.5 py-3 text-sm font-semibold text-vibe-text">
                          {trade.symbol ?? trade.organization?.ticker ?? "N/A"}
                        </td>
                        <td className="border-b border-vibe-border px-2.5 py-3 text-sm text-vibe-text">
                          <div className="truncate">{trade.amount_range ?? "N/A"}</div>
                        </td>
                        <td className="whitespace-nowrap border-b border-vibe-border px-2.5 py-3 text-sm text-vibe-text">
                          {formatCurrency(trade.trade_date_close_price)}
                        </td>
                        <td className="whitespace-nowrap border-b border-vibe-border px-2.5 py-3 text-sm text-vibe-text">
                          {formatCurrency(trade.current_price)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          {!selectedTrade && (
            <div className="py-10 text-sm text-vibe-dim">
              Select a trade to inspect its filing details and pricing snapshot.
            </div>
          )}

          {selectedTrade && (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.2em] text-vibe-dim">Selected Trade</div>
                  <h3 className="mt-2 text-xl font-bold text-vibe-text">{selectedMemberName}</h3>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-vibe-dim">
                    <PartyBadge party={selectedTrade.member?.party} />
                    {selectedTrade.member?.state && <span>{selectedTrade.member.state}</span>}
                    {selectedChamber && <span className="badge bg-vibe-border text-vibe-dim">{selectedChamber}</span>}
                    <span>{selectedTrade.bioguide_id}</span>
                  </div>
                </div>
                <TradeTypeBadge value={selectedTrade.transaction_type} />
              </div>

              <div className="rounded-xl border border-vibe-border bg-vibe-surface/60 p-3">
                <div className="text-base font-semibold text-vibe-text">
                  {selectedTrade.asset_name ?? selectedTrade.organization?.name ?? "Unknown asset"}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-vibe-dim">
                  {(selectedTrade.symbol ?? selectedTrade.organization?.ticker) && (
                    <span className="badge bg-vibe-cosmic/20 text-vibe-cosmic">
                      {selectedTrade.symbol ?? selectedTrade.organization?.ticker}
                    </span>
                  )}
                  <span>{formatDate(selectedTrade.transaction_date)}</span>
                  {selectedTrade.amount_range && <span>{selectedTrade.amount_range}</span>}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <StatCard label="Trade-Day Close" value={formatCurrency(selectedTrade.trade_date_close_price)} />
                <StatCard label="Current Price" value={formatCurrency(selectedTrade.current_price)} />
                <StatCard
                  label="Price Change"
                  value={formatCurrency(selectedTrade.price_change_since_trade)}
                  tone={selectedTrade.price_change_since_trade == null ? "default" : selectedTrade.price_change_since_trade >= 0 ? "positive" : "negative"}
                />
                <StatCard
                  label="Change Percent"
                  value={formatPercent(selectedTrade.price_change_percent_since_trade)}
                  tone={selectedTrade.price_change_percent_since_trade == null ? "default" : selectedTrade.price_change_percent_since_trade >= 0 ? "positive" : "negative"}
                />
              </div>

              <div className="rounded-xl border border-vibe-border bg-vibe-surface/60 p-4">
                <div className="text-[11px] uppercase tracking-[0.2em] text-vibe-dim">Trade Details</div>
                <dl className="mt-3 space-y-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-vibe-dim">Owner</dt>
                    <dd className="text-vibe-text">{selectedTrade.owner_label ?? selectedTrade.owner_type ?? "N/A"}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-vibe-dim">Estimated Value</dt>
                    <dd className="text-vibe-text">{formatCurrency(selectedTrade.estimated_trade_value)}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-vibe-dim">Trade Price Source</dt>
                    <dd className="text-vibe-text">{selectedTrade.trade_date_price_source ?? "N/A"}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-vibe-dim">Current Price As Of</dt>
                    <dd className="text-vibe-text">{formatDateTime(selectedTrade.current_price_as_of)}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-vibe-dim">Disclosure Filed</dt>
                    <dd className="text-vibe-text">{formatDate(selectedTrade.disclosure_date)}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-vibe-dim">Parse Confidence</dt>
                    <dd className="text-vibe-text">{selectedTrade.parse_confidence ?? "N/A"}</dd>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <dt className="text-vibe-dim">Source Row</dt>
                    <dd className="max-w-[14rem] break-all text-right text-vibe-text">{selectedTrade.source_row_key}</dd>
                  </div>
                </dl>
              </div>

              <div className="flex flex-wrap gap-2">
                {selectedTrade.filing?.document_url && (
                  <a
                    href={selectedTrade.filing.document_url}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-primary"
                  >
                    Open Source Filing
                  </a>
                )}
                {(selectedTrade.symbol ?? selectedTrade.organization?.ticker) && (
                  <span className="badge bg-vibe-cosmic/20 text-vibe-cosmic">
                    {selectedTrade.symbol ?? selectedTrade.organization?.ticker}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
