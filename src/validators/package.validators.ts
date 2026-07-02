import { HttpError } from "../middleware/error";
import { Types } from "mongoose";
import {
  PACKAGE_KINDS,
  PACKAGE_SCOPES,
  CURRENCY_CODES,
  LISTING_REF_MODELS,
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

  return {
    kind,
    scope,
    title,
    thumbnail: optStr(b, "thumbnail") ?? images[0]?.url,
    description: optStr(b, "description"),
    highlights: strArr(b, "highlights"),
    tags: strArr(b, "tags"),
    route: validateRoute(b.route),
    itinerary: validateItinerary(b.itinerary),
    components,
    inclusions: strArr(b, "inclusions"),
    exclusions: strArr(b, "exclusions"),
    specs: isObject(b.specs) ? b.specs : {},
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
