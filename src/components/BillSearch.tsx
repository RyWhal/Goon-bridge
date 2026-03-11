import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { JsonViewer } from "./JsonViewer";

interface BillItem {
  congress?: number;
  type?: string;
  number?: string;
  title?: string;
  latestAction?: { text?: string; actionDate?: string };
  url?: string;
  originChamber?: string;
}

interface BillListResponse {
  bills?: BillItem[];
}

interface BillDetailResponse {
  bill?: {
    congress?: number;
    type?: string;
    number?: string;
    title?: string;
    sponsors?: Array<{ bioguideId?: string; fullName?: string; party?: string; state?: string }>;
    cosponsors?: { count?: number };
    subjects?: { legislativeSubjects?: Array<{ name?: string }> };
    latestAction?: { text?: string; actionDate?: string };
    policyArea?: { name?: string };
  };
}

export function BillSearch() {
  const [congress, setCongress] = useState("119");
  const [billType, setBillType] = useState("");
  const [limit, setLimit] = useState("20");
  const list = useApi<BillListResponse>();
  const detail = useApi<BillDetailResponse>();

  const handleSearch = () => {
    const params = new URLSearchParams({ congress, limit, sort: "updateDate+desc" });
    let url = `/api/congress/bills?${params.toString()}`;
    if (billType) {
      url = `/api/congress/bills?congress=${congress}&limit=${limit}&sort=updateDate+desc`;
    }
    list.fetchData(url);
  };

  const handleBillClick = (b: BillItem) => {
    if (b.congress && b.type && b.number) {
      detail.fetchData(
        `/api/congress/bills/${b.congress}/${b.type.toLowerCase()}/${b.number}`
      );
    }
  };

  return (
    <div className="space-y-4">
      <div className="card">
        <h2 className="text-sm font-semibold text-vibe-dim uppercase tracking-wider mb-3">
          Browse Legislation
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
            value={billType}
            onChange={(e) => setBillType(e.target.value)}
          >
            <option value="">All Types</option>
            <option value="hr">H.R. (House Bill)</option>
            <option value="s">S. (Senate Bill)</option>
            <option value="hjres">H.J.Res (House Joint Resolution)</option>
            <option value="sjres">S.J.Res (Senate Joint Resolution)</option>
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
            Fetch Bills
          </button>
        </div>
      </div>

      {list.loading && <LoadingRows />}

      {list.error && (
        <div className="card border-vibe-nay/30">
          <p className="text-sm text-vibe-nay">{list.error}</p>
        </div>
      )}

      {list.data?.bills && (
        <div className="space-y-2">
          {list.data.bills.map((b, i) => (
            <button
              key={i}
              onClick={() => handleBillClick(b)}
              className="card w-full text-left hover:border-vibe-accent/50 transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-bold text-vibe-accent">
                      {b.type?.toUpperCase()} {b.number}
                    </span>
                    {b.originChamber && (
                      <span className="text-xs text-vibe-dim">
                        {b.originChamber}
                      </span>
                    )}
                  </div>
                  <p className="text-sm">{b.title}</p>
                  {b.latestAction && (
                    <p className="text-xs text-vibe-dim mt-1">
                      {b.latestAction.actionDate}: {b.latestAction.text}
                    </p>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {detail.loading && <LoadingRows />}

      {detail.data?.bill && (
        <div className="card border-vibe-accent/30">
          <h3 className="text-sm font-bold mb-1">
            {detail.data.bill.type?.toUpperCase()} {detail.data.bill.number}
          </h3>
          <p className="text-sm mb-3">{detail.data.bill.title}</p>

          {detail.data.bill.policyArea && (
            <p className="text-xs text-vibe-cosmic mb-2">
              Policy Area: {detail.data.bill.policyArea.name}
            </p>
          )}

          {detail.data.bill.sponsors && detail.data.bill.sponsors.length > 0 && (
            <div className="mb-3">
              <p className="text-xs text-vibe-dim mb-1">Sponsors:</p>
              <div className="flex flex-wrap gap-1">
                {detail.data.bill.sponsors.map((s, i) => (
                  <span key={i} className="badge bg-vibe-border text-vibe-text">
                    {s.fullName} ({s.party}-{s.state})
                  </span>
                ))}
              </div>
            </div>
          )}

          {detail.data.bill.cosponsors && (
            <p className="text-xs text-vibe-dim mb-3">
              {detail.data.bill.cosponsors.count} cosponsors
            </p>
          )}

          <JsonViewer data={detail.data} label="Full API Response" />
        </div>
      )}
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
