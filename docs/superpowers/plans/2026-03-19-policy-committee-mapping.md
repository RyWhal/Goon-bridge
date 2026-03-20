# Policy To Committee Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a canonical top-level committee dimension plus a traceable `policy_area -> committee` derivation pipeline with read/admin APIs.

**Architecture:** Extend the existing Supabase relationship layer with canonical committee tables, jurisdiction seed snapshots, deterministic normalization helpers, and a derivation service that scores cached bill history plus jurisdiction support plus manual overrides. Keep raw-ish sources and derived mappings in Postgres, then expose them through Worker endpoints rather than direct frontend Supabase reads.

**Tech Stack:** Supabase SQL migrations, TypeScript, Cloudflare Workers (Hono), Node `node:test`, existing Congress.gov cache tables, existing committee-assignment refresh logic.

---

## File Map

- Create: `supabase/migrations/012_policy_committee_mapping.sql`
- Create: `api/src/lib/committee-normalization.ts`
- Create: `api/src/lib/policy-committee-maps.ts`
- Create: `api/src/apis/maps.ts`
- Create: `api/tests/policy-committee-maps.test.ts`
- Create: `api/tests/policy-committee-endpoints.test.ts`
- Modify: `api/src/lib/relationships.ts`
- Modify: `api/src/apis/correlation.ts`
- Modify: `api/src/index.ts`
- Modify: `api/src/lib/db-types.ts`

### Responsibility Notes

- `012_policy_committee_mapping.sql`: schema for `committees`, alias/review seed tables, `committee_jurisdiction_seeds`, `policy_area_committee_map`, evidence, overrides, indexes, and RLS policies.
- `committee-normalization.ts`: pure helpers for canonicalizing committee names, collapsing subcommittees to parents, deriving `committee_key`, and preparing unmatched-review entries.
- `policy-committee-maps.ts`: derivation logic, override application, read queries, and admin refresh functions.
- `maps.ts`: read/admin HTTP routes for policy committee mappings and evidence.
- `relationships.ts`: backfill and refresh `committee_key` on member committee assignments using the new normalization helpers.
- `db-types.ts`: type surface matching the new migration.

## Task 1: Committee Normalization Primitives

**Files:**
- Create: `api/src/lib/committee-normalization.ts`
- Create: `api/tests/policy-committee-maps.test.ts`
- Modify: `api/src/lib/relationships.ts`

- [ ] **Step 1: Write the failing normalization tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCommitteeLabel,
  buildCommitteeKey,
  collapseCommitteeToTopLevel,
} from "../src/lib/committee-normalization.ts";

test("buildCommitteeKey prefers committee code", () => {
  assert.equal(buildCommitteeKey({
    committeeCode: "HSAS",
    normalizedName: "ARMED SERVICES",
    chamber: "House",
  }), "HSAS");
});

test("buildCommitteeKey falls back to normalized name plus chamber", () => {
  assert.equal(buildCommitteeKey({
    committeeCode: null,
    normalizedName: "APPROPRIATIONS",
    chamber: "Senate",
  }), "APPROPRIATIONS:Senate");
});

test("collapseCommitteeToTopLevel maps known subcommittees to parent committee", () => {
  assert.deepEqual(
    collapseCommitteeToTopLevel("Subcommittee on Defense", {
      parentCommitteeName: "Appropriations",
      chamber: "House",
    }),
    { normalizedName: "APPROPRIATIONS", chamber: "House" },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && node --test tests/policy-committee-maps.test.ts`

Expected: FAIL with missing module or missing exports from `committee-normalization.ts`.

- [ ] **Step 3: Write the minimal normalization implementation**

```ts
export function normalizeCommitteeLabel(value: string): string {
  return value
    .toUpperCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildCommitteeKey(input: {
  committeeCode: string | null;
  normalizedName: string;
  chamber: string | null;
}): string | null {
  if (input.committeeCode) return input.committeeCode;
  if (!input.chamber) return null;
  return `${input.normalizedName}:${input.chamber}`;
}

export function buildCommitteeAssignmentRow(input: {
  bioguideId: string;
  committeeName: string;
  committeeCode: string | null;
  chamber: string | null;
}) {
  const normalizedName = normalizeCommitteeLabel(input.committeeName);
  return {
    bioguide_id: input.bioguideId,
    committee_name: input.committeeName,
    normalized_committee_name: normalizedName,
    committee_key: buildCommitteeKey({
      committeeCode: input.committeeCode,
      normalizedName,
      chamber: input.chamber,
    }),
  };
}

export function collapseCommitteeToTopLevel(
  committeeName: string,
  input: { parentCommitteeName?: string | null; chamber: string | null },
) {
  const normalizedName = normalizeCommitteeLabel(input.parentCommitteeName ?? committeeName);
  return { normalizedName, chamber: input.chamber };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && node --test tests/policy-committee-maps.test.ts`

Expected: PASS for the new normalization helpers.

- [ ] **Step 5: Commit**

```bash
git add api/tests/policy-committee-maps.test.ts api/src/lib/committee-normalization.ts api/src/lib/relationships.ts
git commit -m "feat: add committee normalization helpers"
```

## Task 2: Policy Mapping Scoring And Override Semantics

**Files:**
- Modify: `api/tests/policy-committee-maps.test.ts`
- Create: `api/src/lib/policy-committee-maps.ts`

- [ ] **Step 1: Write the failing scoring and override tests**

```ts
import {
  scorePolicyCommitteeCandidate,
  applyPolicyCommitteeOverride,
} from "../src/lib/policy-committee-maps.ts";

test("scorePolicyCommitteeCandidate blends bill history and jurisdiction support", () => {
  const score = scorePolicyCommitteeCandidate({
    billCount: 12,
    jurisdictionWeight: 0.25,
    latestCongress: 119,
    currentCongress: 119,
  });

  assert.equal(score >= 0.8, true);
});

test("applyPolicyCommitteeOverride suppresses without deleting the row", () => {
  const row = applyPolicyCommitteeOverride(
    { confidence: 0.84, is_suppressed: false },
    { overrideAction: "suppress", confidenceDelta: null },
  );

  assert.deepEqual(row, { confidence: 0, is_suppressed: true, is_manual_override: true });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && node --test tests/policy-committee-maps.test.ts`

Expected: FAIL with missing exports from `policy-committee-maps.ts`.

- [ ] **Step 3: Write the minimal scoring and override implementation**

```ts
export function applyPolicyCommitteeOverride(
  row: { confidence: number; is_suppressed: boolean },
  override: { overrideAction: "promote" | "suppress" | "pin"; confidenceDelta: number | null },
) {
  if (override.overrideAction === "pin") {
    return { confidence: 1, is_suppressed: false, is_manual_override: true };
  }
  if (override.overrideAction === "suppress") {
    return { confidence: 0, is_suppressed: true, is_manual_override: true };
  }
  return {
    confidence: Math.min(1, row.confidence + (override.confidenceDelta ?? 0)),
    is_suppressed: false,
    is_manual_override: true,
  };
}

export function scorePolicyCommitteeCandidate(input: {
  billCount: number;
  jurisdictionWeight: number;
  latestCongress: number | null;
  currentCongress: number;
}) {
  const billComponent = Math.min(0.6, input.billCount * 0.05);
  const jurisdictionComponent = Math.min(0.25, input.jurisdictionWeight);
  const freshnessComponent = input.latestCongress === input.currentCongress ? 0.1 : 0;
  return Math.min(1, billComponent + jurisdictionComponent + freshnessComponent);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && node --test tests/policy-committee-maps.test.ts`

Expected: PASS for scoring and override semantics.

- [ ] **Step 5: Commit**

```bash
git add api/tests/policy-committee-maps.test.ts api/src/lib/policy-committee-maps.ts
git commit -m "feat: add policy committee scoring helpers"
```

## Task 3: Schema, Types, And Committee Backfill

**Files:**
- Create: `supabase/migrations/012_policy_committee_mapping.sql`
- Modify: `api/src/lib/db-types.ts`
- Modify: `api/src/lib/relationships.ts`
- Modify: `api/tests/policy-committee-maps.test.ts`

- [ ] **Step 1: Add a failing test for committee-key backfill payloads**

```ts
import { buildCommitteeAssignmentRow } from "../src/lib/committee-normalization.ts";

test("buildCommitteeAssignmentRow leaves committee_key null when chamber cannot be inferred", () => {
  const row = buildCommitteeAssignmentRow({
    bioguideId: "A000360",
    committeeName: "Armed Services",
    committeeCode: null,
    chamber: null,
  });

  assert.equal(row.committee_key, null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && node --test tests/policy-committee-maps.test.ts`

Expected: FAIL because `buildCommitteeAssignmentRow` is not implemented yet.

- [ ] **Step 3: Write the migration, types, and backfill plumbing**

```sql
ALTER TABLE member_committee_assignments
ADD COLUMN IF NOT EXISTS committee_key TEXT;

CREATE TABLE committees (
  id BIGSERIAL PRIMARY KEY,
  committee_key TEXT NOT NULL UNIQUE,
  committee_code TEXT,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  chamber TEXT,
  is_subcommittee BOOLEAN NOT NULL DEFAULT false,
  parent_committee_id BIGINT REFERENCES committees(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE committee_aliases (
  id BIGSERIAL PRIMARY KEY,
  committee_key TEXT NOT NULL,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE committee_match_review_queue (
  id BIGSERIAL PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_value TEXT NOT NULL,
  normalized_source_value TEXT NOT NULL,
  chamber TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE committee_jurisdiction_seeds (
  id BIGSERIAL PRIMARY KEY,
  committee_key TEXT NOT NULL,
  committee_id BIGINT REFERENCES committees(id) ON DELETE SET NULL,
  congress INTEGER NOT NULL,
  source_version TEXT NOT NULL,
  source_url TEXT NOT NULL,
  jurisdiction_text TEXT NOT NULL,
  jurisdiction_summary TEXT,
  effective_start_date DATE,
  effective_end_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (committee_key, congress, source_version)
);

CREATE TABLE policy_area_committee_map (
  id BIGSERIAL PRIMARY KEY,
  policy_area TEXT NOT NULL,
  subject_term TEXT,
  committee_id BIGINT NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  confidence NUMERIC(4,3) NOT NULL,
  source TEXT NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  bill_count INTEGER NOT NULL DEFAULT 0,
  first_seen_congress INTEGER,
  last_seen_congress INTEGER,
  last_seen_at TIMESTAMPTZ,
  is_manual_override BOOLEAN NOT NULL DEFAULT false,
  is_suppressed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE policy_area_committee_evidence (
  id BIGSERIAL PRIMARY KEY,
  map_id BIGINT NOT NULL REFERENCES policy_area_committee_map(id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_row_id TEXT NOT NULL,
  source_url TEXT,
  weight NUMERIC(4,3),
  note TEXT,
  evidence_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (map_id, evidence_type, source_table, source_row_id)
);

CREATE TABLE policy_area_committee_overrides (
  id BIGSERIAL PRIMARY KEY,
  policy_area TEXT NOT NULL,
  subject_term TEXT,
  committee_id BIGINT NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  override_action TEXT NOT NULL,
  confidence_delta NUMERIC(4,3),
  reason TEXT,
  source TEXT NOT NULL,
  created_by TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  effective_start_date DATE,
  effective_end_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_policy_area_committee_map_null_subject
  ON policy_area_committee_map (policy_area, committee_id)
  WHERE subject_term IS NULL;

CREATE UNIQUE INDEX idx_policy_area_committee_map_with_subject
  ON policy_area_committee_map (policy_area, subject_term, committee_id)
  WHERE subject_term IS NOT NULL;

CREATE UNIQUE INDEX idx_policy_area_committee_overrides_null_subject
  ON policy_area_committee_overrides (policy_area, committee_id)
  WHERE subject_term IS NULL;

CREATE UNIQUE INDEX idx_policy_area_committee_overrides_with_subject
  ON policy_area_committee_overrides (policy_area, subject_term, committee_id)
  WHERE subject_term IS NOT NULL;
```

- [ ] **Step 4: Run tests and type checks**

Run: `cd api && node --test tests/policy-committee-maps.test.ts && npm run build`

Expected: PASS for the tests and no TypeScript errors from the new schema surface.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/012_policy_committee_mapping.sql api/src/lib/db-types.ts api/src/lib/relationships.ts api/tests/policy-committee-maps.test.ts
git commit -m "feat: add policy committee mapping schema"
```

Schema requirements for this task:

- add indexes and uniqueness constraints for alias, seed, map, evidence, and override tables
- add RLS policies matching the spec: raw/seed writes service-only, derived reads exposed through Worker endpoints first
- update `db-types.ts` for every new table touched in this migration so later tasks compile cleanly

RLS requirements for this task:

- `committees`, `committee_aliases`, `committee_jurisdiction_seeds`, `committee_match_review_queue`, and `policy_area_committee_overrides` should be service-write only
- `policy_area_committee_map` and `policy_area_committee_evidence` should be readable through Worker APIs; if direct public reads are added later, they must be explicit and limited to derived rows
- do not add public-read policies to raw review-queue or seed tables

## Task 4: Derivation Service And Query Layer

**Files:**
- Modify: `api/src/lib/policy-committee-maps.ts`
- Modify: `api/tests/policy-committee-maps.test.ts`

- [ ] **Step 1: Add a failing derivation test**

```ts
import { derivePolicyCommitteeMappings } from "../src/lib/policy-committee-maps.ts";

test("derivePolicyCommitteeMappings groups bills by policy area and canonical committee", async () => {
  const rows = await derivePolicyCommitteeMappings({
    bills: [
      { policy_area: "Defense", committee_names: ["House Armed Services"] },
      { policy_area: "Defense", committee_names: ["House Armed Services"] },
    ],
    committeeLookup: new Map([["HOUSE ARMED SERVICES:House", { id: 1, committee_key: "HSAS" }]]),
    jurisdictionSeeds: [],
    overrides: [],
    currentCongress: 119,
  });

  assert.equal(rows[0]?.policy_area, "Defense");
  assert.equal(rows[0]?.committee_id, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && node --test tests/policy-committee-maps.test.ts`

Expected: FAIL because `derivePolicyCommitteeMappings` is incomplete.

- [ ] **Step 3: Implement the derivation and persistence entrypoints**

```ts
export async function refreshPolicyCommitteeMappings(sb: DbClient, congress: number) {
  const bills = await loadBillsForPolicyMapping(sb, congress);
  const committees = await loadCanonicalCommittees(sb);
  const seeds = await loadJurisdictionSeeds(sb, congress);
  const overrides = await loadActivePolicyOverrides(sb);
  const unmatched: Array<{ sourceType: string; sourceValue: string; chamber: string | null }> = [];

  const rows = await derivePolicyCommitteeMappings({
    bills,
    committeeLookup: committees,
    jurisdictionSeeds: seeds,
    overrides,
    unmatchedCollector: unmatched,
    currentCongress: congress,
  });

  await upsertCommitteeMatchReviewQueue(sb, unmatched);
  await replacePolicyCommitteeMappings(sb, rows);
}
```

Implementation note for this task: unmatched committee strings discovered while normalizing bill committee names must be written to `committee_match_review_queue` inside the refresh path. Do not silently drop or invent a fallback committee identity.

- [ ] **Step 4: Run tests and build**

Run: `cd api && node --test tests/policy-committee-maps.test.ts && npm run build`

Expected: PASS with deterministic derived rows and clean compile output.

- [ ] **Step 5: Commit**

```bash
git add api/src/lib/policy-committee-maps.ts api/tests/policy-committee-maps.test.ts
git commit -m "feat: derive policy committee mappings"
```

## Task 5: Maps API And Admin Refresh Routes

**Files:**
- Create: `api/src/apis/maps.ts`
- Create: `api/tests/policy-committee-endpoints.test.ts`
- Modify: `api/src/index.ts`
- Modify: `api/src/apis/correlation.ts`
- Modify: `api/src/lib/policy-committee-maps.ts`

- [ ] **Step 1: Write the failing endpoint tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.ts";

test("GET /api/maps/policy-committees returns visible rows for a policy area", async () => {
  const response = await app.request("/api/maps/policy-committees?policyArea=Defense");
  assert.equal(response.status, 200);
});

test("POST /api/correlation/refresh/policy-committee-map requires admin auth", async () => {
  const response = await app.request("/api/correlation/refresh/policy-committee-map", { method: "POST" });
  assert.equal(response.status, 401);
});

test("GET /api/maps/evidence/policy-committee/1 returns the stored evidence trail", async () => {
  const response = await app.request("/api/maps/evidence/policy-committee/1");
  assert.equal(response.status, 200);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && node --test tests/policy-committee-endpoints.test.ts`

Expected: FAIL because the `maps` router and refresh route do not exist yet.

- [ ] **Step 3: Implement the minimal routes**

```ts
maps.get("/policy-committees", async (c) => {
  const policyArea = c.req.query("policyArea")?.trim();
  if (!policyArea) return c.json({ error: "Missing policyArea" }, 400);
  const rows = await listPolicyCommitteeMappings(getSupabase(c.env), policyArea);
  return c.json({ policyArea, count: rows.length, data: rows });
});

maps.get("/evidence/:mapType/:mapId", async (c) => {
  const mapType = c.req.param("mapType");
  const mapId = Number.parseInt(c.req.param("mapId"), 10);
  const rows = await listMapEvidence(getSupabase(c.env), mapType, mapId);
  return c.json({ mapType, mapId, count: rows.length, data: rows });
});

correlation.post("/refresh/policy-committee-map", async (c) => {
  const congress = Number.parseInt(c.req.query("congress") ?? "119", 10);
  await refreshPolicyCommitteeMappings(getSupabase(c.env), congress);
  return c.json({ ok: true, congress });
});
```

- [ ] **Step 4: Run endpoint tests and build**

Run: `cd api && node --test tests/policy-committee-endpoints.test.ts tests/policy-committee-maps.test.ts && npm run build`

Expected: PASS for the read/admin route tests and no API build regressions.

- [ ] **Step 5: Commit**

```bash
git add api/src/apis/maps.ts api/src/index.ts api/src/apis/correlation.ts api/src/lib/policy-committee-maps.ts api/tests/policy-committee-endpoints.test.ts
git commit -m "feat: expose policy committee mapping APIs"
```

## Verification Checklist

- `cd api && node --test tests/policy-committee-maps.test.ts tests/policy-committee-endpoints.test.ts`
- `cd api && npm run build`
- Verify the migration adds public-read policies only where intended and keeps seed writes service-only.
- Manually hit `GET /api/maps/policy-committees?policyArea=Defense` in local dev after seeding one committee jurisdiction snapshot and one derived mapping row.
