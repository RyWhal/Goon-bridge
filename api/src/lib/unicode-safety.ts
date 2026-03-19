export function sanitizePostgresText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return value ?? null;
  return value
    .replace(/\u0000/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, " ")
    .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, "$1 ")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
}

export function sanitizeJsonStrings<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizePostgresText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonStrings(entry)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeJsonStrings(entry)])
    ) as T;
  }
  return value;
}
