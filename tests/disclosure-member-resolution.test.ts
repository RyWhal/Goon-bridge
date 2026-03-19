import test from "node:test";
import assert from "node:assert/strict";
import { resolveMemberBioguideMatch } from "../api/src/lib/member-resolution.ts";

const members = [
  {
    bioguide_id: "A000372",
    name: "Allen, Rick W.",
    direct_order_name: null,
    state: "Georgia",
    chamber: "House",
  },
  {
    bioguide_id: "B001292",
    name: "Beyer, Donald S.",
    direct_order_name: null,
    state: "Virginia",
    chamber: "House",
  },
  {
    bioguide_id: "D000530",
    name: "Delaney, April McClain",
    direct_order_name: "April McClain Delaney",
    state: "Maryland",
    chamber: "House",
  },
];

test("resolveMemberBioguideMatch scores nickname matches as medium confidence", () => {
  assert.deepEqual(
    resolveMemberBioguideMatch(members, {
      memberName: "Allen, Richard W.",
      state: "GA",
      chamber: "House",
    }),
    {
      bioguideId: "A000372",
      confidence: "medium",
      score: 93,
      reason: "nickname_plus_state",
    },
  );
});

test("resolveMemberBioguideMatch scores exact names as high confidence", () => {
  assert.deepEqual(
    resolveMemberBioguideMatch(members, {
      memberName: "Delaney, April McClain",
      state: "MD",
      chamber: "House",
    }),
    {
      bioguideId: "D000530",
      confidence: "high",
      score: 105,
      reason: "exact_full_name",
    },
  );
});

test("resolveMemberBioguideMatch scores initial matches as low confidence", () => {
  assert.deepEqual(
    resolveMemberBioguideMatch(members, {
      memberName: "Beyer, D.",
      state: "VA",
      chamber: "House",
    }),
    {
      bioguideId: "B001292",
      confidence: "low",
      score: 80,
      reason: "initial_plus_state",
    },
  );
});
