import { HttpError } from "../middleware/error";
import {
  CURRENCY_CODES,
  RESOURCE_STATUS,
  PACKAGE_TYPES,
  DEPARTURE_STATUS,
  DIFFICULTY_LEVELS,
  type CurrencyCode,
  type DepartureStatus,
} from "../models/partner/_shared/enums";
import type { ITourPackage } from "../models/partner/TourPackage";

// Validates the dedicated TourPackage form payload (structured JSON). The
// controller resolves `includes` (cross-model ownership) and `images`/
// `thumbnail` (Cloudinary URLs), so those are excluded here. The raw include ids
// are returned separately for the controller to validate + attach.

export type TourPackageFields = Omit<
  ITourPackage,
  "partner" | "slug" | "createdAt" | "updatedAt" | "includes" | "images" | "thumbnail"
>;

export interface ValidatedTourPackage {
  fields: TourPackageFields;
  includeIds: { taxi?: string; hotels: string[]; tours: string[] };
}

function fail(msg: string): never {
  throw new HttpError(400, `tour package: ${msg}`);
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

function optDate(value: string | undefined, field: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) fail(`${field} is an invalid date: ${value}`);
  return d;
}

export function validateTourPackage(body: unknown): ValidatedTourPackage {
  if (!isObject(body)) fail("request body is required");
  const d = body as Record<string, unknown>;

  // Status.
  let status: TourPackageFields["status"] = "draft";
  if (d.status !== undefined) {
    const s = String(d.status);
    if (!(RESOURCE_STATUS as readonly string[]).includes(s)) {
      fail(`status must be one of: ${RESOURCE_STATUS.join(", ")}`);
    }
    status = s as TourPackageFields["status"];
  }

  // Package type.
  const packageType = reqStr(d, "packageType");
  if (!(PACKAGE_TYPES as readonly string[]).includes(packageType)) {
    fail(`packageType must be one of: ${PACKAGE_TYPES.join(", ")}`);
  }

  // Route.
  const routeRaw = isObject(d.route) ? (d.route as Record<string, unknown>) : {};
  const destinations = strArray(routeRaw.destinations);
  if (destinations.length === 0) fail("at least one destination is required");
  const route = {
    origin: optStr(routeRaw, "origin"),
    destinations,
    durationDays: reqNum(routeRaw, "durationDays"),
    durationNights: reqNum(routeRaw, "durationNights"),
  };
  if (route.durationDays < 1) fail("route.durationDays must be at least 1");

  // Itinerary (day-wise with meals).
  const itineraryRaw = Array.isArray(d.itinerary) ? (d.itinerary as unknown[]) : [];
  const itinerary = itineraryRaw
    .filter(isObject)
    .map((r, i) => {
      const it = r as Record<string, unknown>;
      const meals = isObject(it.meals) ? (it.meals as Record<string, unknown>) : {};
      return {
        day: optNum(it, "day") ?? i + 1,
        title: optStr(it, "title"),
        description: optStr(it, "description"),
        meals: {
          breakfast: bool(meals.breakfast, false),
          lunch: bool(meals.lunch, false),
          dinner: bool(meals.dinner, false),
        },
        accommodation: optStr(it, "accommodation"),
        activities: strArray(it.activities),
      };
    });

  // Pricing + discounts.
  const pricingRaw = isObject(d.pricing) ? (d.pricing as Record<string, unknown>) : {};
  const currency = String(pricingRaw.currency ?? "INR");
  if (!(CURRENCY_CODES as readonly string[]).includes(currency)) {
    fail(`pricing.currency must be one of: ${CURRENCY_CODES.join(", ")}`);
  }
  const discountsRaw = Array.isArray(pricingRaw.discounts) ? (pricingRaw.discounts as unknown[]) : [];
  const discounts = discountsRaw
    .filter(isObject)
    .map((r) => {
      const dc = r as Record<string, unknown>;
      const percent = reqNum(dc, "percent");
      if (percent > 100) fail("discount percent cannot exceed 100");
      return {
        label: reqStr(dc, "label"),
        percent,
        validUntil: optDate(optStr(dc, "validUntil"), "discount.validUntil"),
      };
    });
  const pricing = {
    basePrice: reqNum(pricingRaw, "basePrice"),
    currency: currency as CurrencyCode,
    perPerson: bool(pricingRaw.perPerson, true),
    maxPersons: optNum(pricingRaw, "maxPersons"),
    childPrice: optNum(pricingRaw, "childPrice"),
    infantPrice: optNum(pricingRaw, "infantPrice") ?? 0,
    extraPersonCharge: optNum(pricingRaw, "extraPersonCharge"),
    singleSupplement: optNum(pricingRaw, "singleSupplement"),
    discounts,
  };

  // Departures.
  const departuresRaw = Array.isArray(d.departures) ? (d.departures as unknown[]) : [];
  const departures = departuresRaw
    .filter(isObject)
    .map((r) => {
      const dp = r as Record<string, unknown>;
      const date = optDate(optStr(dp, "date"), "departure.date");
      if (!date) fail("each departure needs a valid date");
      const depStatus = String(dp.status ?? "open");
      if (!(DEPARTURE_STATUS as readonly string[]).includes(depStatus)) {
        fail(`departure.status must be one of: ${DEPARTURE_STATUS.join(", ")}`);
      }
      return {
        date,
        seatsTotal: optNum(dp, "seatsTotal"),
        seatsBooked: optNum(dp, "seatsBooked") ?? 0,
        status: depStatus as DepartureStatus,
      };
    });

  // Difficulty (optional).
  let difficultyLevel: TourPackageFields["difficultyLevel"];
  const diffRaw = optStr(d, "difficultyLevel");
  if (diffRaw) {
    if (!(DIFFICULTY_LEVELS as readonly string[]).includes(diffRaw)) {
      fail(`difficultyLevel must be one of: ${DIFFICULTY_LEVELS.join(", ")}`);
    }
    difficultyLevel = diffRaw as TourPackageFields["difficultyLevel"];
  }

  const fields: TourPackageFields = {
    status,
    title: reqStr(d, "title"),
    packageType: packageType as TourPackageFields["packageType"],
    route,
    customInclusions: strArray(d.customInclusions),
    exclusions: strArray(d.exclusions),
    itinerary,
    pricing,
    departures,
    videoUrl: optStr(d, "videoUrl"),
    description: optStr(d, "description"),
    highlights: strArray(d.highlights),
    tags: strArray(d.tags),
    difficultyLevel,
  };

  // Include refs (validated for ownership in the controller).
  const includesRaw = isObject(d.includes) ? (d.includes as Record<string, unknown>) : {};
  const includeIds = {
    taxi: optStr(includesRaw, "taxi"),
    hotels: strArray(includesRaw.hotels),
    tours: strArray(includesRaw.tours),
  };

  return { fields, includeIds };
}
