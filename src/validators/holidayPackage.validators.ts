import { HttpError } from "../middleware/error";
import {
  CURRENCY_CODES,
  RESOURCE_STATUS,
  PACKAGE_TYPES,
  DEPARTURE_STATUS,
  HOLIDAY_ROOM_TYPES,
  HOLIDAY_MEAL_PLANS,
  INDIAN_STATES,
  type CurrencyCode,
  type DepartureStatus,
} from "../models/partner/_shared/enums";
import type { IHolidayPackage } from "../models/partner/HolidayPackage";

// Validates the dedicated HolidayPackage form payload (structured JSON). The
// controller resolves `includes` (cross-model ownership) and `images`/
// `thumbnail` (Cloudinary URLs), so those are excluded here. Mirrors
// tourPackage.validators.ts — the room-tier block is the only real difference.

export type HolidayPackageFields = Omit<
  IHolidayPackage,
  "partner" | "slug" | "createdAt" | "updatedAt" | "includes" | "images" | "thumbnail"
>;

export interface ValidatedHolidayPackage {
  fields: HolidayPackageFields;
  includeIds: { taxi?: string; hotels: string[]; tours: string[] };
}

function fail(msg: string): never {
  throw new HttpError(400, `holiday package: ${msg}`);
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

// Unlike optNum, coordinates may legitimately be negative (southern latitudes,
// western longitudes) — international-scope packages can have either.
function optSignedNum(o: Record<string, unknown>, k: string): number | undefined {
  if (o[k] === undefined || o[k] === null || o[k] === "") return undefined;
  const v = typeof o[k] === "number" ? (o[k] as number) : Number(o[k]);
  if (!Number.isFinite(v)) fail(`${k} must be a valid number`);
  return v;
}

function optDate(value: string | undefined, field: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) fail(`${field} is an invalid date: ${value}`);
  return d;
}

function optState(o: Record<string, unknown>, k: string): HolidayPackageFields["state"] {
  const v = optStr(o, k);
  if (v === undefined) return undefined;
  if (!(INDIAN_STATES as readonly string[]).includes(v)) fail(`${k} must be one of the listed Indian states/UTs`);
  return v as HolidayPackageFields["state"];
}

// Parses an optional {lat, lng, address?} pin (route origin/destination) — same
// shape as an itinerary day's location.
function optLocation(raw: unknown): { lat: number; lng: number; address?: string } | undefined {
  if (!isObject(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const lat = optSignedNum(o, "lat");
  const lng = optSignedNum(o, "lng");
  return lat !== undefined && lng !== undefined ? { lat, lng, address: optStr(o, "address") } : undefined;
}

export function validateHolidayPackage(body: unknown): ValidatedHolidayPackage {
  if (!isObject(body)) fail("request body is required");
  const d = body as Record<string, unknown>;

  // Status.
  let status: HolidayPackageFields["status"] = "draft";
  if (d.status !== undefined) {
    const s = String(d.status);
    if (!(RESOURCE_STATUS as readonly string[]).includes(s)) {
      fail(`status must be one of: ${RESOURCE_STATUS.join(", ")}`);
    }
    status = s as HolidayPackageFields["status"];
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
    originLocation: optLocation(routeRaw.originLocation),
    destinations,
    destinationLocation: optLocation(routeRaw.destinationLocation),
    durationDays: reqNum(routeRaw, "durationDays"),
    durationNights: reqNum(routeRaw, "durationNights"),
  };
  if (route.durationDays < 1) fail("route.durationDays must be at least 1");

  // Itinerary (day-wise with meals + an optional pin-dropped location).
  const itineraryRaw = Array.isArray(d.itinerary) ? (d.itinerary as unknown[]) : [];
  const itinerary = itineraryRaw
    .filter(isObject)
    .map((r, i) => {
      const it = r as Record<string, unknown>;
      const meals = isObject(it.meals) ? (it.meals as Record<string, unknown>) : {};
      const locRaw = isObject(it.location) ? (it.location as Record<string, unknown>) : undefined;
      const lat = locRaw ? optSignedNum(locRaw, "lat") : undefined;
      const lng = locRaw ? optSignedNum(locRaw, "lng") : undefined;
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
        location: lat !== undefined && lng !== undefined ? { lat, lng, address: optStr(locRaw!, "address") } : undefined,
      };
    });

  // Room tiers (≥1) — the room-category × meal-plan price rows.
  const currency = String(d.currency ?? "INR");
  if (!(CURRENCY_CODES as readonly string[]).includes(currency)) {
    fail(`currency must be one of: ${CURRENCY_CODES.join(", ")}`);
  }
  const roomTiersRaw = Array.isArray(d.roomTiers) ? (d.roomTiers as unknown[]) : [];
  const roomTiers = roomTiersRaw
    .filter(isObject)
    .map((r) => {
      const rt = r as Record<string, unknown>;
      const roomType = reqStr(rt, "roomType");
      if (!(HOLIDAY_ROOM_TYPES as readonly string[]).includes(roomType)) {
        fail(`roomTier.roomType must be one of: ${HOLIDAY_ROOM_TYPES.join(", ")}`);
      }
      const mealPlan = String(rt.mealPlan ?? "breakfast");
      if (!(HOLIDAY_MEAL_PLANS as readonly string[]).includes(mealPlan)) {
        fail(`roomTier.mealPlan must be one of: ${HOLIDAY_MEAL_PLANS.join(", ")}`);
      }
      return {
        roomType: roomType as HolidayPackageFields["roomTiers"][number]["roomType"],
        mealPlan: mealPlan as HolidayPackageFields["roomTiers"][number]["mealPlan"],
        price: reqNum(rt, "price"),
        maxOccupancy: optNum(rt, "maxOccupancy") ?? 2,
        childPrice: optNum(rt, "childPrice"),
        extraBedPrice: optNum(rt, "extraBedPrice"),
      };
    });
  if (roomTiers.length === 0) fail("at least one room tier is required");

  // Discounts.
  const discountsRaw = Array.isArray(d.discounts) ? (d.discounts as unknown[]) : [];
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

  const fields: HolidayPackageFields = {
    status,
    title: reqStr(d, "title"),
    packageType: packageType as HolidayPackageFields["packageType"],
    state: optState(d, "state"),
    route,
    customInclusions: strArray(d.customInclusions),
    exclusions: strArray(d.exclusions),
    itinerary,
    roomTiers,
    currency: currency as CurrencyCode,
    singleSupplement: optNum(d, "singleSupplement"),
    discounts,
    departures,
    videoUrl: optStr(d, "videoUrl"),
    description: optStr(d, "description"),
    highlights: strArray(d.highlights),
    tags: strArray(d.tags),
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
