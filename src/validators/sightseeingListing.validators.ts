import { HttpError } from "../middleware/error";
import {
  CURRENCY_CODES,
  RESOURCE_STATUS,
  OPERATING_DAYS,
  SIGHTSEEING_CATEGORIES,
  SIGHTSEEING_DIFFICULTY,
  SIGHTSEEING_PRICING_MODELS,
  SIGHTSEEING_DURATION_UNITS,
  SERVICE_CANCELLATION_POLICIES,
  type CurrencyCode,
  type OperatingDay,
} from "../models/partner/_shared/enums";
import type { ISightseeingListing } from "../models/partner/SightseeingListing";

// Validates the SightSeeing form payload (structured JSON). The controller resolves
// `images` (Cloudinary URLs), so that field is excluded here. Follows the hand-written
// helper style used by tourListing.validators.ts.

export type SightseeingFields = Omit<
  ISightseeingListing,
  "partner" | "slug" | "createdAt" | "updatedAt" | "images"
>;

function fail(msg: string): never {
  throw new HttpError(400, `sightseeing: ${msg}`);
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

function optNum(o: Record<string, unknown>, k: string): number | undefined {
  if (o[k] === undefined || o[k] === null || o[k] === "") return undefined;
  const v = typeof o[k] === "number" ? (o[k] as number) : Number(o[k]);
  if (!Number.isFinite(v) || v < 0) fail(`${k} must be a non-negative number`);
  return v;
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

function inEnum<T extends string>(values: readonly T[], raw: unknown, label: string, fallback?: T): T {
  if ((raw === undefined || raw === null || raw === "") && fallback !== undefined) return fallback;
  const s = String(raw);
  if (!(values as readonly string[]).includes(s)) fail(`${label} must be one of: ${values.join(", ")}`);
  return s as T;
}

// Builds a GeoPoint when both lat & lng are present on the given object under the
// supplied keys.
function coords(o: Record<string, unknown>, latKey: string, lngKey: string): GeoPointMaybe {
  const latitude = optNum(o, latKey);
  const longitude = optNum(o, lngKey);
  if (latitude === undefined || longitude === undefined) return undefined;
  return { type: "Point" as const, coordinates: [longitude, latitude] as [number, number] };
}
type GeoPointMaybe = { type: "Point"; coordinates: [number, number] } | undefined;

export function validateSightseeingListing(body: unknown): SightseeingFields {
  if (!isObject(body)) fail("request body is required");
  const d = body as Record<string, unknown>;

  const status = inEnum(RESOURCE_STATUS, d.status, "status", "draft");
  const category = inEnum(SIGHTSEEING_CATEGORIES, d.category, "category");

  const locationRaw = isObject(d.location) ? d.location : {};
  const meetingRaw = isObject(d.meetingPoint) ? d.meetingPoint : {};
  const pricingRaw = isObject(d.pricing) ? d.pricing : {};
  const durationRaw = isObject(d.duration) ? d.duration : {};
  const ageRaw = isObject(d.ageRestriction) ? d.ageRestriction : {};
  const groupRaw = isObject(d.groupSize) ? d.groupSize : {};

  // Seasonal pricing overrides.
  const seasonalRaw = Array.isArray(d.seasonalPricing) ? (d.seasonalPricing as unknown[]) : [];
  const seasonalPricing = seasonalRaw.filter(isObject).map((r) => {
    const s = r as Record<string, unknown>;
    const start = optStr(s, "startDate");
    const end = optStr(s, "endDate");
    return {
      startDate: start ? new Date(start) : undefined,
      endDate: end ? new Date(end) : undefined,
      adult: optNum(s, "adult"),
      child: optNum(s, "child"),
      infant: optNum(s, "infant"),
      groupPrice: optNum(s, "groupPrice"),
    };
  });

  const availableDays = strArray(d.availableDays).filter((day): day is OperatingDay =>
    (OPERATING_DAYS as readonly string[]).includes(day),
  );

  return {
    status,
    title: reqStr(d, "title"),
    category,
    location: {
      address: optStr(locationRaw, "address"),
      island: optStr(locationRaw, "island"),
      coordinates: coords(locationRaw, "latitude", "longitude"),
    },
    meetingPoint: {
      instructions: optStr(meetingRaw, "instructions"),
      coordinates: coords(meetingRaw, "latitude", "longitude"),
    },
    description: optStr(d, "description"),
    highlights: strArray(d.highlights),
    duration: {
      value: optNum(durationRaw, "value"),
      unit: inEnum(SIGHTSEEING_DURATION_UNITS, durationRaw.unit, "duration.unit", "hours"),
    },
    difficulty: d.difficulty ? inEnum(SIGHTSEEING_DIFFICULTY, d.difficulty, "difficulty") : undefined,
    ageRestriction: { min: optNum(ageRaw, "min"), max: optNum(ageRaw, "max") },
    groupSize: { min: optNum(groupRaw, "min") ?? 1, max: optNum(groupRaw, "max") },
    inclusions: strArray(d.inclusions),
    exclusions: strArray(d.exclusions),
    whatToBring: strArray(d.whatToBring),
    pricingModel: inEnum(SIGHTSEEING_PRICING_MODELS, d.pricingModel, "pricingModel", "per_person"),
    currency: inEnum(CURRENCY_CODES, d.currency, "currency", "INR") as CurrencyCode,
    pricing: {
      adult: optNum(pricingRaw, "adult"),
      child: optNum(pricingRaw, "child"),
      infant: optNum(pricingRaw, "infant"),
      groupPrice: optNum(pricingRaw, "groupPrice"),
    },
    seasonalPricing,
    availableDays,
    timeSlots: strArray(d.timeSlots),
    blackoutDates: dateArray(d.blackoutDates, "blackoutDates"),
    cancellationPolicy: inEnum(
      SERVICE_CANCELLATION_POLICIES,
      d.cancellationPolicy,
      "cancellationPolicy",
      "free_24h",
    ),
    bookingCutoffHours: optNum(d, "bookingCutoffHours") ?? 6,
    languages: strArray(d.languages),
    accessibility: strArray(d.accessibility),
    termsAndConditions: optStr(d, "termsAndConditions"),
    videoUrl: optStr(d, "videoUrl"),
    tags: strArray(d.tags),
  };
}
