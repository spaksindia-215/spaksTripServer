import { HttpError } from "../middleware/error";
import {
  CURRENCY_CODES,
  RESOURCE_STATUS,
  OPERATING_DAYS,
  SERVICE_CANCELLATION_POLICIES,
  TRANSFER_TYPES,
  TRANSFER_VEHICLE_TYPES,
  SELF_DRIVE_CATEGORIES,
  TRANSMISSION_TYPES,
  FUEL_TYPES,
  MILEAGE_POLICIES,
  FUEL_POLICIES,
  INSURANCE_TIERS,
  ISLANDHOPPER_SERVICE_TYPES,
  VISA_CATEGORIES,
  VISA_CONSULTATION_MODES,
  VISA_PAYMENT_STRUCTURES,
} from "../models/partner/_shared/enums";

// Hand-written validators for the four enquiry-first service modules (Transfer,
// Self-Drive, Islandhopper, Visa). Shares primitives with the tour/sightseeing
// validators' style. The controller resolves `images` separately, so it is omitted
// here. Each returns a loosely-typed object that the model re-validates on save.

// ── Primitives ───────────────────────────────────────────────────────────────
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function reqStr(scope: string, o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string" || v.trim().length === 0) throw new HttpError(400, `${scope}: ${k} is required`);
  return (v as string).trim();
}
function optStr(o: Record<string, unknown>, k: string): string | undefined {
  return typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : undefined;
}
function optNum(scope: string, o: Record<string, unknown>, k: string): number | undefined {
  if (o[k] === undefined || o[k] === null || o[k] === "") return undefined;
  const v = typeof o[k] === "number" ? (o[k] as number) : Number(o[k]);
  if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `${scope}: ${k} must be a non-negative number`);
  return v;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function strArray(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v === "string") return Array.from(new Set(v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)));
  if (!Array.isArray(v)) return [];
  return Array.from(new Set((v as unknown[]).filter((e) => typeof e === "string").map((s) => (s as string).trim()).filter(Boolean)));
}
function inEnum<T extends string>(scope: string, values: readonly T[], raw: unknown, label: string, fallback?: T): T {
  if ((raw === undefined || raw === null || raw === "") && fallback !== undefined) return fallback;
  const s = String(raw);
  if (!(values as readonly string[]).includes(s)) throw new HttpError(400, `${scope}: ${label} must be one of: ${values.join(", ")}`);
  return s as T;
}
function enumArray<T extends string>(values: readonly T[], v: unknown): T[] {
  return strArray(v).filter((s): s is T => (values as readonly string[]).includes(s));
}
function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as unknown[]).filter(isObject) : [];
}
function common(scope: string, d: Record<string, unknown>): Record<string, unknown> {
  return {
    status: inEnum(scope, RESOURCE_STATUS, d.status, "status", "draft"),
    title: reqStr(scope, d, "title"),
    description: optStr(d, "description"),
    termsAndConditions: optStr(d, "termsAndConditions"),
    tags: strArray(d.tags),
    currency: inEnum(scope, CURRENCY_CODES, d.currency, "currency", "INR"),
    cancellationPolicy: inEnum(scope, SERVICE_CANCELLATION_POLICIES, d.cancellationPolicy, "cancellationPolicy", "free_24h"),
  };
}

// ── Transfer ─────────────────────────────────────────────────────────────────
export function validateTransfer(body: unknown): Record<string, unknown> {
  if (!isObject(body)) throw new HttpError(400, "transfer: request body is required");
  const d = body as Record<string, unknown>;
  return {
    ...common("transfer", d),
    transferType: inEnum("transfer", TRANSFER_TYPES, d.transferType, "transferType"),
    coverageAreas: strArray(d.coverageAreas),
    routes: arr(d.routes).map((r) => ({
      from: optStr(r, "from"),
      to: optStr(r, "to"),
      estimatedDuration: optNum("transfer", r, "estimatedDuration"),
      estimatedDistance: optNum("transfer", r, "estimatedDistance"),
      price: optNum("transfer", r, "price"),
    })),
    vehicles: arr(d.vehicles).map((v) => ({
      type: inEnum("transfer", TRANSFER_VEHICLE_TYPES, v.type, "vehicles.type"),
      makeModel: optStr(v, "makeModel"),
      maxPassengers: optNum("transfer", v, "maxPassengers"),
      maxLuggage: optNum("transfer", v, "maxLuggage"),
      features: strArray(v.features),
      basePrice: optNum("transfer", v, "basePrice"),
    })),
    meetAndGreet: bool(d.meetAndGreet, false),
    flightTracking: bool(d.flightTracking, false),
    childSeat: {
      available: bool(isObject(d.childSeat) ? d.childSeat.available : false, false),
      surcharge: isObject(d.childSeat) ? optNum("transfer", d.childSeat, "surcharge") : undefined,
    },
    waitingTimePolicy: optStr(d, "waitingTimePolicy"),
    operatingHours: {
      start: isObject(d.operatingHours) ? optStr(d.operatingHours, "start") : undefined,
      end: isObject(d.operatingHours) ? optStr(d.operatingHours, "end") : undefined,
      is24x7: bool(isObject(d.operatingHours) ? d.operatingHours.is24x7 : false, false),
    },
    advanceBookingHours: optNum("transfer", d, "advanceBookingHours") ?? 24,
  };
}

// ── Self-Drive ───────────────────────────────────────────────────────────────
export function validateSelfDrive(body: unknown): Record<string, unknown> {
  if (!isObject(body)) throw new HttpError(400, "self_drive: request body is required");
  const d = body as Record<string, unknown>;
  const dr = isObject(d.driverRequirements) ? d.driverRequirements : {};
  const dep = isObject(d.securityDeposit) ? d.securityDeposit : {};
  const del = isObject(d.deliveryCollection) ? d.deliveryCollection : {};
  return {
    ...common("self_drive", d),
    pickupLocations: arr(d.pickupLocations).map((l) => ({ name: optStr(l, "name"), address: optStr(l, "address") })),
    dropoffLocations: arr(d.dropoffLocations).map((l) => ({ name: optStr(l, "name"), address: optStr(l, "address") })),
    sameLocationReturnOnly: bool(d.sameLocationReturnOnly, false),
    vehicles: arr(d.vehicles).map((v) => ({
      category: inEnum("self_drive", SELF_DRIVE_CATEGORIES, v.category, "vehicles.category"),
      makeModel: optStr(v, "makeModel"),
      year: optNum("self_drive", v, "year"),
      transmission: v.transmission ? inEnum("self_drive", TRANSMISSION_TYPES, v.transmission, "transmission") : undefined,
      fuelType: v.fuelType ? inEnum("self_drive", FUEL_TYPES, v.fuelType, "fuelType") : undefined,
      seats: optNum("self_drive", v, "seats"),
      luggageCapacity: optNum("self_drive", v, "luggageCapacity"),
      features: strArray(v.features),
      photos: strArray(v.photos),
      dailyRate: optNum("self_drive", v, "dailyRate"),
      weeklyRate: optNum("self_drive", v, "weeklyRate"),
      monthlyRate: optNum("self_drive", v, "monthlyRate"),
      mileagePolicy: v.mileagePolicy ? inEnum("self_drive", MILEAGE_POLICIES, v.mileagePolicy, "mileagePolicy") : undefined,
      kmPerDay: optNum("self_drive", v, "kmPerDay"),
      excessChargePerKm: optNum("self_drive", v, "excessChargePerKm"),
      fuelPolicy: v.fuelPolicy ? inEnum("self_drive", FUEL_POLICIES, v.fuelPolicy, "fuelPolicy") : undefined,
      inventoryCount: optNum("self_drive", v, "inventoryCount"),
    })),
    insuranceOptions: arr(d.insuranceOptions).map((i) => ({
      tier: inEnum("self_drive", INSURANCE_TIERS, i.tier, "insuranceOptions.tier"),
      coverageDetails: optStr(i, "coverageDetails"),
      deductibleAmount: optNum("self_drive", i, "deductibleAmount"),
      dailySurcharge: optNum("self_drive", i, "dailySurcharge"),
    })),
    extras: arr(d.extras).map((e) => ({ name: reqStr("self_drive", e, "name"), dailyPrice: optNum("self_drive", e, "dailyPrice") })),
    minRentalDays: optNum("self_drive", d, "minRentalDays") ?? 1,
    maxRentalDays: optNum("self_drive", d, "maxRentalDays"),
    driverRequirements: {
      minimumAge: optNum("self_drive", dr, "minimumAge"),
      acceptedLicenceTypes: strArray(dr.acceptedLicenceTypes),
      minimumExperienceYears: optNum("self_drive", dr, "minimumExperienceYears"),
    },
    securityDeposit: { amount: optNum("self_drive", dep, "amount"), method: optStr(dep, "method") },
    lateReturnPolicy: optStr(d, "lateReturnPolicy"),
    deliveryCollection: { available: bool(del.available, false), charge: optNum("self_drive", del, "charge") },
  };
}

// ── Islandhopper ─────────────────────────────────────────────────────────────
export function validateIslandhopper(body: unknown): Record<string, unknown> {
  if (!isObject(body)) throw new HttpError(400, "islandhopper: request body is required");
  const d = body as Record<string, unknown>;
  const vessel = isObject(d.vessel) ? d.vessel : {};
  const bag = isObject(d.baggagePolicy) ? d.baggagePolicy : {};
  return {
    ...common("islandhopper", d),
    serviceType: inEnum("islandhopper", ISLANDHOPPER_SERVICE_TYPES, d.serviceType, "serviceType"),
    routes: arr(d.routes).map((r) => ({
      origin: optStr(r, "origin"),
      destination: optStr(r, "destination"),
      distance: optNum("islandhopper", r, "distance"),
      estimatedDuration: optNum("islandhopper", r, "estimatedDuration"),
      isNonStop: bool(r.isNonStop, true),
      oneWayFare: optNum("islandhopper", r, "oneWayFare"),
      roundTripFare: optNum("islandhopper", r, "roundTripFare"),
    })),
    schedule: arr(d.schedule).map((s) => ({
      route: optStr(s, "route"),
      daysOfWeek: enumArray(OPERATING_DAYS, s.daysOfWeek),
      departureTimes: strArray(s.departureTimes),
      frequency: optStr(s, "frequency"),
    })),
    vessel: { type: optStr(vessel, "type"), capacity: optNum("islandhopper", vessel, "capacity"), amenities: strArray(vessel.amenities) },
    baggagePolicy: {
      includedKg: optNum("islandhopper", bag, "includedKg"),
      excessPerKg: optNum("islandhopper", bag, "excessPerKg"),
      prohibitedItems: strArray(bag.prohibitedItems),
    },
    checkinPolicy: optStr(d, "checkinPolicy"),
    departurePoint: optStr(d, "departurePoint"),
    canConnect: bool(d.canConnect, false),
    weatherRestrictions: optStr(d, "weatherRestrictions"),
  };
}

// ── Visa Consultancy ─────────────────────────────────────────────────────────
export function validateVisa(body: unknown): Record<string, unknown> {
  if (!isObject(body)) throw new HttpError(400, "visa: request body is required");
  const d = body as Record<string, unknown>;
  return {
    ...common("visa", d),
    licenceNumber: optStr(d, "licenceNumber"),
    countriesCovered: strArray(d.countriesCovered),
    visaTypesOffered: enumArray(VISA_CATEGORIES, d.visaTypesOffered),
    services: arr(d.services).map((s) => ({
      country: optStr(s, "country"),
      visaCategory: inEnum("visa", VISA_CATEGORIES, s.visaCategory, "services.visaCategory"),
      serviceDescription: optStr(s, "serviceDescription"),
      eligibilityCriteria: optStr(s, "eligibilityCriteria"),
      documentsRequired: strArray(s.documentsRequired),
      processSteps: strArray(s.processSteps),
      estimatedProcessingTime: optStr(s, "estimatedProcessingTime"),
      successRate: optNum("visa", s, "successRate"),
      consultancyFee: optNum("visa", s, "consultancyFee"),
      paymentStructure: s.paymentStructure ? inEnum("visa", VISA_PAYMENT_STRUCTURES, s.paymentStructure, "paymentStructure") : undefined,
      governmentFeesIndicative: optNum("visa", s, "governmentFeesIndicative"),
      refundPolicy: optStr(s, "refundPolicy"),
      additionalServices: strArray(s.additionalServices),
    })),
    consultationModes: enumArray(VISA_CONSULTATION_MODES, d.consultationModes),
    languages: strArray(d.languages),
    officeLocations: arr(d.officeLocations).map((l) => ({ address: optStr(l, "address"), hours: optStr(l, "hours") })),
    teamProfiles: arr(d.teamProfiles).map((t) => ({
      name: optStr(t, "name"),
      role: optStr(t, "role"),
      qualifications: optStr(t, "qualifications"),
      specialization: optStr(t, "specialization"),
    })),
    isFreeInitialConsultation: bool(d.isFreeInitialConsultation, false),
    consultationFee: optNum("visa", d, "consultationFee"),
  };
}
