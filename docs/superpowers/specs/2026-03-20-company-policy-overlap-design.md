# Company Policy Overlap Design

## Goal

Build the first reusable middle-layer correlation slice that turns the existing mapping tables into traceable overlap findings.

The purpose is not to claim causality. The purpose is to surface clear, inspectable chains such as:

- `company -> site -> district -> House member -> committee -> policy area`
- `company -> site -> state -> Senator -> committee -> policy area`

This layer should make it possible to say "this company has operational overlap with members on committees relevant to this policy area" while preserving every supporting hop as stored evidence.

## Scope

### Included in v1

- one derived overlap table:
  - `company_policy_area_overlap`
- one evidence table:
  - `company_policy_area_overlap_evidence`
- two geographic member helper maps:
  - `district_member_map`
  - `state_member_map`
- one normalized member committee helper map:
  - `member_committee_map`
- support for two overlap path types:
  - `district_member_committee`
  - `state_senator_committee`
- current-member-only derivation
- read APIs for overlap rows and evidence
- admin refresh jobs for helper maps and overlap rows

### Explicitly excluded from v1

- donations
- lobbying links
- bill-level inference
- historical seat timelines
- combining House and Senate overlap into one undifferentiated path
- causal or intent-based scoring
- graph database projection

## Existing Inputs

This slice intentionally builds on data already present in the app:

- `members`
  - canonical member identity
  - chamber
  - state
  - district
  - congress
- `member_committee_assignments`
  - committee membership tied to `bioguide_id`
- `policy_area_committee_map`
  - top-level `policy_area -> committee_id` mappings
- `organization_sites`
  - derived company site rows
- `organization_site_district_map`
  - site-level district mappings

The work in this slice is mainly normalization and derived joins, not new external ingestion.

## Design Principles

- Preserve path transparency:
  - every overlap row must be explainable as a concrete chain of stored records
- Keep House and Senate paths distinct:
  - different path types
  - different confidence baselines
- Prefer smaller helper maps over one giant opaque derivation job
- Fail closed when current geography or committee identity is ambiguous

## Canonical Geography Rules

### District format

Canonical district formatting should use:

- uppercase two-letter state
- district rendered as a zero-padded two-character string where needed for storage consistency
- at-large districts represented as `00`

Derived tables may store `state` and `district` separately, but all derivation logic should normalize them consistently before joining.

### Member geography constraints

- `district_member_map` is House-only
- `state_member_map` is Senate-only
- only current members should be included in either helper map
- stale or historical member rows should not participate in v1 overlap derivation

## Tables

### `district_member_map`

Derived helper table for House geography.

Columns:

- `id`
- `state`
- `district`
- `bioguide_id`
- `confidence`
- `source`
- `created_at`
- `updated_at`

Constraints:

- unique on `(state, district, bioguide_id)`

Notes:

- v1 confidence should generally be `1.0` for canonical current-member district rows
- source should identify the cached member dataset, for example `members_current_house`

### `state_member_map`

Derived helper table for Senate geography.

Columns:

- `id`
- `state`
- `bioguide_id`
- `confidence`
- `source`
- `created_at`
- `updated_at`

Constraints:

- unique on `(state, bioguide_id)`

Notes:

- v1 confidence should generally be `1.0` for canonical current-member senator rows
- each state should normally resolve to two rows

### `member_committee_map`

Normalized helper table for current committee membership.

Columns:

- `id`
- `bioguide_id`
- `committee_id`
- `confidence`
- `source`
- `created_at`
- `updated_at`

Constraints:

- unique on `(bioguide_id, committee_id)`

Notes:

- normalize committee assignments to the same top-level `committee_id` used by `policy_area_committee_map`
- only current relevant assignments belong in v1

### `company_policy_area_overlap`

Primary derived overlap table.

Columns:

- `id`
- `organization_key`
- `policy_area`
- `committee_id`
- `bioguide_id`
- `path_type`
- `state`
- `district`
- `confidence`
- `source`
- `site_count`
- `created_at`
- `updated_at`

Constraints:

- unique on `(organization_key, policy_area, committee_id, bioguide_id, path_type, state, COALESCE(district, ''))`

Notes:

- `district` is nullable for Senate path rows
- `path_type` values:
  - `district_member_committee`
  - `state_senator_committee`

### `company_policy_area_overlap_evidence`

Evidence table for overlap rows.

Columns:

- `id`
- `overlap_id`
- `evidence_type`
- `source_table`
- `source_row_id`
- `weight`
- `note`
- `evidence_payload jsonb`
- `created_at`

Evidence types:

- `organization_site`
- `site_district_map`
- `district_member_map`
- `state_member_map`
- `member_committee_map`
- `policy_committee_map`

## Derivation Logic

## Step 1: Refresh geographic member maps

### `district_member_map`

Derive from `members`:

- `chamber = 'House'`
- `district IS NOT NULL`
- current congress only

Normalize:

- `state`
- `district`
- `bioguide_id`

### `state_member_map`

Derive from `members`:

- `chamber = 'Senate'`
- current congress only

Normalize:

- `state`
- `bioguide_id`

## Step 2: Refresh normalized member committee map

Derive from `member_committee_assignments`.

Rules:

- normalize each assignment to the same top-level `committee_id` used by `policy_area_committee_map`
- if a committee name cannot be normalized confidently, exclude it from v1 instead of inventing a match
- keep one row per `bioguide_id + committee_id`

## Step 3: Derive House overlap candidates

Join:

- `organization_sites`
- `organization_site_district_map`
- `district_member_map`
- `member_committee_map`
- `policy_area_committee_map`

Path:

- company site resolves to district
- district resolves to current House member
- House member resolves to committee
- committee resolves to policy area

Write one overlap row per distinct:

- `organization_key`
- `policy_area`
- `committee_id`
- `bioguide_id`
- `district_member_committee`
- `state`
- `district`

## Step 4: Derive Senate overlap candidates

Join:

- `organization_sites`
- `state_member_map`
- `member_committee_map`
- `policy_area_committee_map`

Path:

- company site resolves to state
- state resolves to current senators
- senator resolves to committee
- committee resolves to policy area

Write one overlap row per distinct:

- `organization_key`
- `policy_area`
- `committee_id`
- `bioguide_id`
- `state_senator_committee`
- `state`

## Step 5: Score overlap rows

Scoring should remain legible and path-aware.

### Base confidence

- `district_member_committee`: `0.78`
- `state_senator_committee`: `0.58`

### Adjustments

- add `0.05` to `0.12` for repeated supporting sites in the same geography
- add `0.05` when the underlying `policy_area_committee_map` confidence is high
- subtract `0.05` to `0.10` when the district mapping came from a lower-confidence split-ZIP path
- clamp final confidence to `0..1`

### `site_count`

`site_count` should reflect the number of distinct supporting company sites contributing to the overlap row.

## Step 6: Write overlap evidence

Each overlap row should retain full-hop evidence through `company_policy_area_overlap_evidence`.

Minimum evidence payload for House path:

- organization site row
- site district map row
- district member map row
- member committee map row
- policy committee map row

Minimum evidence payload for Senate path:

- organization site row
- state member map row
- member committee map row
- policy committee map row

Each evidence row should preserve enough identifiers to reopen the source tables during read-path inspection.

## API Shape

### Admin refresh endpoints

- `POST /api/correlation/refresh/member-geography`
- `POST /api/correlation/refresh/company-policy-overlaps`

### Read endpoints

- `GET /api/maps/member-geography?state=TX&district=12`
- `GET /api/maps/company-policy-overlaps?organizationKey=...`
- `GET /api/maps/evidence/company-policy-overlap/:overlapId`

## Read Response Expectations

Overlap reads should return enough information for narrative assembly and debugging:

- organization key
- policy area
- member identity
- committee identity
- path type
- state
- district when applicable
- confidence
- site count
- evidence count

The UI or narrative layer should be able to say whether the row came from:

- district-level House overlap
- statewide Senate overlap

without reverse-engineering it from raw fields.

## Product Interpretation

This layer supports overlap and proximity claims, not intent claims.

Examples of acceptable narrative framing:

- "Company has site presence in districts represented by House members serving on committees relevant to Defense."
- "Company also has statewide overlap with senators serving on relevant committees."

Examples of framing to avoid in v1:

- "Company influenced this committee."
- "Company caused this policy outcome."

## Execution Order

1. migration for helper maps, overlap table, and overlap evidence
2. db types
3. helper derivation for `district_member_map`
4. helper derivation for `state_member_map`
5. helper derivation for `member_committee_map`
6. overlap derivation and evidence writing
7. read and admin APIs
8. local UI or narrative consumer after the backend slice is stable
