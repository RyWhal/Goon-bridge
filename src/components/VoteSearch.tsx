import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { JsonViewer } from "./JsonViewer";

interface VoteItem {
  congress?: number;
  chamber?: string;
  rollCallNumber?: number;
  date?: string;
  question?: string;
  description?: string;
  result?: string;
  url?: string;
}

interface VoteListResponse {
  votes?: VoteItem[];
  notice?: string;
}

interface VoteMember {
  bioguideId?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  name?: string;
  party?: string;
  state?: string;
  votePosition?: string;
  memberVoted?: string;
}

interface VoteDetailResponse {
  vote?: {
    congress?: number;
    chamber?: string;
    date?: string;
    question?: string;
    description?: string;
    result?: string;
    // Possible shapes for totals
    totalYea?: number;
    totalNay?: number;
    totalNotVoting?: number;
    totalPresent?: number;
    totals?: {
      yea?: number;
      nay?: number;
      not_voting?: number;
      notVoting?: number;
      present?: number;
    };
    // Possible shapes for member lists
    members?: VoteMember[];
    memberVotes?: {
      Yea?: VoteMember[];
      Nay?: VoteMember[];
      "Not Voting"?: VoteMember[];
      Present?: VoteMember[];
      yea?: VoteMember[];
      nay?: VoteMember[];
      notVoting?: VoteMember[];
      present?: VoteMember[];
    };
  };
}

type VoteFilter = "all" | "yea" | "nay" | "notVoting";

// Unique key for a vote used to track which one is expanded
function voteKey(v: VoteItem) {
  return `${v.congress}-${v.chamber}-${v.rollCallNumber}`;
}

export function VoteSearch() {
  const [congress, setCongress] = useState("119");
  const [chamber, setChamber] = useState("");
  const [limit, setLimit] = useState("20");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [memberFilter, setMemberFilter] = useState<VoteFilter>("all");
  const list = useApi<VoteListResponse>();
  const detail = useApi<VoteDetailResponse>();

  const handleSearch = () => {
    setExpandedKey(null);
    const params = new URLSearchParams({ congress, limit });
    if (chamber) params.set("chamber", chamber);
    list.fetchData(`/api/congress/votes?${params.toString()}`);
  };

  const handleVoteClick = (v: VoteItem) => {
    const key = voteKey(v);
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(key);
    setMemberFilter("all");
    if (v.congress && v.chamber && v.rollCallNumber) {
      detail.fetchData(
        `/api/congress/votes/${v.congress}/${v.chamber.toLowerCase()}/${v.rollCallNumber}`
      );
    }
  };

  // Read totals from whichever field shape the API returns
  const getTotals = () => {
    const vote = detail.data?.vote;
    if (!vote) return { yea: undefined, nay: undefined, notVoting: undefined, present: undefined };
    return {
      yea: vote.totalYea ?? vote.totals?.yea,
      nay: vote.totalNay ?? vote.totals?.nay,
      notVoting: vote.totalNotVoting ?? vote.totals?.not_voting ?? vote.totals?.notVoting,
      present: vote.totalPresent ?? vote.totals?.present,
    };
  };

  // Normalise member vote lists from either API shape
  const getMembersByPosition = (pos: VoteFilter): VoteMember[] => {
    const vote = detail.data?.vote;
    if (!vote) return [];

    // Shape A: flat members array with votePosition field
    if (vote.members && vote.members.length > 0) {
      if (pos === "all") return vote.members;
      const targets: Record<VoteFilter, string[]> = {
        all: [],
        yea: ["yea", "aye"],
        nay: ["nay", "no"],
        notVoting: ["not voting", "absent", "present", "no vote"],
      };
      return vote.members.filter((m) =>
        targets[pos].includes((m.votePosition ?? m.memberVoted ?? "").toLowerCase())
      );
    }

    // Shape B: memberVotes keyed by position (case-insensitive)
    if (vote.memberVotes) {
      const mv = vote.memberVotes;
      if (pos === "all") {
        return [
          ...(mv.Yea ?? mv.yea ?? []),
          ...(mv.Nay ?? mv.nay ?? []),
          ...(mv["Not Voting"] ?? mv.notVoting ?? []),
          ...(mv.Present ?? mv.present ?? []),
        ];
      }
      if (pos === "yea") return mv.Yea ?? mv.yea ?? [];
      if (pos === "nay") return mv.Nay ?? mv.nay ?? [];
      if (pos === "notVoting")
        return [...(mv["Not Voting"] ?? mv.notVoting ?? []), ...(mv.Present ?? mv.present ?? [])];
    }

    return [];
  };

  const allMembers = getMembersByPosition("all");
  const filteredMembers = getMembersByPosition(memberFilter);
  const hasMembers = allMembers.length > 0;

  return (
    <div className="space-y-4">
      <div className="card">
        <h2 className="text-sm font-semibold text-vibe-dim uppercase tracking-wider mb-3">
          Browse Roll Call Votes
        </h2>
        <div className="flex flex-col sm:flex-row gap-2">
          <select
            className="select"
            value={congress}
            onChange={(e) => setCongress(e.target.value)}
          >
            <option value="119">119th Congress</option>
            <option value="118">118th Congress</option>
          </select>
          <select
            className="select"
            value={chamber}
            onChange={(e) => setChamber(e.target.value)}
          >
            <option value="">House (All Sessions)</option>
            <option value="senate">Senate (All Sessions)</option>
          </select>
          <select
            className="select"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
          >
            <option value="10">10 results</option>
            <option value="20">20 results</option>
            <option value="50">50 results</option>
          </select>
          <button onClick={handleSearch} className="btn btn-primary">
            Fetch Votes
          </button>
        </div>
        <p className="text-xs text-vibe-dim mt-2">
          Click a vote to expand its details inline.
        </p>
      </div>

      {list.loading && <LoadingRows />}

      {list.error && (
        <div className="card border-vibe-nay/30">
          <p className="text-sm text-vibe-nay">{list.error}</p>
        </div>
      )}

      {list.data?.notice && (
        <div className="card border-yellow-500/30">
          <p className="text-sm text-yellow-400">{list.data.notice}</p>
        </div>
      )}

      {list.data?.votes && list.data.votes.length === 0 && !list.data.notice && (
        <div className="card">
          <p className="text-sm text-vibe-dim">
            No roll call votes found for this selection.
          </p>
        </div>
      )}

      {list.data?.votes && list.data.votes.length > 0 && (
        <div className="space-y-2">
          {list.data.votes.map((v, i) => {
            const key = voteKey(v);
            const isExpanded = expandedKey === key;
            const totals = isExpanded ? getTotals() : null;

            return (
              <div key={i}>
                {/* Vote row button */}
                <button
                  onClick={() => handleVoteClick(v)}
                  className={`card w-full text-left hover:border-vibe-accent/50 transition-colors ${
                    isExpanded ? "border-vibe-accent/50" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {v.question || v.description || "Vote"}
                      </p>
                      {v.description && v.question && (
                        <p className="text-xs text-vibe-dim mt-1 truncate">
                          {v.description}
                        </p>
                      )}
                      <div className="flex items-center gap-3 mt-2 text-xs text-vibe-dim">
                        <span>{v.chamber}</span>
                        <span>Roll #{v.rollCallNumber}</span>
                        <span>{v.date}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {v.result && (
                        <span
                          className={`badge ${
                            v.result.toLowerCase().includes("passed") ||
                            v.result.toLowerCase().includes("agreed")
                              ? "badge-yea"
                              : "badge-nay"
                          }`}
                        >
                          {v.result}
                        </span>
                      )}
                      <span className="text-xs text-vibe-dim">
                        {isExpanded ? "▲" : "▼"}
                      </span>
                    </div>
                  </div>
                </button>

                {/* Inline detail */}
                {isExpanded && (
                  <div className="mt-1 ml-2">
                    {detail.loading && <LoadingRows />}

                    {!detail.loading && detail.data?.vote && (
                      <div className="card border-vibe-accent/30">
                        <h3 className="text-sm font-bold mb-1">
                          {detail.data.vote.question}
                        </h3>
                        <p className="text-xs text-vibe-dim mb-4">
                          {detail.data.vote.description}
                        </p>

                        {/* Totals */}
                        <div className="flex gap-6 mb-4">
                          <VoteCount label="Yea" count={totals?.yea} color="vibe-yea" />
                          <VoteCount label="Nay" count={totals?.nay} color="vibe-nay" />
                          <VoteCount label="Not Voting" count={totals?.notVoting} color="vibe-dim" />
                          {(totals?.present ?? 0) > 0 && (
                            <VoteCount label="Present" count={totals?.present} color="vibe-dim" />
                          )}
                        </div>

                        {/* Member breakdown */}
                        {hasMembers ? (
                          <div>
                            <div className="flex flex-wrap gap-2 mb-3">
                              {(
                                [
                                  { id: "all", label: "All" },
                                  { id: "yea", label: "Yea" },
                                  { id: "nay", label: "Nay" },
                                  { id: "notVoting", label: "Not Voting" },
                                ] as { id: VoteFilter; label: string }[]
                              ).map(({ id, label }) => {
                                const count = getMembersByPosition(id).length;
                                return (
                                  <button
                                    key={id}
                                    onClick={() => setMemberFilter(id)}
                                    className={`btn text-xs py-1 ${
                                      memberFilter === id
                                        ? id === "yea"
                                          ? "bg-vibe-yea/20 text-vibe-yea border border-vibe-yea/30"
                                          : id === "nay"
                                          ? "bg-vibe-nay/20 text-vibe-nay border border-vibe-nay/30"
                                          : "btn-primary"
                                        : "btn-ghost"
                                    }`}
                                  >
                                    {label} ({count})
                                  </button>
                                );
                              })}
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 max-h-72 overflow-y-auto">
                              {filteredMembers.map((m, mi) => {
                                const pos = (
                                  m.votePosition ?? m.memberVoted ?? ""
                                ).toLowerCase();
                                const isYea = pos === "yea" || pos === "aye";
                                const isNay = pos === "nay" || pos === "no";
                                const displayName =
                                  m.fullName ??
                                  m.name ??
                                  `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim();
                                return (
                                  <div
                                    key={mi}
                                    className="flex items-center justify-between px-2 py-1 rounded bg-vibe-surface text-xs"
                                  >
                                    <div className="flex items-center gap-2 min-w-0">
                                      <span
                                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                          isYea
                                            ? "bg-vibe-yea"
                                            : isNay
                                            ? "bg-vibe-nay"
                                            : "bg-vibe-dim"
                                        }`}
                                      />
                                      <span className="truncate font-medium">
                                        {displayName}
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0 ml-2">
                                      {m.party && (
                                        <span className="text-vibe-dim">{m.party}</span>
                                      )}
                                      {m.state && (
                                        <span className="text-vibe-dim">-{m.state}</span>
                                      )}
                                      {(m.votePosition ?? m.memberVoted) &&
                                        memberFilter === "all" && (
                                          <span
                                            className={`badge text-[10px] ml-1 ${
                                              isYea
                                                ? "badge-yea"
                                                : isNay
                                                ? "badge-nay"
                                                : "bg-vibe-border text-vibe-dim"
                                            }`}
                                          >
                                            {m.votePosition ?? m.memberVoted}
                                          </span>
                                        )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ) : (
                          <p className="text-xs text-vibe-dim italic">
                            Individual member votes not returned by this endpoint.
                          </p>
                        )}

                        <JsonViewer data={detail.data} label="Full API Response" />
                      </div>
                    )}

                    {!detail.loading && detail.error && (
                      <div className="card border-vibe-nay/30">
                        <p className="text-sm text-vibe-nay">{detail.error}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function VoteCount({
  label,
  count,
  color,
}: {
  label: string;
  count?: number;
  color: string;
}) {
  return (
    <div className="text-center">
      <p className={`text-2xl font-bold text-${color}`}>
        {count != null ? count : "—"}
      </p>
      <p className="text-xs text-vibe-dim">{label}</p>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2">
      {[...Array(3)].map((_, i) => (
        <div key={i} className="card">
          <div className="shimmer h-4 w-64 mb-2" />
          <div className="shimmer h-3 w-40" />
        </div>
      ))}
    </div>
  );
}
