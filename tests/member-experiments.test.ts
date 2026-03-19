import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGoogleSearchUrl,
  canShowGoogleAutocompleteExperiment,
  formatGoogleAutocompleteProbeHeading,
  getGoogleAutocompleteOptionalProbeKeys,
  isGoogleAutocompleteDataCurrent,
  shouldLoadGoogleAutocomplete,
  summarizeAutocompleteCompletions,
} from "../src/lib/member-experiments.ts";

test("google autocomplete experiment is available for any member with a bioguide id", () => {
  assert.equal(canShowGoogleAutocompleteExperiment("P000197"), true);
  assert.equal(canShowGoogleAutocompleteExperiment("P000603"), true);
  assert.equal(canShowGoogleAutocompleteExperiment("O000172"), true);
  assert.equal(canShowGoogleAutocompleteExperiment("M000355"), true);
  assert.equal(canShowGoogleAutocompleteExperiment(""), false);
});

test("summarizeAutocompleteCompletions favors parsed completion text when available", () => {
  assert.deepEqual(
    summarizeAutocompleteCompletions([
      { text: "nancy pelosi stock tracker", completion: "stock tracker" },
      { text: "nancy pelosi age", completion: "age" },
      { text: "nancy pelosi", completion: "" },
    ]),
    ["stock tracker", "age", "nancy pelosi"],
  );
});

test("shouldLoadGoogleAutocomplete only fetches for eligible expanded open sections", () => {
  assert.equal(
    shouldLoadGoogleAutocomplete({ bioguideId: "P000197", isExpanded: true, isOpen: true }),
    true,
  );
  assert.equal(
    shouldLoadGoogleAutocomplete({ bioguideId: "P000197", isExpanded: true, isOpen: false }),
    false,
  );
  assert.equal(
    shouldLoadGoogleAutocomplete({ bioguideId: "M000355", isExpanded: true, isOpen: true }),
    true,
  );
  assert.equal(
    shouldLoadGoogleAutocomplete({ bioguideId: "P000197", isExpanded: false, isOpen: true }),
    false,
  );
});

test("buildGoogleSearchUrl encodes suggestion text into a google search link", () => {
  assert.equal(
    buildGoogleSearchUrl("nancy pelosi stock tracker"),
    "https://www.google.com/search?q=nancy+pelosi+stock+tracker",
  );
});

test("isGoogleAutocompleteDataCurrent only accepts results for the active member", () => {
  assert.equal(
    isGoogleAutocompleteDataCurrent("P000603", { bioguideId: "P000603" }),
    true,
  );
  assert.equal(
    isGoogleAutocompleteDataCurrent("P000603", { bioguideId: "O000172" }),
    false,
  );
  assert.equal(
    isGoogleAutocompleteDataCurrent("P000603", null),
    false,
  );
});

test("formatGoogleAutocompleteProbeHeading shows the raw query without synthetic labels", () => {
  assert.equal(
    formatGoogleAutocompleteProbeHeading("Nancy Pelosi"),
    "Nancy Pelosi...",
  );
  assert.equal(
    formatGoogleAutocompleteProbeHeading("does Nancy Pelosi"),
    "does Nancy Pelosi...",
  );
  assert.equal(
    formatGoogleAutocompleteProbeHeading("Nancy Pelosi is"),
    "Nancy Pelosi is",
  );
});

test("getGoogleAutocompleteOptionalProbeKeys excludes probes that are already loaded", () => {
  assert.deepEqual(getGoogleAutocompleteOptionalProbeKeys(["base"]), ["is", "does"]);
  assert.deepEqual(getGoogleAutocompleteOptionalProbeKeys(["base", "is"]), ["does"]);
  assert.deepEqual(getGoogleAutocompleteOptionalProbeKeys(["base", "is", "does"]), []);
});
