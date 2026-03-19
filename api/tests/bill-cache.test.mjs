import test from "node:test";
import assert from "node:assert/strict";

import { prepareBillCacheRowsForUpsert, resolveBillWarmRequest } from "../src/lib/bill-cache.ts";

test("prepareBillCacheRowsForUpsert stamps updated_at on every row", () => {
  const now = "2026-03-19T02:00:00.000Z";
  const rows = prepareBillCacheRowsForUpsert(
    [
      { congress: 119, bill_type: "hr", bill_number: 528, latest_action_date: "2026-03-17" },
      { congress: 119, bill_type: "hr", bill_number: 556, latest_action_date: "2026-03-16" },
    ],
    now
  );

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.updated_at), [now, now]);
});

test("resolveBillWarmRequest applies defaults and bounds", () => {
  assert.deepEqual(resolveBillWarmRequest(undefined, undefined, undefined), {
    congress: "119",
    sort: "updateDate+desc",
    pageSize: 100,
    maxPages: 5,
    billType: null,
  });

  assert.deepEqual(
    resolveBillWarmRequest("120", "hr", {
      pageSize: "400",
      maxPages: "0",
      sort: "introducedDate+asc",
    }),
    {
      congress: "120",
      sort: "introducedDate+asc",
      pageSize: 250,
      maxPages: 1,
      billType: "hr",
    }
  );
});
