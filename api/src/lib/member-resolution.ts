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

const GIVEN_NAME_GROUPS = [
  ["ALEX", "ALEXANDER", "ALEXANDRA"],
  ["ANDY", "ANDREW"],
  ["BILL", "WILLIAM", "WILL", "BILLY"],
  ["BOB", "ROBERT", "ROBBIE", "BOBBY", "ROB"],
  ["CHRIS", "CHRISTOPHER"],
  ["DAN", "DANIEL"],
  ["DAVE", "DAVID"],
  ["DON", "DONALD"],
  ["JIM", "JAMES", "JIMMY"],
  ["JOE", "JOSEPH", "JOEY"],
  ["MATT", "MATTHEW"],
  ["MIKE", "MICHAEL"],
  ["PAT", "PATRICK"],
  ["RICK", "RICHARD", "RICH", "RICKY"],
  ["RON", "RONALD"],
  ["STEVE", "STEVEN", "STEPHEN"],
  ["TOM", "THOMAS", "TOMMY"],
] as const;

const GIVEN_NAME_VARIANTS = new Map<string, Set<string>>();
for (const group of GIVEN_NAME_GROUPS) {
  const set = new Set(group);
  for (const name of group) GIVEN_NAME_VARIANTS.set(name, set);
}

export type MemberResolutionConfidence = "high" | "medium" | "low";

export type MemberResolutionRow = {
  bioguide_id: string;
  name: string | null;
  direct_order_name: string | null;
  state: string | null;
  chamber: string | null;
};

export type MemberResolutionResult = {
  bioguideId: string | null;
  confidence: MemberResolutionConfidence | null;
  score: number | null;
  reason: string;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeMemberState(value: string | null | undefined): string | null {
  const normalized = asString(value)?.toUpperCase() ?? null;
  if (!normalized) return null;
  if (normalized.length === 2) return normalized;
  const compact = normalized.replace(/[^A-Z ]+/g, " ").replace(/\s+/g, " ").trim();
  return STATE_CODE_BY_NAME[compact] ?? null;
}

export function normalizeMemberName(value: string | null | undefined): string {
  return (value ?? "")
    .toUpperCase()
    .replace(/\b(MR|MRS|MS|REP|SEN|SENATOR|REPRESENTATIVE)\b/g, " ")
    .replace(/\b(JR|SR|II|III|IV|V|MD|PHD|DDS|DMD|FACS)\b/g, " ")
    .replace(/[^A-Z, ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalGivenNames(given: string | null): string[] {
  if (!given) return [];
  const variants = GIVEN_NAME_VARIANTS.get(given);
  return variants ? [...variants] : [given];
}

function parseNameForm(value: string | null | undefined) {
  const normalized = normalizeMemberName(value);
  if (!normalized) return null;

  if (normalized.includes(",")) {
    const [rawSurname, rawRemainder] = normalized.split(",", 2);
    const surnameTokens = (rawSurname ?? "").split(" ").filter(Boolean);
    const givenTokens = (rawRemainder ?? "").split(" ").filter(Boolean);
    const surname = surnameTokens[surnameTokens.length - 1] ?? null;
    const given = givenTokens[0] ?? null;
    return { given, surname };
  }

  const tokens = normalized.split(" ").filter(Boolean);
  return {
    given: tokens[0] ?? null,
    surname: tokens[tokens.length - 1] ?? null,
  };
}

function givenNameMatch(queryGiven: string | null, memberGiven: string | null) {
  if (!queryGiven || !memberGiven) return { matched: false, score: 0, reason: "missing_given_name" };
  if (queryGiven === memberGiven) return { matched: true, score: 70, reason: "exact_full_name" };

  const queryVariants = new Set(canonicalGivenNames(queryGiven));
  const memberVariants = new Set(canonicalGivenNames(memberGiven));
  for (const variant of queryVariants) {
    if (memberVariants.has(variant)) return { matched: true, score: 58, reason: "nickname_plus_state" };
  }

  if (queryGiven[0] === memberGiven[0]) {
    return { matched: true, score: 45, reason: "initial_plus_state" };
  }

  return { matched: false, score: 0, reason: "given_name_mismatch" };
}

function chamberMatches(memberChamber: string | null, chamber: string | null | undefined) {
  if (!chamber || !memberChamber) return true;
  return memberChamber.toLowerCase().includes(chamber.toLowerCase());
}

export function buildResolutionCandidateFilters(memberName: string | null | undefined): string[] {
  const form = parseNameForm(memberName);
  return form?.surname ? [form.surname] : [];
}

export function resolveMemberBioguideMatch(
  members: MemberResolutionRow[],
  {
    memberName,
    chamber,
    state,
  }: {
    memberName?: string | null;
    chamber?: string | null;
    state?: string | null;
  }
): MemberResolutionResult {
  const form = parseNameForm(memberName);
  if (!form?.surname || !form.given) {
    return { bioguideId: null, confidence: null, score: null, reason: "insufficient_name_parts" };
  }

  const normalizedState = normalizeMemberState(state);
  const scored: Array<{
    bioguideId: string;
    confidence: MemberResolutionConfidence;
    score: number;
    reason: string;
  }> = [];

  for (const member of members) {
    if (!member.bioguide_id) continue;
    if (!chamberMatches(member.chamber, chamber)) continue;
    if (normalizedState && normalizeMemberState(member.state) !== normalizedState) continue;

    const memberForm = parseNameForm(member.direct_order_name ?? member.name);
    if (!memberForm?.surname || memberForm.surname !== form.surname) continue;

    const givenMatch = givenNameMatch(form.given, memberForm.given);
    if (!givenMatch.matched) continue;

    let score = 20 + givenMatch.score;
    if (normalizedState) score += 10;
    if (chamber) score += 5;

    scored.push({
      bioguideId: member.bioguide_id,
      confidence: score >= 95 ? "high" : score > 80 ? "medium" : "low",
      score,
      reason: givenMatch.reason,
    });
  }

  scored.sort((left, right) => right.score - left.score || left.bioguideId.localeCompare(right.bioguideId));
  const top = scored[0];
  if (!top) return { bioguideId: null, confidence: null, score: null, reason: "no_candidate_match" };
  if (scored[1] && scored[1].score === top.score) {
    return { bioguideId: null, confidence: null, score: null, reason: "ambiguous_top_score" };
  }
  return top;
}
