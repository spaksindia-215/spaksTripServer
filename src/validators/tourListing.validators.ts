import { HttpError } from "../middleware/error";
import {
  CURRENCY_CODES,
  RESOURCE_STATUS,
  TOUR_CATEGORIES,
  OPERATING_DAYS,
  type CurrencyCode,
  type OperatingDay,
} from "../models/partner/_shared/enums";
import type { ITourListing } from "../models/partner/TourListing";

// Validates the dedicated Tour form payload (structured JSON). The controller
// resolves `images` (Cloudinary URLs), so that field is excluded here.

export type TourFields = Omit<
  ITourListing,
  "partner" | "slug" | "createdAt" | "updatedAt" | "images"
>;

function fail(msg: string): never {
  throw new HttpError(400, `tour: ${msg}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function reqStr(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string" || v.trim().length === 0) fail(`${k} is required`);
  return (v as string).trim();
}

function optStr(o: Record<string, unknown>, k: string): string | undefined {
  return typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : undefined;
}

function reqNum(o: Record<string, unknown>, k: string): number {
  const v = typeof o[k] === "number" ? (o[k] as number) : Number(o[k]);
  if (!Number.isFinite(v) || v < 0) fail(`${k} must be a non-negative number`);
  return v;
}

function optNum(o: Record<string, unknown>, k: string): number | undefined {
  if (o[k] === undefined || o[k] === null || o[k] === "") return undefined;
  const v = typeof o[k] === "number" ? (o[k] as number) : Number(o[k]);
  if (!Number.isFinite(v) || v < 0) fail(`${k} must be a non-negative number`);
  return v;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function strArray(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v === "string") {
    return Array.from(new Set(v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)));
  }
  if (!Array.isArray(v)) return [];
  return Array.from(
    new Set((v as unknown[]).filter((e) => typeof e === "string").map((s) => (s as string).trim()).filter(Boolean)),
  );
}

function dateArray(v: unknown, field: string): Date[] {
  return strArray(v).map((s) => {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) fail(`${field} contains an invalid date: ${s}`);
    return d;
  });
}

export function validateTourListing(body: unknown): TourFields {
  if (!isObject(body)) fail("request body is required");
  const d = body as Record<string, unknown>;

  // Status (optional; defaults to draft).
  let status: TourFields["status"] = "draft";
  if (d.status !== undefined) {
    const s = String(d.status);
    if (!(RESOURCE_STATUS as readonly string[]).includes(s)) {
      fail(`status must be one of: ${RESOURCE_STATUS.join(", ")}`);
    }
    status = s as TourFields["status"];
  }

  const category = reqStr(d, "category");
  if (!(TOUR_CATEGORIES as readonly string[]).includes(category)) {
    fail(`category must be one of: ${TOUR_CATEGORIES.join(", ")}`);
  }

  // Pricing tiers (≥1).
  const pricingRaw = Array.isArray(d.pricing) ? (d.pricing as unknown[]) : [];
  const pricing = pricingRaw.map((r, i) => {
    if (!isObject(r)) fail(`pricing[${i}] must be an object`);
    const t = r as Record<string, unknown>;
    const currency = String(t.currency ?? "INR");
    if (!(CURRENCY_CODES as readonly string[]).includes(currency)) {
      fail(`pricing[${i}].currency must be one of: ${CURRENCY_CODES.join(", ")}`);
    }
    return {
      label: reqStr(t, "label"),
      price: reqNum(t, "price"),
      currency: currency as CurrencyCode,
      minAge: optNum(t, "minAge"),
      maxAge: optNum(t, "maxAge"),
    };
  });
  if (pricing.length === 0) fail("at least one pricing tier is required");

  // Itinerary stops (all fields optional).
  const itineraryRaw = Array.isArray(d.itinerary) ? (d.itinerary as unknown[]) : [];
  const itinerary = itineraryRaw
    .filter(isObject)
    .map((r) => {
      const it = r as Record<string, unknown>;
      return {
        time: optStr(it, "time"),
        title: optStr(it, "title"),
        description: optStr(it, "description"),
        location: optStr(it, "location"),
      };
    })
    .filter((s) => s.time || s.title || s.description || s.location);

  // Pickup points.
  const pickupRaw = Array.isArray(d.pickupPoints) ? (d.pickupPoints as unknown[]) : [];
  const pickupPoints = pickupRaw
    .filter(isObject)
    .map((r) => {
      const p = r as Record<string, unknown>;
      return { name: optStr(p, "name"), time: optStr(p, "time") };
    })
    .filter((p) => p.name || p.time);

  // Operating days.
  const operatingDays = strArray(d.operatingDays).filter((day): day is OperatingDay =>
    (OPERATING_DAYS as readonly string[]).includes(day),
  );

  // Coordinates (only when both lat & lng present).
  const latitude = optNum(d, "latitude");
  const longitude = optNum(d, "longitude");
  const coordinates =
    latitude !== undefined && longitude !== undefined
      ? { type: "Point" as const, coordinates: [longitude, latitude] as [number, number] }
      : undefined;

  return {
    status,
    title: reqStr(d, "title"),
    category: category as TourFields["category"],
    basedIn: reqStr(d, "basedIn"),
    coversCities: strArray(d.coversCities),
    coordinates,
    durationHours: optNum(d, "durationHours"),
    durationDays: optNum(d, "durationDays"),
    durationNights: optNum(d, "durationNights"),
    itinerary,
    pricing,
    minGroupSize: optNum(d, "minGroupSize") ?? 1,
    maxGroupSize: optNum(d, "maxGroupSize"),
    privateAvailable: bool(d.privateAvailable, false),
    privatePrice: optNum(d, "privatePrice"),
    inclusions: strArray(d.inclusions),
    exclusions: strArray(d.exclusions),
    pickupIncluded: bool(d.pickupIncluded, false),
    pickupPoints,
    operatingDays,
    startTimes: strArray(d.startTimes),
    advanceBookingHrs: optNum(d, "advanceBookingHrs") ?? 12,
    blackoutDates: dateArray(d.blackoutDates, "blackoutDates"),
    videoUrl: optStr(d, "videoUrl"),
    description: optStr(d, "description"),
    highlights: strArray(d.highlights),
    tags: strArray(d.tags),
    languages: strArray(d.languages),
  };
}
