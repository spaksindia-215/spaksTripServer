import { env } from "../../config/env";
import type { EventCategory } from "../../models/partner/_shared/enums";
import { fetchJson, sleep, type NormalizedExternalEvent } from "./types";

/*
 * Ticketmaster Discovery API v2
 * Docs: https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/
 * Free tier: 5,000 calls/day, 5 req/sec. Key from developer.ticketmaster.com →
 * TICKETMASTER_API_KEY (+ TICKETMASTER_ENABLED=true).
 *
 * India coverage is limited, so this is mainly useful for users planning trips —
 * show events at their destination. The event URL is used as the affiliate link.
 */

const BASE = "https://app.ticketmaster.com/discovery/v2/events.json";

// Ticketmaster "segment" (top-level classification) → our category enum.
const SEGMENT_MAP: Record<string, EventCategory> = {
  music: "concert",
  sports: "sports",
  "arts & theatre": "theatre",
  "arts and theatre": "theatre",
  film: "other",
  miscellaneous: "other",
};

function mapCategory(name?: string): EventCategory {
  return SEGMENT_MAP[(name ?? "").toLowerCase()] ?? "other";
}

interface TmImage {
  url: string;
  width?: number;
}
interface TmEvent {
  id: string;
  name: string;
  url: string;
  info?: string;
  images?: TmImage[];
  dates?: { start?: { dateTime?: string; localDate?: string } };
  classifications?: Array<{ segment?: { name?: string } }>;
  priceRanges?: Array<{ min?: number; max?: number; currency?: string }>;
  _embedded?: {
    venues?: Array<{
      name?: string;
      city?: { name?: string };
      state?: { name?: string; stateCode?: string };
      country?: { name?: string; countryCode?: string };
      location?: { latitude?: string; longitude?: string };
    }>;
  };
}
interface TmResponse {
  _embedded?: { events?: TmEvent[] };
  page?: { totalPages?: number };
}

function normalize(e: TmEvent): NormalizedExternalEvent {
  const venue = e._embedded?.venues?.[0];
  const lat = venue?.location?.latitude ? Number(venue.location.latitude) : undefined;
  const lng = venue?.location?.longitude ? Number(venue.location.longitude) : undefined;
  const start = e.dates?.start?.dateTime ?? e.dates?.start?.localDate;
  // Largest image first for a crisp card.
  const images = (e.images ?? [])
    .slice()
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
    .map((i) => i.url)
    .filter(Boolean)
    .slice(0, 5);
  const pr = e.priceRanges?.[0];

  return {
    source: "ticketmaster",
    sourceId: e.id,
    sourceUrl: e.url,
    affiliateUrl: e.url, // Ticketmaster URL doubles as the deep link
    title: e.name,
    description: e.info,
    category: mapCategory(e.classifications?.[0]?.segment?.name),
    startDate: start ? new Date(start) : undefined,
    venue: {
      name: venue?.name,
      city: venue?.city?.name,
      state: venue?.state?.name ?? venue?.state?.stateCode,
      country: venue?.country?.name ?? venue?.country?.countryCode,
      coordinates: lat !== undefined && lng !== undefined ? { lat, lng } : undefined,
    },
    images,
    priceRange: pr ? { min: pr.min, max: pr.max, currency: pr.currency ?? "INR" } : undefined,
  };
}

// Fetch upcoming events for a city. Returns [] when disabled/unconfigured/failed.
export async function fetchTicketmasterEvents(city: string): Promise<NormalizedExternalEvent[]> {
  if (!env.ticketmasterEnabled || !env.ticketmasterApiKey) return [];

  const params = new URLSearchParams({
    apikey: env.ticketmasterApiKey,
    city,
    countryCode: "IN",
    size: "50",
    sort: "date,asc",
  });

  // Respect the 5 req/sec limit — a small spacer before the call is plenty here.
  await sleep(250);
  const data = await fetchJson<TmResponse>(`${BASE}?${params.toString()}`);
  const events = data?._embedded?.events ?? [];
  return events.map(normalize).filter((e) => e.sourceId && e.title);
}
