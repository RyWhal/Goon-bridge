import type { Env } from "../types";
import { FetchTimeoutError, fetchWithTimeout } from "./fetch-with-timeout.ts";
import { readErrorDetail } from "./error-utils.ts";
import type { getSupabase } from "./supabase";
import { isValidDate, parseLimit, parseOffset } from "./validation.ts";

export type TradeTransactionType = "purchase" | "sale" | "exchange";
type SupabaseClient = ReturnType<typeof getSupabase>;
const FINNHUB_BASE = "https://finnhub.io/api/v1";
const FINNHUB_TIMEOUT_MS = 12_000;
export const CURRENT_PRICE_TTL_MS = 15 * 60 * 1000;

type TradeSearchInput = {
  from?: string;
  to?: string;
  member?: string;
  transaction_type?: string;
  symbol?: string;
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

type RequestPriceCache = {
  historical: Map<string, Promise<number | null>>;
  current: Map<string, Promise<{ price: number | null; asOf: string | null }>>;
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
  };
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
    const { data: cachedRow, error: cacheError } = await sb
      .from("stock_price_history_cache")
      .select("close_price")
      .eq("symbol", symbol)
      .eq("price_date", tradeDate)
      .maybeSingle();
    if (cacheError && !isMissingCacheTableError(cacheError.message)) {
      throw new Error(`Failed to read stock price history cache: ${cacheError.message}`);
    }
    if (cachedRow?.close_price != null) return cachedRow.close_price;

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
    const { data: cachedRow, error: cacheError } = await sb
      .from("stock_price_quote_cache")
      .select("current_price,fetched_at")
      .eq("symbol", symbol)
      .maybeSingle();
    if (cacheError && !isMissingCacheTableError(cacheError.message)) {
      throw new Error(`Failed to read stock quote cache: ${cacheError.message}`);
    }

    if (
      cachedRow?.current_price != null
      && !isCurrentPriceStale({ fetchedAt: cachedRow.fetched_at, ttlMs: CURRENT_PRICE_TTL_MS })
    ) {
      return { price: cachedRow.current_price, asOf: cachedRow.fetched_at };
    }

    if (!env.FINNHUB_API_KEY) {
      return {
        price: cachedRow?.current_price ?? null,
        asOf: cachedRow?.fetched_at ?? null,
      };
    }

    try {
      const currentPrice = await fetchFinnhubCurrentQuote(env.FINNHUB_API_KEY, symbol);
      if (currentPrice == null) {
        return {
          price: cachedRow?.current_price ?? null,
          asOf: cachedRow?.fetched_at ?? null,
        };
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

      return { price: currentPrice, asOf: fetchedAt };
    } catch (error) {
      if (error instanceof FetchTimeoutError) {
        return {
          price: cachedRow?.current_price ?? null,
          asOf: cachedRow?.fetched_at ?? null,
        };
      }
      return {
        price: cachedRow?.current_price ?? null,
        asOf: cachedRow?.fetched_at ?? null,
      };
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
