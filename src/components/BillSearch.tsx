import { useEffect, useMemo, useState } from "react";
import { useApi } from "../hooks/useApi";
import { JsonViewer } from "./JsonViewer";
import {
  buildBillLinks,
  formatBillLabel,
  formatMemberDisplayName,
  formatVotePositionLabel,
  normalizePartyValue,
  normalizeVotePosition,
  parseBillUrl,
  resolveBillReference,
  type NormalizedVotePosition,
} from "../lib/congress";

interface BillItem {
  congress?: number;
  type?: string;
  number?: string | number;
  title?: string;
  latestAction?: { text?: string; actionDate?: string };
  url?: string;
  originChamber?: string;
  updateDate?: string;
  introducedDate?: string;
  policyArea?: { name?: string };
  sponsor?: {
    bioguideId?: string;
    fullName?: string;
    party?: string;
    state?: string;
  };
  committees?: string[];
  status?: {
    key?: string;
    label?: string;
    step?: number;
    failed?: boolean;
  };
}

interface BillListResponse {
  bills?: BillItem[];
  count?: number;
  notice?: string;
  pagination?: {
    offset?: number;
    limit?: number;
    count?: number;
    hasMore?: boolean;
    filtered?: boolean;
    scanned?: number;
  };
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
    updateDate?: string;
    originChamber?: string;
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
    summaries?: { count?: number; url?: string };
    textVersions?: { count?: number; url?: string };
    url?: string;
  };
}

interface CosponsorListResponse {
  cosponsors?: Cosponsor[];
  pagination?: { count?: number };
}

interface RecordedVoteRef {
  chamber?: string;
  congress?: string | number;
  rollNumber?: string | number;
  sessionNumber?: string | number;
  date?: string;
}

interface BillActionItem {
  actionDate?: string;
  text?: string;
  recordedVotes?: RecordedVoteRef[];
}

interface BillActionsResponse {
  actions?: BillActionItem[];
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
    members?: VoteMember[];
    memberVotes?: {
      Yea?: VoteMember[];
      Nay?: VoteMember[];
      Present?: VoteMember[];
      "Not Voting"?: VoteMember[];
      yea?: VoteMember[];
      nay?: VoteMember[];
      present?: VoteMember[];
      notVoting?: VoteMember[];
    };
  };
}

interface NormalizedVoteMember {
  bioguideId?: string;
  displayName: string;
  party: string | null;
  state?: string;
  rawPosition?: string;
  normalizedPosition: NormalizedVotePosition;
}

interface VoteSnapshot {
  key: string;
  label: string;
  date?: string;
  detail: NonNullable<VoteDetailResponse["vote"]>;
  members: NormalizedVoteMember[];
}

interface VoteChangeSummary {
  memberKey: string;
  displayName: string;
  party: string | null;
  state?: string;
  changes: Array<{
    voteKey: string;
    voteLabel: string;
    position: string;
  }>;
}

function resolveBillPath(bill: BillItem): string | null {
  const resolved = resolveBillReference(bill);
  if (!resolved) return null;
  return `/api/congress/bills/${resolved.congress}/${resolved.type}/${resolved.number}`;
}

function voteRefKey(vote: RecordedVoteRef) {
  return [vote.congress, vote.chamber?.toLowerCase(), vote.rollNumber, vote.sessionNumber]
    .filter(Boolean)
    .join("-");
}

function getVoteTotals(vote?: VoteDetailResponse["vote"]) {
  if (!vote) {
    return { yea: undefined, nay: undefined, present: undefined, notVoting: undefined };
  }

  return {
    yea: vote.totalYea ?? vote.totals?.yea,
    nay: vote.totalNay ?? vote.totals?.nay,
    present: vote.totalPresent ?? vote.totals?.present,
    notVoting:
      vote.totalNotVoting ?? vote.totals?.not_voting ?? vote.totals?.notVoting,
  };
}

function getVoteMembers(vote?: VoteDetailResponse["vote"]): NormalizedVoteMember[] {
  if (!vote) return [];

  if (vote.members?.length) {
    return vote.members.map((member) => ({
      bioguideId: member.bioguideId,
      displayName: formatMemberDisplayName(member),
      party: normalizePartyValue(member.party) ?? member.party ?? null,
      state: member.state,
      rawPosition: member.votePosition ?? member.memberVoted,
      normalizedPosition: normalizeVotePosition(member.votePosition ?? member.memberVoted),
    }));
  }

  if (!vote.memberVotes) return [];

  const groups = [
    { members: vote.memberVotes.Yea ?? vote.memberVotes.yea ?? [], position: "Yea" },
    { members: vote.memberVotes.Nay ?? vote.memberVotes.nay ?? [], position: "Nay" },
    { members: vote.memberVotes.Present ?? vote.memberVotes.present ?? [], position: "Present" },
    {
      members: vote.memberVotes["Not Voting"] ?? vote.memberVotes.notVoting ?? [],
      position: "Not Voting",
    },
  ];

  return groups.flatMap(({ members, position }) =>
    members.map((member) => ({
      bioguideId: member.bioguideId,
      displayName: formatMemberDisplayName(member),
      party: normalizePartyValue(member.party) ?? member.party ?? null,
      state: member.state,
      rawPosition: member.votePosition ?? member.memberVoted ?? position,
      normalizedPosition: normalizeVotePosition(member.votePosition ?? member.memberVoted ?? position),
    }))
  );
}

function getPositionTone(position: NormalizedVotePosition) {
  if (position === "yea") return "badge-yea";
  if (position === "nay") return "badge-nay";
  return "bg-vibe-border text-vibe-dim";
}

function dedupeRecordedVotes(actions?: BillActionItem[]) {
  const entries = (actions ?? []).flatMap((action) =>
    (action.recordedVotes ?? []).map((vote) => ({
      ...vote,
      actionDate: action.actionDate,
      actionText: action.text,
    }))
  );

  const unique = new Map<string, typeof entries[number]>();
  for (const entry of entries) {
    const key = voteRefKey(entry);
    if (!key) continue;
    if (!unique.has(key)) unique.set(key, entry);
  }

  return Array.from(unique.values()).sort((a, b) =>
    (a.date ?? a.actionDate ?? "").localeCompare(b.date ?? b.actionDate ?? "")
  );
}

function getCrossPartyVoters(members: NormalizedVoteMember[]) {
  const partyGroups = new Map<string, NormalizedVoteMember[]>();

  for (const member of members) {
    if (!member.party || member.normalizedPosition === "unknown") continue;
    const current = partyGroups.get(member.party) ?? [];
    current.push(member);
    partyGroups.set(member.party, current);
  }

  const crossers: NormalizedVoteMember[] = [];

  for (const [, partyMembers] of partyGroups) {
    if (partyMembers.length < 3) continue;

    const counts = new Map<NormalizedVotePosition, number>();
    for (const member of partyMembers) {
      counts.set(member.normalizedPosition, (counts.get(member.normalizedPosition) ?? 0) + 1);
    }

    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length < 2 || sorted[0][1] === sorted[1][1]) continue;

    const majorityPosition = sorted[0][0];
    crossers.push(
      ...partyMembers.filter((member) => member.normalizedPosition !== majorityPosition)
    );
  }

  return crossers.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function getVoteChangeSummaries(voteSnapshots: VoteSnapshot[]): VoteChangeSummary[] {
  const chronologicallySorted = [...voteSnapshots].sort((a, b) =>
    (a.date ?? "").localeCompare(b.date ?? "")
  );

  const memberTimelines = new Map<string, VoteChangeSummary>();

  for (const snapshot of chronologicallySorted) {
    for (const member of snapshot.members) {
      if (member.normalizedPosition === "unknown") continue;

      const memberKey = member.bioguideId ?? `${member.displayName}-${member.party ?? "?"}-${member.state ?? "?"}`;
      const existing = memberTimelines.get(memberKey) ?? {
        memberKey,
        displayName: member.displayName,
        party: member.party,
        state: member.state,
        changes: [],
      };

      existing.changes.push({
        voteKey: snapshot.key,
        voteLabel: snapshot.label,
        position: formatVotePositionLabel(member.rawPosition),
      });
      memberTimelines.set(memberKey, existing);
    }
  }

  return [...memberTimelines.values()]
    .filter((timeline) => {
      const positions = new Set(timeline.changes.map((change) => change.position));
      return timeline.changes.length > 1 && positions.size > 1;
    })
    .sort((a, b) => b.changes.length - a.changes.length || a.displayName.localeCompare(b.displayName));
}

const BILL_STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "introduced", label: "Introduced" },
  { value: "passed-house", label: "Passed House" },
  { value: "passed-senate", label: "Passed Senate" },
  { value: "to-president", label: "To President" },
  { value: "became-law", label: "Became Law" },
  { value: "failed-house", label: "Failed House" },
  { value: "failed-senate", label: "Failed Senate" },
  { value: "vetoed", label: "Vetoed" },
  { value: "failed-procedural", label: "Procedural Failure" },
];

const SPONSOR_PARTY_OPTIONS = [
  { value: "", label: "All Sponsor Parties" },
  { value: "D", label: "Democrat" },
  { value: "R", label: "Republican" },
  { value: "I", label: "Independent" },
];

function getBillListKey(bill: BillItem, index: number) {
  const resolved = resolveBillReference(bill) ?? parseBillUrl(bill.url);
  if (resolved) return `${resolved.congress}-${resolved.type}-${resolved.number}`;
  return `${bill.url ?? formatBillLabel(bill)}-${index}`;
}

function getProgressLabels(originChamber?: string) {
  return originChamber?.toLowerCase() === "senate"
    ? ["Introduced", "Passed Senate", "Passed House", "To President", "Became Law"]
    : ["Introduced", "Passed House", "Passed Senate", "To President", "Became Law"];
}

function getStatusTone(status?: BillItem["status"]) {
  if (status?.failed) return "badge-nay";
  if (status?.key === "became-law") return "badge-yea";
  if (status?.key === "to-president") return "bg-vibe-money/20 text-vibe-money";
  if (status?.key === "passed-house" || status?.key === "passed-senate") {
    return "bg-vibe-accent/20 text-vibe-accent";
  }
  return "bg-vibe-border text-vibe-dim";
}

function formatSponsorLabel(sponsor?: BillItem["sponsor"]) {
  if (!sponsor?.fullName) return null;
  const meta = [sponsor.party, sponsor.state].filter(Boolean).join("-");
  return meta ? `${sponsor.fullName} (${meta})` : sponsor.fullName;
}

function BillProgressStepper({ bill }: { bill: BillItem }) {
  const labels = getProgressLabels(bill.originChamber);
  const activeStep = bill.status?.step ?? 0;

  return (
    <div className="grid grid-cols-5 gap-2 mt-3">
      {labels.map((label, index) => {
        const isComplete = index < activeStep || bill.status?.key === "became-law";
        const isCurrent = index === activeStep && bill.status?.key !== "unknown";
        const isFailedStep = Boolean(bill.status?.failed) && index === activeStep;
        const tone = isFailedStep
          ? "border-vibe-nay/40 bg-vibe-nay/10 text-vibe-nay"
          : isCurrent
            ? "border-vibe-accent/40 bg-vibe-accent/10 text-vibe-text"
            : isComplete
              ? "border-vibe-money/30 bg-vibe-money/10 text-vibe-money"
              : "border-vibe-border/60 bg-vibe-bg/25 text-vibe-dim";

        return (
          <div key={label} className={`rounded-md border px-2 py-2 ${tone}`}>
            <p className="text-[10px] uppercase tracking-wide">{label}</p>
          </div>
        );
      })}
    </div>
  );
}

export function BillSearch() {
  const [congress, setCongress] = useState("119");
  const [billType, setBillType] = useState("");
  const [limit, setLimit] = useState("20");
  const [statusFilter, setStatusFilter] = useState("");
  const [latestActionFilter, setLatestActionFilter] = useState("");
  const [sponsorParty, setSponsorParty] = useState("");
  const [sponsorFilter, setSponsorFilter] = useState("");
  const [committeeFilter, setCommitteeFilter] = useState("");
  const [includeVibeData, setIncludeVibeData] = useState<"off" | "placeholder">("off");
  const [offset, setOffset] = useState(0);
  const [expandedBillKey, setExpandedBillKey] = useState<string | null>(null);
  const [submittedFilters, setSubmittedFilters] = useState({
    congress: "119",
    billType: "",
    limit: "20",
    statusFilter: "",
    latestActionFilter: "",
    sponsorParty: "",
    sponsorFilter: "",
    committeeFilter: "",
  });
  const [searchNonce, setSearchNonce] = useState(1);
  const list = useApi<BillListResponse>();
  const detail = useApi<BillDetailResponse>();
  const cosponsors = useApi<CosponsorListResponse>();
  const actions = useApi<BillActionsResponse>();

  useEffect(() => {
    setExpandedBillKey(null);
    const params = new URLSearchParams({
      congress: submittedFilters.congress,
      limit: submittedFilters.limit,
      offset: String(offset),
      sort: "updateDate+desc",
    });
    if (submittedFilters.billType) params.set("type", submittedFilters.billType);
    if (submittedFilters.statusFilter) params.set("status", submittedFilters.statusFilter);
    if (submittedFilters.latestActionFilter) {
      params.set("latestAction", submittedFilters.latestActionFilter);
    }
    if (submittedFilters.sponsorParty) params.set("sponsorParty", submittedFilters.sponsorParty);
    if (submittedFilters.sponsorFilter) params.set("sponsor", submittedFilters.sponsorFilter);
    if (submittedFilters.committeeFilter) params.set("committee", submittedFilters.committeeFilter);
    list.fetchData(`/api/congress/bills?${params.toString()}`);
  }, [list.fetchData, offset, searchNonce, submittedFilters]);

  const handleSearch = () => {
    setOffset(0);
    setSubmittedFilters({
      congress,
      billType,
      limit,
      statusFilter,
      latestActionFilter: latestActionFilter.trim(),
      sponsorParty,
      sponsorFilter: sponsorFilter.trim(),
      committeeFilter: committeeFilter.trim(),
    });
    setSearchNonce((current) => current + 1);
  };

  const handleBillClick = (bill: BillItem, billKey: string) => {
    if (expandedBillKey === billKey) {
      setExpandedBillKey(null);
      return;
    }

    setExpandedBillKey(billKey);
    const path = resolveBillPath(bill);
    if (!path) return;

    detail.fetchData(path);
    cosponsors.fetchData(`${path}/cosponsors?limit=100`);
    actions.fetchData(`${path}/actions?limit=250`);
  };

  const totalCount = list.data?.pagination?.count ?? list.data?.count;
  const pageSize = Number.parseInt(submittedFilters.limit, 10);
  const currentCount = list.data?.bills?.length ?? 0;
  const pageStart = currentCount > 0 ? offset + 1 : 0;
  const pageEnd = offset + currentCount;
  const currentPage = Math.floor(offset / pageSize) + 1;
  const totalPages = totalCount != null && totalCount > 0 ? Math.ceil(totalCount / pageSize) : null;
  const hasMore = Boolean(list.data?.pagination?.hasMore);

  return (
    <div className="space-y-4">
      <div className="card">
        <h2 className="text-sm font-semibold text-vibe-dim uppercase tracking-wider mb-3">
          Bills and Roll Call Votes
        </h2>
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-2">
          <select
            className="select"
            value={congress}
            onChange={(event) => setCongress(event.target.value)}
          >
            <option value="119">119th Congress</option>
            <option value="118">118th Congress</option>
            <option value="117">117th Congress</option>
            <option value="116">116th Congress</option>
          </select>
          <select
            className="select"
            value={billType}
            onChange={(event) => setBillType(event.target.value)}
          >
            <option value="">All Types</option>
            <option value="hr">H.R. (House Bill)</option>
            <option value="s">S. (Senate Bill)</option>
            <option value="hjres">H.J.Res. (House Joint Resolution)</option>
            <option value="sjres">S.J.Res. (Senate Joint Resolution)</option>
            <option value="hres">H.Res. (House Resolution)</option>
            <option value="sres">S.Res. (Senate Resolution)</option>
          </select>
          <select
            className="select"
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
          >
            <option value="10">10 results</option>
            <option value="20">20 results</option>
            <option value="50">50 results</option>
          </select>
          <select
            className="select"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            {BILL_STATUS_OPTIONS.map((option) => (
              <option key={option.value || "all"} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <input
            className="input lg:col-span-2"
            value={latestActionFilter}
            onChange={(event) => setLatestActionFilter(event.target.value)}
            placeholder="Filter latest action text"
          />
          <select
            className="select"
            value={sponsorParty}
            onChange={(event) => setSponsorParty(event.target.value)}
          >
            {SPONSOR_PARTY_OPTIONS.map((option) => (
              <option key={option.value || "all"} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <input
            className="input"
            value={sponsorFilter}
            onChange={(event) => setSponsorFilter(event.target.value)}
            placeholder="Sponsor name"
          />
          <input
            className="input lg:col-span-2"
            value={committeeFilter}
            onChange={(event) => setCommitteeFilter(event.target.value)}
            placeholder="Committee name"
          />
          <div className="section-shell space-y-2 lg:col-span-2">
            <p className="text-[10px] text-vibe-dim uppercase tracking-wide">Vibe Overlay</p>
            <div className="flex flex-wrap gap-3 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={includeVibeData === "off"}
                  onChange={() => setIncludeVibeData("off")}
                />
                <span>Off</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={includeVibeData === "placeholder"}
                  onChange={() => setIncludeVibeData("placeholder")}
                />
                <span>Placeholder</span>
              </label>
            </div>
          </div>
          <button onClick={handleSearch} className="btn btn-primary lg:col-span-2">
            Fetch Bills
          </button>
        </div>
        <p className="text-xs text-vibe-dim mt-2">
          Browse the full Congress.gov bill stream with page controls, workflow status filters,
          sponsor metadata, committee matching, and latest-action search.
        </p>
      </div>

      {includeVibeData === "placeholder" && (
        <div className="section-shell-cosmic">
          <p className="text-xs text-vibe-cosmic uppercase tracking-wider">Vibe Data Placeholder</p>
          <p className="text-sm text-vibe-dim mt-2">
            Reserve space here for Washington weather, lunar phase, astrology, and other daily
            context overlays once we start blending them into the bill list.
          </p>
        </div>
      )}

      {list.loading && <LoadingRows />}

      {list.error && (
        <div className="card border-vibe-nay/30">
          <p className="text-sm text-vibe-nay">{list.error}</p>
        </div>
      )}

      {!list.loading && !list.error && (
        <div className="card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm">
            <p className="font-medium">
              {totalCount != null && totalCount > 0
                ? `Showing ${pageStart}-${pageEnd} of ${totalCount} bills`
                : currentCount > 0
                  ? `Showing ${pageStart}-${pageEnd} bills`
                  : "No bills matched this search"}
            </p>
            <p className="text-xs text-vibe-dim mt-1">
              {totalPages ? `Page ${currentPage} of ${totalPages}` : `Page ${currentPage}`}
              {list.data?.pagination?.filtered
                ? ` · filtered scan across ${list.data.pagination.scanned ?? 0} bills`
                : ""}
            </p>
            {list.data?.notice && <p className="text-xs text-vibe-dim mt-1">{list.data.notice}</p>}
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn btn-ghost"
              onClick={() => setOffset((current) => Math.max(0, current - pageSize))}
              disabled={offset === 0 || list.loading}
            >
              Previous
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => setOffset((current) => current + pageSize)}
              disabled={!hasMore || list.loading}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {!list.loading && !list.error && list.data?.bills && list.data.bills.length === 0 && (
        <div className="card">
          <p className="text-sm text-vibe-dim">No bills matched the current filter set.</p>
        </div>
      )}

      {list.data?.bills && (
        <div className="space-y-2">
          {list.data.bills.map((bill, index) => {
            const billKey = getBillListKey(bill, index);
            const isExpanded = expandedBillKey === billKey;
            const resolved = resolveBillReference(bill) ?? parseBillUrl(bill.url);
            const sponsorLabel = formatSponsorLabel(bill.sponsor);

            return (
              <div key={billKey}>
                <button
                  onClick={() => handleBillClick(bill, billKey)}
                  className={`card w-full text-left hover:border-vibe-accent/50 transition-colors ${
                    isExpanded ? "border-vibe-accent/50" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <span className="text-xs font-bold text-vibe-accent">
                          {formatBillLabel(bill)}
                        </span>
                        {bill.originChamber && (
                          <span className="text-xs text-vibe-dim">{bill.originChamber}</span>
                        )}
                        {resolved?.congress && (
                          <span className="text-xs text-vibe-dim">
                            {resolved.congress}th Congress
                          </span>
                        )}
                        {bill.status?.label && (
                          <span className={`badge ${getStatusTone(bill.status)}`}>
                            {bill.status.label}
                          </span>
                        )}
                      </div>
                      <p className="text-sm">{bill.title}</p>
                      {(sponsorLabel || (bill.committees && bill.committees.length > 0)) && (
                        <div className="flex flex-wrap gap-2 mt-2">
                          {sponsorLabel && (
                            <span className="badge bg-vibe-surface/90 text-vibe-text">
                              Sponsor: {sponsorLabel}
                            </span>
                          )}
                          {(bill.committees ?? []).slice(0, 2).map((committeeName) => (
                            <span
                              key={committeeName}
                              className="badge bg-vibe-border text-vibe-dim"
                            >
                              {committeeName}
                            </span>
                          ))}
                          {(bill.committees?.length ?? 0) > 2 && (
                            <span className="badge bg-vibe-border text-vibe-dim">
                              +{(bill.committees?.length ?? 0) - 2} committees
                            </span>
                          )}
                        </div>
                      )}
                      <BillProgressStepper bill={bill} />
                      {bill.latestAction && (
                        <p className="text-xs text-vibe-dim mt-1">
                          <span className="font-medium">{bill.latestAction.actionDate}:</span>{" "}
                          {bill.latestAction.text}
                        </p>
                      )}
                    </div>
                    <span className="text-xs text-vibe-dim shrink-0">
                      {isExpanded ? "▲" : "▼"}
                    </span>
                  </div>
                </button>

                {isExpanded && (
                  <div className="mt-1 ml-2">
                    {(detail.loading || cosponsors.loading || actions.loading) && <LoadingRows />}

                    {!detail.loading && detail.error && (
                      <div className="card border-vibe-nay/30">
                        <p className="text-sm text-vibe-nay">{detail.error}</p>
                      </div>
                    )}

                    {!detail.loading && detail.data?.bill && (
                      <BillDetailCard
                        bill={detail.data.bill}
                        actions={actions.data?.actions}
                        cosponsorList={cosponsors.data?.cosponsors}
                        cosponsorCount={cosponsors.data?.pagination?.count}
                        rawDetail={detail.data}
                        rawActions={actions.data}
                        rawCosponsors={cosponsors.data}
                      />
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
  actions,
  cosponsorList,
  cosponsorCount,
  rawDetail,
  rawActions,
  rawCosponsors,
}: {
  bill: NonNullable<BillDetailResponse["bill"]>;
  actions?: BillActionItem[];
  cosponsorList?: Cosponsor[];
  cosponsorCount?: number;
  rawDetail: BillDetailResponse;
  rawActions: BillActionsResponse | null;
  rawCosponsors: CosponsorListResponse | null;
}) {
  const [showCosponsors, setShowCosponsors] = useState(false);
  const [voteSnapshots, setVoteSnapshots] = useState<Record<string, VoteSnapshot>>({});

  const billKey = `${bill.congress ?? "?"}-${bill.type ?? "?"}-${bill.number ?? "?"}`;

  useEffect(() => {
    setVoteSnapshots({});
  }, [billKey]);

  const subjects = bill.subjects?.legislativeSubjects ?? [];
  const policyArea = bill.policyArea?.name ?? bill.subjects?.policyArea?.name;
  const sponsors = bill.sponsors ?? [];
  const finalCosponsors = cosponsorList ?? bill.cosponsorList ?? [];
  const totalCosponsors = cosponsorCount ?? bill.cosponsors?.count ?? finalCosponsors.length;
  const billLinks = buildBillLinks(bill);
  const recordedVotes = useMemo(() => dedupeRecordedVotes(actions), [actions]);
  const hasSponsorSection = sponsors.length > 0 || totalCosponsors != null;
  const hasContextSection = subjects.length > 0 || Boolean(bill.cboCostEstimates?.length);
  const changeSummaries = useMemo(
    () => getVoteChangeSummaries(Object.values(voteSnapshots)),
    [voteSnapshots]
  );

  const handleVoteLoaded = (snapshot: VoteSnapshot) => {
    setVoteSnapshots((current) => {
      if (current[snapshot.key]) return current;
      return { ...current, [snapshot.key]: snapshot };
    });
  };

  return (
    <div className="card border-vibe-accent/30 space-y-5">
      <div className="section-shell-accent space-y-4">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <h3 className="text-sm font-bold text-vibe-accent">
              {bill.type?.toUpperCase()} {bill.number}
            </h3>
            {bill.congress && (
              <span className="text-xs text-vibe-dim">{bill.congress}th Congress</span>
            )}
            {bill.originChamber && (
              <span className="badge bg-vibe-surface/90 text-vibe-text">
                {bill.originChamber}
              </span>
            )}
            {bill.laws?.length ? <span className="badge badge-yea">Became Law</span> : null}
          </div>
          <p className="text-xl font-medium leading-tight">{bill.title}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-vibe-dim">
            {bill.introducedDate && <span>Introduced: {bill.introducedDate}</span>}
            {bill.updateDate && <span>Updated: {bill.updateDate}</span>}
            {bill.actions?.count != null && <span>{bill.actions.count} total actions</span>}
            {recordedVotes.length > 0 && <span>{recordedVotes.length} recorded vote(s)</span>}
          </div>
        </div>

        {billLinks && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <a
              href={billLinks.detail}
              target="_blank"
              rel="noopener noreferrer"
              className="section-shell hover:border-vibe-accent/40 transition-colors"
            >
              <p className="text-[10px] text-vibe-dim uppercase tracking-wide">Context</p>
              <p className="text-sm font-medium mt-1">Congress.gov overview</p>
            </a>
            <a
              href={billLinks.text}
              target="_blank"
              rel="noopener noreferrer"
              className="section-shell hover:border-vibe-accent/40 transition-colors"
            >
              <p className="text-[10px] text-vibe-dim uppercase tracking-wide">Full Text</p>
              <p className="text-sm font-medium mt-1">Read bill text and versions</p>
            </a>
            <a
              href={billLinks.actions}
              target="_blank"
              rel="noopener noreferrer"
              className="section-shell hover:border-vibe-accent/40 transition-colors"
            >
              <p className="text-[10px] text-vibe-dim uppercase tracking-wide">History</p>
              <p className="text-sm font-medium mt-1">Full action timeline</p>
            </a>
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {policyArea && (
            <div className="stat-tile col-span-2">
              <p className="text-[10px] text-vibe-dim uppercase tracking-wide">Policy Area</p>
              <p className="text-sm font-medium text-vibe-cosmic mt-1">{policyArea}</p>
            </div>
          )}
          {bill.committees?.count != null && (
            <div className="stat-tile">
              <p className="text-[10px] text-vibe-dim uppercase tracking-wide">Committees</p>
              <p className="text-base font-bold mt-1">{bill.committees.count}</p>
            </div>
          )}
          {totalCosponsors != null && (
            <div className="stat-tile">
              <p className="text-[10px] text-vibe-dim uppercase tracking-wide">Cosponsors</p>
              <p className="text-base font-bold mt-1">{totalCosponsors}</p>
            </div>
          )}
          {bill.textVersions?.count != null && (
            <div className="stat-tile">
              <p className="text-[10px] text-vibe-dim uppercase tracking-wide">Text Versions</p>
              <p className="text-base font-bold mt-1">{bill.textVersions.count}</p>
            </div>
          )}
          {bill.summaries?.count != null && (
            <div className="stat-tile">
              <p className="text-[10px] text-vibe-dim uppercase tracking-wide">Summaries</p>
              <p className="text-base font-bold mt-1">{bill.summaries.count}</p>
            </div>
          )}
        </div>

        {bill.latestAction && (
          <div className="stat-tile border-l-2 border-vibe-accent bg-vibe-accent/[0.04]">
            <p className="text-[10px] text-vibe-dim uppercase tracking-wide mb-1">
              Latest Action
            </p>
            <p className="text-sm font-medium">{bill.latestAction.actionDate}</p>
            <p className="text-xs text-vibe-dim mt-1 leading-relaxed">
              {bill.latestAction.text}
            </p>
          </div>
        )}
      </div>

      {(hasSponsorSection || hasContextSection) && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {hasSponsorSection && (
            <div className="section-shell space-y-4">
              {sponsors.length > 0 && (
                <div>
                  <p className="text-xs text-vibe-dim uppercase tracking-wider mb-2">
                    Primary Sponsor{sponsors.length > 1 ? "s" : ""}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {sponsors.map((sponsor, index) => (
                      <span
                        key={`${sponsor.bioguideId ?? sponsor.fullName ?? index}`}
                        className="badge bg-vibe-surface/90 text-vibe-text"
                      >
                        {sponsor.fullName}
                        {sponsor.party || sponsor.state
                          ? ` (${[sponsor.party, sponsor.state].filter(Boolean).join("-")})`
                          : ""}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <button
                  className="flex items-center gap-2 text-xs text-vibe-dim uppercase tracking-wider hover:text-vibe-text"
                  onClick={() => setShowCosponsors((value) => !value)}
                >
                  Cosponsors ({totalCosponsors ?? "?"})
                  <span>{showCosponsors ? "▲" : "▼"}</span>
                </button>
                {showCosponsors && finalCosponsors.length > 0 && (
                  <div className="list-panel mt-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-60 overflow-y-auto pr-1">
                      {finalCosponsors.map((cosponsor, index) => (
                        <div
                          key={`${cosponsor.bioguideId ?? cosponsor.fullName ?? index}`}
                          className="flex items-center justify-between px-3 py-2 rounded-md border border-vibe-border/60 bg-vibe-bg/35 text-xs gap-2"
                        >
                          <span className="font-medium truncate">{cosponsor.fullName}</span>
                          <span className="text-vibe-dim shrink-0">
                            {[cosponsor.party, cosponsor.state].filter(Boolean).join("-")}
                            {cosponsor.isOriginalCosponsor ? " ★" : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {showCosponsors && finalCosponsors.length === 0 && (
                  <p className="text-xs text-vibe-dim italic mt-3">
                    No cosponsor data available.
                  </p>
                )}
              </div>
            </div>
          )}

          {hasContextSection && (
            <div className="section-shell space-y-4">
              {subjects.length > 0 && (
                <div>
                  <p className="text-xs text-vibe-dim uppercase tracking-wider mb-2">
                    Legislative Subjects
                  </p>
                  <div className="list-panel">
                    <div className="flex flex-wrap gap-2">
                      {subjects.slice(0, 20).map((subject, index) => (
                        <span
                          key={`${subject.name ?? "subject"}-${index}`}
                          className="badge bg-vibe-border text-vibe-dim text-xs"
                        >
                          {subject.name}
                        </span>
                      ))}
                      {subjects.length > 20 && (
                        <span className="badge bg-vibe-border text-vibe-dim text-xs">
                          +{subjects.length - 20} more
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {bill.cboCostEstimates?.length ? (
                <div className="space-y-2">
                  <p className="text-xs text-vibe-dim uppercase tracking-wider">
                    CBO Cost Estimate
                  </p>
                  <div className="list-panel space-y-3">
                    {bill.cboCostEstimates.map((estimate, index) => (
                      <div
                        key={`${estimate.description ?? "estimate"}-${index}`}
                        className="rounded-md border border-vibe-border/60 bg-vibe-bg/35 px-3 py-2 text-xs text-vibe-dim"
                      >
                        <p className="leading-relaxed">{estimate.description}</p>
                        {estimate.url && (
                          <a
                            href={estimate.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-vibe-accent hover:underline inline-block mt-2"
                          >
                            Source document
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}

      <div className="section-shell space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold text-vibe-dim uppercase tracking-wider">
              Recorded Roll Calls
            </h4>
            <p className="text-xs text-vibe-dim mt-1 max-w-3xl leading-relaxed">
              Every action below is a roll call tied to this bill, with who voted Yea, Nay,
              Present, or did not show up.
            </p>
          </div>
          {recordedVotes.length > 0 && (
            <span className="badge bg-vibe-surface/90 text-vibe-text">
              {recordedVotes.length} vote{recordedVotes.length === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {changeSummaries.length > 0 && (
          <div className="section-shell-cosmic">
            <p className="text-xs text-vibe-cosmic uppercase tracking-wider mb-3">
              Vote Changers On This Bill
            </p>
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {changeSummaries.map((summary) => (
                <div
                  key={summary.memberKey}
                  className="rounded-lg border border-vibe-cosmic/15 bg-black/10 px-3 py-2"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-1 text-xs">
                    <div>
                      <p className="font-medium text-vibe-text">
                        {summary.displayName}
                        {summary.party || summary.state
                          ? ` (${[summary.party, summary.state].filter(Boolean).join("-")})`
                          : ""}
                      </p>
                      <p className="text-vibe-dim mt-1">
                        {summary.changes.map((change) => change.position).join(" -> ")}
                      </p>
                    </div>
                    <p className="text-vibe-dim shrink-0">
                      {summary.changes.map((change) => change.voteLabel).join(" • ")}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {recordedVotes.length === 0 && (
          <div className="section-shell">
            <p className="text-sm text-vibe-dim">
              No recorded roll call votes were listed for this bill in the current Congress.gov action history.
            </p>
          </div>
        )}

        {recordedVotes.map((vote) => (
          <RecordedVoteCard
            key={voteRefKey(vote)}
            vote={vote}
            onLoaded={handleVoteLoaded}
          />
        ))}
      </div>

      <JsonViewer
        data={{ detail: rawDetail, actions: rawActions, cosponsors: rawCosponsors }}
        label="Bill API payloads"
      />
    </div>
  );
}

function RecordedVoteCard({
  vote,
  onLoaded,
}: {
  vote: RecordedVoteRef & { actionDate?: string; actionText?: string };
  onLoaded: (snapshot: VoteSnapshot) => void;
}) {
  const detail = useApi<VoteDetailResponse>();
  const key = voteRefKey(vote);

  useEffect(() => {
    if (!vote.congress || !vote.chamber || !vote.rollNumber) return;
    detail.fetchData(
      `/api/congress/votes/${vote.congress}/${vote.chamber.toLowerCase()}/${vote.rollNumber}`
    );
  }, [vote.chamber, vote.congress, vote.rollNumber]);

  const members = useMemo(() => getVoteMembers(detail.data?.vote), [detail.data]);
  const totals = getVoteTotals(detail.data?.vote);
  const crossPartyVoters = useMemo(() => getCrossPartyVoters(members), [members]);

  useEffect(() => {
    if (!detail.data?.vote) return;
    onLoaded({
      key,
      label: `${vote.chamber} #${vote.rollNumber}`,
      date: detail.data.vote.date ?? vote.date ?? vote.actionDate,
      detail: detail.data.vote,
      members,
    });
  }, [detail.data, key, members, onLoaded, vote.actionDate, vote.chamber, vote.date, vote.rollNumber]);

  return (
    <div className="rounded-xl border border-vibe-border/80 bg-vibe-surface/55 overflow-hidden shadow-[0_14px_30px_rgba(0,0,0,0.2)]">
      <div className="px-4 py-3 border-b border-vibe-border/70 bg-vibe-bg/35">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <span className="badge bg-vibe-surface/90 text-vibe-text">
                {vote.chamber} Roll #{vote.rollNumber}
              </span>
              {(detail.data?.vote?.result || vote.actionText) && (
                <span
                  className={`badge ${
                    (detail.data?.vote?.result ?? "").toLowerCase().includes("pass") ||
                    (detail.data?.vote?.result ?? "").toLowerCase().includes("agree")
                      ? "badge-yea"
                      : "badge-nay"
                  }`}
                >
                  {detail.data?.vote?.result ?? "Recorded vote"}
                </span>
              )}
            </div>
            <p className="text-lg font-medium leading-tight">
              {detail.data?.vote?.question ??
                detail.data?.vote?.description ??
                vote.actionText ??
                "Roll call vote"}
            </p>
            <p className="text-xs text-vibe-dim mt-2">
              {detail.data?.vote?.date ?? vote.date ?? vote.actionDate ?? "Date unavailable"}
              {vote.sessionNumber ? ` · Session ${vote.sessionNumber}` : ""}
            </p>
            {detail.data?.vote?.description && detail.data.vote.question && (
              <p className="text-xs text-vibe-dim mt-2 leading-relaxed">
                {detail.data.vote.description}
              </p>
            )}
          </div>
          <div className="text-xs text-vibe-dim shrink-0">
            {detail.loading ? "Loading vote detail..." : `${members.length} recorded member votes`}
          </div>
        </div>
      </div>

      <div className="px-4 py-4 space-y-4">
        {detail.error && (
          <div className="section-shell border-vibe-nay/30">
            <p className="text-sm text-vibe-nay">{detail.error}</p>
          </div>
        )}

        {!detail.error && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <VoteCount label="Yea" count={totals.yea} colorClass="text-vibe-yea" />
              <VoteCount label="Nay" count={totals.nay} colorClass="text-vibe-nay" />
              <VoteCount label="Present" count={totals.present} colorClass="text-vibe-cosmic" />
              <VoteCount
                label="Not Present"
                count={totals.notVoting}
                colorClass="text-vibe-dim"
              />
            </div>

            {crossPartyVoters.length > 0 && (
              <div className="section-shell border-vibe-money/30 bg-vibe-money/[0.05]">
                <p className="text-[10px] text-vibe-money uppercase tracking-wide mb-2">
                  Across Party Lines
                </p>
                <p className="text-xs text-vibe-dim leading-relaxed">
                  {crossPartyVoters
                    .map(
                      (member) =>
                        `${member.displayName} (${[member.party, member.state]
                          .filter(Boolean)
                          .join("-")}, ${formatVotePositionLabel(member.rawPosition)})`
                    )
                    .join("; ")}
                </p>
              </div>
            )}

            {members.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs text-vibe-dim uppercase tracking-wide">Who Voted</p>
                <div className="list-panel">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-80 overflow-y-auto pr-1">
                    {members
                      .slice()
                      .sort((a, b) => a.displayName.localeCompare(b.displayName))
                      .map((member) => (
                        <div
                          key={member.bioguideId ?? `${member.displayName}-${member.state ?? "?"}`}
                          className="flex items-center justify-between px-3 py-2 rounded-md border border-vibe-border/60 bg-vibe-bg/35 text-xs gap-2"
                        >
                          <div className="min-w-0 flex items-center gap-2">
                            <span
                              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                member.normalizedPosition === "yea"
                                  ? "bg-vibe-yea"
                                  : member.normalizedPosition === "nay"
                                    ? "bg-vibe-nay"
                                    : member.normalizedPosition === "present"
                                      ? "bg-vibe-cosmic"
                                      : "bg-vibe-dim"
                              }`}
                            />
                            <span className="font-medium truncate">{member.displayName}</span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {(member.party || member.state) && (
                              <span className="text-vibe-dim">
                                {[member.party, member.state].filter(Boolean).join("-")}
                              </span>
                            )}
                            <span className={`badge ${getPositionTone(member.normalizedPosition)}`}>
                              {formatVotePositionLabel(member.rawPosition)}
                            </span>
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              </div>
            ) : (
              !detail.loading && (
                <p className="text-xs text-vibe-dim italic">
                  Individual member votes were not returned for this roll call.
                </p>
              )
            )}
          </>
        )}
      </div>
    </div>
  );
}

function VoteCount({
  label,
  count,
  colorClass,
}: {
  label: string;
  count?: number;
  colorClass: string;
}) {
  return (
    <div className="stat-tile text-center">
      <p className={`text-xl font-bold ${colorClass}`}>{count != null ? count : "-"}</p>
      <p className="text-[10px] text-vibe-dim uppercase tracking-wide mt-1">{label}</p>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2">
      {[...Array(3)].map((_, index) => (
        <div key={index} className="card">
          <div className="shimmer h-4 w-64 mb-2" />
          <div className="shimmer h-3 w-40" />
        </div>
      ))}
    </div>
  );
}
