# Organization Location To District Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a traceable `organization location observation -> congressional district` pipeline sourced from USAspending-derived location data and versioned district lookup references.

**Architecture:** Add normalized organization location tables plus a versioned district lookup reference table, then derive district mappings from direct source districts first and fallback lookup keys second. Reuse the existing USAspending normalization path, keep writes in Supabase, and extend the Worker maps API with read/admin routes.

**Tech Stack:** Supabase SQL migrations, TypeScript, Cloudflare Workers (Hono), Node `node:test`, existing USAspending fetch/normalization helpers, existing `organizations` and `organization_contract_awards` tables.

---

## File Map

- Create: `supabase/migrations/013_organization_location_district_mapping.sql`
- Create: `api/src/lib/location-district-maps.ts`
- Create: `api/tests/location-district-maps.test.ts`
- Create: `api/tests/location-district-endpoints.test.ts`
- Modify: `api/src/lib/usaspending.ts`
- Modify: `api/src/apis/usaspending.ts`
- Modify: `api/src/apis/maps.ts` (extend the router created by the policy plan; do not recreate it)
- Modify: `api/src/apis/correlation.ts`
- Modify: `api/src/lib/db-types.ts` (append new table types after the policy plan lands)

### Responsibility Notes

- `013_organization_location_district_mapping.sql`: schema for `organization_locations`, `district_lookup_reference`, district map/evidence tables, indexes, and RLS.
- `location-district-maps.ts`: pure helpers for fingerprints and resolver keys plus persistence/refresh logic for location observations and district mappings.
- `usaspending.ts`: shared award-to-location extraction helpers so admin refresh logic does not duplicate route-only parsing.
- `maps.ts`: read/admin HTTP routes for organization district mappings and evidence.

## Task 1: Location Fingerprints And Resolver Keys

**Files:**
- Create: `api/src/lib/location-district-maps.ts`
- Create: `api/tests/location-district-maps.test.ts`

- [ ] **Step 1: Write the failing helper tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLocationFingerprint,
  buildDistrictLookupKey,
  chooseDistrictResolution,
} from "../src/lib/location-district-maps.ts";

test("buildLocationFingerprint prefers address plus city/state/zip", () => {
  assert.equal(
    buildLocationFingerprint({
      address1: "1 Lockheed Blvd",
      city: "Fort Worth",
      state: "TX",
      zip: "76108",
    }),
    "1 LOCKHEED BLVD|FORT WORTH|TX|76108",
  );
});

test("chooseDistrictResolution prefers direct source districts over ZIP fallback", () => {
  assert.deepEqual(
    chooseDistrictResolution({
      directDistrict: "12",
      zipDistrict: "24",
    }),
    { district: "12", resolutionMethod: "direct_source" },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && node --test tests/location-district-maps.test.ts`

Expected: FAIL with missing module or missing exports.

- [ ] **Step 3: Write the minimal helper implementation**

```ts
export function buildLocationFingerprint(input: {
  address1?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}) {
  return [input.address1, input.city, input.state, input.zip]
    .map((value) => (value ?? "").trim().toUpperCase())
    .filter(Boolean)
    .join("|");
}

export function chooseDistrictResolution(input: {
  directDistrict?: string | null;
  zipDistrict?: string | null;
}) {
  if (input.directDistrict) return { district: input.directDistrict, resolutionMethod: "direct_source" as const };
  return { district: input.zipDistrict ?? null, resolutionMethod: "zip_centroid" as const };
}

export function buildDistrictLookupKey(input: {
  congress: number | null;
  lookupType: "zip" | "county" | "address" | "lat_lon";
  zip?: string | null;
}) {
  if (!input.congress || !input.zip) return null;
  return `${input.congress}|${input.lookupType}|${input.zip}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && node --test tests/location-district-maps.test.ts`

Expected: PASS for fingerprint and resolution helpers.

- [ ] **Step 5: Commit**

```bash
git add api/tests/location-district-maps.test.ts api/src/lib/location-district-maps.ts
git commit -m "feat: add location district helper primitives"
```

## Task 2: Schema And Type Surface

**Files:**
- Create: `supabase/migrations/013_organization_location_district_mapping.sql`
- Modify: `api/src/lib/db-types.ts`
- Modify: `api/tests/location-district-maps.test.ts`

- [ ] **Step 1: Add a failing row-shape test**

```ts
import { buildOrganizationLocationRow } from "../src/lib/location-district-maps.ts";

test("buildOrganizationLocationRow keeps source identity for idempotent upserts", () => {
  const row = buildOrganizationLocationRow({
    source: "usaspending_award",
    sourceRowId: "generated-id-1",
    city: "Fort Worth",
    state: "TX",
    zip: "76108",
  });

  assert.equal(row.source, "usaspending_award");
  assert.equal(row.source_row_id, "generated-id-1");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && node --test tests/location-district-maps.test.ts`

Expected: FAIL because the row builder and schema-backed fields do not exist yet.

- [ ] **Step 3: Write the migration and update `db-types.ts`**

```sql
CREATE TABLE district_lookup_reference (
  id BIGSERIAL PRIMARY KEY,
  congress INTEGER NOT NULL,
  lookup_key TEXT NOT NULL,
  lookup_type TEXT NOT NULL,
  state TEXT NOT NULL,
  district TEXT NOT NULL,
  resolution_method TEXT NOT NULL,
  source TEXT NOT NULL,
  source_version TEXT NOT NULL,
  effective_start_date DATE,
  effective_end_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (congress, lookup_type, lookup_key, source_version)
);

CREATE TABLE organization_locations (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_name TEXT,
  address1 TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  latitude NUMERIC,
  longitude NUMERIC,
  location_kind TEXT NOT NULL,
  location_fingerprint TEXT NOT NULL,
  source TEXT NOT NULL,
  source_row_id TEXT NOT NULL,
  confidence NUMERIC(4,3),
  source_congress INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, source_row_id)
);

CREATE INDEX idx_organization_locations_org_fingerprint
  ON organization_locations (organization_id, location_fingerprint);

CREATE TABLE organization_location_district_map (
  id BIGSERIAL PRIMARY KEY,
  organization_location_id BIGINT NOT NULL REFERENCES organization_locations(id) ON DELETE CASCADE,
  congress INTEGER NOT NULL,
  state TEXT,
  district TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL,
  resolution_method TEXT NOT NULL,
  source TEXT NOT NULL,
  lookup_reference_id BIGINT REFERENCES district_lookup_reference(id) ON DELETE SET NULL,
  lookup_source_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_location_id, congress)
);

CREATE TABLE organization_location_district_evidence (
  id BIGSERIAL PRIMARY KEY,
  map_id BIGINT NOT NULL REFERENCES organization_location_district_map(id) ON DELETE CASCADE,
  source_table TEXT NOT NULL,
  source_row_id TEXT NOT NULL,
  source_url TEXT,
  weight NUMERIC(4,3),
  note TEXT,
  evidence_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (map_id, source_table, source_row_id)
);
```

- [ ] **Step 4: Run tests and type checks**

Run: `cd api && node --test tests/location-district-maps.test.ts && npm run build`

Expected: PASS for helper tests and no TypeScript drift from the new schema.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/013_organization_location_district_mapping.sql api/src/lib/db-types.ts api/tests/location-district-maps.test.ts
git commit -m "feat: add location district mapping schema"
```

Schema requirements for this task:

- add the district map/evidence indexes and uniqueness constraints required by the spec
- keep raw lookup reference writes service-only
- update `db-types.ts` additively, preserving the tables added by the policy plan

Implementation note for this task: add `buildOrganizationLocationRow()` to `location-district-maps.ts` so the row-shape test and later extraction logic share one payload builder.

## Task 3: USAspending-Derived Location Refresh

**Files:**
- Modify: `api/src/lib/usaspending.ts`
- Modify: `api/src/apis/usaspending.ts`
- Modify: `api/src/lib/location-district-maps.ts`
- Modify: `api/tests/location-district-maps.test.ts`

- [ ] **Step 1: Add a failing extraction test**

```ts
import { extractOrganizationLocationObservations } from "../src/lib/location-district-maps.ts";

test("extractOrganizationLocationObservations converts normalized awards into location rows", () => {
  const rows = extractOrganizationLocationObservations(42, 119, [
    {
      awardId: "FA1234-25-C-0001",
      performanceCity: "Fort Worth",
      performanceState: "TX",
      performanceZipCode: "76108",
      performanceCongressionalDistrict: "12",
      permalink: "award-1",
    },
  ]);

  assert.equal(rows[0]?.organization_id, 42);
  assert.equal(rows[0]?.location_kind, "performance");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && node --test tests/location-district-maps.test.ts`

Expected: FAIL because the extraction helper does not exist yet.

- [ ] **Step 3: Refactor shared USAspending parsing and implement refresh**

```ts
export function extractOrganizationLocationObservations(
  organizationId: number,
  congress: number,
  awards: Array<NormalizedAward>,
) {
  return awards
    .filter((award) => (award.performanceCity || award.performanceZipCode) && (award.permalink || award.awardId))
    .map((award) => buildOrganizationLocationRow({
      organizationId,
      congress,
      city: award.performanceCity ?? null,
      state: award.performanceState ?? null,
      zip: award.performanceZipCode ?? null,
      directDistrict: award.performanceCongressionalDistrict ?? null,
      sourceRowId: award.permalink ?? award.awardId!,
    }));
}
```

- [ ] **Step 4: Run tests and build**

Run: `cd api && node --test tests/location-district-maps.test.ts && npm run build`

Expected: PASS for extraction behavior and no compile regressions after the USAspending refactor.

- [ ] **Step 5: Commit**

```bash
git add api/src/lib/usaspending.ts api/src/apis/usaspending.ts api/src/lib/location-district-maps.ts api/tests/location-district-maps.test.ts
git commit -m "feat: derive organization locations from usaspending awards"
```

## Task 4: District Resolution And Persistence

**Files:**
- Modify: `api/src/lib/location-district-maps.ts`
- Modify: `api/tests/location-district-maps.test.ts`

- [ ] **Step 1: Add a failing derivation test**

```ts
import { deriveOrganizationLocationDistrictRows } from "../src/lib/location-district-maps.ts";

test("deriveOrganizationLocationDistrictRows uses direct district before lookup reference", () => {
  const rows = deriveOrganizationLocationDistrictRows({
    locations: [{
      id: 5,
      state: "TX",
      zip: "76108",
      source_congress: 119,
      raw_direct_district: "12",
    }],
    lookupByKey: new Map([["119|zip|76108", { district: "24", resolution_method: "zip_centroid" }]]),
  });

  assert.equal(rows[0]?.district, "12");
  assert.equal(rows[0]?.resolution_method, "direct_source");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && node --test tests/location-district-maps.test.ts`

Expected: FAIL because the district derivation function does not exist yet.

- [ ] **Step 3: Implement district derivation and upserts**

```ts
export function deriveOrganizationLocationDistrictRows(input: {
  locations: Array<LocationRow>;
  lookupByKey: Map<string, LookupRow>;
}) {
  return input.locations.flatMap((location) => {
    const directDistrict = location.raw_direct_district ?? null;
    const lookupKey = buildDistrictLookupKey({
      congress: location.source_congress,
      lookupType: "zip",
      zip: location.zip,
    });
    const lookup = lookupKey ? input.lookupByKey.get(lookupKey) : null;
    const chosen = chooseDistrictResolution({
      directDistrict,
      zipDistrict: lookup?.district ?? null,
    });
    if (!chosen.district) return [];
    return [{
      organization_location_id: location.id,
      congress: location.source_congress,
      state: location.state,
      district: chosen.district,
      confidence: chosen.resolutionMethod === "direct_source" ? 0.95 : 0.68,
      resolution_method: chosen.resolutionMethod,
      source: "usaspending_derived",
      lookup_reference_id: lookup?.id ?? null,
      lookup_source_version: lookup?.source_version ?? null,
    }];
  });
}
```

Implementation note for this task: when resolution comes from `district_lookup_reference`, persist both the reference row id and its `source_version` on `organization_location_district_map`. That metadata is part of the audit trail and should also be echoed into `organization_location_district_evidence`.

- [ ] **Step 4: Run tests and build**

Run: `cd api && node --test tests/location-district-maps.test.ts && npm run build`

Expected: PASS for direct-vs-lookup resolution behavior and clean compile output.

- [ ] **Step 5: Commit**

```bash
git add api/src/lib/location-district-maps.ts api/tests/location-district-maps.test.ts
git commit -m "feat: derive organization location district mappings"
```

## Task 5: Maps API And Admin Refresh Routes

**Files:**
- Create: `api/tests/location-district-endpoints.test.ts`
- Modify: `api/src/apis/maps.ts`
- Modify: `api/src/apis/correlation.ts`
- Modify: `api/src/lib/location-district-maps.ts`

- [ ] **Step 1: Write the failing endpoint tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.ts";

test("GET /api/maps/organization-districts returns visible district rows", async () => {
  const response = await app.request("/api/maps/organization-districts?organizationId=42");
  assert.equal(response.status, 200);
});

test("POST /api/correlation/refresh/organization-location-map requires admin auth", async () => {
  const response = await app.request("/api/correlation/refresh/organization-location-map", { method: "POST" });
  assert.equal(response.status, 401);
});

test("GET /api/maps/evidence/location-district/1 returns the stored evidence trail", async () => {
  const response = await app.request("/api/maps/evidence/location-district/1");
  assert.equal(response.status, 200);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && node --test tests/location-district-endpoints.test.ts`

Expected: FAIL because the read/admin routes do not exist yet.

- [ ] **Step 3: Implement the minimal routes**

```ts
maps.get("/organization-districts", async (c) => {
  const organizationId = Number.parseInt(c.req.query("organizationId") ?? "", 10);
  if (!Number.isFinite(organizationId)) return c.json({ error: "Invalid organizationId" }, 400);
  const rows = await listOrganizationDistrictMappings(getSupabase(c.env), organizationId);
  return c.json({ organizationId, count: rows.length, data: rows });
});

correlation.post("/refresh/organization-location-map", async (c) => {
  const organizationId = Number.parseInt(c.req.query("organizationId") ?? "", 10);
  const congress = Number.parseInt(c.req.query("congress") ?? "", 10);
  await refreshOrganizationLocationMappings(getSupabase(c.env), { organizationId, congress });
  return c.json({ ok: true, organizationId });
});
```

In this task, extend the shared `GET /api/maps/evidence/:mapType/:mapId` handler created by the policy plan so it can load `location-district` evidence from `organization_location_district_evidence`.

- [ ] **Step 4: Run endpoint tests and build**

Run: `cd api && node --test tests/location-district-endpoints.test.ts tests/location-district-maps.test.ts && npm run build`

Expected: PASS for the location district endpoints and no Worker build regressions.

- [ ] **Step 5: Commit**

```bash
git add api/src/apis/maps.ts api/src/apis/correlation.ts api/src/lib/location-district-maps.ts api/tests/location-district-endpoints.test.ts
git commit -m "feat: expose organization district mapping APIs"
```

## Verification Checklist

- `cd api && node --test tests/location-district-maps.test.ts tests/location-district-endpoints.test.ts`
- `cd api && npm run build`
- Seed one `district_lookup_reference` row and one normalized USAspending award, then verify `GET /api/maps/organization-districts?organizationId=<id>` returns the mapped district and evidence.
- Verify suppressed or unmapped rows stay queryable internally but do not appear in default public-read responses.
