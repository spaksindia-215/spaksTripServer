import { HttpError } from "../middleware/error";
import { Types } from "mongoose";
import {
  PACKAGE_KINDS,
  PACKAGE_SCOPES,
  CURRENCY_CODES,
  LISTING_REF_MODELS,
  OPERATING_DAYS,
  SIGHTSEEING_CATEGORIES,
  SIGHTSEEING_DIFFICULTY,
  SIGHTSEEING_PRICING_MODELS,
  SIGHTSEEING_DURATION_UNITS,
  SERVICE_CANCELLATION_POLICIES,
  INDIAN_STATES,
  INTERNATIONAL_COUNTRIES,
  type PackageKind,
  type PackageScope,
  type CurrencyCode,
  type ListingRefModel,
} from "../models/partner/_shared/enums";
import type { IPackage, PackageComponent, PackageItineraryDay, PackageRoute } from "../models/partner/Package";
import type { IPackageOffer, OfferContact } from "../models/partner/PackageOffer";
import type { EnquiryContact, EnquiryPax } from "../models/partner/PackageEnquiry";

// Hand-written validators for the marketplace package endpoints (same helper style
// as eventListing.validators.ts). Sections arrive already parsed from the multipart
// JSON fields; image URLs are resolved by the controller.

function fail(scope: string, msg: string): never {
  throw new HttpError(400, `${scope}: ${msg}`);
}
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function reqStr(scope: string, o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string" || v.trim().length === 0) fail(scope, `${k} is required`);
  return (v as string).trim();
}
function optStr(o: Record<string, unknown>, k: string): string | undefined {
  return typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : undefined;
}
function strArr(o: Record<string, unknown>, k: string): string[] {
  const v = o[k];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
}
function optNum(o: Record<string, unknown>, k: string): number | undefined {
  if (o[k] === undefined || o[k] === null || o[k] === "") return undefined;
  const n = Number(o[k]);
  return Number.isFinite(n) ? n : undefined;
}
function inEnum<T extends string>(scope: string, values: readonly T[], raw: unknown, label: string): T {
  if (typeof raw !== "string" || !(values as readonly string[]).includes(raw)) {
    fail(scope, `${label} must be one of: ${values.join(", ")}`);
  }
  return raw as T;
}

// ── Package definition ─────────────────────────────────────────────────────────
export interface PackageRawInput {
  body: Record<string, unknown>;
  imageUrls: string[];
}

export type ValidatedPackage = Pick<
  IPackage,
  | "kind"
  | "scope"
  | "title"
  | "thumbnail"
  | "description"
  | "highlights"
  | "tags"
  | "state"
  | "country"
  | "region"
  | "route"
  | "itinerary"
  | "components"
  | "inclusions"
  | "exclusions"
  | "specs"
  | "referencePrice"
  | "currency"
> & { images: { url: string; isPrimary?: boolean }[] };

function validateRoute(raw: unknown): PackageRoute {
  const o = isObject(raw) ? raw : {};
  const destinations = strArr(o, "destinations");
  return {
    origin: optStr(o, "origin"),
    destinations,
    durationDays: optNum(o, "durationDays") ?? 1,
    durationNights: optNum(o, "durationNights") ?? 0,
  };
}

function validateItinerary(raw: unknown): PackageItineraryDay[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, i): PackageItineraryDay => {
    const o = isObject(entry) ? entry : {};
    const meals = isObject(o.meals) ? o.meals : {};
    return {
      day: optNum(o, "day") ?? i + 1,
      title: optStr(o, "title"),
      description: optStr(o, "description"),
      meals: {
        breakfast: meals.breakfast === true,
        lunch: meals.lunch === true,
        dinner: meals.dinner === true,
      },
      accommodation: optStr(o, "accommodation"),
      activities: strArr(o, "activities"),
    };
  });
}

// Bundle components: each piece may link to one of the partner's real listings
// (ref + refModel) or be a free-form entry (title only). Only kept for kind
// "bundle"; other kinds discard any components sent.
function validateComponents(raw: unknown): PackageComponent[] {
  if (!Array.isArray(raw)) return [];
  const out: PackageComponent[] = [];
  for (const entry of raw) {
    const o = isObject(entry) ? entry : {};
    const title = optStr(o, "title");
    if (!title) continue; // a component without a title is meaningless — drop it
    const refModelRaw = optStr(o, "refModel");
    const refModel =
      refModelRaw && (LISTING_REF_MODELS as readonly string[]).includes(refModelRaw)
        ? (refModelRaw as ListingRefModel)
        : undefined;
    const refRaw = optStr(o, "ref");
    // A ref is only honoured alongside a valid refModel and a valid ObjectId.
    const ref = refModel && refRaw && Types.ObjectId.isValid(refRaw) ? new Types.ObjectId(refRaw) : undefined;
    const qty = optNum(o, "quantity");
    out.push({
      category: optStr(o, "category") ?? "Other",
      refModel: ref ? refModel : undefined,
      ref,
      title,
      description: optStr(o, "description"),
      quantity: qty !== undefined && qty >= 1 ? Math.floor(qty) : 1,
      included: o.included === false ? false : true,
    });
  }
  return out;
}

// Sightseeing-specific fields, kept under Package.specs so a template carries the
// same field set as a partner SightseeingListing (see SightseeingListing.ts). Only
// applied when kind === "sightseeing"; every other kind keeps the loose passthrough.
function validateSightseeingSpecs(raw: unknown): Record<string, unknown> {
  const o = isObject(raw) ? raw : {};
  const location = isObject(o.location) ? o.location : {};
  const meetingPoint = isObject(o.meetingPoint) ? o.meetingPoint : {};
  const duration = isObject(o.duration) ? o.duration : {};
  const ageRestriction = isObject(o.ageRestriction) ? o.ageRestriction : {};
  const groupSize = isObject(o.groupSize) ? o.groupSize : {};
  const pricing = isObject(o.pricing) ? o.pricing : {};

  const availableDaysRaw = Array.isArray(o.availableDays) ? o.availableDays : [];
  const availableDays = availableDaysRaw.filter(
    (d): d is string => typeof d === "string" && (OPERATING_DAYS as readonly string[]).includes(d),
  );

  const blackoutDatesRaw = Array.isArray(o.blackoutDates) ? o.blackoutDates : [];
  const blackoutDates = blackoutDatesRaw
    .filter((d): d is string => typeof d === "string" && d.trim().length > 0)
    .map((d) => d.trim());

  return {
    category: o.category !== undefined
      ? inEnum("package.specs", SIGHTSEEING_CATEGORIES, o.category, "category")
      : undefined,
    location: {
      island: optStr(location, "island"),
      address: optStr(location, "address"),
    },
    meetingPoint: {
      instructions: optStr(meetingPoint, "instructions"),
    },
    duration: {
      value: optNum(duration, "value"),
      unit: duration.unit !== undefined
        ? inEnum("package.specs", SIGHTSEEING_DURATION_UNITS, duration.unit, "duration.unit")
        : undefined,
    },
    difficulty: o.difficulty !== undefined
      ? inEnum("package.specs", SIGHTSEEING_DIFFICULTY, o.difficulty, "difficulty")
      : undefined,
    ageRestriction: {
      min: optNum(ageRestriction, "min"),
      max: optNum(ageRestriction, "max"),
    },
    groupSize: {
      min: optNum(groupSize, "min"),
      max: optNum(groupSize, "max"),
    },
    whatToBring: strArr(o, "whatToBring"),
    pricingModel: o.pricingModel !== undefined
      ? inEnum("package.specs", SIGHTSEEING_PRICING_MODELS, o.pricingModel, "pricingModel")
      : undefined,
    pricing: {
      adult: optNum(pricing, "adult"),
      child: optNum(pricing, "child"),
      infant: optNum(pricing, "infant"),
      groupPrice: optNum(pricing, "groupPrice"),
    },
    availableDays,
    timeSlots: strArr(o, "timeSlots"),
    blackoutDates,
    cancellationPolicy: o.cancellationPolicy !== undefined
      ? inEnum("package.specs", SERVICE_CANCELLATION_POLICIES, o.cancellationPolicy, "cancellationPolicy")
      : undefined,
    bookingCutoffHours: optNum(o, "bookingCutoffHours"),
    languages: strArr(o, "languages"),
    accessibility: strArr(o, "accessibility"),
    termsAndConditions: optStr(o, "termsAndConditions"),
    videoUrl: optStr(o, "videoUrl"),
  };
}

export function validatePackage(input: PackageRawInput): ValidatedPackage {
  const b = input.body;
  const kind = inEnum<PackageKind>("package", PACKAGE_KINDS, b.kind, "kind");
  const components = kind === "bundle" ? validateComponents(b.components) : [];
  if (kind === "bundle" && components.length === 0) {
    fail("package", "a bundle must include at least one component");
  }
  const scope = b.scope === undefined || b.scope === ""
    ? ("domestic" as PackageScope)
    : inEnum<PackageScope>("package", PACKAGE_SCOPES, b.scope, "scope");
  const title = reqStr("package", b, "title");
  const currency = b.currency === undefined || b.currency === ""
    ? ("INR" as CurrencyCode)
    : inEnum<CurrencyCode>("package", CURRENCY_CODES, b.currency, "currency");

  const images = input.imageUrls.map((url, i) => ({ url, isPrimary: i === 0 }));

  // Location is scope-exclusive: a domestic listing is placed by Indian state, an
  // international one by country + region. Each side is dropped for the other scope
  // so a listing flipped from domestic to international (or back) can't keep a stale
  // location — the browse-by-state/country surfaces filter on these fields directly.
  const stateRaw = optStr(b, "state");
  const state = stateRaw !== undefined ? inEnum("package", INDIAN_STATES, stateRaw, "state") : undefined;
  const countryRaw = optStr(b, "country");
  const country = countryRaw !== undefined
    ? inEnum("package", INTERNATIONAL_COUNTRIES, countryRaw, "country")
    : undefined;

  return {
    kind,
    scope,
    title,
    thumbnail: optStr(b, "thumbnail") ?? images[0]?.url,
    description: optStr(b, "description"),
    highlights: strArr(b, "highlights"),
    tags: strArr(b, "tags"),
    state: scope === "domestic" ? state : undefined,
    country: scope === "international" ? country : undefined,
    region: scope === "international" ? optStr(b, "region") : undefined,
    route: validateRoute(b.route),
    itinerary: validateItinerary(b.itinerary),
    components,
    inclusions: strArr(b, "inclusions"),
    exclusions: strArr(b, "exclusions"),
    specs: kind === "sightseeing" ? validateSightseeingSpecs(b.specs) : isObject(b.specs) ? b.specs : {},
    referencePrice: optNum(b, "referencePrice"),
    currency,
    images,
  };
}

// ── Operator offer ───────────────────────────────────────────────────────────
export type ValidatedOffer = Pick<
  IPackageOffer,
  | "price"
  | "currency"
  | "perPerson"
  | "pricingNote"
  | "notes"
  | "inclusionsOverride"
  | "directContact"
  | "showDirectContact"
>;

function validateContact(raw: unknown): OfferContact | undefined {
  if (!isObject(raw)) return undefined;
  const c: OfferContact = {
    name: optStr(raw, "name"),
    businessName: optStr(raw, "businessName"),
    phone: optStr(raw, "phone"),
    email: optStr(raw, "email"),
    whatsapp: optStr(raw, "whatsapp"),
  };
  return Object.values(c).some((v) => v !== undefined) ? c : undefined;
}

export function validateOffer(raw: unknown): ValidatedOffer {
  const b = isObject(raw) ? raw : {};
  const price = optNum(b, "price");
  if (price === undefined || price < 0) fail("offer", "price is required and must be ≥ 0");
  const currency = b.currency === undefined || b.currency === ""
    ? ("INR" as CurrencyCode)
    : inEnum<CurrencyCode>("offer", CURRENCY_CODES, b.currency, "currency");
  return {
    price,
    currency,
    perPerson: b.perPerson === undefined ? true : b.perPerson === true || b.perPerson === "true",
    pricingNote: optStr(b, "pricingNote"),
    notes: optStr(b, "notes"),
    inclusionsOverride: strArr(b, "inclusionsOverride"),
    directContact: validateContact(b.directContact),
    showDirectContact: b.showDirectContact === true || b.showDirectContact === "true",
  };
}

// ── Customer enquiry ─────────────────────────────────────────────────────────
export interface ValidatedEnquiry {
  contact: EnquiryContact;
  travelDate?: Date;
  pax: EnquiryPax;
  message?: string;
}

export function validateEnquiry(raw: unknown): ValidatedEnquiry {
  const b = isObject(raw) ? raw : {};
  const contactRaw = isObject(b.contact) ? b.contact : b; // accept flat or nested
  const contact: EnquiryContact = {
    name: reqStr("enquiry", contactRaw, "name"),
    phone: reqStr("enquiry", contactRaw, "phone"),
    email: optStr(contactRaw, "email"),
  };
  let travelDate: Date | undefined;
  if (typeof b.travelDate === "string" && b.travelDate.trim()) {
    const d = new Date(b.travelDate);
    if (!Number.isNaN(d.getTime())) travelDate = d;
  }
  const paxRaw = isObject(b.pax) ? b.pax : {};
  const pax: EnquiryPax = {
    adults: Math.max(0, optNum(paxRaw, "adults") ?? 1),
    children: Math.max(0, optNum(paxRaw, "children") ?? 0),
    infants: Math.max(0, optNum(paxRaw, "infants") ?? 0),
  };
  return { contact, travelDate, pax, message: optStr(b, "message") };
}
