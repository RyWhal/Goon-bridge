import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGoogleAutocompleteQueries,
  getGoogleAutocompleteProbe,
  parseGoogleAutocompleteResponse,
  createGoogleAutocompleteLimiter,
} from "../src/lib/google-autocomplete.ts";

test("buildGoogleAutocompleteQueries produces a base probe plus optional follow-up probes", () => {
  assert.deepEqual(buildGoogleAutocompleteQueries("Nancy Pelosi"), [
    { key: "base", query: "Nancy Pelosi" },
    { key: "is", query: "Nancy Pelosi is" },
    { key: "does", query: "does Nancy Pelosi" },
  ]);
});

test("getGoogleAutocompleteProbe resolves a supported key and defaults to base", () => {
  assert.deepEqual(getGoogleAutocompleteProbe("Nancy Pelosi", "is"), {
    key: "is",
    query: "Nancy Pelosi is",
  });
  assert.deepEqual(getGoogleAutocompleteProbe("Nancy Pelosi", "unknown"), {
    key: "base",
    query: "Nancy Pelosi",
  });
});

test("parseGoogleAutocompleteResponse strips the repeated prefix into completions", () => {
  const parsed = parseGoogleAutocompleteResponse(
    "Rand Paul is",
    ["Rand Paul is", ["rand paul is a libertarian", "rand paul israel", "rand paul is he a doctor"]],
  );

  assert.deepEqual(parsed, [
    {
      text: "rand paul is a libertarian",
      completion: "a libertarian",
      relevance: null,
    },
    {
      text: "rand paul is he a doctor",
      completion: "he a doctor",
      relevance: null,
    },
  ]);
});

test("parseGoogleAutocompleteResponse drops suggestions that do not match the exact probe prefix", () => {
  const parsed = parseGoogleAutocompleteResponse("does Alexandria Ocasio-Cortez", [
    "does Alexandria Ocasio-Cortez",
    [
      "does alexandria ocasio-cortez speak spanish",
      "is alexandria ocasio-cortez married",
      "does alexandria ocasio-cortez have children",
      "alexandria ocasio-cortez age",
    ],
  ]);

  assert.deepEqual(parsed, [
    {
      text: "does alexandria ocasio-cortez speak spanish",
      completion: "speak spanish",
      relevance: null,
    },
    {
      text: "does alexandria ocasio-cortez have children",
      completion: "have children",
      relevance: null,
    },
  ]);
});

test("parseGoogleAutocompleteResponse keeps only the top 10 suggestions by google relevance", () => {
  const parsed = parseGoogleAutocompleteResponse("Nancy Pelosi", [
    "Nancy Pelosi",
    [
      "nancy pelosi one",
      "nancy pelosi two",
      "nancy pelosi three",
      "nancy pelosi four",
      "nancy pelosi five",
      "nancy pelosi six",
      "nancy pelosi seven",
      "nancy pelosi eight",
      "nancy pelosi nine",
      "nancy pelosi ten",
      "nancy pelosi eleven",
      "nancy pelosi twelve",
    ],
    [],
    [],
    {
      "google:suggestrelevance": [100, 400, 50, 90, 300, 80, 200, 10, 150, 70, 350, 60],
    },
  ]);

  assert.deepEqual(
    parsed.map((entry) => entry.text),
    [
      "nancy pelosi two",
      "nancy pelosi eleven",
      "nancy pelosi five",
      "nancy pelosi seven",
      "nancy pelosi nine",
      "nancy pelosi one",
      "nancy pelosi four",
      "nancy pelosi six",
      "nancy pelosi ten",
      "nancy pelosi twelve",
    ],
  );
  assert.equal(parsed.length, 10);
});

test("createGoogleAutocompleteLimiter waits until the minimum spacing elapses", async () => {
  let now = 0;
  const waits: number[] = [];
  const limiter = createGoogleAutocompleteLimiter({
    minIntervalMs: 5_000,
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });

  await limiter.waitTurn();
  now = 1_000;
  await limiter.waitTurn();

  assert.deepEqual(waits, [4_000]);
});
