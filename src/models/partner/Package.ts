import { Schema, model, Types, HydratedDocument } from "mongoose";
import {
  RESOURCE_STATUS,
  PACKAGE_KINDS,
  PACKAGE_SCOPES,
  PACKAGE_ORIGINS,
  CURRENCY_CODES,
  LISTING_REF_MODELS,
  type ResourceStatus,
  type PackageKind,
  type PackageScope,
  type PackageOrigin,
  type CurrencyCode,
  type ListingRefModel,
} from "./_shared/enums";
import { ImageSchema, type Image } from "./_shared/subdocs";
import { attachSlug } from "./_shared/schemaHelpers";

// Marketplace Package — the shared catalog item (definition only; pricing lives on
// PackageOffer). Authored by the platform as a fixed template (origin "platform")
// or by a partner as a custom package (origin "partner", `author` set). One unified
// model typed by `kind` + `scope` covering taxi / taxi_package / tour / tour_package
// / holiday. Reuses the itinerary/route/Image shapes from TourPackage.ts.

export interface PackageItineraryDay {
  day: number;
  title?: string;
  description?: string;
  meals: { breakfast: boolean; lunch: boolean; dinner: boolean };
  accommodation?: string;
  activities: string[];
}

export interface PackageRoute {
  origin?: string;
  destinations: string[];
  durationDays: number;
  durationNights: number;
}

// One piece of a composite bundle (kind "bundle"). `ref`/`refModel` link to one of
// the partner's real listings (a TaxiListing, HotelListing, …); a free-form piece
// omits both. `title` is a snapshot so the bundle reads correctly even if the source
// listing later changes. `included` = bundled into the price vs an optional add-on.
export interface PackageComponent {
  category: string; // display grouping, e.g. "Stay", "Transfer", "Sightseeing"
  refModel?: ListingRefModel;
  ref?: Types.ObjectId;
  title: string;
  description?: string;
  quantity: number;
  included: boolean;
}

export interface IPackage {
  kind: PackageKind;
  scope: PackageScope;
  origin: PackageOrigin;
  author?: Types.ObjectId; // the partner who created it (origin "partner")
  status: ResourceStatus;
  title: string;
  slug: string;
  thumbnail?: string;
  images: Image[];
  description?: string;
  highlights: string[];
  tags: string[];
  route: PackageRoute;
  itinerary: PackageItineraryDay[];
  components: PackageComponent[]; // populated only for kind "bundle"
  inclusions: string[];
  exclusions: string[];
  // Small per-kind spec block (vehicleType/seating for taxi; languages/maxGroupSize
  // for tour; packageType/difficulty for holiday/tour_package). Kept loose on purpose
  // so each vertical can carry its own fields without a schema change.
  specs: Record<string, unknown>;
  referencePrice?: number; // indicative only — authoritative price is on offers
  currency: CurrencyCode;
  createdAt: Date;
  updatedAt: Date;
}

const itinerarySchema = new Schema<PackageItineraryDay>(
  {
    day: { type: Number, required: [true, "itinerary day is required"], min: [1, "day must be at least 1"] },
    title: { type: String, trim: true },
    description: { type: String, trim: true },
    meals: {
      breakfast: { type: Boolean, default: false },
      lunch: { type: Boolean, default: false },
      dinner: { type: Boolean, default: false },
    },
    accommodation: { type: String, trim: true },
    activities: { type: [String], default: [] },
  },
  { _id: false },
);

const componentSchema = new Schema<PackageComponent>(
  {
    category: { type: String, required: [true, "component category is required"], trim: true },
    refModel: { type: String, enum: LISTING_REF_MODELS },
    ref: { type: Schema.Types.ObjectId, refPath: "components.refModel" },
    title: { type: String, required: [true, "component title is required"], trim: true },
    description: { type: String, trim: true },
    quantity: { type: Number, default: 1, min: [1, "quantity must be at least 1"] },
    included: { type: Boolean, default: true },
  },
  { _id: false },
);

const packageSchema = new Schema<IPackage>(
  {
    kind: { type: String, enum: PACKAGE_KINDS, required: [true, "kind is required"], index: true },
    scope: { type: String, enum: PACKAGE_SCOPES, default: "domestic", index: true },
    origin: { type: String, enum: PACKAGE_ORIGINS, required: [true, "origin is required"], index: true },
    author: { type: Schema.Types.ObjectId, ref: "User", index: true },
    status: { type: String, enum: RESOURCE_STATUS, default: "draft", index: true },
    title: { type: String, required: [true, "title is required"], trim: true },
    slug: { type: String, unique: true, lowercase: true, trim: true },
    thumbnail: { type: String, trim: true },
    images: { type: [ImageSchema], default: [] },
    description: { type: String, maxlength: [4000, "description cannot exceed 4000 chars"], trim: true },
    highlights: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    route: {
      origin: { type: String, trim: true },
      destinations: { type: [String], default: [] },
      durationDays: { type: Number, default: 1, min: [0, "durationDays cannot be negative"] },
      durationNights: { type: Number, default: 0, min: [0, "durationNights cannot be negative"] },
    },
    itinerary: { type: [itinerarySchema], default: [] },
    components: { type: [componentSchema], default: [] },
    inclusions: { type: [String], default: [] },
    exclusions: { type: [String], default: [] },
    specs: { type: Schema.Types.Mixed, default: {} },
    referencePrice: { type: Number, min: [0, "referencePrice cannot be negative"] },
    currency: { type: String, enum: CURRENCY_CODES, default: "INR" },
  },
  { timestamps: true, strict: true },
);

// ── Indexes ──────────────────────────────────────────────────────────────────
packageSchema.index({ kind: 1, scope: 1, status: 1 });
packageSchema.index({ origin: 1, status: 1 });
packageSchema.index({ author: 1, status: 1 });
packageSchema.index({ title: "text", "route.destinations": "text", tags: "text" });

attachSlug(packageSchema, (doc) => String(doc.title ?? ""), "package");
packageSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type PackageDoc = HydratedDocument<IPackage>;
export const PackageModel = model<IPackage>("Package", packageSchema);
