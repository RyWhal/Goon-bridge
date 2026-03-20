import test from "node:test";
import assert from "node:assert/strict";
import {
  getKnownGoodPolicyMapBrowserEvidence,
  getKnownGoodPolicyMapBrowserTestcase,
  POLICY_MAP_BROWSER_TESTCASE_QUERY_PARAM,
} from "../src/lib/policy-map-browser-testcase.ts";

test("known-good policy map browser testcase contains a visible defense mapping and evidence trail", () => {
  const testcase = getKnownGoodPolicyMapBrowserTestcase();

  assert.equal(POLICY_MAP_BROWSER_TESTCASE_QUERY_PARAM, "known-good");
  assert.equal(testcase.policy_area, "DEFENSE");
  assert.equal(testcase.count, 1);
  assert.equal(testcase.rows[0]?.committee?.name, "Armed Services");
  assert.equal(testcase.rows[0]?.committee?.chamber, "House");
  assert.equal(testcase.rows[0]?.bill_count, 2);
  assert.equal(testcase.rows[0]?.evidence_count, 2);
  assert.equal(testcase.rows[0]?.committee?.committee_key, "ARMED SERVICES:House");
  assert.equal(testcase.rows[0]?.id, 11);
  assert.equal(testcase.rows[0]?.evidence_count, testcase.rows[0]?.committee ? 2 : 0);

  const evidence = getKnownGoodPolicyMapBrowserEvidence();

  assert.equal(evidence.map_id, 11);
  assert.equal(evidence.count, 2);
  assert.equal(evidence.evidence[0]?.source_table, "bills");
  assert.equal(evidence.evidence[0]?.source_row_id, "9001");
  assert.equal((evidence.evidence[0]?.evidence_payload.bill_id as number | undefined), 9001);
  assert.equal(evidence.evidence[1]?.source_row_id, "9002");
  assert.equal((evidence.evidence[1]?.evidence_payload.bill_id as number | undefined), 9002);
});
