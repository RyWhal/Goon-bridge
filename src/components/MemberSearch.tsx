import { useState } from "react";
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
}

interface MemberDetailResponse {
  member?: {
    bioguideId?: string;
    directOrderName?: string;
    party?: string;
    state?: string;
    district?: number;
    depiction?: { imageUrl?: string };
    terms?: Array<{
      chamber?: string;
      congress?: number;
      startYear?: number;
      endYear?: number;
    }>;
  };
}

export function MemberSearch() {
  const [query, setQuery] = useState("");
  const [congress, setCongress] = useState("119");
  const search = useApi<MemberSearchResponse>();
  const detail = useApi<MemberDetailResponse>();

  const handleSearch = () => {
    if (!query.trim()) {
      search.fetchData(`/api/congress/members?congress=${congress}&limit=50`);
    } else {
      search.fetchData(
        `/api/congress/members/search?q=${encodeURIComponent(query)}&congress=${congress}`
      );
    }
  };

  const handleMemberClick = (bioguideId: string) => {
    detail.fetchData(`/api/congress/members/${bioguideId}`);
  };

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
            <option value="119">119th Congress (2025-2027)</option>
            <option value="118">118th Congress (2023-2025)</option>
            <option value="117">117th Congress (2021-2023)</option>
            <option value="116">116th Congress (2019-2021)</option>
          </select>
          <button onClick={handleSearch} className="btn btn-primary">
            Search
          </button>
        </div>
        <p className="text-xs text-vibe-dim mt-2">
          Leave blank to browse all members. Source: Congress.gov API
        </p>
      </div>

      {search.loading && <LoadingSkeleton />}

      {search.error && (
        <div className="card border-vibe-nay/30">
          <p className="text-sm text-vibe-nay">{search.error}</p>
        </div>
      )}

      {search.data && (
        <div className="space-y-2">
          <p className="text-xs text-vibe-dim">
            {search.data.count ?? search.data.members?.length ?? 0} results
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {(search.data.members ?? []).slice(0, 60).map((m) => (
              <button
                key={m.bioguideId}
                onClick={() => m.bioguideId && handleMemberClick(m.bioguideId)}
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
        </div>
      )}

      {detail.loading && <LoadingSkeleton />}

      {detail.data?.member && (
        <div className="card border-vibe-accent/30">
          <div className="flex items-start gap-4 mb-4">
            {detail.data.member.depiction?.imageUrl && (
              <img
                src={detail.data.member.depiction.imageUrl}
                alt=""
                className="w-20 h-20 rounded-lg object-cover bg-vibe-border"
              />
            )}
            <div>
              <h3 className="text-lg font-bold">
                {detail.data.member.directOrderName}
              </h3>
              <div className="flex items-center gap-2 mt-1">
                <PartyBadge party={detail.data.member.party} />
                <span className="text-sm text-vibe-dim">
                  {detail.data.member.state}
                  {detail.data.member.district
                    ? ` District ${detail.data.member.district}`
                    : ""}
                </span>
              </div>
              <p className="text-xs text-vibe-dim mt-1">
                Bioguide: {detail.data.member.bioguideId}
              </p>
            </div>
          </div>
          <JsonViewer data={detail.data} label="Full API Response" />
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
