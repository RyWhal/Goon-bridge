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
  party?: string;
  state?: string;
  votePosition?: string;
  district?: number;
}

interface VoteDetailResponse {
  vote?: {
    congress?: number;
    chamber?: string;
    date?: string;
    question?: string;
    description?: string;
    result?: string;
    totalYea?: number;
    totalNay?: number;
    totalNotVoting?: number;
    totalPresent?: number;
    members?: VoteMember[];
    // Some API shapes nest member votes differently
    memberVotes?: {
      yea?: VoteMember[];
      nay?: VoteMember[];
      notVoting?: VoteMember[];
      present?: VoteMember[];
    };
  };
}

type VoteFilter = "all" | "yea" | "nay" | "notVoting";

export function VoteSearch() {
  const [congress, setCongress] = useState("119");
  const [chamber, setChamber] = useState("");
  const [limit, setLimit] = useState("20");
  const [selectedVote, setSelectedVote] = useState<VoteItem | null>(null);
  const [memberFilter, setMemberFilter] = useState<VoteFilter>("all");
  const list = useApi<VoteListResponse>();
  const detail = useApi<VoteDetailResponse>();

  const handleSearch = () => {
    const params = new URLSearchParams({ congress, limit });
    if (chamber) params.set("chamber", chamber);
    list.fetchData(`/api/congress/votes?${params.toString()}`);
  };

  const handleVoteClick = (v: VoteItem) => {
    setSelectedVote(v);
    setMemberFilter("all");
    if (v.congress && v.chamber && v.rollCallNumber) {
      detail.fetchData(
        `/api/congress/votes/${v.congress}/${v.chamber.toLowerCase()}/${v.rollCallNumber}`
      );
    }
  };

  // Normalise member vote lists from either API shape
  const getMembersByPosition = (pos: VoteFilter) => {
    const vote = detail.data?.vote;
    if (!vote) return [];

    // Shape 1: flat members array with votePosition field
    if (vote.members && vote.members.length > 0) {
      if (pos === "all") return vote.members;
      const posMap: Record<VoteFilter, string[]> = {
        all: [],
        yea: ["yea", "aye"],
        nay: ["nay", "no"],
        notVoting: ["not voting", "absent", "present"],
      };
      const targets = posMap[pos];
      return vote.members.filter((m) =>
        targets.includes((m.votePosition ?? "").toLowerCase())
      );
    }

    // Shape 2: memberVotes object keyed by position
    if (vote.memberVotes) {
      if (pos === "all") {
        return [
          ...(vote.memberVotes.yea ?? []),
          ...(vote.memberVotes.nay ?? []),
          ...(vote.memberVotes.notVoting ?? []),
          ...(vote.memberVotes.present ?? []),
        ];
      }
      if (pos === "yea") return vote.memberVotes.yea ?? [];
      if (pos === "nay") return vote.memberVotes.nay ?? [];
      if (pos === "notVoting")
        return [
          ...(vote.memberVotes.notVoting ?? []),
          ...(vote.memberVotes.present ?? []),
        ];
    }

    return [];
  };

  const filteredMembers = getMembersByPosition(memberFilter);
  const hasMembers =
    getMembersByPosition("all").length > 0;

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
            <option value="senate">Senate (not yet available)</option>
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
            No roll call votes found for this congress selection.
          </p>
        </div>
      )}

      {list.data?.votes && list.data.votes.length > 0 && (
        <div className="space-y-2">
          {list.data.votes.map((v, i) => (
            <button
              key={i}
              onClick={() => handleVoteClick(v)}
              className={`card w-full text-left hover:border-vibe-accent/50 transition-colors ${
                selectedVote?.rollCallNumber === v.rollCallNumber &&
                selectedVote?.chamber === v.chamber
                  ? "border-vibe-accent/50"
                  : ""
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
                  <span className="text-xs text-vibe-dim">Click for details →</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {detail.loading && <LoadingRows />}

      {detail.data?.vote && (
        <div className="card border-vibe-accent/30">
          <h3 className="text-sm font-bold mb-1">
            {detail.data.vote.question}
          </h3>
          <p className="text-xs text-vibe-dim mb-3">
            {detail.data.vote.description}
          </p>
          <div className="flex gap-4 mb-4">
            <VoteCount label="Yea" count={detail.data.vote.totalYea} color="vibe-yea" />
            <VoteCount label="Nay" count={detail.data.vote.totalNay} color="vibe-nay" />
            <VoteCount
              label="Not Voting"
              count={detail.data.vote.totalNotVoting}
              color="vibe-dim"
            />
            {(detail.data.vote.totalPresent ?? 0) > 0 && (
              <VoteCount
                label="Present"
                count={detail.data.vote.totalPresent}
                color="vibe-dim"
              />
            )}
          </div>

          {/* Member vote breakdown */}
          {hasMembers ? (
            <div>
              <div className="flex gap-2 mb-3">
                <button
                  onClick={() => setMemberFilter("all")}
                  className={`btn text-xs py-1 ${memberFilter === "all" ? "btn-primary" : "btn-ghost"}`}
                >
                  All ({getMembersByPosition("all").length})
                </button>
                <button
                  onClick={() => setMemberFilter("yea")}
                  className={`btn text-xs py-1 ${memberFilter === "yea" ? "bg-vibe-yea/20 text-vibe-yea border-vibe-yea/30" : "btn-ghost"}`}
                >
                  Yea ({getMembersByPosition("yea").length})
                </button>
                <button
                  onClick={() => setMemberFilter("nay")}
                  className={`btn text-xs py-1 ${memberFilter === "nay" ? "bg-vibe-nay/20 text-vibe-nay border-vibe-nay/30" : "btn-ghost"}`}
                >
                  Nay ({getMembersByPosition("nay").length})
                </button>
                <button
                  onClick={() => setMemberFilter("notVoting")}
                  className={`btn text-xs py-1 ${memberFilter === "notVoting" ? "btn-primary" : "btn-ghost"}`}
                >
                  Not Voting ({getMembersByPosition("notVoting").length})
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 max-h-72 overflow-y-auto">
                {filteredMembers.map((m, i) => {
                  const pos = (m.votePosition ?? "").toLowerCase();
                  const isYea = pos === "yea" || pos === "aye";
                  const isNay = pos === "nay" || pos === "no";
                  return (
                    <div
                      key={i}
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
                          {m.fullName ?? `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim()}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0 ml-2">
                        {m.party && (
                          <span className="text-vibe-dim">{m.party}</span>
                        )}
                        {m.state && (
                          <span className="text-vibe-dim">-{m.state}</span>
                        )}
                        {m.votePosition && memberFilter === "all" && (
                          <span
                            className={`badge text-[10px] ml-1 ${
                              isYea
                                ? "badge-yea"
                                : isNay
                                  ? "badge-nay"
                                  : "bg-vibe-border text-vibe-dim"
                            }`}
                          >
                            {m.votePosition}
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
              Individual member votes not available for this roll call. The totals above come from the Congress.gov API.
            </p>
          )}

          <JsonViewer data={detail.data} label="Full API Response" />
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
      <p className={`text-2xl font-bold text-${color}`}>{count ?? "?"}</p>
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
