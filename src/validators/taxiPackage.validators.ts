import { HttpError } from "../middleware/error";
import { CURRENCY_CODES, RESOURCE_STATUS } from "../models/partner/_shared/enums";
import type { ITaxiPackage } from "../models/partner/TaxiPackage";

// Validates the dedicated TaxiPackage form payload (structured JSON). The
// controller resolves `vehicle`/`vehicleSnapshot` (needs a DB lookup) and
// `images`/`thumbnail` (Cloudinary URLs), so those are excluded here.

export type TaxiPackageFields = Omit<
  ITaxiPackage,
  "partner" | "slug" | "createdAt" | "updatedAt" | "vehicle" | "vehicleSnapshot" | "images" | "thumbnail"
>;

export interface ValidatedTaxiPackage {
  fields: TaxiPackageFields;
  vehicleId?: string;
}

function fail(msg: string): never {
  throw new HttpError(400, `taxi package: ${msg}`);
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
  const raw = strArray(v);
  return raw.map((s) => {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) fail(`${field} contains an invalid date: ${s}`);
    return d;
  });
}

export function validateTaxiPackage(body: unknown): ValidatedTaxiPackage {
  if (!isObject(body)) fail("request body is required");
  const d = body as Record<string, unknown>;

  // Status (optional; defaults to draft at the model layer).
  let status: TaxiPackageFields["status"] = "draft";
  if (d.status !== undefined) {
    const s = String(d.status);
    if (!(RESOURCE_STATUS as readonly string[]).includes(s)) {
      fail(`status must be one of: ${RESOURCE_STATUS.join(", ")}`);
    }
    status = s as TaxiPackageFields["status"];
  }

  // Route.
  const routeRaw = isObject(d.route) ? (d.route as Record<string, unknown>) : {};
  const destinations = strArray(routeRaw.destinations);
  if (destinations.length === 0) fail("at least one destination is required");
  const route = {
    origin: reqStr(routeRaw, "origin"),
    destinations,
    totalKm: optNum(routeRaw, "totalKm"),
    durationDays: reqNum(routeRaw, "durationDays"),
    durationNights: reqNum(routeRaw, "durationNights"),
  };
  if (route.durationDays < 1) fail("route.durationDays must be at least 1");

  // Itinerary.
  const itineraryRaw = Array.isArray(d.itinerary) ? (d.itinerary as unknown[]) : [];
  const itinerary = itineraryRaw.map((r, i) => {
    if (!isObject(r)) fail(`itinerary[${i}] must be an object`);
    const it = r as Record<string, unknown>;
    return {
      day: optNum(it, "day") ?? i + 1,
      title: optStr(it, "title"),
      description: optStr(it, "description"),
      activities: strArray(it.activities),
      distance: optNum(it, "distance"),
      overnight: optStr(it, "overnight"),
    };
  });

  // Pricing.
  const pricingRaw = isObject(d.pricing) ? (d.pricing as Record<string, unknown>) : {};
  const currency = String(pricingRaw.currency ?? "INR");
  if (!(CURRENCY_CODES as readonly string[]).includes(currency)) {
    fail(`pricing.currency must be one of: ${CURRENCY_CODES.join(", ")}`);
  }
  const pricing = {
    basePrice: reqNum(pricingRaw, "basePrice"),
    currency: currency as TaxiPackageFields["pricing"]["currency"],
    maxPersons: optNum(pricingRaw, "maxPersons"),
    extraPersonCharge: optNum(pricingRaw, "extraPersonCharge"),
    tollsIncluded: bool(pricingRaw.tollsIncluded, false),
    driverAllowance: bool(pricingRaw.driverAllowance, true),
    fuelIncluded: bool(pricingRaw.fuelIncluded, true),
  };

  const fields: TaxiPackageFields = {
    status,
    title: reqStr(d, "title"),
    route,
    itinerary,
    pricing,
    inclusions: strArray(d.inclusions),
    exclusions: strArray(d.exclusions),
    startDates: dateArray(d.startDates, "startDates"),
    blackoutDates: dateArray(d.blackoutDates, "blackoutDates"),
    advanceBookingDays: optNum(d, "advanceBookingDays") ?? 3,
    description: optStr(d, "description"),
    highlights: strArray(d.highlights),
    tags: strArray(d.tags),
  };

  return { fields, vehicleId: optStr(d, "vehicle") };
}
