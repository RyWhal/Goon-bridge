import { Hono } from "hono";
import type { Env } from "../types";
import { summarizeMemberVotes, type MemberVoteRecord } from "../lib/member-votes";
import { prepareBillCacheRowsForUpsert, resolveBillWarmRequest } from "../lib/bill-cache";
import {
  createGoogleAutocompleteLimiter,
  getGoogleAutocompleteProbe,
  parseGoogleAutocompleteResponse,
  type GoogleAutocompleteProbeKey,
} from "../lib/google-autocomplete";
import { getSupabase } from "../lib/supabase";
import { FetchTimeoutError, fetchWithTimeout } from "../lib/fetch-with-timeout";
import { hasSupabase, parseBoundedInt } from "../lib/validation";
import { requireAdminAuth } from "../middleware/admin-auth";

const congress = new Hono<Env>();
congress.use("/refresh/*", requireAdminAuth);

const BASE = "https://api.congress.gov/v3";
const CONGRESS_FETCH_TIMEOUT_MS = 15_000;

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

  return fetchWithTimeout(url.toString(), CONGRESS_FETCH_TIMEOUT_MS);
}

const MEMBERS_CACHE_STALE_MS = 12 * 60 * 60 * 1000;
const MEMBER_DETAIL_CACHE_STALE_MS = 24 * 60 * 60 * 1000;
const VOTES_CACHE_STALE_MS = 6 * 60 * 60 * 1000;
const VOTE_DETAIL_CACHE_STALE_MS = 6 * 60 * 60 * 1000;
const BILLS_CACHE_STALE_MS = 6 * 60 * 60 * 1000;
const GOOGLE_AUTOCOMPLETE_MIN_INTERVAL_MS = 5_000;
const GOOGLE_AUTOCOMPLETE_CACHE_STALE_MS = 24 * 60 * 60 * 1000;
const googleAutocompleteLimiter = createGoogleAutocompleteLimiter({
  minIntervalMs: GOOGLE_AUTOCOMPLETE_MIN_INTERVAL_MS,
});

type CachedTimestampRow = { updated_at?: string | null };
type BillCacheTable = "bill_details_cache" | "bill_actions_cache" | "bill_cosponsors_cache";

function isTimestampStale(updatedAt: string | null | undefined, staleMs: number): boolean {
  if (!updatedAt) return true;
  const parsed = new Date(updatedAt);
  return Number.isNaN(parsed.getTime()) || Date.now() - parsed.getTime() > staleMs;
}

function isRowSetStale(rows: CachedTimestampRow[], staleMs: number): boolean {
  if (rows.length === 0) return true;
  return rows.some((row) => isTimestampStale(row.updated_at, staleMs));
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

function dedupeBioguideIds(ids: Array<string | undefined | null>) {
  return [...new Set(ids.map((id) => id?.trim()).filter((id): id is string => !!id))];
}

const STATE_NAME_BY_CODE: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  DC: "District of Columbia",
};

const STATE_CODE_BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_NAME_BY_CODE).map(([code, name]) => [name.toUpperCase(), code])
);

function normalizeStateCode(value: string | null | undefined): string | null {
  const normalized = (value ?? "")
    .toUpperCase()
    .replace(/[^A-Z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  if (normalized.length === 2) return normalized;
  return STATE_CODE_BY_NAME[normalized] ?? null;
}

function normalizeStateName(value: string | null | undefined): string | null {
  const code = normalizeStateCode(value);
  if (!code) return null;
  return STATE_NAME_BY_CODE[code] ?? null;
}

function normalizeBillType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned || null;
}

function normalizePersonName(value: string | null | undefined): string {
  return (value ?? "")
    .toUpperCase()
    .replace(/[.,']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePersonNameForMatch(value: string | null | undefined): string {
  return normalizePersonName(value)
    .replace(/\b(JR|SR|II|III|IV|V)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getLastNameToken(value: string | null | undefined): string {
  const normalized = normalizePersonNameForMatch(value);
  if (!normalized) return "";
  const parts = normalized.split(" ").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function firstNamesCompatible(left: string, right: string): boolean {
  if (!left || !right) return true;
  if (left === right) return true;
  if (left.startsWith(right) || right.startsWith(left)) return true;
  return left[0] === right[0];
}

function splitPersonName(value: string | null | undefined) {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return { firstName: "", lastName: "", fullName: "" };
  }

  if (cleaned.includes(",")) {
    const [lastNameRaw, ...firstNameParts] = cleaned.split(",");
    const lastName = lastNameRaw?.trim() ?? "";
    const firstName = firstNameParts.join(" ").trim();
    return {
      firstName,
      lastName,
      fullName: [firstName, lastName].filter(Boolean).join(" ").trim(),
    };
  }

  const parts = cleaned.split(" ");
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" ") || parts[0] || "",
    fullName: cleaned,
  };
}

type SenateMemberLookup = {
  bioguideId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  party: string | null;
  stateCode: string | null;
  stateName: string | null;
};

async function loadSenateMemberLookup(
  env: Env["Bindings"],
  apiKey: string,
  congress: number
): Promise<SenateMemberLookup[]> {
  if (hasSupabase(env)) {
    try {
      const sb = getSupabase(env);
      const { data, error } = await sb
        .from("member_congresses")
        .select("bioguide_id,name,party,state,district,chamber,congress")
        .eq("congress", congress)
        .order("name", { ascending: true });

      if (!error && data?.length) {
        const senateRows = data
          .filter((row) =>
            row.district == null ||
            inferMemberChamber({
              chamber: normalizeChamberLabel(row.chamber) ?? row.chamber,
              district: row.district,
            }) === "Senate"
          )
          .map((row) => {
          const parsedName = splitPersonName(row.name ?? row.bioguide_id);
          return {
            bioguideId: row.bioguide_id,
            firstName: parsedName.firstName,
            lastName: parsedName.lastName,
            fullName: parsedName.fullName || row.bioguide_id,
            party: normalizePartyValue(row.party),
            stateCode: normalizeStateCode(row.state),
            stateName: normalizeStateName(row.state),
          };
        });
        if (senateRows.length > 0) {
          return senateRows;
        }
      }
    } catch {
      // Fall through to live member list.
    }
  }

  const members = normalizeCongressMembers(await fetchAllCongressMembers(apiKey, String(congress)));
  return members
    .filter(
      (member) =>
        (extractMemberChamber(member) ?? inferMemberChamber(member)) === "Senate" &&
        member.bioguideId
    )
    .map((member) => {
      const parsedName = splitPersonName(member.directOrderName ?? member.name ?? member.bioguideId);
      return {
        bioguideId: member.bioguideId!,
        firstName: parsedName.firstName,
        lastName: parsedName.lastName,
        fullName: parsedName.fullName || member.bioguideId!,
        party: normalizePartyValue(member.party),
        stateCode: normalizeStateCode(typeof member.state === "string" ? member.state : null),
        stateName: normalizeStateName(typeof member.state === "string" ? member.state : null),
      };
    });
}

function resolveSenateMemberBioguide(
  member: {
    firstName?: string;
    lastName?: string;
    fullName?: string;
    party?: string;
    state?: string;
  },
  senators: SenateMemberLookup[]
): string | null {
  const derivedNames = splitPersonName(member.fullName);
  const stateCode = normalizeStateCode(member.state);
  const stateName = normalizeStateName(member.state);
  const party = normalizePartyValue(member.party);
  const firstName = normalizePersonNameForMatch(member.firstName ?? derivedNames.firstName);
  const lastName = normalizePersonNameForMatch(member.lastName ?? derivedNames.lastName);
  const fullName = normalizePersonNameForMatch(member.fullName);
  const derivedLastName = getLastNameToken(lastName || fullName || derivedNames.lastName);

  const matches = senators
    .map((senator) => {
      if (stateCode && senator.stateCode && stateCode !== senator.stateCode) return null;
      if (stateName && senator.stateName && stateName !== senator.stateName) return null;

      const senatorFirst = normalizePersonNameForMatch(senator.firstName);
      const senatorLast = normalizePersonNameForMatch(senator.lastName);
      const senatorFull = normalizePersonNameForMatch(senator.fullName);
      const senatorLastToken = getLastNameToken(senatorLast || senatorFull);

      if (
        derivedLastName &&
        senatorLast !== derivedLastName &&
        senatorLastToken !== derivedLastName &&
        !senatorFull.includes(derivedLastName)
      ) {
        return null;
      }

      let score = 0;
      if (stateCode && senator.stateCode === stateCode) score += 8;
      if (stateName && senator.stateName === stateName) score += 6;
      if (party && senator.party && party === senator.party) score += 2;

      if (derivedLastName && senatorLastToken === derivedLastName) score += 10;
      else if (derivedLastName && senatorLast === derivedLastName) score += 8;
      else if (derivedLastName && senatorFull.includes(derivedLastName)) score += 5;

      if (firstName && senatorFirst && firstNamesCompatible(firstName, senatorFirst)) score += 4;
      if (fullName && senatorFull === fullName) score += 6;
      else if (fullName && senatorFull.includes(fullName)) score += 3;

      return { bioguideId: senator.bioguideId, score };
    })
    .filter((match): match is { bioguideId: string; score: number } => !!match)
    .sort((left, right) => right.score - left.score);

  if (matches.length === 1 && matches[0].score >= 8) return matches[0].bioguideId;
  if (matches.length >= 2 && matches[0].score >= 8 && matches[0].score > matches[1].score) {
    return matches[0].bioguideId;
  }
  return null;
}

function buildSenateVoteXmlUrl(congress: number, session: string, rollCallNumber: number) {
  const paddedRollCall = String(rollCallNumber).padStart(5, "0");
  return `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${paddedRollCall}.xml`;
}

async function fetchRecentSenateVoteRefs(
  congress: number,
  session: string,
  limit: number
): Promise<Array<{ congress: number; sessionNumber: number; rollCallNumber: number; url: string }>> {
  const menuUrl = `https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_${congress}_${session}.htm`;
  const resp = await fetch(menuUrl);
  if (!resp.ok) return [];

  const html = await resp.text();
  const seen = new Set<number>();
  const votes: Array<{ congress: number; sessionNumber: number; rollCallNumber: number; url: string }> = [];
  const voteHrefPattern = new RegExp(`vote_${congress}_${session}_(\\d{5})\\.htm`, "g");

  for (const match of html.matchAll(voteHrefPattern)) {
    const rollCallNumber = Number.parseInt(match[1], 10);
    if (!Number.isFinite(rollCallNumber) || seen.has(rollCallNumber)) continue;
    seen.add(rollCallNumber);
    votes.push({
      congress,
      sessionNumber: Number.parseInt(session, 10),
      rollCallNumber,
      url: buildSenateVoteXmlUrl(congress, session, rollCallNumber),
    });
    if (votes.length >= limit) break;
  }

  return votes;
}

function parseBillReferenceFromUrl(value: unknown) {
  if (typeof value !== "string") return null;
  const match = value.match(/\/bill\/(\d+)\/([a-z0-9]+)\/([a-z0-9-]+)/i);
  if (!match) return null;

  const congress = Number.parseInt(match[1], 10);
  const type = normalizeBillType(match[2]);
  const number = Number.parseInt(match[3].replace(/[^0-9]/g, ""), 10);
  if (!Number.isFinite(congress) || !type || !Number.isFinite(number)) return null;

  return { congress, type, number, apiUrl: value };
}

function extractBillReferenceFromVote(vote: Record<string, unknown>) {
  const fromUrl =
    parseBillReferenceFromUrl(vote.legislationUrl) ??
    parseBillReferenceFromUrl(vote.url) ??
    parseBillReferenceFromUrl((vote.bill as Record<string, unknown> | undefined)?.url);
  if (fromUrl) return fromUrl;

  const bill = vote.bill as Record<string, unknown> | undefined;
  const congress = asNumber(bill?.congress ?? vote.billCongress ?? vote.legislationCongress);
  const type = normalizeBillType(bill?.type ?? vote.billType ?? vote.legislationType);
  const numberValue = bill?.number ?? vote.billNumber ?? vote.legislationNumber;
  const number =
    typeof numberValue === "string"
      ? Number.parseInt(numberValue.replace(/[^0-9]/g, ""), 10)
      : asNumber(numberValue);

  if (!congress || !type || !number) return null;
  return { congress, type, number };
}

function mapDbMemberVotingRecord(row: Record<string, unknown>): MemberVoteRecord {
  const billCongress = asNumber(row.bill_congress);
  const billNumber = asNumber(row.bill_number);
  const billType = typeof row.bill_type === "string" ? row.bill_type.toLowerCase() : null;
  const chamber = typeof row.chamber === "string" ? row.chamber : "house";

  return {
    congress: asNumber(row.congress) || undefined,
    rollCallNumber: asNumber(row.roll_call_number),
    date: typeof row.vote_date === "string" ? row.vote_date : null,
    question: typeof row.question === "string" ? row.question : null,
    description: typeof row.vote_description === "string" ? row.vote_description : null,
    result: typeof row.result === "string" ? row.result : null,
    position: typeof row.position === "string" ? row.position : "Unknown",
    chamber: getVoteRouteMeta(chamber).label,
    bill:
      billCongress && billType && billNumber
        ? {
            congress: String(billCongress),
            type: billType,
            number: String(billNumber),
            title: typeof row.bill_title === "string" ? row.bill_title : null,
            policyArea: typeof row.policy_area === "string" ? row.policy_area : null,
          }
        : undefined,
  };
}

type VoteCacheInput = {
  congress: number;
  chamber: string;
  rollCallNumber: number;
  date: string | null;
  question: string | null;
  description: string | null;
  result: string | null;
  totalYea?: number | null;
  totalNay?: number | null;
  totalNotVoting?: number | null;
  bill?: {
    congress: number;
    type: string;
    number: number;
    apiUrl?: string;
  } | null;
};

function toVoteCacheRow(vote: VoteCacheInput) {
  return {
    congress: vote.congress,
    chamber: vote.chamber.toLowerCase(),
    roll_call_number: vote.rollCallNumber,
    date: vote.date,
    question: vote.question,
    description: vote.description,
    result: vote.result,
    total_yea: vote.totalYea ?? null,
    total_nay: vote.totalNay ?? null,
    total_not_voting: vote.totalNotVoting ?? null,
    bill_congress: vote.bill?.congress ?? null,
    bill_type: vote.bill?.type ?? null,
    bill_number: vote.bill?.number ?? null,
  };
}

async function refreshMemberVoteStats(env: Env["Bindings"], bioguideIds: string[]) {
  const distinctIds = dedupeBioguideIds(bioguideIds);
  if (!distinctIds.length) return;

  try {
    const sb = getSupabase(env);
    await sb.rpc("refresh_member_vote_stats", {
      target_bioguide_ids: distinctIds,
    });
  } catch {
    // Best-effort aggregation refresh
  }
}

async function cacheMembersToSupabase(
  env: Env["Bindings"],
  congressNum: number,
  members: Array<{
    bioguideId?: string;
    name?: string;
    directOrderName?: string;
    party?: string | null;
    state?: string;
    district?: number;
    depiction?: { imageUrl?: string };
  }>
) {
  if (!hasSupabase(env) || members.length === 0) return;
  const sb = getSupabase(env);
  const timestamp = new Date().toISOString();
  const canonicalRows = members
    .filter((member) => member.bioguideId)
    .map((member) => ({
      bioguide_id: member.bioguideId!,
      name: member.name ?? "",
      direct_order_name: typeof member.directOrderName === "string" ? member.directOrderName : null,
      party: member.party ?? null,
      state: member.state ?? null,
      district: member.district ?? null,
      chamber: extractMemberChamber(member) ?? inferMemberChamber(member) ?? null,
      image_url: normalizeMemberImageUrl(member.depiction?.imageUrl) ?? null,
      congress: congressNum,
      updated_at: timestamp,
    }));
  const congressRows = members
    .filter((member) => member.bioguideId)
    .map((member) => ({
      bioguide_id: member.bioguideId!,
      congress: congressNum,
      name: member.name ?? "",
      party: member.party ?? null,
      state: member.state ?? null,
      district: member.district ?? null,
      chamber: extractMemberChamber(member) ?? inferMemberChamber(member) ?? null,
      image_url: normalizeMemberImageUrl(member.depiction?.imageUrl) ?? null,
      updated_at: timestamp,
    }));

  await Promise.all([
    canonicalRows.length
      ? sb.from("members").upsert(canonicalRows, { onConflict: "bioguide_id" })
      : Promise.resolve(),
    congressRows.length
      ? sb.from("member_congresses").upsert(congressRows, { onConflict: "bioguide_id,congress" })
      : Promise.resolve(),
  ]);
}

async function backfillMemberCongressesFromMembers(
  env: Env["Bindings"],
  congressNum: number
) {
  if (!hasSupabase(env)) return 0;
  const sb = getSupabase(env);
  const { data, error } = await sb
    .from("members")
    .select("bioguide_id,name,party,state,district,chamber,image_url,congress,updated_at")
    .eq("congress", congressNum)
    .order("name", { ascending: true });

  if (error || !data || data.length === 0) return 0;

  const detailIds = data
    .map((row) => row.bioguide_id)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const detailById = new Map<string, string | null>();

  if (detailIds.length > 0) {
    const { data: detailRows } = await sb
      .from("member_details_cache")
      .select("bioguide_id,payload")
      .in("bioguide_id", detailIds);

    for (const row of detailRows ?? []) {
      const payload = row.payload as { member?: CongressMemberLike & Record<string, unknown> } | null;
      detailById.set(
        row.bioguide_id,
        payload?.member ? extractMemberChamber(payload.member) ?? null : null
      );
    }
  }

  const rows = data.map((row) => ({
    bioguide_id: row.bioguide_id,
    congress: congressNum,
    name: row.name,
    party: row.party,
    state: row.state,
    district: row.district,
    chamber:
      detailById.get(row.bioguide_id) ??
      (row.district == null ? "Senate" : row.chamber),
    image_url: row.image_url,
    updated_at: row.updated_at,
  }));

  const { error: upsertError } = await sb
    .from("member_congresses")
    .upsert(rows, { onConflict: "bioguide_id,congress" });

  if (upsertError) return 0;
  return rows.length;
}

async function fetchMembersFromCongress(
  env: Env["Bindings"],
  apiKey: string,
  congressNum: string,
  limit: number,
  offset: number
) {
  const data = await fetchCongressMembersPage(apiKey, congressNum, limit, offset);
  const normalizedMembers = normalizeCongressMembers(data.members ?? []);
  await cacheMembersToSupabase(env, parseInt(congressNum, 10), normalizedMembers);
  return {
    members: normalizedMembers,
    count: data.pagination?.count ?? normalizedMembers.length,
    pagination: data.pagination,
  };
}

function queueMembersRefresh(
  executionCtx: ExecutionContext,
  env: Env["Bindings"],
  apiKey: string,
  congressNum: string,
  limit: number,
  offset: number
) {
  executionCtx.waitUntil(
    fetchMembersFromCongress(env, apiKey, congressNum, limit, offset).catch(() => undefined)
  );
}

async function fetchMemberDetailFromCongress(
  env: Env["Bindings"],
  apiKey: string,
  bioguideId: string
) {
  const resp = await congressFetch(`/member/${bioguideId}`, apiKey);
  if (!resp.ok) {
    return {
      ok: false as const,
      status: resp.status,
    };
  }

  const data = (await resp.json()) as {
    member?: CongressMemberLike & Record<string, unknown>;
    [key: string]: unknown;
  };

  if (data.member) {
    data.member.party = extractMemberParty(data.member) ?? undefined;
  }

  if (hasSupabase(env)) {
    const sb = getSupabase(env);
    const timestamp = new Date().toISOString();
    if (data.member) {
      const summary = summarizeMemberTerms(data.member.terms);
      const directOrderName =
        typeof data.member.directOrderName === "string" ? data.member.directOrderName : null;
      const chamber = normalizeChamberLabel(summary.chamber);
      const congressesServed = deriveCongressesServed({
        congressesServed: summary.congressesServed,
        totalTerms: summary.totalTerms,
        firstCongress: summary.firstCongress,
        lastCongress: summary.lastCongress,
      });
      await sb.from("members").upsert(
        {
          bioguide_id: bioguideId,
          name:
            (typeof data.member.directOrderName === "string" && data.member.directOrderName) ||
            (typeof data.member.name === "string" && data.member.name) ||
            "",
          direct_order_name: directOrderName,
          party: typeof data.member.party === "string" ? data.member.party : null,
          state: typeof data.member.state === "string" ? data.member.state : null,
          district: typeof data.member.district === "number" ? data.member.district : null,
          chamber,
          image_url:
            typeof (data.member as { depiction?: { imageUrl?: string } }).depiction?.imageUrl === "string"
              ? normalizeMemberImageUrl(
                  (data.member as { depiction?: { imageUrl?: string } }).depiction?.imageUrl
                ) ?? (data.member as { depiction?: { imageUrl?: string } }).depiction?.imageUrl ?? null
              : null,
          first_congress: summary.firstCongress,
          last_congress: summary.lastCongress,
          total_terms: summary.totalTerms,
          congresses_served: congressesServed,
          years_served: summary.yearsServed,
          updated_at: timestamp,
        },
        { onConflict: "bioguide_id" }
      );
    }
    await sb.from("member_details_cache").upsert(
      {
        bioguide_id: bioguideId,
        payload: data,
        updated_at: timestamp,
      },
      { onConflict: "bioguide_id" }
    );
  }

  return {
    ok: true as const,
    data,
  };
}

async function resolveMemberNameForAutocomplete(
  env: Env["Bindings"],
  apiKey: string | undefined,
  bioguideId: string,
) {
  if (hasSupabase(env)) {
    try {
      const sb = getSupabase(env);
      const { data, error } = await sb
        .from("members")
        .select("name,direct_order_name")
        .eq("bioguide_id", bioguideId)
        .maybeSingle<{ name: string | null; direct_order_name: string | null }>();
      if (!error) {
        const resolved = data?.direct_order_name?.trim() || data?.name?.trim();
        if (resolved) return resolved;
      }
    } catch {
      // Fall through to Congress API detail lookup.
    }
  }

  if (!apiKey) return null;

  try {
    const live = await fetchMemberDetailFromCongress(env, apiKey, bioguideId);
    if (!live.ok) return null;
    const directOrderName = live.data?.member?.directOrderName;
    if (typeof directOrderName === "string" && directOrderName.trim()) {
      return directOrderName.trim();
    }
  } catch {
    // Ignore lookup failure and let the route return a member-not-found error.
  }

  return null;
}

async function fetchGoogleAutocompleteSuggestions(query: string) {
  await googleAutocompleteLimiter.waitTurn();

  const url = new URL("https://suggestqueries.google.com/complete/search");
  url.searchParams.set("client", "chrome");
  url.searchParams.set("q", query);

  const response = await fetchWithTimeout(url.toString(), 10_000, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; CongressVibeCheck/0.1; +https://github.com/RyWhal/Goon-bridge)",
      "Accept": "application/json,text/plain,*/*",
    },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Google suggest request failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  return response.json() as Promise<[string, unknown[], ...unknown[]]>;
}

type GoogleAutocompleteCachePayload = {
  key: GoogleAutocompleteProbeKey;
  query: string;
  suggestions: ReturnType<typeof parseGoogleAutocompleteResponse>;
};

async function readGoogleAutocompleteCache(
  env: Env["Bindings"],
  bioguideId: string,
  probeKey: GoogleAutocompleteProbeKey,
) {
  if (!hasSupabase(env)) return null;

  const sb = getSupabase(env);
  const { data, error } = await sb
    .from("google_autocomplete_cache")
    .select("query,payload,updated_at")
    .eq("bioguide_id", bioguideId)
    .eq("probe_key", probeKey)
    .maybeSingle<{ query: string; payload: GoogleAutocompleteCachePayload; updated_at: string | null }>();

  if (error || !data?.payload) return null;
  return data;
}

async function writeGoogleAutocompleteCache(
  env: Env["Bindings"],
  bioguideId: string,
  probe: GoogleAutocompleteCachePayload,
  fetchedAt: string,
) {
  if (!hasSupabase(env)) return;

  const sb = getSupabase(env);
  await sb.from("google_autocomplete_cache").upsert(
    {
      bioguide_id: bioguideId,
      probe_key: probe.key,
      query: probe.query,
      payload: probe,
      updated_at: fetchedAt,
    },
    { onConflict: "bioguide_id,probe_key" },
  );
}

function queueMemberDetailRefresh(
  executionCtx: ExecutionContext,
  env: Env["Bindings"],
  apiKey: string,
  bioguideId: string
) {
  executionCtx.waitUntil(
    fetchMemberDetailFromCongress(env, apiKey, bioguideId).catch(() => undefined)
  );
}

async function readVoteDetailFromSupabase(
  env: Env["Bindings"],
  congressNum: number,
  chamber: string,
  rollCallNumber: number
) {
  if (!hasSupabase(env)) return null;
  const sb = getSupabase(env);
  const { data: voteRow, error } = await sb
    .from("votes")
    .select("*")
    .eq("congress", congressNum)
    .eq("chamber", chamber)
    .eq("roll_call_number", rollCallNumber)
    .maybeSingle<{
      id: number;
      congress: number;
      chamber: string;
      date: string | null;
      question: string | null;
      description: string | null;
      result: string | null;
      total_yea: number | null;
      total_nay: number | null;
      total_not_voting: number | null;
      updated_at: string | null;
    }>();
  if (error || !voteRow) return null;

  const { data: memberVoteRows } = await sb
    .from("member_votes")
    .select("bioguide_id, position")
    .eq("vote_id", voteRow.id);

  const bioguideIds = dedupeBioguideIds((memberVoteRows ?? []).map((row) => row.bioguide_id));
  const memberMap = new Map<string, { name: string | null; party: string | null; state: string | null }>();

  if (bioguideIds.length > 0) {
    const { data: memberRows } = await sb
      .from("members")
      .select("bioguide_id, name, party, state")
      .in("bioguide_id", bioguideIds);
    for (const row of memberRows ?? []) {
      memberMap.set(row.bioguide_id, {
        name: row.name,
        party: row.party,
        state: row.state,
      });
    }
  }

  return {
    payload: {
      vote: {
        congress: voteRow.congress,
        chamber: chamber === "senate" ? "Senate" : "House",
        date: voteRow.date,
        question: voteRow.question,
        description: voteRow.description,
        result: voteRow.result,
        totalYea: voteRow.total_yea,
        totalNay: voteRow.total_nay,
        totalNotVoting: voteRow.total_not_voting,
        members: (memberVoteRows ?? []).map((row) => {
          const member = memberMap.get(row.bioguide_id);
          const parsed = splitPersonName(member?.name ?? row.bioguide_id);
          return {
            bioguideId: row.bioguide_id,
            fullName: member?.name ?? parsed.fullName,
            firstName: parsed.firstName,
            lastName: parsed.lastName,
            party: member?.party ?? undefined,
            state: member?.state ?? undefined,
            votePosition: row.position,
          };
        }),
      },
      raw: voteRow,
    },
    updatedAt: voteRow.updated_at ?? null,
    hasMembers: (memberVoteRows?.length ?? 0) > 0,
  };
}

async function fetchBillPayloadAndCache(
  env: Env["Bindings"],
  apiKey: string,
  table: BillCacheTable,
  path: string,
  congress: number,
  type: string,
  number: number,
  params?: Record<string, string>
) {
  const resp = await congressFetch(path, apiKey, params);
  if (!resp.ok) {
    return {
      ok: false as const,
      status: resp.status,
    };
  }
  const payload: unknown = await resp.json();
  if (hasSupabase(env)) {
    const sb = getSupabase(env);
    await sb.from(table).upsert(
      {
        congress,
        bill_type: type,
        bill_number: number,
        payload,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "congress,bill_type,bill_number" }
    );
  }
  return {
    ok: true as const,
    data: payload,
  };
}

function queueBillPayloadRefresh(
  executionCtx: ExecutionContext,
  env: Env["Bindings"],
  apiKey: string,
  table: BillCacheTable,
  path: string,
  congress: number,
  type: string,
  number: number,
  params?: Record<string, string>
) {
  executionCtx.waitUntil(
    fetchBillPayloadAndCache(env, apiKey, table, path, congress, type, number, params).catch(
      () => undefined
    )
  );
}

async function refreshVoteListCache(
  env: Env["Bindings"],
  apiKey: string,
  congressNum: string,
  chamber: string | undefined,
  limit: number,
  offset: number
) {
  const requiredWindowSize = limit + offset;
  const sessions = ["1", "2"];
  const chamberNormalized = chamber?.toLowerCase();
  const votePathPrefix = chamberNormalized === "senate" ? "senate-vote" : "house-vote";
  const chamberLabel = chamberNormalized === "senate" ? "Senate" : "House";
  const CONGRESS_MAX_LIMIT = 250;

  type VoteListItem = {
    congress?: number;
    rollCallNumber?: number;
    startDate?: string;
    voteQuestion?: string;
    result?: string;
    voteType?: string;
    legislationUrl?: string;
  };

  const fetchSessionVotes = async (session: string) => {
    const votes: VoteListItem[] = [];
    let pageOffset = 0;
    while (votes.length < requiredWindowSize) {
      const remaining = requiredWindowSize - votes.length;
      const pageLimit = Math.min(CONGRESS_MAX_LIMIT, remaining);
      const resp = await congressFetch(`/${votePathPrefix}/${congressNum}/${session}`, apiKey, {
        limit: String(pageLimit),
        offset: String(pageOffset),
      });
      if (!resp.ok) return votes;
      const data = (await resp.json()) as {
        houseRollCallVotes?: VoteListItem[];
        senateRollCallVotes?: VoteListItem[];
      };
      const pageVotes = data.houseRollCallVotes ?? data.senateRollCallVotes ?? [];
      if (pageVotes.length === 0) break;
      votes.push(...pageVotes);
      if (pageVotes.length < pageLimit) break;
      pageOffset += pageLimit;
    }
    return votes;
  };

  const sessionVotes = (await Promise.all(sessions.map((session) => fetchSessionVotes(session)))).flat();
  const rows = sessionVotes
    .sort((left, right) => (right.startDate ?? "").localeCompare(left.startDate ?? ""))
    .slice(offset, offset + limit)
    .filter((vote) => vote.congress && vote.rollCallNumber)
    .map((vote) =>
      toVoteCacheRow({
        congress: vote.congress!,
        chamber: chamberLabel,
        rollCallNumber: vote.rollCallNumber!,
        date: vote.startDate ?? null,
        question: vote.voteQuestion ?? vote.voteType ?? null,
        description: vote.voteType ?? null,
        result: vote.result ?? null,
        bill: parseBillReferenceFromUrl(vote.legislationUrl),
      })
    );
  if (rows.length > 0 && hasSupabase(env)) {
    const sb = getSupabase(env);
    await sb.from("votes").upsert(rows, { onConflict: "congress,chamber,roll_call_number" });
  }
}

type CongressVoteMember = {
  bioguideId?: string;
  bioguideID?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  name?: string;
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
    fullName: member.fullName ?? member.name,
    name: member.name,
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
      fullName: member.fullName ?? member.name,
      name: member.name,
      party: member.party ?? member.voteParty,
      state: member.state ?? member.voteState,
      votePosition: member.votePosition ?? member.memberVoted ?? member.voteCast,
    }));
  }

  return extractVoteMembers(nested);
}

function createVoteMemberBioguideResolver(
  env: Env["Bindings"],
  apiKey: string,
  congress: number
) {
  let senateLookupPromise: Promise<SenateMemberLookup[]> | null = null;

  return async (members: CongressVoteMember[], chamber: string) => {
    if (getVoteRouteMeta(chamber).normalized !== "senate") return members;
    if (!members.some((member) => !member.bioguideId)) return members;

    senateLookupPromise ??= loadSenateMemberLookup(env, apiKey, congress);
    const senators = await senateLookupPromise;
    if (!senators.length) return members;

    return members.map((member) => ({
      ...member,
      bioguideId:
        member.bioguideId ??
        resolveSenateMemberBioguide(
          {
            firstName: member.firstName,
            lastName: member.lastName,
            fullName: member.fullName ?? member.name,
            party: member.party,
            state: member.state,
          },
          senators
        ) ??
        undefined,
    }));
  };
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function getXmlTagText(xml: string, tagName: string): string | null {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i"));
  const value = match?.[1]?.trim();
  return value ? decodeXmlEntities(value) : null;
}

function parseSenateVoteXml(xml: string) {
  if (!xml.includes("<roll_call_vote>")) return null;

  const countSection = getXmlTagText(xml, "count") ?? "";
  const totalYea = asNumber(getXmlTagText(countSection, "yeas"));
  const totalNay = asNumber(getXmlTagText(countSection, "nays"));
  const totalPresent = asNumber(getXmlTagText(countSection, "present"));
  const totalNotVoting = asNumber(getXmlTagText(countSection, "absent"));

  const members = [...xml.matchAll(/<member>([\s\S]*?)<\/member>/gi)].map((match) => {
    const memberXml = match[1];
    const firstName = getXmlTagText(memberXml, "first_name");
    const lastName = getXmlTagText(memberXml, "last_name");
    const fullName =
      getXmlTagText(memberXml, "member_full") ??
      [firstName, lastName].filter(Boolean).join(" ").trim() ??
      null;

    return {
      bioguideId: null,
      firstName: firstName ?? undefined,
      lastName: lastName ?? undefined,
      fullName: fullName ?? undefined,
      party: getXmlTagText(memberXml, "party") ?? undefined,
      state: getXmlTagText(memberXml, "state") ?? undefined,
      votePosition: getXmlTagText(memberXml, "vote_cast") ?? undefined,
    };
  });

  return {
    congress: asNumber(getXmlTagText(xml, "congress")),
    chamber: "Senate",
    date: getXmlTagText(xml, "vote_date"),
    question: getXmlTagText(xml, "question") ?? getXmlTagText(xml, "vote_question_text"),
    description: getXmlTagText(xml, "vote_title") ?? getXmlTagText(xml, "vote_document_text"),
    result: getXmlTagText(xml, "vote_result") ?? getXmlTagText(xml, "vote_result_text"),
    totalYea,
    totalNay,
    totalPresent,
    totalNotVoting,
    members,
  };
}

async function fetchVoteFromSourceUrl(
  sourceUrl: string,
  voteMeta: ReturnType<typeof getVoteRouteMeta>,
  env: Env["Bindings"],
  apiKey: string,
  congress: number
) {
  if (voteMeta.normalized !== "senate") return null;
  if (!/^https:\/\/www\.senate\.gov\/legislative\/LIS\/roll_call_votes\/vote\d+\/vote_\d+_\d+_\d+\.xml$/i.test(sourceUrl)) {
    return null;
  }

  const resp = await fetch(sourceUrl);
  if (!resp.ok) return null;

  const xml = await resp.text();
  const parsed = parseSenateVoteXml(xml);
  if (!parsed) return null;

  const senators = await loadSenateMemberLookup(env, apiKey, congress);
  return {
    ...parsed,
    members: parsed.members.map((member) => ({
      ...member,
      bioguideId: resolveSenateMemberBioguide(member, senators) ?? undefined,
    })),
  };
}


type CongressPartyHistoryItem = {
  partyName?: string;
  partyAbbreviation?: string;
};

type CongressMemberLike = {
  party?: string | null;
  partyName?: string;
  partyHistory?: CongressPartyHistoryItem[];
  terms?: {
    item?: Array<{
      party?: string;
      partyName?: string;
      partyAbbreviation?: string;
      chamber?: string;
      startYear?: number;
      endYear?: number;
    }>;
  };
};

type CongressMemberApiMember = {
  bioguideId?: string;
  name?: string;
  directOrderName?: string;
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

type CongressMemberDetailTerm = {
  chamber?: string;
  congress?: number;
  startYear?: number;
  endYear?: number;
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

function normalizeMemberImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;

  const normalizedPath = trimmed.replace(/^\/+/, "");
  if (!normalizedPath) return null;
  if (normalizedPath.startsWith("img/member/")) {
    return `https://www.congress.gov/${normalizedPath}`;
  }

  return `https://www.congress.gov/img/member/${normalizedPath}`;
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
    depiction: member.depiction?.imageUrl
      ? { imageUrl: normalizeMemberImageUrl(member.depiction.imageUrl) ?? member.depiction.imageUrl }
      : member.depiction,
  }));
}

function extractMemberChamber(member: CongressMemberLike & Record<string, unknown>): string | null {
  const summarizedChamber = summarizeMemberTerms(member.terms).chamber;
  const chamber =
    summarizedChamber ??
    (typeof member.chamber === "string"
      ? member.chamber
      : null);

  if (!chamber) return null;

  const normalized = chamber.trim().toLowerCase();
  if (normalized.includes("senate")) return "Senate";
  if (normalized.includes("house")) return "House";
  return chamber;
}

function inferMemberChamber(member: {
  chamber?: string | null;
  district?: number | null;
  senateVotes?: number | null;
  houseVotes?: number | null;
}): string | null {
  if (member.chamber) return member.chamber;
  if ((member.senateVotes ?? 0) > 0 && (member.houseVotes ?? 0) === 0) return "Senate";
  if ((member.houseVotes ?? 0) > 0 && (member.senateVotes ?? 0) === 0) return "House";
  if (member.district == null) return "Senate";
  return "House";
}

function summarizeMemberTerms(
  terms: CongressMemberDetailTerm[] | { item?: CongressMemberDetailTerm[] } | undefined
) {
  const allTerms = Array.isArray(terms)
    ? terms
    : Array.isArray(terms?.item)
      ? terms.item
      : [];
  if (!allTerms.length) {
    return {
      chamber: null as string | null,
      firstCongress: null as number | null,
      lastCongress: null as number | null,
      totalTerms: 0,
      congressesServed: null as number | null,
      yearsServed: null as number | null,
    };
  }

  const chambers = allTerms.map((term) => normalizeChamberLabel(term.chamber)).filter(Boolean);
  const senateCount = chambers.filter((value) => value === "Senate").length;
  const houseCount = chambers.filter((value) => value === "House").length;
  const chamber =
    senateCount === houseCount
      ? chambers[0] ?? null
      : senateCount > houseCount
        ? "Senate"
        : "House";

  const congresses = allTerms
    .map((term) => term.congress)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const totalTerms = allTerms.length;
  const congressesServed = congresses.length
    ? new Set(congresses).size
    : totalTerms;
  const firstCongress = congresses.length ? Math.min(...congresses) : null;
  const lastCongress = congresses.length ? Math.max(...congresses) : null;

  const startYears = allTerms
    .map((term) => term.startYear)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const endYears = allTerms
    .map((term) => term.endYear ?? new Date().getFullYear())
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const yearsServed =
    startYears.length && endYears.length
      ? Math.max(0, Math.max(...endYears) - Math.min(...startYears))
      : null;

  return { chamber, firstCongress, lastCongress, totalTerms, congressesServed, yearsServed };
}

function deriveCongressesServed(options: {
  congressesServed?: number | null;
  totalTerms?: number | null;
  firstCongress?: number | null;
  lastCongress?: number | null;
}) {
  const candidates = [
    options.congressesServed,
    options.totalTerms,
    options.firstCongress != null && options.lastCongress != null
      ? Math.max(1, options.lastCongress - options.firstCongress + 1)
      : null,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);

  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

function normalizeChamberLabel(chamber?: string | null): string | null {
  const value = (chamber ?? "").trim().toLowerCase();
  if (!value) return null;
  if (value.includes("senate")) return "Senate";
  if (value.includes("house")) return "House";
  return chamber ?? null;
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
const BILL_METADATA_FETCH_BUDGET = 20;

function normalizeText(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

function textMatches(source: string | undefined | null, query: string | undefined | null): boolean {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return true;
  return normalizeText(source).includes(normalizedQuery);
}

function normalizeDateValue(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function dateInRange(
  value: string | undefined | null,
  startDate: string | null,
  endDate: string | null
) {
  const normalizedValue = normalizeDateValue(value);
  if (!normalizedValue) return !startDate && !endDate;
  if (startDate && normalizedValue < startDate) return false;
  if (endDate && normalizedValue > endDate) return false;
  return true;
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
  search: string | null,
  startDate: string | null,
  endDate: string | null
) {
  if (status && bill.status.key !== status) return false;
  if (!dateInRange(bill.latestAction?.actionDate ?? bill.updateDate ?? bill.introducedDate, startDate, endDate)) {
    return false;
  }

  const searchableFields = [
    bill.title,
    bill.latestAction?.text,
    bill.policyArea?.name,
    bill.sponsor?.fullName,
    bill.sponsor?.state,
    bill.originChamber,
    ...bill.committees,
  ];
  if (search && !searchableFields.some((field) => textMatches(field, search))) return false;
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

function getBillSortDateValue(
  bill: ReturnType<typeof normalizeBillForList>,
  sort: string
): string {
  if (sort.startsWith("introducedDate")) {
    return bill.introducedDate ?? bill.latestAction?.actionDate ?? bill.updateDate ?? "";
  }

  // "Newest activity" must follow the exact date rendered on the card's bottom-left
  // action line. That visible date comes from latestAction.actionDate, not updateDate.
  // Regressions here caused the default bills view to look out of order even when the
  // date-filtered scan path was correct, so keep latestAction.actionDate as the primary
  // sort key for updateDate-based sorts.
  return bill.latestAction?.actionDate ?? bill.updateDate ?? bill.introducedDate ?? "";
}

function compareNormalizedBills(
  left: ReturnType<typeof normalizeBillForList>,
  right: ReturnType<typeof normalizeBillForList>,
  sort: string
) {
  const ascending = sort.endsWith("+asc");
  const leftDate = getBillSortDateValue(left, sort);
  const rightDate = getBillSortDateValue(right, sort);
  const dateComparison = ascending
    ? leftDate.localeCompare(rightDate)
    : rightDate.localeCompare(leftDate);

  if (dateComparison !== 0) return dateComparison;

  const leftLabel = `${left.type ?? ""}-${left.number ?? ""}-${left.title ?? ""}`;
  const rightLabel = `${right.type ?? ""}-${right.number ?? ""}-${right.title ?? ""}`;
  return leftLabel.localeCompare(rightLabel);
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
  await sb
    .from("bills")
    .upsert(prepareBillCacheRowsForUpsert(rows), { onConflict: "congress,bill_type,bill_number" });
}

async function warmBillsCache(
  env: Env["Bindings"],
  apiKey: string,
  options: ReturnType<typeof resolveBillWarmRequest>
) {
  let pagesWarmed = 0;
  let billsSeen = 0;
  let billsUpserted = 0;
  let newestLatestActionDate: string | null = null;
  let newestUpdateDate: string | null = null;

  for (let pageIndex = 0; pageIndex < options.maxPages; pageIndex += 1) {
    const offset = pageIndex * options.pageSize;
    const data = await fetchCongressBillsPage(
      apiKey,
      options.congress,
      options.billType,
      options.pageSize,
      offset,
      options.sort
    );
    const pageBills = data.bills ?? [];
    if (pageBills.length === 0) break;

    const cacheRows = pageBills
      .map((bill) => toBillCacheRow(bill))
      .filter(Boolean) as Array<Record<string, unknown>>;

    if (cacheRows.length > 0) {
      await upsertCachedBills(env, cacheRows);
      billsUpserted += cacheRows.length;
    }

    billsSeen += pageBills.length;
    pagesWarmed += 1;

    const firstBill = pageBills[0];
    if (!newestLatestActionDate && firstBill?.latestAction?.actionDate) {
      newestLatestActionDate = firstBill.latestAction.actionDate;
    }
    if (!newestUpdateDate && firstBill?.updateDate) {
      newestUpdateDate = firstBill.updateDate;
    }

    if (!data.pagination?.next || pageBills.length < options.pageSize) break;
  }

  return {
    congress: Number.parseInt(options.congress, 10),
    bill_type: options.billType,
    sort: options.sort,
    page_size: options.pageSize,
    max_pages_requested: options.maxPages,
    pages_warmed: pagesWarmed,
    bills_seen: billsSeen,
    bills_upserted: billsUpserted,
    newest_latest_action_date: newestLatestActionDate,
    newest_update_date: newestUpdateDate,
  };
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

async function seedFilteredBillsFromCongress(
  env: Env["Bindings"],
  apiKey: string,
  congressNum: string,
  billType: string | null,
  sort: string,
  status: string | null,
  search: string | null,
  startDate: string | null,
  endDate: string | null,
  sponsorParty: string | null,
  limit: number,
  offset: number
) {
  const BILL_SEED_PAGE_SIZE = 250;
  const BILL_SEED_MAX_PAGES = 4;
  const matchedBills: Array<ReturnType<typeof normalizeBillForList>> = [];
  const cacheRows: Array<Record<string, unknown>> = [];
  let scanned = 0;

  for (let pageIndex = 0; pageIndex < BILL_SEED_MAX_PAGES; pageIndex += 1) {
    const pageOffset = pageIndex * BILL_SEED_PAGE_SIZE;
    const data = await fetchCongressBillsPage(
      apiKey,
      congressNum,
      billType,
      BILL_SEED_PAGE_SIZE,
      pageOffset,
      sort
    );
    const pageBills = data.bills ?? [];
    if (pageBills.length === 0) break;
    scanned += pageBills.length;

    const normalizedPage = pageBills.map((bill) => normalizeBillForList(bill));
    for (const bill of normalizedPage) {
      if (
        billMatchesSummaryFilters(bill, status, search, startDate, endDate) &&
        billMatchesMetadataFilters(bill, sponsorParty, null, null)
      ) {
        matchedBills.push(bill);
      }
    }

    cacheRows.push(
      ...(pageBills
        .map((bill) => toBillCacheRow(bill))
        .filter(Boolean) as Array<Record<string, unknown>>)
    );

    if (!data.pagination?.next || pageBills.length < BILL_SEED_PAGE_SIZE) break;
    if (matchedBills.length >= offset + limit) break;
  }

  if (cacheRows.length > 0) {
    await upsertCachedBills(env, cacheRows);
  }

  matchedBills.sort((left, right) => compareNormalizedBills(left, right, sort));
  return {
    bills: matchedBills.slice(offset, offset + limit),
    matchedCount: matchedBills.length,
    scanned,
    partial: true,
  };
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
congress.get("/members", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const currentCongress = c.req.query("congress") ?? "119";
  const limit = parseBoundedInt(c.req.query("limit"), 20, 1, 100);
  const offset = parseBoundedInt(c.req.query("offset"), 0, 0, 5000);

  if (hasSupabase(c.env)) {
    try {
      const sb = getSupabase(c.env);
      const { data, count, error } = await sb
        .from("member_congresses")
        .select("*", { count: "exact" })
        .eq("congress", parseInt(currentCongress, 10))
        .order("name")
        .range(offset, offset + limit - 1);
      if (!error && data && data.length > 0) {
        if (isRowSetStale(data, MEMBERS_CACHE_STALE_MS)) {
          queueMembersRefresh(c.executionCtx, c.env, apiKey, currentCongress, limit, offset);
        }
        return c.json(
          {
            members: data.map((row) => ({
              bioguideId: row.bioguide_id,
              name: row.name,
              party: normalizePartyValue(row.party) ?? row.party,
              state: row.state,
              district: row.district,
              depiction: row.image_url ? { imageUrl: row.image_url } : undefined,
            })),
            count: count ?? data.length,
          },
          200,
          { "Cache-Control": "public, max-age=3600" }
        );
      }
    } catch {
      // Fall through to live fetch.
    }
  }

  try {
    const live = await fetchMembersFromCongress(c.env, apiKey, currentCongress, limit, offset);
    return c.json(live, 200, { "Cache-Control": "public, max-age=3600" });
  } catch (error) {
    if (error instanceof FetchTimeoutError) {
      return c.json({ error: error.message }, 504);
    }
    return c.json({ error: "Failed to fetch from Congress API" }, 502);
  }
});

// ── GET /api/congress/members/search ─────────────────────────────────────────
// Search members by name.
congress.get("/members/search", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const query = c.req.query("q");
  if (!query) return c.json({ error: "Missing search query 'q'" }, 400);

  const currentCongress = c.req.query("congress") ?? "119";

  if (hasSupabase(c.env)) {
    try {
      const sb = getSupabase(c.env);
      const q = `%${query}%`;
      const { data, error } = await sb
        .from("member_congresses")
        .select("*")
        .eq("congress", parseInt(currentCongress, 10))
        .or(`name.ilike.${q},state.ilike.${q},party.ilike.${q}`)
        .order("name")
        .limit(50);
      if (!error && data && data.length > 0) {
        if (isRowSetStale(data, MEMBERS_CACHE_STALE_MS)) {
          queueMembersRefresh(c.executionCtx, c.env, apiKey, currentCongress, 250, 0);
        }
        return c.json(
          {
            members: data.map((row) => ({
              bioguideId: row.bioguide_id,
              name: row.name,
              party: normalizePartyValue(row.party) ?? row.party,
              state: row.state,
              district: row.district,
              depiction: row.image_url ? { imageUrl: row.image_url } : undefined,
            })),
            count: data.length,
          },
          200,
          { "Cache-Control": "public, max-age=3600" }
        );
      }
    } catch {
      // Fall through to live fetch.
    }
  }

  try {
    const normalizedMembers = normalizeCongressMembers(await fetchAllCongressMembers(apiKey, currentCongress));
    const qLower = query.toLowerCase();
    const filtered = normalizedMembers.filter((m) => {
      const name = (m.name ?? "").toLowerCase();
      const state = (m.state ?? "").toLowerCase();
      const party = (m.party ?? "").toLowerCase();
      return name.includes(qLower) || state.includes(qLower) || party.includes(qLower);
    });
    if (normalizedMembers.length) {
      c.executionCtx.waitUntil(
        cacheMembersToSupabase(c.env, parseInt(currentCongress, 10), normalizedMembers)
      );
    }
    return c.json({ members: filtered, count: filtered.length }, 200, {
      "Cache-Control": "public, max-age=3600",
    });
  } catch (error) {
    if (error instanceof FetchTimeoutError) {
      return c.json({ error: error.message }, 504);
    }
    return c.json({ error: "Failed to fetch from Congress API" }, 502);
  }
});

// ── GET /api/congress/members/browse ─────────────────────────────────────────
// Browse members from Supabase cache first so the UI can filter/sort locally.
congress.get("/members/browse", async (c) => {
  const currentCongress = parseBoundedInt(c.req.query("congress"), 119, 1, 999);
  const apiKey = c.env.CONGRESS_API_KEY;

  if (hasSupabase(c.env)) {
    try {
      const sb = getSupabase(c.env);
      let [membersRes, statsRes, canonicalRes] = await Promise.all([
        sb
          .from("member_congresses")
          .select(
            "bioguide_id,name,party,state,district,chamber,image_url,congress,updated_at"
          )
          .eq("congress", currentCongress)
          .order("name", { ascending: true }),
        sb
          .from("member_vote_stats")
          .select("bioguide_id,first_congress,last_congress,house_votes,senate_votes"),
        sb
          .from("members")
          .select("bioguide_id,direct_order_name,first_congress,last_congress,total_terms,congresses_served,years_served"),
      ]);

      if (membersRes.error) throw membersRes.error;
      if (statsRes.error) throw statsRes.error;
      if (canonicalRes.error) throw canonicalRes.error;

      let rows = membersRes.data ?? [];
      if (rows.length === 0) {
        await backfillMemberCongressesFromMembers(c.env, currentCongress);
        const refetched = await sb
          .from("member_congresses")
          .select("bioguide_id,name,party,state,district,chamber,image_url,congress,updated_at")
          .eq("congress", currentCongress)
          .order("name", { ascending: true });
        if (!refetched.error && refetched.data?.length) {
          rows = refetched.data;
        }
      }

      const statsById = new Map((statsRes.data ?? []).map((row) => [row.bioguide_id, row]));
      const canonicalById = new Map((canonicalRes.data ?? []).map((row) => [row.bioguide_id, row]));

      // Members browse must stay cache-only in production. It is a small, mostly static
      // dataset, and adding per-member Congress.gov hydration here has repeatedly pushed
      // the deployed Worker beyond the Pages proxy timeout.
      const members = rows.map((row) => {
        const stats = statsById.get(row.bioguide_id);
        const canonical = canonicalById.get(row.bioguide_id);
        const chamber = inferMemberChamber({
          chamber: normalizeChamberLabel(row.chamber) ?? row.chamber,
          district: row.district,
          houseVotes: stats?.house_votes ?? null,
          senateVotes: stats?.senate_votes ?? null,
        });
        const firstCongress =
          canonical?.first_congress ??
          stats?.first_congress ??
          row.congress ??
          null;
        const lastCongress =
          canonical?.last_congress ??
          stats?.last_congress ??
          row.congress ??
          null;
        const congressesServed = deriveCongressesServed({
          congressesServed: canonical?.congresses_served ?? null,
          totalTerms: canonical?.total_terms ?? null,
          firstCongress,
          lastCongress,
        });

        return {
          bioguideId: row.bioguide_id,
          name: row.name,
          directOrderName: canonical?.direct_order_name ?? undefined,
          party: row.party,
          state: row.state,
          district: row.district,
          chamber,
          depiction: row.image_url
            ? { imageUrl: normalizeMemberImageUrl(row.image_url) ?? row.image_url }
            : undefined,
          firstCongress,
          lastCongress,
          congressesServed,
          yearsServed: canonical?.years_served ?? undefined,
        };
      });

      if (members.length > 0) {
        return c.json(
          { members, count: members.length, source: "supabase_cache" },
          200,
          { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" }
        );
      }
    } catch {
      // Fall through to live fetch.
    }
  }

  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  try {
    const normalizedMembers = normalizeCongressMembers(await fetchAllCongressMembers(apiKey, String(currentCongress)));
    c.executionCtx.waitUntil(cacheMembersToSupabase(c.env, currentCongress, normalizedMembers));
    const members = normalizedMembers.map((member) => ({
      bioguideId: member.bioguideId,
      name: member.name,
      directOrderName: typeof member.directOrderName === "string" ? member.directOrderName : undefined,
      party: member.party,
      state: member.state,
      district: member.district,
      chamber: extractMemberChamber(member) ?? inferMemberChamber(member),
      depiction: member.depiction,
      firstCongress: currentCongress,
      lastCongress: currentCongress,
      congressesServed: 1,
    }));

    return c.json(
      { members, count: members.length, source: "congress_live" },
      200,
      { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" }
    );
  } catch (error) {
    if (error instanceof FetchTimeoutError) {
      return c.json({ error: error.message }, 504);
    }
    return c.json({ error: "Failed to fetch from Congress API" }, 502);
  }
});

// ── GET /api/congress/members/:bioguideId/google-autocomplete ───────────────
congress.get("/members/:bioguideId/google-autocomplete", async (c) => {
  const bioguideId = c.req.param("bioguideId");
  const apiKey = c.env.CONGRESS_API_KEY;
  const memberName = await resolveMemberNameForAutocomplete(c.env, apiKey, bioguideId);

  if (!memberName) {
    return c.json({ error: "Member not found" }, 404, { "Cache-Control": "no-store" });
  }

  try {
    const requestedProbe = getGoogleAutocompleteProbe(memberName, c.req.query("probe"));

    if (hasSupabase(c.env)) {
      const cached = await readGoogleAutocompleteCache(c.env, bioguideId, requestedProbe.key);
      if (
        cached?.payload &&
        cached.query === requestedProbe.query &&
        !isTimestampStale(cached.updated_at, GOOGLE_AUTOCOMPLETE_CACHE_STALE_MS)
      ) {
        return c.json(
          {
            bioguideId,
            memberName,
            disclaimer: "Live Google autocomplete suggestions. This is not sentiment analysis.",
            fetchedAt: cached.updated_at,
            probe: cached.payload,
          },
          200,
          { "Cache-Control": "public, max-age=300" },
        );
      }
    }

    const payload = await fetchGoogleAutocompleteSuggestions(requestedProbe.query);
    const fetchedAt = new Date().toISOString();
    const probe = {
      key: requestedProbe.key,
      query: requestedProbe.query,
      suggestions: parseGoogleAutocompleteResponse(requestedProbe.query, payload),
    } satisfies GoogleAutocompleteCachePayload;

    await writeGoogleAutocompleteCache(c.env, bioguideId, probe, fetchedAt);

    return c.json(
      {
        bioguideId,
        memberName,
        disclaimer: "Live Google autocomplete suggestions. This is not sentiment analysis.",
        fetchedAt,
        probe,
      },
      200,
      { "Cache-Control": "public, max-age=300" },
    );
  } catch (error) {
    if (error instanceof FetchTimeoutError) {
      return c.json({ error: error.message }, 504, { "Cache-Control": "no-store" });
    }
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to fetch Google autocomplete results" },
      502,
      { "Cache-Control": "no-store" },
    );
  }
});

// ── GET /api/congress/members/:bioguideId ────────────────────────────────────
congress.get("/members/:bioguideId", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const bioguideId = c.req.param("bioguideId");

  if (hasSupabase(c.env)) {
    try {
      const sb = getSupabase(c.env);
      const { data, error } = await sb
        .from("member_details_cache")
        .select("payload, updated_at")
        .eq("bioguide_id", bioguideId)
        .maybeSingle<{ payload: Record<string, unknown>; updated_at: string | null }>();
      if (!error && data?.payload) {
        if (isTimestampStale(data.updated_at, MEMBER_DETAIL_CACHE_STALE_MS)) {
          queueMemberDetailRefresh(c.executionCtx, c.env, apiKey, bioguideId);
        }
        return c.json(data.payload, 200, { "Cache-Control": "public, max-age=3600" });
      }
    } catch {
      // Fall through to live fetch.
    }
  }

  try {
    const live = await fetchMemberDetailFromCongress(c.env, apiKey, bioguideId);
    if (!live.ok) {
      return c.json({ error: `Congress API: ${live.status}` }, 502);
    }
    return c.json(live.data, 200, { "Cache-Control": "public, max-age=3600" });
  } catch (error) {
    if (error instanceof FetchTimeoutError) {
      return c.json({ error: error.message }, 504);
    }
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
        if (isRowSetStale(data, VOTES_CACHE_STALE_MS)) {
          c.executionCtx.waitUntil(
            refreshVoteListCache(c.env, apiKey, congress_num, chamber, limit, offset).catch(
              () => undefined
            )
          );
        }
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
    const normalized = allVotes.map((v) => {
      const bill = parseBillReferenceFromUrl(v.legislationUrl);
      return {
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
        bill: bill
          ? {
              congress: bill.congress,
              type: bill.type,
              number: bill.number,
              apiUrl: bill.apiUrl,
            }
          : undefined,
      };
    });

    // Cache votes to Supabase in the background
    if (hasSupabase(c.env) && normalized.length) {
      const sb = getSupabase(c.env);
      const rows = normalized
        .filter((v) => v.congress && v.rollCallNumber)
        .map((v) =>
          toVoteCacheRow({
            congress: v.congress!,
            chamber: chamberLabel,
            rollCallNumber: v.rollCallNumber!,
            date: v.date ?? null,
            question: v.question ?? null,
            description: v.description ?? null,
            result: v.result ?? null,
            bill: v.bill
              ? {
                  congress: Number(v.bill.congress),
                  type: v.bill.type,
                  number: Number(v.bill.number),
                }
              : null,
          })
        );
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
    if (e instanceof FetchTimeoutError) {
      return c.json({ error: e.message }, 504);
    }
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
  const requestedSession = c.req.query("session")?.trim();
  const sourceUrl = c.req.query("source_url")?.trim();

  const voteMeta = getVoteRouteMeta(chamber);

  if (hasSupabase(c.env)) {
    try {
      const cached = await readVoteDetailFromSupabase(
        c.env,
        parseInt(cong, 10),
        voteMeta.normalized,
        parseInt(rollCallNumber, 10)
      );
      if (cached && cached.hasMembers) {
        if (isTimestampStale(cached.updatedAt, VOTE_DETAIL_CACHE_STALE_MS)) {
          c.executionCtx.waitUntil(
            congressFetch(`/${voteMeta.pathPrefix}/${cong}/2/${rollCallNumber}`, apiKey)
              .then(() => undefined)
              .catch(() => undefined)
          );
        }
        return c.json(cached.payload, 200, { "Cache-Control": "public, max-age=1800" });
      }
    } catch {
      // Fall through to live fetch.
    }
  }

  const sessions = requestedSession && /^(1|2)$/.test(requestedSession)
    ? [requestedSession, ...(requestedSession === "1" ? ["2"] : ["1"])]
    : ["2", "1"];
  const resolveVoteMemberBioguides = createVoteMemberBioguideResolver(
    c.env,
    apiKey,
    parseInt(cong, 10)
  );

  for (const session of sessions) {
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
              members = await resolveVoteMemberBioguides(
                extractVoteMembersFromResponse(membersData),
                voteMeta.normalized
              );
            }
          } catch {
            // Best-effort: summary data is still useful without member rows.
          }

          if (
            voteMeta.normalized === "senate" &&
            (!members.length || members.some((member) => !member.bioguideId))
          ) {
            try {
              const fallbackSourceUrl =
                sourceUrl && /^https?:\/\//i.test(sourceUrl)
                  ? sourceUrl
                  : buildSenateVoteXmlUrl(
                      parseInt(cong, 10),
                      session,
                      parseInt(rollCallNumber, 10)
                    );
              const fallbackVote = await fetchVoteFromSourceUrl(
                fallbackSourceUrl,
                voteMeta,
                c.env,
                apiKey,
                parseInt(cong, 10)
              );
              if (fallbackVote?.members?.length) {
                members = fallbackVote.members;
              }
            } catch {
              // Keep the summary response even if the XML fallback fails.
            }
          }

          const bill = extractBillReferenceFromVote(v);

          // Cache the roll call and member-level votes so bill-linked vote pages
          // create durable member histories even when the vote list was never cached.
          if (hasSupabase(c.env)) {
            c.executionCtx.waitUntil(
              cacheVoteDetailToSupabase(c.env, {
                congress: asNumber(v.congress) || parseInt(cong, 10),
                chamber: voteMeta.normalized,
                rollCallNumber: parseInt(rollCallNumber, 10),
                date: typeof v.startDate === "string" ? v.startDate : null,
                question: typeof v.voteQuestion === "string" ? v.voteQuestion : null,
                description: typeof v.voteType === "string" ? v.voteType : null,
                result: typeof v.result === "string" ? v.result : null,
                totalYea,
                totalNay,
                totalNotVoting,
                bill,
              }, members)
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

  if (sourceUrl) {
    try {
      const fallbackVote = await fetchVoteFromSourceUrl(
        sourceUrl,
        voteMeta,
        c.env,
        apiKey,
        parseInt(cong, 10)
      );
      if (fallbackVote) {
        if (hasSupabase(c.env)) {
          c.executionCtx.waitUntil(
            cacheVoteDetailToSupabase(
              c.env,
              {
                congress: fallbackVote.congress || parseInt(cong, 10),
                chamber: voteMeta.normalized,
                rollCallNumber: parseInt(rollCallNumber, 10),
                date: fallbackVote.date ?? null,
                question: fallbackVote.question ?? null,
                description: fallbackVote.description ?? null,
                result: fallbackVote.result ?? null,
                totalYea: fallbackVote.totalYea,
                totalNay: fallbackVote.totalNay,
                totalNotVoting: fallbackVote.totalNotVoting,
                bill: null,
              },
              fallbackVote.members
            )
          );
        }
        return c.json(
          {
            vote: fallbackVote,
            raw: { sourceUrl },
          },
          200,
          { "Cache-Control": "public, max-age=1800" }
        );
      }
    } catch {
      // Fall through to 404 below.
    }
  }

  return c.json({ error: `Vote not found: congress ${cong}, roll call ${rollCallNumber}` }, 404);
});

// ── GET /api/congress/member-votes/:bioguideId ──────────────────────────────
// Fetch a member's voting record from Congress.gov. This populates the
// member_votes table so the Follow the Money page can show voting data.
congress.get("/member-votes/:bioguideId", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  const bioguideId = c.req.param("bioguideId");
  const congressNum = c.req.query("congress") ?? "119";
  const limit = parseBoundedInt(c.req.query("limit"), 20, 1, 100);
  const sessions = ["2", "1"];

  if (hasSupabase(c.env)) {
    try {
      const sb = getSupabase(c.env);
      let votesQuery = sb
        .from("member_voting_record")
        .select("*", { count: "exact" })
        .eq("bioguide_id", bioguideId)
        .order("vote_date", { ascending: false })
        .limit(limit);

      if (congressNum) {
        votesQuery = votesQuery.eq("congress", parseInt(congressNum, 10));
      }

      const [votesRes, statsRes] = await Promise.all([
        votesQuery,
        sb.from("member_vote_stats").select("*").eq("bioguide_id", bioguideId).maybeSingle(),
      ]);

      if (!votesRes.error && votesRes.data && votesRes.data.length > 0) {
        return c.json(
          {
            bioguide_id: bioguideId,
            votes: votesRes.data.map((row) => mapDbMemberVotingRecord(row as Record<string, unknown>)),
            count: votesRes.count ?? votesRes.data.length,
            stats: statsRes.data ?? undefined,
            source: "supabase_cache",
          },
          200,
          { "Cache-Control": "public, max-age=1800" }
        );
      }
    } catch {
      // Fall through to live fetch.
    }
  }

  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

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
  const resolveVoteMemberBioguides = createVoteMemberBioguideResolver(
    c.env,
    apiKey,
    parseInt(congressNum, 10)
  );
  for (const session of sessions) {
    try {
      const voteMeta = getVoteRouteMeta("house");
      const resp = await congressFetch(`/${voteMeta.pathPrefix}/${congressNum}/${session}`, apiKey, {
        limit: limit.toString(),
      });
      if (!resp.ok) continue;

      const data = (await resp.json()) as {
        houseRollCallVotes?: Array<Omit<VoteListItem, "chamberLabel" | "chamberNormalized" | "pathPrefix">>;
      };
      const incoming = data.houseRollCallVotes ?? [];
      allVotes = allVotes.concat(
        incoming.map((vote) => ({
          ...vote,
          chamberLabel: voteMeta.label,
          chamberNormalized: voteMeta.normalized,
          pathPrefix: voteMeta.pathPrefix,
        }))
      );
    } catch {
      // Skip House sessions that fail.
    }
  }

  for (const session of sessions) {
    try {
      const voteMeta = getVoteRouteMeta("senate");
      const incoming = await fetchRecentSenateVoteRefs(parseInt(congressNum, 10), session, limit);
      allVotes = allVotes.concat(
        incoming.map((vote) => ({
          ...vote,
          chamberLabel: voteMeta.label,
          chamberNormalized: voteMeta.normalized,
          pathPrefix: voteMeta.pathPrefix,
        }))
      );
    } catch {
      // Skip Senate sessions that fail.
    }
  }

  allVotes.sort((a, b) => (b.startDate ?? "").localeCompare(a.startDate ?? ""));
  allVotes = allVotes.slice(0, limit);

  // For each vote, fetch member-level data to find this member's position
  const memberVotes: MemberVoteRecord[] = [];

  // Fetch member votes in batches of 5 to avoid rate limits
  for (let i = 0; i < allVotes.length; i += 5) {
    const batch = allVotes.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(async (vote) => {
        if (!vote.rollCallNumber) return null;
        const session = String(vote.sessionNumber ?? 1);
        try {
          if (vote.chamberNormalized === "senate") {
            const senateVote = await fetchVoteFromSourceUrl(
              vote.url ?? buildSenateVoteXmlUrl(parseInt(congressNum, 10), session, vote.rollCallNumber),
              getVoteRouteMeta("senate"),
              c.env,
              apiKey,
              parseInt(congressNum, 10)
            );
            if (!senateVote) return null;
            const memberVote = senateVote.members.find((m) => m.bioguideId === bioguideId);
            if (!memberVote) return null;

            return {
              congress: senateVote.congress || vote.congress || parseInt(congressNum, 10),
              rollCallNumber: vote.rollCallNumber,
              date: senateVote.date ?? vote.startDate ?? null,
              question: senateVote.question ?? vote.voteQuestion ?? null,
              description: senateVote.description ?? vote.voteType ?? null,
              result: senateVote.result ?? vote.result ?? null,
              position: memberVote.votePosition ?? "Unknown",
              chamber: vote.chamberLabel,
            };
          }

          let resolvedMembers: CongressVoteMember[] = [];
          const resp = await congressFetch(
            `/${vote.pathPrefix}/${congressNum}/${session}/${vote.rollCallNumber}/members`,
            apiKey,
            { limit: "500" }
          );
          if (resp.ok) {
            const data = (await resp.json()) as Record<string, unknown>;
            resolvedMembers = await resolveVoteMemberBioguides(
              extractVoteMembersFromResponse(data),
              vote.chamberNormalized
            );
          }

          const memberVote = resolvedMembers.find((m) => m.bioguideId === bioguideId);
          let resolvedMemberVote: CongressVoteMember | undefined = memberVote;

          if (!resolvedMemberVote && vote.chamberNormalized === "senate") {
            const fallbackSourceUrl =
              typeof vote.url === "string" && vote.url
                ? vote.url
                : buildSenateVoteXmlUrl(
                    parseInt(congressNum, 10),
                    session,
                    vote.rollCallNumber
                  );
            const fallbackVote = await fetchVoteFromSourceUrl(
              fallbackSourceUrl,
              getVoteRouteMeta(vote.chamberNormalized),
              c.env,
              apiKey,
              parseInt(congressNum, 10)
            );
            const fallbackMembers = fallbackVote?.members ?? [];
            resolvedMemberVote = fallbackMembers.find((m) => m.bioguideId === bioguideId);
          }

          if (!resolvedMemberVote) return null;
          const billMatch =
            parseBillReferenceFromUrl(vote.legislationUrl);
          return {
            congress: vote.congress,
            rollCallNumber: vote.rollCallNumber,
            date: vote.startDate ?? null,
            question: vote.voteQuestion ?? null,
            description: vote.legislationType
              ? `${vote.legislationType} - ${vote.voteType ?? ""}`.trim()
              : vote.voteType ?? null,
            result: vote.result ?? null,
            position: resolvedMemberVote.votePosition ?? "Unknown",
            chamber: vote.chamberLabel,
            bill: billMatch
              ? {
                  congress: String(billMatch.congress),
                  type: billMatch.type,
                  number: String(billMatch.number),
                  apiUrl: billMatch.apiUrl ?? (typeof vote.legislationUrl === "string" ? vote.legislationUrl : undefined),
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

  const stats = summarizeMemberVotes(bioguideId, memberVotes);

  return c.json({
    bioguide_id: bioguideId,
    votes: memberVotes,
    count: memberVotes.length,
    stats,
    source: "live_congress_api",
  }, 200, { "Cache-Control": "public, max-age=1800" });
});

async function cacheVoteDetailToSupabase(
  env: Env["Bindings"],
  vote: VoteCacheInput,
  members: CongressVoteMember[]
) {
  try {
    const sb = getSupabase(env);
    const { data: voteRow } = await sb
      .from("votes")
      .upsert(toVoteCacheRow(vote), { onConflict: "congress,chamber,roll_call_number" })
      .select("id")
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
      await refreshMemberVoteStats(
        env,
        rows.map((row) => row.bioguide_id)
      );
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
  memberVotes: MemberVoteRecord[]
) {
  try {
    const sb = getSupabase(env);
    let wroteMemberVotes = false;

    for (const mv of memberVotes) {
      const voteCongress = mv.congress ?? congressNum;
      const { data: voteRow } = await sb
        .from("votes")
        .upsert(
          toVoteCacheRow({
            congress: voteCongress,
            chamber: mv.chamber,
            rollCallNumber: mv.rollCallNumber,
            date: mv.date,
            question: mv.question,
            description: mv.description,
            result: mv.result,
            bill: mv.bill
              ? {
                  congress: Number.parseInt(mv.bill.congress, 10),
                  type: mv.bill.type,
                  number: Number.parseInt(mv.bill.number, 10),
                  apiUrl: mv.bill.apiUrl,
                }
              : null,
          }),
          { onConflict: "congress,chamber,roll_call_number" }
        )
        .select("id")
        .single();
      if (!voteRow) continue;

      // Insert member vote
      await sb.from("member_votes").upsert({
        vote_id: voteRow.id,
        bioguide_id: bioguideId,
        position: mv.position,
      }, { onConflict: "vote_id,bioguide_id" });
      wroteMemberVotes = true;
    }

    if (wroteMemberVotes) {
      await refreshMemberVoteStats(env, [bioguideId]);
    }
  } catch {
    // Best-effort
  }
}

// ── GET /api/congress/bills ──────────────────────────────────────────────────
congress.post("/refresh/bills", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);
  if (!hasSupabase(c.env)) {
    return c.json({ error: "Supabase not configured" }, 503);
  }

  const options = resolveBillWarmRequest(c.req.query("congress"), c.req.query("type"), {
    pageSize: c.req.query("pageSize"),
    maxPages: c.req.query("maxPages"),
    sort: c.req.query("sort"),
  });

  try {
    const result = await warmBillsCache(c.env, apiKey, options);
    return c.json(
      {
        ok: true,
        job: "warm-bills-cache",
        ...result,
      },
      200,
      { "Cache-Control": "no-store" }
    );
  } catch (error) {
    if (error instanceof FetchTimeoutError) {
      return c.json({ error: error.message }, 504);
    }
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to warm bill cache" },
      502
    );
  }
});

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
  const search = c.req.query("search")?.trim() ?? "";
  const requestedStartDate = normalizeDateValue(c.req.query("startDate"));
  const requestedEndDate = normalizeDateValue(c.req.query("endDate"));
  const startDate =
    requestedStartDate && requestedEndDate && requestedStartDate > requestedEndDate
      ? requestedEndDate
      : requestedStartDate;
  const endDate =
    requestedStartDate && requestedEndDate && requestedStartDate > requestedEndDate
      ? requestedStartDate
      : requestedEndDate;
  const sponsorParty = normalizePartyValue(c.req.query("sponsorParty"));
  const sponsor = c.req.query("sponsor")?.trim() ?? "";
  const committee = c.req.query("committee")?.trim() ?? "";

  const hasSummaryFilters = Boolean(status || search || startDate || endDate);
  const hasMetadataFilters = Boolean(sponsorParty || sponsor || committee);
  const requiresScan = Boolean(sponsor || committee);
  const canServeFromCacheOnly = hasSummaryFilters || sponsorParty || !requiresScan;

  try {
    if (canServeFromCacheOnly && hasSupabase(c.env)) {
      try {
        const sb = getSupabase(c.env);
        const sortColumn = sort.startsWith("introducedDate")
          ? "introduced_date"
          : "latest_action_date";
        const ascending = sort.endsWith("+asc");
        let cacheQuery = sb
          .from("bills")
          .select(
            "congress,bill_type,bill_number,title,policy_area,latest_action_text,latest_action_date,origin_chamber,update_date,introduced_date,sponsor_bioguide_id,sponsor_name,sponsor_party,sponsor_state,committee_names,bill_status,bill_status_label,bill_status_step,updated_at",
            { count: "exact" }
          )
          .eq("congress", parseInt(congress_num, 10))
          .order(sortColumn, { ascending, nullsFirst: false })
          .order("bill_number", { ascending: true })
          .range(offset, offset + limit - 1);

        if (billType) {
          cacheQuery = cacheQuery.eq("bill_type", billType);
        }
        if (status) {
          cacheQuery = cacheQuery.eq("bill_status", status);
        }
        if (sponsorParty) {
          cacheQuery = cacheQuery.eq("sponsor_party", sponsorParty);
        }
        if (startDate) {
          cacheQuery = cacheQuery.gte("latest_action_date", startDate);
        }
        if (endDate) {
          cacheQuery = cacheQuery.lte("latest_action_date", endDate);
        }
        if (search) {
          const q = `%${search}%`;
          cacheQuery = cacheQuery.or(
            `title.ilike.${q},latest_action_text.ilike.${q},policy_area.ilike.${q},sponsor_name.ilike.${q}`
          );
        }

        const { data, count, error } = await cacheQuery;
        const hasCacheScopedFilters = Boolean(
          billType || status || search || startDate || endDate || sponsorParty
        );
        if (!error && ((data?.length ?? 0) > 0 || hasCacheScopedFilters)) {
          if ((data?.length ?? 0) === 0 && hasCacheScopedFilters) {
            const seeded = await seedFilteredBillsFromCongress(
              c.env,
              apiKey,
              congress_num,
              billType,
              sort,
              status || null,
              search || null,
              startDate,
              endDate,
              sponsorParty,
              limit,
              offset
            );
            return c.json(
              {
                bills: seeded.bills,
                count: undefined,
                notice:
                  seeded.bills.length > 0
                    ? "Results were seeded from a bounded live Congress.gov scan and cached. Broader matches may appear after more cache warming."
                    : "No cached bill matches were available. A bounded live scan ran and cached recent bill pages, but did not find a match yet.",
                pagination: {
                  offset,
                  limit,
                  count: undefined,
                  hasMore: seeded.partial && seeded.matchedCount >= offset + limit,
                  filtered: true,
                  scanned: seeded.scanned,
                },
              },
              200,
              { "Cache-Control": "public, max-age=300" }
            );
          }

          const normalizedBills = (data ?? []).map((row) =>
            normalizeBillForList(
              {
                congress: asNumber(row.congress) ?? undefined,
                type: typeof row.bill_type === "string" ? row.bill_type : undefined,
                number: asNumber(row.bill_number) ?? undefined,
                title: typeof row.title === "string" ? row.title : undefined,
                originChamber:
                  typeof row.origin_chamber === "string" ? row.origin_chamber : undefined,
                updateDate: typeof row.update_date === "string" ? row.update_date : undefined,
                introducedDate:
                  typeof row.introduced_date === "string" ? row.introduced_date : undefined,
                latestAction: {
                  text:
                    typeof row.latest_action_text === "string"
                      ? row.latest_action_text
                      : undefined,
                  actionDate:
                    typeof row.latest_action_date === "string"
                      ? row.latest_action_date
                      : undefined,
                },
                policyArea:
                  typeof row.policy_area === "string" ? { name: row.policy_area } : undefined,
              },
              row as CachedBillRow
            )
          );

          if (data && data.length > 0 && isRowSetStale(data, BILLS_CACHE_STALE_MS)) {
            c.executionCtx.waitUntil(
              fetchCongressBillsPage(apiKey, congress_num, billType, limit, offset, sort)
                .then((payload) =>
                  upsertCachedBills(
                    c.env,
                    (payload.bills ?? [])
                      .map((bill) => toBillCacheRow(bill))
                      .filter(Boolean) as Array<Record<string, unknown>>
                  )
                )
                .catch(() => undefined)
            );
          }

          return c.json(
            {
              bills: normalizedBills,
              count: count ?? normalizedBills.length,
              notice:
                hasCacheScopedFilters
                  ? "Filtered bill results are served from the warmed Supabase cache to avoid worker timeouts."
                  : undefined,
              pagination: {
                offset,
                limit,
                count: count ?? normalizedBills.length,
                hasMore: count != null ? offset + limit < count : normalizedBills.length === limit,
                filtered: hasCacheScopedFilters ? true : undefined,
                scanned: undefined,
              },
            },
            200,
            { "Cache-Control": "public, max-age=900" }
          );
        }
      } catch {
        // Fall through to live fetch or limited scan below.
      }
    }

    if (!requiresScan) {
      if (hasSupabase(c.env)) {
        try {
          const sb = getSupabase(c.env);
          // Default bill browse must be cache-first in production. The list cards already
          // render the minimal fields we persist in Supabase, and "Newest activity" must
          // sort by the visible bottom-left action date (`latest_action_date`).
          const sortColumn = sort.startsWith("introducedDate")
            ? "introduced_date"
            : "latest_action_date";
          const ascending = sort.endsWith("+asc");
          let cacheQuery = sb
            .from("bills")
            .select(
              "congress,bill_type,bill_number,title,policy_area,latest_action_text,latest_action_date,origin_chamber,update_date,introduced_date,sponsor_bioguide_id,sponsor_name,sponsor_party,sponsor_state,committee_names,bill_status,bill_status_label,bill_status_step",
              { count: "exact" }
            )
            .eq("congress", parseInt(congress_num, 10))
            .order(sortColumn, { ascending, nullsFirst: false })
            .order("bill_number", { ascending: true })
            .range(offset, offset + limit - 1);

          if (billType) {
            cacheQuery = cacheQuery.eq("bill_type", billType);
          }

          const { data, count, error } = await cacheQuery;
          if (!error && data && data.length > 0) {
            const normalizedBills = data.map((row) =>
              normalizeBillForList(
                {
                  congress: asNumber(row.congress) ?? undefined,
                  type: typeof row.bill_type === "string" ? row.bill_type : undefined,
                  number: asNumber(row.bill_number) ?? undefined,
                  title: typeof row.title === "string" ? row.title : undefined,
                  originChamber:
                    typeof row.origin_chamber === "string" ? row.origin_chamber : undefined,
                  updateDate: typeof row.update_date === "string" ? row.update_date : undefined,
                  introducedDate:
                    typeof row.introduced_date === "string" ? row.introduced_date : undefined,
                  latestAction: {
                    text:
                      typeof row.latest_action_text === "string"
                        ? row.latest_action_text
                        : undefined,
                    actionDate:
                      typeof row.latest_action_date === "string"
                        ? row.latest_action_date
                        : undefined,
                  },
                  policyArea:
                    typeof row.policy_area === "string" ? { name: row.policy_area } : undefined,
                },
                row as CachedBillRow
              )
            );

            return c.json(
              {
                bills: normalizedBills,
                count: count ?? normalizedBills.length,
                pagination: {
                  offset,
                  limit,
                  count: count ?? normalizedBills.length,
                  hasMore: count != null ? offset + limit < count : normalizedBills.length === limit,
                },
              },
              200,
              { "Cache-Control": "public, max-age=900" }
            );
          }
        } catch {
          // Fall through to live fetch.
        }
      }

      const data = await fetchCongressBillsPage(apiKey, congress_num, billType, limit, offset, sort);
      const pages = { bills: data.bills ?? [], totalCount: data.pagination?.count };

      const cachedBills = await loadCachedBills(c.env, congress_num, pages.bills);
      const normalizedWindow = pages.bills.map((bill) => {
        const identity = getBillIdentity(bill);
        return normalizeBillForList(bill, identity ? cachedBills.get(identity.key) : undefined);
      }).sort((left, right) => compareNormalizedBills(left, right, sort));

      const normalizedBills = normalizedWindow;

      const cacheRows = pages.bills
        .map((bill) => toBillCacheRow(bill))
        .filter(Boolean) as Array<Record<string, unknown>>;
      if (cacheRows.length > 0) {
        c.executionCtx.waitUntil(upsertCachedBills(c.env, cacheRows));
      }

      return c.json(
        {
          bills: normalizedBills,
          count: pages.totalCount,
          pagination: {
            offset,
            limit,
            count: pages.totalCount,
            hasMore:
              pages.totalCount != null
                ? offset + limit < pages.totalCount
                : normalizedBills.length === limit,
          },
        },
        200,
        { "Cache-Control": "public, max-age=1800" }
      );
    }

    const matchedBills: Array<ReturnType<typeof normalizeBillForList>> = [];
    const cacheRowsToUpsert: Array<Record<string, unknown>> = [];
    let scannedCount = 0;
    let metadataFetches = 0;
    let truncatedForBudget = false;

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
        .filter((entry) =>
          billMatchesSummaryFilters(entry.normalized, status, search, startDate, endDate)
        );

      const resolvedCandidates = hasMetadataFilters
        ? await mapInBatches(summaryCandidates, 5, async (entry) => {
            if (billMatchesMetadataFilters(entry.normalized, sponsorParty, sponsor, committee)) {
              return entry.normalized;
            }

            const identity = getBillIdentity(entry.rawBill);
            if (!identity) return null;
            if (metadataFetches >= BILL_METADATA_FETCH_BUDGET) {
              truncatedForBudget = true;
              return null;
            }
            metadataFetches += 1;

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
        matchedBills.push(bill);
      }

      if (truncatedForBudget || !data.pagination?.next || pageBills.length < BILL_SCAN_PAGE_SIZE) {
        break;
      }
    }

    if (cacheRowsToUpsert.length > 0) {
      c.executionCtx.waitUntil(upsertCachedBills(c.env, cacheRowsToUpsert));
    }

    matchedBills.sort((left, right) => compareNormalizedBills(left, right, sort));
    const pagedBills = matchedBills.slice(offset, offset + limit);
    const matchedCount = matchedBills.length;

    return c.json(
      {
        bills: pagedBills,
        count: truncatedForBudget ? undefined : matchedCount,
        notice: truncatedForBudget
          ? "Filtered results were capped to stay within production runtime limits. Browse further or warm the bill cache for broader sponsor and committee searches."
          : undefined,
        pagination: {
          offset,
          limit,
          count: truncatedForBudget ? undefined : matchedCount,
          hasMore: truncatedForBudget || offset + limit < matchedCount,
          filtered: true,
          scanned: scannedCount,
        },
      },
      200,
      { "Cache-Control": "public, max-age=600" }
    );
  } catch (error) {
    if (error instanceof FetchTimeoutError) {
      return c.json({ error: error.message }, 504);
    }
    console.error("Congress bills fetch failed", {
      congress: congress_num,
      billType,
      limit,
      offset,
      sort,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "Failed to fetch from Congress API" }, 502);
  }
});

// ── GET /api/congress/bills/:congress/:type/:number ──────────────────────────
congress.get("/bills/:congress/:type/:number", async (c) => {
  const apiKey = c.env.CONGRESS_API_KEY;
  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  const { congress: cong, type, number } = c.req.param();
  const path = `/bill/${cong}/${type}/${number}`;
  const congressNum = Number.parseInt(cong, 10);
  const billNumber = Number.parseInt(number, 10);
  const normalizedType = type.toLowerCase();

  if (hasSupabase(c.env)) {
    try {
      const sb = getSupabase(c.env);
      const { data, error } = await sb
        .from("bill_details_cache")
        .select("payload, updated_at")
        .eq("congress", congressNum)
        .eq("bill_type", normalizedType)
        .eq("bill_number", billNumber)
        .maybeSingle<{ payload: unknown; updated_at: string | null }>();
      if (!error && data?.payload) {
        if (isTimestampStale(data.updated_at, BILLS_CACHE_STALE_MS)) {
          queueBillPayloadRefresh(
            c.executionCtx,
            c.env,
            apiKey,
            "bill_details_cache",
            path,
            congressNum,
            normalizedType,
            billNumber
          );
        }
        return c.json(data.payload, 200, { "Cache-Control": "public, max-age=1800" });
      }
    } catch {
      // Fall through to live fetch.
    }
  }

  try {
    const live = await fetchBillPayloadAndCache(
      c.env,
      apiKey,
      "bill_details_cache",
      path,
      congressNum,
      normalizedType,
      billNumber
    );
    if (!live.ok) {
      return c.json({ error: `Congress API: ${live.status}` }, 502);
    }
    const data = live.data as CongressBillDetailResponse;

    if (data.bill) {
      const committeeNames = await fetchCongressBillCommittees(apiKey, congressNum, type, billNumber).catch(
        () => []
      );
      const cacheRow = toBillCacheRow(data.bill, committeeNames);
      if (cacheRow) {
        c.executionCtx.waitUntil(upsertCachedBills(c.env, [cacheRow]));
      }
    }

    return c.json(data, 200, { "Cache-Control": "public, max-age=1800" });
  } catch (error) {
    if (error instanceof FetchTimeoutError) {
      return c.json({ error: error.message }, 504);
    }
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
  const congressNum = Number.parseInt(cong, 10);
  const billNumber = Number.parseInt(number, 10);
  const normalizedType = type.toLowerCase();
  const params = { limit: String(limit), offset: String(offset) };

  if (hasSupabase(c.env)) {
    try {
      const sb = getSupabase(c.env);
      const { data, error } = await sb
        .from("bill_cosponsors_cache")
        .select("payload, updated_at")
        .eq("congress", congressNum)
        .eq("bill_type", normalizedType)
        .eq("bill_number", billNumber)
        .maybeSingle<{ payload: unknown; updated_at: string | null }>();
      if (!error && data?.payload) {
        if (isTimestampStale(data.updated_at, BILLS_CACHE_STALE_MS)) {
          queueBillPayloadRefresh(
            c.executionCtx,
            c.env,
            apiKey,
            "bill_cosponsors_cache",
            `/bill/${cong}/${type}/${number}/cosponsors`,
            congressNum,
            normalizedType,
            billNumber,
            params
          );
        }
        return c.json(data.payload, 200, { "Cache-Control": "public, max-age=1800" });
      }
    } catch {
      // Fall through to live fetch.
    }
  }

  try {
    const live = await fetchBillPayloadAndCache(
      c.env,
      apiKey,
      "bill_cosponsors_cache",
      `/bill/${cong}/${type}/${number}/cosponsors`,
      congressNum,
      normalizedType,
      billNumber,
      params
    );
    if (!live.ok) {
      return c.json({ error: `Congress API: ${live.status}` }, 502);
    }
    return c.json(live.data, 200, { "Cache-Control": "public, max-age=1800" });
  } catch (error) {
    if (error instanceof FetchTimeoutError) {
      return c.json({ error: error.message }, 504);
    }
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
  const congressNum = Number.parseInt(cong, 10);
  const billNumber = Number.parseInt(number, 10);
  const normalizedType = type.toLowerCase();
  const params = { limit: String(limit), offset: String(offset) };

  if (hasSupabase(c.env)) {
    try {
      const sb = getSupabase(c.env);
      const { data, error } = await sb
        .from("bill_actions_cache")
        .select("payload, updated_at")
        .eq("congress", congressNum)
        .eq("bill_type", normalizedType)
        .eq("bill_number", billNumber)
        .maybeSingle<{ payload: unknown; updated_at: string | null }>();
      if (!error && data?.payload) {
        if (isTimestampStale(data.updated_at, BILLS_CACHE_STALE_MS)) {
          queueBillPayloadRefresh(
            c.executionCtx,
            c.env,
            apiKey,
            "bill_actions_cache",
            `/bill/${cong}/${type}/${number}/actions`,
            congressNum,
            normalizedType,
            billNumber,
            params
          );
        }
        return c.json(data.payload, 200, { "Cache-Control": "public, max-age=1800" });
      }
    } catch {
      // Fall through to live fetch.
    }
  }

  try {
    const live = await fetchBillPayloadAndCache(
      c.env,
      apiKey,
      "bill_actions_cache",
      `/bill/${cong}/${type}/${number}/actions`,
      congressNum,
      normalizedType,
      billNumber,
      params
    );
    if (!live.ok) {
      return c.json({ error: `Congress API: ${live.status}` }, 502);
    }
    return c.json(live.data, 200, { "Cache-Control": "public, max-age=1800" });
  } catch (error) {
    if (error instanceof FetchTimeoutError) {
      return c.json({ error: error.message }, 504);
    }
    return c.json({ error: "Failed to fetch from Congress API" }, 502);
  }
});

export { congress };
