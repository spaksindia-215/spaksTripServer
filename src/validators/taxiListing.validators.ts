import { HttpError } from "../middleware/error";
import {
  TAXI_VEHICLE_TYPES,
  TAXI_FUEL_TYPES,
  TAXI_TRANSMISSION_TYPES,
  TAXI_SERVICE_TYPES,
  type TaxiVehicleType,
  type TaxiFuelType,
  type TaxiTransmissionType,
  type TaxiLuggageSize,
  type TaxiServiceType,
} from "../models/partner/_shared/enums";
import type { ITaxiListing } from "../models/partner/TaxiListing";

// Validates + adapts the existing client list-your-taxi payload (flat, single
// vehicle, single fare) into the MTI TaxiListing model shape. The form sends the
// client's TaxiListing object (see client/src/types/taxiListing.ts); here we
// re-validate server-side and derive one default service from the flat pricing.

export type ValidatedTaxiListing = Omit<
  ITaxiListing,
  "partner" | "slug" | "createdAt" | "updatedAt"
>;

// Cloudinary URLs resolved by the controller before validation.
export interface TaxiMedia {
  vehicleImageUrls?: string[];
  docs?: {
    vehicleRC?: string;
    insurance?: string;
    pollutionCertificate?: string;
    drivingLicense?: string;
  };
}

// Editable subset surfaced by the My Taxis dashboard editor.
export interface TaxiListingUpdateInput {
  operatingCity?: string;
  minimumFare?: number;
  pricePerKm?: number;
  serviceAreas?: string[];
  availableRoutes?: string[];
  description?: string;
  availableDays?: string[];
  availableTimeSlots?: string[];
  amenities?: string[];
  availabilityEnabled?: boolean;
}

function fail(msg: string): never {
  throw new HttpError(400, `taxi: ${msg}`);
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
    // Tolerate comma/newline-joined strings as well as arrays.
    return Array.from(new Set(v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)));
  }
  if (!Array.isArray(v)) return [];
  return Array.from(new Set((v as unknown[]).filter((e) => typeof e === "string").map((s) => (s as string).trim()).filter(Boolean)));
}

// Map the form's human-readable label to a canonical snake enum value.
function mapEnum<T extends string>(raw: string, allowed: readonly T[], field: string): T {
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, "_");
  if (!(allowed as readonly string[]).includes(normalized)) {
    fail(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return normalized as T;
}

function luggageBucket(bags: number | undefined): TaxiLuggageSize | undefined {
  if (bags === undefined) return undefined;
  if (bags <= 2) return "small";
  if (bags <= 4) return "medium";
  return "large";
}

// "06:00 - 10:00" → { from: "06:00", to: "10:00" }
function parseSlot(raw: string): { from: string; to: string } | null {
  const m = raw.split(/[-–]/).map((s) => s.trim());
  if (m.length !== 2 || !m[0] || !m[1]) return null;
  return { from: m[0], to: m[1] };
}

function buildDocRef(url: string | undefined): { url: string } | undefined {
  return url ? { url } : undefined;
}

export function validateTaxiListing(body: unknown, media: TaxiMedia = {}): ValidatedTaxiListing {
  if (!isObject(body)) fail("request body is required");
  const d = body as Record<string, unknown>;

  // ── Vehicle ────────────────────────────────────────────────────────────────
  const vehicleType = mapEnum<TaxiVehicleType>(reqStr(d, "vehicleType"), TAXI_VEHICLE_TYPES, "vehicleType");
  const fuelRaw = optStr(d, "fuelType");
  const fuelType = fuelRaw ? mapEnum<TaxiFuelType>(fuelRaw, TAXI_FUEL_TYPES, "fuelType") : undefined;
  const transRaw = optStr(d, "transmission");
  const transmission = transRaw
    ? mapEnum<TaxiTransmissionType>(transRaw, TAXI_TRANSMISSION_TYPES, "transmission")
    : undefined;
  const luggageCapacity = optNum(d, "luggageCapacity");

  const vehicle = {
    make: reqStr(d, "brand"),
    model: reqStr(d, "model"),
    type: vehicleType,
    fuelType,
    transmission,
    registrationNumber: optStr(d, "registrationNumber"),
    yearOfManufacture: optNum(d, "yearOfManufacture"),
    seatingCap: reqNum(d, "seatingCapacity"),
    acAvailable: bool(d.acAvailable, true),
    luggageSpace: luggageBucket(luggageCapacity),
    luggageCapacity,
    images: (media.vehicleImageUrls ?? []).map((url, i) => ({ url, isPrimary: i === 0 })),
    amenities: strArray(d.amenities),
  };

  // ── Service (derive one from the flat fare/coverage fields) ─────────────────
  const baseCity = reqStr(d, "operatingCity");
  const serviceAreas = strArray(d.serviceAreas);
  const routes = strArray(d.availableRoutes);
  const baseFare = reqNum(d, "minimumFare");
  const pricePerKm = optNum(d, "pricePerKm");

  // Allow an explicit serviceType override; otherwise default to outstation,
  // which best matches the form's intercity routes + service areas.
  const serviceTypeRaw = optStr(d, "serviceType");
  const serviceType = serviceTypeRaw
    ? mapEnum<TaxiServiceType>(serviceTypeRaw, TAXI_SERVICE_TYPES, "serviceType")
    : ("outstation" as TaxiServiceType);

  const services = [
    {
      type: serviceType,
      isActive: true,
      pricing: { baseFare, pricePerKm, tollsIncluded: false, taxPercent: 5 },
      coverage: { baseCity, servicedCities: serviceAreas },
    },
  ];

  // ── Operational hours from availableTimeSlots ───────────────────────────────
  const slotStrings = strArray(d.availableTimeSlots);
  const slots = slotStrings.map(parseSlot).filter((s): s is { from: string; to: string } => s !== null);
  const operationalHours = { available24x7: slots.length === 0, slots };

  return {
    status: bool(d.availabilityEnabled, true) ? "active" : "paused",
    vehicle,
    services,
    operationalHours,
    operatingDays: strArray(d.availableDays),
    routes,
    advanceBookingHrs: optNum(d, "advanceBookingHrs") ?? 4,
    docs: {
      vehicleRC: buildDocRef(media.docs?.vehicleRC),
      insurance: buildDocRef(media.docs?.insurance),
      pollutionCertificate: buildDocRef(media.docs?.pollutionCertificate),
      drivingLicense: buildDocRef(media.docs?.drivingLicense),
    },
    cancellationPolicy: { freeCancelHrs: 24, chargePercent: 10 },
    contact: {
      name: optStr(d, "fullName"),
      phone: optStr(d, "mobileNumber"),
      email: optStr(d, "emailAddress"),
      businessName: optStr(d, "businessName"),
    },
    description: optStr(d, "description"),
    driverIncluded: bool(d.driverIncluded, true),
    selfDriveAvailable: bool(d.selfDriveAvailable, false),
  };
}

// Validate the dashboard editor's partial update. Only provided keys are
// returned; the controller maps them onto the loaded MTI document.
export function validateTaxiListingUpdate(body: unknown): TaxiListingUpdateInput {
  if (!isObject(body)) fail("request body is required");
  const d = body as Record<string, unknown>;
  const out: TaxiListingUpdateInput = {};

  if (d.operatingCity !== undefined) out.operatingCity = reqStr(d, "operatingCity");
  if (d.minimumFare !== undefined) out.minimumFare = reqNum(d, "minimumFare");
  if (d.pricePerKm !== undefined) out.pricePerKm = reqNum(d, "pricePerKm");
  if (d.serviceAreas !== undefined) out.serviceAreas = strArray(d.serviceAreas);
  if (d.availableRoutes !== undefined) out.availableRoutes = strArray(d.availableRoutes);
  if (d.description !== undefined) out.description = optStr(d, "description") ?? "";
  if (d.availableDays !== undefined) out.availableDays = strArray(d.availableDays);
  if (d.availableTimeSlots !== undefined) out.availableTimeSlots = strArray(d.availableTimeSlots);
  if (d.amenities !== undefined) out.amenities = strArray(d.amenities);
  if (d.availabilityEnabled !== undefined) out.availabilityEnabled = bool(d.availabilityEnabled, true);

  if (Object.keys(out).length === 0) fail("no updatable fields provided");
  return out;
}

// "06:00 - 10:00" → { from, to }; exported for the controller's slot mapping.
export function parseSlotStrings(slots: string[]): { from: string; to: string }[] {
  return slots.map(parseSlot).filter((s): s is { from: string; to: string } => s !== null);
}
