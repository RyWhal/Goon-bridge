import test from "node:test";
import assert from "node:assert/strict";
import {
  getDisclosureAdvancedJobs,
  getDisclosurePrimaryJobs,
} from "../src/lib/admin-jobs.ts";

test("disclosure admin jobs emphasize daily import actions", () => {
  assert.deepEqual(
    getDisclosurePrimaryJobs().map((job) => job.label),
    ["Import House Disclosures", "Import Senate Disclosures"],
  );
});

test("advanced disclosure jobs keep bulk backfill and filing reprocess separate", () => {
  assert.deepEqual(
    getDisclosureAdvancedJobs().map((job) => job.label),
    ["Bulk Backfill", "Reprocess Filing"],
  );
});
