import test from "node:test";
import assert from "node:assert/strict";
import {
  appendTradePage,
  buildTradesUrl,
  describeShareCount,
} from "../src/lib/stock-trade-feed.ts";

test("buildTradesUrl includes pagination for filtered trade pages", () => {
  assert.equal(
    buildTradesUrl(
      {
        from: "2026-03-01",
        to: "2026-03-19",
        member: "Nancy Pelosi",
        symbol: "NVDA",
        transactionType: "purchase",
      },
      "disclosure_date",
      20,
      40,
    ),
    "/api/disclosures/trades/search?limit=20&offset=40&sort=disclosure_date&from=2026-03-01&to=2026-03-19&member=Nancy+Pelosi&symbol=NVDA&transaction_type=purchase",
  );
});

test("appendTradePage preserves order while skipping duplicate trade ids", () => {
  assert.deepEqual(
    appendTradePage(
      [{ id: 1 }, { id: 2 }, { id: 3 }],
      [{ id: 3 }, { id: 4 }, { id: 5 }],
    ),
    [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
  );
});

test("describeShareCount labels exact and estimated counts differently", () => {
  assert.equal(describeShareCount(5, "pdf_exact"), "5 shares");
  assert.equal(describeShareCount(5.126, "estimated_from_amount_and_close"), "~5.13 shares");
  assert.equal(describeShareCount(null, null), "N/A");
});
