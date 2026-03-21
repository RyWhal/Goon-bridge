# Organization Site To District Mapping Design

## Goal

Build a traceable backend-only v1 that derives `organization -> site -> congressional district` mappings from USAspending contract location data.

The purpose is not research-grade location intelligence. The purpose is to create readable, evidence-backed chains that can later support the existing "interesting fact" engine and future graph edges.

## Scope

### Included in v1

- USAspending-derived location facts only
- `UEI -> DUNS -> normalized recipient_name` organization key resolution
- two site types:
  - `place_of_performance`
  - `recipient_location`
- ZIP-first district mapping
- admin-triggered refresh job
- read APIs for inspecting derived sites, districts, and evidence
- row-level evidence for every derived district mapping

### Explicitly excluded from v1

- SEC `Item 2. Properties` ingestion
- address geocoding
- county-based fallback resolution
- district history by congress/session
- frontend explorer
- generic graph edge projection
- full organization master-data reconciliation

## Design Principles

- Preserve the same pattern already established for `policy_area -> committee`:
  - raw facts
  - derived map rows
  - evidence rows
- Prefer stable, legible heuristics over opaque inference
- Keep the derived rows explainable from stored source facts
- Fail closed when district resolution is too weak

## Source Data

### Primary source

USAspending award location data, specifically:

- recipient identifiers
  - `uei`
  - `duns`
  - `recipient_name`
- recipient location fields
  - `recipient_location_*`
- place of performance fields
  - `place_of_performance_*`

### Assumptions

- v1 will rely on whatever location fields are already available through the current USAspending ingestion path or a closely-related extension of it
- if a source row contains enough fields for both site types, both site candidates should be generated
- if ZIP is missing, no district map row is produced for that site

## Canonical Keys

### Organization key

Organization identity in v1 resolves as:

1. `uei` when present
2. else `duns` when present
3. else normalized `recipient_name`

This is intentionally pragmatic. It is sufficient for v1 traceability while leaving room for future entity reconciliation.

### Site key

Sites should deduplicate by:

- `organization_key`
- `site_type`
- normalized location key

The normalized location key for v1 should use:

- `state`
- `zip`
- `city` retained for display and evidence, not as the primary district-resolution input

## Tables

### `usaspending_location_facts`

Raw staging table for award-level location facts.

Columns:

- `id`
- `award_id`
- `generated_source_key`
- `uei`
- `duns`
- `recipient_name`
- `recipient_city`
- `recipient_state`
- `recipient_zip`
- `place_of_performance_city`
- `place_of_performance_state`
- `place_of_performance_zip`
- `source`
- `source_url`
- `raw_payload jsonb`
- `pulled_at`
- `created_at`

Notes:

- `generated_source_key` must be deterministic so refreshes are idempotent
- this table remains source-of-truth staging, not the direct API surface

### `organization_sites`

Derived site table.

Columns:

- `id`
- `organization_key`
- `site_type`
- `source`
- `source_row_id`
- `uei`
- `duns`
- `recipient_name`
- `address_line1`
- `city`
- `state`
- `zip`
- `normalized_location_key`
- `confidence`
- `created_at`
- `updated_at`

Constraints:

- unique on `(organization_key, site_type, normalized_location_key)`

Notes:

- `address_line1` is nullable in v1 because ZIP-first resolution may not have a street address
- `confidence` here reflects confidence that the derived site is a useful stable location record, not district certainty

### `organization_site_district_map`

Derived district mapping table.

Columns:

- `id`
- `organization_site_id`
- `state`
- `district`
- `confidence`
- `resolution_method`
- `source`
- `created_at`
- `updated_at`

Constraints:

- unique on `(organization_site_id, state, district, resolution_method)`

### `organization_site_district_evidence`

Evidence table for district mappings.

Columns:

- `id`
- `map_id`
- `source_table`
- `source_row_id`
- `source_url`
- `weight`
- `note`
- `evidence_payload jsonb`
- `created_at`

## Resolution Logic

## Step 1: Ingest raw USAspending location facts

Each refresh pulls candidate award rows and writes them into `usaspending_location_facts`.

Each row should preserve:

- identifiers used for organization resolution
- recipient location fields
- place of performance fields
- enough raw payload to debug later

## Step 2: Derive site candidates

Each fact row may produce up to two site candidates:

- one `place_of_performance` site
- one `recipient_location` site

Rows with missing `state` or `zip` for a site type may still be stored in `organization_sites` if the site record is otherwise useful, but no district map row is created unless district resolution is possible.

## Step 3: Deduplicate sites

Upsert into `organization_sites` using:

- `organization_key`
- `site_type`
- `normalized_location_key`

For v1, the normalized location key should be based on:

- uppercase normalized `state`
- five-digit normalized `zip`

If city is present, retain it for display, but do not require city equality for site identity.

## Step 4: Resolve ZIP to district

Use a ZIP-first crosswalk.

### Resolution behavior

- exact ZIP-state match to one district:
  - write map row
  - `confidence = 0.9`
  - `resolution_method = 'zip_crosswalk_exact'`
- ZIP-state match to multiple districts:
  - choose the primary/default district only if the reference data contains an explicit primary mapping
  - `confidence = 0.65`
  - `resolution_method = 'zip_crosswalk_primary'`
- no ZIP match:
  - write no district row

### Fail-closed rule

Do not invent a district from partial location fields in v1.

If ZIP resolution is ambiguous and there is no explicit primary mapping in the reference data, the site remains unresolved.

## Step 5: Write evidence

Every successful district map row gets at least one evidence row pointing back to the exact `usaspending_location_facts` source row.

`evidence_payload` should include:

- `organization_key`
- `site_type`
- `zip`
- `state`
- `resolution_method`
- source identifiers like `award_id`, `uei`, `duns` when available

## Confidence Model

Keep confidence intentionally simple in v1:

- `0.9` exact ZIP -> single district
- `0.65` ZIP -> primary district from an explicit multi-district crosswalk
- unresolved sites produce no mapping row

No probabilistic distribution over multiple districts in v1.

## APIs

### `POST /api/correlation/refresh/organization-site-districts`

Admin-only mutation endpoint.

Behavior:

- ingest raw USAspending location facts
- derive sites
- resolve districts
- write evidence

Response fields:

- `ok`
- `job`
- `facts_loaded`
- `sites_written`
- `district_maps_written`
- `evidence_rows_written`

### `GET /api/maps/organization-sites?organizationKey=...`

Read endpoint for derived site records and their district mappings.

Response shape:

- `organization_key`
- `count`
- `rows`

Each row should include:

- site identity fields
- site type
- location display fields
- zero or more district mappings
- confidence
- resolution method

### `GET /api/maps/evidence/organization-site-district/:mapId`

Read endpoint for district-map evidence.

Response shape:

- `map_type`
- `map_id`
- `count`
- `evidence`

## Refresh Behavior

V1 refresh is admin-triggered only.

No scheduled automation is part of this slice yet.

Refresh must be idempotent:

- raw facts can be upserted by deterministic source key
- sites can be upserted by canonical site key
- district mappings can be replaced/upserted without leaving stale duplicates
- evidence rows should remain traceable and deduplicated

## Testing

Minimum test coverage:

- organization key fallback order:
  - `uei`
  - `duns`
  - normalized `recipient_name`
- site derivation writes both `place_of_performance` and `recipient_location`
- site dedupe preserves one canonical site row for repeated facts
- ZIP exact match writes one district mapping
- ambiguous ZIP without primary mapping writes no district row
- evidence rows point back to the correct raw source fact
- admin refresh endpoint enforces auth
- read endpoints return stable, compact shapes

## Open Follow-Ups

These are deferred, not blockers:

- district lookup reference table design and source selection
- SEC properties ingestion
- frontend organization-site explorer
- merging district mappings into later graph or narrative outputs

## Execution Order

1. Add migration for raw facts, sites, district map, and evidence tables
2. Extend db types
3. Add USAspending location ingestion helper
4. Add site derivation logic
5. Add ZIP -> district resolver
6. Add admin refresh endpoint
7. Add read/evidence endpoints
8. Verify with known contractor examples
