import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./db-types.ts";
import { ensureOrganization, materializeMemberRelationships, normalizeOrganizationName, resolveOrganizationId } from "./relationships.ts";
import {
  SenateEfdUnavailableError,
  isSenateMaintenanceResponse,
  shouldRetrySenateEfdRequest,
  summarizeUpstreamHtml,
} from "./senate-efd.ts";
import { sanitizeJsonStrings, sanitizePostgresText } from "./unicode-safety.ts";

type DbClient = SupabaseClient;
type JsonRecord = Record<string, unknown>;

const DISCLOSURE_PARSER_VERSION = "v2";
const SENATE_HOME_URL = "https://efdsearch.senate.gov/search/home/";
const SENATE_SEARCH_URL = "https://efdsearch.senate.gov/search/";
const SENATE_REPORT_DATA_URL = "https://efdsearch.senate.gov/search/report/data/";
const HOUSE_INDEX_BASE_URL = "https://disclosures-clerk.house.gov/public_disc/financial-pdfs";
const HOUSE_PTR_BASE_URL = "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs";

const AMOUNT_RANGE_RE = /\$[\d,]+(?:\.\d+)?\s*-\s*\$[\d,]+(?:\.\d+)?/;
const TRADE_TYPE_RE = /\b(Purchase|Sale|Exchange|Partial Sale|Partial Purchase|P(?:\s*\(partial\))?|S(?:\s*\(partial\))?|E)\b/i;
const PDF_LITERAL_RE = /\((?:\\.|[^\\()])*\)\s*Tj/g;
const PDF_ARRAY_RE = /\[(.*?)\]\s*TJ/gs;
const UNWANTED_ASSET_KEYWORDS = [
  "ETF",
  "FUND",
  "MUTUAL",
  "TREASURY",
  "BOND",
  "NOTE",
  "OPTION",
  "PUT",
  "CALL",
  "CRYPTO",
  "BITCOIN",
  "TRUST",
  "INDEX",
];
const OWNER_LABEL_MAP: Record<string, string> = {
  SP: "spouse",
  DC: "dependent_child",
  JT: "joint",
  SELF: "self",
};
const FALLBACK_TEXT_SIGNAL_RE = /\b(periodic transaction report|name:|filer:|purchase|sale|exchange|transaction date|notification date)\b/i;

type DisclosureFilingInsert = Database["public"]["Tables"]["disclosure_filings"]["Insert"];
type DisclosureTradeRowInsert = Database["public"]["Tables"]["disclosure_trade_rows"]["Insert"];
type MemberStockTradeInsert = Database["public"]["Tables"]["member_stock_trades"]["Insert"];

type DisclosureSourceFiling = {
  chamber: "House" | "Senate";
  sourceType: string;
  filingIdentifier: string;
  sourceRowKey: string;
  filingType: string | null;
  memberName: string | null;
  memberFirstName: string | null;
  memberLastName: string | null;
  memberState: string | null;
  candidateState: string | null;
  documentUrl: string | null;
  archiveUrl: string | null;
  filedDate: string | null;
  disclosureDate: string | null;
  rawMetadata: JsonRecord;
  binaryContent?: ArrayBuffer | null;
};

type ParsedTradeRow = {
  rowOrdinal: number;
  ownerLabel: string | null;
  ownerType: string | null;
  assetName: string | null;
  normalizedAssetName: string | null;
  assetType: string | null;
  symbolGuess: string | null;
  transactionType: string | null;
  transactionDate: string | null;
  notificationDate: string | null;
  amountRange: string | null;
  shareCount: number | null;
  shareCountSource: "pdf_exact" | null;
  isPublicEquity: boolean;
  parseConfidence: string;
  quarantineReason: string | null;
  rawPayload: JsonRecord;
};

type DisclosureRefreshOptions = {
  from: string;
  to: string;
  limit?: number;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toIsoDate(value: string | null | undefined): string | null {
  const normalized = asString(value);
  if (!normalized) return null;

  const isoMatch = normalized.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];

  const usMatch = normalized.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (usMatch) {
    const month = usMatch[1].padStart(2, "0");
    const day = usMatch[2].padStart(2, "0");
    const rawYear = usMatch[3];
    const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    return `${year}-${month}-${day}`;
  }

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function extractExplicitShareCount(text: string): number | null {
  const match = text.match(/\b(\d[\d,]*(?:\.\d+)?)\s*(?:shares?|shrs?)\b/i);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1]!.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function isDateInWindow(value: string | null, from: string, to: string): boolean {
  if (!value) return false;
  return value >= from && value <= to;
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function jsonRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function ensureAbsoluteUrl(base: string, maybeRelative: string | null): string | null {
  if (!maybeRelative) return null;
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
}

function formatSenateDate(date: string) {
  const parsed = new Date(`${date}T00:00:00Z`);
  const month = `${parsed.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${parsed.getUTCDate()}`.padStart(2, "0");
  const year = parsed.getUTCFullYear();
  return `${month}/${day}/${year}`;
}

function normalizeState(value?: string | null): string | null {
  const normalized = asString(value)?.toUpperCase() ?? null;
  if (!normalized) return null;
  if (normalized.length === 2) return normalized;
  const compact = normalized.replace(/[^A-Z ]+/g, " ").replace(/\s+/g, " ").trim();
  const states: Record<string, string> = {
    ALABAMA: "AL",
    ALASKA: "AK",
    ARIZONA: "AZ",
    ARKANSAS: "AR",
    CALIFORNIA: "CA",
    COLORADO: "CO",
    CONNECTICUT: "CT",
    DELAWARE: "DE",
    FLORIDA: "FL",
    GEORGIA: "GA",
    HAWAII: "HI",
    IDAHO: "ID",
    ILLINOIS: "IL",
    INDIANA: "IN",
    IOWA: "IA",
    KANSAS: "KS",
    KENTUCKY: "KY",
    LOUISIANA: "LA",
    MAINE: "ME",
    MARYLAND: "MD",
    MASSACHUSETTS: "MA",
    MICHIGAN: "MI",
    MINNESOTA: "MN",
    MISSISSIPPI: "MS",
    MISSOURI: "MO",
    MONTANA: "MT",
    NEBRASKA: "NE",
    NEVADA: "NV",
    "NEW HAMPSHIRE": "NH",
    "NEW JERSEY": "NJ",
    "NEW MEXICO": "NM",
    "NEW YORK": "NY",
    "NORTH CAROLINA": "NC",
    "NORTH DAKOTA": "ND",
    OHIO: "OH",
    OKLAHOMA: "OK",
    OREGON: "OR",
    PENNSYLVANIA: "PA",
    "RHODE ISLAND": "RI",
    "SOUTH CAROLINA": "SC",
    "SOUTH DAKOTA": "SD",
    TENNESSEE: "TN",
    TEXAS: "TX",
    UTAH: "UT",
    VERMONT: "VT",
    VIRGINIA: "VA",
    WASHINGTON: "WA",
    "WEST VIRGINIA": "WV",
    WISCONSIN: "WI",
    WYOMING: "WY",
    "DISTRICT OF COLUMBIA": "DC",
  };
  return states[compact] ?? null;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function arrayBufferToText(data: ArrayBuffer): Promise<string> {
  return new TextDecoder("latin1").decode(data);
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodePdfEscapes(value: string): string {
  return value
    .replace(/\\([\\()])/g, "$1")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\(\d{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

async function extractPdfText(data: ArrayBuffer): Promise<{ text: string | null; method: string; status: string; diagnostics: JsonRecord }> {
  const raw = await arrayBufferToText(data);
  const literalSegments = [...raw.matchAll(PDF_LITERAL_RE)]
    .map((match) => match[0].replace(/\)\s*Tj$/, ""))
    .map((value) => value.slice(1))
    .map(decodePdfEscapes);

  const arraySegments = [...raw.matchAll(PDF_ARRAY_RE)]
    .flatMap((match) => [...match[1].matchAll(/\((?:\\.|[^\\()])*\)/g)])
    .map((nested) => nested[0].slice(1, -1))
    .map(decodePdfEscapes);

  const combined = [...literalSegments, ...arraySegments]
    .map((segment) => normalizeExtractedText(segment))
    .filter(Boolean)
    .join("\n")
    .replace(/\n{2,}/g, "\n");

  if (combined.length >= 120) {
    return {
      text: combined,
      method: "pdf_literal_text",
      status: "success",
      diagnostics: {
        literalSegments: literalSegments.length,
        arraySegments: arraySegments.length,
      },
    };
  }

  const fallbackSegments = raw
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 20);
  const fallbackText = fallbackSegments.join("\n");

  if (fallbackText.length >= 120 && FALLBACK_TEXT_SIGNAL_RE.test(fallbackText)) {
    return {
      text: fallbackText,
      method: "pdf_printable_fallback",
      status: "partial",
      diagnostics: {
        literalSegments: literalSegments.length,
        arraySegments: arraySegments.length,
        fallbackPreview: fallbackText.slice(0, 500),
      },
    };
  }

  return {
    text: null,
    method: "pdf_text_extraction_failed",
    status: "failed",
    diagnostics: {
      literalSegments: literalSegments.length,
      arraySegments: arraySegments.length,
      preview: raw.slice(0, 500),
    },
  };
}

function normalizeTradeType(value: string | null): string | null {
  const upper = asString(value)?.toUpperCase() ?? null;
  if (!upper) return null;
  if (upper === "P" || upper.startsWith("P (")) return "purchase";
  if (upper === "S" || upper.startsWith("S (")) return "sale";
  if (upper === "E") return "exchange";
  if (upper.includes("PARTIAL SALE")) return "sale";
  if (upper.includes("PARTIAL PURCHASE")) return "purchase";
  if (upper.includes("PURCHASE")) return "purchase";
  if (upper.includes("SALE")) return "sale";
  if (upper.includes("EXCHANGE")) return "exchange";
  return upper.toLowerCase();
}

function classifyAsset(assetName: string | null, symbolGuess: string | null) {
  const normalized = normalizeOrganizationName(assetName ?? "");
  if (!normalized) {
    return {
      assetType: "unknown",
      isPublicEquity: false,
      quarantineReason: "missing_asset_name",
    };
  }

  if (UNWANTED_ASSET_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return {
      assetType: "unsupported_asset",
      isPublicEquity: false,
      quarantineReason: "unsupported_asset_type",
    };
  }

  if (symbolGuess || /\b(STOCK|SHARES|CORP|CORPORATION|INC|INCORPORATED|PLC|HOLDINGS)\b/.test(normalized)) {
    return {
      assetType: "public_equity",
      isPublicEquity: true,
      quarantineReason: null,
    };
  }

  return {
    assetType: "unknown",
    isPublicEquity: false,
    quarantineReason: "ambiguous_asset_label",
  };
}

function extractTickerGuess(assetName: string | null): string | null {
  const value = asString(assetName);
  if (!value) return null;
  const parenMatch = value.match(/\(([A-Z.\-]{1,6})\)/);
  if (parenMatch?.[1]) return parenMatch[1].replace(/\./g, "").toUpperCase();
  const suffixMatch = value.match(/\b([A-Z]{1,5})\b$/);
  return suffixMatch?.[1] ? suffixMatch[1].toUpperCase() : null;
}

function normalizeOwnerLabel(ownerLabel: string | null): { label: string | null; ownerType: string | null } {
  const upper = asString(ownerLabel)?.toUpperCase() ?? null;
  if (!upper) return { label: null, ownerType: null };
  return {
    label: upper,
    ownerType: OWNER_LABEL_MAP[upper] ?? upper.toLowerCase().replace(/\s+/g, "_"),
  };
}

function isHouseDisclosureText(text: string): boolean {
  return /clerk of the house of representatives/i.test(text) || /\bfiling id #\d+\b/i.test(text);
}

function matchHouseTradeType(value: string): RegExpMatchArray | null {
  return value.match(/^(?:(P|S|E)(?:\s*\(partial\))?(?=\s|$)|(Purchase|Sale|Exchange|Partial Sale|Partial Purchase)(?=\s|$))/i);
}

function parseHouseTradeRowsFromText(text: string): ParsedTradeRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const rows: ParsedTradeRow[] = [];
  const ownerStartRe = /^(SP|DC|JT|SELF)\b\s*(.*)$/i;
  const footerRe = /^(I CERTIFY|Digitally Signed:|Filing ID #)/i;

  let i = 0;
  while (i < lines.length) {
    const ownerStart = lines[i].match(ownerStartRe);
    if (!ownerStart) {
      i += 1;
      continue;
    }

    const ownerLabel = ownerStart[1].toUpperCase();
    const inlineAsset = ownerStart[2]?.trim() ?? "";
    i += 1;

    const assetLines: string[] = inlineAsset ? [inlineAsset] : [];
    while (i < lines.length && !matchHouseTradeType(lines[i]) && !footerRe.test(lines[i])) {
      assetLines.push(lines[i]);
      i += 1;
    }
    if (i >= lines.length || !matchHouseTradeType(lines[i])) {
      continue;
    }

    const tradeLine = lines[i];
    const tradeTypeMatch = matchHouseTradeType(tradeLine);
    if (!tradeTypeMatch) continue;
    const tradeType = tradeTypeMatch[0];
    i += 1;

    const detailLines = [tradeLine];
    while (i < lines.length && !ownerStartRe.test(lines[i]) && !footerRe.test(lines[i])) {
      detailLines.push(lines[i]);
      const joined = detailLines.join(" ");
      if (AMOUNT_RANGE_RE.test(joined)) break;
      i += 1;
    }

    const joinedDetails = detailLines.join(" ");
    const dates = [...joinedDetails.matchAll(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g)].map((match) => match[0]);
    const amountMatch = joinedDetails.match(AMOUNT_RANGE_RE);
    if (!amountMatch) continue;
    const shareCount = extractExplicitShareCount(joinedDetails);

    while (i < lines.length && !ownerStartRe.test(lines[i]) && !footerRe.test(lines[i])) {
      i += 1;
    }

    const assetName = assetLines.join(" ").trim();
    const owner = normalizeOwnerLabel(ownerLabel);
    const symbolGuess = extractTickerGuess(assetName);
    const assetClassification = classifyAsset(assetName, symbolGuess);
    const rawText = [ownerLabel, assetName, tradeType, ...dates, amountMatch[0]].join(" ");

    rows.push({
      rowOrdinal: rows.length + 1,
      ownerLabel: owner.label,
      ownerType: owner.ownerType,
      assetName: assetName || null,
      normalizedAssetName: assetName ? normalizeOrganizationName(assetName) : null,
      assetType: assetClassification.assetType,
      symbolGuess,
      transactionType: normalizeTradeType(tradeType),
      transactionDate: toIsoDate(dates[0] ?? null),
      notificationDate: toIsoDate(dates[1] ?? null),
      amountRange: amountMatch[0],
      shareCount,
      shareCountSource: shareCount != null ? "pdf_exact" : null,
      isPublicEquity: assetClassification.isPublicEquity,
      parseConfidence: symbolGuess ? "high" : assetClassification.isPublicEquity ? "medium" : "low",
      quarantineReason: assetClassification.quarantineReason,
      rawPayload: {
        rawText,
        shareCount,
        shareCountSource: shareCount != null ? "pdf_exact" : null,
      },
    });
  }

  return rows;
}

function parseGenericTradeRowsFromText(text: string): ParsedTradeRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const rows: ParsedTradeRow[] = [];
  let buffer: string[] = [];

  const flushBuffer = () => {
    if (!buffer.length) return;
    const joined = buffer.join(" ");
    buffer = [];

    if (!AMOUNT_RANGE_RE.test(joined) || !TRADE_TYPE_RE.test(joined)) {
      return;
    }

    const amountMatch = joined.match(AMOUNT_RANGE_RE);
    const tradeTypeMatch = joined.match(TRADE_TYPE_RE);
    if (!amountMatch || !tradeTypeMatch) return;

    const amountRange = amountMatch[0];
    const tradeType = tradeTypeMatch[0];
    const ownerMatch = joined.match(/^(SP|DC|JT|SELF)\b/i);
    const ownerLabel = ownerMatch?.[1]?.toUpperCase() ?? null;
    const owner = normalizeOwnerLabel(ownerLabel);

    const beforeTradeType = joined.slice(ownerMatch ? ownerMatch[0].length : 0, tradeTypeMatch.index).trim();
    const afterTradeType = joined.slice((tradeTypeMatch.index ?? 0) + tradeTypeMatch[0].length).trim();
    const dates = [...afterTradeType.matchAll(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g)].map((match) => match[0]);
    const transactionDate = toIsoDate(dates[0] ?? null);
    const notificationDate = toIsoDate(dates[1] ?? null);
    const shareCount = extractExplicitShareCount(joined);
    const symbolGuess = extractTickerGuess(beforeTradeType);
    const assetClassification = classifyAsset(beforeTradeType, symbolGuess);

    rows.push({
      rowOrdinal: rows.length + 1,
      ownerLabel: owner.label,
      ownerType: owner.ownerType,
      assetName: beforeTradeType || null,
      normalizedAssetName: beforeTradeType ? normalizeOrganizationName(beforeTradeType) : null,
      assetType: assetClassification.assetType,
      symbolGuess,
      transactionType: normalizeTradeType(tradeType),
      transactionDate,
      notificationDate,
      amountRange,
      shareCount,
      shareCountSource: shareCount != null ? "pdf_exact" : null,
      isPublicEquity: assetClassification.isPublicEquity,
      parseConfidence: symbolGuess ? "high" : assetClassification.isPublicEquity ? "medium" : "low",
      quarantineReason: assetClassification.quarantineReason,
      rawPayload: {
        rawText: joined,
        shareCount,
        shareCountSource: shareCount != null ? "pdf_exact" : null,
      },
    });
  };

  for (const line of lines) {
    if (/periodic transaction report/i.test(line) || /^name[:\s]/i.test(line) || /^status[:\s]/i.test(line)) {
      flushBuffer();
      continue;
    }

    buffer.push(line);
    if (AMOUNT_RANGE_RE.test(buffer.join(" ")) && TRADE_TYPE_RE.test(buffer.join(" "))) {
      flushBuffer();
    } else if (buffer.length >= 4) {
      flushBuffer();
    }
  }

  flushBuffer();
  return rows;
}

export function parseTradeRowsFromText(text: string): ParsedTradeRow[] {
  return isHouseDisclosureText(text)
    ? parseHouseTradeRowsFromText(text)
    : parseGenericTradeRowsFromText(text);
}

function extractMemberMetadataFromText(text: string) {
  const normalized = text.replace(/\s+/g, " ");
  const nameMatch =
    normalized.match(/\bName:\s*([A-Z][A-Za-z.'\-]+,\s*[A-Z][A-Za-z.'\-\s]+)/)
    ?? normalized.match(/\bFiler:\s*([A-Z][A-Za-z.'\-]+,\s*[A-Z][A-Za-z.'\-\s]+)/);
  const name = nameMatch?.[1]?.trim() ?? null;
  const filedMatch = normalized.match(/\b(Date Filed|Date Received|Filed):\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  return {
    memberName: name,
    filedDate: toIsoDate(filedMatch?.[2] ?? null),
  };
}

async function logDisclosureFailure(sb: DbClient, failure: Database["public"]["Tables"]["disclosure_ingest_failures"]["Insert"]) {
  await sb.from("disclosure_ingest_failures").insert(failure);
}

async function resolveMemberBioguideId(
  sb: DbClient,
  {
    memberName,
    chamber,
    state,
  }: {
    memberName?: string | null;
    chamber?: string | null;
    state?: string | null;
  }
): Promise<string | null> {
  const normalizedState = normalizeState(state);
  const normalizedName = asString(memberName);
  if (!normalizedName) return null;

  const candidates = [normalizedName]
    .flatMap((value) => {
      const direct = value;
      const commaParts = value.split(",").map((part) => part.trim()).filter(Boolean);
      if (commaParts.length >= 2) {
        return [direct, `${commaParts.slice(1).join(" ")} ${commaParts[0]}`.trim()];
      }
      return [direct];
    });

  const [{ data: nameMatches, error: nameError }, { data: directNameMatches, error: directError }] = await Promise.all([
    sb
      .from("members")
      .select("bioguide_id,name,direct_order_name,state,chamber")
      .in("name", candidates),
    sb
      .from("members")
      .select("bioguide_id,name,direct_order_name,state,chamber")
      .in("direct_order_name", candidates),
  ]);

  if (nameError) throw new Error(`Failed to resolve member '${normalizedName}': ${nameError.message}`);
  if (directError) throw new Error(`Failed to resolve member '${normalizedName}': ${directError.message}`);

  const byBioguide = new Map<string, NonNullable<typeof nameMatches>[number]>();
  for (const member of [...(nameMatches ?? []), ...(directNameMatches ?? [])]) {
    byBioguide.set(member.bioguide_id, member);
  }
  const data = [...byBioguide.values()];

  const filtered = (data ?? []).filter((member) => {
    const stateMatches = !normalizedState || normalizeState(member.state) === normalizedState;
    const chamberMatches = !chamber || !member.chamber || member.chamber.toLowerCase().includes(chamber.toLowerCase());
    return stateMatches && chamberMatches;
  });

  if (filtered.length === 1) return filtered[0].bioguide_id;

  const exactMatches = (data ?? []).filter((member) => {
    const directNames = [member.name, member.direct_order_name].filter(Boolean).map((value) => value!.toLowerCase());
    return directNames.includes(normalizedName.toLowerCase())
      && (!normalizedState || normalizeState(member.state) === normalizedState);
  });

  return exactMatches.length === 1 ? exactMatches[0].bioguide_id : null;
}

async function upsertDisclosureFiling(sb: DbClient, filing: DisclosureSourceFiling) {
  const memberBioguideId = await resolveMemberBioguideId(sb, {
    memberName: filing.memberName,
    chamber: filing.chamber,
    state: filing.memberState ?? filing.candidateState,
  });

  const payload: DisclosureFilingInsert = {
    chamber: filing.chamber,
    source_type: filing.sourceType,
    filing_identifier: filing.filingIdentifier,
    source_row_key: filing.sourceRowKey,
    filing_type: filing.filingType,
    member_name: filing.memberName,
    member_first_name: filing.memberFirstName,
    member_last_name: filing.memberLastName,
    member_state: filing.memberState,
    member_bioguide_id: memberBioguideId,
    candidate_state: filing.candidateState,
    document_url: filing.documentUrl,
    archive_url: filing.archiveUrl,
    filed_date: filing.filedDate,
    disclosure_date: filing.disclosureDate,
    raw_metadata: filing.rawMetadata,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await sb
    .from("disclosure_filings")
    .upsert(payload, { onConflict: "source_row_key" })
    .select("*")
    .single();

  if (error) throw new Error(`Failed to upsert disclosure filing ${filing.filingIdentifier}: ${error.message}`);
  return data;
}

async function upsertFilingText(
  sb: DbClient,
  filingId: number,
  extraction: { text: string | null; method: string; status: string; diagnostics: JsonRecord }
) {
  const sanitizedText = sanitizePostgresText(extraction.text);
  const sanitizedDiagnostics = sanitizeJsonStrings(extraction.diagnostics);

  const { error } = await sb
    .from("disclosure_filing_text")
    .upsert({
      filing_id: filingId,
      parser_version: DISCLOSURE_PARSER_VERSION,
      extraction_method: extraction.method,
      extraction_status: extraction.status,
      extracted_text: sanitizedText,
      parse_diagnostics: sanitizedDiagnostics,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: "filing_id,parser_version",
    });
  if (error) throw new Error(`Failed to upsert disclosure filing text ${filingId}: ${error.message}`);
}

async function upsertTradeRows(
  sb: DbClient,
  filing: Database["public"]["Tables"]["disclosure_filings"]["Row"],
  rows: ParsedTradeRow[]
): Promise<{ rows: Database["public"]["Tables"]["disclosure_trade_rows"]["Row"][]; affectedMembers: string[] }> {
  if (!rows.length) return { rows: [], affectedMembers: [] };

  const payloads: DisclosureTradeRowInsert[] = [];
  const affectedMembers = new Set<string>();

  for (const row of rows) {
    const memberBioguideId = filing.member_bioguide_id ?? await resolveMemberBioguideId(sb, {
      memberName: filing.member_name,
      chamber: filing.chamber,
      state: filing.member_state ?? filing.candidate_state,
    });
    if (memberBioguideId) affectedMembers.add(memberBioguideId);

    let organizationId: number | null = null;
    if (row.isPublicEquity) {
      organizationId =
        await resolveOrganizationId(sb, { name: row.assetName, ticker: row.symbolGuess }) ??
        (row.assetName
          ? (await ensureOrganization(sb, {
              canonicalName: row.assetName,
              ticker: row.symbolGuess,
              aliasSourceType: filing.source_type,
              aliasSourceRowId: filing.filing_identifier,
              identifiers: row.symbolGuess
                ? [{ sourceType: filing.source_type, identifierType: "ticker", identifierValue: row.symbolGuess }]
                : [],
              sourceCoverage: { disclosures: true },
            })).id
          : null);
    }

    payloads.push({
      filing_id: filing.id,
      source_row_key: `${filing.source_row_key}:row:${row.rowOrdinal}:${normalizeOrganizationName(row.assetName ?? "")}:${row.transactionType ?? ""}:${row.amountRange ?? ""}`,
      row_ordinal: row.rowOrdinal,
      owner_label: row.ownerLabel,
      owner_type: row.ownerType,
      asset_name: row.assetName,
      normalized_asset_name: row.normalizedAssetName,
      asset_type: row.assetType,
      symbol_guess: row.symbolGuess,
      transaction_type: row.transactionType,
      transaction_date: row.transactionDate,
      notification_date: row.notificationDate,
      amount_range: row.amountRange,
      is_public_equity: row.isPublicEquity,
      parse_confidence: row.parseConfidence,
      organization_id: organizationId,
      member_bioguide_id: memberBioguideId,
      quarantine_reason: row.quarantineReason,
      raw_payload: row.rawPayload,
      updated_at: new Date().toISOString(),
    });
  }

  const { data, error } = await sb
    .from("disclosure_trade_rows")
    .upsert(payloads, { onConflict: "source_row_key" })
    .select("*");
  if (error) throw new Error(`Failed to upsert disclosure trade rows for filing ${filing.id}: ${error.message}`);

  return { rows: data ?? [], affectedMembers: [...affectedMembers] };
}

async function normalizeTradeRowsForFiling(
  sb: DbClient,
  filingId: number
): Promise<{ normalizedTrades: number; affectedMembers: string[] }> {
  const { data: filing, error: filingError } = await sb
    .from("disclosure_filings")
    .select("*")
    .eq("id", filingId)
    .single();
  if (filingError) throw new Error(`Failed to load disclosure filing ${filingId}: ${filingError.message}`);

  const { data: rows, error: rowsError } = await sb
    .from("disclosure_trade_rows")
    .select("*")
    .eq("filing_id", filingId);
  if (rowsError) throw new Error(`Failed to load trade rows for filing ${filingId}: ${rowsError.message}`);

  const normalizedPayloads: MemberStockTradeInsert[] = [];
  const affectedMembers = new Set<string>();

  for (const row of rows ?? []) {
    if (!row.is_public_equity) continue;
    if (!row.member_bioguide_id) continue;
    affectedMembers.add(row.member_bioguide_id);
    normalizedPayloads.push({
      bioguide_id: row.member_bioguide_id,
      organization_id: row.organization_id,
      disclosure_filing_id: filing.id,
      source_type: filing.source_type,
      source_row_key: `${row.source_row_key}:normalized`,
      symbol: row.symbol_guess,
      asset_name: row.asset_name,
      normalized_asset_name: row.normalized_asset_name,
      transaction_date: row.transaction_date,
      disclosure_date: filing.disclosure_date ?? filing.filed_date,
      transaction_type: row.transaction_type,
      amount_range: row.amount_range,
      share_count: typeof row.raw_payload?.shareCount === "number" ? row.raw_payload.shareCount : null,
      owner_label: row.owner_label,
      owner_type: row.owner_type,
      asset_type: row.asset_type,
      parse_confidence: row.parse_confidence,
      raw_payload: row.raw_payload,
      updated_at: new Date().toISOString(),
    });
  }

  if (normalizedPayloads.length) {
    const { error } = await sb.from("member_stock_trades").upsert(normalizedPayloads, {
      onConflict: "source_row_key",
    });
    if (error) throw new Error(`Failed to normalize stock trades for filing ${filingId}: ${error.message}`);
  }

  for (const bioguideId of affectedMembers) {
    await materializeMemberRelationships(sb, bioguideId);
  }

  return {
    normalizedTrades: normalizedPayloads.length,
    affectedMembers: [...affectedMembers],
  };
}

async function fetchWithBytes(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const data = await response.arrayBuffer();
  if (!response.ok) {
    throw new Error(`Fetch failed (${response.status}) for ${url}`);
  }
  return data;
}

async function fetchWithText(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Fetch failed (${response.status}) for ${url}: ${text.slice(0, 300)}`);
  }
  return text;
}

async function senateSession() {
  const homeResponse = await fetch(SENATE_HOME_URL);
  const homeHtml = await homeResponse.text();
  if (!homeResponse.ok) throw new Error(`Senate home fetch failed (${homeResponse.status})`);
  const csrfToken = homeHtml.match(/name="csrfmiddlewaretoken" value="([^"]+)"/)?.[1];
  if (!csrfToken) throw new Error("Senate csrf token not found");

  const setCookie = homeResponse.headers.get("set-cookie") ?? "";
  const csrftoken = setCookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";

  const agreementBody = new URLSearchParams({
    prohibition_agreement: "1",
    csrfmiddlewaretoken: csrfToken,
  });
  const agreementResponse = await fetch(SENATE_HOME_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: SENATE_HOME_URL,
      Cookie: setCookie,
    },
    body: agreementBody.toString(),
    redirect: "manual",
  });

  if (![200, 302].includes(agreementResponse.status)) {
    throw new Error(`Senate agreement failed (${agreementResponse.status})`);
  }

  const agreementCookies = [setCookie, agreementResponse.headers.get("set-cookie") ?? ""]
    .flatMap((value) => value.split(/,(?=[^;]+?=)/))
    .map((value) => value.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");

  const searchPage = await fetch(SENATE_SEARCH_URL, {
    headers: {
      Cookie: agreementCookies,
      Referer: SENATE_HOME_URL,
    },
  });
  const searchHtml = await searchPage.text();
  if (!searchPage.ok) throw new Error(`Senate search page failed (${searchPage.status})`);

  const searchCsrf = searchPage.headers.get("set-cookie")?.match(/csrftoken=([^;]+)/)?.[1]
    ?? searchHtml.match(/name="csrfmiddlewaretoken" value="([^"]+)"/)?.[1]
    ?? csrftoken;

  return {
    cookie: agreementCookies,
    csrfToken: searchCsrf,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSenateResultsPayload(payload: unknown): DisclosureSourceFiling[] {
  const record = jsonRecord(payload);
  const rows = Array.isArray(record.data) ? record.data : [];
  const filings: DisclosureSourceFiling[] = [];

  for (const row of rows) {
    const cells = Array.isArray(row) ? row : [];
    if (cells.length < 5) continue;

    const firstName = stripHtml(String(cells[0] ?? ""));
    const lastName = stripHtml(String(cells[1] ?? ""));
    const filedDate = toIsoDate(stripHtml(String(cells[2] ?? "")));
    const reportType = stripHtml(String(cells[3] ?? ""));
    const linkHtml = String(cells[4] ?? "");
    const href = linkHtml.match(/href="([^"]+)"/)?.[1] ?? null;
    const state = linkHtml.match(/\(([A-Z]{2})\)/)?.[1] ?? null;
    const documentUrl = ensureAbsoluteUrl(SENATE_SEARCH_URL, href);
    const filingIdentifier = documentUrl ?? `${lastName}:${firstName}:${filedDate ?? ""}:${reportType}`;

    filings.push({
      chamber: "Senate",
      sourceType: "senate_efd",
      filingIdentifier,
      sourceRowKey: filingIdentifier,
      filingType: reportType || "Periodic Transaction Report",
      memberName: [lastName, firstName].filter(Boolean).join(", ") || null,
      memberFirstName: firstName || null,
      memberLastName: lastName || null,
      memberState: state,
      candidateState: null,
      documentUrl,
      archiveUrl: null,
      filedDate,
      disclosureDate: filedDate,
      rawMetadata: {
        row: cells,
      },
    });
  }

  return filings;
}

async function fetchSenateDisclosures(from: string, to: string): Promise<DisclosureSourceFiling[]> {
  const session = await senateSession();
  const body = new URLSearchParams({
    draw: "1",
    start: "0",
    length: "100",
    "search[value]": "",
    "search[regex]": "false",
    report_types: "[11]",
    filer_types: "[1,5]",
    submitted_start_date: formatSenateDate(from),
    submitted_end_date: formatSenateDate(to),
    candidate_state: "",
    senator_state: "",
    office_id: "",
    first_name: "",
    last_name: "",
    "order[0][column]": "2",
    "order[0][dir]": "desc",
  });
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(SENATE_REPORT_DATA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-CSRFToken": session.csrfToken,
        Referer: SENATE_SEARCH_URL,
        Cookie: session.cookie,
        "X-Requested-With": "XMLHttpRequest",
      },
      body: body.toString(),
    });

    const contentType = response.headers.get("content-type") ?? "";
    const rawText = await response.text();
    const summary = summarizeUpstreamHtml(rawText);

    if (response.ok) {
      if (!contentType.includes("application/json")) {
        throw new Error(`Senate report data returned non-JSON content: ${summary.slice(0, 120)}`);
      }

      const parsed = JSON.parse(rawText) as unknown;
      return parseSenateResultsPayload(parsed);
    }

    if (shouldRetrySenateEfdRequest(response.status, rawText, attempt, maxAttempts)) {
      await sleep(500 * attempt);
      continue;
    }

    if (isSenateMaintenanceResponse(response.status, rawText)) {
      throw new SenateEfdUnavailableError(
        `Senate eFD upstream is under maintenance (${response.status}). Retry later.`,
        response.status
      );
    }

    throw new Error(`Senate report data fetch failed (${response.status}): ${summary}`);
  }

  throw new SenateEfdUnavailableError(
    "Senate eFD upstream remained unavailable after 3 attempts. Retry later.",
    503
  );
}

async function fetchHouseDisclosures(from: string, to: string, limit?: number): Promise<DisclosureSourceFiling[]> {
  const startYear = Number.parseInt(from.slice(0, 4), 10);
  const endYear = Number.parseInt(to.slice(0, 4), 10);
  const filings: DisclosureSourceFiling[] = [];

  for (let year = startYear; year <= endYear; year += 1) {
    const indexUrl = `${HOUSE_INDEX_BASE_URL}/${year}FD.xml`;
    const xmlText = await fetchWithText(indexUrl);
    const members = [...xmlText.matchAll(/<Member>([\s\S]*?)<\/Member>/g)].map((match) => match[1]);

    const readTag = (block: string, tag: string) => {
      const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return stripHtml(match?.[1] ?? "");
    };

    for (const member of members) {
      const filingType = readTag(member, "FilingType");
      if (filingType !== "P") continue;
      const docId = readTag(member, "DocID");
      const filingDate = toIsoDate(readTag(member, "FilingDate"));
      const lastName = readTag(member, "Last");
      const firstName = readTag(member, "First");
      const stateDst = readTag(member, "StateDst");
      if (!docId) continue;
      if (!isDateInWindow(filingDate, from, to)) continue;

      const documentUrl = `${HOUSE_PTR_BASE_URL}/${year}/${docId}.pdf`;
      filings.push({
        chamber: "House",
        sourceType: "house_clerk_ptr",
        filingIdentifier: `house:${year}:${docId}`,
        sourceRowKey: `house:${year}:${docId}`,
        filingType: "Periodic Transaction Report",
        memberName: [lastName, firstName].filter(Boolean).join(", ") || null,
        memberFirstName: firstName || null,
        memberLastName: lastName || null,
        memberState: stateDst.slice(0, 2) || null,
        candidateState: null,
        documentUrl,
        archiveUrl: indexUrl,
        filedDate: filingDate,
        disclosureDate: filingDate,
        rawMetadata: {
          docId,
          year,
          filingType,
          stateDst,
        },
      });

      if (limit && filings.length >= limit) {
        return filings;
      }
    }
  }

  return filings;
}

async function processDisclosureFiling(
  sb: DbClient,
  sourceFiling: DisclosureSourceFiling
): Promise<{ filingId: number; parsedRows: number; normalizedTrades: number; affectedMembers: string[] }> {
  const binaryContent = sourceFiling.binaryContent
    ?? (sourceFiling.documentUrl ? await fetchWithBytes(sourceFiling.documentUrl) : null);
  const filing = await upsertDisclosureFiling(sb, sourceFiling);

  if (!binaryContent) {
    await logDisclosureFailure(sb, {
      filing_id: filing.id,
      source_type: sourceFiling.sourceType,
      stage: "fetch_document",
      error_code: "missing_binary_content",
      error_message: "Disclosure document content was not available for processing",
      retryable: true,
      raw_payload: sourceFiling.rawMetadata,
    });
    await sb.from("disclosure_filings").update({
      fetch_status: "failed",
      parse_status: "quarantined",
      quarantine_reason: "missing_binary_content",
      updated_at: new Date().toISOString(),
    }).eq("id", filing.id);
    return { filingId: filing.id, parsedRows: 0, normalizedTrades: 0, affectedMembers: [] };
  }

  const checksum = await sha256Hex(binaryContent);
  const extraction = await extractPdfText(binaryContent);
  const metadataFromText = extraction.text ? extractMemberMetadataFromText(extraction.text) : { memberName: null, filedDate: null };
  const nextMemberName = filing.member_name ?? metadataFromText.memberName;
  const nextFiledDate = filing.filed_date ?? metadataFromText.filedDate;
  const nextBioguideId = await resolveMemberBioguideId(sb, {
    memberName: nextMemberName,
    chamber: filing.chamber,
    state: filing.member_state ?? filing.candidate_state,
  });

  await sb.from("disclosure_filings").update({
    checksum_sha256: checksum,
    member_name: nextMemberName,
    member_bioguide_id: nextBioguideId,
    filed_date: nextFiledDate,
    fetch_status: "fetched",
    parse_status: extraction.status === "failed" ? "quarantined" : "parsed",
    quarantine_reason: extraction.status === "failed" ? "text_extraction_failed" : null,
    updated_at: new Date().toISOString(),
  }).eq("id", filing.id);

  await upsertFilingText(sb, filing.id, extraction);

  if (!extraction.text) {
    await logDisclosureFailure(sb, {
      filing_id: filing.id,
      source_type: sourceFiling.sourceType,
      stage: "extract_text",
      error_code: "text_extraction_failed",
      error_message: "Text extraction failed; filing quarantined for future OCR or manual review",
      retryable: true,
      raw_payload: extraction.diagnostics,
    });
    return { filingId: filing.id, parsedRows: 0, normalizedTrades: 0, affectedMembers: [] };
  }

  const parsedRows = parseTradeRowsFromText(extraction.text);
  const tradeRowsResult = await upsertTradeRows(sb, {
    ...filing,
    member_name: nextMemberName,
    member_bioguide_id: nextBioguideId,
    filed_date: nextFiledDate,
  }, parsedRows);
  const normalized = await normalizeTradeRowsForFiling(sb, filing.id);

  if (parsedRows.length === 0) {
    await logDisclosureFailure(sb, {
      filing_id: filing.id,
      source_type: sourceFiling.sourceType,
      stage: "parse_rows",
      error_code: "no_rows_parsed",
      error_message: "No transaction rows could be parsed from the disclosure text",
      retryable: true,
      raw_payload: {
        parser_version: DISCLOSURE_PARSER_VERSION,
      },
    });
    await sb.from("disclosure_filings").update({
      parse_status: "quarantined",
      quarantine_reason: "no_rows_parsed",
      updated_at: new Date().toISOString(),
    }).eq("id", filing.id);
  }

  return {
    filingId: filing.id,
    parsedRows: tradeRowsResult.rows.length,
    normalizedTrades: normalized.normalizedTrades,
    affectedMembers: normalized.affectedMembers,
  };
}

export async function refreshSenateDisclosures(
  sb: DbClient,
  { from, to, limit }: DisclosureRefreshOptions
) {
  const filings = await fetchSenateDisclosures(from, to);
  const limitedFilings = typeof limit === "number" ? filings.slice(0, limit) : filings;
  const results = [];
  for (const filing of limitedFilings) {
    results.push(await processDisclosureFiling(sb, filing));
  }
  return {
    source: "senate",
    filingsDiscovered: limitedFilings.length,
    filingsProcessed: results.length,
    parsedRows: results.reduce((sum, item) => sum + item.parsedRows, 0),
    normalizedTrades: results.reduce((sum, item) => sum + item.normalizedTrades, 0),
    affectedMembers: [...new Set(results.flatMap((item) => item.affectedMembers))],
  };
}

export async function refreshHouseDisclosures(
  sb: DbClient,
  { from, to, limit }: DisclosureRefreshOptions
) {
  const filings = await fetchHouseDisclosures(from, to, limit);
  const results = [];
  for (const filing of filings) {
    results.push(await processDisclosureFiling(sb, filing));
  }
  return {
    source: "house",
    filingsDiscovered: filings.length,
    filingsProcessed: results.length,
    parsedRows: results.reduce((sum, item) => sum + item.parsedRows, 0),
    normalizedTrades: results.reduce((sum, item) => sum + item.normalizedTrades, 0),
    affectedMembers: [...new Set(results.flatMap((item) => item.affectedMembers))],
  };
}

export async function normalizeDisclosureTradesForFiling(
  sb: DbClient,
  filingId: number
) {
  return await normalizeTradeRowsForFiling(sb, filingId);
}
