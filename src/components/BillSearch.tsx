import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { JsonViewer } from "./JsonViewer";

interface BillItem {
  congress?: number;
  type?: string;
  number?: string | number;
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
    number?: string | number;
    title?: string;
    introducedDate?: string;
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
    laws?: Array<{ number?: string; type?: string }>;
    url?: string;
  };
}

interface CosponsorListResponse {
  cosponsors?: Cosponsor[];
  pagination?: { count?: number };
}

/** Extract congress/type/number from a Congress.gov bill URL.
 *  e.g. https://api.congress.gov/v3/bill/119/hr/1234?format=json */
function parseBillUrl(url?: string): { congress: string; type: string; number: string } | null {
  if (!url) return null;
  const m = url.match(/\/bill\/(\d+)\/(\w+)\/(\w+)/i);
  if (!m) return null;
  return { congress: m[1], type: m[2], number: m[3] };
}

/** Resolve the API path for a bill, falling back to URL parsing if direct fields are absent. */
function resolveBillPath(b: BillItem): string | null {
  const congress = b.congress ? String(b.congress) : null;
  const type = b.type ?? null;
  const number = b.number != null ? String(b.number) : null;

  if (congress && type && number) {
    return `/api/congress/bills/${congress}/${type.toLowerCase()}/${number}`;
  }

  // Fallback: parse from the URL field that Congress.gov always includes
  const parsed = parseBillUrl(b.url);
  if (parsed) {
    return `/api/congress/bills/${parsed.congress}/${parsed.type.toLowerCase()}/${parsed.number}`;
  }

  return null;
}

/** Display label for a bill (type + number), falling back to URL parsing. */
function billLabel(b: BillItem): string {
  const type = b.type?.toUpperCase();
  const num = b.number != null ? String(b.number) : null;
  if (type && num) return `${type} ${num}`;
  const parsed = parseBillUrl(b.url);
  if (parsed) return `${parsed.type.toUpperCase()} ${parsed.number}`;
  return "Bill";
}

export function BillSearch() {
  const [congress, setCongress] = useState("119");
  const [billType, setBillType] = useState("");
  const [limit, setLimit] = useState("20");
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const list = useApi<BillListResponse>();
  const detail = useApi<BillDetailResponse>();
  const cosponsors = useApi<CosponsorListResponse>();

  const handleSearch = () => {
    setExpandedIndex(null);
    const params = new URLSearchParams({ congress, limit, sort: "updateDate+desc" });
    if (billType) params.set("type", billType);
    list.fetchData(`/api/congress/bills?${params.toString()}`);
  };

  const handleBillClick = (b: BillItem, idx: number) => {
    if (expandedIndex === idx) {
      setExpandedIndex(null);
      return;
    }
    setExpandedIndex(idx);

    const path = resolveBillPath(b);
    if (path) {
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
        <p className="text-xs text-vibe-dim mt-2">
          Click a bill to expand full details inline.
        </p>
      </div>

      {list.loading && <LoadingRows />}

      {list.error && (
        <div className="card border-vibe-nay/30">
          <p className="text-sm text-vibe-nay">{list.error}</p>
        </div>
      )}

      {list.data?.bills && (
        <div className="space-y-2">
          {list.data.bills.map((b, i) => {
            const isExpanded = expandedIndex === i;
            return (
              <div key={i}>
                {/* Bill row */}
                <button
                  onClick={() => handleBillClick(b, i)}
                  className={`card w-full text-left hover:border-vibe-accent/50 transition-colors ${
                    isExpanded ? "border-vibe-accent/50" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-bold text-vibe-accent">
                          {billLabel(b)}
                        </span>
                        {b.originChamber && (
                          <span className="text-xs text-vibe-dim">
                            {b.originChamber}
                          </span>
                        )}
                        {(b.congress ?? parseBillUrl(b.url)?.congress) && (
                          <span className="text-xs text-vibe-dim">
                            {b.congress ?? parseBillUrl(b.url)?.congress}th Congress
                          </span>
                        )}
                      </div>
                      <p className="text-sm">{b.title}</p>
                      {b.latestAction && (
                        <p className="text-xs text-vibe-dim mt-1">
                          <span className="font-medium">
                            {b.latestAction.actionDate}:
                          </span>{" "}
                          {b.latestAction.text}
                        </p>
                      )}
                    </div>
                    <span className="text-xs text-vibe-dim shrink-0">
                      {isExpanded ? "▲" : "▼"}
                    </span>
                  </div>
                </button>

                {/* Inline detail */}
                {isExpanded && (
                  <div className="mt-1 ml-2">
                    {(detail.loading || cosponsors.loading) && <LoadingRows />}

                    {!detail.loading && detail.error && (
                      <div className="card border-vibe-nay/30">
                        <p className="text-sm text-vibe-nay">{detail.error}</p>
                      </div>
                    )}

                    {!detail.loading && detail.data?.bill && (
                      <BillDetailCard
                        bill={detail.data.bill}
                        cosponsorList={cosponsors.data?.cosponsors}
                        cosponsorCount={cosponsors.data?.pagination?.count}
                        rawDetail={detail.data}
                        rawCosponsors={cosponsors.data}
                      />
                    )}

                    {!detail.loading && !detail.error && !detail.data?.bill && (
                      <div className="card">
                        <p className="text-xs text-vibe-dim italic">
                          No detail data returned. Check the JSON viewer below.
                        </p>
                        <JsonViewer data={detail.data} label="Raw API Response" />
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
  const totalCosponsors = cosponsorCount ?? bill.cosponsors?.count ?? cosponsorFinal.length;

  return (
    <div className="card border-vibe-accent/30">
      {/* Header */}
      <div className="mb-3">
        <div className="flex items-center gap-2 mb-1">
          <h3 className="text-sm font-bold text-vibe-accent">
            {bill.type?.toUpperCase()} {bill.number}
          </h3>
          {bill.congress && (
            <span className="text-xs text-vibe-dim">{bill.congress}th Congress</span>
          )}
          {bill.laws && bill.laws.length > 0 && (
            <span className="badge badge-yea text-xs">Became Law</span>
          )}
        </div>
        <p className="text-sm font-medium">{bill.title}</p>
        {bill.introducedDate && (
          <p className="text-xs text-vibe-dim mt-1">Introduced: {bill.introducedDate}</p>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        {policyArea && (
          <div className="bg-vibe-surface rounded px-2 py-1.5 col-span-2">
            <p className="text-[10px] text-vibe-dim uppercase tracking-wide">
              Policy Area
            </p>
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
            <p className="text-[10px] text-vibe-dim uppercase tracking-wide">
              Committees
            </p>
            <p className="text-sm font-bold">{bill.committees.count}</p>
          </div>
        )}
      </div>

      {/* Latest action */}
      {bill.latestAction && (
        <div className="mb-4 px-3 py-2 bg-vibe-surface rounded border-l-2 border-vibe-accent">
          <p className="text-[10px] text-vibe-dim uppercase tracking-wide mb-0.5">
            Latest Action
          </p>
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

      {/* Cosponsors (collapsible) */}
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
              <div
                key={i}
                className="flex items-center justify-between px-2 py-1 bg-vibe-surface rounded text-xs"
              >
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
          <p className="text-xs text-vibe-dim italic">
            No cosponsor data available.
          </p>
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

      {/* CBO estimates */}
      {bill.cboCostEstimates && bill.cboCostEstimates.length > 0 && (
        <div className="mb-4 text-xs text-vibe-dim">
          <p className="uppercase tracking-wider mb-1">CBO Cost Estimate</p>
          {bill.cboCostEstimates.map((e, i) => (
            <p key={i}>{e.description}</p>
          ))}
        </div>
      )}

      <JsonViewer
        data={{ bill: rawDetail.bill, cosponsors: rawCosponsors }}
        label="Full API Response"
      />
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
