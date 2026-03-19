import test from "node:test";
import assert from "node:assert/strict";
import { getPathForRoute, getRouteState } from "../src/lib/routes.ts";

test("experimental root still loads correlations", () => {
  assert.deepEqual(getRouteState("/experimental"), { page: "experimental", tab: "correlations" });
  assert.equal(getPathForRoute({ page: "experimental", tab: "correlations" }), "/experimental/correlations");
});

test("legacy experimental trades URL no longer resolves to the trades view", () => {
  assert.deepEqual(getRouteState("/experimental/trades"), { page: "main", tab: "members" });
});

test("main trades tab stays on the main page path", () => {
  assert.equal(getPathForRoute({ page: "main", tab: "trades" }), "/");
});
