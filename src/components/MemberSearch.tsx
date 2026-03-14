import { useEffect, useState } from "react";
import { useApi } from "../hooks/useApi";
import { JsonViewer } from "./JsonViewer";
import {
  buildBillLinks,
  formatBillLabel,
  formatVotePositionLabel,
  normalizeVotePosition,
  resolveMemberImageUrl,
} from "../lib/congress";

interface MemberResult {
  name?: string;
  bioguideId?: string;
  directOrderName?: string;
  state?: string;
  party?: string;
  district?: number;
  chamber?: string;
  firstCongress?: number | null;
  lastCongress?: number | null;
  congressesServed?: number | null;
  terms?: { item?: Array<{ chamber?: string }> };
  depiction?: { imageUrl?: string };
}

interface MemberSearchResponse {
  members?: MemberResult[];
  count?: number;
  source?: string;
}

interface MemberTerm {
  chamber?: string;
  congress?: number;
  startYear?: number;
  endYear?: number;
  district?: number;
  memberType?: string;
}

function summarizeDisplayedTerms(terms: MemberTerm[] | undefined) {
  const allTerms = Array.isArray(terms) ? terms : [];
  const congresses = allTerms
    .map((term) => term.congress)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  return {
    congressesServed: congresses.length ? new Set(congresses).size : allTerms.length,
    chamber:
      allTerms.length > 0
        ? allTerms[allTerms.length - 1]?.chamber
        : undefined,
  };
}

interface MemberDetailResponse {
  member?: {
    bioguideId?: string;
    directOrderName?: string;
    party?: string;
    partyName?: string;
    state?: string;
    district?: number;
    officialWebsiteUrl?: string;
    depiction?: { imageUrl?: string };
    terms?: MemberTerm[];
    addressInformation?: {
      officeAddress?: string;
      phoneNumber?: string;
    };
    leadership?: Array<{ congress?: number; type?: string }>;
  };
}

interface MemberVoteRecord {
  rollCallNumber: number;
  date: string | null;
  question: string | null;
  description: string | null;
  result: string | null;
  position: string;
  chamber: string;
  bill?: {
    congress?: string | number;
    type?: string;
    number?: string | number;
    apiUrl?: string;
  };
}

interface MemberVotesResponse {
  bioguide_id: string;
  votes?: MemberVoteRecord[];
  count?: number;
}

type PartyFilter = "all" | "D" | "R" | "I";
type ChamberFilter = "all" | "House" | "Senate";
type SortOption =
  | "name-asc"
  | "state-asc"
  | "congresses-desc"
  | "congresses-asc";

function normalizeParty(party?: string | null): PartyFilter | null {
  const value = (party ?? "").trim().toUpperCase();
  if (value === "D" || value === "DEMOCRAT" || value === "DEMOCRATIC") return "D";
  if (value === "R" || value === "REPUBLICAN") return "R";
  if (value === "I" || value === "INDEPENDENT") return "I";
  return null;
}

function normalizeChamber(chamber?: string | null): ChamberFilter | null {
  const value = (chamber ?? "").trim().toLowerCase();
  if (value.includes("house")) return "House";
  if (value.includes("senate")) return "Senate";
  return null;
}

export function MemberSearch() {
  const [query, setQuery] = useState("");
  const [congress, setCongress] = useState("119");
  const [partyFilter, setPartyFilter] = useState<PartyFilter>("all");
  const [chamberFilter, setChamberFilter] = useState<ChamberFilter>("all");
  const [sortBy, setSortBy] = useState<SortOption>("name-asc");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const browse = useApi<MemberSearchResponse>();
  const detail = useApi<MemberDetailResponse>();
  const memberVotes = useApi<MemberVotesResponse>();

  useEffect(() => {
    browse.fetchData(`/api/congress/members/browse?congress=${congress}`);
    setExpandedId(null);
  }, [browse.fetchData, congress]);

  useEffect(() => {
    if (!expandedId || !browse.data?.members || !detail.data?.member) return;

    const { congressesServed, chamber } = summarizeDisplayedTerms(detail.data.member.terms);
    const existingMember = browse.data.members.find((member) => member.bioguideId === expandedId);
    if (!existingMember) return;
    if (
      existingMember.congressesServed === congressesServed &&
      (chamber == null || existingMember.chamber === chamber)
    ) {
      return;
    }

    browse.setData({
      ...browse.data,
      members: browse.data.members.map((member) =>
        member.bioguideId === expandedId
          ? {
              ...member,
              congressesServed,
              chamber: chamber ?? member.chamber,
            }
          : member
      ),
    });
  }, [browse.data, browse.setData, detail.data, expandedId]);

  const handleMemberClick = (bioguideId: string) => {
    if (expandedId === bioguideId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(bioguideId);
    detail.fetchData(`/api/congress/members/${bioguideId}`);
    memberVotes.fetchData(`/api/congress/member-votes/${bioguideId}?congress=${congress}&limit=30`);
  };

  const allMembers = browse.data?.members ?? [];
  const normalizedQuery = query.trim().toLowerCase();

  const filteredMembers = [...allMembers]
    .filter((member) => {
      const memberParty = normalizeParty(member.party);
      const memberChamber =
        normalizeChamber(member.chamber) ??
        (member.district == null ? "Senate" : "House");

      if (partyFilter !== "all" && memberParty !== partyFilter) return false;
      if (chamberFilter !== "all" && memberChamber !== chamberFilter) return false;
      if (!normalizedQuery) return true;

      const name = (member.name ?? member.directOrderName ?? "").toLowerCase();
      const state = (member.state ?? "").toLowerCase();
      return name.includes(normalizedQuery) || state.includes(normalizedQuery);
    })
    .sort((left, right) => {
      const leftName = (left.name ?? left.directOrderName ?? "").toLowerCase();
      const rightName = (right.name ?? right.directOrderName ?? "").toLowerCase();
      const leftState = (left.state ?? "").toLowerCase();
      const rightState = (right.state ?? "").toLowerCase();
      const leftCongresses = left.congressesServed ?? 0;
      const rightCongresses = right.congressesServed ?? 0;

      switch (sortBy) {
        case "state-asc":
          return leftState.localeCompare(rightState) || leftName.localeCompare(rightName);
        case "congresses-desc":
          return rightCongresses - leftCongresses || leftName.localeCompare(rightName);
        case "congresses-asc":
          return leftCongresses - rightCongresses || leftName.localeCompare(rightName);
        case "name-asc":
        default:
          return leftName.localeCompare(rightName);
      }
    });

  return (
    <div className="space-y-4">
      <div className="card">
        <h2 className="text-sm font-semibold text-vibe-dim uppercase tracking-wider mb-4">
          Browse Members of Congress
        </h2>
        <div className="flex flex-col lg:flex-row gap-3">
          <input
            type="text"
            className="input flex-1"
            placeholder="Search by name or state..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="select"
            value={congress}
            onChange={(e) => setCongress(e.target.value)}
          >
            <option value="119">119th Congress (2025–2027)</option>
            <option value="118">118th Congress (2023–2025)</option>
            <option value="117">117th Congress (2021–2023)</option>
            <option value="116">116th Congress (2019–2021)</option>
          </select>
          <select
            className="select"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortOption)}
          >
            <option value="name-asc">Name (A-Z)</option>
            <option value="state-asc">State</option>
            <option value="congresses-desc">Congresses Served (Most)</option>
            <option value="congresses-asc">Congresses Served (Fewest)</option>
          </select>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-2 xl:gap-4">
          <div>
            <p className="mb-1.5 text-[10px] text-vibe-dim uppercase tracking-wider">Party</p>
            <div className="flex flex-wrap gap-1.5">
              <FilterToggle
                label="All"
                active={partyFilter === "all"}
                onClick={() => setPartyFilter("all")}
              />
              <FilterToggle
                label="Democrats"
                active={partyFilter === "D"}
                onClick={() => setPartyFilter("D")}
              />
              <FilterToggle
                label="Republicans"
                active={partyFilter === "R"}
                onClick={() => setPartyFilter("R")}
              />
              <FilterToggle
                label="Independents"
                active={partyFilter === "I"}
                onClick={() => setPartyFilter("I")}
              />
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-[10px] text-vibe-dim uppercase tracking-wider">Chamber</p>
            <div className="flex flex-wrap gap-1.5">
              <FilterToggle
                label="All"
                active={chamberFilter === "all"}
                onClick={() => setChamberFilter("all")}
              />
              <FilterToggle
                label="House"
                active={chamberFilter === "House"}
                onClick={() => setChamberFilter("House")}
              />
              <FilterToggle
                label="Senate"
                active={chamberFilter === "Senate"}
                onClick={() => setChamberFilter("Senate")}
              />
            </div>
          </div>
        </div>

        <p className="text-xs text-vibe-dim mt-3">
          Cached members load automatically. Search matches name or state only. Click a member card to expand details.
        </p>
      </div>

      {browse.error && (
        <div className="card border-vibe-nay/30">
          <p className="text-sm text-vibe-nay">{browse.error}</p>
        </div>
      )}

      {filteredMembers.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs text-vibe-dim">
            Showing {filteredMembers.length} of {allMembers.length} members
            {browse.data?.source ? ` · ${browse.data.source.replace(/_/g, " ")}` : ""}
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2">
            {filteredMembers.map((m) => (
              <MemberCard
                key={m.bioguideId}
                member={m}
                isExpanded={expandedId === m.bioguideId}
                onClick={() => m.bioguideId && handleMemberClick(m.bioguideId)}
                detail={expandedId === m.bioguideId ? detail : null}
                memberVotes={expandedId === m.bioguideId ? memberVotes : null}
              />
            ))}
          </div>
        </div>
      )}

      {!browse.loading && !browse.error && allMembers.length > 0 && filteredMembers.length === 0 && (
        <div className="card">
          <p className="text-sm text-vibe-dim">
            No members matched the current filters.
          </p>
        </div>
      )}

      {browse.loading && <LoadingSkeleton />}
    </div>
  );
}

function FilterToggle({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? "border-vibe-accent bg-vibe-accent text-white"
          : "border-transparent text-vibe-dim hover:border-vibe-border hover:bg-vibe-border/60 hover:text-vibe-text"
      }`}
    >
      {label}
    </button>
  );
}

function MemberCard({
  member,
  isExpanded,
  onClick,
  detail,
  memberVotes,
}: {
  member: MemberResult;
  isExpanded: boolean;
  onClick: () => void;
  detail: ReturnType<typeof useApi<MemberDetailResponse>> | null;
  memberVotes: ReturnType<typeof useApi<MemberVotesResponse>> | null;
}) {
  const chamber =
    normalizeChamber(member.chamber) ??
    (member.district == null ? "Senate" : "House");
  const portraitUrl = resolveMemberImageUrl(member.depiction?.imageUrl);
  const tenureLabel =
    member.congressesServed != null
      ? `${member.congressesServed} congress${member.congressesServed === 1 ? "" : "es"} served`
      : null;

  return (
    <>
      <button
        onClick={onClick}
        className={`card p-3 text-left hover:border-vibe-accent/50 transition-colors ${
          isExpanded ? "border-vibe-accent/50 bg-vibe-surface/80" : ""
        }`}
      >
        <div className="flex items-center gap-2.5">
          {portraitUrl && (
            <img
              src={portraitUrl}
              alt=""
              className="h-9 w-9 rounded-full object-cover bg-vibe-border"
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate">{member.name}</p>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              <PartyBadge party={member.party} />
              <span className="badge bg-vibe-border px-1.5 py-0.5 text-[10px] text-vibe-dim">
                {chamber}
              </span>
              <span className="text-xs text-vibe-dim">
                {member.state}
                {member.district != null ? `-${member.district}` : ""}
              </span>
            </div>
            {tenureLabel && (
              <p className="mt-1 text-[10px] text-vibe-dim">{tenureLabel}</p>
            )}
          </div>
          <span className="text-xs text-vibe-dim shrink-0">
            {isExpanded ? "▲" : "▼"}
          </span>
        </div>
      </button>

      {/* Inline detail — col-span-full so it breaks across the grid */}
      {isExpanded && (
        <div className="col-span-full">
          {detail?.loading && <LoadingSkeleton />}
          {detail?.data?.member && (
            <MemberDetailCard member={detail.data.member} votingRecord={memberVotes} />
          )}
          {!detail?.loading && !detail?.data?.member && detail?.error && (
            <div className="card border-vibe-nay/30">
              <p className="text-sm text-vibe-nay">{detail.error}</p>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function MemberDetailCard({
  member,
  votingRecord,
}: {
  member: NonNullable<MemberDetailResponse["member"]>;
  votingRecord: ReturnType<typeof useApi<MemberVotesResponse>> | null;
}) {
  const terms = member.terms ?? [];
  const latestTerm = terms[terms.length - 1];
  const chamber = latestTerm?.chamber ?? "";
  const senatTerms = terms.filter((t) =>
    t.chamber?.toLowerCase().includes("senate")
  );
  const houseTerms = terms.filter((t) =>
    t.chamber?.toLowerCase().includes("house")
  );
  const allStartYears = terms.map((t) => t.startYear).filter(Boolean) as number[];
  const allEndYears = terms
    .map((t) => t.endYear ?? new Date().getFullYear())
    .filter(Boolean) as number[];
  const firstYear = allStartYears.length ? Math.min(...allStartYears) : null;
  const lastYear = allEndYears.length ? Math.max(...allEndYears) : null;
  const yearsServed = firstYear && lastYear ? lastYear - firstYear : null;
  const isCurrentSenator = chamber.toLowerCase().includes("senate");
  const isCurrentRep = chamber.toLowerCase().includes("house");
  const recentVotes = votingRecord?.data?.votes ?? [];
  const voteCounts = recentVotes.reduce(
    (counts, vote) => {
      const normalized = normalizeVotePosition(vote.position);
      if (normalized === "yea") counts.yea += 1;
      else if (normalized === "nay") counts.nay += 1;
      else if (normalized === "present") counts.present += 1;
      else if (normalized === "not-voting") counts.notVoting += 1;
      return counts;
    },
    { yea: 0, nay: 0, present: 0, notVoting: 0 }
  );
  const portraitUrl = resolveMemberImageUrl(member.depiction?.imageUrl);

  return (
    <div className="card border-vibe-accent/30 mt-2">
      {/* Header */}
      <div className="flex items-start gap-4 mb-4">
        {portraitUrl && (
          <img
            src={portraitUrl}
            alt=""
            className="w-20 h-20 rounded-lg object-cover bg-vibe-border shrink-0"
          />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-bold">{member.directOrderName}</h3>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <PartyBadge party={member.party} />
            {chamber && (
              <span
                className={`badge ${
                  isCurrentSenator
                    ? "bg-vibe-cosmic/20 text-vibe-cosmic"
                    : "bg-vibe-accent/20 text-vibe-accent"
                }`}
              >
                {isCurrentSenator
                  ? "Senator"
                  : isCurrentRep
                  ? "Representative"
                  : chamber}
              </span>
            )}
            <span className="text-sm text-vibe-dim">
              {member.state}
              {member.district ? ` District ${member.district}` : ""}
            </span>
          </div>
          {member.officialWebsiteUrl && (
            <a
              href={member.officialWebsiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-vibe-accent hover:underline mt-1 block"
            >
              Official Website →
            </a>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <StatBox label="Total Terms" value={terms.length > 0 ? String(terms.length) : "—"} />
        <StatBox label="Senate Terms" value={String(senatTerms.length)} />
        <StatBox label="House Terms" value={String(houseTerms.length)} />
        <StatBox label="Yrs in Congress" value={yearsServed != null ? `~${yearsServed}` : "—"} />
      </div>

      {/* Term history */}
      {terms.length > 0 && (
        <div className="mb-4">
          <p className="text-xs text-vibe-dim uppercase tracking-wider mb-2">
            Term History
          </p>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {[...terms].reverse().map((t, i) => (
              <div
                key={i}
                className="flex items-center justify-between text-xs px-2 py-1.5 rounded bg-vibe-surface"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`badge text-[10px] ${
                      t.chamber?.toLowerCase().includes("senate")
                        ? "bg-vibe-cosmic/20 text-vibe-cosmic"
                        : "bg-vibe-accent/20 text-vibe-accent"
                    }`}
                  >
                    {t.chamber?.toLowerCase().includes("senate") ? "SEN" : "REP"}
                  </span>
                  {t.congress && (
                    <span className="text-vibe-dim">{t.congress}th Congress</span>
                  )}
                </div>
                <span className="text-vibe-dim">
                  {t.startYear}
                  {t.endYear ? ` – ${t.endYear}` : " – present"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Leadership */}
      {member.leadership && member.leadership.length > 0 && (
        <div className="mb-4">
          <p className="text-xs text-vibe-dim uppercase tracking-wider mb-2">
            Leadership Roles
          </p>
          <div className="flex flex-wrap gap-1">
            {member.leadership.map((l, i) => (
              <span key={i} className="badge bg-vibe-money/20 text-vibe-money text-xs">
                {l.type} (Congress {l.congress})
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Office */}
      {member.addressInformation && (
        <div className="mb-4 text-xs text-vibe-dim">
          {member.addressInformation.officeAddress && (
            <p>{member.addressInformation.officeAddress}</p>
          )}
          {member.addressInformation.phoneNumber && (
            <p>Phone: {member.addressInformation.phoneNumber}</p>
          )}
        </div>
      )}

      <div className="mb-4">
        <div className="flex items-center justify-between gap-3 mb-2">
          <p className="text-xs text-vibe-dim uppercase tracking-wider">
            Recent Voting Record
          </p>
          <span className="text-xs text-vibe-dim">
            {votingRecord?.data?.count ?? recentVotes.length} recent vote(s)
          </span>
        </div>

        {votingRecord?.loading && <LoadingSkeleton />}

        {!votingRecord?.loading && recentVotes.length > 0 && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
              <StatBox label="Yea" value={String(voteCounts.yea)} />
              <StatBox label="Nay" value={String(voteCounts.nay)} />
              <StatBox label="Present" value={String(voteCounts.present)} />
              <StatBox label="Not Present" value={String(voteCounts.notVoting)} />
            </div>
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {recentVotes.map((vote, index) => {
                const billLinks = vote.bill ? buildBillLinks(vote.bill) : null;
                return (
                  <div
                    key={`${vote.chamber}-${vote.rollCallNumber}-${vote.date ?? index}`}
                    className="rounded bg-vibe-surface px-3 py-2 text-xs"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          <span className="badge bg-vibe-border text-vibe-text">
                            {vote.chamber} Roll #{vote.rollCallNumber}
                          </span>
                          <span
                            className={`badge ${
                              normalizeVotePosition(vote.position) === "yea"
                                ? "badge-yea"
                                : normalizeVotePosition(vote.position) === "nay"
                                ? "badge-nay"
                                : "bg-vibe-border text-vibe-dim"
                            }`}
                          >
                            {formatVotePositionLabel(vote.position)}
                          </span>
                        </div>
                        <p className="font-medium text-vibe-text">
                          {vote.question ?? vote.description ?? "Vote"}
                        </p>
                        <p className="text-vibe-dim mt-1">
                          {vote.date ?? "Date unavailable"}
                          {vote.result ? ` · ${vote.result}` : ""}
                        </p>
                        {vote.description && vote.question && (
                          <p className="text-vibe-dim mt-1">{vote.description}</p>
                        )}
                      </div>
                      {vote.bill && billLinks && (
                        <a
                          href={billLinks.detail}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-vibe-accent hover:underline shrink-0"
                        >
                          {formatBillLabel(vote.bill)}
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {!votingRecord?.loading && votingRecord?.error && (
          <div className="card border-vibe-nay/30">
            <p className="text-sm text-vibe-nay">{votingRecord.error}</p>
          </div>
        )}

        {!votingRecord?.loading && !votingRecord?.error && recentVotes.length === 0 && (
          <p className="text-xs text-vibe-dim italic">
            No recent voting history was returned for this member.
          </p>
        )}
      </div>

      <JsonViewer data={{ member }} label="Full API Response" />
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-vibe-surface rounded px-3 py-2 text-center">
      <p className="text-lg font-bold">{value}</p>
      <p className="text-[10px] text-vibe-dim uppercase tracking-wide">{label}</p>
    </div>
  );
}

function PartyBadge({ party }: { party?: string }) {
  const p = (party ?? "").toUpperCase();
  const cls =
    p === "DEMOCRAT" || p === "D"
      ? "badge-d"
      : p === "REPUBLICAN" || p === "R"
      ? "badge-r"
      : "badge-i";
  return <span className={`badge ${cls}`}>{p.charAt(0) || "?"}</span>;
}

function LoadingSkeleton() {
  return (
    <div className="space-y-2">
      {[...Array(3)].map((_, i) => (
        <div key={i} className="card">
          <div className="shimmer h-4 w-48 mb-2" />
          <div className="shimmer h-3 w-32" />
        </div>
      ))}
    </div>
  );
}
