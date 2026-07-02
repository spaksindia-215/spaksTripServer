import type { EventCategory } from "../../models/partner/_shared/enums";
import type { ExternalEventSource } from "../../models/ExternalEvent";

// Common normalized shape every external source maps into before it is cached as
// an ExternalEvent. Keeps the source adapters (ticketmaster.ts, insiderIn.ts)
// independent of the persistence model.
export interface NormalizedExternalEvent {
  source: ExternalEventSource;
  sourceId: string;
  sourceUrl: string;
  affiliateUrl?: string;
  title: string;
  description?: string;
  category: EventCategory;
  startDate?: Date;
  endDate?: Date;
  venue: {
    name?: string;
    city?: string;
    state?: string;
    country?: string;
    coordinates?: { lat?: number; lng?: number };
  };
  images: string[];
  priceRange?: { min?: number; max?: number; currency?: string };
}

// Defensive JSON fetch with a hard timeout (AbortController) — third-party APIs
// are flaky and must never hang the sync worker. Returns null on any failure;
// callers degrade gracefully.
export async function fetchJson<T>(url: string, timeoutMs = 10_000): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "SpaksTrip/1.0 (+https://spakstrip.com)" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Small sleep used to rate-limit polite sequential requests.
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
