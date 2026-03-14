# USAspending Implementation Plan

## Goal

Replace the current minimal contract-award integration with a broader USAspending-backed data layer that supports:

- Better recipient/entity matching
- Award and transaction timelines around votes
- District and geography correlations
- Sector and oversight analysis
- Drill-down on specific awards, funding, and contract vehicles
- Bulk backfills for reproducible analysis

This plan assumes the existing stack:

- Frontend: React + TypeScript
- API: Cloudflare Worker (Hono)
- Persistence: Supabase

## Current State

The project now uses direct USAspending contract award search for the corporation view, but only in a narrow way:

- `search/spending_by_award` is used for recent contract-award display
- Matching is still primarily company-name based
- There is no recipient resolution layer
- There is no transaction-level or district-level USAspending ingestion
- There is no warehousing/backfill path for large historical loads

## Guiding Principles

1. Resolve entities first, then search spending.
2. Prefer durable identifiers over names whenever possible.
3. Separate interactive endpoints from bulk ingestion endpoints.
4. Keep UI response shapes stable where possible, but persist richer raw payloads.
5. Build the district and committee-correlation model only after recipient and transaction identity are reliable.

## Phase 1: Foundation

### 1. Recipient Resolution Layer

Endpoints:

- `/api/v2/autocomplete/recipient/`
- `/api/v2/recipient/`

Why:

- Current company-name matching is serviceable but not durable.
- USAspending recipient IDs give you a stable join key for awards, transactions, subawards, and geography.

Implementation:

- Add Worker routes under `/api/usaspending/recipients/*`.
- Accept `q`, `ticker`, `company`, and optional `limit`.
- Return normalized candidates with:
  - `recipient_id`
  - `recipient_name`
  - `parent_recipient_name`
  - `uei`
  - `duns` if available
  - confidence/match metadata
- Add resolution heuristics:
  - exact company name
  - stripped corporate suffix
  - ticker-derived company name
  - known aliases from local organization tables

Schema changes:

- Add USAspending identifiers to `organization_identifiers`:
  - `source_type = 'usaspending'`
  - `identifier_type in ('recipient_id', 'uei', 'duns')`
- Optionally add `recipient_id` and `parent_recipient_id` fields to `organizations` if you want direct access without extra joins.

Frontend changes:

- In `CorporationSearch`, resolve recipient candidates before award search.
- Let the user override the chosen recipient when the match is ambiguous.

Priority:

- Highest. This unlocks everything else cleanly.

### 2. Harden Award Search

Endpoint:

- `/api/v2/search/spending_by_award/`

Why:

- This is the core replacement for the old Finnhub proxy.

Implementation:

- Keep the current `/api/usaspending/awards` route, but refactor it to prefer resolved `recipient_id` over raw name search.
- Support filters for:
  - `recipient_id`
  - `time_period`
  - `award_type_codes`
  - `agencies`
  - `naics_codes`
  - `psc_codes`
  - `place_of_performance_locations`
- Preserve current UI-normalized fields while also storing raw payloads.

Frontend changes:

- Add search filters for:
  - award type
  - agency
  - NAICS
  - state

Priority:

- Highest. This is the baseline interactive contracts view.

## Phase 2: Timing and Correlation

### 3. Transaction-Level Search

Endpoints:

- `/api/v2/search/spending_by_transaction/`
- `/api/v2/transactions/`

Why:

- Award-level data is too coarse for vote-window analysis.
- Transactions are what you want for "what happened 30 days before/after a vote?"

Implementation:

- Add Worker routes:
  - `/api/usaspending/transactions/search`
  - `/api/usaspending/transactions/:id`
- Normalize fields:
  - transaction id
  - award id / generated internal id
  - recipient id / recipient name
  - action date
  - obligation / outlay amounts
  - awarding and funding agency
  - program activity / federal account where available

Schema changes:

- Add a `organization_transaction_events` table or similar:
  - `organization_id`
  - `transaction_id`
  - `award_id`
  - `action_date`
  - `amount`
  - `awarding_agency_name`
  - `funding_agency_name`
  - `raw_payload`

Use cases:

- Compare transaction activity against:
  - bill actions
  - committee hearings
  - vote dates
  - member stock trades

Priority:

- High. This is the most useful next step for actual correlation work.

### 4. Spending Over Time

Endpoint:

- `/api/v2/search/spending_over_time/`

Why:

- Useful for charts and pre/post event windows without pulling every transaction row.

Implementation:

- Add `/api/usaspending/spending-over-time`.
- Support parameters:
  - recipient id
  - time range
  - rolling interval
  - award types
  - agencies

Frontend changes:

- Add a chart to:
  - corporation view
  - member-correlation view

Use cases:

- Show spending slope around:
  - passage
  - cloture
  - markup
  - hearing dates

Priority:

- High.

## Phase 3: District and Geography

### 5. District and Geography Correlations

Endpoints:

- `/api/v2/search/spending_by_geography/`
- `/api/v2/search/spending_by_category/district/`

Why:

- This is the path from "company got contracts" to "did spending concentrate in the district a member represents?"

Implementation:

- Add Worker routes:
  - `/api/usaspending/geography`
  - `/api/usaspending/districts`
- Support filters by:
  - district
  - state
  - recipient
  - date range
  - award type

Schema changes:

- Add a `district_spending_snapshots` table for cached aggregates.
- Persist:
  - congress
  - chamber
  - state
  - district
  - date window
  - amount
  - award count
  - raw payload

Use cases:

- Compare member votes with:
  - spending into their district
  - spending into committee members' districts
  - state-level vs district-level dependence

Priority:

- High for member-correlation work.

## Phase 4: Sector and Oversight

### 6. Category and Sector Views

Endpoints:

- `/api/v2/search/spending_by_category/naics/`
- `/api/v2/search/spending_by_category/psc/`
- `/api/v2/search/spending_by_category/awarding_agency/`
- `/api/v2/search/spending_by_category/funding_agency/`
- `/api/v2/search/spending_by_category/federal_account/`

Why:

- These endpoints make the "who oversees what money?" story much better.

Implementation:

- Add Worker routes under `/api/usaspending/categories/*`.
- Build a common aggregation adapter so these endpoints return a shared shape:
  - `category`
  - `amount`
  - `count`
  - `share`

Use cases:

- Committee oversight:
  - Armed Services -> defense-heavy awards
  - Banking -> housing and finance programs
- Sector analysis:
  - map corporate recipients to industry buckets
  - compare bill subject area vs spending sector

Frontend changes:

- Add tabbed category summaries in:
  - corporation search
  - correlation explorer

Priority:

- Medium-high.

## Phase 5: Drill-Down and Networks

### 7. Award Detail and Funding Rollups

Endpoints:

- `/api/v2/awards/<AWARD_ID>/`
- `/api/v2/awards/funding`
- `/api/v2/awards/funding_rollup`

Why:

- Once a suspicious award is found, users need a full detail view.

Implementation:

- Add:
  - `/api/usaspending/awards/:awardId`
  - `/api/usaspending/awards/:awardId/funding`
  - `/api/usaspending/awards/:awardId/funding-rollup`

Use cases:

- Drill into:
  - agency chain
  - funding source
  - award modifications
  - linked transactions

Priority:

- Medium.

### 8. Subawards and Prime/Sub Networks

Endpoint:

- `/api/v2/subawards/`

Why:

- Prime awards often hide where money actually flowed.

Implementation:

- Add `/api/usaspending/subawards`.
- Allow filters by:
  - prime award
  - recipient
  - date window

Schema changes:

- Add `organization_subaward_flows` table:
  - prime organization
  - subrecipient organization
  - amount
  - date
  - award linkage

Use cases:

- Build recipient networks
- Detect when member-district benefit comes through subrecipients, not prime contractors

Priority:

- Medium.

### 9. IDV Activity

Endpoint:

- `/api/v2/idvs/activity/`

Why:

- Many contract relationships sit inside umbrella vehicles.

Implementation:

- Add `/api/usaspending/idvs/activity`.
- Link IDV results to award and transaction records.

Use cases:

- Identify master contract vehicles and recurring ordering channels
- Understand the difference between base contract and actual obligation flow

Priority:

- Medium.

## Phase 6: Warehousing and Backfills

### 10. Bulk Download Pipeline

Endpoints:

- `/api/v2/download/awards/`
- `/api/v2/download/transactions/`
- `/api/v2/download/count/`

Why:

- Interactive endpoints are not enough for historical analysis at scale.
- You need repeatable backfills for durable analytics and reproducible correlation studies.

Implementation:

- Add batch scripts in `api/scripts/`:
  - `usaspending_awards_backfill.mjs`
  - `usaspending_transactions_backfill.mjs`
  - `usaspending_counts_backfill.mjs`
- Persist downloaded snapshots into staging tables or object storage.
- Add resumable job metadata if the backfills are long-running.

Schema changes:

- Consider staging tables:
  - `usaspending_award_download_jobs`
  - `usaspending_transaction_download_jobs`
  - `usaspending_download_artifacts`

Use cases:

- Historical warehousing
- Auditable ETL
- Recompute correlations without hitting live APIs repeatedly

Priority:

- Medium-high if the analysis scope is growing.

## Recommended Delivery Order

### Milestone 1

- Recipient autocomplete and resolution
- Award search refactor to use recipient IDs
- Basic award detail drill-down

Outcome:

- Reliable corporation spending search

### Milestone 2

- Transaction search
- Spending over time
- Correlation refresh updates to use transaction windows

Outcome:

- Vote-window and event-window analysis

### Milestone 3

- Geography and district endpoints
- District aggregate persistence

Outcome:

- Member-district spending correlations

### Milestone 4

- Category endpoints: NAICS, PSC, awarding/funding agency, federal account
- UI for sector and oversight summaries

Outcome:

- Committee and sector narratives

### Milestone 5

- Subawards
- IDV activity
- Funding rollups

Outcome:

- Deeper contract-network analysis

### Milestone 6

- Bulk downloads and backfills

Outcome:

- Durable warehouse and reproducible research

## API Design Notes

Recommended Worker route structure:

- `/api/usaspending/recipients/autocomplete`
- `/api/usaspending/recipients/search`
- `/api/usaspending/awards`
- `/api/usaspending/awards/:awardId`
- `/api/usaspending/awards/:awardId/funding`
- `/api/usaspending/awards/:awardId/funding-rollup`
- `/api/usaspending/transactions/search`
- `/api/usaspending/transactions/:transactionId`
- `/api/usaspending/spending-over-time`
- `/api/usaspending/geography`
- `/api/usaspending/districts`
- `/api/usaspending/categories/naics`
- `/api/usaspending/categories/psc`
- `/api/usaspending/categories/awarding-agency`
- `/api/usaspending/categories/funding-agency`
- `/api/usaspending/categories/federal-account`
- `/api/usaspending/subawards`
- `/api/usaspending/idvs/activity`

## Correlation Model Updates

Update the current correlation flow so organization activity is no longer just:

- lobbying
- contract awards

Add:

- transaction events
- district aggregate exposure
- sector category exposure
- subaward network edges
- IDV relationship signals

That likely means extending `persistFinnhubActivity` into a source-agnostic organization activity persistence layer, for example:

- `persistOrganizationActivity`

Inputs:

- lobbying records
- award records
- transaction records
- subaward records
- category aggregates

## Testing Plan

### Unit/Parser Tests

- recipient result normalization
- award search normalization
- transaction search normalization
- district/category aggregate normalization

### Integration Tests

- company search resolves recipient -> award results
- vote-date window produces transaction results
- district lookup for a member returns valid aggregates
- award detail route hydrates funding and rollup data

### Backfill Tests

- dry-run mode for download scripts
- resumability after partial failure
- duplicate-safe upserts

## Known Risks

- Recipient matching ambiguity for large conglomerates and subsidiaries
- District joins may need careful handling across Congress changes
- Bulk endpoints may require different operational handling than interactive endpoints
- Some USAspending endpoints have field-name inconsistencies across award groups

## Suggested First Build Ticket Set

1. Add recipient autocomplete and recipient detail routes.
2. Refactor corporation search to resolve a recipient ID before award search.
3. Add transaction search and transaction detail routes.
4. Extend correlation refresh to ingest transaction events.
5. Add spending-over-time chart for corporation and vote windows.
6. Add district aggregate routes and member-district comparison UI.

## File/Module Suggestions

Suggested new API files:

- `api/src/apis/usaspending.ts`
- `api/src/lib/usaspending-normalizers.ts`
- `api/src/lib/usaspending-filters.ts`
- `api/src/lib/usaspending-persistence.ts`

Suggested future scripts:

- `api/scripts/usaspending_awards_backfill.mjs`
- `api/scripts/usaspending_transactions_backfill.mjs`
- `api/scripts/usaspending_categories_backfill.mjs`

Suggested future frontend modules:

- `src/lib/usaspending.ts`
- `src/components/UsaSpendingTimeline.tsx`
- `src/components/UsaSpendingCategoryBreakdown.tsx`
- `src/components/UsaSpendingDistrictMap.tsx`

