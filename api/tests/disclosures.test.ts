import test from "node:test";
import assert from "node:assert/strict";
import { parseTradeRowsFromText } from "../src/lib/disclosures.ts";

test("parseTradeRowsFromText captures exact share counts from house disclosure text", () => {
  const rows = parseTradeRowsFromText(`
Periodic Transaction Report
Filing ID #12345678
Name: Doe, Jane
SP Apple Inc. (AAPL)
Purchase
03/10/2026
03/11/2026
5 shares
$1,001 - $15,000
  `);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.shareCount, 5);
  assert.equal(rows[0]?.shareCountSource, "pdf_exact");
});

test("parseTradeRowsFromText leaves share count empty when no exact shares are present", () => {
  const rows = parseTradeRowsFromText(`
Periodic Transaction Report
Filing ID #12345678
Name: Doe, Jane
SP Apple Inc. (AAPL)
Purchase
03/10/2026
03/11/2026
$1,001 - $15,000
  `);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.shareCount, null);
  assert.equal(rows[0]?.shareCountSource, null);
});
