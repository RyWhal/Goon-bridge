import { useState, useEffect, useRef } from "react";
import { useApi } from "../hooks/useApi";
import { JsonViewer } from "./JsonViewer";

interface MemberResult {
  name?: string;
  bioguideId?: string;
  state?: string;
  party?: string;
  district?: number;
  terms?: { item?: Array<{ chamber?: string }> };
  depiction?: { imageUrl?: string };
}

interface MemberSearchResponse {
  members?: MemberResult[];
  count?: number;
  pagination?: { count?: number; next?: string };
}

interface MemberTerm {
  chamber?: string;
  congress?: number;
  startYear?: number;
  endYear?: number;
  district?: number;
  memberType?: string;
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

const LIMIT = 50;

export function MemberSearch() {
  const [query, setQuery] = useState("");
  const [congress, setCongress] = useState("119");
  const [offset, setOffset] = useState(0);
  const [allMembers, setAllMembers] = useState<MemberResult[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const isLoadMore = useRef(false);

  const search = useApi<MemberSearchResponse>();
  const detail = useApi<MemberDetailResponse>();

  // Accumulate members across pages
  useEffect(() => {
    if (!search.data?.members) return;
    const incoming = search.data.members;
    if (isLoadMore.current) {
      setAllMembers((prev) => [...prev, ...incoming]);
    } else {
      setAllMembers(incoming);
    }
    setTotalCount(
      search.data.count ??
        search.data.pagination?.count ??
        incoming.length
    );
    isLoadMore.current = false;
  }, [search.data]);

  const doFetch = (newOffset: number) => {
    const base = query.trim()
      ? `/api/congress/members/search?q=${encodeURIComponent(query)}&congress=${congress}`
      : `/api/congress/members?congress=${congress}`;
    search.fetchData(`${base}&limit=${LIMIT}&offset=${newOffset}`);
  };

  const handleSearch = () => {
    isLoadMore.current = false;
    setOffset(0);
    setAllMembers([]);
    setExpandedId(null);
    doFetch(0);
  };

  const handleLoadMore = () => {
    const next = offset + LIMIT;
    isLoadMore.current = true;
    setOffset(next);
    doFetch(next);
  };

  const handleMemberClick = (bioguideId: string) => {
    if (expandedId === bioguideId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(bioguideId);
    detail.fetchData(`/api/congress/members/${bioguideId}`);
  };

  const hasMore = allMembers.length < totalCount && totalCount > 0;

  return (
    <div className="space-y-4">
      <div className="card">
        <h2 className="text-sm font-semibold text-vibe-dim uppercase tracking-wider mb-3">
          Search Members of Congress
        </h2>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            className="input flex-1"
            placeholder="Search by name, state, or party..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
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
          <button onClick={handleSearch} className="btn btn-primary">
            Search
          </button>
        </div>
        <p className="text-xs text-vibe-dim mt-2">
          Leave blank to browse all members. Click a member card to expand details.
        </p>
      </div>

      {search.error && (
        <div className="card border-vibe-nay/30">
          <p className="text-sm text-vibe-nay">{search.error}</p>
        </div>
      )}

      {allMembers.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs text-vibe-dim">
            Showing {allMembers.length} of {totalCount} members
          </p>

          {/* Grid with inline expansion */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {allMembers.map((m) => (
              <MemberCard
                key={m.bioguideId}
                member={m}
                isExpanded={expandedId === m.bioguideId}
                onClick={() => m.bioguideId && handleMemberClick(m.bioguideId)}
                detail={expandedId === m.bioguideId ? detail : null}
              />
            ))}
          </div>

          {/* Load more */}
          {hasMore && (
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                onClick={handleLoadMore}
                disabled={search.loading}
                className="btn btn-primary"
              >
                {search.loading && isLoadMore.current
                  ? "Loading..."
                  : `Load more (${totalCount - allMembers.length} remaining)`}
              </button>
            </div>
          )}

          {search.loading && !isLoadMore.current && (
            <LoadingSkeleton />
          )}
        </div>
      )}

      {/* Initial loading */}
      {search.loading && allMembers.length === 0 && <LoadingSkeleton />}
    </div>
  );
}

function MemberCard({
  member,
  isExpanded,
  onClick,
  detail,
}: {
  member: MemberResult;
  isExpanded: boolean;
  onClick: () => void;
  detail: ReturnType<typeof useApi<MemberDetailResponse>> | null;
}) {
  return (
    <>
      <button
        onClick={onClick}
        className={`card text-left hover:border-vibe-accent/50 transition-colors ${
          isExpanded ? "border-vibe-accent/50 bg-vibe-surface/80" : ""
        }`}
      >
        <div className="flex items-center gap-3">
          {member.depiction?.imageUrl && (
            <img
              src={member.depiction.imageUrl}
              alt=""
              className="w-10 h-10 rounded-full object-cover bg-vibe-border"
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate">{member.name}</p>
            <div className="flex items-center gap-2 mt-0.5">
              <PartyBadge party={member.party} />
              <span className="text-xs text-vibe-dim">
                {member.state}
                {member.district != null ? `-${member.district}` : ""}
              </span>
            </div>
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
            <MemberDetailCard member={detail.data.member} />
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
}: {
  member: NonNullable<MemberDetailResponse["member"]>;
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

  return (
    <div className="card border-vibe-accent/30 mt-2">
      {/* Header */}
      <div className="flex items-start gap-4 mb-4">
        {member.depiction?.imageUrl && (
          <img
            src={member.depiction.imageUrl}
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

      <div className="mt-3 pt-3 border-t border-vibe-border">
        <p className="text-xs text-vibe-dim">
          See this member's donors and votes side-by-side in the{" "}
          <span className="text-vibe-money font-medium">Follow the Money</span> tab.
        </p>
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
