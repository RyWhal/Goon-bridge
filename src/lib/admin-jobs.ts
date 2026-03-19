export interface JobConfig {
  id: string;
  label: string;
  description: string;
  endpoint: string;
  method?: string;
  params?: ParamDef[];
  emphasis?: "primary" | "advanced";
  helperText?: string;
}

export interface ParamDef {
  name: string;
  label: string;
  type: "text" | "date" | "number" | "select";
  required?: boolean;
  placeholder?: string;
  options?: { value: string; label: string }[];
}

export const DISCLOSURE_JOBS: JobConfig[] = [
  {
    id: "import-house",
    label: "Import House Disclosures",
    description: "Run the normal House PTR import for a date window.",
    helperText: "Use this for day-to-day House disclosure ingestion.",
    endpoint: "/api/disclosures/refresh/house",
    emphasis: "primary",
    params: [
      { name: "from", label: "From", type: "date", required: true },
      { name: "to", label: "To", type: "date", required: true },
      { name: "limit", label: "Limit", type: "number", placeholder: "500" },
    ],
  },
  {
    id: "import-senate",
    label: "Import Senate Disclosures",
    description: "Run the normal Senate disclosure import for a date window.",
    helperText: "Use this for day-to-day Senate disclosure ingestion.",
    endpoint: "/api/disclosures/refresh/senate",
    emphasis: "primary",
    params: [
      { name: "from", label: "From", type: "date", required: true },
      { name: "to", label: "To", type: "date", required: true },
      { name: "limit", label: "Limit", type: "number", placeholder: "500" },
    ],
  },
  {
    id: "backfill",
    label: "Bulk Backfill",
    description: "Catch up a larger historical date range for one chamber.",
    helperText: "Use this when the dataset is behind, not for normal daily imports.",
    endpoint: "/api/disclosures/backfill",
    emphasis: "advanced",
    params: [
      {
        name: "chamber",
        label: "Chamber",
        type: "select",
        required: true,
        options: [
          { value: "senate", label: "Senate" },
          { value: "house", label: "House" },
        ],
      },
      { name: "from", label: "From", type: "date", required: true },
      { name: "to", label: "To", type: "date", required: true },
      { name: "limit", label: "Limit", type: "number", placeholder: "500" },
    ],
  },
  {
    id: "normalize-trades",
    label: "Reprocess Filing",
    description: "Re-run trade normalization for one known filing.",
    helperText: "Use this to repair or re-enrich a filing that already exists in the database.",
    endpoint: "/api/disclosures/normalize/trades",
    emphasis: "advanced",
    params: [
      { name: "filing_id", label: "Filing ID", type: "number", required: true },
    ],
  },
];

export const CORRELATION_JOBS: JobConfig[] = [
  {
    id: "refresh-organizations",
    label: "Refresh Organizations",
    description: "Ingest contribution data into organization records",
    endpoint: "/api/correlation/refresh/organizations",
    params: [
      { name: "bioguide_id", label: "Bioguide ID", type: "text", placeholder: "optional" },
      { name: "candidate_id", label: "Candidate ID", type: "text", placeholder: "optional" },
      { name: "limit", label: "Limit", type: "number", placeholder: "500" },
    ],
  },
  {
    id: "refresh-org-activity",
    label: "Refresh Org Activity",
    description: "Fetch lobbying & contract data for an organization by ticker",
    endpoint: "/api/correlation/refresh/organization/{symbol}/activity",
    params: [
      { name: "symbol", label: "Ticker Symbol", type: "text", required: true, placeholder: "AAPL" },
      { name: "from", label: "From", type: "date", required: true },
      { name: "to", label: "To", type: "date", required: true },
    ],
  },
  {
    id: "refresh-member-committees",
    label: "Refresh Member Committees",
    description: "Update committee assignments for a member",
    endpoint: "/api/correlation/refresh/member/{bioguideId}/committees",
    params: [
      { name: "bioguideId", label: "Bioguide ID", type: "text", required: true },
    ],
  },
  {
    id: "refresh-member-cases",
    label: "Refresh Member Cases",
    description: "Materialize correlation cases for a single member",
    endpoint: "/api/correlation/refresh/member/{bioguideId}/cases",
    params: [
      { name: "bioguideId", label: "Bioguide ID", type: "text", required: true },
    ],
  },
  {
    id: "refresh-all-cases",
    label: "Refresh All Cases",
    description: "Batch materialize cases for all members with trade activity",
    endpoint: "/api/correlation/refresh/cases/all",
    params: [
      { name: "limit", label: "Limit", type: "number", placeholder: "50" },
      { name: "offset", label: "Offset", type: "number", placeholder: "0" },
    ],
  },
];

export const CONGRESS_JOBS: JobConfig[] = [
  {
    id: "warm-bills-cache",
    label: "Warm Bills Cache",
    description: "Fetch recent Congress.gov bill pages and upsert them into Supabase",
    endpoint: "/api/congress/refresh/bills",
    params: [
      { name: "congress", label: "Congress", type: "number", placeholder: "119" },
      { name: "type", label: "Bill Type", type: "text", placeholder: "optional (hr, s, hres)" },
      { name: "pageSize", label: "Page Size", type: "number", placeholder: "100" },
      { name: "maxPages", label: "Max Pages", type: "number", placeholder: "5" },
      {
        name: "sort",
        label: "Sort",
        type: "select",
        options: [
          { value: "updateDate+desc", label: "Updated desc" },
          { value: "introducedDate+desc", label: "Introduced desc" },
          { value: "updateDate+asc", label: "Updated asc" },
          { value: "introducedDate+asc", label: "Introduced asc" },
        ],
      },
    ],
  },
];

export function getDisclosurePrimaryJobs() {
  return DISCLOSURE_JOBS.filter((job) => job.emphasis === "primary");
}

export function getDisclosureAdvancedJobs() {
  return DISCLOSURE_JOBS.filter((job) => job.emphasis === "advanced");
}
