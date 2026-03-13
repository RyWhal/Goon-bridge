import { Hono } from "hono";
import type { Env } from "../types";

const finnhub = new Hono<Env>();

const BASE = "https://finnhub.io/api/v1";
const FINNHUB_FETCH_TIMEOUT_MS = 12_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class FinnhubTimeoutError extends Error {
  constructor(message = "Finnhub request timed out") {
    super(message);
    this.name = "FinnhubTimeoutError";
  }
}

interface FinnhubLobbyingRecord {
  symbol?: string | null;
  name?: string | null;
  description?: string | null;
  country?: string | null;
  uuid?: string | null;
  year?: number | null;
  period?: string | null;
  type?: string | null;
  documentUrl?: string | null;
  income?: number | null;
  expenses?: number | null;
  postedName?: string | null;
  dtPosted?: string | null;
  clientId?: string | null;
  registrantId?: string | null;
  senateId?: string | null;
  houseRegistrantId?: string | null;
}

interface FinnhubUsaSpendingRecord {
  symbol?: string | null;
  recipientName?: string | null;
  recipientParentName?: string | null;
  country?: string | null;
  totalValue?: number | null;
  actionDate?: string | null;
  performanceStartDate?: string | null;
  performanceEndDate?: string | null;
  awardingAgencyName?: string | null;
  awardingSubAgencyName?: string | null;
  awardingOfficeName?: string | null;
  performanceCountry?: string | null;
  performanceCity?: string | null;
  performanceCounty?: string | null;
  performanceState?: string | null;
  performanceZipCode?: string | null;
  performanceCongressionalDistrict?: string | null;
  awardDescription?: string | null;
  naicsCode?: string | null;
  permalink?: string | null;
}

interface FinnhubSymbolSearchResult {
  description?: string | null;
  displaySymbol?: string | null;
  symbol?: string | null;
  type?: string | null;
}

async function finnhubFetch(
  path: string,
  apiKey: string,
  params: Record<string, string>
): Promise<Response> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("token", apiKey);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FINNHUB_FETCH_TIMEOUT_MS);

  try {
    return await fetch(url.toString(), { signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new FinnhubTimeoutError(
        `Finnhub request timed out after ${FINNHUB_FETCH_TIMEOUT_MS}ms`
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
      error?: string;
      message?: string;
      detail?: string;
    };
    return parsed.error ?? parsed.message ?? parsed.detail ?? raw.slice(0, 300);
  } catch {
    return raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || null;
  }
}

function isValidDate(value: string | undefined): value is string {
  if (!value || !DATE_RE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed);
}

function scoreSymbolMatch(query: string, item: FinnhubSymbolSearchResult): number {
  const normalizedQuery = query.trim().toUpperCase();
  const symbol = item.symbol?.trim().toUpperCase() ?? "";
  const displaySymbol = item.displaySymbol?.trim().toUpperCase() ?? "";
  const description = item.description?.trim().toUpperCase() ?? "";
  const type = item.type?.trim().toUpperCase() ?? "";

  let score = 0;

  if (type.includes("COMMON")) score += 40;
  if (type.includes("ADR")) score -= 5;
  if (displaySymbol.includes(".")) score -= 25;
  if (symbol === normalizedQuery || displaySymbol === normalizedQuery) score += 120;
  if (description === normalizedQuery) score += 90;
  if (description.startsWith(normalizedQuery)) score += 60;
  if (description.includes(normalizedQuery)) score += 25;
  if (symbol.startsWith(normalizedQuery) || displaySymbol.startsWith(normalizedQuery)) score += 15;

  return score;
}

finnhub.get("/symbol-lookup", async (c) => {
  const apiKey = c.env.FINNHUB_API_KEY;
  if (!apiKey) return c.json({ error: "Finnhub API key not configured" }, 500);

  const query = c.req.query("q")?.trim();
  if (!query) return c.json({ error: "Missing required query parameter 'q'" }, 400);

  try {
    const resp = await finnhubFetch("/search", apiKey, {
      q: query,
      exchange: "US",
    });

    if (!resp.ok) {
      const detail = await readErrorDetail(resp);
      return c.json(
        {
          error: `Finnhub API: ${resp.status}`,
          ...(detail ? { detail } : {}),
        },
        502
      );
    }

    const raw = (await resp.json()) as {
      count?: number;
      result?: FinnhubSymbolSearchResult[];
    };

    const candidates = (Array.isArray(raw.result) ? raw.result : [])
      .map((item) => ({
        symbol: item.symbol ?? null,
        displaySymbol: item.displaySymbol ?? null,
        description: item.description ?? null,
        type: item.type ?? null,
        score: scoreSymbolMatch(query, item),
      }))
      .sort((a, b) => b.score - a.score);

    const bestMatch = candidates[0] ?? null;

    return c.json(
      {
        query,
        count: raw.count ?? candidates.length,
        bestMatch,
        candidates,
      },
      200,
      { "Cache-Control": "public, max-age=21600" }
    );
  } catch (error) {
    if (error instanceof FinnhubTimeoutError) {
      return c.json({ error: error.message }, 504);
    }

    return c.json(
      {
        error: "Failed to fetch from Finnhub API",
        detail: error instanceof Error ? error.message : String(error),
      },
      502
    );
  }
});

finnhub.get("/lobbying", async (c) => {
  const apiKey = c.env.FINNHUB_API_KEY;
  if (!apiKey) return c.json({ error: "Finnhub API key not configured" }, 500);

  const rawSymbol = c.req.query("symbol")?.trim().toUpperCase();
  const from = c.req.query("from");
  const to = c.req.query("to");

  if (!rawSymbol) return c.json({ error: "Missing required query parameter 'symbol'" }, 400);
  if (!isValidDate(from)) return c.json({ error: "Invalid 'from' date (use YYYY-MM-DD)" }, 400);
  if (!isValidDate(to)) return c.json({ error: "Invalid 'to' date (use YYYY-MM-DD)" }, 400);
  if (Date.parse(`${from}T00:00:00Z`) > Date.parse(`${to}T00:00:00Z`)) {
    return c.json({ error: "'from' date must be on or before 'to' date" }, 400);
  }

  try {
    const resp = await finnhubFetch("/stock/lobbying", apiKey, {
      symbol: rawSymbol,
      from,
      to,
    });

    if (!resp.ok) {
      const detail = await readErrorDetail(resp);
      return c.json(
        {
          error: `Finnhub API: ${resp.status}`,
          ...(detail ? { detail } : {}),
        },
        502
      );
    }

    const raw = (await resp.json()) as {
      data?: FinnhubLobbyingRecord[];
      symbol?: string;
    };

    const data = Array.isArray(raw.data) ? raw.data : [];
    const records = data.map((item) => {
      const inSenate = Boolean(item.senateId?.trim());
      const inHouse = Boolean(item.houseRegistrantId?.trim());
      const chambers = [
        ...(inSenate ? ["Senate"] : []),
        ...(inHouse ? ["House"] : []),
      ];

      return {
        symbol: item.symbol ?? rawSymbol,
        name: item.name ?? null,
        description: item.description ?? null,
        country: item.country ?? null,
        uuid: item.uuid ?? null,
        year: item.year ?? null,
        period: item.period ?? null,
        type: item.type ?? null,
        documentUrl: item.documentUrl ?? null,
        income: item.income ?? null,
        expenses: item.expenses ?? null,
        postedName: item.postedName ?? null,
        dtPosted: item.dtPosted ?? null,
        clientId: item.clientId ?? null,
        registrantId: item.registrantId ?? null,
        senateId: item.senateId ?? null,
        houseRegistrantId: item.houseRegistrantId ?? null,
        chambers,
        chamberLabel:
          chambers.length === 2 ? "Senate + House" : chambers[0] ?? "Unknown",
      };
    });

    const senateCount = records.filter((item) => item.chambers.includes("Senate")).length;
    const houseCount = records.filter((item) => item.chambers.includes("House")).length;

    return c.json(
      {
        symbol: raw.symbol ?? rawSymbol,
        from,
        to,
        count: records.length,
        summary: {
          senateCount,
          houseCount,
          dualFiledCount: records.filter((item) => item.chambers.length === 2).length,
        },
        data: records,
      },
      200,
      { "Cache-Control": "public, max-age=21600" }
    );
  } catch (error) {
    if (error instanceof FinnhubTimeoutError) {
      return c.json({ error: error.message }, 504);
    }

    return c.json(
      {
        error: "Failed to fetch from Finnhub API",
        detail: error instanceof Error ? error.message : String(error),
      },
      502
    );
  }
});

finnhub.get("/usa-spending", async (c) => {
  const apiKey = c.env.FINNHUB_API_KEY;
  if (!apiKey) return c.json({ error: "Finnhub API key not configured" }, 500);

  const rawSymbol = c.req.query("symbol")?.trim().toUpperCase();
  const from = c.req.query("from");
  const to = c.req.query("to");

  if (!rawSymbol) return c.json({ error: "Missing required query parameter 'symbol'" }, 400);
  if (!isValidDate(from)) return c.json({ error: "Invalid 'from' date (use YYYY-MM-DD)" }, 400);
  if (!isValidDate(to)) return c.json({ error: "Invalid 'to' date (use YYYY-MM-DD)" }, 400);
  if (Date.parse(`${from}T00:00:00Z`) > Date.parse(`${to}T00:00:00Z`)) {
    return c.json({ error: "'from' date must be on or before 'to' date" }, 400);
  }

  try {
    const resp = await finnhubFetch("/stock/usa-spending", apiKey, {
      symbol: rawSymbol,
      from,
      to,
    });

    if (!resp.ok) {
      const detail = await readErrorDetail(resp);
      return c.json(
        {
          error: `Finnhub API: ${resp.status}`,
          ...(detail ? { detail } : {}),
        },
        502
      );
    }

    const raw = (await resp.json()) as {
      data?: FinnhubUsaSpendingRecord[];
      symbol?: string;
    };

    const data = Array.isArray(raw.data) ? raw.data : [];
    const records = data
      .map((item) => ({
        symbol: item.symbol ?? rawSymbol,
        recipientName: item.recipientName ?? null,
        recipientParentName: item.recipientParentName ?? null,
        country: item.country ?? null,
        totalValue: typeof item.totalValue === "number" ? item.totalValue : null,
        actionDate: item.actionDate ?? null,
        performanceStartDate: item.performanceStartDate ?? null,
        performanceEndDate: item.performanceEndDate ?? null,
        awardingAgencyName: item.awardingAgencyName ?? null,
        awardingSubAgencyName: item.awardingSubAgencyName ?? null,
        awardingOfficeName: item.awardingOfficeName ?? null,
        performanceCountry: item.performanceCountry ?? null,
        performanceCity: item.performanceCity ?? null,
        performanceCounty: item.performanceCounty ?? null,
        performanceState: item.performanceState ?? null,
        performanceZipCode: item.performanceZipCode ?? null,
        performanceCongressionalDistrict: item.performanceCongressionalDistrict ?? null,
        awardDescription: item.awardDescription ?? null,
        naicsCode: item.naicsCode ?? null,
        permalink: item.permalink ?? null,
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
        symbol: raw.symbol ?? rawSymbol,
        from,
        to,
        count: records.length,
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
    if (error instanceof FinnhubTimeoutError) {
      return c.json({ error: error.message }, 504);
    }

    return c.json(
      {
        error: "Failed to fetch from Finnhub API",
        detail: error instanceof Error ? error.message : String(error),
      },
      502
    );
  }
});

export { finnhub };
