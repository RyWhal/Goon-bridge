import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./db-types";

type DbClient = SupabaseClient;

type JsonRecord = Record<string, unknown>;

type OrganizationRow = Database["public"]["Tables"]["organizations"]["Row"];
type RelationshipFactInsert = Database["public"]["Tables"]["relationship_facts"]["Insert"];
type CorrelationCaseInsert = Database["public"]["Tables"]["correlation_cases"]["Insert"];
const CORRELATION_WINDOW_DAYS = 45;

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

const STATE_CODE_BY_NAME: Record<string, string> = {
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

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toDateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function toDateOnlyEpochMs(value: string | null | undefined): number | null {
  const dateOnly = toDateOnly(value);
  if (!dateOnly) return null;
  const parsed = Date.parse(`${dateOnly}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function getDateDistanceDays(left: string | null | undefined, right: string | null | undefined): number | null {
  const leftTime = toDateOnlyEpochMs(left);
  const rightTime = toDateOnlyEpochMs(right);
  if (leftTime == null || rightTime == null) return null;
  return Math.abs(Math.round((leftTime - rightTime) / 86_400_000));
}

function buildSourceCoveragePatch(current: unknown, patch: Record<string, boolean>) {
  const existing = current && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, boolean>
    : {};
  return { ...existing, ...patch };
}

export function normalizeOrganizationName(value: string): string {
  const upper = value
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!upper) return "";

  const parts = upper.split(" ").filter(Boolean);
  while (parts.length > 1 && ORG_SUFFIXES.has(parts[parts.length - 1])) {
    parts.pop();
  }
  return parts.join(" ");
}

async function getOrganizationById(sb: DbClient, organizationId: number): Promise<OrganizationRow | null> {
  const { data, error } = await sb.from("organizations").select("*").eq("id", organizationId).maybeSingle();
  if (error) throw new Error(`Failed to read organization ${organizationId}: ${error.message}`);
  return data;
}

export async function resolveOrganizationId(
  sb: DbClient,
  {
    name,
    ticker,
    identifiers = [],
  }: {
    name?: string | null;
    ticker?: string | null;
    identifiers?: Array<{ sourceType: string; identifierType: string; identifierValue: string | null | undefined }>;
  }
): Promise<number | null> {
  const cleanedTicker = asString(ticker)?.toUpperCase() ?? null;

  for (const identifier of identifiers) {
    const value = asString(identifier.identifierValue);
    if (!value) continue;
    const { data, error } = await sb
      .from("organization_identifiers")
      .select("organization_id")
      .eq("source_type", identifier.sourceType)
      .eq("identifier_type", identifier.identifierType)
      .eq("identifier_value", value)
      .maybeSingle();

    if (error) throw new Error(`Failed to resolve organization identifier: ${error.message}`);
    if (data?.organization_id != null) return data.organization_id;
  }

  if (cleanedTicker) {
    const { data, error } = await sb
      .from("organizations")
      .select("id")
      .eq("ticker", cleanedTicker)
      .maybeSingle();
    if (error) throw new Error(`Failed to resolve organization ticker: ${error.message}`);
    if (data?.id != null) return data.id;
  }

  const normalizedName = asString(name) ? normalizeOrganizationName(name!) : "";
  if (!normalizedName) return null;

  const [{ data: aliasData, error: aliasError }, { data: orgData, error: orgError }] = await Promise.all([
    sb
      .from("organization_aliases")
      .select("organization_id")
      .eq("normalized_alias", normalizedName)
      .maybeSingle(),
    sb
      .from("organizations")
      .select("id")
      .eq("normalized_name", normalizedName)
      .maybeSingle(),
  ]);

  if (aliasError) throw new Error(`Failed to resolve organization alias: ${aliasError.message}`);
  if (orgError) throw new Error(`Failed to resolve organization name: ${orgError.message}`);

  return aliasData?.organization_id ?? orgData?.id ?? null;
}

export async function ensureOrganization(
  sb: DbClient,
  {
    canonicalName,
    ticker,
    aliasSourceType,
    aliasSourceRowId,
    identifiers = [],
    sourceCoverage = {},
  }: {
    canonicalName: string;
    ticker?: string | null;
    aliasSourceType: string;
    aliasSourceRowId?: string | null;
    identifiers?: Array<{ sourceType: string; identifierType: string; identifierValue: string | null | undefined }>;
    sourceCoverage?: Record<string, boolean>;
  }
): Promise<OrganizationRow> {
  const normalizedName = normalizeOrganizationName(canonicalName);
  if (!normalizedName) {
    throw new Error("Cannot create an organization without a normalizable name");
  }

  const cleanedTicker = asString(ticker)?.toUpperCase() ?? null;
  const existingId = await resolveOrganizationId(sb, {
    name: canonicalName,
    ticker: cleanedTicker,
    identifiers,
  });

  let organization: OrganizationRow | null = existingId != null ? await getOrganizationById(sb, existingId) : null;

  if (!organization) {
    const { data, error } = await sb
      .from("organizations")
      .insert({
        canonical_name: canonicalName,
        normalized_name: normalizedName,
        ticker: cleanedTicker,
        source_coverage: sourceCoverage,
      })
      .select("*")
      .single();

    if (error) throw new Error(`Failed to create organization '${canonicalName}': ${error.message}`);
    organization = data;
  } else {
    const nextCoverage = buildSourceCoveragePatch(organization.source_coverage, sourceCoverage);
    const { data, error } = await sb
      .from("organizations")
      .update({
        canonical_name: organization.canonical_name || canonicalName,
        ticker: organization.ticker ?? cleanedTicker,
        source_coverage: nextCoverage,
        updated_at: new Date().toISOString(),
      })
      .eq("id", organization.id)
      .select("*")
      .single();

    if (error) throw new Error(`Failed to update organization '${canonicalName}': ${error.message}`);
    organization = data;
  }

  if (!organization) {
    throw new Error(`Organization '${canonicalName}' could not be resolved after upsert`);
  }

  const aliasPayloads = [
    {
      organization_id: organization.id,
      alias: canonicalName,
      normalized_alias: normalizedName,
      source_type: aliasSourceType,
      source_row_id: aliasSourceRowId ?? null,
      updated_at: new Date().toISOString(),
    },
  ];

  const { error: aliasError } = await sb.from("organization_aliases").upsert(aliasPayloads, {
    onConflict: "normalized_alias",
  });
  if (aliasError) throw new Error(`Failed to upsert organization alias '${canonicalName}': ${aliasError.message}`);

  const identifierPayloads = identifiers
    .map((identifier) => {
      const value = asString(identifier.identifierValue);
      if (!value) return null;
      return {
        organization_id: organization!.id,
        source_type: identifier.sourceType,
        identifier_type: identifier.identifierType,
        identifier_value: value,
        updated_at: new Date().toISOString(),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => !!entry);

  if (identifierPayloads.length) {
    const { error: identifierError } = await sb.from("organization_identifiers").upsert(identifierPayloads, {
      onConflict: "source_type,identifier_type,identifier_value",
    });
    if (identifierError) {
      throw new Error(`Failed to upsert organization identifiers for '${canonicalName}': ${identifierError.message}`);
    }
  }

  return organization;
}

export async function refreshOrganizationsFromContributions(
  sb: DbClient,
  options?: { bioguideId?: string | null; candidateId?: string | null; limit?: number }
) {
  const limit = Math.max(1, Math.min(options?.limit ?? 500, 2000));
  let query = sb
    .from("contributions")
    .select("id,candidate_id,contributor_employer,updated_at")
    .not("contributor_employer", "is", null)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (options?.candidateId) {
    query = query.eq("candidate_id", options.candidateId);
  } else if (options?.bioguideId) {
    const { data: fecRows, error: fecError } = await sb
      .from("fec_candidates")
      .select("candidate_id")
      .eq("bioguide_id", options.bioguideId);
    if (fecError) throw new Error(`Failed to resolve candidate IDs for organization refresh: ${fecError.message}`);
    const candidateIds = (fecRows ?? []).map((row) => row.candidate_id).filter(Boolean);
    if (!candidateIds.length) return { processed: 0, organizations: 0 };
    query = query.in("candidate_id", candidateIds);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load contributions for organization refresh: ${error.message}`);

  let processed = 0;
  const organizationIds = new Set<number>();

  for (const contribution of data ?? []) {
    const employer = asString(contribution.contributor_employer);
    if (!employer) continue;
    const organization = await ensureOrganization(sb, {
      canonicalName: employer,
      aliasSourceType: "contribution_employer",
      aliasSourceRowId: String(contribution.id),
      sourceCoverage: { contributions: true },
    });
    organizationIds.add(organization.id);
    processed += 1;
  }

  return { processed, organizations: organizationIds.size };
}

type FinnhubLobbyingRecord = {
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
  chambers?: string[];
};

type FinnhubContractRecord = {
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
};

async function upsertOrganizationFactsForOrg(sb: DbClient, organizationId: number) {
  const [{ data: lobbyingRows, error: lobbyingError }, { data: contractRows, error: contractError }] = await Promise.all([
    sb
      .from("organization_lobbying_filings")
      .select("id,dt_posted,filing_type,symbol,name,description,client_id,registrant_id,document_url")
      .eq("organization_id", organizationId),
    sb
      .from("organization_contract_awards")
      .select("id,action_date,total_value,recipient_name,recipient_parent_name,awarding_agency_name,awarding_sub_agency_name,awarding_office_name,award_description,permalink")
      .eq("organization_id", organizationId),
  ]);

  if (lobbyingError) throw new Error(`Failed to load lobbying filings for organization ${organizationId}: ${lobbyingError.message}`);
  if (contractError) throw new Error(`Failed to load contract awards for organization ${organizationId}: ${contractError.message}`);

  const factRows: RelationshipFactInsert[] = [];

  for (const row of lobbyingRows ?? []) {
    factRows.push({
      organization_id: organizationId,
      fact_type: "ORG_LOBBIED",
      related_entity_type: "lobbying_filing",
      related_entity_id: String(row.id),
      fact_date: row.dt_posted,
      source_table: "organization_lobbying_filings",
      source_row_id: String(row.id),
      evidence_payload: {
        filingType: row.filing_type,
        symbol: row.symbol,
        name: row.name,
        description: row.description,
        clientId: row.client_id,
        registrantId: row.registrant_id,
        documentUrl: row.document_url,
      },
    });
  }

  for (const row of contractRows ?? []) {
    factRows.push({
      organization_id: organizationId,
      fact_type: "ORG_HAS_CONTRACT",
      related_entity_type: "contract_award",
      related_entity_id: String(row.id),
      fact_date: row.action_date,
      source_table: "organization_contract_awards",
      source_row_id: String(row.id),
      evidence_payload: {
        totalValue: row.total_value,
        recipientName: row.recipient_name,
        recipientParentName: row.recipient_parent_name,
        awardingAgencyName: row.awarding_agency_name,
        awardingSubAgencyName: row.awarding_sub_agency_name,
        awardingOfficeName: row.awarding_office_name,
        awardDescription: row.award_description,
        permalink: row.permalink,
      },
    });
  }

  const { error: deleteError } = await sb
    .from("relationship_facts")
    .delete()
    .eq("organization_id", organizationId)
    .in("fact_type", ["ORG_LOBBIED", "ORG_HAS_CONTRACT"]);
  if (deleteError) throw new Error(`Failed to clear organization facts for ${organizationId}: ${deleteError.message}`);

  if (factRows.length) {
    const { error: insertError } = await sb.from("relationship_facts").insert(factRows);
    if (insertError) throw new Error(`Failed to insert organization facts for ${organizationId}: ${insertError.message}`);
  }
}

export async function persistFinnhubActivity(
  sb: DbClient,
  {
    symbol,
    lobbyingRecords,
    contractRecords,
  }: {
    symbol: string;
    lobbyingRecords?: FinnhubLobbyingRecord[];
    contractRecords?: FinnhubContractRecord[];
  }
) {
  const normalizedSymbol = symbol.trim().toUpperCase();
  let organization: OrganizationRow | null = null;

  const possibleNames = [
    ...(lobbyingRecords ?? []).map((record) => asString(record.name)).filter((value): value is string => !!value),
    ...(contractRecords ?? [])
      .flatMap((record) => [asString(record.recipientParentName), asString(record.recipientName)])
      .filter((value): value is string => !!value),
  ];

  const canonicalName = possibleNames[0] ?? normalizedSymbol;

  organization = await ensureOrganization(sb, {
    canonicalName,
    ticker: normalizedSymbol,
    aliasSourceType: "ticker",
    aliasSourceRowId: normalizedSymbol,
    identifiers: [
      {
        sourceType: "ticker",
        identifierType: "symbol",
        identifierValue: normalizedSymbol,
      },
    ],
    sourceCoverage: {
      lobbying: (lobbyingRecords?.length ?? 0) > 0,
      contracts: (contractRecords?.length ?? 0) > 0,
    },
  });

  const lobbyingPayloads = (lobbyingRecords ?? []).map((record, index) => {
    const name = asString(record.name) ?? canonicalName;
    const sourceRowKey = [
      normalizedSymbol,
      asString(record.uuid) ?? "",
      toDateOnly(record.dtPosted) ?? "",
      String(record.year ?? ""),
      record.period ?? "",
      String(index),
    ].join(":");

    return {
      organization_id: organization!.id,
      ticker: normalizedSymbol,
      symbol: normalizedSymbol,
      filing_uuid: asString(record.uuid),
      source_row_key: sourceRowKey,
      name,
      normalized_name: normalizeOrganizationName(name),
      description: asString(record.description),
      country: asString(record.country),
      year: record.year ?? null,
      period: asString(record.period),
      filing_type: asString(record.type),
      document_url: asString(record.documentUrl),
      income: asNumber(record.income),
      expenses: asNumber(record.expenses),
      posted_name: asString(record.postedName),
      dt_posted: toDateOnly(record.dtPosted),
      client_id: asString(record.clientId),
      registrant_id: asString(record.registrantId),
      senate_id: asString(record.senateId),
      house_registrant_id: asString(record.houseRegistrantId),
      chambers: Array.isArray(record.chambers) ? record.chambers : [],
      raw_payload: record as JsonRecord,
      updated_at: new Date().toISOString(),
    };
  });

  const contractPayloads = (contractRecords ?? []).map((record, index) => {
    const recipient = asString(record.recipientParentName) ?? asString(record.recipientName) ?? canonicalName;
    const sourceRowKey = [
      normalizedSymbol,
      recipient,
      toDateOnly(record.actionDate) ?? "",
      asString(record.permalink) ?? "",
      String(index),
    ].join(":");

    return {
      organization_id: organization!.id,
      ticker: normalizedSymbol,
      symbol: normalizedSymbol,
      source_row_key: sourceRowKey,
      recipient_name: asString(record.recipientName),
      recipient_parent_name: asString(record.recipientParentName),
      normalized_recipient_name: normalizeOrganizationName(recipient),
      normalized_parent_name: asString(record.recipientParentName)
        ? normalizeOrganizationName(record.recipientParentName!)
        : null,
      country: asString(record.country),
      total_value: asNumber(record.totalValue),
      action_date: toDateOnly(record.actionDate),
      performance_start_date: toDateOnly(record.performanceStartDate),
      performance_end_date: toDateOnly(record.performanceEndDate),
      awarding_agency_name: asString(record.awardingAgencyName),
      awarding_sub_agency_name: asString(record.awardingSubAgencyName),
      awarding_office_name: asString(record.awardingOfficeName),
      performance_country: asString(record.performanceCountry),
      performance_city: asString(record.performanceCity),
      performance_county: asString(record.performanceCounty),
      performance_state: asString(record.performanceState),
      performance_zip_code: asString(record.performanceZipCode),
      performance_congressional_district: asString(record.performanceCongressionalDistrict),
      award_description: asString(record.awardDescription),
      naics_code: asString(record.naicsCode),
      permalink: asString(record.permalink),
      raw_payload: record as JsonRecord,
      updated_at: new Date().toISOString(),
    };
  });

  if (lobbyingPayloads.length) {
    const { error } = await sb.from("organization_lobbying_filings").upsert(lobbyingPayloads, {
      onConflict: "source_row_key",
    });
    if (error) throw new Error(`Failed to persist lobbying filings for ${normalizedSymbol}: ${error.message}`);
  }

  if (contractPayloads.length) {
    const { error } = await sb.from("organization_contract_awards").upsert(contractPayloads, {
      onConflict: "source_row_key",
    });
    if (error) throw new Error(`Failed to persist contract awards for ${normalizedSymbol}: ${error.message}`);
  }

  await upsertOrganizationFactsForOrg(sb, organization.id);

  return {
    organizationId: organization.id,
    lobbyingCount: lobbyingPayloads.length,
    contractCount: contractPayloads.length,
  };
}

type CommitteeAssignmentRecord = {
  committeeCode: string | null;
  committeeName: string;
  role: string | null;
  chamber: string | null;
  congress: number | null;
  rawPayload: JsonRecord;
  subcommittees: Array<{
    subcommitteeCode: string | null;
    subcommitteeName: string;
    role: string | null;
    rawPayload: JsonRecord;
  }>;
};

type MemberCommitteeSourceContext = {
  bioguideId: string;
  memberName: string;
  directOrderName?: string | null;
  state?: string | null;
  chamber?: string | null;
  congress?: number | null;
};

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&rsquo;|&#8217;/gi, "'")
    .replace(/&ndash;|&#8211;/gi, "-")
    .replace(/&mdash;|&#8212;/gi, "-")
    .replace(/&eacute;/gi, "e")
    .replace(/&aacute;/gi, "a")
    .replace(/&uuml;/gi, "u")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, num: string) =>
      String.fromCharCode(Number.parseInt(num, 10))
    );
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePersonName(value: string): string {
  return decodeHtmlEntities(value)
    .toUpperCase()
    .replace(/\b(MR|MRS|MS|REP|SEN|SENATOR|REPRESENTATIVE)\b/g, " ")
    .replace(/\b(JR|SR|II|III|IV)\b/g, " ")
    .replace(/[^A-Z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type PersonNameForm = {
  given: string | null;
  surname: string | null;
  tokens: string[];
};

function buildPersonNameForms(value: string): PersonNameForm[] {
  const decoded = decodeHtmlEntities(value)
    .toUpperCase()
    .replace(/\b(MR|MRS|MS|REP|SEN|SENATOR|REPRESENTATIVE)\b/g, " ")
    .replace(/\b(JR|SR|II|III|IV)\b/g, " ")
    .replace(/[^A-Z, ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const normalized = normalizePersonName(decoded);
  const tokens = normalized.split(" ").filter((token) => token.length > 1);
  if (!tokens.length) return [];

  const forms = new Map<string, PersonNameForm>();
  const addForm = (given: string | null, surname: string | null, nextTokens: string[]) => {
    const key = `${given ?? ""}|${surname ?? ""}|${nextTokens.join(" ")}`;
    forms.set(key, { given, surname, tokens: nextTokens });
  };

  addForm(tokens[0] ?? null, tokens[tokens.length - 1] ?? null, tokens);

  if (decoded.includes(",")) {
    const [rawSurname, rawRemainder] = decoded.split(",", 2);
    const surnameTokens = normalizePersonName(rawSurname ?? "").split(" ").filter((token) => token.length > 1);
    const givenTokens = normalizePersonName(rawRemainder ?? "").split(" ").filter((token) => token.length > 1);
    addForm(
      givenTokens[0] ?? null,
      surnameTokens[surnameTokens.length - 1] ?? null,
      [...surnameTokens, ...givenTokens]
    );
  }

  return [...forms.values()];
}

function parseRoleFromHtml(value: string): string | null {
  const roleMatch = value.match(/\(([^)]+)\)/);
  return roleMatch ? stripHtml(roleMatch[1]) : null;
}

function normalizeChamberFromMember(value?: string | null): "House" | "Senate" | null {
  const lower = (value ?? "").trim().toLowerCase();
  if (lower.includes("house")) return "House";
  if (lower.includes("senate")) return "Senate";
  return null;
}

function normalizeStateCode(value?: string | null): string | null {
  const normalized = decodeHtmlEntities(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  if (normalized.length === 2) return normalized;
  return STATE_CODE_BY_NAME[normalized] ?? null;
}

function memberNameMatchesSenateHeader(context: MemberCommitteeSourceContext, headerName: string, headerState: string | null) {
  const memberState = normalizeStateCode(context.state);
  const senateState = normalizeStateCode(headerState);
  if (memberState && senateState && memberState !== senateState) {
    return false;
  }

  const headerForms = buildPersonNameForms(headerName);
  const headerTokenSet = new Set(
    headerForms.flatMap((form) => form.tokens).filter(Boolean)
  );
  const candidates = [context.directOrderName, context.memberName]
    .filter((value): value is string => !!value)
    .flatMap(buildPersonNameForms);

  return candidates.some((candidate) => {
    if (candidate.tokens.length && candidate.tokens.every((token) => headerTokenSet.has(token))) {
      return true;
    }

    return headerForms.some((header) => {
      if (!candidate.surname || !header.surname || candidate.surname !== header.surname) {
        return false;
      }
      if (!candidate.given || !header.given) {
        return false;
      }
      if (candidate.given === header.given) {
        return true;
      }

      const minComparableLength = 3;
      return candidate.given.length >= minComparableLength
        && header.given.length >= minComparableLength
        && (
          candidate.given.startsWith(header.given)
          || header.given.startsWith(candidate.given)
        );
    });
  });
}

function parseHouseCommitteeAssignments(html: string, context: MemberCommitteeSourceContext): CommitteeAssignmentRecord[] {
  const sectionMatch = html.match(
    /<section class="subcommittees">[\s\S]*?<span class="library-h2">Committee and Subcommittee Assignments<\/span>[\s\S]*?<div class="col-md-12">([\s\S]*?)<hr \/>/i
  );
  if (!sectionMatch) return [];

  const sectionHtml = sectionMatch[1];
  const pattern = /<a class="library-committeePanel-subItems" href="\/Committees\/([A-Z0-9]+)"[^>]*>([^<]+)<\/a>\s*<ul class="library-list_ul">([\s\S]*?)<\/ul>/gi;
  const assignments: CommitteeAssignmentRecord[] = [];

  for (const match of sectionHtml.matchAll(pattern)) {
    const committeeCode = match[1] ?? null;
    const committeeName = stripHtml(match[2] ?? "");
    const subcommitteeHtml = match[3] ?? "";
    if (!committeeName) continue;

    const subcommittees = [...subcommitteeHtml.matchAll(/<li>\s*<a class="library-committeePanel-subItems" href="\/Committees\/([A-Z0-9]+)"[^>]*>([^<]+)<\/a>\s*<\/li>/gi)]
      .map((subMatch) => ({
        subcommitteeCode: subMatch[1] ?? null,
        subcommitteeName: stripHtml(subMatch[2] ?? ""),
        role: null,
        rawPayload: {
          hrefCode: subMatch[1] ?? null,
          name: stripHtml(subMatch[2] ?? ""),
          source: "clerk_house_member_profile",
        },
      }))
      .filter((entry) => !!entry.subcommitteeName);

    assignments.push({
      committeeCode,
      committeeName,
      role: null,
      chamber: "House",
      congress: context.congress ?? null,
      rawPayload: {
        hrefCode: committeeCode,
        name: committeeName,
        source: "clerk_house_member_profile",
      },
      subcommittees,
    });
  }

  return assignments;
}

function parseSenateCommitteeAssignments(html: string, context: MemberCommitteeSourceContext): CommitteeAssignmentRecord[] {
  const blockPattern = /<a name="([^"]+)">&nbsp;<\/a><a href="[^"]*">([^<]+)<\/a>\s*\(([A-Z])-([A-Z]{2})\)<\/div>/gi;
  let blockHtml: string | null = null;

  for (const match of html.matchAll(blockPattern)) {
    const headerName = stripHtml(match[2] ?? "");
    const headerState = match[4] ?? null;
    if (!memberNameMatchesSenateHeader(context, headerName, headerState)) {
      continue;
    }

    const matchText = match[0];
    const startIndex = match.index != null ? match.index + matchText.length : -1;
    if (startIndex < 0) continue;

    const nextDivider = html.indexOf('<hr width="100%"', startIndex);
    const nextAnchor = html.indexOf('<a name="', startIndex);
    const endCandidates = [nextDivider, nextAnchor].filter((value) => value >= 0);
    const endIndex = endCandidates.length ? Math.min(...endCandidates) : html.length;
    blockHtml = html.slice(startIndex, endIndex);
    break;
  }

  if (!blockHtml) return [];

  const assignments: CommitteeAssignmentRecord[] = [];
  const committeePattern = /<li[^>]*>\s*<strong><a href="\/general\/committee_membership\/committee_memberships_([A-Z0-9]+)\.htm">([\s\S]*?)<\/a>([\s\S]*?)<\/strong>\s*<ul[^>]*>([\s\S]*?)<\/ul>\s*<\/li>/gi;

  for (const match of blockHtml.matchAll(committeePattern)) {
    const committeeCode = match[1] ?? null;
    const committeeName = stripHtml(match[2] ?? "");
    const committeeRole = parseRoleFromHtml(match[3] ?? "");
    const subcommitteeHtml = match[4] ?? "";
    if (!committeeName) continue;

    const subcommittees = [...subcommitteeHtml.matchAll(/<li>([\s\S]*?)<\/li>/gi)]
      .map((subMatch) => {
        const raw = subMatch[1] ?? "";
        const subcommitteeName = stripHtml(raw);
        if (!subcommitteeName) return null;
        return {
          subcommitteeCode: null,
          subcommitteeName: subcommitteeName.replace(/\s+\((Chairman|Ranking)\)$/i, "").trim(),
          role: parseRoleFromHtml(raw),
          rawPayload: {
            name: subcommitteeName,
            source: "senate_committee_assignments",
          },
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => !!entry);

    assignments.push({
      committeeCode,
      committeeName: committeeName.replace(/\s+\((Chairman|Ranking)\)$/i, "").trim(),
      role: committeeRole,
      chamber: "Senate",
      congress: context.congress ?? null,
      rawPayload: {
        code: committeeCode,
        name: committeeName,
        role: committeeRole,
        source: "senate_committee_assignments",
      },
      subcommittees,
    });
  }

  return assignments;
}

export async function fetchOfficialCommitteeAssignments(
  context: MemberCommitteeSourceContext
): Promise<CommitteeAssignmentRecord[]> {
  const chamber = normalizeChamberFromMember(context.chamber);
  if (chamber === "House") {
    const response = await fetch(`https://clerk.house.gov/members/${context.bioguideId}`);
    if (!response.ok) {
      throw new Error(`House Clerk member profile returned ${response.status}`);
    }
    const html = await response.text();
    return parseHouseCommitteeAssignments(html, context);
  }

  if (chamber === "Senate") {
    const response = await fetch("https://www.senate.gov/general/committee_assignments/assignments.htm");
    if (!response.ok) {
      throw new Error(`Senate committee assignments page returned ${response.status}`);
    }
    const html = await response.text();
    return parseSenateCommitteeAssignments(html, context);
  }

  throw new Error("Member chamber could not be determined for committee assignment refresh");
}

function findArraysByLikelyKey(root: unknown, keyPattern: RegExp, depth = 0): JsonRecord[] {
  if (depth > 6 || !root || typeof root !== "object") return [];
  const record = root as JsonRecord;
  const found: JsonRecord[] = [];

  for (const [key, value] of Object.entries(record)) {
    if (keyPattern.test(key) && Array.isArray(value)) {
      found.push(...value.filter((entry): entry is JsonRecord => !!entry && typeof entry === "object"));
    } else if (value && typeof value === "object") {
      found.push(...findArraysByLikelyKey(value, keyPattern, depth + 1));
    }
  }

  return found;
}

function extractCommitteeName(record: JsonRecord): string | null {
  return asString(record.name)
    ?? asString(record.committeeName)
    ?? asString(record.displayName)
    ?? asString(record.title)
    ?? null;
}

function extractSubcommitteeName(record: JsonRecord): string | null {
  return asString(record.name)
    ?? asString(record.subcommitteeName)
    ?? asString(record.displayName)
    ?? asString(record.title)
    ?? null;
}

export function extractCommitteeAssignmentsFromMemberDetail(memberDetail: JsonRecord): CommitteeAssignmentRecord[] {
  const member = memberDetail.member && typeof memberDetail.member === "object"
    ? memberDetail.member as JsonRecord
    : memberDetail;

  const committeeCandidates = findArraysByLikelyKey(member, /committee/i).filter((entry) => {
    const name = extractCommitteeName(entry);
    return !!name && !/subcommittee/i.test(name);
  });

  const deduped = new Map<string, CommitteeAssignmentRecord>();

  for (const committee of committeeCandidates) {
    const committeeName = extractCommitteeName(committee);
    if (!committeeName) continue;
    const normalizedName = normalizeOrganizationName(committeeName);
    if (!normalizedName) continue;

    const subcommitteeEntries = [
      ...findArraysByLikelyKey(committee, /subcommittee/i),
      ...asArray(committee.subcommittees).filter((entry): entry is JsonRecord => !!entry && typeof entry === "object"),
    ];

    const subcommittees = subcommitteeEntries
      .map((subcommittee) => {
        const subcommitteeName = extractSubcommitteeName(subcommittee);
        if (!subcommitteeName) return null;
        return {
          subcommitteeCode: asString(subcommittee.systemCode) ?? asString(subcommittee.code),
          subcommitteeName,
          role: asString(subcommittee.role) ?? asString(subcommittee.title),
          rawPayload: subcommittee,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => !!entry);

    deduped.set(normalizedName, {
      committeeCode: asString(committee.systemCode) ?? asString(committee.code),
      committeeName,
      role: asString(committee.role) ?? asString(committee.title),
      chamber: asString(committee.chamber),
      congress: asNumber(committee.congress),
      rawPayload: committee,
      subcommittees,
    });
  }

  return [...deduped.values()];
}

export async function replaceMemberCommitteeAssignments(
  sb: DbClient,
  bioguideId: string,
  assignments: CommitteeAssignmentRecord[]
) {
  const { error: deleteSubsError } = await sb
    .from("member_subcommittee_assignments")
    .delete()
    .eq("bioguide_id", bioguideId);
  if (deleteSubsError) throw new Error(`Failed to clear subcommittee assignments: ${deleteSubsError.message}`);

  const { error: deleteCommitteesError } = await sb
    .from("member_committee_assignments")
    .delete()
    .eq("bioguide_id", bioguideId);
  if (deleteCommitteesError) throw new Error(`Failed to clear committee assignments: ${deleteCommitteesError.message}`);

  if (!assignments.length) return { committees: 0, subcommittees: 0 };

  const committeeInsertPayloads = assignments.map((assignment) => ({
    bioguide_id: bioguideId,
    committee_code: assignment.committeeCode,
    committee_name: assignment.committeeName,
    normalized_committee_name: normalizeOrganizationName(assignment.committeeName),
    chamber: assignment.chamber,
    congress: assignment.congress,
    role: assignment.role,
    source_row_key: `${bioguideId}:committee:${normalizeOrganizationName(assignment.committeeName)}`,
    raw_payload: assignment.rawPayload,
  }));

  const { data: insertedCommittees, error: insertCommitteesError } = await sb
    .from("member_committee_assignments")
    .insert(committeeInsertPayloads)
    .select("id,committee_name,normalized_committee_name");

  if (insertCommitteesError) {
    throw new Error(`Failed to insert committee assignments: ${insertCommitteesError.message}`);
  }

  const committeeIds = new Map<string, number>();
  for (const row of insertedCommittees ?? []) {
    committeeIds.set(row.normalized_committee_name, row.id);
  }

  const subcommitteeInsertPayloads = assignments.flatMap((assignment) => {
    const committeeId = committeeIds.get(normalizeOrganizationName(assignment.committeeName));
    return assignment.subcommittees.map((subcommittee) => ({
      bioguide_id: bioguideId,
      committee_assignment_id: committeeId ?? null,
      parent_committee_code: assignment.committeeCode,
      parent_committee_name: assignment.committeeName,
      subcommittee_code: subcommittee.subcommitteeCode,
      subcommittee_name: subcommittee.subcommitteeName,
      normalized_subcommittee_name: normalizeOrganizationName(subcommittee.subcommitteeName),
      chamber: assignment.chamber,
      congress: assignment.congress,
      role: subcommittee.role,
      source_row_key: `${bioguideId}:subcommittee:${normalizeOrganizationName(subcommittee.subcommitteeName)}`,
      raw_payload: subcommittee.rawPayload,
    }));
  });

  if (subcommitteeInsertPayloads.length) {
    const { error: insertSubcommitteesError } = await sb
      .from("member_subcommittee_assignments")
      .insert(subcommitteeInsertPayloads);
    if (insertSubcommitteesError) {
      throw new Error(`Failed to insert subcommittee assignments: ${insertSubcommitteesError.message}`);
    }
  }

  return {
    committees: committeeInsertPayloads.length,
    subcommittees: subcommitteeInsertPayloads.length,
  };
}

function buildCorrelationCaseKey(casePayload: CorrelationCaseInsert): string {
  return [
    casePayload.member_bioguide_id,
    String(casePayload.organization_id ?? -1),
    casePayload.case_type,
    casePayload.event_date ?? "",
    casePayload.summary,
  ].join("|");
}

function mergeCorrelationEvidence(
  left: unknown,
  right: unknown
): { evidence: unknown[] } {
  const leftEvidence = Array.isArray((left as { evidence?: unknown[] } | null)?.evidence)
    ? (left as { evidence: unknown[] }).evidence
    : [];
  const rightEvidence = Array.isArray((right as { evidence?: unknown[] } | null)?.evidence)
    ? (right as { evidence: unknown[] }).evidence
    : [];
  const deduped = new Map<string, unknown>();

  for (const item of [...leftEvidence, ...rightEvidence]) {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : null;
    const dedupeKey = record?.type === "contract_award"
      ? JSON.stringify({
          type: record.type,
          permalink: record.permalink ?? null,
          actionDate: record.actionDate ?? null,
          totalValue: record.totalValue ?? null,
          awardingAgencyName: record.awardingAgencyName ?? null,
          awardingSubAgencyName: record.awardingSubAgencyName ?? null,
          awardingOfficeName: record.awardingOfficeName ?? null,
          awardDescription: record.awardDescription ?? null,
        })
      : JSON.stringify(item);
    deduped.set(dedupeKey, item);
  }

  return { evidence: [...deduped.values()] };
}

export async function materializeMemberRelationships(sb: DbClient, bioguideId: string) {
  const [
    committeesRes,
    subcommitteesRes,
    contributionsRes,
    tradesRes,
    votesRes,
  ] = await Promise.all([
    sb.from("member_committee_assignments").select("*").eq("bioguide_id", bioguideId),
    sb.from("member_subcommittee_assignments").select("*").eq("bioguide_id", bioguideId),
    sb
      .from("contributions")
      .select("id,candidate_id,contributor_employer,contribution_amount,contribution_date")
      .in(
        "candidate_id",
        (
          await sb.from("fec_candidates").select("candidate_id").eq("bioguide_id", bioguideId)
        ).data?.map((row) => row.candidate_id) ?? []
      ),
    sb.from("member_stock_trades").select("*").eq("bioguide_id", bioguideId),
    sb
      .from("member_voting_record")
      .select("vote_id,vote_date,position,bill_congress,bill_type,bill_number,bill_title,policy_area,question,vote_description,result")
      .eq("bioguide_id", bioguideId)
      .limit(200),
  ]);

  if (committeesRes.error) throw new Error(`Failed to load committees: ${committeesRes.error.message}`);
  if (subcommitteesRes.error) throw new Error(`Failed to load subcommittees: ${subcommitteesRes.error.message}`);
  if (contributionsRes.error) throw new Error(`Failed to load contributions: ${contributionsRes.error.message}`);
  if (tradesRes.error) throw new Error(`Failed to load trades: ${tradesRes.error.message}`);
  if (votesRes.error) throw new Error(`Failed to load votes: ${votesRes.error.message}`);

  const memberFactTypes = [
    "MEMBER_ON_COMMITTEE",
    "MEMBER_ON_SUBCOMMITTEE",
    "MEMBER_RECEIVED_FUNDS_FROM_ORG_ALIAS",
    "MEMBER_TRADED_ORG_STOCK",
    "MEMBER_CAST_VOTE",
  ];

  const { error: clearFactsError } = await sb
    .from("relationship_facts")
    .delete()
    .eq("member_bioguide_id", bioguideId)
    .in("fact_type", memberFactTypes);
  if (clearFactsError) throw new Error(`Failed to clear member facts: ${clearFactsError.message}`);

  const { error: clearCasesError } = await sb
    .from("correlation_cases")
    .delete()
    .eq("member_bioguide_id", bioguideId);
  if (clearCasesError) throw new Error(`Failed to clear member cases: ${clearCasesError.message}`);

  const factPayloads: RelationshipFactInsert[] = [];

  for (const committee of committeesRes.data ?? []) {
    factPayloads.push({
      member_bioguide_id: bioguideId,
      fact_type: "MEMBER_ON_COMMITTEE",
      related_entity_type: "committee_assignment",
      related_entity_id: String(committee.id),
      source_table: "member_committee_assignments",
      source_row_id: String(committee.id),
      evidence_payload: {
        committeeName: committee.committee_name,
        committeeCode: committee.committee_code,
        role: committee.role,
        chamber: committee.chamber,
        congress: committee.congress,
      },
    });
  }

  for (const subcommittee of subcommitteesRes.data ?? []) {
    factPayloads.push({
      member_bioguide_id: bioguideId,
      fact_type: "MEMBER_ON_SUBCOMMITTEE",
      related_entity_type: "subcommittee_assignment",
      related_entity_id: String(subcommittee.id),
      source_table: "member_subcommittee_assignments",
      source_row_id: String(subcommittee.id),
      evidence_payload: {
        subcommitteeName: subcommittee.subcommittee_name,
        subcommitteeCode: subcommittee.subcommittee_code,
        parentCommitteeName: subcommittee.parent_committee_name,
        role: subcommittee.role,
        chamber: subcommittee.chamber,
        congress: subcommittee.congress,
      },
    });
  }

  const contributionFactsByOrg = new Map<number, RelationshipFactInsert[]>();
  for (const contribution of contributionsRes.data ?? []) {
    const employer = asString(contribution.contributor_employer);
    if (!employer) continue;
    const organizationId = await resolveOrganizationId(sb, { name: employer });
    if (organizationId == null) continue;
    const fact: RelationshipFactInsert = {
      member_bioguide_id: bioguideId,
      organization_id: organizationId,
      fact_type: "MEMBER_RECEIVED_FUNDS_FROM_ORG_ALIAS",
      related_entity_type: "contribution",
      related_entity_id: String(contribution.id),
      fact_date: contribution.contribution_date,
      source_table: "contributions",
      source_row_id: String(contribution.id),
      evidence_payload: {
        employer,
        contributionAmount: contribution.contribution_amount,
        contributionDate: contribution.contribution_date,
        candidateId: contribution.candidate_id,
      },
    };
    factPayloads.push(fact);
    contributionFactsByOrg.set(organizationId, [...(contributionFactsByOrg.get(organizationId) ?? []), fact]);
  }

  const tradeFactsByOrg = new Map<number, RelationshipFactInsert[]>();
  for (const trade of tradesRes.data ?? []) {
    const organizationId =
      trade.organization_id ??
      (await resolveOrganizationId(sb, {
        name: trade.asset_name,
        ticker: trade.symbol,
      }));
    if (organizationId == null) continue;
    const fact: RelationshipFactInsert = {
      member_bioguide_id: bioguideId,
      organization_id: organizationId,
      fact_type: "MEMBER_TRADED_ORG_STOCK",
      related_entity_type: "member_stock_trade",
      related_entity_id: String(trade.id),
      fact_date: trade.transaction_date,
      source_table: "member_stock_trades",
      source_row_id: String(trade.id),
      evidence_payload: {
        symbol: trade.symbol,
        assetName: trade.asset_name,
        transactionDate: trade.transaction_date,
        disclosureDate: trade.disclosure_date,
        transactionType: trade.transaction_type,
        amountRange: trade.amount_range,
        shareCount: trade.share_count,
      },
    };
    factPayloads.push(fact);
    tradeFactsByOrg.set(organizationId, [...(tradeFactsByOrg.get(organizationId) ?? []), fact]);
  }

  for (const vote of votesRes.data ?? []) {
    factPayloads.push({
      member_bioguide_id: bioguideId,
      fact_type: "MEMBER_CAST_VOTE",
      related_entity_type: "vote",
      related_entity_id: String(vote.vote_id),
      fact_date: vote.vote_date,
      source_table: "member_voting_record",
      source_row_id: String(vote.vote_id),
      evidence_payload: {
        position: vote.position,
        question: vote.question,
        description: vote.vote_description,
        result: vote.result,
        billCongress: vote.bill_congress,
        billType: vote.bill_type,
        billNumber: vote.bill_number,
        billTitle: vote.bill_title,
        policyArea: vote.policy_area,
      },
    });
  }

  if (factPayloads.length) {
    const { error: insertFactsError } = await sb.from("relationship_facts").insert(factPayloads);
    if (insertFactsError) throw new Error(`Failed to insert member facts: ${insertFactsError.message}`);
  }

  const orgIds = new Set<number>(tradeFactsByOrg.keys());

  const casePayloadsByKey = new Map<string, CorrelationCaseInsert>();

  for (const organizationId of orgIds) {
    const organization = await getOrganizationById(sb, organizationId);
    if (!organization) continue;

    const { data: contractRows, error: contractRowsError } = await sb
      .from("organization_contract_awards")
      .select("*")
      .eq("organization_id", organizationId)
      .order("action_date", { ascending: false })
      .limit(20);
    if (contractRowsError) throw new Error(`Failed to load contract rows for ${organizationId}: ${contractRowsError.message}`);

    const { data: lobbyingRows, error: lobbyingRowsError } = await sb
      .from("organization_lobbying_filings")
      .select("*")
      .eq("organization_id", organizationId)
      .order("dt_posted", { ascending: false })
      .limit(20);
    if (lobbyingRowsError) throw new Error(`Failed to load lobbying rows for ${organizationId}: ${lobbyingRowsError.message}`);

    const tradeEvidence = tradeFactsByOrg.get(organizationId) ?? [];
    if (!tradeEvidence.length) continue;

    for (const tradeFact of tradeEvidence) {
      const tradeDate = toDateOnly(tradeFact.fact_date);
      if (!tradeDate) continue;

      const matchingContracts = (contractRows ?? [])
        .map((contract) => ({
          contract,
          distanceDays: getDateDistanceDays(tradeDate, contract.action_date),
        }))
        .filter((entry) => entry.distanceDays != null && entry.distanceDays <= CORRELATION_WINDOW_DAYS);

      const matchingLobbying = (lobbyingRows ?? [])
        .map((lobbying) => ({
          lobbying,
          distanceDays: getDateDistanceDays(tradeDate, lobbying.dt_posted),
        }))
        .filter((entry) => entry.distanceDays != null && entry.distanceDays <= CORRELATION_WINDOW_DAYS);

      if (!matchingContracts.length && !matchingLobbying.length) continue;

      const evidence = [
        {
          type: "member_trade",
          sourceTable: tradeFact.source_table,
          sourceRowId: tradeFact.source_row_id,
          factDate: tradeFact.fact_date,
          details: tradeFact.evidence_payload,
        },
        ...matchingContracts.map(({ contract, distanceDays }) => ({
          type: "contract_award",
          sourceTable: "organization_contract_awards",
          sourceRowId: String(contract.id),
          actionDate: contract.action_date,
          totalValue: contract.total_value,
          awardingAgencyName: contract.awarding_agency_name,
          awardingSubAgencyName: contract.awarding_sub_agency_name,
          awardingOfficeName: contract.awarding_office_name,
          awardDescription: contract.award_description,
          permalink: contract.permalink,
          daysFromTrade: distanceDays,
        })),
        ...matchingLobbying.map(({ lobbying, distanceDays }) => ({
          type: "lobbying_filing",
          sourceTable: "organization_lobbying_filings",
          sourceRowId: String(lobbying.id),
          dtPosted: lobbying.dt_posted,
          filingType: lobbying.filing_type,
          documentUrl: lobbying.document_url,
          clientId: lobbying.client_id,
          registrantId: lobbying.registrant_id,
          daysFromTrade: distanceDays,
        })),
      ];

      const timeWindowDays = Math.min(
        ...[
          ...matchingContracts.map((entry) => entry.distanceDays),
          ...matchingLobbying.map((entry) => entry.distanceDays),
        ].filter((value): value is number => value != null)
      );

      const hasContractMatch = matchingContracts.length > 0;
      const hasLobbyingMatch = matchingLobbying.length > 0;
      const caseType = hasContractMatch && hasLobbyingMatch
        ? "contract_lobbying_trade_overlap"
        : hasContractMatch
          ? "contract_trade_overlap"
          : "lobbying_trade_overlap";
      const summary = hasContractMatch && hasLobbyingMatch
        ? `${organization.canonical_name} had lobbying activity and federal contract action within ${CORRELATION_WINDOW_DAYS} days of the member's stock trade.`
        : hasContractMatch
          ? `${organization.canonical_name} had federal contract activity within ${CORRELATION_WINDOW_DAYS} days of the member's stock trade.`
          : `${organization.canonical_name} had lobbying activity within ${CORRELATION_WINDOW_DAYS} days of the member's stock trade.`;

      const nextCase: CorrelationCaseInsert = {
        member_bioguide_id: bioguideId,
        organization_id: organizationId,
        case_type: caseType,
        summary,
        event_date: tradeDate,
        time_window_days: timeWindowDays,
        evidence_payload: { evidence },
        status: "active",
      };
      const nextKey = buildCorrelationCaseKey(nextCase);
      const existingCase = casePayloadsByKey.get(nextKey);
      casePayloadsByKey.set(nextKey, existingCase
        ? {
            ...existingCase,
            time_window_days: Math.min(
              existingCase.time_window_days ?? Number.POSITIVE_INFINITY,
              nextCase.time_window_days ?? Number.POSITIVE_INFINITY
            ),
            evidence_payload: mergeCorrelationEvidence(existingCase.evidence_payload, nextCase.evidence_payload),
          }
        : nextCase);
    }
  }

  const casePayloads = [...casePayloadsByKey.values()];
  if (casePayloads.length) {
    const { error: insertCasesError } = await sb.from("correlation_cases").insert(casePayloads);
    if (insertCasesError) throw new Error(`Failed to insert correlation cases: ${insertCasesError.message}`);
  }

  return {
    factCount: factPayloads.length,
    caseCount: casePayloads.length,
  };
}
