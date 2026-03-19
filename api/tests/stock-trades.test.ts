import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTradeSearchParams,
  collectTradePriceLookupKeys,
  computeTradeShareSnapshot,
  computeTradePriceSnapshot,
  isCurrentPriceStale,
} from "../src/lib/stock-trades.ts";

test("buildTradeSearchParams normalizes and validates trade filters", () => {
  const result = buildTradeSearchParams({
    from: "2024-06-01",
    to: "2024-06-30",
    member: "  Nancy Pelosi ",
    transaction_type: "purchase",
    symbol: " nvda ",
    sort: "disclosure_date",
    limit: "40",
    offset: "20",
  });

  assert.deepEqual(result, {
    from: "2024-06-01",
    to: "2024-06-30",
    member: "Nancy Pelosi",
    transactionType: "purchase",
    symbol: "NVDA",
    sort: "disclosure_date",
    limit: 40,
    offset: 20,
    hasFilters: true,
  });
});

test("buildTradeSearchParams rejects reversed date windows", () => {
  assert.deepEqual(
    buildTradeSearchParams({
      from: "2024-07-01",
      to: "2024-06-01",
    }),
    { error: "'from' date must be on or before 'to' date" }
  );
});

test("buildTradeSearchParams falls back to trade-date sorting for unknown sort", () => {
  assert.equal(
    buildTradeSearchParams({
      sort: "whatever",
    }).sort,
    "trade_date",
  );
});

test("computeTradePriceSnapshot prefers stored trade-day close and computes deltas", () => {
  assert.deepEqual(
    computeTradePriceSnapshot({
      storedExecutionClosePrice: 131.88,
      cachedTradeDateClosePrice: 129.11,
      liveCurrentPrice: 137.42,
      currentPriceAsOf: "2026-03-18T20:15:00.000Z",
    }),
    {
      tradeDateClosePrice: 131.88,
      tradeDatePriceSource: "trade_raw_payload",
      currentPrice: 137.42,
      currentPriceAsOf: "2026-03-18T20:15:00.000Z",
      priceChangeSinceTrade: 5.54,
      priceChangePercentSinceTrade: 4.2,
    }
  );
});

test("computeTradeShareSnapshot preserves exact counts and falls back to an estimate", () => {
  assert.deepEqual(
    computeTradeShareSnapshot({
      storedShareCount: 5,
      rawShareCountSource: "pdf_exact",
      amountRange: "$1,001 - $15,000",
      estimatedTradeValue: 8000,
      tradeDateClosePrice: 125,
    }),
    {
      shareCount: 5,
      shareCountSource: "pdf_exact",
    },
  );

  assert.deepEqual(
    computeTradeShareSnapshot({
      storedShareCount: null,
      rawShareCountSource: null,
      amountRange: "$1,001 - $15,000",
      estimatedTradeValue: null,
      tradeDateClosePrice: 100,
    }),
    {
      shareCount: 80.005,
      shareCountSource: "estimated_from_amount_and_close",
    },
  );
});

test("collectTradePriceLookupKeys dedupes symbols and historical lookups", () => {
  assert.deepEqual(
    collectTradePriceLookupKeys([
      {
        symbol: "NVDA",
        transaction_date: "2024-06-14",
        raw_payload: {},
      },
      {
        symbol: "NVDA",
        transaction_date: "2024-06-14",
        raw_payload: {},
      },
      {
        symbol: "AAPL",
        transaction_date: "2024-06-13",
        raw_payload: { executionClosePrice: 214.24 },
      },
    ]),
    {
      symbols: ["AAPL", "NVDA"],
      historicalLookupKeys: ["NVDA:2024-06-14"],
      historicalDateRange: {
        from: "2024-06-14",
        to: "2024-06-14",
      },
    }
  );
});

test("isCurrentPriceStale expires quotes older than the ttl", () => {
  assert.equal(
    isCurrentPriceStale({
      fetchedAt: "2026-03-18T19:40:00.000Z",
      now: "2026-03-18T20:00:00.000Z",
      ttlMs: 15 * 60 * 1000,
    }),
    true
  );

  assert.equal(
    isCurrentPriceStale({
      fetchedAt: "2026-03-18T19:50:01.000Z",
      now: "2026-03-18T20:00:00.000Z",
      ttlMs: 15 * 60 * 1000,
    }),
    false
  );
});
