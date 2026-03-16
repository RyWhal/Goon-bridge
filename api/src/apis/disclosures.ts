import { Hono } from "hono";
import type { Env } from "../types";
import { getSupabase } from "../lib/supabase";
import { requireAdminAuth } from "../middleware/admin-auth";
import {
  normalizeDisclosureTradesForFiling,
  refreshHouseDisclosures,
  refreshSenateDisclosures,
} from "../lib/disclosures";

const disclosures = new Hono<Env>();

// All POST (mutation) routes require admin authentication
disclosures.use("/refresh/*", requireAdminAuth);
disclosures.use("/backfill", requireAdminAuth);
disclosures.use("/normalize/*", requireAdminAuth);

function hasSupabase(env: Env["Bindings"]): boolean {
  return !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);
}

function isValidDate(value: string | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseLimit(value: string | undefined, fallback: number, max = 200) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, max));
}

function parseOptionalLimit(value: string | undefined, max = 200): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return parseLimit(value, max, max);
}

function validateDateWindow(from: string | undefined, to: string | undefined) {
  if (!isValidDate(from) || !isValidDate(to)) {
    return { error: "Both 'from' and 'to' must be valid YYYY-MM-DD dates" };
  }
  if (Date.parse(`${from}T00:00:00Z`) > Date.parse(`${to}T00:00:00Z`)) {
    return { error: "'from' date must be on or before 'to' date" };
  }
  return { from, to };
}

async function fetchOrganizationsByIds(sb: ReturnType<typeof getSupabase>, ids: number[]) {
  if (!ids.length) return new Map<number, { id: number; canonical_name: string; ticker: string | null }>();
  const { data, error } = await sb
    .from("organizations")
    .select("id,canonical_name,ticker")
    .in("id", ids);
  if (error) throw new Error(`Failed to load organizations: ${error.message}`);
  return new Map((data ?? []).map((entry) => [entry.id, entry]));
}

async function fetchFilingsByIds(sb: ReturnType<typeof getSupabase>, ids: number[]) {
  if (!ids.length) return new Map<number, { id: number; document_url: string | null; filed_date: string | null }>();
  const { data, error } = await sb
    .from("disclosure_filings")
    .select("id,document_url,filed_date")
    .in("id", ids);
  if (error) throw new Error(`Failed to load disclosure filings: ${error.message}`);
  return new Map((data ?? []).map((entry) => [entry.id, entry]));
}

function mapTradeRecord(
  trade: {
    id: number;
    bioguide_id: string;
    organization_id: number | null;
    disclosure_filing_id: number | null;
    source_type: string;
    source_row_key: string;
    symbol: string | null;
    asset_name: string | null;
    normalized_asset_name: string | null;
    transaction_date: string | null;
    disclosure_date: string | null;
    transaction_type: string | null;
    amount_range: string | null;
    share_count: number | null;
    owner_label: string | null;
    owner_type: string | null;
    asset_type: string | null;
    parse_confidence: string | null;
    raw_payload: Record<string, unknown>;
    created_at: string;
    updated_at: string;
  },
  organizations: Map<number, { id: number; canonical_name: string; ticker: string | null }>,
  filings: Map<number, { id: number; document_url: string | null; filed_date: string | null }>
) {
  const estimatedTradeValue = typeof trade.raw_payload?.estimatedTradeValue === "number"
    ? trade.raw_payload.estimatedTradeValue
    : null;
  const executionClosePrice = typeof trade.raw_payload?.executionClosePrice === "number"
    ? trade.raw_payload.executionClosePrice
    : null;

  const organization = trade.organization_id != null ? organizations.get(trade.organization_id) ?? null : null;
  const filing = trade.disclosure_filing_id != null ? filings.get(trade.disclosure_filing_id) ?? null : null;
  return {
    id: trade.id,
    bioguide_id: trade.bioguide_id,
    source_type: trade.source_type,
    source_row_key: trade.source_row_key,
    symbol: trade.symbol ?? organization?.ticker ?? null,
    asset_name: trade.asset_name,
    normalized_asset_name: trade.normalized_asset_name,
    transaction_date: trade.transaction_date,
    disclosure_date: trade.disclosure_date ?? filing?.filed_date ?? null,
    transaction_type: trade.transaction_type,
    amount_range: trade.amount_range,
    estimated_trade_value: estimatedTradeValue,
    execution_close_price: executionClosePrice,
    share_count: trade.share_count,
    owner_label: trade.owner_label,
    owner_type: trade.owner_type,
    asset_type: trade.asset_type,
    parse_confidence: trade.parse_confidence,
    raw_payload: trade.raw_payload,
    organization: organization
      ? {
          id: organization.id,
          name: organization.canonical_name,
          ticker: organization.ticker,
        }
      : null,
    filing: filing
      ? {
          id: filing.id,
          document_url: filing.document_url,
          filed_date: filing.filed_date,
        }
      : null,
    created_at: trade.created_at,
    updated_at: trade.updated_at,
  };
}

// ── GET /api/disclosures/members/with-trades ────────────────────────────────
disclosures.get("/members/with-trades", async (c) => {
  if (!hasSupabase(c.env)) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const sb = getSupabase(c.env);
  const limit = parseLimit(c.req.query("limit"), 250, 1000);
  const transactionType = c.req.query("transaction_type");

  let tradeQuery = sb
    .from("member_stock_trades")
    .select("bioguide_id,transaction_date")
    .order("transaction_date", { ascending: false, nullsFirst: false })
    .limit(5000);

  if (transactionType) {
    tradeQuery = tradeQuery.eq("transaction_type", transactionType);
  }

  const { data: trades, error } = await tradeQuery;
  if (error) return c.json({ error: error.message }, 500);

  const byMember = new Map<string, { bioguide_id: string; trade_count: number; latest_trade_date: string | null }>();
  for (const trade of trades ?? []) {
    const bioguideId = trade.bioguide_id;
    if (!bioguideId) continue;
    const current = byMember.get(bioguideId);
    if (!current) {
      byMember.set(bioguideId, {
        bioguide_id: bioguideId,
        trade_count: 1,
        latest_trade_date: trade.transaction_date,
      });
      continue;
    }
    current.trade_count += 1;
    if ((trade.transaction_date ?? "") > (current.latest_trade_date ?? "")) {
      current.latest_trade_date = trade.transaction_date;
    }
  }

  const memberIds = [...byMember.keys()];
  const { data: members, error: memberError } = memberIds.length
    ? await sb
      .from("members")
      .select("bioguide_id,name,direct_order_name,party,state,chamber,image_url")
      .in("bioguide_id", memberIds)
    : { data: [], error: null };
  if (memberError) return c.json({ error: memberError.message }, 500);

  const memberMap = new Map((members ?? []).map((entry) => [entry.bioguide_id, entry]));
  const results = [...byMember.values()]
    .map((entry) => ({
      bioguide_id: entry.bioguide_id,
      trade_count: entry.trade_count,
      latest_trade_date: entry.latest_trade_date,
      member: memberMap.get(entry.bioguide_id) ?? null,
    }))
    .sort((left, right) =>
      (right.latest_trade_date ?? "").localeCompare(left.latest_trade_date ?? "")
      || right.trade_count - left.trade_count
    )
    .slice(0, limit);

  return c.json(
    {
      count: byMember.size,
      members: results,
    },
    200,
    { "Cache-Control": "public, max-age=300" }
  );
});

// ── GET /api/disclosures/trades/recent ───────────────────────────────────────
disclosures.get("/trades/recent", async (c) => {
  if (!hasSupabase(c.env)) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const sb = getSupabase(c.env);
  const limit = parseLimit(c.req.query("limit"), 25, 100);
  const transactionType = c.req.query("transaction_type");

  let query = sb
    .from("member_stock_trades")
    .select("*", { count: "exact" })
    .order("transaction_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (transactionType) {
    query = query.eq("transaction_type", transactionType);
  }

  const { data: trades, error, count } = await query;
  if (error) return c.json({ error: error.message }, 500);

  const bioguideIds = [...new Set((trades ?? []).map((trade) => trade.bioguide_id))];
  const organizationIds = [...new Set((trades ?? []).map((trade) => trade.organization_id).filter((value): value is number => value != null))];
  const filingIds = [...new Set((trades ?? []).map((trade) => trade.disclosure_filing_id).filter((value): value is number => value != null))];

  const [{ data: members, error: memberError }, organizations, filings] = await Promise.all([
    bioguideIds.length
      ? sb.from("members").select("bioguide_id,name,direct_order_name,party,state,chamber,image_url").in("bioguide_id", bioguideIds)
      : Promise.resolve({ data: [], error: null }),
    fetchOrganizationsByIds(sb, organizationIds),
    fetchFilingsByIds(sb, filingIds),
  ]);

  if (memberError) return c.json({ error: memberError.message }, 500);
  const memberMap = new Map((members ?? []).map((entry) => [entry.bioguide_id, entry]));

  return c.json(
    {
      count: count ?? trades?.length ?? 0,
      trades: (trades ?? []).map((trade) => ({
        ...mapTradeRecord(trade, organizations, filings),
        member: memberMap.get(trade.bioguide_id) ?? null,
      })),
    },
    200,
    { "Cache-Control": "public, max-age=300" }
  );
});

// ── GET /api/disclosures/member/:bioguideId/trades ──────────────────────────
disclosures.get("/member/:bioguideId/trades", async (c) => {
  if (!hasSupabase(c.env)) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const sb = getSupabase(c.env);
  const bioguideId = c.req.param("bioguideId");
  const limit = parseLimit(c.req.query("limit"), 50, 200);
  const transactionType = c.req.query("transaction_type");

  const { data: member, error: memberError } = await sb
    .from("members")
    .select("bioguide_id,name,direct_order_name,party,state,chamber,image_url")
    .eq("bioguide_id", bioguideId)
    .maybeSingle();

  if (memberError) return c.json({ error: memberError.message }, 500);
  if (!member) return c.json({ error: `Member ${bioguideId} not found` }, 404);

  let tradeQuery = sb
    .from("member_stock_trades")
    .select("*", { count: "exact" })
    .eq("bioguide_id", bioguideId)
    .order("transaction_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (transactionType) {
    tradeQuery = tradeQuery.eq("transaction_type", transactionType);
  }

  const { data: trades, error: tradeError, count } = await tradeQuery;
  if (tradeError) return c.json({ error: tradeError.message }, 500);

  const organizationIds = [...new Set((trades ?? []).map((trade) => trade.organization_id).filter((value): value is number => value != null))];
  const filingIds = [...new Set((trades ?? []).map((trade) => trade.disclosure_filing_id).filter((value): value is number => value != null))];
  const [organizations, filings] = await Promise.all([
    fetchOrganizationsByIds(sb, organizationIds),
    fetchFilingsByIds(sb, filingIds),
  ]);

  return c.json(
    {
      bioguide_id: bioguideId,
      member,
      count: count ?? trades?.length ?? 0,
      trades: (trades ?? []).map((trade) => mapTradeRecord(trade, organizations, filings)),
    },
    200,
    { "Cache-Control": "public, max-age=300" }
  );
});

// ── GET /api/disclosures/filings ─────────────────────────────────────────────
disclosures.get("/filings", async (c) => {
  if (!hasSupabase(c.env)) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const sb = getSupabase(c.env);
  const limit = parseLimit(c.req.query("limit"), 50, 200);
  let query = sb
    .from("disclosure_filings")
    .select("*", { count: "exact" })
    .order("filed_date", { ascending: false, nullsFirst: false })
    .order("updated_at", { ascending: false })
    .limit(limit);

  const chamber = c.req.query("chamber");
  const sourceType = c.req.query("source_type");
  const parseStatus = c.req.query("parse_status");
  if (chamber) query = query.eq("chamber", chamber);
  if (sourceType) query = query.eq("source_type", sourceType);
  if (parseStatus) query = query.eq("parse_status", parseStatus);

  const { data, error, count } = await query;
  if (error) return c.json({ error: error.message }, 500);

  return c.json(
    {
      count: count ?? data?.length ?? 0,
      filings: data ?? [],
    },
    200,
    { "Cache-Control": "public, max-age=900" }
  );
});

// ── POST /api/disclosures/refresh/senate ─────────────────────────────────────
disclosures.post("/refresh/senate", async (c) => {
  if (!hasSupabase(c.env)) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const window = validateDateWindow(c.req.query("from"), c.req.query("to"));
  if ("error" in window) return c.json(window, 400);
  const limit = parseOptionalLimit(c.req.query("limit"), 500);

  try {
    const result = await refreshSenateDisclosures(getSupabase(c.env), { ...window, limit });
    return c.json({ ok: true, ...result });
  } catch (error) {
    return c.json(
      {
        error: "Failed to refresh Senate disclosures",
        detail: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

// ── POST /api/disclosures/refresh/house ──────────────────────────────────────
disclosures.post("/refresh/house", async (c) => {
  if (!hasSupabase(c.env)) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const window = validateDateWindow(c.req.query("from"), c.req.query("to"));
  if ("error" in window) return c.json(window, 400);
  const limit = parseOptionalLimit(c.req.query("limit"), 500);

  try {
    const result = await refreshHouseDisclosures(getSupabase(c.env), { ...window, limit });
    return c.json({ ok: true, ...result });
  } catch (error) {
    return c.json(
      {
        error: "Failed to refresh House disclosures",
        detail: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

// ── POST /api/disclosures/backfill ───────────────────────────────────────────
disclosures.post("/backfill", async (c) => {
  if (!hasSupabase(c.env)) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const chamber = c.req.query("chamber")?.toLowerCase();
  const window = validateDateWindow(c.req.query("from"), c.req.query("to"));
  if ("error" in window) return c.json(window, 400);
  if (chamber !== "house" && chamber !== "senate") {
    return c.json({ error: "Query parameter 'chamber' must be 'house' or 'senate'" }, 400);
  }
  const limit = parseOptionalLimit(c.req.query("limit"), 500);

  try {
    const sb = getSupabase(c.env);
    const result = chamber === "house"
      ? await refreshHouseDisclosures(sb, { ...window, limit })
      : await refreshSenateDisclosures(sb, { ...window, limit });
    return c.json({ ok: true, chamber, ...result });
  } catch (error) {
    return c.json(
      {
        error: `Failed to backfill ${chamber} disclosures`,
        detail: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

// ── POST /api/disclosures/normalize/trades ───────────────────────────────────
disclosures.post("/normalize/trades", async (c) => {
  if (!hasSupabase(c.env)) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const filingId = Number.parseInt(c.req.query("filing_id") ?? "", 10);
  if (!Number.isFinite(filingId) || filingId <= 0) {
    return c.json({ error: "Query parameter 'filing_id' must be a positive integer" }, 400);
  }

  try {
    const result = await normalizeDisclosureTradesForFiling(getSupabase(c.env), filingId);
    return c.json({ ok: true, filing_id: filingId, ...result });
  } catch (error) {
    return c.json(
      {
        error: "Failed to normalize disclosure trades",
        detail: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

export { disclosures };
