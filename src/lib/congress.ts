export interface BillReference {
  congress?: number | string;
  type?: string;
  number?: number | string;
  url?: string;
}

export type NormalizedVotePosition =
  | "yea"
  | "nay"
  | "present"
  | "not-voting"
  | "unknown";

const BILL_TYPE_SLUGS: Record<string, string> = {
  hr: "house-bill",
  s: "senate-bill",
  hjres: "house-joint-resolution",
  sjres: "senate-joint-resolution",
  hres: "house-resolution",
  sres: "senate-resolution",
  hconres: "house-concurrent-resolution",
  sconres: "senate-concurrent-resolution",
};

export function parseBillUrl(url?: string): {
  congress: string;
  type: string;
  number: string;
} | null {
  if (!url) return null;
  const match = url.match(/\/bill\/(\d+)\/([a-z0-9]+)\/([a-z0-9-]+)/i);
  if (!match) return null;
  return {
    congress: match[1],
    type: match[2].toLowerCase(),
    number: match[3],
  };
}

export function resolveBillReference(ref: BillReference) {
  const congress = ref.congress != null ? String(ref.congress) : undefined;
  const type = ref.type?.toLowerCase();
  const number = ref.number != null ? String(ref.number) : undefined;

  if (congress && type && number) {
    return { congress, type, number };
  }

  return parseBillUrl(ref.url);
}

export function formatBillLabel(ref: BillReference): string {
  const resolved = resolveBillReference(ref);
  if (!resolved) return "Bill";
  return `${resolved.type.toUpperCase()} ${resolved.number}`;
}

export function buildBillLinks(ref: BillReference) {
  const resolved = resolveBillReference(ref);
  if (!resolved) return null;

  const slug = BILL_TYPE_SLUGS[resolved.type] ?? "bill";
  const base = `https://www.congress.gov/bill/${resolved.congress}th-congress/${slug}/${resolved.number}`;
  return {
    detail: base,
    text: `${base}/text`,
    actions: `${base}/actions`,
  };
}

export function normalizePartyValue(raw?: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.trim();
  if (!cleaned) return null;

  const upper = cleaned.toUpperCase();
  if (upper === "D" || upper === "R" || upper === "I") return upper;
  if (upper.includes("DEMOCRAT")) return "D";
  if (upper.includes("REPUBLICAN")) return "R";
  if (upper.includes("INDEPENDENT")) return "I";
  return cleaned;
}

export function normalizeVotePosition(value?: string | null): NormalizedVotePosition {
  const lower = (value ?? "").trim().toLowerCase();
  if (lower === "yea" || lower === "aye" || lower === "yes") return "yea";
  if (lower === "nay" || lower === "no") return "nay";
  if (lower === "present") return "present";
  if (
    lower === "not voting" ||
    lower === "not present" ||
    lower === "absent" ||
    lower === "no vote"
  ) {
    return "not-voting";
  }
  return "unknown";
}

export function formatVotePositionLabel(value?: string | null): string {
  const normalized = normalizeVotePosition(value);
  if (normalized === "yea") return "Yea";
  if (normalized === "nay") return "Nay";
  if (normalized === "present") return "Present";
  if (normalized === "not-voting") return "Not Present";
  return value?.trim() || "Unknown";
}

export function formatMemberDisplayName(member: {
  fullName?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
}) {
  const combined = `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim();
  if (member.fullName) return member.fullName;
  if (member.name) return member.name;
  if (combined) return combined;
  return "Unknown member";
}

export function resolveMemberImageUrl(value?: string | null): string | null {
  if (!value) return null;
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
