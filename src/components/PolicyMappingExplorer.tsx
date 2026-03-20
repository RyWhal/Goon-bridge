import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useApi } from "../hooks/useApi";
import {
  getKnownGoodPolicyMapBrowserEvidence,
  getKnownGoodPolicyMapBrowserTestcase,
  POLICY_MAP_BROWSER_TESTCASE_QUERY_PARAM,
} from "../lib/policy-map-browser-testcase";

interface PolicyCommitteeSummary {
  id: number;
  committee_key: string;
  committee_code: string | null;
  name: string;
  normalized_name: string;
  chamber: string | null;
}

interface PolicyCommitteeMapResult {
  id: number;
  policy_area: string;
  committee_id: number;
  confidence: number;
  source: string;
  evidence_count: number;
  bill_count: number;
  first_seen_congress: number | null;
  last_seen_congress: number | null;
  last_seen_at: string | null;
  is_manual_override: boolean;
  is_suppressed: boolean;
  created_at: string;
  updated_at: string;
  committee: PolicyCommitteeSummary | null;
}

interface PolicyCommitteeSearchResponse {
  policy_area: string;
  count: number;
  rows: PolicyCommitteeMapResult[];
}

interface PolicyCommitteeEvidenceItem {
  id: number;
  map_id: number;
  evidence_type: string;
  source_table: string;
  source_row_id: string;
  source_url: string | null;
  weight: number | null;
  note: string | null;
  evidence_payload: Record<string, unknown>;
  created_at: string;
}

interface PolicyCommitteeEvidenceResponse {
  map_type: string;
  map_id: number;
  count: number;
  evidence: PolicyCommitteeEvidenceItem[];
}

function normalizeQuery(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function formatConfidence(value: number) {
  return `${Math.round(value * 100)}% confidence`;
}

function formatSourceLabel(value: string) {
  return value.replace(/_/g, " ");
}

function formatCongressRange(first: number | null, last: number | null) {
  if (first == null && last == null) return null;
  if (first != null && last != null && first === last) return `Congress ${first}`;
  if (first != null && last != null) return `Congresses ${first}-${last}`;
  if (last != null) return `Through Congress ${last}`;
  return `From Congress ${first}`;
}

function formatEvidenceHeadline(item: PolicyCommitteeEvidenceItem) {
  const billId = item.evidence_payload.bill_id;
  if (typeof billId === "number") {
    return `Bill ${billId}`;
  }
  return `Evidence ${item.id}`;
}

function formatEvidenceMeta(item: PolicyCommitteeEvidenceItem) {
  const congress = item.evidence_payload.congress;
  const committeeKey = item.evidence_payload.committee_key;
  const parts = [
    typeof congress === "number" ? `Congress ${congress}` : null,
    typeof committeeKey === "string" ? committeeKey : null,
    item.source_table ? `${item.source_table}:${item.source_row_id}` : null,
  ];
  return parts.filter((value): value is string => !!value).join(" · ");
}

const POLICY_MAP_BROWSER_TESTCASE_URL_PARAM = "policyMapsCase";

async function fetchEvidence(mapId: number) {
  const response = await fetch(`/api/maps/evidence/policy-committee/${mapId}`);
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as PolicyCommitteeEvidenceResponse & { error?: string }) : null;

  if (!response.ok || payload?.error) {
    throw new Error(payload?.error ?? `HTTP ${response.status}`);
  }

  return payload as PolicyCommitteeEvidenceResponse;
}

export function PolicyMappingExplorer() {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [expandedMapId, setExpandedMapId] = useState<number | null>(null);
  const [loadingEvidenceId, setLoadingEvidenceId] = useState<number | null>(null);
  const [evidenceByMapId, setEvidenceByMapId] = useState<Record<number, PolicyCommitteeEvidenceItem[]>>({});
  const [evidenceErrorsByMapId, setEvidenceErrorsByMapId] = useState<Record<number, string | null>>({});
  const [browserTestcaseActive, setBrowserTestcaseActive] = useState(false);
  const search = useApi<PolicyCommitteeSearchResponse>();

  const setBrowserTestcaseUrl = useCallback((active: boolean) => {
    if (typeof window === "undefined") return;

    const url = new URL(window.location.href);
    if (active) {
      url.searchParams.set(POLICY_MAP_BROWSER_TESTCASE_URL_PARAM, POLICY_MAP_BROWSER_TESTCASE_QUERY_PARAM);
    } else {
      url.searchParams.delete(POLICY_MAP_BROWSER_TESTCASE_URL_PARAM);
    }

    const nextPath = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState({}, "", nextPath);
  }, []);

  const loadKnownGoodBrowserTestcase = useCallback(
    (syncUrl: boolean) => {
      const testcase = getKnownGoodPolicyMapBrowserTestcase();
      const evidence = getKnownGoodPolicyMapBrowserEvidence();
      const firstRow = testcase.rows[0] ?? null;

      setQuery("Defense");
      setSubmittedQuery("Defense");
      setValidationError(null);
      setExpandedMapId(firstRow?.id ?? null);
      setLoadingEvidenceId(null);
      setEvidenceByMapId(firstRow ? { [firstRow.id]: evidence.evidence } : {});
      setEvidenceErrorsByMapId({});
      setBrowserTestcaseActive(true);
      search.setData(testcase);

      if (syncUrl) {
        setBrowserTestcaseUrl(true);
      }
    },
    [search.setData, setBrowserTestcaseUrl]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    const url = new URL(window.location.href);
    if (url.searchParams.get(POLICY_MAP_BROWSER_TESTCASE_URL_PARAM) === POLICY_MAP_BROWSER_TESTCASE_QUERY_PARAM) {
      loadKnownGoodBrowserTestcase(false);
    }
  }, [loadKnownGoodBrowserTestcase]);

  const normalizedSubmittedQuery = normalizeQuery(submittedQuery).toUpperCase();
  const showingStaleResults = search.loading && search.data?.policy_area !== normalizedSubmittedQuery;
  const rows = showingStaleResults ? [] : search.data?.rows ?? [];

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const normalizedQuery = normalizeQuery(query);
    if (!normalizedQuery) {
      setValidationError("Enter a policy area to load committee mappings.");
      return;
    }

    setValidationError(null);
    setSubmittedQuery(normalizedQuery);
    setExpandedMapId(null);
    setBrowserTestcaseActive(false);
    setEvidenceByMapId({});
    setEvidenceErrorsByMapId({});
    setBrowserTestcaseUrl(false);
    await search.fetchData(`/api/maps/policy-committees?policyArea=${encodeURIComponent(normalizedQuery)}`, {
      force: true,
    });
  };

  const handleToggleEvidence = async (mapId: number) => {
    if (expandedMapId === mapId) {
      setExpandedMapId(null);
      return;
    }

    setExpandedMapId(mapId);
    if (evidenceByMapId[mapId]) {
      return;
    }

    setLoadingEvidenceId(mapId);
    setEvidenceErrorsByMapId((current) => ({ ...current, [mapId]: null }));

    try {
      const response = await fetchEvidence(mapId);
      setEvidenceByMapId((current) => ({ ...current, [mapId]: response.evidence ?? [] }));
    } catch (error) {
      setEvidenceErrorsByMapId((current) => ({
        ...current,
        [mapId]: error instanceof Error ? error.message : "Failed to load evidence",
      }));
    } finally {
      setLoadingEvidenceId((current) => (current === mapId ? null : current));
    }
  };

  return (
    <section className="space-y-6">
      <div className="section-shell-accent space-y-3">
        <div className="space-y-1">
          <p className="text-[11px] uppercase tracking-[0.28em] text-vibe-accent">Policy Maps</p>
          <h2 className="text-2xl font-semibold text-vibe-text">Search policy areas, then inspect the committee trail.</h2>
          <p className="max-w-3xl text-sm text-vibe-dim">
            This view is intentionally narrow: ranked committee mappings first, underlying evidence on demand.
          </p>
        </div>

        <form className="flex flex-col gap-3 sm:flex-row" onSubmit={handleSubmit}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Defense and national security"
            className="input flex-1"
            aria-label="Policy area"
          />
          <button type="submit" className="btn btn-primary sm:min-w-[160px]">
            Search policy maps
          </button>
        </form>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => loadKnownGoodBrowserTestcase(true)} className="btn btn-ghost">
            {browserTestcaseActive ? "Reload known-good testcase" : "Load known-good testcase"}
          </button>
          {browserTestcaseActive && (
            <span className="badge bg-vibe-yea/15 text-vibe-yea">Browser testcase active</span>
          )}
        </div>

        {validationError && <p className="text-sm text-vibe-nay">{validationError}</p>}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <div className="section-shell space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-vibe-dim">Results</p>
              <h3 className="text-lg font-semibold text-vibe-text">
                {(search.data?.policy_area ?? normalizedSubmittedQuery) || "No query yet"}
              </h3>
            </div>
            {search.data && !showingStaleResults && (
              <div className="badge bg-vibe-accent/15 text-vibe-accent">{search.data.count} mapped committees</div>
            )}
          </div>

          {search.loading && showingStaleResults && (
            <div className="rounded-xl border border-vibe-border/70 bg-vibe-surface/40 px-4 py-8 text-sm text-vibe-dim">
              Loading policy committee mappings...
            </div>
          )}

          {search.error && !showingStaleResults && (
            <div className="rounded-xl border border-vibe-nay/30 bg-vibe-nay/10 px-4 py-3 text-sm text-vibe-nay">
              {search.error}
            </div>
          )}

          {!submittedQuery && !search.loading && !search.error && (
            <div className="rounded-xl border border-dashed border-vibe-border/80 px-4 py-8 text-sm text-vibe-dim">
              Start with a policy area like <span className="text-vibe-text">Defense</span>,{" "}
              <span className="text-vibe-text">Agriculture</span>, or{" "}
              <span className="text-vibe-text">Taxation</span>.
            </div>
          )}

          {submittedQuery && !search.loading && !search.error && rows.length === 0 && (
            <div className="rounded-xl border border-dashed border-vibe-border/80 px-4 py-8 text-sm text-vibe-dim">
              No visible top-level committee mappings found for this policy area yet.
            </div>
          )}

          {rows.length > 0 && (
            <div className="space-y-3">
              {rows.map((row) => {
                const isExpanded = expandedMapId === row.id;
                const evidence = evidenceByMapId[row.id] ?? [];
                const evidenceError = evidenceErrorsByMapId[row.id];
                const congressRange = formatCongressRange(row.first_seen_congress, row.last_seen_congress);

                return (
                  <article
                    key={row.id}
                    className={`rounded-xl border px-4 py-4 transition-colors ${
                      isExpanded
                        ? "border-vibe-accent/40 bg-vibe-accent/[0.06]"
                        : "border-vibe-border/70 bg-vibe-surface/45"
                    }`}
                  >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="text-base font-semibold text-vibe-text">
                            {row.committee?.name ?? `Committee ${row.committee_id}`}
                          </h4>
                          {row.committee?.chamber && (
                            <span className="badge bg-vibe-border/70 text-vibe-text">{row.committee.chamber}</span>
                          )}
                          <span className="badge bg-vibe-accent/15 text-vibe-accent">
                            {formatConfidence(row.confidence)}
                          </span>
                          {row.is_manual_override && (
                            <span className="badge bg-vibe-cosmic/15 text-vibe-cosmic">Manual override</span>
                          )}
                        </div>
                        <p className="text-sm text-vibe-dim">
                          {[congressRange, `${row.bill_count} bills`, `${row.evidence_count} evidence rows`, formatSourceLabel(row.source)]
                            .filter((value): value is string => !!value)
                            .join(" · ")}
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() => void handleToggleEvidence(row.id)}
                        aria-expanded={isExpanded}
                        className="btn btn-ghost self-start"
                      >
                        {isExpanded ? "Hide evidence" : "Show evidence"}
                      </button>
                    </div>

                    {isExpanded && (
                      <div className="mt-4 space-y-3 border-t border-vibe-border/60 pt-4">
                        {loadingEvidenceId === row.id && (
                          <div className="text-sm text-vibe-dim">Loading evidence...</div>
                        )}

                        {evidenceError && (
                          <div className="rounded-lg border border-vibe-nay/30 bg-vibe-nay/10 px-3 py-2 text-sm text-vibe-nay">
                            {evidenceError}
                          </div>
                        )}

                        {loadingEvidenceId !== row.id && !evidenceError && evidence.length === 0 && (
                          <div className="text-sm text-vibe-dim">No evidence rows were returned for this mapping.</div>
                        )}

                        {evidence.length > 0 && (
                          <div className="space-y-2">
                            {evidence.map((item) => {
                              const meta = formatEvidenceMeta(item);
                              return (
                                <div
                                  key={item.id}
                                  className="rounded-lg border border-vibe-border/60 bg-vibe-bg/35 px-3 py-3"
                                >
                                  <div className="flex flex-wrap items-center gap-2">
                                    <p className="text-sm font-semibold text-vibe-text">{formatEvidenceHeadline(item)}</p>
                                    <span className="badge bg-vibe-border/70 text-vibe-dim">
                                      {formatSourceLabel(item.evidence_type)}
                                    </span>
                                    {item.weight != null && (
                                      <span className="badge bg-vibe-border/70 text-vibe-dim">weight {item.weight}</span>
                                    )}
                                  </div>
                                  <p className="mt-1 text-sm text-vibe-dim">
                                    {item.note ?? "Derived evidence row"}
                                    {meta ? ` · ${meta}` : ""}
                                  </p>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>

        <aside className="section-shell-cosmic space-y-3">
          <p className="text-[11px] uppercase tracking-[0.28em] text-vibe-cosmic">How to read this</p>
          <h3 className="text-lg font-semibold text-vibe-text">This is a traceable ranking, not a claim engine.</h3>
          <p className="text-sm text-vibe-dim">
            Each row is a derived link from historical bill referrals. Evidence stays attached so you can inspect the
            steps and decide whether the chain is interesting.
          </p>
          <div className="space-y-2 text-sm text-vibe-dim">
            <p>
              <span className="text-vibe-text">Confidence</span> reflects how comfortable the system is surfacing the
              link.
            </p>
            <p>
              <span className="text-vibe-text">Evidence</span> shows the source rows currently backing the mapping.
            </p>
            <p>
              <span className="text-vibe-text">Scope</span> is top-level committees only for this first pass.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}
