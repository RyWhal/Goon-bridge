import { Hono } from "hono";
import type { Env } from "../types";

const usaspending = new Hono<Env>();

const BASE = "https://api.usaspending.gov";
const REQUEST_TIMEOUT_MS = 12_000;
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

class UsaSpendingTimeoutError extends Error {
  constructor(message = "USAspending request timed out") {
    super(message);
    this.name = "UsaSpendingTimeoutError";
  }
}

type UsaSpendingAwardSearchRow = Record<string, unknown>;

async function usaspendingFetch(path: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(`${BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new UsaSpendingTimeoutError(
        `USAspending request timed out after ${REQUEST_TIMEOUT_MS}ms`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readErrorDetail(resp: Response): Promise<string | null> {
  const raw = await resp.text().catch(() => "");
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as {
      detail?: string;
      message?: string;
      status?: string;
      error?: string;
    };
    return parsed.detail ?? parsed.message ?? parsed.error ?? parsed.status ?? raw.slice(0, 300);
  } catch {
    return raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || null;
  }
}

type AwardSearchResponse = {
  results?: UsaSpendingAwardSearchRow[];
  page_metadata?: {
    count?: number;
  };
};

function isValidDate(value: string | undefined): value is string {
  if (!value || !DATE_RE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stripCorporateSuffixes(value: string): string {
  return value
    .replace(/\b(inc|incorporated|corp|corporation|company|co|llc|ltd|limited|plc|holdings|holding|group)\b\.?/gi, "")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildRecipientSearchText(companyName: string | null, symbol: string): string[] {
  const candidates = [companyName, stripCorporateSuffixes(companyName ?? ""), symbol]
    .map((value) => value?.trim())
    .filter((value): value is string => !!value);

  return [...new Set(candidates)];
}

function makeAwardUrl(generatedInternalId: string | null): string | null {
  if (!generatedInternalId) return null;
  return `https://www.usaspending.gov/award/${encodeURIComponent(generatedInternalId)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function searchAwards(
  bodies: Array<Record<string, unknown>>
): Promise<
  | { ok: true; body: AwardSearchResponse; requestBody: Record<string, unknown> }
  | { ok: false; status: number; detail: string | null; requestBody: Record<string, unknown> }
> {
  let lastFailure:
    | { ok: false; status: number; detail: string | null; requestBody: Record<string, unknown> }
    | null = null;

  for (const body of bodies) {
    const resp = await usaspendingFetch("/api/v2/search/spending_by_award/", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (resp.ok) {
      return {
        ok: true,
        body: (await resp.json()) as AwardSearchResponse,
        requestBody: body,
      };
    }

    lastFailure = {
      ok: false,
      status: resp.status,
      detail: await readErrorDetail(resp),
      requestBody: body,
    };

    if (resp.status < 500) break;
  }

  return (
    lastFailure ?? {
      ok: false,
      status: 502,
      detail: "No response from USAspending API",
      requestBody: bodies[0] ?? {},
    }
  );
}

usaspending.get("/awards", async (c) => {
  const rawSymbol = c.req.query("symbol")?.trim().toUpperCase();
  const company = c.req.query("company")?.trim() ?? null;
  const from = c.req.query("from");
  const to = c.req.query("to");

  if (!rawSymbol) return c.json({ error: "Missing required query parameter 'symbol'" }, 400);
  if (!isValidDate(from)) return c.json({ error: "Invalid 'from' date (use YYYY-MM-DD)" }, 400);
  if (!isValidDate(to)) return c.json({ error: "Invalid 'to' date (use YYYY-MM-DD)" }, 400);
  if (Date.parse(`${from}T00:00:00Z`) > Date.parse(`${to}T00:00:00Z`)) {
    return c.json({ error: "'from' date must be on or before 'to' date" }, 400);
  }

  const recipientSearchText = buildRecipientSearchText(company, rawSymbol);
  const primarySearchText = recipientSearchText[0] ?? rawSymbol;
  const fallbackSearchText = recipientSearchText[1] ?? rawSymbol;

  try {
    const attempts: Array<Record<string, unknown>> = [
      {
        filters: {
          recipient_search_text: [primarySearchText],
          time_period: [{ start_date: from, end_date: to }],
          award_type_codes: CONTRACT_AWARD_TYPE_CODES,
        },
        fields: AWARD_SEARCH_FIELDS,
        page: 1,
        limit: 100,
        sort: "Base Obligation Date",
        order: "desc",
      },
    ];

    if (fallbackSearchText !== primarySearchText) {
      attempts.push({
        filters: {
          recipient_search_text: [fallbackSearchText],
          time_period: [{ start_date: from, end_date: to }],
          award_type_codes: CONTRACT_AWARD_TYPE_CODES,
        },
        fields: AWARD_SEARCH_FIELDS,
        page: 1,
        limit: 100,
        sort: "Base Obligation Date",
        order: "desc",
      });
    }

    const result = await searchAwards(attempts);

    if (!result.ok) {
      const detail = result.detail;
      console.error("USAspending upstream error", {
        status: result.status,
        symbol: rawSymbol,
        company,
        recipientSearchText,
        from,
        to,
        detail,
        requestBody: result.requestBody,
      });
      return c.json(
        {
          error: `USAspending API: ${result.status}`,
          ...(detail ? { detail } : {}),
        },
        502
      );
    }

    const raw = result.body;

    const data = Array.isArray(raw.results) ? raw.results : [];
    const records = data
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => !!item)
      .map((item) => ({
        symbol: rawSymbol,
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

    const totalValue = records.reduce((sum, item) => sum + (item.totalValue ?? 0), 0);
    const agenciesByValue = new Map<string, number>();
    for (const record of records) {
      const agency = record.awardingAgencyName ?? "Unknown";
      agenciesByValue.set(agency, (agenciesByValue.get(agency) ?? 0) + (record.totalValue ?? 0));
    }

    const topAgencyEntry = [...agenciesByValue.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;

    return c.json(
      {
        symbol: rawSymbol,
        company,
        from,
        to,
        count: raw.page_metadata?.count ?? records.length,
        summary: {
          totalValue,
          averageAwardValue: records.length ? totalValue / records.length : 0,
          agencyCount: agenciesByValue.size,
          topAgencyName: topAgencyEntry?.[0] ?? null,
          topAgencyValue: topAgencyEntry?.[1] ?? null,
        },
        data: records,
      },
      200,
      { "Cache-Control": "public, max-age=21600" }
    );
  } catch (error) {
    console.error("USAspending handler failure", {
      symbol: rawSymbol,
      company,
      from,
      to,
      detail: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof UsaSpendingTimeoutError) {
      return c.json({ error: error.message }, 504);
    }

    return c.json(
      {
        error: "Failed to fetch from USAspending API",
        detail: error instanceof Error ? error.message : String(error),
      },
      502
    );
  }
});

export { usaspending };
