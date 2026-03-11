import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { JsonViewer } from "./JsonViewer";

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
  message?: string;
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
  message?: string;
}

export function FollowTheMoney() {
  const [query, setQuery] = useState("");
  const [selectedMember, setSelectedMember] = useState<MemberResult | null>(null);
  const [showDebug, setShowDebug] = useState(false);
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
    setShowDebug(false);

    // Fire correlation request (Supabase-backed)
    correlation.fetchData(`/api/correlation/member/${member.bioguideId}`);

    // Link FEC candidates first, THEN fetch contributions (contributions
    // endpoint requires FEC candidates to be linked in Supabase first)
    await link.fetchData(`/api/fec/link/${member.bioguideId}`);
    contributions.fetchData(`/api/fec/member/${member.bioguideId}/contributions`);
  };

  const hasAnyDonorData =
    (correlation.data?.top_donors && correlation.data.top_donors.length > 0) ||
    (contributions.data?.contributions && contributions.data.contributions.length > 0);

  const hasAnyVoteData =
    correlation.data?.recent_votes && correlation.data.recent_votes.length > 0;

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="card">
        <h2 className="text-sm font-semibold text-vibe-dim uppercase tracking-wider mb-3">
          Follow the Money
        </h2>
        <p className="text-xs text-vibe-dim mb-3">
          Search for a member of Congress to see their top donors alongside their
          voting record. Data is sourced from FEC filings and Congress.gov.
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
              <div className="flex-1">
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
            <div className="mt-3 pt-3 border-t border-vibe-border">
              {link.loading && (
                <p className="text-xs text-vibe-dim">Linking to FEC records...</p>
              )}
              {link.error && (
                <p className="text-xs text-vibe-nay">FEC link error: {link.error}</p>
              )}
              {link.data && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-vibe-dim">
                    {link.data.fec_candidates?.length ?? 0} FEC candidate record(s) linked
                  </span>
                  {link.data.fec_candidates?.map((fc) => (
                    <span key={fc.candidate_id} className="badge bg-vibe-border text-vibe-text text-xs">
                      {fc.candidate_id} {fc.name ? `(${fc.name})` : ""}
                    </span>
                  ))}
                  {link.data.message && (
                    <span className="text-xs text-yellow-400">{link.data.message}</span>
                  )}
                  {(link.data.fec_candidates?.length ?? 0) === 0 && (
                    <span className="text-xs text-yellow-400">
                      No FEC candidate match found — contribution data may be unavailable.
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Debug toggle */}
            <button
              onClick={() => setShowDebug((v) => !v)}
              className="text-xs text-vibe-dim hover:text-vibe-text mt-2 block"
            >
              {showDebug ? "Hide" : "Show"} raw API data
            </button>
            {showDebug && (
              <div className="mt-2 space-y-2">
                <JsonViewer data={correlation.data} label="Correlation API" />
                <JsonViewer data={link.data} label="FEC Link API" />
                <JsonViewer data={contributions.data} label="Contributions API" />
              </div>
            )}
          </div>

          {/* Two-column layout: donors + votes */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Donors column */}
            <div className="space-y-2">
              <h4 className="text-sm font-semibold text-vibe-money uppercase tracking-wider">
                Top Donors by Employer
              </h4>

              {(correlation.loading || contributions.loading) && <LoadingSkeleton />}

              {/* From Supabase correlation data */}
              {correlation.data?.top_donors &&
                correlation.data.top_donors.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs text-vibe-dim">From contribution records:</p>
                    {correlation.data.top_donors.slice(0, 15).map((d, i) => (
                      <div key={i} className="card py-2 px-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              {d.contributor_employer || "(Unknown employer)"}
                            </p>
                            <p className="text-xs text-vibe-dim">
                              {d.contribution_count} contribution(s) ·{" "}
                              {d.first_contribution?.slice(0, 4)}
                              {d.last_contribution && d.last_contribution !== d.first_contribution
                                ? `–${d.last_contribution?.slice(0, 4)}`
                                : ""}
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
                !hasAnyDonorData && (
                  <div className="card bg-vibe-surface">
                    <p className="text-sm text-vibe-dim mb-2">
                      No contribution data found.
                    </p>
                    <p className="text-xs text-vibe-dim">
                      This can happen if:
                    </p>
                    <ul className="text-xs text-vibe-dim mt-1 space-y-0.5 list-disc list-inside">
                      <li>No FEC candidate record was matched (see linking status above)</li>
                      <li>The member hasn't filed recent FEC reports</li>
                      <li>Contribution data hasn't been indexed yet</li>
                    </ul>
                    <p className="text-xs text-vibe-dim mt-2">
                      Try searching this candidate directly in the{" "}
                      <span className="text-vibe-money font-medium">Money</span> tab for more options.
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

              {hasAnyVoteData && (
                <div className="space-y-1">
                  {correlation.data!.recent_votes.slice(0, 20).map((v, i) => (
                    <div key={i} className="card py-2 px-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm truncate">
                            {v.question ?? v.vote_description ?? "Vote"}
                          </p>
                          {v.vote_description && v.question && (
                            <p className="text-xs text-vibe-dim truncate">
                              {v.vote_description}
                            </p>
                          )}
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

              {!correlation.loading && !hasAnyVoteData && (
                <div className="card bg-vibe-surface">
                  <p className="text-sm text-vibe-dim mb-2">
                    No voting records found yet.
                  </p>
                  <p className="text-xs text-vibe-dim">
                    Vote data is populated when users browse the{" "}
                    <span className="text-vibe-accent font-medium">Votes</span> tab.
                    Try browsing the 119th Congress votes there to seed the data.
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
