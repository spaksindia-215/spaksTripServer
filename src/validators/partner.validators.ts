import { HttpError } from "../middleware/error";
import {
  RESOURCE_TYPES,
  type ResourceType,
  type AnyResourceDetails,
  TAXI_VEHICLE_TYPES,
  TAXI_FUEL_TYPES,
  TAXI_TRANSMISSION_TYPES,
  HOTEL_PROPERTY_TYPES,
  HOTEL_ROOM_TYPES,
  HOTEL_BED_TYPES,
  type HotelRoomDetails,
} from "../models/partnerInventory";

export interface ResourceCreateInput {
  type: ResourceType;
  title: string;
  description: string;
  price: number;
  metadata: AnyResourceDetails;
}

export type ResourceUpdateInput = Partial<ResourceCreateInput>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidType(v: unknown): v is ResourceType {
  return typeof v === "string" && (RESOURCE_TYPES as readonly string[]).includes(v);
}

// ── Field helpers (throw HttpError(400) with a `<type> details: ...` prefix) ─────
function fail(type: ResourceType, msg: string): never {
  throw new HttpError(400, `${type} details: ${msg}`);
}

function str(o: Record<string, unknown>, k: string, type: ResourceType): string {
  const v = o[k];
  if (typeof v !== "string" || v.trim().length === 0) fail(type, `${k} is required`);
  return (v as string).trim();
}

function optStr(o: Record<string, unknown>, k: string): string | undefined {
  return typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : undefined;
}

function num(o: Record<string, unknown>, k: string, type: ResourceType): number {
  const v = typeof o[k] === "number" ? (o[k] as number) : Number(o[k]);
  if (!Number.isFinite(v) || v < 0) fail(type, `${k} must be a non-negative number`);
  return v;
}

function optNum(o: Record<string, unknown>, k: string, type: ResourceType): number | undefined {
  if (o[k] === undefined || o[k] === null || o[k] === "") return undefined;
  const v = typeof o[k] === "number" ? (o[k] as number) : Number(o[k]);
  if (!Number.isFinite(v) || v < 0) fail(type, `${k} must be a non-negative number`);
  return v;
}

function bool(o: Record<string, unknown>, k: string, type: ResourceType): boolean {
  if (typeof o[k] !== "boolean") fail(type, `${k} must be a boolean`);
  return o[k] as boolean;
}

function strArray(o: Record<string, unknown>, k: string, type: ResourceType): string[] {
  const v = o[k];
  if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) {
    fail(type, `${k} must be an array of strings`);
  }
  return (v as string[]).map((s) => s.trim()).filter(Boolean);
}

function optStrArray(o: Record<string, unknown>, k: string, type: ResourceType): string[] | undefined {
  if (o[k] === undefined) return undefined;
  return strArray(o, k, type);
}

function enumVal<T extends string>(
  o: Record<string, unknown>,
  k: string,
  allowed: readonly T[],
  type: ResourceType,
): T {
  const v = o[k];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    fail(type, `${k} must be one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

// ── Per-type detail validators ───────────────────────────────────────────────────
function validateDetails(type: ResourceType, raw: unknown): AnyResourceDetails {
  if (!isObject(raw)) fail(type, "details object is required");
  const d = raw as Record<string, unknown>;

  switch (type) {
    case "hotel": {
      const roomsRaw = d.rooms;
      if (!Array.isArray(roomsRaw) || roomsRaw.length === 0) {
        fail(type, "at least one room is required");
      }
      const rooms: HotelRoomDetails[] = (roomsRaw as unknown[]).map((r) => {
        if (!isObject(r)) fail(type, "each room must be an object");
        const ro = r as Record<string, unknown>;
        return {
          name: str(ro, "name", type),
          type: enumVal(ro, "type", HOTEL_ROOM_TYPES, type),
          bedType: enumVal(ro, "bedType", HOTEL_BED_TYPES, type),
          maxOccupancy: num(ro, "maxOccupancy", type),
          basePrice: num(ro, "basePrice", type),
          refundable: bool(ro, "refundable", type),
          breakfast: bool(ro, "breakfast", type),
        };
      });
      const star = num(d, "starRating", type);
      if (![1, 2, 3, 4, 5].includes(star)) fail(type, "starRating must be 1-5");
      return {
        starRating: star as 1 | 2 | 3 | 4 | 5,
        propertyType: enumVal(d, "propertyType", HOTEL_PROPERTY_TYPES, type),
        city: str(d, "city", type),
        country: str(d, "country", type),
        address: str(d, "address", type),
        latitude: optNum(d, "latitude", type),
        longitude: optNum(d, "longitude", type),
        checkInTime: optStr(d, "checkInTime"),
        checkOutTime: optStr(d, "checkOutTime"),
        amenities: strArray(d, "amenities", type),
        rooms,
      };
    }
    case "taxi":
      return {
        vehicleType: enumVal(d, "vehicleType", TAXI_VEHICLE_TYPES, type),
        brand: str(d, "brand", type),
        model: str(d, "model", type),
        registrationNumber: str(d, "registrationNumber", type),
        seatingCapacity: num(d, "seatingCapacity", type),
        fuelType: enumVal(d, "fuelType", TAXI_FUEL_TYPES, type),
        transmission: enumVal(d, "transmission", TAXI_TRANSMISSION_TYPES, type),
        acAvailable: bool(d, "acAvailable", type),
        luggageCapacity: optNum(d, "luggageCapacity", type),
        yearOfManufacture: optNum(d, "yearOfManufacture", type),
        operatingCity: str(d, "operatingCity", type),
        serviceAreas: strArray(d, "serviceAreas", type),
        availableRoutes: optStrArray(d, "availableRoutes", type),
        minimumFare: num(d, "minimumFare", type),
        pricePerKm: num(d, "pricePerKm", type),
        driverIncluded: bool(d, "driverIncluded", type),
        selfDriveAvailable: bool(d, "selfDriveAvailable", type),
        amenities: strArray(d, "amenities", type),
      };
    case "taxi_package":
      return {
        vehicleType: enumVal(d, "vehicleType", TAXI_VEHICLE_TYPES, type),
        seatingCapacity: num(d, "seatingCapacity", type),
        operatingCity: str(d, "operatingCity", type),
        durationDays: num(d, "durationDays", type),
        durationNights: num(d, "durationNights", type),
        itinerary: strArray(d, "itinerary", type),
        inclusions: strArray(d, "inclusions", type),
        exclusions: optStrArray(d, "exclusions", type),
        pricePerPerson: optNum(d, "pricePerPerson", type),
      };
    case "cruise":
      return {
        cruiseLine: str(d, "cruiseLine", type),
        ship: str(d, "ship", type),
        departurePort: str(d, "departurePort", type),
        route: str(d, "route", type),
        durationNights: num(d, "durationNights", type),
        cabinTypes: strArray(d, "cabinTypes", type),
        amenities: strArray(d, "amenities", type),
      };
    case "tour":
      return {
        destination: str(d, "destination", type),
        durationDays: optNum(d, "durationDays", type),
        durationHours: optNum(d, "durationHours", type),
        languages: strArray(d, "languages", type),
        maxGroupSize: optNum(d, "maxGroupSize", type),
        inclusions: strArray(d, "inclusions", type),
        exclusions: optStrArray(d, "exclusions", type),
      };
    case "tour_package":
      return {
        destinations: strArray(d, "destinations", type),
        durationDays: num(d, "durationDays", type),
        durationNights: num(d, "durationNights", type),
        itinerary: strArray(d, "itinerary", type),
        inclusions: strArray(d, "inclusions", type),
        exclusions: optStrArray(d, "exclusions", type),
        accommodationLevel: optStr(d, "accommodationLevel"),
        transportIncluded: typeof d.transportIncluded === "boolean" ? d.transportIncluded : undefined,
      };
  }
}

export function validateResourceCreate(body: unknown): ResourceCreateInput {
  if (!isObject(body)) throw new HttpError(400, "Invalid body");
  const { type, title, description, price, metadata } = body;

  if (!isValidType(type)) {
    throw new HttpError(400, `type must be one of: ${RESOURCE_TYPES.join(", ")}`);
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new HttpError(400, "title is required");
  }
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
    throw new HttpError(400, "price must be a non-negative number");
  }
  if (description !== undefined && typeof description !== "string") {
    throw new HttpError(400, "description must be a string");
  }

  return {
    type,
    title: title.trim(),
    description: typeof description === "string" ? description.trim() : "",
    price,
    metadata: validateDetails(type, metadata),
  };
}

export function validateResourceUpdate(body: unknown): ResourceUpdateInput {
  if (!isObject(body)) throw new HttpError(400, "Invalid body");
  const { type, title, description, price, metadata } = body;
  const out: ResourceUpdateInput = {};

  let resolvedType: ResourceType | undefined;
  if (type !== undefined) {
    if (!isValidType(type)) {
      throw new HttpError(400, `type must be one of: ${RESOURCE_TYPES.join(", ")}`);
    }
    resolvedType = type;
    out.type = type;
  }
  if (title !== undefined) {
    if (typeof title !== "string" || title.trim().length === 0) {
      throw new HttpError(400, "title must be a non-empty string");
    }
    out.title = title.trim();
  }
  if (description !== undefined) {
    if (typeof description !== "string") throw new HttpError(400, "description must be a string");
    out.description = description.trim();
  }
  if (price !== undefined) {
    if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
      throw new HttpError(400, "price must be a non-negative number");
    }
    out.price = price;
  }
  if (metadata !== undefined) {
    // Updating details requires knowing the type (provided in this request).
    if (!resolvedType) {
      throw new HttpError(400, "type is required when updating details");
    }
    out.metadata = validateDetails(resolvedType, metadata);
  }

  if (Object.keys(out).length === 0) {
    throw new HttpError(400, "No updatable fields provided");
  }
  return out;
}
