import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildCommitteeAssignmentRow,
  buildCommitteeKey,
  collapseCommitteeToTopLevel,
} from "../src/lib/committee-normalization.ts";
import { replaceMemberCommitteeAssignments } from "../src/lib/relationships.ts";
import {
  applyPolicyCommitteeOverride,
  derivePolicyCommitteeMappings,
  refreshPolicyCommitteeMappings,
  scorePolicyCommitteeCandidate,
} from "../src/lib/policy-committee-maps.ts";

type PolicyCommitteeMapFixture = {
  id: number;
  policy_area: string;
  committee_id: number;
  source: string;
  confidence?: number;
  updated_at?: string;
};

type PolicyCommitteeEvidenceFixture = {
  id: number;
  map_id: number;
  evidence_type: string;
  source_table: string;
  source_row_id: string;
  note?: string | null;
  updated_at?: string;
};

type CommitteeMatchReviewQueueFixture = {
  id: number;
  source_type: string;
  source_value: string;
  normalized_source_value: string;
  chamber: string | null;
  review_status: string;
  updated_at?: string;
};

function createRefreshHarness(initial?: {
  bills?: Array<Record<string, unknown>>;
  committees?: Array<Record<string, unknown>>;
  maps?: PolicyCommitteeMapFixture[];
  evidence?: PolicyCommitteeEvidenceFixture[];
  reviewQueue?: CommitteeMatchReviewQueueFixture[];
}) {
  const state = {
    bills: initial?.bills ?? [],
    committees: initial?.committees ?? [],
    maps: initial?.maps ?? [],
    evidence: initial?.evidence ?? [],
    reviewQueue: initial?.reviewQueue ?? [],
  };
  const operations: string[] = [];
  let nextId =
    1 +
    Math.max(
      0,
      ...state.maps.map((row) => row.id),
      ...state.evidence.map((row) => row.id),
      ...state.reviewQueue.map((row) => row.id)
    );

  const makePromise = <T,>(value: T) => Promise.resolve(value);

  const makeSelectQuery = (table: string) => {
    const filters: Array<{ column: string; value: unknown }> = [];

    const resolve = () => {
      if (table === "bills") {
        const congressFilter = filters.find((filter) => filter.column === "congress");
        const data = congressFilter == null
          ? state.bills
          : state.bills.filter((row) => row.congress === congressFilter.value);
        return data;
      }

      if (table === "committees") {
        return state.committees;
      }

      if (table === "policy_area_committee_map") {
        return state.maps.filter((row) => {
          const sourceFilter = filters.find((filter) => filter.column === "source");
          return sourceFilter == null || row.source === sourceFilter.value;
        });
      }

      if (table === "policy_area_committee_evidence") {
        return state.evidence.filter((row) => {
          const sourceFilter = filters.find((filter) => filter.column === "source_table");
          return sourceFilter == null || row.source_table === sourceFilter.value;
        });
      }

      if (table === "committee_match_review_queue") {
        return state.reviewQueue.filter((row) => {
          const sourceFilter = filters.find((filter) => filter.column === "source_type");
          return sourceFilter == null || row.source_type === sourceFilter.value;
        });
      }

      throw new Error(`Unexpected select table: ${table}`);
    };

    const query: any = {
      eq(column: string, value: unknown) {
        filters.push({ column, value });
        return query;
      },
      order() {
        return makePromise({ data: resolve(), error: null });
      },
      maybeSingle() {
        const data = resolve();
        return makePromise({ data: data[0] ?? null, error: null });
      },
      then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
        return makePromise({ data: resolve(), error: null }).then(onFulfilled, onRejected);
      },
    };

    return query;
  };

  const makeDeleteQuery = (table: string) => {
    const filters: Array<{ column: string; value: unknown }> = [];
    const query: any = {
      eq(column: string, value: unknown) {
        filters.push({ column, value });
        return makePromise({
          error: null,
        }).then((result) => {
          if (table === "policy_area_committee_map") {
            state.maps = state.maps.filter((row) => !(filters.every((filter) => row[filter.column as keyof typeof row] === filter.value)));
          } else if (table === "policy_area_committee_evidence") {
            state.evidence = state.evidence.filter((row) => !(filters.every((filter) => row[filter.column as keyof typeof row] === filter.value)));
          } else if (table === "committee_match_review_queue") {
            state.reviewQueue = state.reviewQueue.filter((row) => !(filters.every((filter) => row[filter.column as keyof typeof row] === filter.value)));
          } else {
            throw new Error(`Unexpected delete table: ${table}`);
          }
          operations.push(`${table}.delete:${filters.map((filter) => `${filter.column}=${String(filter.value)}`).join(",")}`);
          return result;
        });
      },
    };
    return query;
  };

  const from = (table: string) => {
    if (table === "bills" || table === "committees" || table === "policy_area_committee_map" || table === "policy_area_committee_evidence" || table === "committee_match_review_queue") {
      return {
        select() {
          operations.push(`${table}.select`);
          return makeSelectQuery(table);
        },
        delete() {
          return makeDeleteQuery(table);
        },
        upsert(rows: Array<Record<string, unknown>>) {
          operations.push(`${table}.upsert:${rows.length}`);
          if (table === "policy_area_committee_map") {
            const currentRows = rows.map((row) => {
              const key = `${row.policy_area as string}|${row.committee_id as number}`;
              const existing = state.maps.find((existingRow) => `${existingRow.policy_area}|${existingRow.committee_id}` === key);
              if (existing) {
                Object.assign(existing, row);
                return existing;
              }
              const inserted = {
                id: nextId++,
                policy_area: row.policy_area as string,
                committee_id: row.committee_id as number,
                source: row.source as string,
                confidence: row.confidence as number | undefined,
                updated_at: row.updated_at as string | undefined,
              };
              state.maps.push(inserted);
              return inserted;
            });
            const response = { data: currentRows, error: null };
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
              const key = `${row.map_id as number}|${row.evidence_type as string}|${row.source_table as string}|${row.source_row_id as string}`;
              const existing = state.evidence.find((existingRow) => `${existingRow.map_id}|${existingRow.evidence_type}|${existingRow.source_table}|${existingRow.source_row_id}` === key);
              if (existing) {
                Object.assign(existing, row);
              } else {
                state.evidence.push({
                  id: nextId++,
                  map_id: row.map_id as number,
                  evidence_type: row.evidence_type as string,
                  source_table: row.source_table as string,
                  source_row_id: row.source_row_id as string,
                  note: (row.note as string | null | undefined) ?? null,
                  updated_at: row.updated_at as string | undefined,
                });
              }
            }
            const response = { data: null, error: null };
            return makePromise(response);
          }

          throw new Error(`Unexpected upsert table: ${table}`);
        },
        insert(rows: Array<Record<string, unknown>>) {
          operations.push(`${table}.insert:${rows.length}`);
          if (table === "committee_match_review_queue") {
            for (const row of rows) {
              state.reviewQueue.push({
                id: nextId++,
                source_type: row.source_type as string,
                source_value: row.source_value as string,
                normalized_source_value: row.normalized_source_value as string,
                chamber: (row.chamber as string | null | undefined) ?? null,
                review_status: (row.review_status as string | undefined) ?? "pending",
                updated_at: row.updated_at as string | undefined,
              });
            }
            return makePromise({ error: null });
          }
          throw new Error(`Unexpected insert table: ${table}`);
        },
        update(patch: Record<string, unknown>) {
          operations.push(`${table}.update`);
          return {
            eq(column: string, value: unknown) {
              if (table === "committee_match_review_queue") {
                const row = state.reviewQueue.find((entry) => entry[column as keyof CommitteeMatchReviewQueueFixture] === value);
                if (!row) return makePromise({ error: null });
                Object.assign(row, patch);
                return makePromise({ error: null });
              }
              throw new Error(`Unexpected update table: ${table}`);
            },
          };
        },
      };
    }

    throw new Error(`Unexpected table: ${table}`);
  };

  return { from, state, operations };
}

test("buildCommitteeKey prefers committee code", () => {
  assert.equal(
    buildCommitteeKey({
      committeeCode: "HSAG00",
      normalizedName: "ARMED SERVICES",
      chamber: "House",
    }),
    "HSAG00"
  );
});

test("buildCommitteeKey falls back to normalized name plus chamber", () => {
  assert.equal(
    buildCommitteeKey({
      committeeCode: null,
      normalizedName: "ARMED SERVICES",
      chamber: "House",
    }),
    "ARMED SERVICES:House"
  );
});

test("buildCommitteeKey returns null when chamber is absent", () => {
  assert.equal(
    buildCommitteeKey({
      committeeCode: null,
      normalizedName: "ARMED SERVICES",
      chamber: null,
    }),
    null
  );
});

test("collapseCommitteeToTopLevel maps known subcommittees to parent committee", () => {
  assert.deepEqual(
    collapseCommitteeToTopLevel("Subcommittee on Defense", {
      parentCommitteeName: null,
      chamber: "House",
    }),
    { normalizedName: "ARMED SERVICES", chamber: "House" }
  );
});

test("collapseCommitteeToTopLevel matches comma-stripped aliases", () => {
  assert.deepEqual(
    collapseCommitteeToTopLevel("Subcommittee on Courts, Intellectual Property, and the Internet", {
      parentCommitteeName: null,
      chamber: "House",
    }),
    { normalizedName: "JUDICIARY", chamber: "House" }
  );
});

test("buildCommitteeAssignmentRow includes the canonical committee key", () => {
  assert.deepEqual(
    buildCommitteeAssignmentRow({
      bioguideId: "A000148",
      committeeName: "Subcommittee on Defense",
      committeeCode: null,
      chamber: "House",
    }),
    {
      bioguide_id: "A000148",
      committee_code: null,
      committee_name: "Subcommittee on Defense",
      committee_key: "ARMED SERVICES:House",
      normalized_committee_name: "ARMED SERVICES",
      chamber: "House",
      source_row_key: "A000148:committee:ARMED SERVICES:House",
    }
  );
});

test("derivePolicyCommitteeMappings groups bills by policy area and canonical committee", () => {
  const result = derivePolicyCommitteeMappings({
    bills: [
      {
        id: 101,
        congress: 119,
        policy_area: "DEFENSE",
        committee_names: ["Subcommittee on Defense"],
      },
      {
        id: 102,
        congress: 119,
        policy_area: "DEFENSE",
        committee_names: ["Committee on Armed Services"],
      },
      {
        id: 103,
        congress: 119,
        policy_area: "HEALTH",
        committee_names: ["Subcommittee on Health"],
      },
      {
        id: 104,
        congress: 119,
        policy_area: "HEALTH",
        committee_names: ["Committee on Energy and Commerce"],
      },
      {
        id: 105,
        congress: 119,
        policy_area: "HEALTH",
        committee_names: ["Unknown Special Committee"],
      },
      {
        id: 106,
        congress: 119,
        policy_area: "HEALTH",
        committee_names: ["unknown special committee"],
      },
    ],
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
        committee_key: "ENERGY AND COMMERCE:House",
        committee_code: null,
        name: "Energy and Commerce",
        normalized_name: "ENERGY AND COMMERCE",
        chamber: "House",
      },
    ],
  });

  assert.deepEqual(result.mappings, [
    {
      policy_area: "DEFENSE",
      committee_id: 1,
      committee_key: "ARMED SERVICES:House",
      bill_count: 2,
      bill_ids: [101, 102],
    },
    {
      policy_area: "HEALTH",
      committee_id: 2,
      committee_key: "ENERGY AND COMMERCE:House",
      bill_count: 2,
      bill_ids: [103, 104],
    },
  ]);

  assert.deepEqual(result.reviewQueueRows, [
    {
      source_type: "bill_committee_name",
      source_value: "Unknown Special Committee",
      normalized_source_value: "UNKNOWN SPECIAL COMMITTEE",
      chamber: null,
      review_status: "pending",
    },
    {
      source_type: "bill_committee_name",
      source_value: "unknown special committee",
      normalized_source_value: "UNKNOWN SPECIAL COMMITTEE",
      chamber: null,
      review_status: "pending",
    },
  ]);
});

test("refreshPolicyCommitteeMappings writes derived rows before pruning stale ones and preserves raw queue identities", async () => {
  const harness = createRefreshHarness({
    bills: [
      {
        id: 201,
        congress: 119,
        policy_area: "DEFENSE",
        committee_names: [
          "Subcommittee on Defense",
          "Unknown Special Committee",
          "unknown special committee",
        ],
      },
    ],
    committees: [
      {
        id: 1,
        committee_key: "ARMED SERVICES:House",
        committee_code: null,
        name: "Armed Services",
        normalized_name: "ARMED SERVICES",
        chamber: "House",
      },
    ],
    maps: [
      { id: 7, policy_area: "DEFENSE", committee_id: 1, source: "bill_history", confidence: 0.42 },
      { id: 8, policy_area: "HEALTH", committee_id: 2, source: "bill_history", confidence: 0.31 },
    ],
    evidence: [
      { id: 71, map_id: 7, evidence_type: "bill_history", source_table: "bills", source_row_id: "999" },
      { id: 72, map_id: 8, evidence_type: "bill_history", source_table: "bills", source_row_id: "888" },
    ],
    reviewQueue: [
      {
        id: 501,
        source_type: "bill_committee_name",
        source_value: "Old Unmatched",
        normalized_source_value: "OLD UNMATCHED",
        chamber: null,
        review_status: "pending",
      },
      {
        id: 502,
        source_type: "bill_committee_name",
        source_value: "Unknown Special Committee",
        normalized_source_value: "UNKNOWN SPECIAL COMMITTEE",
        chamber: null,
        review_status: "pending",
      },
    ],
  });

  const result = await refreshPolicyCommitteeMappings(harness as never, 119);

  assert.equal(result.mappingsWritten, 1);
  assert.equal(result.evidenceRowsWritten, 1);
  assert.equal(result.reviewQueueRowsWritten, 2);

  assert.deepEqual(
    harness.state.maps.map(({ id, policy_area, committee_id, source, confidence }) => ({
      id,
      policy_area,
      committee_id,
      source,
      confidence,
      updated_at: typeof (harness.state.maps.find((row) => row.id === id)?.updated_at) === "string",
    })),
    [
      {
        id: 7,
        policy_area: "DEFENSE",
        committee_id: 1,
        source: "bill_history",
        confidence: 0.25,
        updated_at: true,
      },
    ]
  );

  assert.deepEqual(
    harness.state.evidence.map(({ id, map_id, source_row_id }) => ({
      id,
      map_id,
      source_row_id,
    })),
    [
      {
        id: 503,
        map_id: 7,
        source_row_id: "201",
      },
    ]
  );

  assert.deepEqual(
    harness.state.reviewQueue.map(({ id, source_value, normalized_source_value, review_status, updated_at }) => ({
      id,
      source_value,
      normalized_source_value,
      review_status,
      updated_at: typeof updated_at === "string",
    })),
    [
      {
        id: 502,
        source_value: "Unknown Special Committee",
        normalized_source_value: "UNKNOWN SPECIAL COMMITTEE",
        review_status: "pending",
        updated_at: true,
      },
      {
        id: 504,
        source_value: "unknown special committee",
        normalized_source_value: "UNKNOWN SPECIAL COMMITTEE",
        review_status: "pending",
        updated_at: true,
      },
    ]
  );

  const mapUpsertIndex = harness.operations.findIndex((entry) => entry.startsWith("policy_area_committee_map.upsert"));
  const mapDeleteIndex = harness.operations.findIndex((entry) => entry.startsWith("policy_area_committee_map.delete"));
  const queueInsertIndex = harness.operations.findIndex((entry) => entry.startsWith("committee_match_review_queue.insert"));
  const queueDeleteIndex = harness.operations.findIndex((entry) => entry.startsWith("committee_match_review_queue.delete"));

  assert.ok(mapUpsertIndex >= 0);
  assert.ok(queueInsertIndex >= 0);
  assert.ok(mapDeleteIndex > mapUpsertIndex);
  assert.ok(queueDeleteIndex > queueInsertIndex);
});

test("refreshPolicyCommitteeMappings removes duplicate review queue rows deterministically", async () => {
  const harness = createRefreshHarness({
    bills: [
      {
        id: 301,
        congress: 119,
        policy_area: "HEALTH",
        committee_names: ["Unknown Special Committee"],
      },
    ],
    committees: [
      {
        id: 1,
        committee_key: "ARMED SERVICES:House",
        committee_code: null,
        name: "Armed Services",
        normalized_name: "ARMED SERVICES",
        chamber: "House",
      },
    ],
    reviewQueue: [
      {
        id: 901,
        source_type: "bill_committee_name",
        source_value: "Unknown Special Committee",
        normalized_source_value: "UNKNOWN SPECIAL COMMITTEE",
        chamber: null,
        review_status: "pending",
      },
      {
        id: 902,
        source_type: "bill_committee_name",
        source_value: "Unknown Special Committee",
        normalized_source_value: "UNKNOWN SPECIAL COMMITTEE",
        chamber: null,
        review_status: "pending",
      },
      {
        id: 903,
        source_type: "bill_committee_name",
        source_value: "Old Stale Committee",
        normalized_source_value: "OLD STALE COMMITTEE",
        chamber: null,
        review_status: "pending",
      },
    ],
  });

  await refreshPolicyCommitteeMappings(harness as never, 119);

  assert.deepEqual(
    harness.state.reviewQueue.map(({ id, source_value }) => ({ id, source_value })),
    [
      {
        id: 901,
        source_value: "Unknown Special Committee",
      },
    ]
  );

  assert.ok(harness.operations.includes("committee_match_review_queue.delete:id=902"));
  assert.ok(harness.operations.includes("committee_match_review_queue.delete:id=903"));
});

test("policy committee migration anchors canonical committee_key references", () => {
  const migration = readFileSync(
    new URL("../../supabase/migrations/012_policy_committee_mapping.sql", import.meta.url),
    "utf8"
  );

  assert.equal(
    /ALTER TABLE member_committee_assignments[\s\S]*FOREIGN KEY \(committee_key\) REFERENCES committees\(committee_key\)/.test(migration),
    false
  );
  assert.match(migration, /committee_aliases[\s\S]*committee_key TEXT NOT NULL REFERENCES committees\(committee_key\)/);
  assert.match(migration, /committee_jurisdiction_seeds[\s\S]*committee_key TEXT NOT NULL REFERENCES committees\(committee_key\)/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_member_committee_assignments_committee_key/);
});

test("replaceMemberCommitteeAssignments links subcommittee rows through selected committee_key values", async () => {
  let committeeInsertPayload: Array<Record<string, unknown>> | null = null;
  let committeeSelectColumns: string | null = null;
  let subcommitteeInsertPayload: Array<Record<string, unknown>> | null = null;

  const sb = {
    from(table: string) {
      if (table === "member_committee_assignments") {
        return {
          delete() {
            return {
              eq: async () => ({ error: null }),
            };
          },
          insert(payload: Array<Record<string, unknown>>) {
            committeeInsertPayload = payload;
            return {
              select(columns: string) {
                committeeSelectColumns = columns;
                return Promise.resolve({
                  data: [{ id: 44, committee_key: committeeInsertPayload?.[0]?.committee_key ?? null }],
                  error: null,
                });
              },
            };
          },
        };
      }

      if (table === "member_subcommittee_assignments") {
        return {
          delete() {
            return {
              eq: async () => ({ error: null }),
            };
          },
          insert(payload: Array<Record<string, unknown>>) {
            subcommitteeInsertPayload = payload;
            return Promise.resolve({ error: null });
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  } as never;

  await replaceMemberCommitteeAssignments(sb, "A000148", [
    {
      committeeName: "Subcommittee on Defense",
      committeeCode: null,
      chamber: "House",
      role: null,
      congress: null,
      rawPayload: {},
      subcommittees: [
        {
          subcommitteeCode: "HSAS03",
          subcommitteeName: "Subcommittee on Readiness",
          role: "Member",
          rawPayload: {},
        },
      ],
    },
  ]);

  assert.equal(committeeSelectColumns, "id,committee_key");
  assert.equal(committeeInsertPayload?.[0]?.committee_key, "ARMED SERVICES:House");
  assert.equal(subcommitteeInsertPayload?.[0]?.committee_assignment_id, 44);
});

test("replaceMemberCommitteeAssignments preserves null committee keys in backfill payloads", async () => {
  let committeeInsertPayload: Array<Record<string, unknown>> | null = null;
  let subcommitteeInsertPayload: Array<Record<string, unknown>> | null = null;

  const sb = {
    from(table: string) {
      if (table === "member_committee_assignments") {
        return {
          delete() {
            return {
              eq: async () => ({ error: null }),
            };
          },
          insert(payload: Array<Record<string, unknown>>) {
            committeeInsertPayload = payload;
            return {
              select: async () => ({
                data: [{ id: 55, committee_key: committeeInsertPayload?.[0]?.committee_key ?? null }],
                error: null,
              }),
            };
          },
        };
      }

      if (table === "member_subcommittee_assignments") {
        return {
          delete() {
            return {
              eq: async () => ({ error: null }),
            };
          },
          insert(payload: Array<Record<string, unknown>>) {
            subcommitteeInsertPayload = payload;
            return Promise.resolve({ error: null });
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  } as never;

  await replaceMemberCommitteeAssignments(sb, "A000148", [
    {
      committeeName: "Subcommittee on Defense",
      committeeCode: null,
      chamber: null,
      role: null,
      congress: null,
      rawPayload: {},
      subcommittees: [
        {
          subcommitteeCode: null,
          subcommitteeName: "Subcommittee on Defense",
          role: null,
          rawPayload: {},
        },
      ],
    },
  ]);

  assert.equal(committeeInsertPayload?.[0]?.committee_key, null);
  assert.equal(subcommitteeInsertPayload?.[0]?.committee_assignment_id, null);
});

test("replaceMemberCommitteeAssignments fails closed when multiple committees have null keys", async () => {
  let subcommitteeInsertPayload: Array<Record<string, unknown>> | null = null;

  const sb = {
    from(table: string) {
      if (table === "member_committee_assignments") {
        return {
          delete() {
            return {
              eq: async () => ({ error: null }),
            };
          },
          insert() {
            return {
              select: async () => ({
                data: [
                  { id: 55, committee_key: null },
                  { id: 56, committee_key: null },
                ],
                error: null,
              }),
            };
          },
        };
      }

      if (table === "member_subcommittee_assignments") {
        return {
          delete() {
            return {
              eq: async () => ({ error: null }),
            };
          },
          insert(payload: Array<Record<string, unknown>>) {
            subcommitteeInsertPayload = payload;
            return Promise.resolve({ error: null });
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  } as never;

  await replaceMemberCommitteeAssignments(sb, "A000148", [
    {
      committeeName: "Subcommittee on Defense",
      committeeCode: null,
      chamber: null,
      role: null,
      congress: null,
      rawPayload: {},
      subcommittees: [
        {
          subcommitteeCode: null,
          subcommitteeName: "Subcommittee on Defense",
          role: null,
          rawPayload: {},
        },
      ],
    },
    {
      committeeName: "Subcommittee on Health",
      committeeCode: null,
      chamber: null,
      role: null,
      congress: null,
      rawPayload: {},
      subcommittees: [
        {
          subcommitteeCode: null,
          subcommitteeName: "Subcommittee on Health",
          role: null,
          rawPayload: {},
        },
      ],
    },
  ]);

  assert.equal(subcommitteeInsertPayload?.[0]?.committee_assignment_id, null);
  assert.equal(subcommitteeInsertPayload?.[1]?.committee_assignment_id, null);
});

test("scorePolicyCommitteeCandidate blends bill history and jurisdiction support", () => {
  assert.equal(
    scorePolicyCommitteeCandidate({
      billCount: 4,
      jurisdictionWeight: 0.8,
      latestCongress: 119,
      currentCongress: 119,
    }),
    0.9
  );
});

test("scorePolicyCommitteeCandidate clamps and ignores non-finite inputs", () => {
  assert.equal(
    scorePolicyCommitteeCandidate({
      billCount: Number.POSITIVE_INFINITY,
      jurisdictionWeight: Number.NaN,
      latestCongress: 118,
      currentCongress: 119,
    }),
    0.6
  );
});

test("applyPolicyCommitteeOverride promotes within bounds", () => {
  assert.deepEqual(
    applyPolicyCommitteeOverride(
      {
        confidence: 0.7,
        is_manual_override: false,
        is_suppressed: false,
      },
      {
        override_action: "promote",
        confidence_delta: 0.4,
      }
    ),
    {
      confidence: 1,
      is_manual_override: true,
      is_suppressed: false,
    }
  );
});

test("applyPolicyCommitteeOverride pins to an explicit confidence", () => {
  assert.deepEqual(
    applyPolicyCommitteeOverride(
      {
        confidence: 0.3,
        is_manual_override: false,
        is_suppressed: false,
      },
      {
        override_action: "pin",
        confidence_delta: 0.88,
      }
    ),
    {
      confidence: 0.88,
      is_manual_override: true,
      is_suppressed: false,
    }
  );
});

test("applyPolicyCommitteeOverride fails closed for malformed pins", () => {
  assert.deepEqual(
    applyPolicyCommitteeOverride(
      {
        confidence: 0.3,
        is_manual_override: false,
        is_suppressed: false,
      },
      {
        override_action: "pin",
        confidence_delta: Number.NaN,
      }
    ),
    {
      confidence: 0,
      is_manual_override: true,
      is_suppressed: true,
    }
  );
});

test("applyPolicyCommitteeOverride suppresses without deleting the row", () => {
  const row = {
    id: "map_1",
    policy_area: "HEALTH",
    committee_id: "HSAG00",
    confidence: 0.72,
    is_manual_override: false,
    is_suppressed: false,
  };

  assert.deepEqual(
    applyPolicyCommitteeOverride(row, {
      override_action: "suppress",
      confidence_delta: null,
    }),
    {
      ...row,
      confidence: 0,
      is_manual_override: true,
      is_suppressed: true,
    }
  );
});
