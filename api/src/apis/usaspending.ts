import { Context, Hono } from "hono";
import type { Env } from "../types";
import {
  asArray,
  asRecord,
  buildAwardSearchBodies,
  buildRecipientSearchTerms,
  dedupeRecipientCandidates,
  isValidDate,
  normalizeAwardSearchResults,
  normalizeRecipientCandidate,
  summarizeAwards,
  type UsaSpendingAwardSearchResponse,
  type UsaSpendingRecipientCandidate,
} from "../lib/usaspending";
import { FetchTimeoutError, fetchWithTimeout } from "../lib/fetch-with-timeout";
import { readErrorDetail } from "../lib/error-utils";

const usaspending = new Hono<Env>();

const BASE = "https://api.usaspending.gov";
const REQUEST_TIMEOUT_MS = 20_000;

async function usaspendingFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(`${BASE}${path}`, REQUEST_TIMEOUT_MS, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

async function searchAwards(
  bodies: Array<Record<string, unknown>>
): Promise<
  | { ok: true; body: UsaSpendingAwardSearchResponse; requestBody: Record<string, unknown> }
  | { ok: false; status: number; detail: string | null; requestBody: Record<string, unknown> }
> {
  let lastFailure:
    | { ok: false; status: number; detail: string | null; requestBody: Record<string, unknown> }
    | null = null;

  for (const body of bodies) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
      }

      let resp: Response;
      try {
        resp = await usaspendingFetch("/api/v2/search/spending_by_award/", {
          method: "POST",
          body: JSON.stringify(body),
        });
      } catch (error) {
        lastFailure = {
          ok: false,
          status: 502,
          detail: error instanceof Error ? error.message : String(error),
          requestBody: body,
        };
        continue;
      }

      if (resp.ok) {
        const raw = (await resp.json()) as UsaSpendingAwardSearchResponse & { detail?: string };
        // USAspending occasionally returns HTTP 200 with an error body
        if (raw && typeof raw === "object" && raw.detail && !raw.results) {
          lastFailure = { ok: false, status: 500, detail: String(raw.detail), requestBody: body };
          continue;
        }
        return { ok: true, body: raw, requestBody: body };
      }

      lastFailure = {
        ok: false,
        status: resp.status,
        detail: await readErrorDetail(resp),
        requestBody: body,
      };

      if (resp.status < 500) {
        return lastFailure;
      }
    }
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

async function postJson(path: string, body: Record<string, unknown>) {
  let resp: Response;
  try {
    resp = await usaspendingFetch(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (error) {
    return {
      ok: false as const,
      status: 502,
      detail: error instanceof Error ? error.message : String(error),
      requestBody: body,
    };
  }

  if (!resp.ok) {
    return {
      ok: false as const,
      status: resp.status,
      detail: await readErrorDetail(resp),
      requestBody: body,
    };
  }

  return {
    ok: true as const,
    body: await resp.json(),
    requestBody: body,
  };
}

function getRecipientQueryContext(c: Context<Env>) {
  const q = c.req.query("q")?.trim() ?? null;
  const ticker = c.req.query("ticker")?.trim().toUpperCase() ?? null;
  const company = c.req.query("company")?.trim() ?? null;
  const limit = Math.max(1, Math.min(25, Number(c.req.query("limit") ?? "8") || 8));

  return { q, ticker, company, limit };
}

async function resolveRecipientCandidates(params: {
  q: string | null;
  ticker: string | null;
  company: string | null;
  limit: number;
}) {
  const searchTerms = buildRecipientSearchTerms(params.q, params.company, params.ticker).slice(0, 3);
  const failures: Array<{ status: number; detail: string | null; requestBody: Record<string, unknown> }> = [];
  const rawCandidates: UsaSpendingRecipientCandidate[] = [];

  for (const term of searchTerms) {
    const recipientSearch = await postJson("/api/v2/recipient/", {
      keyword: term,
      limit: params.limit,
    });

    if (!recipientSearch.ok) {
      failures.push(recipientSearch);
      continue;
    }

    const recipientRows = asArray((recipientSearch.body as Record<string, unknown>)?.results);
    const normalizedRecipientSearch = recipientRows
      .map((row) => asRecord(row))
      .filter((row): row is Record<string, unknown> => !!row)
      .map((row) =>
        normalizeRecipientCandidate(row, "recipient_search", {
          query: params.q,
          company: params.company,
          ticker: params.ticker,
        })
      )
      .filter((candidate): candidate is NonNullable<typeof candidate> => !!candidate);

    rawCandidates.push(...normalizedRecipientSearch);
  }

  return {
    searchTerms,
    candidates: dedupeRecipientCandidates(rawCandidates).slice(0, params.limit),
    failures,
  };
}

usaspending.get("/recipients/autocomplete", async (c) => {
  const { q, ticker, company, limit } = getRecipientQueryContext(c);

  if (!q && !ticker && !company) {
    return c.json({ error: "Provide at least one of 'q', 'ticker', or 'company'" }, 400);
  }

  try {
    const result = await resolveRecipientCandidates({ q, ticker, company, limit });
    const bestMatch = result.candidates[0] ?? null;

    return c.json(
      {
        query: { q, ticker, company, limit },
        count: result.candidates.length,
        bestMatch,
        candidates: result.candidates,
        warnings: result.failures.slice(0, 2).map((failure) => ({
          status: failure.status,
          detail: failure.detail,
        })),
      },
      200,
      { "Cache-Control": "public, max-age=21600" }
    );
  } catch (error) {
    if (error instanceof FetchTimeoutError) {
      return c.json({ error: error.message }, 504);
    }

    return c.json(
      {
        error: "Failed to resolve USAspending recipients",
        detail: error instanceof Error ? error.message : String(error),
      },
      502
    );
  }
});

usaspending.get("/recipients/search", async (c) => {
  return usaspending.fetch(new Request(c.req.url.replace("/search", "/autocomplete"), c.req.raw));
});

usaspending.get("/awards", async (c) => {
  const rawSymbol = c.req.query("symbol")?.trim().toUpperCase();
  const company = c.req.query("company")?.trim() ?? null;
  const recipientId = c.req.query("recipient_id")?.trim() ?? null;
  const recipientName = c.req.query("recipient_name")?.trim() ?? null;
  const from = c.req.query("from");
  const to = c.req.query("to");

  if (!rawSymbol) return c.json({ error: "Missing required query parameter 'symbol'" }, 400);
  if (!isValidDate(from)) return c.json({ error: "Invalid 'from' date (use YYYY-MM-DD)" }, 400);
  if (!isValidDate(to)) return c.json({ error: "Invalid 'to' date (use YYYY-MM-DD)" }, 400);
  if (Date.parse(`${from}T00:00:00Z`) > Date.parse(`${to}T00:00:00Z`)) {
    return c.json({ error: "'from' date must be on or before 'to' date" }, 400);
  }

  const recipientSearchTerms = buildRecipientSearchTerms(recipientName, company, rawSymbol);

  try {
    const attempts = buildAwardSearchBodies({
      from,
      to,
      recipientId,
      recipientName,
      recipientSearchTerms,
      limit: 100,
    });
    const result = await searchAwards(attempts);

    if (!result.ok) {
      console.error("USAspending upstream error", {
        status: result.status,
        symbol: rawSymbol,
        company,
        recipientId,
        recipientName,
        from,
        to,
        detail: result.detail,
        requestBody: result.requestBody,
      });
      return c.json(
        {
          error: `USAspending API: ${result.status}`,
          ...(result.detail ? { detail: result.detail } : {}),
        },
        502
      );
    }

    const raw = result.body;
    const data = asArray(raw.results)
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => !!item);
    const records = normalizeAwardSearchResults(data, rawSymbol);

    return c.json(
      {
        symbol: rawSymbol,
        company,
        from,
        to,
        count: raw.page_metadata?.count ?? records.length,
        recipient: {
          recipientId,
          recipientName,
          usedRecipientId: false,
          searchTerms: recipientSearchTerms,
        },
        summary: summarizeAwards(records),
        data: records,
      },
      200,
      { "Cache-Control": "public, max-age=21600" }
    );
  } catch (error) {
    console.error("USAspending handler failure", {
      symbol: rawSymbol,
      company,
      recipientId,
      recipientName,
      from,
      to,
      detail: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof FetchTimeoutError) {
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
