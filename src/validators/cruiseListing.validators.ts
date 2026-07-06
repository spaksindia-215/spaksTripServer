import { HttpError } from "../middleware/error";
import {
  CURRENCY_CODES,
  RESOURCE_STATUS,
  CRUISE_TYPES,
  CABIN_TYPES,
  CRUISE_DEPARTURE_STATUS,
  type CurrencyCode,
  type CabinType,
  type CruiseDepartureStatus,
} from "../models/partner/_shared/enums";
import type { ICruiseListing } from "../models/partner/CruiseListing";

// Validates the dedicated Cruise form payload (structured JSON). The controller
// injects `vessel.images` (Cloudinary URLs) after validation, so they default
// to [] here.

export type CruiseFields = Omit<ICruiseListing, "partner" | "slug" | "createdAt" | "updatedAt">;

function fail(msg: string): never {
  throw new HttpError(400, `cruise: ${msg}`);
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

export function validateCruiseListing(body: unknown): CruiseFields {
  if (!isObject(body)) fail("request body is required");
  const d = body as Record<string, unknown>;

  // Status.
  let status: CruiseFields["status"] = "draft";
  if (d.status !== undefined) {
    const s = String(d.status);
    if (!(RESOURCE_STATUS as readonly string[]).includes(s)) {
      fail(`status must be one of: ${RESOURCE_STATUS.join(", ")}`);
    }
    status = s as CruiseFields["status"];
  }

  const cruiseType = reqStr(d, "cruiseType");
  if (!(CRUISE_TYPES as readonly string[]).includes(cruiseType)) {
    fail(`cruiseType must be one of: ${CRUISE_TYPES.join(", ")}`);
  }

  // Vessel (images injected by controller).
  const vesselRaw = isObject(d.vessel) ? (d.vessel as Record<string, unknown>) : {};
  const vessel = {
    name: optStr(vesselRaw, "name"),
    operator: optStr(vesselRaw, "operator"),
    totalDecks: optNum(vesselRaw, "totalDecks"),
    builtYear: optNum(vesselRaw, "builtYear"),
    images: [],
  };

  // Route + stops.
  const routeRaw = isObject(d.route) ? (d.route as Record<string, unknown>) : {};
  const stopsRaw = Array.isArray(routeRaw.stops) ? (routeRaw.stops as unknown[]) : [];
  const stops = stopsRaw
    .filter(isObject)
    .map((r) => {
      const s = r as Record<string, unknown>;
      return { port: optStr(s, "port"), arrivalTime: optStr(s, "arrivalTime"), departureTime: optStr(s, "departureTime") };
    })
    .filter((s) => s.port || s.arrivalTime || s.departureTime);
  const route = {
    departurePort: reqStr(routeRaw, "departurePort"),
    arrivalPort: optStr(routeRaw, "arrivalPort"),
    stops,
    durationDays: reqNum(routeRaw, "durationDays"),
    durationNights: optNum(routeRaw, "durationNights"),
  };
  if (route.durationDays < 1) fail("route.durationDays must be at least 1");

  // Cabins (≥1).
  const cabinsRaw = Array.isArray(d.cabins) ? (d.cabins as unknown[]) : [];
  const cabins = cabinsRaw.map((r, i) => {
    if (!isObject(r)) fail(`cabins[${i}] must be an object`);
    const c = r as Record<string, unknown>;
    const type = reqStr(c, "type");
    if (!(CABIN_TYPES as readonly string[]).includes(type)) {
      fail(`cabins[${i}].type must be one of: ${CABIN_TYPES.join(", ")}`);
    }
    const currency = String(c.currency ?? "INR");
    if (!(CURRENCY_CODES as readonly string[]).includes(currency)) {
      fail(`cabins[${i}].currency must be one of: ${CURRENCY_CODES.join(", ")}`);
    }
    return {
      type: type as CabinType,
      label: optStr(c, "label"),
      maxOccupancy: optNum(c, "maxOccupancy"),
      pricePerPerson: reqNum(c, "pricePerPerson"),
      currency: currency as CurrencyCode,
      totalCabins: optNum(c, "totalCabins"),
      amenities: strArray(c.amenities),
      images: strArray(c.images),
      isRefundable: bool(c.isRefundable, true),
    };
  });
  if (cabins.length === 0) fail("at least one cabin type is required");

  // Departures with cabin availability.
  const departuresRaw = Array.isArray(d.departures) ? (d.departures as unknown[]) : [];
  const departures = departuresRaw
    .filter(isObject)
    .map((r) => {
      const dp = r as Record<string, unknown>;
      const date = optDate(optStr(dp, "date"), "departure.date");
      if (!date) fail("each departure needs a valid date");
      const depStatus = String(dp.status ?? "open");
      if (!(CRUISE_DEPARTURE_STATUS as readonly string[]).includes(depStatus)) {
        fail(`departure.status must be one of: ${CRUISE_DEPARTURE_STATUS.join(", ")}`);
      }
      const availRaw = Array.isArray(dp.cabinAvailability) ? (dp.cabinAvailability as unknown[]) : [];
      const cabinAvailability = availRaw
        .filter(isObject)
        .map((a) => {
          const av = a as Record<string, unknown>;
          return { cabinType: optStr(av, "cabinType") ?? "", seatsLeft: optNum(av, "seatsLeft") };
        })
        .filter((a) => a.cabinType);
      return { date, cabinAvailability, status: depStatus as CruiseDepartureStatus };
    });

  const mealsRaw = isObject(d.mealsIncluded) ? (d.mealsIncluded as Record<string, unknown>) : {};
  const cancelRaw = isObject(d.cancellationPolicy) ? (d.cancellationPolicy as Record<string, unknown>) : {};
  const ageRaw = isObject(d.boardingAge) ? (d.boardingAge as Record<string, unknown>) : {};

  return {
    status,
    cruiseName: reqStr(d, "cruiseName"),
    cruiseType: cruiseType as CruiseFields["cruiseType"],
    vessel,
    route,
    cabins,
    shipAmenities: strArray(d.shipAmenities),
    diningOptions: strArray(d.diningOptions),
    mealsIncluded: {
      breakfast: bool(mealsRaw.breakfast, false),
      lunch: bool(mealsRaw.lunch, false),
      dinner: bool(mealsRaw.dinner, false),
    },
    departures,
    cancellationPolicy: {
      freeCancelDays: optNum(cancelRaw, "freeCancelDays"),
      chargePercent: optNum(cancelRaw, "chargePercent"),
    },
    boardingAge: {
      minAge: optNum(ageRaw, "minAge"),
      maxAge: optNum(ageRaw, "maxAge"),
    },
    description: optStr(d, "description"),
    highlights: strArray(d.highlights),
    tags: strArray(d.tags),
  };
}
