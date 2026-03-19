import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTradeSearchParams,
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
    limit: "40",
    offset: "20",
  });

  assert.deepEqual(result, {
    from: "2024-06-01",
    to: "2024-06-30",
    member: "Nancy Pelosi",
    transactionType: "purchase",
    symbol: "NVDA",
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
