export type TransactionFilter = "all" | "purchase" | "sale" | "exchange";
export type SortMode = "trade_date" | "disclosure_date";
export type ShareCountSource = "pdf_exact" | "estimated_from_amount_and_close" | null;

export type FilterState = {
  from: string;
  to: string;
  member: string;
  symbol: string;
  transactionType: TransactionFilter;
};

export function buildTradesUrl(filters: FilterState, sortMode: SortMode, limit: number, offset: number) {
  const hasFilters = Boolean(
    filters.from || filters.to || filters.member.trim() || filters.symbol.trim() || filters.transactionType !== "all",
  );

  if (!hasFilters) {
    return `/api/disclosures/trades/recent?limit=${limit}&offset=${offset}&sort=${sortMode}`;
  }

  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    sort: sortMode,
  });
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.member.trim()) params.set("member", filters.member.trim());
  if (filters.symbol.trim()) params.set("symbol", filters.symbol.trim().toUpperCase());
  if (filters.transactionType !== "all") params.set("transaction_type", filters.transactionType);
  return `/api/disclosures/trades/search?${params.toString()}`;
}

export function appendTradePage<T extends { id: number }>(current: T[], incoming: T[]) {
  const seen = new Set(current.map((trade) => trade.id));
  return [...current, ...incoming.filter((trade) => !seen.has(trade.id))];
}

export function describeShareCount(value: number | null, source: ShareCountSource) {
  if (value == null || !Number.isFinite(value)) return "N/A";

  const formatted = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);

  return source === "estimated_from_amount_and_close"
    ? `~${formatted} shares`
    : `${formatted} shares`;
}
