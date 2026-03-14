const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONTRACT_AWARD_TYPE_CODES = ["A", "B", "C", "D"];
const AWARD_SEARCH_FIELDS = [
  "Award ID",
  "Recipient Name",
  "Award Amount",
  "Base Obligation Date",
  "Start Date",
  "End Date",
  "Awarding Agency",
  "Awarding Sub Agency",
  "Contract Award Type",
  "Description",
  "pop_city_name",
  "pop_state_code",
  "Place of Performance Zip5",
  "naics_code",
  "generated_internal_id",
];
const AWARD_SEARCH_MINIMAL_FIELDS = [
  "Award ID",
  "Recipient Name",
  "Award Amount",
  "Base Obligation Date",
  "Awarding Agency",
  "Awarding Sub Agency",
  "Contract Award Type",
  "Description",
  "generated_internal_id",
];

export type UsaSpendingAwardSearchRow = Record<string, unknown>;

export type UsaSpendingAwardSearchResponse = {
  results?: UsaSpendingAwardSearchRow[];
  page_metadata?: {
    count?: number;
  };
};

export type UsaSpendingRecipientCandidate = {
  recipientId: string;
  recipientName: string | null;
  parentRecipientName: string | null;
  uei: string | null;
  duns: string | null;
  displayLabel: string;
  matchScore: number;
  matchReasons: string[];
  source: "autocomplete" | "recipient_search";
  raw: Record<string, unknown>;
};

export function isValidDate(value: string | undefined): value is string {
  if (!value || !DATE_RE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed);
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stripCorporateSuffixes(value: string): string {
  return value
    .replace(
      /\b(inc|incorporated|corp|corporation|company|co|llc|ltd|limited|plc|holdings|holding|group)\b\.?/gi,
      ""
    )
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(value: string | null): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildRecipientSearchTerms(
  q: string | null,
  company: string | null,
  ticker: string | null
): string[] {
  const normalizedQuery = q?.trim() ?? null;
  const normalizedCompany = company?.trim() ?? null;
  const strippedCompany = normalizedCompany ? stripCorporateSuffixes(normalizedCompany) : null;
  const normalizedTicker = ticker?.trim() ?? null;
  const values = [
    normalizedQuery,
    normalizedCompany,
    strippedCompany,
    normalizedCompany ? null : normalizedTicker,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => !!value);

  return [...new Set(values)];
}

export function buildAwardSearchBodies(params: {
  from: string;
  to: string;
  recipientId?: string | null;
  recipientName?: string | null;
  recipientSearchTerms?: string[];
  limit?: number;
}): Array<Record<string, unknown>> {
  const limit = Math.max(1, Math.min(100, params.limit ?? 100));
  const baseBody = {
    fields: AWARD_SEARCH_FIELDS,
    page: 1,
    limit,
    sort: "Base Obligation Date",
    order: "desc",
  };

  const searchTerms = [
    params.recipientName,
    ...(params.recipientSearchTerms ?? []),
  ].filter((term, index, items): term is string => !!term && items.indexOf(term) === index);

  return searchTerms.map((term) => ({
    filters: {
      recipient_search_text: [term],
      time_period: [{ start_date: params.from, end_date: params.to }],
      award_type_codes: CONTRACT_AWARD_TYPE_CODES,
    },
  })).flatMap((filters) => [
    {
      ...baseBody,
      ...filters,
    },
    {
      fields: AWARD_SEARCH_FIELDS,
      page: 1,
      limit: Math.min(limit, 50),
      sort: "Base Obligation Date",
      order: "desc",
      ...filters,
    },
    {
      fields: AWARD_SEARCH_MINIMAL_FIELDS,
      page: 1,
      limit: Math.min(limit, 25),
      sort: "Base Obligation Date",
      order: "desc",
      ...filters,
    },
  ]);
}

function coalesceString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return null;
}

function scoreCandidate(params: {
  recipientName: string | null;
  parentRecipientName: string | null;
  query: string | null;
  company: string | null;
  ticker: string | null;
}): { score: number; reasons: string[] } {
  const searchInputs = [params.query, params.company, params.company ? stripCorporateSuffixes(params.company) : null]
    .map(normalizeName)
    .filter(Boolean);
  const ticker = normalizeName(params.ticker);
  const names = [params.recipientName, params.parentRecipientName]
    .map(normalizeName)
    .filter(Boolean);

  let score = 0;
  const reasons: string[] = [];

  for (const input of searchInputs) {
    for (const name of names) {
      if (!input || !name) continue;
      if (name === input) {
        score += 120;
        reasons.push("exact_name");
      } else if (name.startsWith(input)) {
        score += 80;
        reasons.push("prefix_name");
      } else if (name.includes(input) || input.includes(name)) {
        score += 45;
        reasons.push("partial_name");
      }
    }
  }

  if (ticker) {
    for (const name of names) {
      if (name === ticker) {
        score += 40;
        reasons.push("ticker_exact");
      } else if (name.includes(ticker)) {
        score += 15;
        reasons.push("ticker_partial");
      }
    }
  }

  if (!reasons.length && names.length) {
    score = 5;
    reasons.push("weak_match");
  }

  return { score, reasons: [...new Set(reasons)] };
}

export function normalizeRecipientCandidate(
  record: Record<string, unknown>,
  source: "autocomplete" | "recipient_search",
  context: {
    query: string | null;
    company: string | null;
    ticker: string | null;
  }
): UsaSpendingRecipientCandidate | null {
  const recipientId = coalesceString(record, [
    "recipient_id",
    "recipientId",
    "recipient_hash",
    "recipientHash",
    "legal_entity_id",
    "legalEntityId",
    "id",
  ]);
  if (!recipientId) return null;

  const recipientName = coalesceString(record, [
    "recipient_name",
    "recipientName",
    "name",
    "legal_business_name",
    "legalBusinessName",
  ]);
  const parentRecipientName = coalesceString(record, [
    "parent_recipient_name",
    "parentRecipientName",
    "parent_name",
    "parentName",
    "ultimate_parent_legal_enti",
  ]);
  const uei = coalesceString(record, ["uei", "uei_number", "ueiNumber"]);
  const duns = coalesceString(record, ["duns", "duns_number", "dunsNumber"]);
  const { score, reasons } = scoreCandidate({
    recipientName,
    parentRecipientName,
    query: context.query,
    company: context.company,
    ticker: context.ticker,
  });

  return {
    recipientId,
    recipientName,
    parentRecipientName,
    uei,
    duns,
    displayLabel: recipientName ?? parentRecipientName ?? recipientId,
    matchScore: score,
    matchReasons: reasons,
    source,
    raw: record,
  };
}

export function dedupeRecipientCandidates(
  candidates: UsaSpendingRecipientCandidate[]
): UsaSpendingRecipientCandidate[] {
  const byId = new Map<string, UsaSpendingRecipientCandidate>();

  for (const candidate of candidates) {
    const existing = byId.get(candidate.recipientId);
    if (!existing || candidate.matchScore > existing.matchScore) {
      byId.set(candidate.recipientId, candidate);
      continue;
    }

    byId.set(candidate.recipientId, {
      ...existing,
      recipientName: existing.recipientName ?? candidate.recipientName,
      parentRecipientName: existing.parentRecipientName ?? candidate.parentRecipientName,
      uei: existing.uei ?? candidate.uei,
      duns: existing.duns ?? candidate.duns,
      matchReasons: [...new Set([...existing.matchReasons, ...candidate.matchReasons])],
    });
  }

  return [...byId.values()].sort((a, b) => {
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    return (a.recipientName ?? a.displayLabel).localeCompare(b.recipientName ?? b.displayLabel);
  });
}

export function makeAwardUrl(generatedInternalId: string | null): string | null {
  if (!generatedInternalId) return null;
  return `https://www.usaspending.gov/award/${encodeURIComponent(generatedInternalId)}`;
}

export function normalizeAwardSearchResults(
  rows: Record<string, unknown>[],
  symbol: string
) {
  return rows
    .map((item) => ({
      symbol,
      recipientName: asString(item["Recipient Name"]),
      recipientParentName: null,
      country: null,
      totalValue: asNumber(item["Award Amount"]),
      actionDate: asString(item["Base Obligation Date"]),
      performanceStartDate: asString(item["Start Date"]),
      performanceEndDate: asString(item["End Date"]),
      awardingAgencyName: asString(item["Awarding Agency"]),
      awardingSubAgencyName: asString(item["Awarding Sub Agency"]),
      awardingOfficeName: null,
      performanceCountry: null,
      performanceCity: asString(item["pop_city_name"]),
      performanceCounty: null,
      performanceState: asString(item["pop_state_code"]),
      performanceZipCode: asString(item["Place of Performance Zip5"]),
      performanceCongressionalDistrict: null,
      awardDescription: asString(item["Description"]),
      naicsCode: asString(item["naics_code"]),
      permalink: makeAwardUrl(asString(item["generated_internal_id"])),
      awardId: asString(item["Award ID"]),
      awardType: asString(item["Contract Award Type"]),
    }))
    .sort((a, b) => {
      const aTime = a.actionDate ? Date.parse(`${a.actionDate}T00:00:00Z`) : 0;
      const bTime = b.actionDate ? Date.parse(`${b.actionDate}T00:00:00Z`) : 0;
      return bTime - aTime;
    });
}

export function summarizeAwards(
  records: Array<{ totalValue: number | null; awardingAgencyName: string | null }>
) {
  const totalValue = records.reduce((sum, item) => sum + (item.totalValue ?? 0), 0);
  const agenciesByValue = new Map<string, number>();

  for (const record of records) {
    const agency = record.awardingAgencyName ?? "Unknown";
    agenciesByValue.set(agency, (agenciesByValue.get(agency) ?? 0) + (record.totalValue ?? 0));
  }

  const topAgencyEntry = [...agenciesByValue.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;

  return {
    totalValue,
    averageAwardValue: records.length ? totalValue / records.length : 0,
    agencyCount: agenciesByValue.size,
    topAgencyName: topAgencyEntry?.[0] ?? null,
    topAgencyValue: topAgencyEntry?.[1] ?? null,
  };
}
