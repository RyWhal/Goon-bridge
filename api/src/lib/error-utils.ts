/**
 * Shared utility for extracting error details from upstream API responses.
 */

export async function readErrorDetail(resp: Response): Promise<string | null> {
  const raw = await resp.text().catch(() => "");
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const reason =
      parsed.error ?? parsed.message ?? parsed.detail ?? parsed.status;
    if (reason != null) return String(reason).slice(0, 300);
    return JSON.stringify(parsed).slice(0, 300);
  } catch {
    return raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || null;
  }
}
