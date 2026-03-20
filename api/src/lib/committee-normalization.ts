type CommitteeKeyInput = {
  committeeCode?: string | null;
  normalizedName: string;
  chamber?: string | null;
};

type BuildCommitteeAssignmentRowInput = {
  bioguideId: string;
  committeeName: string;
  committeeCode?: string | null;
  chamber?: string | null;
};

type CollapseCommitteeToTopLevelOptions = {
  parentCommitteeName?: string | null;
  chamber?: string | null;
};

type CollapsedCommittee = {
  normalizedName: string;
  chamber: string | null;
};

const SUBCOMMITTEE_TO_PARENT: Record<string, string> = {
  "DEFENSE": "ARMED SERVICES",
  "HEALTH": "ENERGY AND COMMERCE",
  "INVESTIGATIONS": "WAYS AND MEANS",
  "OVERSIGHT": "WAYS AND MEANS",
  "CRIME AND TERRORISM": "JUDICIARY",
  "COURTS INTELLECTUAL PROPERTY AND THE INTERNET": "JUDICIARY",
  "DOMESTIC MONETARY POLICY AND TECHNOLOGY": "FINANCIAL SERVICES",
  "ENERGY AND WATER DEVELOPMENT": "APPROPRIATIONS",
  "STATE FOREIGN OPERATIONS AND RELATED PROGRAMS": "APPROPRIATIONS",
  "LABOR HEALTH AND HUMAN SERVICES EDUCATION AND RELATED AGENCIES": "APPROPRIATIONS",
  "AGRICULTURE RURAL DEVELOPMENT FOOD AND DRUG ADMINISTRATION AND RELATED AGENCIES": "APPROPRIATIONS",
};

function stripBoilerplate(value: string): string {
  let cleaned = value;
  let changed = true;

  while (changed) {
    changed = false;
    for (const prefix of [
      "UNITED STATES ",
      "U S ",
      "US ",
      "HOUSE OF REPRESENTATIVES ",
      "HOUSE ",
      "SENATE ",
      "PERMANENT SELECT ",
      "SELECT ",
      "COMMITTEE ON ",
      "SUBCOMMITTEE ON ",
      "COMMITTEE ",
      "SUBCOMMITTEE ",
    ]) {
      if (cleaned.startsWith(prefix)) {
        cleaned = cleaned.slice(prefix.length);
        changed = true;
      }
    }
  }

  return cleaned.trim();
}

export function normalizeCommitteeLabel(value: string): string {
  const cleaned = value
    .trim()
    .toUpperCase()
    .replace(/\s*\((?:CHAIR|CHAIRMAN|RANKING MEMBER|RANKING)\)\s*$/g, "")
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";
  return stripBoilerplate(cleaned)
    .replace(/\s+COMMITTEE$/g, "")
    .trim();
}

export function buildCommitteeKey({ committeeCode, normalizedName, chamber }: CommitteeKeyInput): string | null {
  const cleanedCode = committeeCode?.trim();
  if (cleanedCode) return cleanedCode;
  const cleanedName = normalizedName.trim();
  const cleanedChamber = chamber?.trim();
  if (!cleanedChamber) return null;
  return `${cleanedName}:${cleanedChamber}`;
}

export function collapseCommitteeToTopLevel(
  committeeName: string,
  { parentCommitteeName, chamber: _chamber }: CollapseCommitteeToTopLevelOptions
): CollapsedCommittee {
  const normalizedParent = parentCommitteeName ? normalizeCommitteeLabel(parentCommitteeName) : null;
  if (normalizedParent) return { normalizedName: normalizedParent, chamber: _chamber ?? null };

  const normalizedName = normalizeCommitteeLabel(committeeName);
  return {
    normalizedName: SUBCOMMITTEE_TO_PARENT[normalizedName] ?? normalizedName,
    chamber: _chamber ?? null,
  };
}

export function buildCommitteeAssignmentRow({
  bioguideId,
  committeeName,
  committeeCode,
  chamber,
}: BuildCommitteeAssignmentRowInput) {
  const collapsedCommittee = collapseCommitteeToTopLevel(committeeName, { chamber });
  const committeeKey = buildCommitteeKey({
    committeeCode,
    normalizedName: collapsedCommittee.normalizedName,
    chamber: collapsedCommittee.chamber,
  });

  return {
    bioguide_id: bioguideId,
    committee_code: committeeCode ?? null,
    committee_name: committeeName,
    committee_key: committeeKey,
    normalized_committee_name: collapsedCommittee.normalizedName,
    chamber: collapsedCommittee.chamber,
    source_row_key: `${bioguideId}:committee:${committeeKey ?? collapsedCommittee.normalizedName}`,
  };
}
