export class SenateEfdUnavailableError extends Error {
  status: number;
  retryable: boolean;

  constructor(message: string, status = 503, retryable = true) {
    super(message);
    this.name = "SenateEfdUnavailableError";
    this.status = status;
    this.retryable = retryable;
  }
}

export function isSenateMaintenanceResponse(status: number, body: string): boolean {
  return status === 503 && /site under maintenance/i.test(body);
}

export function summarizeUpstreamHtml(body: string, max = 300): string {
  return body
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function shouldRetrySenateEfdRequest(
  status: number,
  body: string,
  attempt: number,
  maxAttempts: number
): boolean {
  if (attempt >= maxAttempts) return false;
  if (isSenateMaintenanceResponse(status, body)) return true;
  return status === 502 || status === 503 || status === 504;
}
