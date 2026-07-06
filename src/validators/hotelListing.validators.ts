import { HttpError } from "../middleware/error";
import {
  HOTEL_TYPES,
  HOTEL_MEAL_TYPES,
  HOTEL_DISCOUNT_TYPES,
  HOTEL_STAR_RATINGS,
  CURRENCY_CODES,
  type HotelType,
} from "../models/partner/_shared/enums";
import type { IHotelListing } from "../models/partner/HotelListing";

// Validates the partner hotel form payload (already split into sections and with
// uploaded image URLs resolved by the controller) and returns a typed object
// ready for HotelListingModel.create({ ...result, partner }). All field shapes
// trace back to client/src/components/partner/HotelPartnerRegistration.tsx.

export interface HotelListingRawInput {
  hotel: unknown;
  rooms: unknown;
  rates: unknown;
  inventory: unknown;
  pricing: unknown;
  promotions: unknown;
  hotelImageUrls: string[];
  // room client id → uploaded image URLs
  roomImageUrls: Record<string, string[]>;
}

export type ValidatedHotelListing = Omit<
  IHotelListing,
  "partner" | "slug" | "status" | "createdAt" | "updatedAt"
>;

// ── Field helpers (throw HttpError(400) with a `hotel: <msg>` prefix) ──────────
function fail(msg: string): never {
  throw new HttpError(400, `hotel: ${msg}`);
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

function optDate(o: Record<string, unknown>, k: string): Date | undefined {
  if (o[k] === undefined || o[k] === null || o[k] === "") return undefined;
  const d = new Date(o[k] as string);
  if (Number.isNaN(d.getTime())) fail(`${k} must be a valid date`);
  return d;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function strArray(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail("expected an array of strings");
  return (v as unknown[]).filter((e) => typeof e === "string").map((s) => (s as string).trim()).filter(Boolean);
}

function enumVal<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    fail(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

// Map the form's human-readable hotelType ("Guest House") to the canonical enum.
function normalizeHotelType(raw: string): HotelType {
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, "_");
  return enumVal(normalized, HOTEL_TYPES, "type");
}

export function validateHotelListing(input: HotelListingRawInput): ValidatedHotelListing {
  if (!isObject(input.hotel)) fail("hotel section is required");
  const h = input.hotel as Record<string, unknown>;

  const name = reqStr(h, "hotelName");
  const type = normalizeHotelType(reqStr(h, "hotelType"));

  const starRaw = reqNum(h, "starRating");
  if (!(HOTEL_STAR_RATINGS as readonly number[]).includes(starRaw)) {
    fail(`starRating must be one of: ${HOTEL_STAR_RATINGS.join(", ")}`);
  }

  // Rooms — at least one, each keyed by the client-generated id.
  if (!Array.isArray(input.rooms) || input.rooms.length === 0) {
    fail("at least one room is required");
  }
  const rooms = (input.rooms as unknown[]).map((r) => {
    if (!isObject(r)) fail("each room must be an object");
    const ro = r as Record<string, unknown>;
    const key = reqStr(ro, "id");
    return {
      key,
      name: reqStr(ro, "name"),
      description: optStr(ro, "description"),
      maxAdults: optNum(ro, "maxAdults") ?? 1,
      maxChildren: optNum(ro, "maxChildren") ?? 0,
      bedType: optStr(ro, "bedType"),
      roomSize: optStr(ro, "roomSize"),
      amenities: strArray(ro.amenities),
      images: input.roomImageUrls[key] ?? [],
    };
  });
  const roomKeys = new Set(rooms.map((r) => r.key));

  // Rates — reference an existing room via roomTypeId.
  const ratesRaw = Array.isArray(input.rates) ? (input.rates as unknown[]) : [];
  const rates = ratesRaw.map((r) => {
    if (!isObject(r)) fail("each rate must be an object");
    const ra = r as Record<string, unknown>;
    const roomKey = reqStr(ra, "roomTypeId");
    if (!roomKeys.has(roomKey)) fail(`rate references unknown room "${roomKey}"`);
    return {
      key: optStr(ra, "id") ?? roomKey,
      roomKey,
      name: optStr(ra, "name") ?? "",
      mealType: enumVal(optStr(ra, "mealType") ?? "Room Only", HOTEL_MEAL_TYPES, "mealType"),
      refundable: bool(ra.refundable, true),
      inclusions: strArray(ra.inclusions),
    };
  });

  // Inventory — reference an existing room; availableRooms cannot exceed total.
  const inventoryRaw = Array.isArray(input.inventory) ? (input.inventory as unknown[]) : [];
  const inventory = inventoryRaw.map((r) => {
    if (!isObject(r)) fail("each inventory entry must be an object");
    const iv = r as Record<string, unknown>;
    const roomKey = reqStr(iv, "roomTypeId");
    if (!roomKeys.has(roomKey)) fail(`inventory references unknown room "${roomKey}"`);
    const totalRooms = optNum(iv, "totalRooms") ?? 0;
    const availableRooms = optNum(iv, "availableRooms") ?? 0;
    if (availableRooms > totalRooms) {
      fail(`availableRooms (${availableRooms}) cannot exceed totalRooms (${totalRooms}) for room "${roomKey}"`);
    }
    return { roomKey, totalRooms, availableRooms };
  });

  // Pricing — basePricePerNight required.
  if (!isObject(input.pricing)) fail("pricing section is required");
  const p = input.pricing as Record<string, unknown>;
  const currency = enumVal(optStr(p, "currency") ?? "INR", CURRENCY_CODES, "currency");
  const pricing = {
    basePricePerNight: reqNum(p, "basePricePerNight"),
    taxPercentage: optNum(p, "taxPercentage") ?? 0,
    extraAdultCharge: optNum(p, "extraAdultCharge"),
    extraChildCharge: optNum(p, "extraChildCharge"),
    currency,
  };
  if (pricing.taxPercentage > 100) fail("taxPercentage cannot exceed 100");

  // Promotions — optional.
  const promotionsRaw = Array.isArray(input.promotions) ? (input.promotions as unknown[]) : [];
  const promotions = promotionsRaw.map((r) => {
    if (!isObject(r)) fail("each promotion must be an object");
    const pr = r as Record<string, unknown>;
    return {
      key: optStr(pr, "id") ?? reqStr(pr, "name"),
      name: reqStr(pr, "name"),
      discountType: enumVal(optStr(pr, "discountType") ?? "Percentage", HOTEL_DISCOUNT_TYPES, "discountType"),
      discountValue: optNum(pr, "discountValue") ?? 0,
      startDate: optDate(pr, "startDate"),
      endDate: optDate(pr, "endDate"),
    };
  });

  // Coordinates — only when both lat & lng are present.
  const latitude = optNum(h, "latitude");
  const longitude = optNum(h, "longitude");
  const coordinates =
    latitude !== undefined && longitude !== undefined
      ? ({ type: "Point" as const, coordinates: [longitude, latitude] as [number, number] })
      : undefined;

  const policiesRaw = isObject(h.policies) ? (h.policies as Record<string, unknown>) : {};

  return {
    name,
    type,
    description: optStr(h, "description"),
    starRating: starRaw as ValidatedHotelListing["starRating"],
    address: {
      street: optStr(h, "address"),
      city: reqStr(h, "city"),
      state: optStr(h, "state"),
      country: optStr(h, "country"),
      postalCode: optStr(h, "postalCode"),
    },
    coordinates,
    contact: {
      phone: optStr(h, "contactNumber"),
      email: optStr(h, "email"),
    },
    policies: {
      checkIn: optStr(h, "checkInTime"),
      checkOut: optStr(h, "checkOutTime"),
      cancellation: optStr(policiesRaw, "cancellation"),
      child: optStr(policiesRaw, "child"),
      pet: optStr(policiesRaw, "pet"),
      smoking: optStr(policiesRaw, "smoking"),
    },
    amenities: strArray(h.amenities),
    images: input.hotelImageUrls.map((url, i) => ({ url, isPrimary: i === 0 })),
    rooms,
    rates,
    inventory,
    pricing,
    promotions,
    tags: strArray(h.tags),
    seoTitle: optStr(h, "seoTitle"),
  };
}
