import { Hono } from "hono";
import type { Env } from "../types";
import { summarizeMemberVotes, type MemberVoteRecord } from "../lib/member-votes";
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function congressFetchWithRetry(
  path: string,
  apiKey: string,
  params?: Record<string, string>,
  attempts = 3
): Promise<Response> {
  let lastResponse: Response | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await congressFetch(path, apiKey, params);
      lastResponse = response;
      if (
        response.ok ||
        ![408, 429, 500, 502, 503, 504].includes(response.status) ||
        attempt === attempts - 1
      ) {
        return response;
      }
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) break;
    }

    await sleep(250 * (attempt + 1));
  }

  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error("Congress API request failed");
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
        .from("members")
        .select("bioguide_id,name,direct_order_name,party,state,chamber,congress")
        .eq("congress", congress)
        .eq("chamber", "Senate");

      if (!error && data?.length) {
        return data.map((row) => {
          const displayName = row.direct_order_name ?? row.name ?? row.bioguide_id;
          const normalizedDisplay = displayName.replace(/\s+/g, " ").trim();
          const parts = normalizedDisplay.split(" ");
          return {
            bioguideId: row.bioguide_id,
            firstName: parts[0] ?? "",
            lastName: parts.slice(1).join(" ") || parts[0] || "",
            fullName: normalizedDisplay,
            party: normalizePartyValue(row.party),
            stateCode: null,
            stateName: row.state ?? null,
          };
        });
      }
    } catch {
      // Fall through to live member list.
    }
  }

  const members = normalizeCongressMembers(await fetchAllCongressMembers(apiKey, String(congress)));
  return members
    .filter((member) => extractMemberChamber(member) === "Senate" && member.bioguideId)
    .map((member) => {
      const rawName = member.name?.replace(/\s+/g, " ").trim() ?? "";
      const [lastNameRaw, firstNameRaw] = rawName.split(",").map((part) => part.trim());
      return {
        bioguideId: member.bioguideId!,
        firstName: firstNameRaw ?? "",
        lastName: lastNameRaw ?? rawName,
        fullName: member.directOrderName ?? member.name ?? member.bioguideId!,
        party: normalizePartyValue(member.party),
        stateCode: null,
        stateName: typeof member.state === "string" ? member.state : null,
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
  const stateCode = member.state?.trim().toUpperCase() ?? null;
  const stateName = stateCode ? (STATE_NAME_BY_CODE[stateCode] ?? null) : null;
  const party = normalizePartyValue(member.party);
  const firstName = normalizePersonName(member.firstName);
  const lastName = normalizePersonName(member.lastName);
  const fullName = normalizePersonName(member.fullName);

  const matches = senators.filter((senator) => {
    if (party && senator.party && party !== senator.party) return false;
    if (stateName && senator.stateName && stateName !== senator.stateName) return false;

    const senatorFirst = normalizePersonName(senator.firstName);
    const senatorLast = normalizePersonName(senator.lastName);
    const senatorFull = normalizePersonName(senator.fullName);

    if (lastName && senatorLast !== lastName && !senatorFull.includes(lastName)) return false;
    if (firstName && senatorFirst && !senatorFirst.startsWith(firstName)) return false;
    if (fullName && !senatorFull.includes(lastName || fullName.split(" ").slice(-1)[0] || "")) return false;

    return true;
  });

  if (matches.length === 1) return matches[0].bioguideId;
  return null;
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

type CongressMemberDetailResponse = {
  member?: {
    bioguideId?: string;
    directOrderName?: string;
    terms?: CongressMemberDetailTerm[] | { item?: CongressMemberDetailTerm[] };
  };
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
  const currentTerm = member.terms?.item?.[0];
  const chamber =
    typeof currentTerm?.chamber === "string"
      ? currentTerm.chamber
      : typeof member.chamber === "string"
        ? member.chamber
        : null;

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

async function fetchMemberDetailSummary(
  apiKey: string,
  bioguideId: string
): Promise<{
  directOrderName?: string;
  chamber?: string | null;
  firstCongress?: number | null;
  lastCongress?: number | null;
  totalTerms?: number;
  congressesServed?: number | null;
  yearsServed?: number | null;
} | null> {
  try {
    const resp = await congressFetchWithRetry(`/member/${bioguideId}`, apiKey);
    if (!resp.ok) return null;

    const data = (await resp.json()) as CongressMemberDetailResponse;
    if (!data.member) return null;

    const summary = summarizeMemberTerms(data.member.terms);
    return {
      directOrderName: data.member.directOrderName,
      chamber: summary.chamber,
      firstCongress: summary.firstCongress,
      lastCongress: summary.lastCongress,
      totalTerms: summary.totalTerms,
      congressesServed: summary.congressesServed ?? summary.totalTerms,
      yearsServed: summary.yearsServed,
    };
  } catch {
    return null;
  }
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
          direct_order_name:
            typeof m.directOrderName === "string" ? m.directOrderName : null,
          party: m.party ?? null,
          state: m.state ?? null,
          district: m.district ?? null,
          chamber: extractMemberChamber(m) ?? null,
          image_url: normalizeMemberImageUrl(m.depiction?.imageUrl) ?? null,
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
          direct_order_name:
            typeof m.directOrderName === "string" ? m.directOrderName : null,
          party: m.party ?? null,
          state: m.state ?? null,
          district: m.district ?? null,
          chamber: extractMemberChamber(m) ?? null,
          image_url: normalizeMemberImageUrl(m.depiction?.imageUrl) ?? null,
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

// ── GET /api/congress/members/browse ─────────────────────────────────────────
// Browse members from Supabase cache first so the UI can filter/sort locally.
congress.get("/members/browse", async (c) => {
  const currentCongress = parseBoundedInt(c.req.query("congress"), 119, 1, 999);
  const apiKey = c.env.CONGRESS_API_KEY;

  if (hasSupabase(c.env)) {
    try {
      const sb = getSupabase(c.env);
      const [membersRes, statsRes] = await Promise.all([
        sb
          .from("members")
          .select(
            "bioguide_id,name,direct_order_name,party,state,district,chamber,image_url,congress,first_congress,last_congress,total_terms,congresses_served,years_served"
          )
          .eq("congress", currentCongress)
          .order("name", { ascending: true }),
        sb
          .from("member_vote_stats")
          .select("bioguide_id,first_congress,last_congress,house_votes,senate_votes"),
      ]);

      if (membersRes.error) throw membersRes.error;
      if (statsRes.error) throw statsRes.error;

      const statsById = new Map(
        (statsRes.data ?? []).map((row) => [row.bioguide_id, row])
      );
      const rows = membersRes.data ?? [];

      // Members browse must stay cache-only in production. It is a small, mostly static
      // dataset, and adding per-member Congress.gov hydration here has repeatedly pushed
      // the deployed Worker beyond the Pages proxy timeout.
      const members = rows.map((row) => {
        const stats = statsById.get(row.bioguide_id);
        const chamber = inferMemberChamber({
          chamber: normalizeChamberLabel(row.chamber) ?? row.chamber,
          district: row.district,
          houseVotes: stats?.house_votes ?? null,
          senateVotes: stats?.senate_votes ?? null,
        });
        const firstCongress =
          row.first_congress ??
          stats?.first_congress ??
          row.congress ??
          null;
        const lastCongress =
          row.last_congress ??
          stats?.last_congress ??
          row.congress ??
          null;
        const congressesServed = deriveCongressesServed({
          congressesServed: row.congresses_served,
          totalTerms: row.total_terms,
          firstCongress,
          lastCongress,
        });

        return {
          bioguideId: row.bioguide_id,
          name: row.name,
          directOrderName: row.direct_order_name,
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
        };
      });

      if (members.length > 0) {
        return c.json(
          { members, count: members.length, source: "supabase_cache" },
          200,
          { "Cache-Control": "public, max-age=300" }
        );
      }
    } catch {
      // Fall through to live fetch.
    }
  }

  if (!apiKey) return c.json({ error: "Congress API key not configured" }, 500);

  try {
    const normalizedMembers = normalizeCongressMembers(
      await fetchAllCongressMembers(apiKey, String(currentCongress))
    );
    const detailResults = await mapInBatches(
      normalizedMembers.filter((member) => !!member.bioguideId),
      10,
      async (member) => ({
        bioguideId: member.bioguideId!,
        detail: await fetchMemberDetailSummary(apiKey, member.bioguideId!),
      })
    );
    const detailSummaries = new Map(
      detailResults.map((result) => [result.bioguideId, result.detail])
    );

    const members = normalizedMembers.map((member) => {
      const detail = member.bioguideId ? detailSummaries.get(member.bioguideId) : null;
      const firstCongress = detail?.firstCongress ?? currentCongress;
      const lastCongress = detail?.lastCongress ?? currentCongress;

        return {
          bioguideId: member.bioguideId,
          name: member.name,
        directOrderName:
          detail?.directOrderName ??
          (typeof member.directOrderName === "string" ? member.directOrderName : undefined),
        party: member.party,
        state: member.state,
        district: member.district,
        chamber:
          detail?.chamber ??
          extractMemberChamber(member) ??
          inferMemberChamber(member),
          depiction: member.depiction,
          firstCongress,
          lastCongress,
          congressesServed:
            detail?.congressesServed ??
            detail?.totalTerms ??
            Math.max(1, lastCongress - firstCongress + 1),
        };
      });

    return c.json(
      { members, count: members.length, source: "congress_live" },
      200,
      { "Cache-Control": "public, max-age=300" }
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

      if (hasSupabase(c.env)) {
        const summary = summarizeMemberTerms(data.member.terms);
        const sb = getSupabase(c.env);
        const directOrderName =
          typeof data.member.directOrderName === "string" ? data.member.directOrderName : null;
        const chamber = normalizeChamberLabel(summary.chamber);
        const congressesServed = deriveCongressesServed({
          congressesServed: summary.congressesServed,
          totalTerms: summary.totalTerms,
          firstCongress: summary.firstCongress,
          lastCongress: summary.lastCongress,
        });

        c.executionCtx.waitUntil(
          Promise.resolve(
            sb
              .from("members")
              .update({
                direct_order_name: directOrderName,
                chamber,
                first_congress: summary.firstCongress,
                last_congress: summary.lastCongress,
                total_terms: summary.totalTerms,
                congresses_served: congressesServed,
                years_served: summary.yearsServed,
                updated_at: new Date().toISOString(),
              })
              .eq("bioguide_id", bioguideId)
          )
        );
      }
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

  const sessions = requestedSession && /^(1|2)$/.test(requestedSession)
    ? [requestedSession, ...(requestedSession === "1" ? ["2"] : ["1"])]
    : ["2", "1"];

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
              members = extractVoteMembersFromResponse(membersData);
            }
          } catch {
            // Best-effort: summary data is still useful without member rows.
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
  const memberVotes: MemberVoteRecord[] = [];

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
            position: memberVote.votePosition ?? "Unknown",
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
  const requiresScan = hasSummaryFilters || hasMetadataFilters;

  try {
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
