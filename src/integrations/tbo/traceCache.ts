
// TBO requires the TraceId from a search response to be sent with every
// subsequent FareRule / FareQuote / SSR / Book call.
// Storing it server-side keeps it off the client bundle and Zustand store.
// TTL matches TBO's fare validity window (15 minutes).

interface TraceEntry {
  traceId: string;
  expiresAt: number; // epoch ms
}

const cache = new Map<string, TraceEntry>();

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export function storeTrace(
  resultIndex: string,
  traceId: string,
  ttlMs = DEFAULT_TTL_MS,
): void {
  cache.set(resultIndex, { traceId, expiresAt: Date.now() + ttlMs });
}

export function getTrace(resultIndex: string): string | null {
  const entry = cache.get(resultIndex);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(resultIndex);
    return null;
  }
  return entry.traceId;
}

export function deleteTrace(resultIndex: string): void {
  cache.delete(resultIndex);
}
