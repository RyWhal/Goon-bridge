import { useState } from "react";
import { useApi } from "../hooks/useApi";

interface MemberResult {
  name?: string;
  bioguideId?: string;
  state?: string;
  party?: string;
  district?: number;
  depiction?: { imageUrl?: string };
}

interface MemberSearchResponse {
  members?: MemberResult[];
  count?: number;
}

interface CorrelationResponse {
  member: {
    bioguide_id: string;
    name: string;
    party: string | null;
    state: string | null;
    district: number | null;
    image_url: string | null;
  };
  fec_candidates: Array<{
    candidate_id: string;
    name: string | null;
    party: string | null;
    state: string | null;
    office: string | null;
    election_years: number[] | null;
  }>;
  top_donors: Array<{
    contributor_employer: string;
    total_amount: number;
    contribution_count: number;
    first_contribution: string;
    last_contribution: string;
  }>;
  recent_votes: Array<{
    vote_date: string | null;
    question: string | null;
    vote_description: string | null;
    result: string | null;
    position: string;
    chamber: string;
    roll_call_number: number;
  }>;
}

interface LinkResponse {
  bioguide_id: string;
  fec_candidates: Array<{ candidate_id?: string; name?: string }>;
  count?: number;
}

interface ContributionsResponse {
  bioguide_id: string;
  contributions: Array<{
    contributor_name?: string;
    contributor_employer?: string;
    contributor_occupation?: string;
    contributor_state?: string;
    contribution_receipt_amount?: number;
    contribution_amount?: number;
    contribution_receipt_date?: string;
    contribution_date?: string;
    committee?: { name?: string };
    committee_name?: string;
  }>;
  count: number;
  source: string;
}

export function FollowTheMoney() {
  const [query, setQuery] = useState("");
  const [selectedMember, setSelectedMember] = useState<MemberResult | null>(null);
  const search = useApi<MemberSearchResponse>();
  const correlation = useApi<CorrelationResponse>();
  const link = useApi<LinkResponse>();
  const contributions = useApi<ContributionsResponse>();

  const handleSearch = () => {
    if (!query.trim()) return;
    setSelectedMember(null);
    search.fetchData(
      `/api/congress/members/search?q=${encodeURIComponent(query)}&congress=119`
    );
  };

  const handleSelectMember = async (member: MemberResult) => {
    if (!member.bioguideId) return;
    setSelectedMember(member);

    // Fire correlation request (Supabase-backed)
    correlation.fetchData(`/api/correlation/member/${member.bioguideId}`);

    // Also trigger FEC linking + contribution fetch
    link.fetchData(`/api/fec/link/${member.bioguideId}`);
    contributions.fetchData(`/api/fec/member/${member.bioguideId}/contributions`);
  };

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="card">
        <h2 className="text-sm font-semibold text-vibe-dim uppercase tracking-wider mb-3">
          Follow the Money
        </h2>
        <p className="text-xs text-vibe-dim mb-3">
          Search for a member of Congress to see their top donors alongside their
          voting record.
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            className="input flex-1"
            placeholder="Search member by name..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          />
          <button onClick={handleSearch} className="btn btn-primary">
            Search
          </button>
        </div>
      </div>

      {/* Search results */}
      {search.loading && <LoadingSkeleton />}
      {search.error && (
        <div className="card border-vibe-nay/30">
          <p className="text-sm text-vibe-nay">{search.error}</p>
        </div>
      )}
      {search.data?.members && !selectedMember && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {search.data.members.slice(0, 30).map((m) => (
            <button
              key={m.bioguideId}
              onClick={() => handleSelectMember(m)}
              className="card text-left hover:border-vibe-accent/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                {m.depiction?.imageUrl && (
                  <img
                    src={m.depiction.imageUrl}
                    alt=""
                    className="w-10 h-10 rounded-full object-cover bg-vibe-border"
                  />
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{m.name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <PartyBadge party={m.party} />
                    <span className="text-xs text-vibe-dim">
                      {m.state}
                      {m.district != null ? `-${m.district}` : ""}
                    </span>
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Selected member profile */}
      {selectedMember && (
        <div className="space-y-4">
          {/* Back button + header */}
          <div className="card border-vibe-accent/30">
            <div className="flex items-start gap-4">
              <button
                onClick={() => setSelectedMember(null)}
                className="text-xs text-vibe-dim hover:text-vibe-text shrink-0 mt-1"
              >
                &larr; Back
              </button>
              {selectedMember.depiction?.imageUrl && (
                <img
                  src={selectedMember.depiction.imageUrl}
                  alt=""
                  className="w-16 h-16 rounded-lg object-cover bg-vibe-border"
                />
              )}
              <div>
                <h3 className="text-lg font-bold">{selectedMember.name}</h3>
                <div className="flex items-center gap-2 mt-1">
                  <PartyBadge party={selectedMember.party} />
                  <span className="text-sm text-vibe-dim">
                    {selectedMember.state}
                    {selectedMember.district != null
                      ? ` District ${selectedMember.district}`
                      : ""}
                  </span>
                </div>
              </div>
            </div>

            {/* FEC linking status */}
            {link.loading && (
              <p className="text-xs text-vibe-dim mt-3">Linking to FEC records...</p>
            )}
            {link.data && (
              <p className="text-xs text-vibe-dim mt-3">
                {link.data.fec_candidates?.length ?? 0} FEC candidate record(s) found
                {link.data.fec_candidates?.map((fc) => (
                  <span key={fc.candidate_id} className="ml-2 badge bg-vibe-border text-vibe-text">
                    {fc.candidate_id}
                  </span>
                ))}
              </p>
            )}
          </div>

          {/* Two-column layout: donors + votes */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Donors column */}
            <div className="space-y-2">
              <h4 className="text-sm font-semibold text-vibe-money uppercase tracking-wider">
                Top Donors by Employer
              </h4>

              {correlation.loading && <LoadingSkeleton />}

              {/* From Supabase correlation data */}
              {correlation.data?.top_donors &&
                correlation.data.top_donors.length > 0 && (
                  <div className="space-y-1">
                    {correlation.data.top_donors.slice(0, 15).map((d, i) => (
                      <div key={i} className="card py-2 px-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              {d.contributor_employer}
                            </p>
                            <p className="text-xs text-vibe-dim">
                              {d.contribution_count} contribution(s)
                            </p>
                          </div>
                          <p className="text-sm font-bold text-vibe-money shrink-0">
                            ${d.total_amount?.toLocaleString() ?? "?"}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

              {/* Fallback: raw contributions from FEC API */}
              {(!correlation.data?.top_donors ||
                correlation.data.top_donors.length === 0) &&
                contributions.data?.contributions &&
                contributions.data.contributions.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs text-vibe-dim">
                      Individual contributions (from FEC):
                    </p>
                    {contributions.data.contributions.slice(0, 15).map((c, i) => {
                      const amount =
                        c.contribution_receipt_amount ?? c.contribution_amount;
                      return (
                        <div key={i} className="card py-2 px-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">
                                {c.contributor_name}
                              </p>
                              <p className="text-xs text-vibe-dim truncate">
                                {c.contributor_employer}
                                {c.contributor_occupation
                                  ? ` | ${c.contributor_occupation}`
                                  : ""}
                              </p>
                            </div>
                            <p className="text-sm font-bold text-vibe-money shrink-0">
                              ${amount?.toLocaleString() ?? "?"}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

              {/* No data state */}
              {!correlation.loading &&
                !contributions.loading &&
                (!correlation.data?.top_donors ||
                  correlation.data.top_donors.length === 0) &&
                (!contributions.data?.contributions ||
                  contributions.data.contributions.length === 0) && (
                  <div className="card">
                    <p className="text-sm text-vibe-dim">
                      No contribution data available yet. Data is populated as
                      users search the FEC contributions tab.
                    </p>
                  </div>
                )}
            </div>

            {/* Votes column */}
            <div className="space-y-2">
              <h4 className="text-sm font-semibold text-vibe-accent uppercase tracking-wider">
                Recent Votes
              </h4>

              {correlation.loading && <LoadingSkeleton />}

              {correlation.data?.recent_votes &&
                correlation.data.recent_votes.length > 0 && (
                  <div className="space-y-1">
                    {correlation.data.recent_votes.slice(0, 20).map((v, i) => (
                      <div key={i} className="card py-2 px-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm truncate">
                              {v.question ?? v.vote_description ?? "Vote"}
                            </p>
                            <p className="text-xs text-vibe-dim">
                              {v.vote_date} | {v.chamber} RC#{v.roll_call_number}
                            </p>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <PositionBadge position={v.position} />
                            {v.result && (
                              <span className="text-xs text-vibe-dim">
                                {v.result}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

              {!correlation.loading &&
                (!correlation.data?.recent_votes ||
                  correlation.data.recent_votes.length === 0) && (
                  <div className="card">
                    <p className="text-sm text-vibe-dim">
                      No voting record available yet. Vote data is populated as
                      users browse the Votes tab.
                    </p>
                  </div>
                )}
            </div>
          </div>
        </div>
      )}
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
  return <span className={`badge ${cls}`}>{p.charAt(0)}</span>;
}

function PositionBadge({ position }: { position: string }) {
  const p = position.toLowerCase();
  if (p === "yea" || p === "aye") {
    return (
      <span className="badge bg-vibe-yea/20 text-vibe-yea text-xs">
        {position}
      </span>
    );
  }
  if (p === "nay" || p === "no") {
    return (
      <span className="badge bg-vibe-nay/20 text-vibe-nay text-xs">
        {position}
      </span>
    );
  }
  return (
    <span className="badge bg-vibe-border text-vibe-dim text-xs">
      {position}
    </span>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-2">
      {[...Array(3)].map((_, i) => (
        <div key={i} className="card py-2 px-3">
          <div className="shimmer h-4 w-48 mb-2" />
          <div className="shimmer h-3 w-32" />
        </div>
      ))}
    </div>
  );
}
