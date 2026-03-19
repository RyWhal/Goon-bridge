import { Hono } from "hono";
import type { Env } from "../types";
import { FetchTimeoutError, fetchWithTimeout } from "../lib/fetch-with-timeout";

const lda = new Hono<Env>();

const BASE = "https://lda.senate.gov/api/v1";
const LDA_FETCH_TIMEOUT_MS = 10_000;

// UUID v4 pattern
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LdaLobbyistEntry {
  lobbyist?: {
    first_name?: string | null;
    last_name?: string | null;
    covered_position?: string | null;
  } | null;
}

interface LdaActivity {
  general_issue_area_code?: string | null;
  specific_issues?: string | null;
  lobbyists?: LdaLobbyistEntry[] | null;
}

interface LdaFilingResponse {
  lobbying_activities?: LdaActivity[] | null;
}

lda.get("/filing", async (c) => {
  const uuid = c.req.query("uuid")?.trim();
  if (!uuid) return c.json({ error: "Missing required query parameter 'uuid'" }, 400);
  if (!UUID_RE.test(uuid)) return c.json({ error: "Invalid UUID format" }, 400);

  try {
    const resp = await fetchWithTimeout(`${BASE}/filings/${uuid}/`, LDA_FETCH_TIMEOUT_MS);

    if (!resp.ok) {
      return c.json({ error: `Senate LDA API: ${resp.status}` }, 502);
    }

    const raw = (await resp.json()) as LdaFilingResponse;
    const activities = Array.isArray(raw.lobbying_activities) ? raw.lobbying_activities : [];

    return c.json(
      {
        uuid,
        activities: activities.map((act) => ({
          generalIssueAreaCode: act.general_issue_area_code ?? null,
          specificIssues: act.specific_issues ?? null,
          lobbyists: (act.lobbyists ?? []).map((entry) => ({
            firstName: entry.lobbyist?.first_name ?? null,
            lastName: entry.lobbyist?.last_name ?? null,
            coveredOfficialPosition: entry.lobbyist?.covered_position ?? null,
          })),
        })),
      },
      200,
      { "Cache-Control": "public, max-age=86400" }
    );
  } catch (error) {
    if (error instanceof FetchTimeoutError) {
      return c.json({ error: error.message }, 504);
    }
    return c.json(
      {
        error: "Failed to fetch from Senate LDA API",
        detail: error instanceof Error ? error.message : String(error),
      },
      502
    );
  }
});

export { lda };
