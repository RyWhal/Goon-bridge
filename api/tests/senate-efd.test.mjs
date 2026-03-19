import test from "node:test";
import assert from "node:assert/strict";

import {
  SenateEfdUnavailableError,
  isSenateMaintenanceResponse,
  summarizeUpstreamHtml,
  shouldRetrySenateEfdRequest,
} from "../src/lib/senate-efd.ts";

test("isSenateMaintenanceResponse detects the maintenance page", () => {
  assert.equal(
    isSenateMaintenanceResponse(
      503,
      '<html><head><title>U.S. Senate: Site Under Maintenance</title></head><body></body></html>'
    ),
    true
  );
  assert.equal(isSenateMaintenanceResponse(503, "<html><body>Service unavailable</body></html>"), false);
});

test("summarizeUpstreamHtml strips tags and compresses whitespace", () => {
  assert.equal(
    summarizeUpstreamHtml("<html><body><h1>Site Under Maintenance</h1>\n<p>Retry later.</p></body></html>", 80),
    "Site Under Maintenance Retry later."
  );
});

test("shouldRetrySenateEfdRequest retries transient failures but not final attempts", () => {
  assert.equal(shouldRetrySenateEfdRequest(503, "Site Under Maintenance", 1, 3), true);
  assert.equal(shouldRetrySenateEfdRequest(503, "Site Under Maintenance", 3, 3), false);
  assert.equal(shouldRetrySenateEfdRequest(502, "Bad Gateway", 1, 3), true);
  assert.equal(shouldRetrySenateEfdRequest(500, "Internal Error", 1, 3), false);
});

test("SenateEfdUnavailableError preserves the upstream status", () => {
  const error = new SenateEfdUnavailableError("maintenance", 503);
  assert.equal(error.status, 503);
  assert.equal(error.retryable, true);
});
