import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  buildResolutionCandidateFilters,
  normalizeMemberState,
  resolveMemberBioguideMatch,
} from "../src/lib/member-resolution.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const API_DIR = path.resolve(__dirname, "..");
const DEV_VARS_PATH = path.join(API_DIR, ".dev.vars");
const HOUSE_INDEX_BASE_URL = "https://disclosures-clerk.house.gov/public_disc/financial-pdfs";
const HOUSE_PTR_BASE_URL = "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs";
const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";
const STOOQ_DAILY_BASE_URL = "https://stooq.com/q/d/l/";
const DISCLOSURE_PARSER_VERSION = "v2-node-pdfjs";
const AMOUNT_RANGE_RE = /\$[\d,]+(?:\.\d+)?\s*-\s*\$[\d,]+(?:\.\d+)?/;
const OWNER_LABEL_MAP = {
  SP: "spouse",
  DC: "dependent_child",
  JT: "joint",
  SELF: "self",
};
const ORG_SUFFIXES = new Set([
  "INC",
  "INCORPORATED",
  "CORP",
  "CORPORATION",
  "CO",
  "COMPANY",
  "LLC",
  "LTD",
  "LIMITED",
  "PLC",
  "LP",
  "HOLDINGS",
  "HOLDING",
  "GROUP",
]);
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
const STATE_CODE_BY_NAME = {
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

export function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

function parseArgs(argv) {
  const options = {
    from: null,
    to: null,
    limit: 10,
    offset: 0,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--from") options.from = argv[++i] ?? null;
    else if (arg === "--to") options.to = argv[++i] ?? null;
    else if (arg === "--limit") options.limit = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--offset") options.offset = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--force") options.force = true;
  }
  if (!options.from || !options.to) {
    throw new Error("Usage: npm run disclosures:house -- --from YYYY-MM-DD --to YYYY-MM-DD [--limit N] [--offset N] [--force]");
  }
  if (!Number.isFinite(options.limit) || options.limit <= 0) options.limit = 10;
  if (!Number.isFinite(options.offset) || options.offset < 0) options.offset = 0;
  return options;
}

function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toIsoDate(value) {
  const normalized = asString(value);
  if (!normalized) return null;
  const isoMatch = normalized.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];
  const usMatch = normalized.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (usMatch) {
    const year = usMatch[3].length === 2 ? `20${usMatch[3]}` : usMatch[3];
    return `${year}-${usMatch[1].padStart(2, "0")}-${usMatch[2].padStart(2, "0")}`;
  }
  return null;
}

function normalizeOrganizationName(value) {
  const upper = value
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!upper) return "";
  const parts = upper.split(" ").filter(Boolean);
  while (parts.length > 1 && ORG_SUFFIXES.has(parts.at(-1))) {
    parts.pop();
  }
  return parts.join(" ");
}

function normalizeExtractedText(value) {
  return value
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeTradeType(value) {
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

function extractTickerGuess(assetName) {
  const value = asString(assetName);
  if (!value) return null;
  const parenMatch = value.match(/\(([A-Z.\-]{1,6})\)/);
  if (parenMatch?.[1]) return parenMatch[1].replace(/\./g, "").toUpperCase();
  const suffixMatch = value.match(/\b([A-Z]{1,5})\b$/);
  return suffixMatch?.[1] ? suffixMatch[1].toUpperCase() : null;
}

function normalizeOwnerLabel(ownerLabel) {
  const upper = asString(ownerLabel)?.toUpperCase() ?? null;
  if (!upper) return { label: null, ownerType: null };
  return {
    label: upper,
    ownerType: OWNER_LABEL_MAP[upper] ?? upper.toLowerCase().replace(/\s+/g, "_"),
  };
}

function classifyAsset(assetName, symbolGuess) {
  const normalized = normalizeOrganizationName(assetName ?? "");
  if (!normalized) {
    return { assetType: "unknown", isPublicEquity: false, quarantineReason: "missing_asset_name" };
  }
  if (UNWANTED_ASSET_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return { assetType: "unsupported_asset", isPublicEquity: false, quarantineReason: "unsupported_asset_type" };
  }
  if (symbolGuess || /\b(STOCK|SHARES|CORP|CORPORATION|INC|INCORPORATED|PLC|HOLDINGS)\b/.test(normalized)) {
    return { assetType: "public_equity", isPublicEquity: true, quarantineReason: null };
  }
  return { assetType: "unknown", isPublicEquity: false, quarantineReason: "ambiguous_asset_label" };
}

async function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(Buffer.from(buffer)).digest("hex");
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fetch failed (${response.status}) for ${url}`);
  return response.text();
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fetch failed (${response.status}) for ${url}`);
  return response.arrayBuffer();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fetch failed (${response.status}) for ${url}`);
  return response.json();
}

function parseAmountRange(value) {
  const matches = value?.match(/\$[\d,]+(?:\.\d+)?/g) ?? [];
  if (matches.length < 2) return null;
  const lower = Number(matches[0].replace(/[$,]/g, ""));
  const upper = Number(matches[1].replace(/[$,]/g, ""));
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return null;
  return {
    lower,
    upper,
    midpoint: Number(((lower + upper) / 2).toFixed(2)),
  };
}

function extractExplicitShareCount(text) {
  const match = text?.match(/\b(\d[\d,]*(?:\.\d+)?)\s*(?:shares?|shrs?)\b/i);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchFinnhubClosePrice(apiKey, symbol, date, cache) {
  if (!apiKey || !symbol || !date) return null;
  const cacheKey = `${symbol}:${date}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const from = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
  const to = from + 86399;
  const url = new URL(`${FINNHUB_BASE_URL}/stock/candle`);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("resolution", "D");
  url.searchParams.set("from", String(from));
  url.searchParams.set("to", String(to));
  url.searchParams.set("token", apiKey);

  const raw = await fetchJson(url.toString());
  const closes = Array.isArray(raw?.c) ? raw.c : [];
  const close = typeof closes.at(-1) === "number" && Number.isFinite(closes.at(-1)) ? closes.at(-1) : null;
  cache.set(cacheKey, close);
  return close;
}

async function fetchStooqClosePrice(symbol, date, cache) {
  if (!symbol || !date) return null;
  const cacheKey = `stooq:${symbol}:${date}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const url = new URL(STOOQ_DAILY_BASE_URL);
  url.searchParams.set("s", `${symbol.toLowerCase()}.us`);
  url.searchParams.set("i", "d");

  const csv = await fetchText(url.toString());
  const rows = csv.split(/\r?\n/);
  const target = rows.find((row) => row.startsWith(`${date},`));
  if (!target) {
    cache.set(cacheKey, null);
    return null;
  }

  const parts = target.split(",");
  const close = Number(parts[4] ?? "");
  const value = Number.isFinite(close) ? close : null;
  cache.set(cacheKey, value);
  return value;
}

async function fetchHistoricalClosePrice(apiKey, symbol, date, cache) {
  try {
    const finnhub = await fetchFinnhubClosePrice(apiKey, symbol, date, cache);
    if (finnhub != null) return finnhub;
  } catch {
    // Fall through to the no-auth CSV source.
  }

  try {
    return await fetchStooqClosePrice(symbol, date, cache);
  } catch {
    return null;
  }
}

async function extractPdfText(buffer) {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;
  try {
    const pages = [];
    let itemCount = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const items = textContent.items
        .map((item) => ({
          str: (item.str ?? "").replace(/\u0000/g, "").trim(),
          y: Array.isArray(item.transform) ? item.transform[5] ?? 0 : 0,
        }))
        .filter((item) => item.str);

      itemCount += items.length;
      const lines = [];
      let currentLine = "";
      let lastY = null;
      for (const item of items) {
        if (lastY === null || Math.abs(item.y - lastY) <= 2) {
          currentLine = currentLine ? `${currentLine} ${item.str}` : item.str;
        } else {
          if (currentLine) lines.push(currentLine);
          currentLine = item.str;
        }
        lastY = item.y;
      }
      if (currentLine) lines.push(currentLine);
      pages.push(lines.join("\n"));
    }

    return {
      text: normalizeExtractedText(pages.join("\n\n")),
      pageCount: pdf.numPages,
      itemCount,
    };
  } finally {
    await pdf.destroy();
  }
}

function readTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return asString(match?.[1]) ?? null;
}

async function fetchHouseFilings(from, to, { limit, offset = 0 } = {}) {
  const startYear = Number.parseInt(from.slice(0, 4), 10);
  const endYear = Number.parseInt(to.slice(0, 4), 10);
  const filings = [];

  for (let year = startYear; year <= endYear; year += 1) {
    const xmlText = await fetchText(`${HOUSE_INDEX_BASE_URL}/${year}FD.xml`);
    const members = [...xmlText.matchAll(/<Member>([\s\S]*?)<\/Member>/g)].map((match) => match[1]);
    for (const member of members) {
      if (readTag(member, "FilingType") !== "P") continue;
      const filingDate = toIsoDate(readTag(member, "FilingDate"));
      if (!filingDate || filingDate < from || filingDate > to) continue;
      const docId = readTag(member, "DocID");
      if (!docId) continue;
      filings.push({
        year,
        docId,
        filingDate,
        lastName: readTag(member, "Last"),
        firstName: readTag(member, "First"),
        stateDst: readTag(member, "StateDst"),
      });
    }
  }

  filings.sort((a, b) => {
    if (a.filingDate !== b.filingDate) return (a.filingDate ?? "").localeCompare(b.filingDate ?? "");
    return a.docId.localeCompare(b.docId);
  });

  const start = Math.max(0, offset);
  const end = typeof limit === "number" ? start + limit : undefined;
  return filings.slice(start, end);
}

function matchHouseTradeType(value) {
  return value.match(/^(?:(P|S|E)(?:\s*\(partial\))?(?=\s|$)|(Purchase|Sale|Exchange|Partial Sale|Partial Purchase)(?=\s|$))/i);
}

function parseHouseTradeRows(text) {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const rows = [];
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

    const assetLines = inlineAsset ? [inlineAsset] : [];
    while (i < lines.length && !matchHouseTradeType(lines[i]) && !footerRe.test(lines[i])) {
      assetLines.push(lines[i]);
      i += 1;
    }
    if (i >= lines.length || !matchHouseTradeType(lines[i])) continue;

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
    const classification = classifyAsset(assetName, symbolGuess);
    rows.push({
      rowOrdinal: rows.length + 1,
      ownerLabel: owner.label,
      ownerType: owner.ownerType,
      assetName,
      normalizedAssetName: normalizeOrganizationName(assetName),
      assetType: classification.assetType,
      symbolGuess,
      transactionType: normalizeTradeType(tradeType),
      transactionDate: toIsoDate(dates[0] ?? null),
      notificationDate: toIsoDate(dates[1] ?? null),
      amountRange: amountMatch[0],
      shareCount,
      shareCountSource: shareCount != null ? "pdf_exact" : null,
      isPublicEquity: classification.isPublicEquity,
      parseConfidence: symbolGuess ? "high" : classification.isPublicEquity ? "medium" : "low",
      quarantineReason: classification.quarantineReason,
      rawPayload: {
        rawText: [ownerLabel, assetName, tradeType, ...dates, amountMatch[0]].join(" "),
        shareCount,
        shareCountSource: shareCount != null ? "pdf_exact" : null,
      },
    });
  }

  return rows;
}

async function resolveMemberBioguide(sb, { memberName, chamber, state }) {
  const normalizedName = asString(memberName);
  const normalizedState = normalizeMemberState(state);
  if (!normalizedName) return { bioguideId: null, confidence: null, score: null, reason: null };

  const candidates = [normalizedName].flatMap((value) => {
    const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
    return parts.length >= 2 ? [value, `${parts.slice(1).join(" ")} ${parts[0]}`.trim()] : [value];
  });

  const [{ data: nameMatches, error: nameError }, { data: directMatches, error: directError }] = await Promise.all([
    sb.from("members").select("bioguide_id,name,direct_order_name,state,chamber").in("name", candidates),
    sb.from("members").select("bioguide_id,name,direct_order_name,state,chamber").in("direct_order_name", candidates),
  ]);
  if (nameError) throw new Error(`Failed to resolve member '${normalizedName}': ${nameError.message}`);
  if (directError) throw new Error(`Failed to resolve member '${normalizedName}': ${directError.message}`);

  const byBioguide = new Map();
  for (const member of [...(nameMatches ?? []), ...(directMatches ?? [])]) {
    byBioguide.set(member.bioguide_id, member);
  }
  const exactMatch = resolveMemberBioguideMatch([...byBioguide.values()], {
    memberName: normalizedName,
    chamber,
    state: normalizedState,
  });
  if (exactMatch.bioguideId) return exactMatch;

  const surnameFilters = [...new Set(buildResolutionCandidateFilters(normalizedName))];
  if (!surnameFilters.length) return { bioguideId: null, confidence: null, score: null, reason: "no_candidate_filters" };

  let fallbackQuery = sb.from("members").select("bioguide_id,name,direct_order_name,state,chamber");
  if (chamber) fallbackQuery = fallbackQuery.ilike("chamber", `%${chamber}%`);

  const fallbackFilters = surnameFilters.flatMap((surname) => [
    `name.ilike.%${surname}%`,
    `direct_order_name.ilike.%${surname}%`,
  ]);
  const { data: fallbackMatches, error: fallbackError } = await fallbackQuery.or(fallbackFilters.join(","));
  if (fallbackError) throw new Error(`Failed to resolve member '${normalizedName}': ${fallbackError.message}`);

  return resolveMemberBioguideMatch(fallbackMatches ?? [], {
    memberName: normalizedName,
    chamber,
    state: normalizedState,
  });
}

async function resolveOrganizationId(sb, { name, ticker }) {
  const cleanedTicker = asString(ticker)?.toUpperCase() ?? null;
  if (cleanedTicker) {
    const { data, error } = await sb.from("organizations").select("id").eq("ticker", cleanedTicker).maybeSingle();
    if (error) throw new Error(`Failed to resolve organization ticker: ${error.message}`);
    if (data?.id != null) return data.id;
  }

  const normalizedName = asString(name) ? normalizeOrganizationName(name) : "";
  if (!normalizedName) return null;

  const [{ data: aliasData, error: aliasError }, { data: orgData, error: orgError }] = await Promise.all([
    sb.from("organization_aliases").select("organization_id").eq("normalized_alias", normalizedName).maybeSingle(),
    sb.from("organizations").select("id").eq("normalized_name", normalizedName).maybeSingle(),
  ]);
  if (aliasError) throw new Error(`Failed to resolve organization alias: ${aliasError.message}`);
  if (orgError) throw new Error(`Failed to resolve organization name: ${orgError.message}`);
  return aliasData?.organization_id ?? orgData?.id ?? null;
}

async function ensureOrganization(sb, { assetName, ticker }) {
  const normalizedName = normalizeOrganizationName(assetName);
  if (!normalizedName) return null;
  let organizationId = await resolveOrganizationId(sb, { name: assetName, ticker });
  if (organizationId == null) {
    const { data, error } = await sb
      .from("organizations")
      .insert({
        canonical_name: assetName,
        normalized_name: normalizedName,
        ticker: asString(ticker)?.toUpperCase() ?? null,
        source_coverage: { disclosures: true },
      })
      .select("id")
      .single();
    if (error) throw new Error(`Failed to create organization '${assetName}': ${error.message}`);
    organizationId = data.id;
  }

  await sb.from("organization_aliases").upsert({
    organization_id: organizationId,
    alias: assetName,
    normalized_alias: normalizedName,
    source_type: "house_clerk_ptr",
    source_row_id: null,
  }, { onConflict: "normalized_alias" });

  const cleanedTicker = asString(ticker)?.toUpperCase() ?? null;
  if (cleanedTicker) {
    await sb.from("organization_identifiers").upsert({
      organization_id: organizationId,
      source_type: "house_clerk_ptr",
      identifier_type: "ticker",
      identifier_value: cleanedTicker,
    }, { onConflict: "source_type,identifier_type,identifier_value" });
  }

  return organizationId;
}

async function processFiling(sb, filing, { finnhubApiKey, priceCache }) {
  const documentUrl = `${HOUSE_PTR_BASE_URL}/${filing.year}/${filing.docId}.pdf`;
  const archiveUrl = `${HOUSE_INDEX_BASE_URL}/${filing.year}FD.xml`;
  const memberName = [filing.lastName, filing.firstName].filter(Boolean).join(", ") || null;
  const memberState = asString(filing.stateDst)?.slice(0, 2) ?? null;
  const memberResolution = await resolveMemberBioguide(sb, {
    memberName,
    chamber: "House",
    state: memberState,
  });

  const { data: filingRow, error: filingError } = await sb
    .from("disclosure_filings")
    .upsert({
      chamber: "House",
      source_type: "house_clerk_ptr",
      filing_identifier: `house:${filing.year}:${filing.docId}`,
      source_row_key: `house:${filing.year}:${filing.docId}`,
      filing_type: "Periodic Transaction Report",
      member_name: memberName,
      member_first_name: filing.firstName,
      member_last_name: filing.lastName,
      member_state: memberState,
      member_bioguide_id: memberResolution.bioguideId,
      member_resolution_confidence: memberResolution.confidence,
      member_resolution_score: memberResolution.score,
      member_resolution_reason: memberResolution.reason,
      document_url: documentUrl,
      archive_url: archiveUrl,
      filed_date: filing.filingDate,
      disclosure_date: filing.filingDate,
      raw_metadata: {
        year: filing.year,
        docId: filing.docId,
        stateDst: filing.stateDst,
        filingType: "P",
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: "source_row_key" })
    .select("*")
    .single();
  if (filingError) throw new Error(`Failed to upsert filing ${filing.docId}: ${filingError.message}`);

  const pdfBuffer = await fetchBytes(documentUrl);
  const checksum = await sha256Hex(pdfBuffer);
  const extraction = await extractPdfText(pdfBuffer);
  const parsedRows = parseHouseTradeRows(extraction.text);

  await sb.from("disclosure_filings").update({
    checksum_sha256: checksum,
    fetch_status: "fetched",
    parse_status: extraction.text ? (parsedRows.length ? "parsed" : "quarantined") : "quarantined",
    quarantine_reason: extraction.text ? (parsedRows.length ? null : "no_rows_parsed") : "text_extraction_failed",
    member_bioguide_id: memberResolution.bioguideId,
    member_resolution_confidence: memberResolution.confidence,
    member_resolution_score: memberResolution.score,
    member_resolution_reason: memberResolution.reason,
    updated_at: new Date().toISOString(),
  }).eq("id", filingRow.id);

  await sb.from("disclosure_filing_text").upsert({
    filing_id: filingRow.id,
    parser_version: DISCLOSURE_PARSER_VERSION,
    extraction_method: "pdfjs_text_content",
    extraction_status: extraction.text ? "success" : "failed",
    extracted_text: extraction.text,
    parse_diagnostics: {
      pageCount: extraction.pageCount,
      itemCount: extraction.itemCount,
    },
    updated_at: new Date().toISOString(),
  }, { onConflict: "filing_id,parser_version" });

  if (!extraction.text || parsedRows.length === 0) {
    await sb.from("disclosure_ingest_failures").insert({
      filing_id: filingRow.id,
      source_type: "house_clerk_ptr",
      stage: extraction.text ? "parse_rows" : "extract_text",
      error_code: extraction.text ? "no_rows_parsed" : "text_extraction_failed",
      error_message: extraction.text
        ? "No trade rows were parsed from the extracted House PTR text"
        : "PDF text extraction failed for House PTR",
      retryable: true,
      raw_payload: {
        docId: filing.docId,
        pageCount: extraction.pageCount,
        itemCount: extraction.itemCount,
      },
    });
    return { filingId: filingRow.id, parsedRows: 0, normalizedTrades: 0, memberBioguideId: memberResolution.bioguideId ?? null };
  }

  let normalizedTrades = 0;
  for (const row of parsedRows) {
    const amountStats = parseAmountRange(row.amountRange);
    const executionClosePrice = row.symbolGuess && row.transactionDate
      ? await fetchHistoricalClosePrice(finnhubApiKey, row.symbolGuess, row.transactionDate, priceCache)
      : null;
    const estimatedTradeValue = amountStats?.midpoint ?? null;
    const estimatedShareCount = executionClosePrice != null && estimatedTradeValue != null
      ? Number((estimatedTradeValue / executionClosePrice).toFixed(4))
      : null;
    const resolvedShareCount = row.shareCount ?? estimatedShareCount;
    const resolvedShareCountSource = row.shareCount != null
      ? "pdf_exact"
      : estimatedShareCount != null
        ? "estimated_from_amount_and_close"
        : null;

    let organizationId = null;
    if (row.isPublicEquity && row.assetName) {
      organizationId = await ensureOrganization(sb, {
        assetName: row.assetName,
        ticker: row.symbolGuess,
      });
    }

    const sourceRowKey = `house:${filing.year}:${filing.docId}:row:${row.rowOrdinal}`;
    const enrichedRawPayload = {
      ...row.rawPayload,
      amountRangeLower: amountStats?.lower ?? null,
      amountRangeUpper: amountStats?.upper ?? null,
      estimatedTradeValue,
      executionClosePrice,
      estimatedShareCount,
      shareCount: resolvedShareCount,
      shareCountSource: resolvedShareCountSource,
      pricingMethod: executionClosePrice != null && estimatedTradeValue != null
        ? "midpoint_amount_range_div_same_day_close"
        : null,
    };
    await sb.from("disclosure_trade_rows").upsert({
      filing_id: filingRow.id,
      source_row_key: sourceRowKey,
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
      member_bioguide_id: memberResolution.bioguideId,
      member_resolution_confidence: memberResolution.confidence,
      member_resolution_score: memberResolution.score,
      member_resolution_reason: memberResolution.reason,
      quarantine_reason: row.quarantineReason,
      raw_payload: enrichedRawPayload,
      updated_at: new Date().toISOString(),
    }, { onConflict: "source_row_key" });

    if (row.isPublicEquity && memberResolution.bioguideId) {
      await sb.from("member_stock_trades").upsert({
        bioguide_id: memberResolution.bioguideId,
        organization_id: organizationId,
        disclosure_filing_id: filingRow.id,
        source_type: "house_clerk_ptr",
        source_row_key: sourceRowKey,
        symbol: row.symbolGuess,
        asset_name: row.assetName,
        normalized_asset_name: row.normalizedAssetName,
        transaction_date: row.transactionDate,
        disclosure_date: filing.filingDate,
        transaction_type: row.transactionType,
        amount_range: row.amountRange,
        share_count: resolvedShareCount,
        owner_label: row.ownerLabel,
        owner_type: row.ownerType,
        asset_type: row.assetType,
        parse_confidence: row.parseConfidence,
        raw_payload: enrichedRawPayload,
        updated_at: new Date().toISOString(),
      }, { onConflict: "source_row_key" });
      normalizedTrades += 1;
    }
  }

  return {
    filingId: filingRow.id,
    parsedRows: parsedRows.length,
    normalizedTrades,
    memberBioguideId: memberResolution.bioguideId ?? null,
  };
}

async function getExistingParsedFiling(sb, filing) {
  const sourceRowKey = `house:${filing.year}:${filing.docId}`;
  const { data, error } = await sb
    .from("disclosure_filings")
    .select("id,parse_status,member_bioguide_id")
    .eq("source_row_key", sourceRowKey)
    .maybeSingle();
  if (error) throw new Error(`Failed to inspect existing filing ${sourceRowKey}: ${error.message}`);
  return data;
}

async function refreshMemberCases(baseUrl, bioguideId) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/correlation/refresh/member/${encodeURIComponent(bioguideId)}/cases`, {
    method: "POST",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to refresh cases for ${bioguideId} (${response.status}): ${body.slice(0, 300)}`);
  }
  return response.json();
}

export async function runHouseDisclosureIngest({
  sb,
  from,
  to,
  limit = 10,
  offset = 0,
  force = false,
  refreshCases = false,
  refreshBaseUrl = "http://localhost:8787",
  log = console,
  finnhubApiKey = process.env.FINNHUB_API_KEY ?? null,
} = {}) {
  const filings = await fetchHouseFilings(from, to, { limit, offset });
  const results = [];
  const skipped = [];
  const priceCache = new Map();

  for (const filing of filings) {
    const existing = !force ? await getExistingParsedFiling(sb, filing) : null;
    if (existing?.parse_status === "parsed") {
      skipped.push({
        filingId: existing.id,
        memberBioguideId: existing.member_bioguide_id ?? null,
        reason: "already_parsed",
        filingKey: `house:${filing.year}:${filing.docId}`,
      });
      log.log(`Skipping House PTR ${filing.docId} (${filing.filingDate}) because it is already parsed`);
      continue;
    }

    log.log(`Processing House PTR ${filing.docId} (${filing.filingDate})`);
    results.push(await processFiling(sb, filing, { finnhubApiKey, priceCache }));
  }

  const affectedMembers = [...new Set([
    ...results.map((item) => item.memberBioguideId),
    ...skipped.map((item) => item.memberBioguideId),
  ].filter(Boolean))];

  const refreshedMembers = [];
  if (refreshCases) {
    for (const bioguideId of affectedMembers) {
      log.log(`Refreshing cases for ${bioguideId}`);
      await refreshMemberCases(refreshBaseUrl, bioguideId);
      refreshedMembers.push(bioguideId);
    }
  }

  return {
    filingsDiscovered: filings.length,
    filingsProcessed: results.length,
    filingsSkipped: skipped.length,
    parsedRows: results.reduce((sum, item) => sum + item.parsedRows, 0),
    normalizedTrades: results.reduce((sum, item) => sum + item.normalizedTrades, 0),
    affectedMembers,
    refreshedMembers,
    nextOffset: offset + filings.length,
  };
}

async function main() {
  loadDotEnv(DEV_VARS_PATH);
  const { from, to, limit, offset, force } = parseArgs(process.argv.slice(2));
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in api/.dev.vars or the environment");
  }

  const sb = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
  const summary = await runHouseDisclosureIngest({ sb, from, to, limit, offset, force });

  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
