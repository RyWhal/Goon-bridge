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

export function BillSearch() {
  const [congress, setCongress] = useState("119");
  const [billType, setBillType] = useState("");
  const [limit, setLimit] = useState("20");
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const list = useApi<BillListResponse>();
  const detail = useApi<BillDetailResponse>();
  const cosponsors = useApi<CosponsorListResponse>();
  const actions = useApi<BillActionsResponse>();

  const handleSearch = () => {
    setExpandedIndex(null);
    const params = new URLSearchParams({ congress, limit, sort: "updateDate+desc" });
    if (billType) params.set("type", billType);
    list.fetchData(`/api/congress/bills?${params.toString()}`);
  };

  const handleBillClick = (bill: BillItem, index: number) => {
    if (expandedIndex === index) {
      setExpandedIndex(null);
      return;
    }

    setExpandedIndex(index);
    const path = resolveBillPath(bill);
    if (!path) return;

    detail.fetchData(path);
    cosponsors.fetchData(`${path}/cosponsors?limit=100`);
    actions.fetchData(`${path}/actions?limit=250`);
  };

  return (
    <div className="space-y-4">
      <div className="card">
        <h2 className="text-sm font-semibold text-vibe-dim uppercase tracking-wider mb-3">
          Bills and Roll Call Votes
        </h2>
        <div className="flex flex-col sm:flex-row gap-2">
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
          <button onClick={handleSearch} className="btn btn-primary">
            Fetch Bills
          </button>
        </div>
        <p className="text-xs text-vibe-dim mt-2">
          Expand a bill to see its public context links, every recorded roll call we can find,
          individual member votes, and cross-party or vote-change callouts.
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
          {list.data.bills.map((bill, index) => {
            const isExpanded = expandedIndex === index;
            const resolved = resolveBillReference(bill) ?? parseBillUrl(bill.url);

            return (
              <div key={`${bill.url ?? formatBillLabel(bill)}-${index}`}>
                <button
                  onClick={() => handleBillClick(bill, index)}
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
                      </div>
                      <p className="text-sm">{bill.title}</p>
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
      <div>
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <h3 className="text-sm font-bold text-vibe-accent">
            {bill.type?.toUpperCase()} {bill.number}
          </h3>
          {bill.congress && (
            <span className="text-xs text-vibe-dim">{bill.congress}th Congress</span>
          )}
          {bill.originChamber && (
            <span className="badge bg-vibe-surface text-vibe-text">{bill.originChamber}</span>
          )}
          {bill.laws?.length ? <span className="badge badge-yea">Became Law</span> : null}
        </div>
        <p className="text-sm font-medium">{bill.title}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-vibe-dim">
          {bill.introducedDate && <span>Introduced: {bill.introducedDate}</span>}
          {bill.updateDate && <span>Updated: {bill.updateDate}</span>}
          {bill.actions?.count != null && <span>{bill.actions.count} total actions</span>}
          {recordedVotes.length > 0 && <span>{recordedVotes.length} recorded vote(s)</span>}
        </div>
      </div>

      {billLinks && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <a
            href={billLinks.detail}
            target="_blank"
            rel="noopener noreferrer"
            className="card p-3 hover:border-vibe-accent/50 transition-colors"
          >
            <p className="text-[10px] text-vibe-dim uppercase tracking-wide">Context</p>
            <p className="text-sm font-medium mt-1">Congress.gov overview</p>
          </a>
          <a
            href={billLinks.text}
            target="_blank"
            rel="noopener noreferrer"
            className="card p-3 hover:border-vibe-accent/50 transition-colors"
          >
            <p className="text-[10px] text-vibe-dim uppercase tracking-wide">Full Text</p>
            <p className="text-sm font-medium mt-1">Read bill text and versions</p>
          </a>
          <a
            href={billLinks.actions}
            target="_blank"
            rel="noopener noreferrer"
            className="card p-3 hover:border-vibe-accent/50 transition-colors"
          >
            <p className="text-[10px] text-vibe-dim uppercase tracking-wide">History</p>
            <p className="text-sm font-medium mt-1">Full action timeline</p>
          </a>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {policyArea && (
          <div className="bg-vibe-surface rounded px-2 py-1.5 col-span-2">
            <p className="text-[10px] text-vibe-dim uppercase tracking-wide">Policy Area</p>
            <p className="text-xs font-medium text-vibe-cosmic">{policyArea}</p>
          </div>
        )}
        {bill.committees?.count != null && (
          <div className="bg-vibe-surface rounded px-2 py-1.5">
            <p className="text-[10px] text-vibe-dim uppercase tracking-wide">Committees</p>
            <p className="text-sm font-bold">{bill.committees.count}</p>
          </div>
        )}
        {totalCosponsors != null && (
          <div className="bg-vibe-surface rounded px-2 py-1.5">
            <p className="text-[10px] text-vibe-dim uppercase tracking-wide">Cosponsors</p>
            <p className="text-sm font-bold">{totalCosponsors}</p>
          </div>
        )}
        {bill.textVersions?.count != null && (
          <div className="bg-vibe-surface rounded px-2 py-1.5">
            <p className="text-[10px] text-vibe-dim uppercase tracking-wide">Text Versions</p>
            <p className="text-sm font-bold">{bill.textVersions.count}</p>
          </div>
        )}
        {bill.summaries?.count != null && (
          <div className="bg-vibe-surface rounded px-2 py-1.5">
            <p className="text-[10px] text-vibe-dim uppercase tracking-wide">Summaries</p>
            <p className="text-sm font-bold">{bill.summaries.count}</p>
          </div>
        )}
      </div>

      {bill.latestAction && (
        <div className="px-3 py-2 bg-vibe-surface rounded border-l-2 border-vibe-accent">
          <p className="text-[10px] text-vibe-dim uppercase tracking-wide mb-0.5">
            Latest Action
          </p>
          <p className="text-xs font-medium">{bill.latestAction.actionDate}</p>
          <p className="text-xs text-vibe-dim mt-0.5">{bill.latestAction.text}</p>
        </div>
      )}

      {sponsors.length > 0 && (
        <div>
          <p className="text-xs text-vibe-dim uppercase tracking-wider mb-2">
            Primary Sponsor{sponsors.length > 1 ? "s" : ""}
          </p>
          <div className="flex flex-wrap gap-1">
            {sponsors.map((sponsor, index) => (
              <span key={`${sponsor.bioguideId ?? sponsor.fullName ?? index}`} className="badge bg-vibe-surface text-vibe-text">
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
          className="flex items-center gap-2 text-xs text-vibe-dim uppercase tracking-wider mb-2 hover:text-vibe-text"
          onClick={() => setShowCosponsors((value) => !value)}
        >
          Cosponsors ({totalCosponsors ?? "?"})
          <span>{showCosponsors ? "▲" : "▼"}</span>
        </button>
        {showCosponsors && finalCosponsors.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 max-h-60 overflow-y-auto">
            {finalCosponsors.map((cosponsor, index) => (
              <div
                key={`${cosponsor.bioguideId ?? cosponsor.fullName ?? index}`}
                className="flex items-center justify-between px-2 py-1 bg-vibe-surface rounded text-xs"
              >
                <span className="font-medium truncate">{cosponsor.fullName}</span>
                <span className="text-vibe-dim shrink-0 ml-2">
                  {[cosponsor.party, cosponsor.state].filter(Boolean).join("-")}
                  {cosponsor.isOriginalCosponsor ? " ★" : ""}
                </span>
              </div>
            ))}
          </div>
        )}
        {showCosponsors && finalCosponsors.length === 0 && (
          <p className="text-xs text-vibe-dim italic">No cosponsor data available.</p>
        )}
      </div>

      {subjects.length > 0 && (
        <div>
          <p className="text-xs text-vibe-dim uppercase tracking-wider mb-2">
            Legislative Subjects
          </p>
          <div className="flex flex-wrap gap-1">
            {subjects.slice(0, 20).map((subject, index) => (
              <span key={`${subject.name ?? "subject"}-${index}`} className="badge bg-vibe-border text-vibe-dim text-xs">
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
      )}

      {bill.cboCostEstimates?.length ? (
        <div className="text-xs text-vibe-dim space-y-1">
          <p className="uppercase tracking-wider">CBO Cost Estimate</p>
          {bill.cboCostEstimates.map((estimate, index) => (
            <div key={`${estimate.description ?? "estimate"}-${index}`}>
              <p>{estimate.description}</p>
              {estimate.url && (
                <a
                  href={estimate.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-vibe-accent hover:underline"
                >
                  Source document
                </a>
              )}
            </div>
          ))}
        </div>
      ) : null}

      <div className="space-y-3">
        <div>
          <h4 className="text-sm font-semibold text-vibe-dim uppercase tracking-wider">
            Recorded Roll Calls
          </h4>
          <p className="text-xs text-vibe-dim mt-1">
            Every action below is a roll call tied to this bill, with who voted Yea, Nay,
            Present, or did not show up.
          </p>
        </div>

        {changeSummaries.length > 0 && (
          <div className="card border-vibe-cosmic/30 bg-vibe-cosmic/5 p-3">
            <p className="text-xs text-vibe-cosmic uppercase tracking-wider mb-2">
              Vote Changers On This Bill
            </p>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {changeSummaries.map((summary) => (
                <div
                  key={summary.memberKey}
                  className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-1 text-xs"
                >
                  <div>
                    <p className="font-medium text-vibe-text">
                      {summary.displayName}
                      {summary.party || summary.state
                        ? ` (${[summary.party, summary.state].filter(Boolean).join("-")})`
                        : ""}
                    </p>
                    <p className="text-vibe-dim">
                      {summary.changes.map((change) => change.position).join(" -> ")}
                    </p>
                  </div>
                  <p className="text-vibe-dim shrink-0">
                    {summary.changes.map((change) => change.voteLabel).join(" • ")}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {recordedVotes.length === 0 && (
          <div className="card border-vibe-border/70 p-3">
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
    <div className="card border-vibe-border/80 p-3 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="badge bg-vibe-surface text-vibe-text">
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
          <p className="text-sm font-medium">
            {detail.data?.vote?.question ?? detail.data?.vote?.description ?? vote.actionText ?? "Roll call vote"}
          </p>
          <p className="text-xs text-vibe-dim mt-1">
            {detail.data?.vote?.date ?? vote.date ?? vote.actionDate ?? "Date unavailable"}
            {vote.sessionNumber ? ` · Session ${vote.sessionNumber}` : ""}
          </p>
          {detail.data?.vote?.description && detail.data.vote.question && (
            <p className="text-xs text-vibe-dim mt-1">{detail.data.vote.description}</p>
          )}
        </div>
        <div className="text-xs text-vibe-dim">
          {detail.loading ? "Loading vote detail..." : `${members.length} recorded member votes`}
        </div>
      </div>

      {detail.error && (
        <div className="card border-vibe-nay/30 p-3">
          <p className="text-sm text-vibe-nay">{detail.error}</p>
        </div>
      )}

      {!detail.error && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
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
            <div className="rounded border border-vibe-money/30 bg-vibe-money/5 px-3 py-2">
              <p className="text-[10px] text-vibe-money uppercase tracking-wide mb-1">
                Across Party Lines
              </p>
              <p className="text-xs text-vibe-dim">
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 max-h-80 overflow-y-auto">
                {members
                  .slice()
                  .sort((a, b) => a.displayName.localeCompare(b.displayName))
                  .map((member) => (
                    <div
                      key={member.bioguideId ?? `${member.displayName}-${member.state ?? "?"}`}
                      className="flex items-center justify-between px-2 py-1 rounded bg-vibe-surface text-xs gap-2"
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
                      <div className="flex items-center gap-1 shrink-0">
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
    <div className="bg-vibe-surface rounded px-2 py-2 text-center">
      <p className={`text-xl font-bold ${colorClass}`}>{count != null ? count : "-"}</p>
      <p className="text-[10px] text-vibe-dim uppercase tracking-wide">{label}</p>
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
