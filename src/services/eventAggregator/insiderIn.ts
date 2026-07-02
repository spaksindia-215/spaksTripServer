import { env } from "../../config/env";
import type { EventCategory } from "../../models/partner/_shared/enums";
import { fetchJson, sleep, type NormalizedExternalEvent } from "./types";

/*
 * Paytm Insider (insider.in) — Option B: affiliate deep-link (instruct.md Step 2.3).
 *
 * Most relevant source for Indian events. We read the undocumented public
 * endpoint their own frontend uses (no key needed) behind INSIDER_API_ENABLED,
 * normalize to NormalizedExternalEvent, and link "Book Now" out to the insider.in
 * event page. SpaksTrip never sells these — pure discovery + deep link.
 *
 * The public payload is undocumented and may change, so this parser is fully
 * defensive: anything it can't read is skipped, never thrown.
 */

const BASE = "https://api.insider.in/home";

// Insider category slug → our category enum (instruct.md Step 2.3).
const CATEGORY_MAP: Record<string, EventCategory> = {
  music: "concert",
  comedy: "comedy_show",
  workshops: "workshop",
  workshop: "workshop",
  food: "food_festival",
  nightlife: "nightlife",
  theatre: "theatre",
  sports: "sports",
  exhibitions: "exhibition",
  exhibition: "exhibition",
  experiences: "other",
};

function mapCategory(raw?: string): EventCategory {
  return CATEGORY_MAP[(raw ?? "").toLowerCase()] ?? "other";
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function asNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Recursively collect plausible event objects from the loosely-typed payload.
// An "event" here is any object exposing a slug/url plus a title/name.
function collectEventLikeObjects(node: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (depth > 6 || out.length > 500) return;
  if (Array.isArray(node)) {
    for (const item of node) collectEventLikeObjects(item, out, depth + 1);
    return;
  }
  if (!isObject(node)) return;
  const hasTitle = "title" in node || "name" in node;
  const hasLink = "slug" in node || "url" in node || "permalink" in node;
  if (hasTitle && hasLink) out.push(node);
  for (const value of Object.values(node)) collectEventLikeObjects(value, out, depth + 1);
}

function normalize(o: Record<string, unknown>, city: string): NormalizedExternalEvent | null {
  const title = asString(o.title) ?? asString(o.name);
  const slug = asString(o.slug) ?? asString(o.permalink);
  const directUrl = asString(o.url);
  if (!title || (!slug && !directUrl)) return null;

  const sourceUrl = directUrl ?? `https://insider.in/${slug}`;
  const id = asString(o.id) ?? asString(o._id) ?? slug ?? sourceUrl;

  const venueObj = isObject(o.venue) ? (o.venue as Record<string, unknown>) : {};
  const minPrice = asNumber(o.min_price) ?? asNumber(o.minPrice) ?? asNumber(o.price);
  const maxPrice = asNumber(o.max_price) ?? asNumber(o.maxPrice);
  const startRaw = asString(o.start_date) ?? asString(o.startDate) ?? asString(o.event_date);
  const imageCandidates = [asString(o.image), asString(o.cover_image), asString(o.banner), asString(o.thumbnail)].filter(
    (x): x is string => Boolean(x),
  );

  return {
    source: "insider",
    sourceId: String(id),
    sourceUrl,
    affiliateUrl: sourceUrl, // join Insider's affiliate program later to add tracking params
    title,
    description: asString(o.description) ?? asString(o.summary),
    category: mapCategory(asString(o.category) ?? asString(o.type) ?? asString(o.vertical)),
    startDate: startRaw && !Number.isNaN(new Date(startRaw).getTime()) ? new Date(startRaw) : undefined,
    venue: {
      name: asString(venueObj.name) ?? asString(o.venue_name),
      city: asString(venueObj.city) ?? asString(o.city) ?? city,
      country: "India",
    },
    images: imageCandidates.slice(0, 5),
    priceRange: minPrice !== undefined || maxPrice !== undefined ? { min: minPrice, max: maxPrice, currency: "INR" } : undefined,
  };
}

// Fetch go-out events for a city. Returns [] when disabled or the shape is
// unrecognized — never throws.
export async function fetchInsiderEvents(city: string): Promise<NormalizedExternalEvent[]> {
  if (!env.insiderApiEnabled) return [];

  const params = new URLSearchParams({ filterBy: "go-out", city });
  // Be polite to the undocumented endpoint (instruct.md: ~1 req / 5 sec).
  await sleep(5_000);
  const data = await fetchJson<unknown>(`${BASE}?${params.toString()}`);
  if (data === null) return [];

  const candidates: Record<string, unknown>[] = [];
  collectEventLikeObjects(data, candidates);

  const seen = new Set<string>();
  const events: NormalizedExternalEvent[] = [];
  for (const c of candidates) {
    const ev = normalize(c, city);
    if (ev && !seen.has(ev.sourceId)) {
      seen.add(ev.sourceId);
      events.push(ev);
    }
  }
  return events;
}
