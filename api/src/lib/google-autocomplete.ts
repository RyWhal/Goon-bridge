type GoogleAutocompletePayload = [string, unknown[]?, ...unknown[]];

export type GoogleAutocompleteProbeKey = "base" | "is" | "does";

export type GoogleAutocompleteProbe = {
  key: GoogleAutocompleteProbeKey;
  query: string;
};

export type GoogleAutocompleteSuggestion = {
  text: string;
  completion: string;
  relevance: number | null;
};

const MAX_GOOGLE_AUTOCOMPLETE_RESULTS = 10;

export function buildGoogleAutocompleteQueries(memberName: string): GoogleAutocompleteProbe[] {
  const trimmedName = memberName.trim();
  return [
    { key: "base", query: trimmedName },
    { key: "is", query: `${trimmedName} is` },
    { key: "does", query: `does ${trimmedName}` },
  ];
}

export function getGoogleAutocompleteProbe(memberName: string, probeKey: string | undefined): GoogleAutocompleteProbe {
  const probes = buildGoogleAutocompleteQueries(memberName);
  return probes.find((probe) => probe.key === probeKey) ?? probes[0]!;
}

export function parseGoogleAutocompleteResponse(
  query: string,
  payload: GoogleAutocompletePayload,
): GoogleAutocompleteSuggestion[] {
  const suggestions = Array.isArray(payload[1]) ? payload[1] : [];
  const normalizedQuery = query.trim();
  const metadata = isRecord(payload[4]) ? payload[4] : null;
  const relevanceScores = Array.isArray(metadata?.["google:suggestrelevance"])
    ? metadata["google:suggestrelevance"]
    : [];

  return suggestions
    .map((value, index) => ({ value, index }))
    .filter((entry): entry is { value: string; index: number } => typeof entry.value === "string" && entry.value.trim().length > 0)
    .filter(({ value }) => matchesExactProbe(value.trim(), normalizedQuery))
    .map(({ value, index }) => {
      const text = value;
      const normalizedText = text.trim();
      const completion = stripExactProbePrefix(normalizedText, normalizedQuery);
      const rawRelevance = relevanceScores[index];
      const relevance = typeof rawRelevance === "number" && Number.isFinite(rawRelevance)
        ? rawRelevance
        : null;

      return {
        text: normalizedText,
        completion,
        relevance,
        index,
      };
    })
    .sort((left, right) => {
      const leftScore = left.relevance ?? Number.NEGATIVE_INFINITY;
      const rightScore = right.relevance ?? Number.NEGATIVE_INFINITY;
      if (rightScore !== leftScore) return rightScore - leftScore;
      return left.index - right.index;
    })
    .slice(0, MAX_GOOGLE_AUTOCOMPLETE_RESULTS)
    .map(({ index: _index, ...suggestion }) => suggestion);
}

type LimiterOptions = {
  minIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export function createGoogleAutocompleteLimiter({
  minIntervalMs,
  now = () => Date.now(),
  sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: LimiterOptions) {
  let nextAvailableAt = 0;

  return {
    async waitTurn() {
      const currentTime = now();
      const waitMs = Math.max(0, nextAvailableAt - currentTime);
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      nextAvailableAt = Math.max(currentTime, nextAvailableAt) + minIntervalMs;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function matchesExactProbe(text: string, query: string) {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  return lowerText === lowerQuery || lowerText.startsWith(`${lowerQuery} `);
}

function stripExactProbePrefix(text: string, query: string) {
  if (text.length === query.length) {
    return text.trim();
  }

  return text.slice(query.length).trim();
}
