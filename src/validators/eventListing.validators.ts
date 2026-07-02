import { HttpError } from "../middleware/error";
import {
  EVENT_CATEGORIES,
  EVENT_TYPES,
  RECURRING_FREQUENCIES,
  VIRTUAL_PLATFORMS,
  EVENT_VENUE_TYPES,
  EVENT_CANCELLATION_POLICIES,
  CURRENCY_CODES,
} from "../models/partner/_shared/enums";
import type { IEventListing } from "../models/partner/EventListing";

// Validates the partner event form payload (sections already parsed from the
// multipart JSON fields, image URLs resolved by the controller) and returns a
// typed object ready for EventListingModel.create({ ...result, partner }).
// Same hand-written-helper style as hotelListing.validators.ts.

export interface EventListingRawInput {
  event: unknown; // identity + classification + dates + policies + organizer
  venue: unknown;
  virtualDetails: unknown;
  tickets: unknown;
  recurringPattern: unknown;
  imageUrls: string[];
}

export type ValidatedEventListing = Omit<
  IEventListing,
  | "partner"
  | "slug"
  | "status"
  | "isFree"
  | "priceRange"
  | "currentBookings"
  | "isSoldOut"
  | "isFeatured"
  | "createdAt"
  | "updatedAt"
>;

function fail(msg: string): never {
  throw new HttpError(400, `event: ${msg}`);
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

function reqDate(o: Record<string, unknown>, k: string): Date {
  const d = new Date(o[k] as string);
  if (Number.isNaN(d.getTime())) fail(`${k} must be a valid date`);
  return d;
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

export function validateEventListing(input: EventListingRawInput): ValidatedEventListing {
  if (!isObject(input.event)) fail("event section is required");
  const e = input.event as Record<string, unknown>;

  const title = reqStr(e, "title");
  if (title.length < 5 || title.length > 200) fail("title must be 5-200 characters");

  const description = reqStr(e, "description");
  if (description.length < 50 || description.length > 5000) fail("description must be 50-5000 characters");

  const category = enumVal(reqStr(e, "category"), EVENT_CATEGORIES, "category");
  const eventType = enumVal(optStr(e, "eventType") ?? "in_person", EVENT_TYPES, "eventType");

  const startDate = reqDate(e, "startDate");
  const endDate = reqDate(e, "endDate");
  if (endDate < startDate) fail("endDate must be on or after startDate");

  const tags = strArray(e.tags);
  if (tags.length > 10) fail("at most 10 tags allowed");

  // ── Tickets — at least one; availableQuantity seeded from totalQuantity ──────
  if (!Array.isArray(input.tickets) || input.tickets.length === 0) {
    fail("at least one ticket type is required");
  }
  const tickets = (input.tickets as unknown[]).map((t) => {
    if (!isObject(t)) fail("each ticket must be an object");
    const to = t as Record<string, unknown>;
    const totalQuantity = reqNum(to, "totalQuantity");
    if (totalQuantity < 1) fail("ticket.totalQuantity must be at least 1");
    return {
      name: reqStr(to, "name"),
      description: optStr(to, "description"),
      price: reqNum(to, "price"),
      currency: enumVal(optStr(to, "currency") ?? "INR", CURRENCY_CODES, "currency"),
      totalQuantity,
      soldQuantity: 0,
      availableQuantity: totalQuantity,
      maxPerOrder: optNum(to, "maxPerOrder") ?? 10,
      saleStartDate: optDate(to, "saleStartDate"),
      saleEndDate: optDate(to, "saleEndDate"),
      isActive: bool(to.isActive, true),
    };
  });

  // ── Capacity — must cover the total ticket inventory at minimum ──────────────
  const ticketCapacity = tickets.reduce((sum, t) => sum + t.totalQuantity, 0);
  const totalCapacity = optNum(e, "totalCapacity") ?? ticketCapacity;
  if (totalCapacity < 1) fail("totalCapacity must be at least 1");

  // ── Venue — required for in_person / hybrid (city is the minimum) ────────────
  let venue: ValidatedEventListing["venue"];
  if (eventType === "in_person" || eventType === "hybrid") {
    if (!isObject(input.venue)) fail("venue is required for in_person / hybrid events");
    const v = input.venue as Record<string, unknown>;
    const latitude = optNum(v, "lat");
    const longitude = optNum(v, "lng");
    venue = {
      name: optStr(v, "name"),
      address: optStr(v, "address"),
      city: reqStr(v, "city"),
      state: optStr(v, "state"),
      pincode: optStr(v, "pincode"),
      country: optStr(v, "country") ?? "India",
      coordinates:
        latitude !== undefined && longitude !== undefined
          ? { type: "Point" as const, coordinates: [longitude, latitude] as [number, number] }
          : undefined,
      landmark: optStr(v, "landmark"),
      venueType: v.venueType ? enumVal(String(v.venueType), EVENT_VENUE_TYPES, "venue.venueType") : undefined,
    };
  }

  // ── Virtual details — required for virtual / hybrid ──────────────────────────
  let virtualDetails: ValidatedEventListing["virtualDetails"];
  if (eventType === "virtual" || eventType === "hybrid") {
    const v = isObject(input.virtualDetails) ? (input.virtualDetails as Record<string, unknown>) : {};
    virtualDetails = {
      platform: v.platform ? enumVal(String(v.platform), VIRTUAL_PLATFORMS, "virtualDetails.platform") : undefined,
      link: optStr(v, "link"),
      instructions: optStr(v, "instructions"),
    };
  }

  // ── Recurrence — only when isRecurring ───────────────────────────────────────
  const isRecurring = bool(e.isRecurring, false);
  let recurringPattern: ValidatedEventListing["recurringPattern"];
  if (isRecurring) {
    if (!isObject(input.recurringPattern)) fail("recurringPattern is required when isRecurring is true");
    const r = input.recurringPattern as Record<string, unknown>;
    const daysOfWeek = Array.isArray(r.daysOfWeek)
      ? (r.daysOfWeek as unknown[]).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : [];
    recurringPattern = {
      frequency: enumVal(reqStr(r, "frequency"), RECURRING_FREQUENCIES, "recurringPattern.frequency"),
      endDate: optDate(r, "endDate"),
      daysOfWeek,
    };
  }

  // ── Organizer — name required ────────────────────────────────────────────────
  const orgRaw = isObject(e.organizer) ? (e.organizer as Record<string, unknown>) : {};
  const organizer = {
    name: reqStr(orgRaw, "name"),
    phone: optStr(orgRaw, "phone"),
    email: optStr(orgRaw, "email"),
    website: optStr(orgRaw, "website"),
    logo: optStr(orgRaw, "logo"),
  };

  // ── Age restriction ──────────────────────────────────────────────────────────
  const arRaw = isObject(e.ageRestriction) ? (e.ageRestriction as Record<string, unknown>) : {};
  const ageRestriction = {
    hasRestriction: bool(arRaw.hasRestriction, false),
    minimumAge: optNum(arRaw, "minimumAge"),
  };

  if (input.imageUrls.length === 0) fail("at least one image is required");
  if (input.imageUrls.length > 10) fail("at most 10 images allowed");

  return {
    title,
    description,
    shortDescription: optStr(e, "shortDescription"),
    category,
    tags,
    eventType,
    startDate,
    endDate,
    startTime: optStr(e, "startTime"),
    endTime: optStr(e, "endTime"),
    isRecurring,
    recurringPattern,
    venue,
    virtualDetails,
    images: input.imageUrls.map((url, i) => ({ url, isPrimary: i === 0 })),
    tickets,
    totalCapacity,
    organizer,
    cancellationPolicy: enumVal(
      optStr(e, "cancellationPolicy") ?? "no_refund",
      EVENT_CANCELLATION_POLICIES,
      "cancellationPolicy",
    ),
    cancellationDetails: optStr(e, "cancellationDetails"),
    termsAndConditions: optStr(e, "termsAndConditions"),
    ageRestriction,
    metaTitle: optStr(e, "metaTitle"),
    metaDescription: optStr(e, "metaDescription"),
  };
}
