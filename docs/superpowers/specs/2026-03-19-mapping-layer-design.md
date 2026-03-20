# Mapping Layer Design

## Summary

Add a relational-first mapping layer that supports transparent, inspectable "interesting fact" chains without introducing a graph database in v1.

The first release covers two derived mapping systems:

- `policy area -> top-level committee`
- `organization location observation -> congressional district`

Both systems should follow the same pattern:

1. ingest stable source facts into source tables
2. derive ranked links into focused map tables
3. attach traceable evidence rows to every derived link
4. expose only higher-confidence links to narrative outputs while preserving broader exploratory coverage

The purpose is not to prove causality or deliver research-grade classification. The purpose is to let the app show legible chains such as:

- `bill -> policy area -> committee -> members`
- `company -> location observation -> district -> member`

with enough structured evidence that a user can inspect why each hop exists.

## Goals

- Add a durable mapping layer in Supabase/Postgres that fits the current relationship-first architecture.
- Make every derived link traceable through human-readable evidence.
- Support broad exploratory coverage while keeping narrative outputs gated by confidence thresholds.
- Reuse stable public sources where possible and cache or materialize derived mappings in tables.
- Preserve a clear path to graph-style visualization later without making a graph database the source of truth now.

## Non-Goals

- Introducing a graph database in v1.
- Modeling subcommittees as first-class mapping targets in the first release.
- Performing semantic bill-text classification in the first release.
- Requiring SEC properties scraping for launch.
- Making causality, intent, or ethical judgments about the relationships being shown.
- Treating every v1 organization location as a verified operating facility rather than an observed location claim from a source record.

## Product Framing

This system is designed as an "interesting fact" engine, not a formal research tool. Derived links should therefore optimize for:

- understandable step-by-step chains
- inspectable evidence
- legible confidence scoring

instead of:

- exhaustive ontology design
- opaque model-driven inference
- claims stronger than the underlying data supports

Confidence should be interpreted as "how comfortable are we showing this link as an interesting chain" rather than "how certain is this fact in an absolute sense."

## Existing Context

The current codebase already has the right architectural base for this work:

- source-oriented relationship tables in Supabase
- derived case generation
- API routes that read structured relationship data for the UI

The new mapping layer should extend that pattern rather than creating a separate inference stack. Raw source records, derived mappings, and evidence trails should all remain queryable in SQL.

## Approach Options Considered

### Option 1: Domain-Specific Mapping Tables Only

Create dedicated map tables for each domain, such as `policy_area_committee_map` and `organization_location_district_map`, with separate evidence handling for each pipeline.

Pros:

- simplest to implement
- easiest to understand in SQL

Cons:

- traceability conventions drift between pipelines
- harder to project into graph-style edges later

### Option 2: Domain Tables Plus Shared Evidence Pattern

Keep dedicated map tables for each domain, but standardize shared confidence and evidence conventions across pipelines.

Pros:

- fits the current relational architecture
- keeps domain logic readable
- supports a later graph projection cleanly
- avoids a premature generic edge abstraction

Cons:

- requires some discipline in evidence modeling

### Option 3: Generic Edge Engine First

Model everything as typed entity-to-entity edges from the start.

Pros:

- flexible long-term shape

Cons:

- too abstract for the current codebase
- adds cognitive overhead before the product needs it

### Recommendation

Adopt Option 2.

This gives the project focused, debuggable SQL tables for the first mappings while preserving a clean path to future edge projection and visualization.

## System Design

The mapping layer should use the following pipeline for both domains:

1. ingest raw or lightly normalized source facts
2. derive candidate links
3. score and materialize derived links in domain-specific map tables
4. write evidence rows explaining why each derived link exists
5. expose read APIs that return both the link and its evidence trail

Narrative outputs should not perform fresh inference at request time. They should assemble summaries from stored map rows and stored evidence rows using configurable thresholds.

## Core Data Model

### Committee Dimension

Add a canonical committee table for top-level committees:

- `committees`
  - `id`
  - `committee_key`
  - `committee_code`
  - `name`
  - `normalized_name`
  - `chamber`
  - `is_subcommittee`
  - `parent_committee_id`
  - `source`
  - `created_at`
  - `updated_at`

`committee_key` should be the canonical join key for the project and must be unique. In v1, define it as:

- `committee_code` when present
- otherwise `normalized_name + ':' + chamber`

Even though v1 only targets top-level committees, `is_subcommittee` and `parent_committee_id` should be present now so subcommittees can be added later without redesigning the model.

The existing `member_committee_assignments` table should gain a nullable `committee_key` column in a follow-up migration and be backfilled using the same rule:

- `committee_code` when present
- otherwise `normalized_committee_name + ':' + chamber`

Do not rely on a looser compatibility view that drops chamber from the fallback key. That would create avoidable collisions between House and Senate committees with similar names.

If an existing committee-assignment row has a null chamber, the backfill should:

- first attempt chamber normalization from the member record or source payload
- if chamber still cannot be determined, leave `committee_key` null
- exclude that row from joins that require canonical committee identity until repaired

### Policy To Committee Mapping

- `policy_area_committee_map`
  - `id`
  - `policy_area`
  - `subject_term`
  - `committee_id`
  - `confidence`
  - `source`
  - `evidence_count`
  - `bill_count`
  - `first_seen_congress`
  - `last_seen_congress`
  - `last_seen_at`
  - `is_manual_override`
  - `created_at`
  - `updated_at`

- `policy_area_committee_evidence`
  - `id`
  - `map_id`
  - `evidence_type`
  - `source_table`
  - `source_row_id`
  - `source_url`
  - `weight`
  - `note`
  - `evidence_payload jsonb`
  - `created_at`

Supported `evidence_type` values should include:

- `bill_history`
- `jurisdiction_rule`
- `manual_override`

- `policy_area_committee_overrides`
  - `id`
  - `policy_area`
  - `subject_term`
  - `committee_id`
  - `override_action`
  - `confidence_delta`
  - `reason`
  - `source`
  - `created_by`
  - `is_active`
  - `effective_start_date`
  - `effective_end_date`
  - `created_at`
  - `updated_at`

Recommended `override_action` values:

- `promote`
- `suppress`
- `pin`

Override precedence for v1:

- `pin` sets the final mapping confidence directly and forces inclusion
- `promote` adds a bounded positive adjustment
- `suppress` applies a bounded negative adjustment or exclusion

This table is the source of truth for manual intervention. `is_manual_override` on the map row simply indicates that at least one active override affected the final score.

Override reconciliation rules:

- only active overrides participate in scoring
- active means `is_active = true` and the current date is within the effective date window when one is present
- when multiple historical overrides exist for the same key, the newest active override wins
- the implementation should enforce at most one active override per `(policy_area, committee_id)` when `subject_term is null`
- the implementation should enforce at most one active override per `(policy_area, subject_term, committee_id)` when `subject_term is not null`

For v1, `subject_term` should remain nullable and should not be required for the first derivation pass. The current bill cache already persists `policy_area` and committee names, but not subject terms. Subject-level mappings should therefore be deferred until a dedicated subject-term ingestion path exists.

Recommended uniqueness constraints:

- unique on `committee_key` in `committees`
- unique on `(policy_area, committee_id)` for rows where `subject_term is null`
- unique on `(policy_area, subject_term, committee_id)` for rows where `subject_term is not null`
- unique on `(map_id, evidence_type, source_table, source_row_id)` in `policy_area_committee_evidence`
- unique on `(policy_area, committee_id)` in `policy_area_committee_overrides` for rows where `subject_term is null`
- unique on `(policy_area, subject_term, committee_id)` in `policy_area_committee_overrides` for rows where `subject_term is not null`

### Organization Location Observation Dimension

- `organization_locations`
  - `id`
  - `organization_id`
  - `location_name`
  - `address1`
  - `city`
  - `state`
  - `zip`
  - `latitude`
  - `longitude`
  - `location_kind`
  - `location_fingerprint`
  - `source`
  - `source_row_id`
  - `confidence`
  - `source_congress`
  - `created_at`
  - `updated_at`

Recommended `location_kind` values:

- `performance`
- `facility`
- `hq`
- `office`

`organization_locations` is intentionally broader than a strict operating-sites table. In v1, most rows will be observed location claims derived from source records such as USAspending place-of-performance data. Later releases can add stronger operating-facility sources without redesigning the model.

`location_fingerprint` should be a deterministic normalized key derived from the best available address parts, such as normalized `address1 + city + state + zip`, or `city + state + zip` when only partial location data exists.

### Location To District Mapping

- `organization_location_district_map`
  - `id`
  - `organization_location_id`
  - `congress`
  - `state`
  - `district`
  - `confidence`
  - `resolution_method`
  - `source`
  - `created_at`
  - `updated_at`

- `organization_location_district_evidence`
  - `id`
  - `map_id`
  - `source_table`
  - `source_row_id`
  - `source_url`
  - `weight`
  - `note`
  - `evidence_payload jsonb`
  - `created_at`

Recommended `resolution_method` values:

- `direct_source`
- `address_geocode`
- `zip_centroid`
- `county_crosswalk`

Recommended uniqueness constraints:

- unique on `(source, source_row_id)` in `organization_locations`
- non-unique index on `(organization_id, location_fingerprint)`
- unique on `(organization_location_id, congress)` in `organization_location_district_map`
- unique on `(map_id, source_table, source_row_id)` in `organization_location_district_evidence`

## Shared Evidence Pattern

Every derived link should have a corresponding evidence trail that supports two use cases:

1. API and UI inspection
2. explanation in narrative summaries

Evidence rows should therefore be:

- row-level, not just aggregate counters
- source-aware
- human-readable
- compact enough to render directly in the UI

The evidence payload should store the raw context needed to explain the link, such as:

- bill identifiers and counts
- committee jurisdiction excerpts
- matching subject terms
- original location values
- geocoding or district lookup metadata

The evidence table shape can vary by domain, but the semantics should remain consistent:

- what source created this evidence
- what source row backs it
- how much this evidence contributed
- what short explanation can be shown to the user

## Source Data Strategy

### Policy To Committee Sources

There is likely no single official dataset that directly states "this policy area belongs to these committees." The mapping should therefore be materialized from a combination of stable sources:

- Congress.gov bill metadata
  - policy area
  - committee referrals
- manually curated jurisdiction seed snapshots sourced from official House and Senate committee jurisdiction material
- manual overrides

The bill metadata path is the primary source of observed legislative behavior. Jurisdiction text acts as a slower-moving seed and correction layer.

For v1, the derivation must rely only on fields already available or explicitly planned for ingestion. That means:

- required in v1: `policy_area`, committee referrals or committee names
- required in v1: a versioned `committee_jurisdiction_seeds` table populated from manually curated snapshots of official jurisdiction text
- deferred from v1: Congress.gov subject terms until they are stored in cache tables or a dedicated raw bill-subject table

For v1, do not scrape official committee pages dynamically at runtime. Instead:

- create a `committee_jurisdiction_seeds` table
- load it from manually curated snapshots sourced from official House and Senate jurisdiction pages
- version the seeds by Congress or effective date
- refresh them only through an explicit admin workflow when the source material changes

### Organization Location To District Sources

The first release should prioritize sources that are stable and easy to operationalize:

- USAspending contract records
  - recipient name
  - place of performance city
  - place of performance state
  - place of performance ZIP
  - performance congressional district when directly available
- one canonical congressional district resolver aligned to the congressional cycle being analyzed

Recommendation for the canonical resolver in v1:

- use one official Census-aligned district lookup source for the same Congress the app is targeting
- persist the resolved `congress` on the mapping row so future redistricting does not silently rewrite history

Persist the resolver reference material in:

- `district_lookup_reference`
  - `id`
  - `congress`
  - `lookup_key`
  - `lookup_type`
  - `state`
  - `district`
  - `resolution_method`
  - `source`
  - `source_version`
  - `effective_start_date`
  - `effective_end_date`
  - `created_at`
  - `updated_at`

Recommended `lookup_type` values:

- `address`
- `zip`
- `county`
- `lat_lon`

`district_lookup_reference` should be versioned by Congress and source version. `lookup_key` should be a deterministic normalized key appropriate for the lookup type, such as normalized ZIP, county FIPS, or geocode bucket key. The derivation layer should always record both the resolved district and the resolver version used.

Deferred but planned later:

- SEC 10-K `Item 2. Properties`
- state economic development datasets
- industry-specific facility datasets

## Derivation Logic

### Policy To Committee Scoring

The first release should use a transparent scoring model with three signal families:

1. `bill_history`
2. `jurisdiction_rule`
3. `manual_override`

Recommended interpretation:

- `bill_history`: strongest observed signal
- `jurisdiction_rule`: slower-moving seed or support signal sourced from versioned jurisdiction snapshots
- `manual_override`: targeted promotion, suppression, or pinning via `policy_area_committee_overrides`

Example composition:

- `0.60` from repeated bill-history co-occurrence
- `0.25` from jurisdiction overlap
- `0.10` from freshness or consistency bonus
- `+/- manual adjustment`

The exact coefficients can be tuned later, but the model must stay legible and deterministic.

Suggested confidence bands:

- `>= 0.80`: safe for narrative summaries
- `0.55 - 0.79`: visible in exploration UI
- `< 0.55`: stored for analysis but hidden by default

#### Bill-History Rules

When deriving `policy area -> committee` from bills:

- count co-occurrence frequency across historical bills
- weight primary or explicit referrals more strongly than weaker committee associations
- down-rank rare one-off matches

This keeps the mapping grounded in observed legislative traffic.

#### Jurisdiction Rules

Jurisdiction-derived support should come from official House and Senate rule text or committee jurisdiction pages. This source is valuable because:

- it changes slowly
- it provides a seed even when bill history is sparse
- it helps suppress obviously misleading co-occurrences

Jurisdiction support should not fully replace bill history, because the product benefits from showing what committees actually receive bills in practice.

### Organization Location To District Scoring

This mapping should use a source-first hierarchy:

- `direct_source`: highest confidence
- `address_geocode`: high confidence
- `zip_centroid`: medium confidence
- `county_crosswalk`: lower confidence

Example interpretations:

- SEC address geocoded directly into a district: high confidence
- USAspending ZIP mapped via centroid: medium confidence
- county-to-district crosswalk for a split county: lower confidence

This should produce user-facing explanations such as:

> Mapped Fort Worth, Texas location to TX-12 using ZIP-based district lookup from USAspending performance location.

The important property is transparency, not false precision.

## Operational Flow

### Ingestion

Source data should be ingested into raw or lightly normalized tables on an admin-triggered or scheduled basis.

Recommended first-pass jobs:

- refresh committee dimension and jurisdiction seeds
- refresh historical bill metadata required for policy mappings
- refresh organization location candidates from USAspending-derived location data
- refresh district lookup material needed for site resolution

### Derivation

Separate derivation jobs should:

- compute candidate mappings
- upsert the map tables
- update confidence and metadata
- rewrite evidence rows for the affected mappings

Derivations should be rerunnable and idempotent. A failed derivation should not corrupt raw source facts.

Idempotency depends on deterministic keys:

- committee rows keyed by `committee_key`
- policy map rows keyed by `policy_area + committee_id`, or `policy_area + subject_term + committee_id` when subject terms exist
- organization location rows keyed by `source + source_row_id`
- district map rows keyed by `organization_location_id + congress`
- evidence rows keyed by parent map id plus source identity

### Read Path

Read-oriented APIs should return derived links plus compact evidence trails. Suggested endpoints:

- `GET /api/maps/policy-committees?policyArea=...`
- `GET /api/maps/organization-districts?organizationId=...`
- `GET /api/maps/evidence/:mapType/:mapId`

These endpoints should support the existing frontend model where the UI presents a result and lets the user expand into the supporting chain.

## Access Control

New tables should follow the same broad security posture as the current relationship layer:

- service-role write access for ingestion and derivation jobs
- public read only through curated API responses or explicitly approved derived views

Recommendation:

- keep raw source tables service-only
- expose derived reads through Worker endpoints first
- only add direct public-read Supabase views if the frontend later needs them

## Integration With Existing App

This work should extend the current Supabase-backed relationship layer rather than introducing a separate subsystem.

Recommended integration points:

- keep raw facts and derived mappings in Supabase migrations alongside the current relationship schema
- add admin refresh routes under the existing correlation/admin pipeline
- use derived map tables to enrich correlation cases and future narrative summaries

The implementation plan should also define:

- how `member_committee_assignments` joins to `committees` through `committee_key`
- the backfill migration that writes `committee_key` onto existing committee assignment rows
- whether any public-facing derived views should be added with `security_invoker = true`

The current relationship and correlation architecture already supports storing evidence payloads and assembling cases from durable facts. The mapping layer should become another structured input to that system.

## Narrative Generation

Narrative output should be a thin presentation layer over stored mappings.

For example, a summary such as:

- company lobbied on defense procurement
- those issues map to Armed Services committees
- members on those committees received donations from the company

should be constructed from:

- stored organization activity
- stored policy-to-committee links
- stored committee membership
- stored contribution facts

The summary layer should never be the only place where the logic exists. Every statement should be reconstructable from durable tables and evidence rows.

## Graph Projection Strategy

Do not adopt a graph database in v1.

If graph traversal or visualization later becomes important, add a derived projection layer such as:

- `influence_edges`

This table can denormalize selected rows from:

- organization activity
- policy area mappings
- committee assignments
- member activity
- contract or contribution relationships

That projection can feed visualization without replacing the relational system of record.

## Risks And Trade-Offs

### Risk: False Precision

Confidence scores can look more rigorous than they really are.

Mitigation:

- use a small number of legible evidence types
- expose explanations alongside the score
- avoid strong product language that implies causality

### Risk: Sparse Or Noisy Coverage

Some policy areas or company locations will have weak data.

Mitigation:

- store broad candidate mappings
- use thresholds to control narrative promotion
- preserve lower-confidence links for exploratory use

### Risk: Source Drift

Committee jurisdiction pages or external source schemas may change.

Mitigation:

- keep source URLs and source row identifiers in evidence rows
- isolate ingestion from derivation
- favor stable official sources where available

## Phased Delivery

### Phase 1

- add committee dimension
- add `committee_jurisdiction_seeds` sourced from manually curated official snapshots
- add policy-to-committee map and evidence tables
- add manual override table for policy mappings
- add organization location and location-to-district map and evidence tables
- seed from Congress.gov-derived bill history and USAspending-derived locations
- expose read APIs

### Phase 2

- add manual override workflows
- improve jurisdiction seed coverage
- add explicit subject-term ingestion and subject-level mappings
- enrich organization locations with SEC and other facility sources
- expand narrative outputs to use the new mappings more aggressively

### Phase 3

- add subcommittee support
- add graph-style edge projection for visualization

## Open Questions For Planning

- how much historical bill depth should be materialized before the first derivation run
- whether manual overrides need an internal admin UI in the first implementation plan or can start as seed tables

## Recommendation

Build the mapping layer as a relational source of truth with dedicated domain map tables and a shared evidence pattern.

For v1:

- map `policy area -> top-level committee`
- map `organization location observation -> congressional district`
- keep every link traceable
- feed the results into the existing correlation and narrative system

This is the shortest path to useful, inspectable "vibe check" chains while preserving a clean upgrade path to graph-style traversal later.
