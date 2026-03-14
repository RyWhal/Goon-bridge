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
}

interface RecentTradeRecord extends TradeRecord {
  member: MemberRecord | null;
}

interface RecentTradesResponse {
  count: number;
  trades: RecentTradeRecord[];
}

interface TradeMemberSummary {
  bioguide_id: string;
  trade_count: number;
  latest_trade_date: string | null;
  member: MemberRecord | null;
}

interface TradeMembersResponse {
  count: number;
  members: TradeMemberSummary[];
}

interface MemberTradesResponse {
  bioguide_id: string;
  member: MemberRecord;
  count: number;
  trades: TradeRecord[];
}

type TransactionFilter = "all" | "purchase" | "sale" | "exchange";

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

function formatTradeType(value?: string | null) {
  if (!value) return "trade";
  return value.replace(/_/g, " ");
}

function formatCurrency(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

function formatShareCount(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
  }).format(value);
}

function PartyBadge({ party }: { party?: string | null }) {
  const normalized = normalizeParty(party);
  if (normalized === "D") return <span className="badge badge-d">D</span>;
  if (normalized === "R") return <span className="badge badge-r">R</span>;
  if (normalized === "I") return <span className="badge badge-i">I</span>;
  return <span className="badge bg-vibe-border text-vibe-dim">?</span>;
}

function TradeCard({
  trade,
  member,
  onOpenMember,
}: {
  trade: TradeRecord;
  member?: MemberRecord | null;
  onOpenMember?: ((bioguideId: string) => void) | null;
}) {
  return (
    <article className="card border-vibe-accent/20">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.2em] text-vibe-dim">
            <span className="badge bg-vibe-money/20 text-vibe-money">
              {formatTradeType(trade.transaction_type)}
            </span>
            {trade.symbol && (
              <span className="badge bg-vibe-cosmic/20 text-vibe-cosmic">{trade.symbol}</span>
            )}
            <span>{formatDate(trade.transaction_date)}</span>
          </div>
          <h3 className="text-lg font-bold text-vibe-text">
            {trade.asset_name ?? trade.organization?.name ?? "Unknown asset"}
          </h3>
          <div className="flex flex-wrap items-center gap-2 text-sm text-vibe-dim">
            {member && onOpenMember && (
              <button
                type="button"
                onClick={() => onOpenMember(trade.bioguide_id)}
                className="text-vibe-accent hover:text-vibe-accent/80"
              >
                {member.direct_order_name ?? member.name ?? trade.bioguide_id}
              </button>
            )}
            {trade.amount_range && <span>{trade.amount_range}</span>}
            {trade.owner_type && <span>{trade.owner_type.replace(/_/g, " ")}</span>}
            {trade.parse_confidence && <span>{trade.parse_confidence} confidence</span>}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm text-vibe-dim">
            {formatShareCount(trade.share_count) && (
              <span>~{formatShareCount(trade.share_count)} shares</span>
            )}
            {formatCurrency(trade.execution_close_price) && (
              <span>@ {formatCurrency(trade.execution_close_price)} close</span>
            )}
            {formatCurrency(trade.estimated_trade_value) && (
              <span>~{formatCurrency(trade.estimated_trade_value)} estimated value</span>
            )}
          </div>
        </div>

        {trade.filing?.document_url && (
          <a
            href={trade.filing.document_url}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-vibe-accent hover:text-vibe-accent/80"
          >
            Source
          </a>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-vibe-dim">
        {trade.organization?.name && (
          <span className="badge bg-vibe-border text-vibe-text">{trade.organization.name}</span>
        )}
        {trade.disclosure_date && <span>disclosed {formatDate(trade.disclosure_date)}</span>}
        <span>{trade.source_row_key}</span>
      </div>
    </article>
  );
}

export function StockTradeExplorer() {
  const [query, setQuery] = useState("");
  const [selectedBioguideId, setSelectedBioguideId] = useState<string | null>(null);
  const [transactionFilter, setTransactionFilter] = useState<TransactionFilter>("all");

  const recentTrades = useApi<RecentTradesResponse>();
  const memberTrades = useApi<MemberTradesResponse>();
  const tradeMembers = useApi<TradeMembersResponse>();

  useEffect(() => {
    const params = new URLSearchParams({ limit: "24" });
    if (transactionFilter !== "all") {
      params.set("transaction_type", transactionFilter);
    }
    void recentTrades.fetchData(`/api/disclosures/trades/recent?${params.toString()}`);
    void tradeMembers.fetchData(`/api/disclosures/members/with-trades?limit=500${transactionFilter !== "all" ? `&transaction_type=${encodeURIComponent(transactionFilter)}` : ""}`);
  }, [recentTrades.fetchData, tradeMembers.fetchData, transactionFilter]);

  useEffect(() => {
    if (!selectedBioguideId) return;
    const params = new URLSearchParams({ limit: "50" });
    if (transactionFilter !== "all") {
      params.set("transaction_type", transactionFilter);
    }
    void memberTrades.fetchData(`/api/disclosures/member/${selectedBioguideId}/trades?${params.toString()}`);
  }, [memberTrades.fetchData, selectedBioguideId, transactionFilter]);

  const foundMembers = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return (tradeMembers.data?.members ?? [])
      .map((entry) => ({
        bioguideId: entry.bioguide_id,
        name: entry.member?.direct_order_name ?? entry.member?.name ?? entry.bioguide_id,
        state: entry.member?.state ?? undefined,
        party: entry.member?.party ?? undefined,
        chamber: entry.member?.chamber ?? undefined,
        depiction: entry.member?.image_url ? { imageUrl: entry.member.image_url } : undefined,
        tradeCount: entry.trade_count,
        latestTradeDate: entry.latest_trade_date,
      }))
      .filter((entry) => {
        if (!normalizedQuery) return true;
        const haystacks = [entry.name, entry.state, entry.bioguideId]
          .filter((value): value is string => !!value)
          .map((value) => value.toLowerCase());
        return haystacks.some((value) => value.includes(normalizedQuery));
      })
      .sort((left, right) =>
        (right.latestTradeDate ?? "").localeCompare(left.latestTradeDate ?? "") || right.tradeCount - left.tradeCount
      );
  }, [tradeMembers.data?.members, query]);

  const selectedMember = memberTrades.data?.member ?? null;

  const openMember = async (bioguideId: string) => {
    setSelectedBioguideId(bioguideId);
  };

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-vibe-dim uppercase tracking-wider">
              Member Stock Trades
            </h2>
            <p className="text-sm text-vibe-dim mt-2 max-w-2xl">
              View normalized congressional stock trades parsed from official public disclosures and cached in Supabase. Start with recent parsed trades or drill into one member.
            </p>
          </div>
          <span className="badge bg-vibe-money/20 text-vibe-money uppercase tracking-wider">
            Disclosures
          </span>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
          <input
            type="text"
            className="input w-full"
            placeholder="Search members by name, state, or bioguide ID..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            className="select"
            value={transactionFilter}
            onChange={(event) => setTransactionFilter(event.target.value as TransactionFilter)}
          >
            <option value="all">All trades</option>
            <option value="purchase">Purchases</option>
            <option value="sale">Sales</option>
            <option value="exchange">Exchanges</option>
          </select>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-4">
          <div className="card">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs uppercase tracking-[0.2em] text-vibe-dim">Members With Trades</h3>
              <span className="text-[11px] text-vibe-dim">{tradeMembers.data?.count ?? foundMembers.length} found</span>
            </div>
            <div className="mt-3 space-y-2 max-h-[38rem] overflow-y-auto pr-1">
              {foundMembers.map((entry) => {
                const isActive = selectedBioguideId === entry.bioguideId;
                const chamber = normalizeChamber(entry.chamber);
                return (
                  <button
                    key={entry.bioguideId}
                    type="button"
                    onClick={() => entry.bioguideId && openMember(entry.bioguideId)}
                    className={`card w-full text-left transition-colors ${
                      isActive ? "border-vibe-accent/60" : "hover:border-vibe-accent/40"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      {entry.depiction?.imageUrl && (
                        <img
                          src={entry.depiction.imageUrl}
                          alt={entry.name ?? "Member portrait"}
                          className="h-12 w-12 rounded-md object-cover border border-vibe-border"
                        />
                      )}
                      <div className="min-w-0">
                        <div className="text-base font-semibold text-vibe-text truncate">{entry.name}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-vibe-dim">
                          <PartyBadge party={entry.party ?? null} />
                          {entry.state && <span>{entry.state}</span>}
                          {chamber && <span className="badge bg-vibe-border text-vibe-dim">{chamber}</span>}
                          {entry.bioguideId && <span>{entry.bioguideId}</span>}
                          <span>{entry.tradeCount} trade{entry.tradeCount === 1 ? "" : "s"}</span>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}

              {!foundMembers.length && (
                <div className="card border-vibe-nay/30 text-sm text-vibe-dim">
                  No members with parsed trades matched that search.
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          {!selectedBioguideId && (
            <div className="card">
              <h3 className="text-xs uppercase tracking-[0.2em] text-vibe-dim">Recent Parsed Trades</h3>
              <p className="mt-2 text-sm text-vibe-dim">
                These are normalized trades already extracted from official disclosure PDFs.
              </p>

              {recentTrades.loading && <div className="mt-4 text-sm text-vibe-dim">Loading recent trades…</div>}
              {recentTrades.error && (
                <div className="card border-vibe-nay/30 mt-4 text-sm text-vibe-nay">{recentTrades.error}</div>
              )}

              {!recentTrades.loading && !recentTrades.error && (
                <div className="mt-4 space-y-3">
                  {recentTrades.data?.trades.length ? (
                    recentTrades.data.trades.map((trade) => (
                      <TradeCard
                        key={trade.id}
                        trade={trade}
                        member={trade.member}
                        onOpenMember={openMember}
                      />
                    ))
                  ) : (
                    <div className="card border-vibe-border text-sm text-vibe-dim">
                      No parsed trades are available for this filter yet.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {selectedBioguideId && (
            <>
              <div className="card">
                <div className="flex items-start gap-4">
                  {selectedMember?.image_url && (
                    <img
                      src={selectedMember.image_url}
                      alt={selectedMember.direct_order_name ?? selectedMember.name ?? selectedBioguideId}
                      className="h-20 w-20 rounded-lg object-cover border border-vibe-border"
                    />
                  )}
                  <div className="min-w-0">
                    <h3 className="text-2xl font-bold text-vibe-text">
                      {selectedMember?.direct_order_name ?? selectedMember?.name ?? selectedBioguideId}
                    </h3>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-vibe-dim">
                      <PartyBadge party={selectedMember?.party} />
                      {selectedMember?.chamber && (
                        <span className="badge bg-vibe-border text-vibe-dim">
                          {normalizeChamber(selectedMember.chamber) ?? selectedMember.chamber}
                        </span>
                      )}
                      {selectedMember?.state && <span>{selectedMember.state}</span>}
                      <span>{selectedBioguideId}</span>
                    </div>
                  </div>
                </div>
              </div>

              {memberTrades.loading && <div className="card text-sm text-vibe-dim">Loading member trades…</div>}
              {memberTrades.error && (
                <div className="card border-vibe-nay/30 text-sm text-vibe-nay">{memberTrades.error}</div>
              )}

              {!memberTrades.loading && !memberTrades.error && (
                <div className="card">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-xs uppercase tracking-[0.2em] text-vibe-dim">Trade History</h3>
                    <span className="text-sm text-vibe-dim">
                      {memberTrades.data?.count ?? 0} trade{(memberTrades.data?.count ?? 0) === 1 ? "" : "s"}
                    </span>
                  </div>

                  <div className="mt-4 space-y-3">
                    {memberTrades.data?.trades.length ? (
                      memberTrades.data.trades.map((trade) => (
                        <TradeCard key={trade.id} trade={trade} />
                      ))
                    ) : (
                      <div className="card border-vibe-border text-sm text-vibe-dim">
                        No normalized trades found for this member yet.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
