export interface UsaSpendingRecipientCandidate {
  recipientId: string;
  recipientName: string | null;
  parentRecipientName: string | null;
  uei: string | null;
  duns: string | null;
  displayLabel: string;
  matchScore: number;
  matchReasons: string[];
  source: "autocomplete" | "recipient_search";
}

export interface UsaSpendingRecipientSearchResponse {
  query: {
    q: string | null;
    ticker: string | null;
    company: string | null;
    limit: number;
  };
  count: number;
  bestMatch: UsaSpendingRecipientCandidate | null;
  candidates: UsaSpendingRecipientCandidate[];
  warnings?: Array<{
    status: number;
    detail: string | null;
  }>;
}

export interface UsaSpendingAwardResult {
  symbol: string;
  recipientName: string | null;
  recipientParentName: string | null;
  country: string | null;
  totalValue: number | null;
  actionDate: string | null;
  performanceStartDate: string | null;
  performanceEndDate: string | null;
  awardingAgencyName: string | null;
  awardingSubAgencyName: string | null;
  awardingOfficeName: string | null;
  performanceCountry: string | null;
  performanceCity: string | null;
  performanceCounty: string | null;
  performanceState: string | null;
  performanceZipCode: string | null;
  performanceCongressionalDistrict: string | null;
  awardDescription: string | null;
  naicsCode: string | null;
  permalink: string | null;
  awardId?: string | null;
  awardType?: string | null;
}

export interface UsaSpendingAwardSearchResponse {
  symbol: string;
  company?: string | null;
  from: string;
  to: string;
  count: number;
  recipient: {
    recipientId: string | null;
    recipientName: string | null;
    usedRecipientId: boolean;
    searchTerms: string[];
  };
  summary: {
    totalValue: number;
    averageAwardValue: number;
    agencyCount: number;
    topAgencyName: string | null;
    topAgencyValue: number | null;
  };
  data: UsaSpendingAwardResult[];
}

export function formatRecipientOption(candidate: UsaSpendingRecipientCandidate): string {
  const parts = [candidate.recipientName ?? candidate.parentRecipientName ?? candidate.recipientId];
  if (candidate.parentRecipientName && candidate.parentRecipientName !== candidate.recipientName) {
    parts.push(`parent: ${candidate.parentRecipientName}`);
  }
  if (candidate.uei) parts.push(`UEI ${candidate.uei}`);
  return parts.join(" · ");
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function buildUsaSpendingAwardUrl(generatedInternalId: string | null): string | null {
  if (!generatedInternalId) return null;
  return `https://www.usaspending.gov/award/${encodeURIComponent(generatedInternalId)}`;
}

export const USA_SPENDING_DIRECT_FIELDS = [
  "Award ID",
  "Recipient Name",
  "Award Amount",
  "Base Obligation Date",
  "Period of Performance Start Date",
  "Period of Performance Current End Date",
  "Awarding Agency",
  "Awarding Sub Agency",
  "Contract Award Type",
  "Description",
  "Place of Performance City Name",
  "Place of Performance State Code",
  "Place of Performance Zip5",
  "NAICS Code",
  "generated_internal_id",
];

export const USA_SPENDING_CONTRACT_CODES = ["A", "B", "C", "D"];

export function normalizeUsaSpendingAwardResponse(
  symbol: string,
  company: string,
  from: string,
  to: string,
  recipientName: string | null,
  raw: { results?: Array<Record<string, unknown>>; page_metadata?: { count?: number } }
): UsaSpendingAwardSearchResponse {
  const data = Array.isArray(raw.results) ? raw.results : [];
  const records = data
    .map((item) => ({
      symbol,
      recipientName: asTrimmedString(item["Recipient Name"]),
      recipientParentName: null,
      country: null,
      totalValue: asFiniteNumber(item["Award Amount"]),
      actionDate: asTrimmedString(item["Base Obligation Date"]),
      performanceStartDate: asTrimmedString(item["Period of Performance Start Date"]),
      performanceEndDate: asTrimmedString(item["Period of Performance Current End Date"]),
      awardingAgencyName: asTrimmedString(item["Awarding Agency"]),
      awardingSubAgencyName: asTrimmedString(item["Awarding Sub Agency"]),
      awardingOfficeName: null,
      performanceCountry: null,
      performanceCity: asTrimmedString(item["Place of Performance City Name"]),
      performanceCounty: null,
      performanceState: asTrimmedString(item["Place of Performance State Code"]),
      performanceZipCode: asTrimmedString(item["Place of Performance Zip5"]),
      performanceCongressionalDistrict: null,
      awardDescription: asTrimmedString(item["Description"]),
      naicsCode: asTrimmedString(item["NAICS Code"]),
      permalink: buildUsaSpendingAwardUrl(asTrimmedString(item["generated_internal_id"])),
      awardId: asTrimmedString(item["Award ID"]),
      awardType: asTrimmedString(item["Contract Award Type"]),
    }))
    .sort((a, b) => {
      const aTime = a.actionDate ? Date.parse(`${a.actionDate}T00:00:00Z`) : 0;
      const bTime = b.actionDate ? Date.parse(`${b.actionDate}T00:00:00Z`) : 0;
      return bTime - aTime;
    });

  const totalValue = records.reduce((sum, item) => sum + (item.totalValue ?? 0), 0);
  const agenciesByValue = new Map<string, number>();
  for (const record of records) {
    const agency = record.awardingAgencyName ?? "Unknown";
    agenciesByValue.set(agency, (agenciesByValue.get(agency) ?? 0) + (record.totalValue ?? 0));
  }
  const topAgencyEntry = [...agenciesByValue.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;

  return {
    symbol,
    company,
    from,
    to,
    count: raw.page_metadata?.count ?? records.length,
    recipient: {
      recipientId: null,
      recipientName,
      usedRecipientId: false,
      searchTerms: recipientName ? [recipientName] : [company],
    },
    summary: {
      totalValue,
      averageAwardValue: records.length ? totalValue / records.length : 0,
      agencyCount: agenciesByValue.size,
      topAgencyName: topAgencyEntry?.[0] ?? null,
      topAgencyValue: topAgencyEntry?.[1] ?? null,
    },
    data: records,
  };
}
