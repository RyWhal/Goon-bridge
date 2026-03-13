export interface MemberVoteRecord {
  congress?: number;
  rollCallNumber: number;
  date: string | null;
  question: string | null;
  description: string | null;
  result: string | null;
  position: string;
  chamber: string;
  bill?: {
    congress: string;
    type: string;
    number: string;
    title?: string | null;
    policyArea?: string | null;
    apiUrl?: string;
  };
}

export interface MemberVoteStats {
  bioguide_id: string;
  total_votes: number;
  yea_votes: number;
  nay_votes: number;
  present_votes: number;
  not_voting_votes: number;
  unknown_votes: number;
  attended_votes: number;
  attendance_rate: number;
  house_votes: number;
  senate_votes: number;
  first_vote_date: string | null;
  last_vote_date: string | null;
  first_congress: number | null;
  last_congress: number | null;
  updated_at?: string;
}

export function normalizeVotePosition(value?: string | null) {
  const lower = (value ?? "").trim().toLowerCase();
  if (lower === "yea" || lower === "aye" || lower === "yes") return "yea";
  if (lower === "nay" || lower === "no") return "nay";
  if (lower === "present") return "present";
  if (
    lower === "not voting" ||
    lower === "not present" ||
    lower === "absent" ||
    lower === "no vote"
  ) {
    return "not-voting";
  }
  return "unknown";
}

export function summarizeMemberVotes(
  bioguideId: string,
  votes: MemberVoteRecord[],
  updatedAt?: string
): MemberVoteStats {
  let yeaVotes = 0;
  let nayVotes = 0;
  let presentVotes = 0;
  let notVotingVotes = 0;
  let unknownVotes = 0;
  let houseVotes = 0;
  let senateVotes = 0;
  let firstCongress: number | null = null;
  let lastCongress: number | null = null;
  let firstVoteDate: string | null = null;
  let lastVoteDate: string | null = null;

  for (const vote of votes) {
    const normalizedPosition = normalizeVotePosition(vote.position);
    if (normalizedPosition === "yea") yeaVotes += 1;
    else if (normalizedPosition === "nay") nayVotes += 1;
    else if (normalizedPosition === "present") presentVotes += 1;
    else if (normalizedPosition === "not-voting") notVotingVotes += 1;
    else unknownVotes += 1;

    const chamber = vote.chamber.trim().toLowerCase();
    if (chamber === "house") houseVotes += 1;
    if (chamber === "senate") senateVotes += 1;

    const voteCongress =
      vote.congress != null
        ? vote.congress
        : vote.bill?.congress != null
          ? Number.parseInt(vote.bill.congress, 10)
          : Number.NaN;
    if (Number.isFinite(voteCongress)) {
      firstCongress = firstCongress == null ? voteCongress : Math.min(firstCongress, voteCongress);
      lastCongress = lastCongress == null ? voteCongress : Math.max(lastCongress, voteCongress);
    }

    if (vote.date) {
      if (firstVoteDate == null || vote.date < firstVoteDate) firstVoteDate = vote.date;
      if (lastVoteDate == null || vote.date > lastVoteDate) lastVoteDate = vote.date;
    }
  }

  const totalVotes = votes.length;
  const attendedVotes = yeaVotes + nayVotes + presentVotes;

  return {
    bioguide_id: bioguideId,
    total_votes: totalVotes,
    yea_votes: yeaVotes,
    nay_votes: nayVotes,
    present_votes: presentVotes,
    not_voting_votes: notVotingVotes,
    unknown_votes: unknownVotes,
    attended_votes: attendedVotes,
    attendance_rate: totalVotes > 0 ? attendedVotes / totalVotes : 0,
    house_votes: houseVotes,
    senate_votes: senateVotes,
    first_vote_date: firstVoteDate,
    last_vote_date: lastVoteDate,
    first_congress: firstCongress,
    last_congress: lastCongress,
    updated_at: updatedAt,
  };
}
