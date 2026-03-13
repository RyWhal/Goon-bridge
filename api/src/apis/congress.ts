import { Hono } from "hono";
import type { Env } from "../types";
import { getSupabase } from "../lib/supabase";

const congress = new Hono<Env>();

const BASE = "https://api.congress.gov/v3";

async function congressFetch(
  path: string,
  apiKey: string,
  params?: Record<string, string>
): Promise<Response> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("format", "json");
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  return fetch(url.toString());
}

/**
 * Check if Supabase is configured. Gracefully degrade if not.
 */
function hasSupabase(env: Env["Bindings"]): boolean {
  return !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);
}


function parseBoundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function getVoteRouteMeta(chamber: string) {
  const normalized = chamber.toLowerCase();
  return normalized === "senate"
    ? { normalized: "senate", label: "Senate", pathPrefix: "senate-vote" }
    : { normalized: "house", label: "House", pathPrefix: "house-vote" };
}

type CongressVoteMember = {
  bioguideId?: string;
  bioguideID?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  party?: string;
  voteParty?: string;
  state?: string;
  voteState?: string;
  votePosition?: string;
  memberVoted?: string;
  voteCast?: string;
};

function extractVoteMembers(rawVote?: Record<string, unknown>): CongressVoteMember[] {
  return ((rawVote?.members as CongressVoteMember[] | undefined) ?? []).map((member) => ({
    bioguideId: member.bioguideId ?? member.bioguideID,
    firstName: member.firstName,
    lastName: member.lastName,
    fullName: member.fullName,
    party: member.party ?? member.voteParty,
    state: member.state ?? member.voteState,
    votePosition: member.votePosition ?? member.memberVoted ?? member.voteCast,
  }));
}

function extractVoteMembersFromResponse(raw?: Record<string, unknown>): CongressVoteMember[] {
  const directMembers = raw?.members as CongressVoteMember[] | undefined;
  if (Array.isArray(directMembers) && directMembers.length > 0) {
    return extractVoteMembers({ members: directMembers });
  }

  const nested =
    (raw?.houseRollCallVoteMemberVotes as Record<string, unknown> | undefined) ??
    (raw?.senateRollCallVoteMemberVotes as Record<string, unknown> | undefined) ??
    (raw?.houseRollCallVoteMember as Record<string, unknown> | undefined) ??
    (raw?.senateRollCallVoteMember as Record<string, unknown> | undefined) ??
    (raw?.houseRollCallVote as Record<string, unknown> | undefined) ??
    (raw?.senateRollCallVote as Record<string, unknown> | undefined);

  const resultMembers = nested?.results as CongressVoteMember[] | undefined;
  if (Array.isArray(resultMembers) && resultMembers.length > 0) {
    return resultMembers.map((member) => ({
      bioguideId: member.bioguideId ?? member.bioguideID,
      firstName: member.firstName,
      lastName: member.lastName,
      fullName: member.fullName,
      party: member.party ?? member.voteParty,
      state: member.state ?? member.voteState,
      votePosition: member.votePosition ?? member.memberVoted ?? member.voteCast,
    }));
  }

  return extractVoteMembers(nested);
}


type CongressPartyHistoryItem = {
  partyName?: string;
  partyAbbreviation?: string;
};

type CongressMemberLike = {
  party?: string;
  partyName?: string;
  partyHistory?: CongressPartyHistoryItem[];
  terms?: { item?: Array<{ party?: string; partyName?: string; partyAbbreviation?: string }> };
};

type CongressMemberApiMember = {
  bioguideId?: string;
  name?: string;
  party?: string;
  partyName?: string;
  partyHistory?: CongressPartyHistoryItem[];
  state?: string;
  district?: number;
  depiction?: { imageUrl?: string };
  [key: string]: unknown;
};

type CongressMembersResponse = {
  members?: CongressMemberApiMember[];
  pagination?: { count?: number; next?: string };
  [key: string]: unknown;
};

function normalizePartyValue(raw?: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.trim();
  if (!cleaned) return null;

  if (cleaned.length === 1) {
    const c = cleaned.toUpperCase();
    if (c === "D" || c === "R" || c === "I") return c;
    return cleaned;
  }

  const lower = cleaned.toLowerCase();
  if (lower.includes("democrat")) return "D";
  if (lower.includes("republic")) return "R";
  if (lower.includes("independent")) return "I";

  return cleaned;
}

function extractMemberParty(member: CongressMemberLike): string | null {
  const history = Array.isArray(member.partyHistory)
    ? member.partyHistory
    : (member.partyHistory as unknown as { item?: CongressPartyHistoryItem[] } | undefined)?.item;
  const currentTerm = member.terms?.item?.[0];

  const candidates = [
    normalizePartyValue(member.party),
    normalizePartyValue(member.partyName),
    normalizePartyValue(history?.[0]?.partyAbbreviation),
    normalizePartyValue(history?.[0]?.partyName),
    normalizePartyValue(currentTerm?.partyAbbreviation),
    normalizePartyValue(currentTerm?.partyName),
    normalizePartyValue(currentTerm?.party),
  ];
  return candidates.find((value): value is string => !!value) ?? null;
}

function normalizeCongressMembers(members: CongressMemberApiMember[]) {
  return members.map((member) => ({
    ...member,
    party: extractMemberParty(member),
  }));
}

async function fetchCongressMembersPage(
  apiKey: string,
  congressNum: string,
  limit: number,
  offset: number
): Promise<CongressMembersResponse> {
  const resp = await congressFetch(`/member/congress/${congressNum}`, apiKey, {
    limit: limit.toString(),
    offset: offset.toString(),
  });

  if (!resp.ok) {
    throw new Error(`Congress API: ${resp.status}`);
  }

  return (await resp.json()) as CongressMembersResponse;
}

async function fetchAllCongressMembers(apiKey: string, congressNum: string): Promise<CongressMemberApiMember[]> {
  const allMembers: CongressMemberApiMember[] = [];
  const pageSize = 250;

  for (let offset = 0; offset <= 5000; offset += pageSize) {
    const data = await fetchCongressMembersPage(apiKey, congressNum, pageSize, offset);
    const pageMembers = data.members ?? [];
    allMembers.push(...pageMembers);

    if (!data.pagination?.next || pageMembers.length < pageSize) {
      break;
    }
  }

  return allMembers;
}

type CongressBillSponsor = {
  bioguideId?: string;
  fullName?: string;
  party?: string;
  state?: string;
  district?: number;
  [key: string]: unknown;
};

type CongressBillLike = {
  congress?: number;
  type?: string;
  number?: number | string;
  title?: string;
  url?: string;
  originChamber?: string;
  introducedDate?: string;
  updateDate?: string;
  latestAction?: { text?: string; actionDate?: string };
  policyArea?: { name?: string };
  sponsors?: CongressBillSponsor[];
  laws?: Array<{ number?: string; type?: string }>;
  [key: string]: unknown;
};

type CongressBillsResponse = {
  bills?: CongressBillLike[];
  pagination?: { count?: number; next?: string; previous?: string };
  [key: string]: unknown;
};

type CongressBillDetailResponse = {
  bill?: CongressBillLike;
  [key: string]: unknown;
};

type BillStatusKey =
  | "introduced"
  | "passed-house"
  | "passed-senate"
  | "to-president"
  | "became-law"
  | "failed-house"
  | "failed-senate"
  | "vetoed"
  | "failed-procedural"
  | "unknown";

type NormalizedBillStatus = {
  key: BillStatusKey;
  label: string;
  step: number;
  failed: boolean;
};

type CachedBillRow = Record<string, unknown>;

const BILL_SCAN_PAGE_SIZE = 250;
const BILL_SCAN_MAX_OFFSET = 20000;

function normalizeText(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

function textMatches(source: string | undefined | null, query: string | undefined | null): boolean {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return true;
  return normalizeText(source).includes(normalizedQuery);
}

function dedupeStrings(values: Array<string | undefined | null>): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const cleaned = (value ?? "").trim();
    if (cleaned) unique.add(cleaned);
  }
  return [...unique];
}

function getBillIdentity(bill: CongressBillLike | CachedBillRow) {
  const congressNum = asNumber(bill.congress);
  const billType = typeof bill.type === "string"
    ? bill.type.toLowerCase()
    : typeof bill.bill_type === "string"
      ? bill.bill_type.toLowerCase()
      : "";
  const billNumber = asNumber(
    "number" in bill ? bill.number : ("bill_number" in bill ? bill.bill_number : undefined)
  );

  if (!congressNum || !billType || !billNumber) return null;

  return {
    congress: congressNum,
    type: billType,
    number: billNumber,
    key: `${congressNum}-${billType}-${billNumber}`,
  };
}

function extractPrimarySponsor(bill: CongressBillLike | CachedBillRow): CongressBillSponsor | undefined {
  if (Array.isArray(bill.sponsors) && bill.sponsors.length > 0) {
    return bill.sponsors[0];
  }

  const fullName = typeof bill.sponsor_name === "string" ? bill.sponsor_name : undefined;
  const party = typeof bill.sponsor_party === "string" ? bill.sponsor_party : undefined;
  const state = typeof bill.sponsor_state === "string" ? bill.sponsor_state : undefined;
  const bioguideId =
    typeof bill.sponsor_bioguide_id === "string" ? bill.sponsor_bioguide_id : undefined;

  if (!fullName && !party && !state && !bioguideId) return undefined;
  return { bioguideId, fullName, party, state };
}

function classifyBillStatus(bill: CongressBillLike | CachedBillRow): NormalizedBillStatus {
  if (typeof bill.bill_status === "string" && typeof bill.bill_status_label === "string") {
    return {
      key: bill.bill_status as BillStatusKey,
      label: bill.bill_status_label,
      step: asNumber(bill.bill_status_step),
      failed: normalizeText(bill.bill_status).startsWith("failed") || normalizeText(bill.bill_status) === "vetoed",
    };
  }

  const latestActionText =
    typeof bill.latest_action_text === "string"
      ? bill.latest_action_text
      : "latestAction" in bill &&
          bill.latestAction &&
          typeof bill.latestAction === "object" &&
          typeof (bill.latestAction as { text?: unknown }).text === "string"
        ? (bill.latestAction as { text?: string }).text
        : undefined;

  const lower = normalizeText(latestActionText);
  const hasLaw =
    Array.isArray(bill.laws) && bill.laws.length > 0
      ? true
      : lower.includes("became public law") ||
        lower.includes("became private law") ||
        lower.includes("signed by president");

  if (hasLaw) {
    return { key: "became-law", label: "Became Law", step: 4, failed: false };
  }

  if (lower.includes("vetoed by president") || lower.includes("pocket vetoed")) {
    return { key: "vetoed", label: "Vetoed", step: 3, failed: true };
  }

  if (
    lower.includes("failed in house") ||
    lower.includes("failed of passage in house") ||
    lower.includes("not passed house") ||
    lower.includes("motion to suspend the rules and pass failed")
  ) {
    return { key: "failed-house", label: "Failed House", step: 1, failed: true };
  }

  if (
    lower.includes("failed in senate") ||
    lower.includes("failed of passage in senate") ||
    lower.includes("not passed senate") ||
    lower.includes("cloture on the motion to proceed not invoked")
  ) {
    return { key: "failed-senate", label: "Failed Senate", step: 2, failed: true };
  }

  if (
    lower.includes("cloture not invoked") ||
    lower.includes("laid on the table") ||
    lower.includes("indefinitely postponed")
  ) {
    return { key: "failed-procedural", label: "Procedural Failure", step: 0, failed: true };
  }

  if (
    lower.includes("presented to president") ||
    lower.includes("sent to president") ||
    lower.includes("laid before president")
  ) {
    return { key: "to-president", label: "To President", step: 3, failed: false };
  }

  if (
    lower.includes("passed senate") ||
    lower.includes("passed/agreed to in senate") ||
    lower.includes("agreed to in senate")
  ) {
    return { key: "passed-senate", label: "Passed Senate", step: 2, failed: false };
  }

  if (
    lower.includes("passed house") ||
    lower.includes("passed/agreed to in house") ||
    lower.includes("agreed to in house") ||
    lower.includes("on passage passed")
  ) {
    return { key: "passed-house", label: "Passed House", step: 1, failed: false };
  }

  if (!lower) {
    return { key: "unknown", label: "Unknown", step: 0, failed: false };
  }

  return { key: "introduced", label: "Introduced", step: 0, failed: false };
}

function extractCommitteeNames(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];

  const record = raw as Record<string, unknown>;
  const possibleArrays: unknown[] = [
    record.committees,
    (record.committees as { item?: unknown[] } | undefined)?.item,
    record.billCommittees,
    (record.billCommittees as { item?: unknown[] } | undefined)?.item,
  ];

  const items = possibleArrays.flatMap((value) => (Array.isArray(value) ? value : []));
  return dedupeStrings(
    items.map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return undefined;
      const entry = item as Record<string, unknown>;
      return typeof entry.name === "string"
        ? entry.name
        : typeof entry.displayName === "string"
          ? entry.displayName
          : typeof entry.systemCode === "string"
            ? entry.systemCode
            : undefined;
    })
  );
}

function normalizeBillForList(
  bill: CongressBillLike,
  cached?: CachedBillRow,
  committeesOverride?: string[]
) {
  const sponsor = extractPrimarySponsor(bill) ?? extractPrimarySponsor(cached ?? {});
  const normalizedSponsor = sponsor
    ? {
        bioguideId: sponsor.bioguideId,
        fullName: sponsor.fullName,
        party: normalizePartyValue(sponsor.party) ?? sponsor.party,
        state: sponsor.state,
      }
    : undefined;

  const committees = dedupeStrings([
    ...(committeesOverride ?? []),
    ...((Array.isArray(cached?.committee_names) ? cached?.committee_names : []) as string[]),
  ]);
  const status = classifyBillStatus(cached ?? bill);

  return {
    congress: bill.congress,
    type: bill.type?.toLowerCase(),
    number: bill.number,
    title: bill.title,
    url: bill.url,
    originChamber:
      bill.originChamber ??
      (typeof cached?.origin_chamber === "string" ? cached.origin_chamber : undefined),
    updateDate:
      bill.updateDate ??
      (typeof cached?.update_date === "string" ? cached.update_date : undefined),
    introducedDate:
      bill.introducedDate ??
      (typeof cached?.introduced_date === "string" ? cached.introduced_date : undefined),
    latestAction: {
      text:
        bill.latestAction?.text ??
        (typeof cached?.latest_action_text === "string" ? cached.latest_action_text : undefined),
      actionDate:
        bill.latestAction?.actionDate ??
        (typeof cached?.latest_action_date === "string" ? cached.latest_action_date : undefined),
    },
    policyArea: bill.policyArea,
    sponsor: normalizedSponsor,
    committees,
    status,
  };
}

function billMatchesSummaryFilters(
  bill: ReturnType<typeof normalizeBillForList>,
  status: string | null,
  latestAction: string | null
) {
  if (status && bill.status.key !== status) return false;
  if (!textMatches(bill.latestAction?.text, latestAction)) return false;
  return true;
}

function billMatchesMetadataFilters(
  bill: ReturnType<typeof normalizeBillForList>,
  sponsorParty: string | null,
  sponsor: string | null,
  committee: string | null
) {
  if (sponsorParty && normalizePartyValue(bill.sponsor?.party) !== sponsorParty) return false;
  if (!textMatches(bill.sponsor?.fullName, sponsor)) return false;
  if (committee) {
    const matchedCommittee = bill.committees.some((name) => textMatches(name, committee));
    if (!matchedCommittee) return false;
  }
  return true;
}

function toBillCacheRow(bill: CongressBillLike, committeeNames?: string[]) {
  const identity = getBillIdentity(bill);
  if (!identity) return null;

  const sponsor = extractPrimarySponsor(bill);
  const status = classifyBillStatus(bill);

  return {
    congress: identity.congress,
    bill_type: identity.type,
    bill_number: identity.number,
    title: bill.title ?? null,
    policy_area: bill.policyArea?.name ?? null,
    latest_action_text: bill.latestAction?.text ?? null,
    latest_action_date: bill.latestAction?.actionDate ?? null,
    origin_chamber: bill.originChamber ?? null,
    update_date: bill.updateDate ?? null,
    introduced_date: bill.introducedDate ?? null,
    sponsor_bioguide_id: sponsor?.bioguideId ?? null,
    sponsor_name: sponsor?.fullName ?? null,
    sponsor_party: normalizePartyValue(sponsor?.party) ?? sponsor?.party ?? null,
    sponsor_state: sponsor?.state ?? null,
    committee_names: committeeNames?.length ? committeeNames : null,
    bill_status: status.key,
    bill_status_label: status.label,
    bill_status_step: status.step,
  };
}

async function upsertCachedBills(env: Env["Bindings"], rows: Array<Record<string, unknown>>) {
  if (!hasSupabase(env) || rows.length === 0) return;

  const sb = getSupabase(env);
  await sb.from("bills").upsert(rows, { onConflict: "congress,bill_type,bill_number" });
}

async function fetchCongressBillsPage(
  apiKey: string,
  congressNum: string,
  billType: string | null,
  limit: number,
  offset: number,
  sort: string
): Promise<CongressBillsResponse> {
  const params: Record<string, string> = {
    limit: String(limit),
    offset: String(offset),
    sort,
  };

  let path = `/bill/${congressNum}`;
  if (billType) path += `/${billType}`;

  const resp = await congressFetch(path, apiKey, params);
  if (!resp.ok) {
    throw new Error(`Congress API: ${resp.status}`);
  }

  return (await resp.json()) as CongressBillsResponse;
}

async function fetchCongressBillDetail(
  apiKey: string,
  congressNum: number,
  billType: string,
  billNumber: number
): Promise<CongressBillLike | null> {
  const resp = await congressFetch(`/bill/${congressNum}/${billType}/${billNumber}`, apiKey);
  if (!resp.ok) return null;
  const data = (await resp.json()) as CongressBillDetailResponse;
  return data.bill ?? null;
}

async function fetchCongressBillCommittees(
  apiKey: string,
  congressNum: number,
  billType: string,
  billNumber: number
): Promise<string[]> {
  const resp = await congressFetch(`/bill/${congressNum}/${billType}/${billNumber}/committees`, apiKey, {
    limit: "250",
    offset: "0",
  });
  if (!resp.ok) return [];
  return extractCommitteeNames(await resp.json());
}

async function loadCachedBills(
  env: Env["Bindings"],
  congressNum: string,
  bills: CongressBillLike[]
): Promise<Map<string, CachedBillRow>> {
  const result = new Map<string, CachedBillRow>();
  if (!hasSupabase(env) || bills.length === 0) return result;

  const identities = bills.map((bill) => getBillIdentity(bill)).filter(Boolean);
  const billTypes = dedupeStrings(identities.map((identity) => identity?.type));
  const billNumbers = dedupeStrings(identities.map((identity) => String(identity?.number ?? ""))).map((value) =>
    Number.parseInt(value, 10)
  );

  if (billTypes.length === 0 || billNumbers.length === 0) return result;

  try {
    const sb = getSupabase(env);
    const { data, error } = await sb
      .from("bills")
      .select(
        "congress,bill_type,bill_number,title,policy_area,latest_action_text,latest_action_date,origin_chamber,update_date,introduced_date,sponsor_bioguide_id,sponsor_name,sponsor_party,sponsor_state,committee_names,bill_status,bill_status_label,bill_status_step"
      )
      .eq("congress", parseInt(congressNum, 10))
      .in("bill_type", billTypes)
      .in("bill_number", billNumbers);

    if (error || !data) return result;

    for (const row of data) {
      const identity = getBillIdentity(row as CachedBillRow);
      if (!identity) continue;
      result.set(identity.key, row as CachedBillRow);
    }
  } catch {
    return result;
  }

  return result;
}

async function mapInBatches<T, R>(
  items: T[],
  batchSize: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    const resolved = await Promise.all(batch.map((item) => mapper(item)));
    results.push(...resolved);
  }
  return results;
}

// ── GET /api/congress/members ────────────────────────────────────────────────
// List members — always fetch live Congress.gov data for correct per-congress counts
congress.get("/members", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const currentCongress = c.req.query("congress") ?? "119";
  const limit = parseBoundedInt(c.req.query("limit"), 20, 1, 100);
  const offset = parseBoundedInt(c.req.query("offset"), 0, 0, 5000);

  try {
    const data = await fetchCongressMembersPage(apiKey, currentCongress, limit, offset);
    const normalizedMembers = normalizeCongressMembers(data.members ?? []);

    // Cache members to Supabase in the background
    if (hasSupabase(c.env) && normalizedMembers.length) {
      const sb = getSupabase(c.env);
      const rows = normalizedMembers
        .filter((m) => m.bioguideId)
        .map((m) => ({
          bioguide_id: m.bioguideId!,
          name: m.name ?? "",
          party: m.party ?? null,
          state: m.state ?? null,
          district: m.district ?? null,
          image_url: m.depiction?.imageUrl ?? null,
          congress: parseInt(currentCongress, 10),
        }));
      // Fire and forget — don't block the response
      c.executionCtx.waitUntil(
        Promise.resolve(sb.from("members").upsert(rows, { onConflict: "bioguide_id" }))
      );
    }

    return c.json(
      { ...data, members: normalizedMembers },
      200,
      { "Cache-Control": "public, max-age=3600" }
    );
  } catch {
    return c.json({ error: "Failed to fetch from Congress API" }, 502);
  }
});

// ── GET /api/congress/members/search ─────────────────────────────────────────
// Search members by name — scan live Congress.gov member pages for complete results
congress.get("/members/search", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const query = c.req.query("q");
  if (!query) return c.json({ error: "Missing search query 'q'" }, 400);

  const currentCongress = c.req.query("congress") ?? "119";

  try {
    const normalizedMembers = normalizeCongressMembers(await fetchAllCongressMembers(apiKey, currentCongress));

    const qLower = query.toLowerCase();
    const filtered = normalizedMembers.filter((m) => {
      const name = (m.name ?? "").toLowerCase();
      const state = (m.state ?? "").toLowerCase();
      const party = (m.party ?? "").toLowerCase();
      return name.includes(qLower) || state.includes(qLower) || party.includes(qLower);
    });

    // Cache all fetched members to Supabase in the background
    if (hasSupabase(c.env) && normalizedMembers.length) {
      const sb = getSupabase(c.env);
      const rows = normalizedMembers
        .filter((m) => m.bioguideId)
        .map((m) => ({
          bioguide_id: m.bioguideId!,
          name: m.name ?? "",
          party: m.party ?? null,
          state: m.state ?? null,
          district: m.district ?? null,
          image_url: m.depiction?.imageUrl ?? null,
          congress: parseInt(currentCongress, 10),
        }));
      c.executionCtx.waitUntil(
        Promise.resolve(sb.from("members").upsert(rows, { onConflict: "bioguide_id" }))
      );
    }

    return c.json(
      { members: filtered, count: filtered.length },
      200,
      { "Cache-Control": "public, max-age=3600" }
    );
  } catch {
    return c.json({ error: "Failed to fetch from Congress API" }, 502);
  }
});

// ── GET /api/congress/members/:bioguideId ────────────────────────────────────
congress.get("/members/:bioguideId", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const bioguideId = c.req.param("bioguideId");

  try {
    const resp = await congressFetch(`/member/${bioguideId}`, apiKey);
    if (!resp.ok) {
      return c.json({ error: `Congress API: ${resp.status}` }, 502);
    }
    const data = (await resp.json()) as {
      member?: CongressMemberLike & Record<string, unknown>;
      [key: string]: unknown;
    };

    if (data.member) {
      data.member.party = extractMemberParty(data.member) ?? undefined;
    }

    return c.json(data, 200, { "Cache-Control": "public, max-age=3600" });
  } catch {
    return c.json({ error: "Failed to fetch from Congress API" }, 502);
  }
});

// ── GET /api/congress/votes ──────────────────────────────────────────────────
congress.get("/votes", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const congress_num = c.req.query("congress") ?? "119";
  const chamber = c.req.query("chamber");
  const limit = parseBoundedInt(c.req.query("limit"), 20, 1, 100);
  const offset = parseBoundedInt(c.req.query("offset"), 0, 0, 5000);

  // Helper to normalize vote rows from Supabase (snake_case) to frontend (camelCase)
  function normalizeDbVote(row: Record<string, unknown>) {
    return {
      congress: row.congress,
      chamber: row.chamber,
      rollCallNumber: row.roll_call_number,
      date: row.date,
      question: row.question,
      description: row.description,
      result: row.result,
      totalYea: row.total_yea,
      totalNay: row.total_nay,
      totalNotVoting: row.total_not_voting,
      bill: row.bill_congress
        ? { congress: row.bill_congress, type: row.bill_type, number: row.bill_number }
        : undefined,
    };
  }

  // Try Supabase first
  if (hasSupabase(c.env)) {
    try {
      const sb = getSupabase(c.env);
      let query = sb
        .from("votes")
        .select("*", { count: "exact" })
        .eq("congress", parseInt(congress_num, 10))
        .order("date", { ascending: false })
        .range(offset, offset + limit - 1);

      if (chamber) {
        query = query.eq("chamber", chamber.toLowerCase());
      }

      const { data, count, error } = await query;

      if (!error && data && data.length > 0) {
        return c.json(
          {
            votes: data.map((row) => normalizeDbVote(row as Record<string, unknown>)),
            count: count ?? data.length,
          },
          200,
          { "Cache-Control": "public, max-age=1800" }
        );
      }
    } catch {
      // Fall through to live API
    }
  }

  // We merge votes from two sessions and then paginate locally.
  // To keep pagination correct, we may need up to offset+limit from each session.
  const requiredWindowSize = limit + offset;

  // Congress.gov API v3 uses `/house-vote/{congress}/{session}` for House
  // and `/senate-vote/{congress}/{session}` for Senate roll call votes.
  // Each congress has two sessions (1 and 2). We fetch both sessions and
  // merge so the user doesn't need to pick a session.
  const sessions = ["1", "2"];

  // Raw shape returned by the Congress.gov vote list endpoints.
  type CongressHouseVote = {
    congress?: number;
    sessionNumber?: number;
    rollCallNumber?: number;
    startDate?: string;
    voteQuestion?: string;
    result?: string;
    voteType?: string;
    legislationType?: string;
    legislationUrl?: string;
    url?: string;
    [key: string]: unknown;
  };
  const chamberNormalized = chamber?.toLowerCase();
  const votePathPrefix = chamberNormalized === "senate" ? "senate-vote" : "house-vote";
  const chamberLabel = chamberNormalized === "senate" ? "Senate" : "House";

  try {
    const CONGRESS_MAX_LIMIT = 250;

    const fetchSessionVotes = async (session: string): Promise<{ votes: CongressHouseVote[]; totalCount?: number; errorStatus?: number; errorBody?: string }> => {
      const votes: CongressHouseVote[] = [];
      let pageOffset = 0;
      let totalCount: number | undefined;

      while (votes.length < requiredWindowSize) {
        const remaining = requiredWindowSize - votes.length;
        const pageLimit = Math.min(CONGRESS_MAX_LIMIT, remaining);
        const resp = await congressFetch(`/${votePathPrefix}/${congress_num}/${session}`, apiKey, {
          limit: String(pageLimit),
          offset: String(pageOffset),
        });

        if (!resp.ok) {
          return {
            votes,
            totalCount,
            errorStatus: resp.status,
            errorBody: await resp.text().catch(() => ""),
          };
        }

        const data = (await resp.json()) as {
          houseRollCallVotes?: CongressHouseVote[];
          senateRollCallVotes?: CongressHouseVote[];
          pagination?: { count?: number };
        };

        if (data.pagination?.count != null) {
          totalCount = data.pagination.count;
        }

        const pageVotes = data.houseRollCallVotes ?? data.senateRollCallVotes ?? [];
        if (pageVotes.length === 0) break;

        votes.push(...pageVotes);
        if (pageVotes.length < pageLimit) break;

        pageOffset += pageLimit;
      }

      return { votes, totalCount };
    };

    const sessionResults = await Promise.all(sessions.map((session) => fetchSessionVotes(session)));

    let allVotes: CongressHouseVote[] = [];
    let firstErrorStatus: number | null = null;
    let firstErrorBody = "";
    let totalCount = 0;

    for (const result of sessionResults) {
      if (result.errorStatus && firstErrorStatus === null) {
        firstErrorStatus = result.errorStatus;
        firstErrorBody = result.errorBody ?? "";
      }
      allVotes = allVotes.concat(result.votes);
      if (result.totalCount != null) {
        totalCount += result.totalCount;
      }
    }

    if (allVotes.length === 0) {
      if (firstErrorStatus !== null) {
        return c.json(
          {
            error: `Congress API returned ${firstErrorStatus}`,
            detail: firstErrorBody.slice(0, 200) || undefined,
            hint: !hasSupabase(c.env)
              ? "Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY Worker secrets to enable cached data."
              : undefined,
          },
          502
        );
      }
      return c.json(
        { votes: [], count: 0 },
        200,
        { "Cache-Control": "public, max-age=300" }
      );
    }

    // Sort merged results by date descending and apply requested pagination
    allVotes.sort((a, b) => {
      const da = a.startDate ?? "";
      const db = b.startDate ?? "";
      return db.localeCompare(da);
    });
    allVotes = allVotes.slice(offset, offset + limit);

    // Normalize to the shape the frontend expects
    const normalized = allVotes.map((v) => ({
      congress: v.congress,
      chamber: chamberLabel,
      rollCallNumber: v.rollCallNumber,
      date: v.startDate,
      question: v.voteQuestion ?? v.voteType,
      description: v.legislationType
        ? `${v.legislationType} — ${v.voteType ?? ""}`
        : v.voteType,
      result: v.result,
      url: v.url,
    }));

    // Cache votes to Supabase in the background
    if (hasSupabase(c.env) && normalized.length) {
      const sb = getSupabase(c.env);
      const rows = normalized
        .filter((v) => v.congress && v.rollCallNumber)
        .map((v) => ({
          congress: v.congress!,
          chamber: chamberLabel.toLowerCase(),
          roll_call_number: v.rollCallNumber!,
          date: v.date ?? null,
          question: v.question ?? null,
          description: v.description ?? null,
          result: v.result ?? null,
          total_yea: null,
          total_nay: null,
          total_not_voting: null,
          bill_congress: null,
          bill_type: null,
          bill_number: null,
        }));
      c.executionCtx.waitUntil(
        Promise.resolve(
          sb.from("votes").upsert(rows, { onConflict: "congress,chamber,roll_call_number" })
        )
      );
    }

    return c.json(
      { votes: normalized, count: totalCount || normalized.length, offset, limit },
      200,
      { "Cache-Control": "public, max-age=1800" }
    );
  } catch (e) {
    return c.json(
      {
        error: "Failed to fetch from Congress API",
        detail: e instanceof Error ? e.message : undefined,
        hint: !hasSupabase(c.env)
          ? "Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY Worker secrets to enable cached data."
          : undefined,
      },
      502
    );
  }
});

// ── GET /api/congress/votes/:congress/:chamber/:rollCallNumber ───────────────
// The Congress.gov v3 item-level endpoint requires a session number:
//   /house-vote/{congress}/{session}/{rollCallNumber}
// Since the frontend doesn't track session, we try both sessions.
congress.get("/votes/:congress/:chamber/:rollCallNumber", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const { congress: cong, chamber, rollCallNumber } = c.req.param();

  const voteMeta = getVoteRouteMeta(chamber);

  // Try session 2 first (more recent), then session 1
  for (const session of ["2", "1"]) {
    try {
      const resp = await congressFetch(
        `/${voteMeta.pathPrefix}/${cong}/${session}/${rollCallNumber}`,
        apiKey
      );
      if (resp.ok) {
        const raw = (await resp.json()) as Record<string, unknown>;
        const v =
          (raw.houseRollCallVote as Record<string, unknown> | undefined) ??
          (raw.senateRollCallVote as Record<string, unknown> | undefined);
        if (v) {
          const partyTotals = v.votePartyTotal as Array<Record<string, unknown>> | undefined;
          let totalYea = 0, totalNay = 0, totalNotVoting = 0;
          let members: CongressVoteMember[] = [];
          if (partyTotals) {
            for (const p of partyTotals) {
              totalYea += asNumber(p.yeaTotal ?? p.yea);
              totalNay += asNumber(p.nayTotal ?? p.nay);
              totalNotVoting += asNumber(p.notVotingTotal ?? p.notVoting);
            }
          }

          if (!partyTotals?.length) {
            totalYea = asNumber(v.yeaTotal ?? v.totalYea);
            totalNay = asNumber(v.nayTotal ?? v.totalNay);
            totalNotVoting = asNumber(v.notVotingTotal ?? v.totalNotVoting);
          }

          try {
            const membersResp = await congressFetch(
              `/${voteMeta.pathPrefix}/${cong}/${session}/${rollCallNumber}/members`,
              apiKey,
              { limit: "500" }
            );
            if (membersResp.ok) {
              const membersData = (await membersResp.json()) as Record<string, unknown>;
              members = extractVoteMembersFromResponse(membersData);
            }
          } catch {
            // Best-effort: summary data is still useful without member rows.
          }

          // Fetch member-level votes and cache to Supabase in the background
          if (hasSupabase(c.env)) {
            c.executionCtx.waitUntil(
              fetchAndCacheMemberVotes(
                c.env,
                apiKey,
                cong,
                voteMeta.normalized,
                session,
                rollCallNumber
              )
            );
          }

          return c.json({
            vote: {
              congress: v.congress,
              chamber: voteMeta.label,
              date: v.startDate,
              question: v.voteQuestion,
              description: v.voteType,
              result: v.result,
              totalYea,
              totalNay,
              totalNotVoting,
              members,
            },
            raw: v,
          }, 200, { "Cache-Control": "public, max-age=1800" });
        }
        return c.json(raw, 200, { "Cache-Control": "public, max-age=1800" });
      }
      // 404 means wrong session — try the other one
      if (resp.status !== 404) {
        return c.json({ error: `Congress API: ${resp.status}` }, 502);
      }
    } catch {
      // Try next session
    }
  }

  return c.json({ error: `Vote not found: congress ${cong}, roll call ${rollCallNumber}` }, 404);
});

// ── GET /api/congress/member-votes/:bioguideId ──────────────────────────────
// Fetch a member's voting record from Congress.gov. This populates the
// member_votes table so the Follow the Money page can show voting data.
congress.get("/member-votes/:bioguideId", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const bioguideId = c.req.param("bioguideId");
  const congressNum = c.req.query("congress") ?? "119";
  const limit = parseBoundedInt(c.req.query("limit"), 20, 1, 100);
  const sessions = ["2", "1"];
  type VoteListItem = {
    congress?: number;
    sessionNumber?: number;
    rollCallNumber?: number;
    startDate?: string;
    voteQuestion?: string;
    result?: string;
    voteType?: string;
    legislationType?: string;
    legislationUrl?: string;
    url?: string;
    chamberLabel: string;
    chamberNormalized: string;
    pathPrefix: string;
  };

  let allVotes: VoteListItem[] = [];
  for (const chamber of ["house", "senate"]) {
    const voteMeta = getVoteRouteMeta(chamber);
    for (const session of sessions) {
      try {
        const resp = await congressFetch(`/${voteMeta.pathPrefix}/${congressNum}/${session}`, apiKey, {
          limit: limit.toString(),
        });
        if (!resp.ok) continue;

        const data = (await resp.json()) as {
          houseRollCallVotes?: Array<Omit<VoteListItem, "chamberLabel" | "chamberNormalized" | "pathPrefix">>;
          senateRollCallVotes?: Array<Omit<VoteListItem, "chamberLabel" | "chamberNormalized" | "pathPrefix">>;
        };
        const incoming = data.houseRollCallVotes ?? data.senateRollCallVotes ?? [];
        allVotes = allVotes.concat(
          incoming.map((vote) => ({
            ...vote,
            chamberLabel: voteMeta.label,
            chamberNormalized: voteMeta.normalized,
            pathPrefix: voteMeta.pathPrefix,
          }))
        );
      } catch {
        // Skip chamber/session combinations that fail.
      }
    }
  }

  allVotes.sort((a, b) => (b.startDate ?? "").localeCompare(a.startDate ?? ""));
  allVotes = allVotes.slice(0, limit);

  // For each vote, fetch member-level data to find this member's position
  const memberVotes: Array<{
    rollCallNumber: number;
    date: string | null;
    question: string | null;
    description: string | null;
    result: string | null;
    position: string;
    chamber: string;
    bill?: {
      congress: string;
      type: string;
      number: string;
      apiUrl?: string;
    };
  }> = [];

  // Fetch member votes in batches of 5 to avoid rate limits
  for (let i = 0; i < allVotes.length; i += 5) {
    const batch = allVotes.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(async (vote) => {
        if (!vote.rollCallNumber) return null;
        const session = String(vote.sessionNumber ?? 1);
        try {
          const resp = await congressFetch(
            `/${vote.pathPrefix}/${congressNum}/${session}/${vote.rollCallNumber}/members`,
            apiKey,
            { limit: "500" }
          );
          if (!resp.ok) return null;
          const data = (await resp.json()) as Record<string, unknown>;
          const memberVote = extractVoteMembersFromResponse(data).find(
            (m) => m.bioguideId === bioguideId
          );
          if (!memberVote) return null;
          const billMatch =
            typeof vote.legislationUrl === "string"
              ? vote.legislationUrl.match(/\/bill\/(\d+)\/([a-z0-9]+)\/([a-z0-9-]+)/i)
              : null;
          return {
            rollCallNumber: vote.rollCallNumber,
            date: vote.startDate ?? null,
            question: vote.voteQuestion ?? null,
            description: vote.legislationType
              ? `${vote.legislationType} - ${vote.voteType ?? ""}`.trim()
              : vote.voteType ?? null,
            result: vote.result ?? null,
            position: memberVote.votePosition ?? "Unknown",
            chamber: vote.chamberLabel,
            bill: billMatch
              ? {
                  congress: billMatch[1],
                  type: billMatch[2].toLowerCase(),
                  number: billMatch[3],
                  apiUrl: vote.legislationUrl,
                }
              : undefined,
          };
        } catch {
          return null;
        }
      })
    );
    for (const r of results) {
      if (r) memberVotes.push(r);
    }
  }

  // Cache to Supabase in background
  if (hasSupabase(c.env) && memberVotes.length) {
    c.executionCtx.waitUntil(
      cacheMemberVotesToSupabase(c.env, bioguideId, parseInt(congressNum, 10), memberVotes)
    );
  }

  return c.json({
    bioguide_id: bioguideId,
    votes: memberVotes,
    count: memberVotes.length,
  }, 200, { "Cache-Control": "public, max-age=1800" });
});

/**
 * Fetch member-level votes for a single roll call and cache to member_votes table.
 */
async function fetchAndCacheMemberVotes(
  env: Env["Bindings"],
  apiKey: string,
  congressNum: string,
  chamber: string,
  session: string,
  rollCallNumber: string
) {
  try {
    const voteMeta = getVoteRouteMeta(chamber);
    const resp = await congressFetch(
      `/${voteMeta.pathPrefix}/${congressNum}/${session}/${rollCallNumber}/members`,
      apiKey,
      { limit: "500" }
    );
    if (!resp.ok) return;
    const data = (await resp.json()) as Record<string, unknown>;
    const members = extractVoteMembersFromResponse(data);
    if (!members.length) return;

    const sb = getSupabase(env);

    // Ensure the vote row exists
    const { data: voteRow } = await sb
      .from("votes")
      .select("id")
      .eq("congress", parseInt(congressNum, 10))
      .eq("chamber", voteMeta.normalized)
      .eq("roll_call_number", parseInt(rollCallNumber, 10))
      .single();

    if (!voteRow) return;

    const rows = members
      .filter((m) => m.bioguideId && m.votePosition)
      .map((m) => ({
        vote_id: voteRow.id,
        bioguide_id: m.bioguideId!,
        position: m.votePosition!,
      }));

    if (rows.length > 0) {
      await sb.from("member_votes").upsert(rows, {
        onConflict: "vote_id,bioguide_id",
      });
    }
  } catch {
    // Best-effort caching
  }
}

/**
 * Cache a member's vote positions to Supabase.
 */
async function cacheMemberVotesToSupabase(
  env: Env["Bindings"],
  bioguideId: string,
  congressNum: number,
  memberVotes: Array<{
    rollCallNumber: number;
    date: string | null;
    question: string | null;
    description: string | null;
    result: string | null;
    position: string;
    chamber: string;
    bill?: {
      congress: string;
      type: string;
      number: string;
      apiUrl?: string;
    };
  }>
) {
  try {
    const sb = getSupabase(env);

    for (const mv of memberVotes) {
      // Ensure vote row exists
      const { data: existing } = await sb
        .from("votes")
        .select("id")
        .eq("congress", congressNum)
        .eq("chamber", mv.chamber.toLowerCase())
        .eq("roll_call_number", mv.rollCallNumber)
        .single();

      let voteId: number;
      if (existing) {
        voteId = existing.id;
      } else {
        // Insert the vote
        const { data: inserted } = await sb
          .from("votes")
          .upsert({
            congress: congressNum,
            chamber: mv.chamber.toLowerCase(),
            roll_call_number: mv.rollCallNumber,
            date: mv.date,
            question: mv.question,
            description: mv.description,
            result: mv.result,
          }, { onConflict: "congress,chamber,roll_call_number" })
          .select("id")
          .single();
        if (!inserted) continue;
        voteId = inserted.id;
      }

      // Insert member vote
      await sb.from("member_votes").upsert({
        vote_id: voteId,
        bioguide_id: bioguideId,
        position: mv.position,
      }, { onConflict: "vote_id,bioguide_id" });
    }
  } catch {
    // Best-effort
  }
}

// ── GET /api/congress/bills ──────────────────────────────────────────────────
congress.get("/bills", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const congress_num = c.req.query("congress") ?? "119";
  const billType = c.req.query("type")?.toLowerCase() ?? null;
  const limit = parseBoundedInt(c.req.query("limit"), 20, 1, 100);
  const offset = parseBoundedInt(c.req.query("offset"), 0, 0, BILL_SCAN_MAX_OFFSET);
  const sort = c.req.query("sort") ?? "updateDate+desc";
  const status = normalizeText(c.req.query("status"));
  const latestAction = c.req.query("latestAction")?.trim() ?? "";
  const sponsorParty = normalizePartyValue(c.req.query("sponsorParty"));
  const sponsor = c.req.query("sponsor")?.trim() ?? "";
  const committee = c.req.query("committee")?.trim() ?? "";

  const hasSummaryFilters = Boolean(status || latestAction);
  const hasMetadataFilters = Boolean(sponsorParty || sponsor || committee);
  const requiresScan = hasSummaryFilters || hasMetadataFilters;

  try {
    if (!requiresScan) {
      const data = await fetchCongressBillsPage(apiKey, congress_num, billType, limit, offset, sort);
      const cachedBills = await loadCachedBills(c.env, congress_num, data.bills ?? []);
      const normalizedBills = (data.bills ?? []).map((bill) => {
        const identity = getBillIdentity(bill);
        return normalizeBillForList(bill, identity ? cachedBills.get(identity.key) : undefined);
      });

      const cacheRows = (data.bills ?? [])
        .map((bill) => toBillCacheRow(bill))
        .filter(Boolean) as Array<Record<string, unknown>>;
      if (cacheRows.length > 0) {
        c.executionCtx.waitUntil(upsertCachedBills(c.env, cacheRows));
      }

      return c.json(
        {
          bills: normalizedBills,
          count: data.pagination?.count,
          pagination: {
            offset,
            limit,
            count: data.pagination?.count,
            hasMore: Boolean(data.pagination?.next) || normalizedBills.length === limit,
          },
        },
        200,
        { "Cache-Control": "public, max-age=1800" }
      );
    }

    const matchedBills: Array<ReturnType<typeof normalizeBillForList>> = [];
    const cacheRowsToUpsert: Array<Record<string, unknown>> = [];
    let matchedCount = 0;
    let scannedCount = 0;

    for (let scanOffset = 0; scanOffset <= BILL_SCAN_MAX_OFFSET; scanOffset += BILL_SCAN_PAGE_SIZE) {
      const data = await fetchCongressBillsPage(
        apiKey,
        congress_num,
        billType,
        BILL_SCAN_PAGE_SIZE,
        scanOffset,
        sort
      );
      const pageBills = data.bills ?? [];
      scannedCount += pageBills.length;

      cacheRowsToUpsert.push(
        ...pageBills
          .map((bill) => toBillCacheRow(bill))
          .filter(Boolean) as Array<Record<string, unknown>>
      );

      const cachedBills = await loadCachedBills(c.env, congress_num, pageBills);
      const summaryCandidates = pageBills
        .map((bill) => {
          const identity = getBillIdentity(bill);
          const cached = identity ? cachedBills.get(identity.key) : undefined;
          return {
            rawBill: bill,
            cached,
            normalized: normalizeBillForList(bill, cached),
          };
        })
        .filter((entry) => billMatchesSummaryFilters(entry.normalized, status, latestAction));

      const resolvedCandidates = hasMetadataFilters
        ? await mapInBatches(summaryCandidates, 5, async (entry) => {
            if (billMatchesMetadataFilters(entry.normalized, sponsorParty, sponsor, committee)) {
              return entry.normalized;
            }

            const identity = getBillIdentity(entry.rawBill);
            if (!identity) return null;

            const detailedBill =
              (await fetchCongressBillDetail(apiKey, identity.congress, identity.type, identity.number)) ??
              entry.rawBill;
            const committeeNames = committee
              ? await fetchCongressBillCommittees(apiKey, identity.congress, identity.type, identity.number)
              : Array.isArray(entry.cached?.committee_names)
                ? (entry.cached?.committee_names as string[])
                : [];

            const hydratedBill = normalizeBillForList(detailedBill, entry.cached, committeeNames);
            const cacheRow = toBillCacheRow(detailedBill, committeeNames);
            if (cacheRow) cacheRowsToUpsert.push(cacheRow);

            return billMatchesMetadataFilters(hydratedBill, sponsorParty, sponsor, committee)
              ? hydratedBill
              : null;
          })
        : summaryCandidates.map((entry) => entry.normalized);

      for (const bill of resolvedCandidates) {
        if (!bill) continue;
        if (matchedCount >= offset && matchedBills.length < limit) {
          matchedBills.push(bill);
        }
        matchedCount += 1;
      }

      if (!data.pagination?.next || pageBills.length < BILL_SCAN_PAGE_SIZE) {
        break;
      }
    }

    if (cacheRowsToUpsert.length > 0) {
      c.executionCtx.waitUntil(upsertCachedBills(c.env, cacheRowsToUpsert));
    }

    return c.json(
      {
        bills: matchedBills,
        count: matchedCount,
        pagination: {
          offset,
          limit,
          count: matchedCount,
          hasMore: offset + limit < matchedCount,
          filtered: true,
          scanned: scannedCount,
        },
      },
      200,
      { "Cache-Control": "public, max-age=600" }
    );
  } catch {
    return c.json({ error: "Failed to fetch from Congress API" }, 502);
  }
});

// ── GET /api/congress/bills/:congress/:type/:number ──────────────────────────
congress.get("/bills/:congress/:type/:number", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const { congress: cong, type, number } = c.req.param();
  const path = `/bill/${cong}/${type}/${number}`;

  try {
    const resp = await congressFetch(path, apiKey);
    if (!resp.ok) {
      return c.json({ error: `Congress API: ${resp.status}` }, 502);
    }
    const data = (await resp.json()) as CongressBillDetailResponse;

    if (data.bill) {
      const congressNum = Number.parseInt(cong, 10);
      const billNumber = Number.parseInt(number, 10);
      const committeeNames = await fetchCongressBillCommittees(apiKey, congressNum, type, billNumber).catch(
        () => []
      );
      const cacheRow = toBillCacheRow(data.bill, committeeNames);
      if (cacheRow) {
        c.executionCtx.waitUntil(upsertCachedBills(c.env, [cacheRow]));
      }
    }

    return c.json(data, 200, { "Cache-Control": "public, max-age=1800" });
  } catch {
    return c.json({ error: "Failed to fetch from Congress API" }, 502);
  }
});

// ── GET /api/congress/bills/:congress/:type/:number/cosponsors ──────────────
congress.get("/bills/:congress/:type/:number/cosponsors", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const { congress: cong, type, number } = c.req.param();
  const limit = parseBoundedInt(c.req.query("limit"), 50, 1, 250);
  const offset = parseBoundedInt(c.req.query("offset"), 0, 0, 5000);

  try {
    const resp = await congressFetch(`/bill/${cong}/${type}/${number}/cosponsors`, apiKey, {
      limit: String(limit),
      offset: String(offset),
    });
    if (!resp.ok) {
      return c.json({ error: `Congress API: ${resp.status}` }, 502);
    }
    const data: unknown = await resp.json();
    return c.json(data, 200, { "Cache-Control": "public, max-age=1800" });
  } catch {
    return c.json({ error: "Failed to fetch from Congress API" }, 502);
  }
});

// ── GET /api/congress/bills/:congress/:type/:number/actions ─────────────────
congress.get("/bills/:congress/:type/:number/actions", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const { congress: cong, type, number } = c.req.param();
  const limit = parseBoundedInt(c.req.query("limit"), 50, 1, 250);
  const offset = parseBoundedInt(c.req.query("offset"), 0, 0, 5000);

  try {
    const resp = await congressFetch(`/bill/${cong}/${type}/${number}/actions`, apiKey, {
      limit: String(limit),
      offset: String(offset),
    });
    if (!resp.ok) {
      return c.json({ error: `Congress API: ${resp.status}` }, 502);
    }
    const data: unknown = await resp.json();
    return c.json(data, 200, { "Cache-Control": "public, max-age=1800" });
  } catch {
    return c.json({ error: "Failed to fetch from Congress API" }, 502);
  }
});

export { congress };
