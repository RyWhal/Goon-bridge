export type GoogleAutocompleteProbeKey = "base" | "is" | "does";

const OPTIONAL_GOOGLE_AUTOCOMPLETE_PROBE_KEYS: GoogleAutocompleteProbeKey[] = ["is", "does"];

export type AutocompleteSuggestionSummary = {
  text: string;
  completion: string;
};

export function canShowGoogleAutocompleteExperiment(bioguideId: string | null | undefined) {
  return Boolean(bioguideId);
}

export function summarizeAutocompleteCompletions(suggestions: AutocompleteSuggestionSummary[]) {
  return suggestions.map((suggestion) => suggestion.completion.trim() || suggestion.text.trim());
}

export function shouldLoadGoogleAutocomplete({
  bioguideId,
  isExpanded,
  isOpen,
}: {
  bioguideId: string | null | undefined;
  isExpanded: boolean;
  isOpen: boolean;
}) {
  return Boolean(isExpanded && isOpen && canShowGoogleAutocompleteExperiment(bioguideId));
}

export function buildGoogleSearchUrl(query: string) {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", query);
  return url.toString();
}

export function isGoogleAutocompleteDataCurrent(
  bioguideId: string | null | undefined,
  data: { bioguideId?: string | null } | null | undefined,
) {
  if (!bioguideId || !data?.bioguideId) return false;
  return data.bioguideId === bioguideId;
}

export function formatGoogleAutocompleteProbeHeading(query: string) {
  const trimmed = query.trim();
  if (!trimmed) return "";
  return trimmed.toLowerCase().endsWith(" is") ? trimmed : `${trimmed}...`;
}

export function getGoogleAutocompleteOptionalProbeKeys(
  loadedProbeKeys: GoogleAutocompleteProbeKey[],
) {
  const loaded = new Set<GoogleAutocompleteProbeKey>(loadedProbeKeys);
  return OPTIONAL_GOOGLE_AUTOCOMPLETE_PROBE_KEYS.filter((probeKey) => !loaded.has(probeKey));
}
