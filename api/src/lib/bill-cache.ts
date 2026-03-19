export type BillCacheRow = Record<string, unknown> & {
  congress: number;
  bill_type: string;
  bill_number: number;
  updated_at?: string;
};

export function prepareBillCacheRowsForUpsert(
  rows: Array<Record<string, unknown>>,
  updatedAt = new Date().toISOString()
): BillCacheRow[] {
  return rows.map((row) => ({
    ...row,
    updated_at: updatedAt,
  })) as BillCacheRow[];
}

function parseBoundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeBillType(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned || null;
}

export function resolveBillWarmRequest(
  congress: string | undefined,
  billType: string | undefined,
  query?: { pageSize?: string; maxPages?: string; sort?: string }
) {
  const sort = query?.sort?.trim() || "updateDate+desc";
  return {
    congress: congress?.trim() || "119",
    sort,
    pageSize: parseBoundedInt(query?.pageSize, 100, 1, 250),
    maxPages: parseBoundedInt(query?.maxPages, 5, 1, 50),
    billType: normalizeBillType(billType),
  };
}
