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
  };
}

export function VoteSearch() {
  const [congress, setCongress] = useState("119");
  const [chamber, setChamber] = useState("");
  const [limit, setLimit] = useState("20");
  const list = useApi<VoteListResponse>();
  const detail = useApi<VoteDetailResponse>();

  const handleSearch = () => {
    const params = new URLSearchParams({ congress, limit });
    if (chamber) params.set("chamber", chamber);
    list.fetchData(`/api/congress/votes?${params.toString()}`);
  };

  const handleVoteClick = (v: VoteItem) => {
    if (v.congress && v.chamber && v.rollCallNumber) {
      detail.fetchData(
        `/api/congress/votes/${v.congress}/${v.chamber.toLowerCase()}/${v.rollCallNumber}`
      );
    }
  };

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
            <option value="117">117th Congress</option>
            <option value="116">116th Congress</option>
          </select>
          <select
            className="select"
            value={chamber}
            onChange={(e) => setChamber(e.target.value)}
          >
            <option value="">Both Chambers</option>
            <option value="house">House</option>
            <option value="senate">Senate</option>
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

      {list.data?.votes && (
        <div className="space-y-2">
          {list.data.votes.map((v, i) => (
            <button
              key={i}
              onClick={() => handleVoteClick(v)}
              className="card w-full text-left hover:border-vibe-accent/50 transition-colors"
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
              </div>
            </button>
          ))}
        </div>
      )}

      {detail.loading && <LoadingRows />}

      {detail.data?.vote && (
        <div className="card border-vibe-accent/30">
          <h3 className="text-sm font-bold mb-2">
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
          </div>
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
