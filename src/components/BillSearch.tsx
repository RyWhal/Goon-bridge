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
  updateDate?: string;
}

interface BillListResponse {
  bills?: BillItem[];
}

interface Cosponsor {
  bioguideId?: string;
  fullName?: string;
  party?: string;
  state?: string;
  district?: number;
  sponsorshipDate?: string;
  isOriginalCosponsor?: boolean;
}

interface BillDetailResponse {
  bill?: {
    congress?: number;
    type?: string;
    number?: string;
    title?: string;
    introducedDate?: string;
    constitutionalAuthorityStatementText?: string;
    sponsors?: Array<{
      bioguideId?: string;
      fullName?: string;
      party?: string;
      state?: string;
      district?: number;
    }>;
    cosponsors?: { count?: number; url?: string };
    cosponsorList?: Cosponsor[];
    subjects?: {
      legislativeSubjects?: Array<{ name?: string }>;
      policyArea?: { name?: string };
    };
    latestAction?: { text?: string; actionDate?: string };
    policyArea?: { name?: string };
    cboCostEstimates?: Array<{ description?: string; url?: string }>;
    committees?: { count?: number };
    actions?: { count?: number };
    summaries?: { count?: number };
    relatedBills?: { count?: number };
    laws?: Array<{ number?: string; type?: string }>;
    url?: string;
  };
}

interface CosponsorListResponse {
  cosponsors?: Cosponsor[];
  pagination?: { count?: number };
}

export function BillSearch() {
  const [congress, setCongress] = useState("119");
  const [billType, setBillType] = useState("");
  const [limit, setLimit] = useState("20");
  const [selectedBill, setSelectedBill] = useState<BillItem | null>(null);
  const list = useApi<BillListResponse>();
  const detail = useApi<BillDetailResponse>();
  const cosponsors = useApi<CosponsorListResponse>();

  const handleSearch = () => {
    const params = new URLSearchParams({ congress, limit, sort: "updateDate+desc" });
    if (billType) params.set("type", billType);
    list.fetchData(`/api/congress/bills?${params.toString()}`);
    setSelectedBill(null);
  };

  const handleBillClick = (b: BillItem) => {
    setSelectedBill(b);
    if (b.congress && b.type && b.number) {
      const path = `/api/congress/bills/${b.congress}/${b.type.toLowerCase()}/${b.number}`;
      detail.fetchData(path);
      cosponsors.fetchData(`${path}/cosponsors?limit=50`);
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
              className={`card w-full text-left hover:border-vibe-accent/50 transition-colors ${
                selectedBill?.type === b.type && selectedBill?.number === b.number
                  ? "border-vibe-accent/50"
                  : ""
              }`}
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
                    {b.congress && (
                      <span className="text-xs text-vibe-dim">
                        {b.congress}th Congress
                      </span>
                    )}
                  </div>
                  <p className="text-sm">{b.title}</p>
                  {b.latestAction && (
                    <p className="text-xs text-vibe-dim mt-1">
                      <span className="font-medium">{b.latestAction.actionDate}:</span>{" "}
                      {b.latestAction.text}
                    </p>
                  )}
                </div>
                <span className="text-xs text-vibe-dim shrink-0">Details →</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {(detail.loading || cosponsors.loading) && <LoadingRows />}

      {detail.data?.bill && (
        <BillDetailCard
          bill={detail.data.bill}
          cosponsorList={cosponsors.data?.cosponsors}
          cosponsorCount={cosponsors.data?.pagination?.count}
          rawDetail={detail.data}
          rawCosponsors={cosponsors.data}
        />
      )}
    </div>
  );
}

function BillDetailCard({
  bill,
  cosponsorList,
  cosponsorCount,
  rawDetail,
  rawCosponsors,
}: {
  bill: NonNullable<BillDetailResponse["bill"]>;
  cosponsorList?: Cosponsor[];
  cosponsorCount?: number;
  rawDetail: BillDetailResponse;
  rawCosponsors: CosponsorListResponse | null;
}) {
  const [showCosponsors, setShowCosponsors] = useState(false);

  const subjects = bill.subjects?.legislativeSubjects ?? [];
  const policyArea = bill.policyArea?.name ?? bill.subjects?.policyArea?.name;
  const sponsors = bill.sponsors ?? [];
  const cosponsorFinal = cosponsorList ?? bill.cosponsorList ?? [];
  const totalCosponsors =
    cosponsorCount ?? bill.cosponsors?.count ?? cosponsorFinal.length;

  return (
    <div className="card border-vibe-accent/30">
      {/* Bill header */}
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-bold text-vibe-accent">
              {bill.type?.toUpperCase()} {bill.number}
            </h3>
            {bill.congress && (
              <span className="text-xs text-vibe-dim">
                {bill.congress}th Congress
              </span>
            )}
            {bill.laws && bill.laws.length > 0 && (
              <span className="badge bg-vibe-yea/20 text-vibe-yea text-xs">
                Became Law
              </span>
            )}
          </div>
          <p className="text-sm font-medium">{bill.title}</p>
          {bill.introducedDate && (
            <p className="text-xs text-vibe-dim mt-1">
              Introduced: {bill.introducedDate}
            </p>
          )}
        </div>
      </div>

      {/* Status row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        {policyArea && (
          <div className="bg-vibe-surface rounded px-2 py-1.5 col-span-2">
            <p className="text-[10px] text-vibe-dim uppercase tracking-wide">Policy Area</p>
            <p className="text-xs font-medium text-vibe-cosmic">{policyArea}</p>
          </div>
        )}
        {bill.actions?.count != null && (
          <div className="bg-vibe-surface rounded px-2 py-1.5">
            <p className="text-[10px] text-vibe-dim uppercase tracking-wide">Actions</p>
            <p className="text-sm font-bold">{bill.actions.count}</p>
          </div>
        )}
        {bill.committees?.count != null && (
          <div className="bg-vibe-surface rounded px-2 py-1.5">
            <p className="text-[10px] text-vibe-dim uppercase tracking-wide">Committees</p>
            <p className="text-sm font-bold">{bill.committees.count}</p>
          </div>
        )}
      </div>

      {/* Latest action */}
      {bill.latestAction && (
        <div className="mb-4 px-3 py-2 bg-vibe-surface rounded border-l-2 border-vibe-accent">
          <p className="text-[10px] text-vibe-dim uppercase tracking-wide mb-0.5">Latest Action</p>
          <p className="text-xs font-medium">{bill.latestAction.actionDate}</p>
          <p className="text-xs text-vibe-dim mt-0.5">{bill.latestAction.text}</p>
        </div>
      )}

      {/* Sponsors */}
      {sponsors.length > 0 && (
        <div className="mb-4">
          <p className="text-xs text-vibe-dim uppercase tracking-wider mb-2">
            Primary Sponsor{sponsors.length > 1 ? "s" : ""}
          </p>
          <div className="flex flex-wrap gap-1">
            {sponsors.map((s, i) => (
              <span key={i} className="badge bg-vibe-surface text-vibe-text">
                {s.fullName}
                {s.party || s.state
                  ? ` (${[s.party, s.state].filter(Boolean).join("-")})`
                  : ""}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Cosponsors */}
      <div className="mb-4">
        <button
          className="flex items-center gap-2 text-xs text-vibe-dim uppercase tracking-wider mb-2 hover:text-vibe-text"
          onClick={() => setShowCosponsors((v) => !v)}
        >
          Cosponsors ({totalCosponsors ?? "?"})
          <span>{showCosponsors ? "▲" : "▼"}</span>
        </button>
        {showCosponsors && cosponsorFinal.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 max-h-60 overflow-y-auto">
            {cosponsorFinal.map((c, i) => (
              <div key={i} className="flex items-center justify-between px-2 py-1 bg-vibe-surface rounded text-xs">
                <span className="font-medium truncate">{c.fullName}</span>
                <span className="text-vibe-dim shrink-0 ml-2">
                  {c.party}-{c.state}
                  {c.isOriginalCosponsor ? " ★" : ""}
                </span>
              </div>
            ))}
          </div>
        )}
        {showCosponsors && cosponsorFinal.length === 0 && (
          <p className="text-xs text-vibe-dim italic">No cosponsor data available.</p>
        )}
      </div>

      {/* Legislative subjects */}
      {subjects.length > 0 && (
        <div className="mb-4">
          <p className="text-xs text-vibe-dim uppercase tracking-wider mb-2">
            Legislative Subjects
          </p>
          <div className="flex flex-wrap gap-1">
            {subjects.slice(0, 20).map((s, i) => (
              <span key={i} className="badge bg-vibe-border text-vibe-dim text-xs">
                {s.name}
              </span>
            ))}
            {subjects.length > 20 && (
              <span className="badge bg-vibe-border text-vibe-dim text-xs">
                +{subjects.length - 20} more
              </span>
            )}
          </div>
        </div>
      )}

      {/* CBO cost estimate */}
      {bill.cboCostEstimates && bill.cboCostEstimates.length > 0 && (
        <div className="mb-4 text-xs text-vibe-dim">
          <p className="uppercase tracking-wider mb-1">CBO Cost Estimate</p>
          {bill.cboCostEstimates.map((e, i) => (
            <p key={i}>{e.description}</p>
          ))}
        </div>
      )}

      <JsonViewer data={{ bill: rawDetail.bill, cosponsors: rawCosponsors }} label="Full API Response" />
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
