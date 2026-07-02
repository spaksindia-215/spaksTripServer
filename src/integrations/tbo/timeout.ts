// Timeout utilities for TBO API calls
// TBO Booking cutoff: 120 seconds (per TBO recommendation)

export interface TimeoutOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export class TimeoutError extends Error {
  constructor(public timeoutMs: number) {
    super(`Request timeout after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Wraps a fetch call with a timeout.
 * TBO recommends 120 second cutoff for booking requests.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit & TimeoutOptions,
): Promise<Response> {
  const { timeoutMs, signal, ...fetchOptions } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const mergedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    const response = await fetch(url, {
      ...fetchOptions,
      signal: mergedSignal,
    });

    return response;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Returns true if error is a timeout error.
 */
export function isTimeoutError(err: unknown): boolean {
  return err instanceof TimeoutError || (err instanceof Error && err.name === "AbortError");
}
