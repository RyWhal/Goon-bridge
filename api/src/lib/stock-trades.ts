import type { Env } from "../types";
import { FetchTimeoutError, fetchWithTimeout } from "./fetch-with-timeout.ts";
import { readErrorDetail } from "./error-utils.ts";
import type { getSupabase } from "./supabase";
import { isValidDate, parseLimit, parseOffset } from "./validation.ts";

export type TradeTransactionType = "purchase" | "sale" | "exchange";
export type TradeSortMode = "trade_date" | "disclosure_date";
type SupabaseClient = ReturnType<typeof getSupabase>;
const FINNHUB_BASE = "https://finnhub.io/api/v1";
const FINNHUB_TIMEOUT_MS = 12_000;
export const CURRENT_PRICE_TTL_MS = 15 * 60 * 1000;
const MAX_LIVE_HISTORICAL_LOOKUPS_PER_REQUEST = 2;
const MAX_LIVE_CURRENT_LOOKUPS_PER_REQUEST = 2;

type TradeSearchInput = {
  from?: string;
  to?: string;
  member?: string;
  transaction_type?: string;
  symbol?: string;
  sort?: string;
  limit?: string;
  offset?: string;
};

type TradeSearchParams =
  | {
      error: string;
    }
  | {
      from?: string;
      to?: string;
      member?: string;
      transactionType?: TradeTransactionType;
      symbol?: string;
      sort: TradeSortMode;
      limit: number;
      offset: number;
      hasFilters: boolean;
    };

type PriceSnapshotInput = {
  storedExecutionClosePrice?: number | null;
  cachedTradeDateClosePrice?: number | null;
  liveCurrentPrice?: number | null;
  currentPriceAsOf?: string | null;
};

type ShareSnapshotInput = {
  storedShareCount?: number | null;
  rawShareCountSource?: string | null;
  amountRange?: string | null;
  estimatedTradeValue?: number | null;
  tradeDateClosePrice?: number | null;
};

type RequestPriceCache = {
  historical: Map<string, Promise<number | null>>;
  current: Map<string, Promise<{ price: number | null; asOf: string | null }>>;
  historicalCachedValues: Map<string, number>;
  currentCachedValues: Map<string, { price: number | null; asOf: string | null }>;
  remainingLiveHistoricalLookups: number;
  remainingLiveCurrentLookups: number;
};

type TradeLike = {
  symbol: string | null;
  transaction_date: string | null;
  raw_payload: Record<string, unknown>;
};

type EnrichedTradePricing = ReturnType<typeof computeTradePriceSnapshot>;

type StaleQuoteInput = {
  fetchedAt?: string | null;
  now?: string;
  ttlMs: number;
};

function asFiniteNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

function roundPercent(value: number) {
  return Math.round(value * 10) / 10;
}

function roundShareCount(value: number) {
  return Math.round(value * 10000) / 10000;
}

function parseAmountRangeMidpoint(amountRange?: string | null) {
  const match = amountRange?.match(/\$([\d,]+(?:\.\d+)?)\s*-\s*\$([\d,]+(?:\.\d+)?)/);
  if (!match) return null;
  const lower = Number.parseFloat(match[1]!.replace(/,/g, ""));
  const upper = Number.parseFloat(match[2]!.replace(/,/g, ""));
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return null;
  return (lower + upper) / 2;
}

export function buildTradeSearchParams(input: TradeSearchInput): TradeSearchParams {
  const from = input.from?.trim() || undefined;
  const to = input.to?.trim() || undefined;

  if ((from && !isValidDate(from)) || (to && !isValidDate(to))) {
    return { error: "Both 'from' and 'to' must be valid YYYY-MM-DD dates" };
  }

  if (from && to && Date.parse(`${from}T00:00:00Z`) > Date.parse(`${to}T00:00:00Z`)) {
    return { error: "'from' date must be on or before 'to' date" };
  }

  const member = input.member?.trim() || undefined;
  const symbol = input.symbol?.trim().toUpperCase() || undefined;
  const sort: TradeSortMode = input.sort === "disclosure_date" ? "disclosure_date" : "trade_date";
  const transactionType = input.transaction_type?.trim() || undefined;
  const normalizedTransactionType = transactionType === "purchase"
    || transactionType === "sale"
    || transactionType === "exchange"
    ? transactionType
    : undefined;

  return {
    from,
    to,
    member,
    transactionType: normalizedTransactionType,
    symbol,
    sort,
    limit: parseLimit(input.limit, 20, 100),
    offset: parseOffset(input.offset, 0),
    hasFilters: Boolean(from || to || member || normalizedTransactionType || symbol),
  };
}

export function computeTradePriceSnapshot(input: PriceSnapshotInput) {
  const storedExecutionClosePrice = asFiniteNumber(input.storedExecutionClosePrice);
  const cachedTradeDateClosePrice = asFiniteNumber(input.cachedTradeDateClosePrice);
  const currentPrice = asFiniteNumber(input.liveCurrentPrice);
  const tradeDateClosePrice = storedExecutionClosePrice ?? cachedTradeDateClosePrice;
  const tradeDatePriceSource = storedExecutionClosePrice != null
    ? "trade_raw_payload"
    : cachedTradeDateClosePrice != null
      ? "historical_price_cache"
      : null;

  const priceChangeSinceTrade = tradeDateClosePrice != null && currentPrice != null
    ? roundCurrency(currentPrice - tradeDateClosePrice)
    : null;
  const priceChangePercentSinceTrade = tradeDateClosePrice != null && currentPrice != null && tradeDateClosePrice !== 0
    ? roundPercent(((currentPrice - tradeDateClosePrice) / tradeDateClosePrice) * 100)
    : null;

  return {
    tradeDateClosePrice,
    tradeDatePriceSource,
    currentPrice,
    currentPriceAsOf: currentPrice != null ? input.currentPriceAsOf ?? null : null,
    priceChangeSinceTrade,
    priceChangePercentSinceTrade,
  };
}

export function computeTradeShareSnapshot(input: ShareSnapshotInput) {
  const storedShareCount = asFiniteNumber(input.storedShareCount);
  const rawShareCountSource = input.rawShareCountSource === "pdf_exact"
    || input.rawShareCountSource === "estimated_from_amount_and_close"
    ? input.rawShareCountSource
    : null;
  if (storedShareCount != null && rawShareCountSource != null) {
    return {
      shareCount: storedShareCount,
      shareCountSource: rawShareCountSource,
    };
  }

  const tradeDateClosePrice = asFiniteNumber(input.tradeDateClosePrice);
  const estimatedTradeValue = asFiniteNumber(input.estimatedTradeValue) ?? parseAmountRangeMidpoint(input.amountRange);
  if (tradeDateClosePrice != null && estimatedTradeValue != null && tradeDateClosePrice !== 0) {
    return {
      shareCount: roundShareCount(estimatedTradeValue / tradeDateClosePrice),
      shareCountSource: "estimated_from_amount_and_close" as const,
    };
  }

  return {
    shareCount: storedShareCount,
    shareCountSource: rawShareCountSource,
  };
}

export function isCurrentPriceStale(input: StaleQuoteInput) {
  if (!input.fetchedAt) return true;
  const fetchedMs = Date.parse(input.fetchedAt);
  const nowMs = Date.parse(input.now ?? new Date().toISOString());
  if (!Number.isFinite(fetchedMs) || !Number.isFinite(nowMs)) return true;
  return nowMs - fetchedMs >= input.ttlMs;
}

function getRawExecutionClosePrice(rawPayload: Record<string, unknown>) {
  const value = rawPayload.executionClosePrice;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isMissingCacheTableError(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("does not exist") || normalized.includes("could not find the table");
}

export function collectTradePriceLookupKeys(trades: TradeLike[]) {
  const symbols = [...new Set(
    trades
      .map((trade) => trade.symbol?.trim().toUpperCase() || null)
      .filter((symbol): symbol is string => Boolean(symbol)),
  )].sort();

  const historicalLookupKeys = [...new Set(
    trades.flatMap((trade) => {
      const symbol = trade.symbol?.trim().toUpperCase() || null;
      const transactionDate = trade.transaction_date?.trim() || null;
      if (!symbol || !transactionDate) return [];
      if (getRawExecutionClosePrice(trade.raw_payload) != null) return [];
      return [`${symbol}:${transactionDate}`];
    }),
  )].sort();

  const dates = historicalLookupKeys.map((entry) => entry.split(":")[1]!).sort();
  return {
    symbols,
    historicalLookupKeys,
    historicalDateRange: dates.length
      ? { from: dates[0]!, to: dates[dates.length - 1]! }
      : null,
  };
}

async function finnhubFetch(path: string, apiKey: string, params: Record<string, string>) {
  const url = new URL(`${FINNHUB_BASE}${path}`);
  url.searchParams.set("token", apiKey);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const resp = await fetchWithTimeout(url.toString(), FINNHUB_TIMEOUT_MS);
  if (!resp.ok) {
    const detail = await readErrorDetail(resp);
    throw new Error(detail ? `Finnhub API ${resp.status}: ${detail}` : `Finnhub API ${resp.status}`);
  }
  return resp.json();
}

async function fetchFinnhubHistoricalClosePrice(apiKey: string, symbol: string, date: string) {
  const from = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
  const to = from + 86399;
  const raw = await finnhubFetch("/stock/candle", apiKey, {
    symbol,
    resolution: "D",
    from: String(from),
    to: String(to),
  }) as { c?: unknown[]; s?: string };

  const closes = Array.isArray(raw.c) ? raw.c : [];
  const close = closes.at(-1);
  return typeof close === "number" && Number.isFinite(close) ? close : null;
}

async function fetchFinnhubCurrentQuote(apiKey: string, symbol: string) {
  const raw = await finnhubFetch("/quote", apiKey, { symbol }) as { c?: unknown };
  const current = raw.c;
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

export function createTradePriceRequestCache(): RequestPriceCache {
  return {
    historical: new Map(),
    current: new Map(),
    historicalCachedValues: new Map(),
    currentCachedValues: new Map(),
    remainingLiveHistoricalLookups: MAX_LIVE_HISTORICAL_LOOKUPS_PER_REQUEST,
    remainingLiveCurrentLookups: MAX_LIVE_CURRENT_LOOKUPS_PER_REQUEST,
  };
}

export async function preloadTradePriceCache(
  sb: SupabaseClient,
  requestCache: RequestPriceCache,
  trades: TradeLike[],
) {
  const lookupKeys = collectTradePriceLookupKeys(trades);

  if (lookupKeys.symbols.length) {
    const { data: quoteRows, error } = await sb
      .from("stock_price_quote_cache")
      .select("symbol,current_price,fetched_at")
      .in("symbol", lookupKeys.symbols);
    if (error && !isMissingCacheTableError(error.message)) {
      throw new Error(`Failed to preload stock quote cache: ${error.message}`);
    }

    for (const row of quoteRows ?? []) {
      requestCache.currentCachedValues.set(row.symbol, {
        price: row.current_price,
        asOf: row.fetched_at,
      });
    }
  }

  if (lookupKeys.historicalLookupKeys.length && lookupKeys.historicalDateRange) {
    const historicalSymbols = [...new Set(lookupKeys.historicalLookupKeys.map((entry) => entry.split(":")[0]!))];
    const { data: historyRows, error } = await sb
      .from("stock_price_history_cache")
      .select("symbol,price_date,close_price")
      .in("symbol", historicalSymbols)
      .gte("price_date", lookupKeys.historicalDateRange.from)
      .lte("price_date", lookupKeys.historicalDateRange.to);
    if (error && !isMissingCacheTableError(error.message)) {
      throw new Error(`Failed to preload stock price history cache: ${error.message}`);
    }

    for (const row of historyRows ?? []) {
      requestCache.historicalCachedValues.set(`${row.symbol}:${row.price_date}`, row.close_price);
    }
  }
}

export async function getHistoricalTradeDateClosePrice(
  sb: SupabaseClient,
  env: Env["Bindings"],
  requestCache: RequestPriceCache,
  symbol: string,
  tradeDate: string,
) {
  const cacheKey = `${symbol}:${tradeDate}`;
  const existing = requestCache.historical.get(cacheKey);
  if (existing) return existing;

  const request = (async () => {
    const preloaded = requestCache.historicalCachedValues.get(cacheKey);
    if (preloaded != null) return preloaded;

    if (requestCache.remainingLiveHistoricalLookups <= 0) return null;
    requestCache.remainingLiveHistoricalLookups -= 1;

    const { data: cachedRow, error: cacheError } = await sb
      .from("stock_price_history_cache")
      .select("close_price")
      .eq("symbol", symbol)
      .eq("price_date", tradeDate)
      .maybeSingle();
    if (cacheError && !isMissingCacheTableError(cacheError.message)) {
      throw new Error(`Failed to read stock price history cache: ${cacheError.message}`);
    }
    if (cachedRow?.close_price != null) {
      requestCache.historicalCachedValues.set(cacheKey, cachedRow.close_price);
      return cachedRow.close_price;
    }

    if (!env.FINNHUB_API_KEY) return null;

    try {
      const closePrice = await fetchFinnhubHistoricalClosePrice(env.FINNHUB_API_KEY, symbol, tradeDate);
      if (closePrice == null) return null;

      const { error: writeError } = await sb.from("stock_price_history_cache").upsert({
        symbol,
        price_date: tradeDate,
        close_price: closePrice,
        source: "finnhub",
        fetched_at: new Date().toISOString(),
      }, { onConflict: "symbol,price_date" });
      if (writeError && !isMissingCacheTableError(writeError.message)) {
        throw new Error(`Failed to write stock price history cache: ${writeError.message}`);
      }

      return closePrice;
    } catch (error) {
      if (error instanceof FetchTimeoutError) return null;
      return null;
    }
  })();

  requestCache.historical.set(cacheKey, request);
  return request;
}

export async function getCurrentTradePrice(
  sb: SupabaseClient,
  env: Env["Bindings"],
  requestCache: RequestPriceCache,
  symbol: string,
) {
  const existing = requestCache.current.get(symbol);
  if (existing) return existing;

  const request = (async () => {
    const preloaded = requestCache.currentCachedValues.get(symbol);
    if (preloaded?.price != null && !isCurrentPriceStale({ fetchedAt: preloaded.asOf, ttlMs: CURRENT_PRICE_TTL_MS })) {
      return preloaded;
    }

    const { data: cachedRow, error: cacheError } = await sb
      .from("stock_price_quote_cache")
      .select("current_price,fetched_at")
      .eq("symbol", symbol)
      .maybeSingle();
    if (cacheError && !isMissingCacheTableError(cacheError.message)) {
      throw new Error(`Failed to read stock quote cache: ${cacheError.message}`);
    }

    const cachedQuote = cachedRow?.current_price != null
      ? { price: cachedRow.current_price, asOf: cachedRow.fetched_at }
      : preloaded ?? { price: null, asOf: null };

    if (cachedQuote.price != null && !isCurrentPriceStale({ fetchedAt: cachedQuote.asOf, ttlMs: CURRENT_PRICE_TTL_MS })) {
      requestCache.currentCachedValues.set(symbol, cachedQuote);
      return cachedQuote;
    }

    if (requestCache.remainingLiveCurrentLookups <= 0) return cachedQuote;
    requestCache.remainingLiveCurrentLookups -= 1;

    if (!env.FINNHUB_API_KEY) {
      return cachedQuote;
    }

    try {
      const currentPrice = await fetchFinnhubCurrentQuote(env.FINNHUB_API_KEY, symbol);
      if (currentPrice == null) {
        return cachedQuote;
      }

      const fetchedAt = new Date().toISOString();
      const { error: writeError } = await sb.from("stock_price_quote_cache").upsert({
        symbol,
        current_price: currentPrice,
        source: "finnhub",
        fetched_at: fetchedAt,
      }, { onConflict: "symbol" });
      if (writeError && !isMissingCacheTableError(writeError.message)) {
        throw new Error(`Failed to write stock quote cache: ${writeError.message}`);
      }

      const liveQuote = { price: currentPrice, asOf: fetchedAt };
      requestCache.currentCachedValues.set(symbol, liveQuote);
      return liveQuote;
    } catch (error) {
      if (error instanceof FetchTimeoutError) {
        return cachedQuote;
      }
      return cachedQuote;
    }
  })();

  requestCache.current.set(symbol, request);
  return request;
}

export async function enrichTradeWithPrices(
  sb: SupabaseClient,
  env: Env["Bindings"],
  requestCache: RequestPriceCache,
  trade: TradeLike,
): Promise<EnrichedTradePricing> {
  const symbol = trade.symbol?.trim().toUpperCase() || null;
  const transactionDate = trade.transaction_date?.trim() || null;
  const storedExecutionClosePrice = getRawExecutionClosePrice(trade.raw_payload);

  const cachedTradeDateClosePrice = symbol && transactionDate
    ? await getHistoricalTradeDateClosePrice(sb, env, requestCache, symbol, transactionDate)
    : null;
  const currentQuote = symbol
    ? await getCurrentTradePrice(sb, env, requestCache, symbol)
    : { price: null, asOf: null };

  return computeTradePriceSnapshot({
    storedExecutionClosePrice,
    cachedTradeDateClosePrice,
    liveCurrentPrice: currentQuote.price,
    currentPriceAsOf: currentQuote.asOf,
  });
}
