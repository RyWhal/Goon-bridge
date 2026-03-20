import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { refreshPolicyCommitteeMappings } from "../src/lib/policy-committee-maps.ts";

type SupabaseRow = Record<string, unknown>;

const baseUrl = "https://example.supabase.co";
const originalEndpointTestMode = process.env.GOON_BRIDGE_ENDPOINT_TEST;
process.env.GOON_BRIDGE_ENDPOINT_TEST = "1";
const { default: app } = await import("../src/index.ts");
if (originalEndpointTestMode == null) {
  delete process.env.GOON_BRIDGE_ENDPOINT_TEST;
} else {
  process.env.GOON_BRIDGE_ENDPOINT_TEST = originalEndpointTestMode;
}

function parseSupabaseScalar(value: string): string | number | boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function matchesSupabaseFilter(row: SupabaseRow, key: string, rawValue: string): boolean {
  if (rawValue.startsWith("eq.")) {
    return row[key] === parseSupabaseScalar(rawValue.slice(3));
  }

  if (rawValue.startsWith("in.")) {
    const values = rawValue
      .slice(3)
      .replace(/^\(/, "")
      .replace(/\)$/, "")
      .split(",")
      .filter(Boolean)
      .map(parseSupabaseScalar);
    return values.some((value) => value === row[key]);
  }

  return true;
}

function sortRows(rows: SupabaseRow[], orderParam: string | null): SupabaseRow[] {
  if (!orderParam) return [...rows];

  const orderings = orderParam.split(",").map((entry) => {
    const [column, direction] = entry.split(".");
    return {
      column,
      descending: direction === "desc",
    };
  });

  return [...rows].sort((left, right) => {
    for (const order of orderings) {
      const leftValue = left[order.column];
      const rightValue = right[order.column];
      if (leftValue === rightValue) continue;
      if (leftValue == null) return 1;
      if (rightValue == null) return -1;
      if (leftValue < rightValue) return order.descending ? 1 : -1;
      if (leftValue > rightValue) return order.descending ? -1 : 1;
    }
    return 0;
  });
}

function buildSupabaseFetchStub(state: {
  committees: SupabaseRow[];
  policyAreaCommitteeMaps: SupabaseRow[];
  policyAreaCommitteeEvidence: SupabaseRow[];
}) {
  return async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const { pathname, searchParams } = url;

    const filterableParams = [...searchParams.entries()].filter(
      ([key]) => key !== "select" && key !== "order" && key !== "head"
    );

    let rows: SupabaseRow[] = [];

    if (pathname.endsWith("/policy_area_committee_map")) {
      rows = state.policyAreaCommitteeMaps;
    } else if (pathname.endsWith("/policy_area_committee_evidence")) {
      rows = state.policyAreaCommitteeEvidence;
    } else if (pathname.endsWith("/committees")) {
      rows = state.committees;
    } else {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    for (const [key, rawValue] of filterableParams) {
      rows = rows.filter((row) => matchesSupabaseFilter(row, key, rawValue));
    }

    rows = sortRows(rows, searchParams.get("order"));

    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Range": rows.length ? `0-${rows.length - 1}/${rows.length}` : "*/0",
      },
    });
  };
}

function makeEnv(overrides: Partial<Record<string, string>> = {}) {
  return {
    CONGRESS_API_KEY: "test-congress-key",
    OPENFEC_API_KEY: "test-openfec-key",
    FINNHUB_API_KEY: "test-finnhub-key",
    SUPABASE_URL: baseUrl,
    SUPABASE_SERVICE_KEY: "service-key",
    ADMIN_API_KEY: "admin-secret",
    ALLOWED_ORIGINS: "*",
    ENVIRONMENT: "development",
    ...overrides,
  };
}

function createRefreshHarness(initial?: {
  bills?: Array<Record<string, unknown>>;
  committees?: Array<Record<string, unknown>>;
  maps?: Array<Record<string, unknown>>;
  evidence?: Array<Record<string, unknown>>;
  reviewQueue?: Array<Record<string, unknown>>;
}) {
  const state = {
    bills: initial?.bills ?? [],
    committees: initial?.committees ?? [],
    maps: initial?.maps ?? [],
    evidence: initial?.evidence ?? [],
    reviewQueue: initial?.reviewQueue ?? [],
  };
  let nextId = 1;

  const makePromise = <T,>(value: T) => Promise.resolve(value);

  const makeSelectQuery = (table: string) => {
    const filters: Array<{ column: string; value: unknown }> = [];

    const resolve = () => {
      if (table === "bills") return state.bills;
      if (table === "committees") return state.committees;
      if (table === "policy_area_committee_map") return state.maps;
      if (table === "policy_area_committee_evidence") return state.evidence;
      if (table === "committee_match_review_queue") return state.reviewQueue;
      throw new Error(`Unexpected select table: ${table}`);
    };

    const query: any = {
      eq(column: string, value: unknown) {
        filters.push({ column, value });
        return query;
      },
      range() {
        return query;
      },
      order() {
        return makePromise({ data: resolve(), error: null });
      },
      then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
        return makePromise({ data: resolve(), error: null }).then(onFulfilled, onRejected);
      },
    };

    return query;
  };

  const makeDeleteQuery = (table: string) => ({
    eq(column: string, value: unknown) {
      if (table === "policy_area_committee_map") {
        state.maps = state.maps.filter((row) => row[column] !== value);
      } else if (table === "policy_area_committee_evidence") {
        state.evidence = state.evidence.filter((row) => row[column] !== value);
      } else if (table === "committee_match_review_queue") {
        state.reviewQueue = state.reviewQueue.filter((row) => row[column] !== value);
      } else {
        throw new Error(`Unexpected delete table: ${table}`);
      }
      return makePromise({ error: null });
    },
  });

  return {
    state,
    from(table: string) {
      if (
        table === "bills" ||
        table === "committees" ||
        table === "policy_area_committee_map" ||
        table === "policy_area_committee_evidence" ||
        table === "committee_match_review_queue"
      ) {
        return {
          select() {
            return makeSelectQuery(table);
          },
          delete() {
            return makeDeleteQuery(table);
          },
          upsert(rows: Array<Record<string, unknown>>) {
            if (table === "policy_area_committee_map") {
              const inserted = rows.map((row) => {
                const existing = state.maps.find(
                  (current) =>
                    current.policy_area === row.policy_area && current.committee_id === row.committee_id
                );
                if (existing) {
                  Object.assign(existing, row);
                  return existing;
                }
                const nextRow = { id: nextId++, ...row };
                state.maps.push(nextRow);
                return nextRow;
              });
              const response = { data: inserted, error: null };
              return {
                select() {
                  return makePromise(response);
                },
                then(onFulfilled: (value: typeof response) => unknown, onRejected?: (reason: unknown) => unknown) {
                  return makePromise(response).then(onFulfilled, onRejected);
                },
              };
            }

            if (table === "policy_area_committee_evidence") {
              for (const row of rows) {
                state.evidence.push({ id: nextId++, ...row });
              }
              return makePromise({ data: null, error: null });
            }

            throw new Error(`Unexpected upsert table: ${table}`);
          },
          insert(rows: Array<Record<string, unknown>>) {
            if (table !== "committee_match_review_queue") {
              throw new Error(`Unexpected insert table: ${table}`);
            }
            for (const row of rows) {
              state.reviewQueue.push({ id: nextId++, ...row });
            }
            return makePromise({ error: null });
          },
          update(patch: Record<string, unknown>) {
            return {
              eq(column: string, value: unknown) {
                const row = state.reviewQueue.find((entry) => entry[column] === value);
                if (row) Object.assign(row, patch);
                return makePromise({ error: null });
              },
            };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

test("refreshPolicyCommitteeMappings uses the requested congress as the freshness baseline", async () => {
  const harness = createRefreshHarness({
    bills: [
      {
        id: 41,
        congress: 118,
        policy_area: "DEFENSE",
        committee_names: ["Committee on Armed Services"],
      },
    ],
    committees: [
      {
        id: 7,
        committee_key: "ARMED SERVICES:House",
        committee_code: null,
        name: "Armed Services",
        normalized_name: "ARMED SERVICES",
        chamber: "House",
      },
    ],
  });

  await refreshPolicyCommitteeMappings(harness as never, 119);

  assert.equal(harness.state.maps[0]?.confidence, 0.15);
});

test("GET /api/maps/policy-committees?policyArea=Defense returns visible rows", async (t) => {
  mock.method(
    globalThis,
    "fetch",
    buildSupabaseFetchStub({
      committees: [
        {
          id: 1,
          committee_key: "ARMED SERVICES:House",
          committee_code: null,
          name: "Armed Services",
          normalized_name: "ARMED SERVICES",
          chamber: "House",
        },
        {
          id: 2,
          committee_key: "APPROPRIATIONS:House",
          committee_code: null,
          name: "Appropriations",
          normalized_name: "APPROPRIATIONS",
          chamber: "House",
        },
      ],
      policyAreaCommitteeMaps: [
        {
          id: 11,
          policy_area: "DEFENSE",
          committee_id: 1,
          confidence: 0.82,
          source: "bill_history",
          evidence_count: 3,
          bill_count: 3,
          first_seen_congress: 118,
          last_seen_congress: 119,
          last_seen_at: "2026-03-19T00:00:00.000Z",
          is_manual_override: false,
          is_suppressed: false,
          created_at: "2026-03-19T00:00:00.000Z",
          updated_at: "2026-03-19T00:00:00.000Z",
        },
        {
          id: 12,
          policy_area: "DEFENSE",
          committee_id: 2,
          confidence: 0.21,
          source: "bill_history",
          evidence_count: 1,
          bill_count: 1,
          first_seen_congress: 119,
          last_seen_congress: 119,
          last_seen_at: "2026-03-19T00:00:00.000Z",
          is_manual_override: false,
          is_suppressed: true,
          created_at: "2026-03-19T00:00:00.000Z",
          updated_at: "2026-03-19T00:00:00.000Z",
        },
      ],
      policyAreaCommitteeEvidence: [],
    })
  );
  t.after(() => mock.restoreAll());

  const response = await app.fetch(
    new Request(`${baseUrl}/api/maps/policy-committees?policyArea=Defense`),
    makeEnv()
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=900");
  assert.deepEqual(await response.json(), {
    policy_area: "DEFENSE",
    count: 1,
    rows: [
      {
        id: 11,
        policy_area: "DEFENSE",
        committee_id: 1,
        confidence: 0.82,
        source: "bill_history",
        evidence_count: 3,
        bill_count: 3,
        first_seen_congress: 118,
        last_seen_congress: 119,
        last_seen_at: "2026-03-19T00:00:00.000Z",
        is_manual_override: false,
        is_suppressed: false,
        created_at: "2026-03-19T00:00:00.000Z",
        updated_at: "2026-03-19T00:00:00.000Z",
        committee: {
          id: 1,
          committee_key: "ARMED SERVICES:House",
          committee_code: null,
          name: "Armed Services",
          normalized_name: "ARMED SERVICES",
          chamber: "House",
        },
      },
    ],
  });
});

test("GET /api/maps/policy-committees returns 400 when policyArea is missing", async () => {
  const response = await app.fetch(new Request(`${baseUrl}/api/maps/policy-committees`), makeEnv());

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Missing required query parameter 'policyArea'",
  });
});

test("GET /api/maps/policy-committees resolves defense shorthand to armed forces and national security", async (t) => {
  mock.method(
    globalThis,
    "fetch",
    buildSupabaseFetchStub({
      committees: [
        {
          id: 1,
          committee_key: "ARMED SERVICES:Unknown",
          committee_code: null,
          name: "Armed Services",
          normalized_name: "ARMED SERVICES",
          chamber: null,
        },
      ],
      policyAreaCommitteeMaps: [
        {
          id: 21,
          policy_area: "Armed Forces and National Security",
          committee_id: 1,
          confidence: 0.7,
          source: "bill_history",
          evidence_count: 4,
          bill_count: 4,
          first_seen_congress: 119,
          last_seen_congress: 119,
          last_seen_at: "2026-03-20T00:00:00.000Z",
          is_manual_override: false,
          is_suppressed: false,
          created_at: "2026-03-20T00:00:00.000Z",
          updated_at: "2026-03-20T00:00:00.000Z",
        },
      ],
      policyAreaCommitteeEvidence: [],
    })
  );
  t.after(() => mock.restoreAll());

  const response = await app.fetch(
    new Request(`${baseUrl}/api/maps/policy-committees?policyArea=Defense`),
    makeEnv()
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    policy_area: "Armed Forces and National Security",
    count: 1,
    rows: [
      {
        id: 21,
        policy_area: "Armed Forces and National Security",
        committee_id: 1,
        confidence: 0.7,
        source: "bill_history",
        evidence_count: 4,
        bill_count: 4,
        first_seen_congress: 119,
        last_seen_congress: 119,
        last_seen_at: "2026-03-20T00:00:00.000Z",
        is_manual_override: false,
        is_suppressed: false,
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
        committee: {
          id: 1,
          committee_key: "ARMED SERVICES:Unknown",
          committee_code: null,
          name: "Armed Services",
          normalized_name: "ARMED SERVICES",
          chamber: null,
        },
      },
    ],
  });
});

test("GET /api/maps/policy-committees returns 503 when Supabase is not configured", async () => {
  const response = await app.fetch(
    new Request(`${baseUrl}/api/maps/policy-committees?policyArea=Defense`),
    makeEnv({ SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "" })
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Supabase not configured",
  });
});

test("GET /api/maps/evidence/policy-committee/1 returns stored evidence", async (t) => {
  mock.method(
    globalThis,
    "fetch",
    buildSupabaseFetchStub({
      committees: [],
      policyAreaCommitteeMaps: [],
      policyAreaCommitteeEvidence: [
        {
          id: 101,
          map_id: 1,
          evidence_type: "bill_history",
          source_table: "bills",
          source_row_id: "201",
          source_url: "https://example.com/bills/201",
          weight: 1,
          note: "Derived from bill committee referrals",
          evidence_payload: {
            bill_id: 201,
            policy_area: "DEFENSE",
            committee_id: 1,
          },
          created_at: "2026-03-19T00:00:00.000Z",
        },
        {
          id: 102,
          map_id: 1,
          evidence_type: "bill_history",
          source_table: "bills",
          source_row_id: "202",
          source_url: "https://example.com/bills/202",
          weight: 1,
          note: "Derived from bill committee referrals",
          evidence_payload: {
            bill_id: 202,
            policy_area: "DEFENSE",
            committee_id: 1,
          },
          created_at: "2026-03-19T00:00:00.000Z",
        },
      ],
    })
  );
  t.after(() => mock.restoreAll());

  const response = await app.fetch(
    new Request(`${baseUrl}/api/maps/evidence/policy-committee/1`),
    makeEnv()
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=900");
  assert.deepEqual(await response.json(), {
    map_type: "policy-committee",
    map_id: 1,
    count: 2,
    evidence: [
      {
        id: 101,
        map_id: 1,
        evidence_type: "bill_history",
        source_table: "bills",
        source_row_id: "201",
        source_url: "https://example.com/bills/201",
        weight: 1,
        note: "Derived from bill committee referrals",
        evidence_payload: {
          bill_id: 201,
          policy_area: "DEFENSE",
          committee_id: 1,
        },
        created_at: "2026-03-19T00:00:00.000Z",
      },
      {
        id: 102,
        map_id: 1,
        evidence_type: "bill_history",
        source_table: "bills",
        source_row_id: "202",
        source_url: "https://example.com/bills/202",
        weight: 1,
        note: "Derived from bill committee referrals",
        evidence_payload: {
          bill_id: 202,
          policy_area: "DEFENSE",
          committee_id: 1,
        },
        created_at: "2026-03-19T00:00:00.000Z",
      },
    ],
  });
});

test("GET /api/maps/evidence/policy-committee/:mapId returns 400 for invalid ids", async () => {
  const response = await app.fetch(
    new Request(`${baseUrl}/api/maps/evidence/policy-committee/not-a-number`),
    makeEnv()
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Invalid policy committee map id",
  });
});

test("GET /api/maps/evidence/policy-committee/:mapId returns 503 when Supabase is not configured", async () => {
  const response = await app.fetch(
    new Request(`${baseUrl}/api/maps/evidence/policy-committee/1`),
    makeEnv({ SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "" })
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Supabase not configured",
  });
});

test("POST /api/correlation/refresh/policy-committee-map requires admin auth", async () => {
  const response = await app.fetch(
    new Request(`${baseUrl}/api/correlation/refresh/policy-committee-map`, { method: "POST" }),
    makeEnv({ ENVIRONMENT: "production" })
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: "Missing Authorization header",
  });
});

test("POST /api/correlation/refresh/policy-committee-map returns 503 when Supabase is not configured", async () => {
  const response = await app.fetch(
    new Request(`${baseUrl}/api/correlation/refresh/policy-committee-map`, {
      method: "POST",
      headers: { Authorization: "Bearer admin-secret" },
    }),
    makeEnv({
      ENVIRONMENT: "production",
      SUPABASE_URL: "",
      SUPABASE_SERVICE_KEY: "",
    })
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Supabase not configured",
  });
});
