
// Set TBO_DEBUG=true in .env.local to enable verbose request/response logging.
// Logs go to the Next.js server console (terminal where `npm run dev` runs).
const DEBUG = process.env.TBO_DEBUG === "true" || process.env.NODE_ENV !== "production";

function ts(): string {
  return new Date().toISOString();
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function logRequest(operation: string, url: string, body: unknown): void {
  if (!DEBUG) return;
  console.log(
    `\n[TBO ${ts()}] → ${operation}\n  URL: ${url}\n  BODY: ${safeJson(body)}`,
  );
}

export function logResponse(operation: string, status: number, body: unknown): void {
  if (!DEBUG) return;
  const preview = safeJson(body);
  const truncated = preview.length > 4000 ? preview.slice(0, 4000) + "\n... [truncated]" : preview;
  console.log(
    `\n[TBO ${ts()}] ← ${operation} [HTTP ${status}]\n  RESPONSE: ${truncated}`,
  );
}

export function logError(operation: string, err: unknown, extra?: unknown): void {
  const stack = err instanceof Error ? err.stack : String(err);
  console.error(
    `\n[TBO ${ts()}] ✗ ${operation} FAILED\n  ERROR: ${err instanceof Error ? err.message : String(err)}\n  STACK: ${stack}${extra ? `\n  EXTRA: ${safeJson(extra)}` : ""}`,
  );
}
