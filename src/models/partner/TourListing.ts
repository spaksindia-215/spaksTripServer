import { Schema, model, Types, HydratedDocument } from "mongoose";
import { randomBytes } from "crypto";
import {
  RESOURCE_STATUS,
  CURRENCY_CODES,
  TOUR_CATEGORIES,
  OPERATING_DAYS,
  type ResourceStatus,
  type CurrencyCode,
  type TourCategory,
  type OperatingDay,
} from "./_shared/enums";
import { ImageSchema, CoordinateSchema, type Image, type GeoPoint } from "./_shared/subdocs";

// CLAUDE.md Model 4 — TourListing. Single- or multi-day guided tours listed by a
// partner (e.g. "Jaipur City Tour by AC Coach"). Pricing is a set of tiers
// (Adult/Child/Infant…). Stored in its own `tourlistings` collection, replacing
// the legacy mixed-metadata `tour` PartnerResource.

export interface TourItineraryStop {
  time?: string;
  title?: string;
  description?: string;
  location?: string;
}

export interface TourPricingTier {
  label: string;
  price: number;
  currency: CurrencyCode;
  minAge?: number;
  maxAge?: number;
}

export interface TourPickupPoint {
  name?: string;
  time?: string;
  coordinates?: GeoPoint;
}

export interface ITourListing {
  partner: Types.ObjectId;
  status: ResourceStatus;
  title: string;
  slug: string;
  category: TourCategory;
  basedIn: string;
  coversCities: string[];
  coordinates?: GeoPoint;
  durationHours?: number;
  durationDays?: number;
  durationNights?: number;
  itinerary: TourItineraryStop[];
  pricing: TourPricingTier[];
  minGroupSize: number;
  maxGroupSize?: number;
  privateAvailable: boolean;
  privatePrice?: number;
  inclusions: string[];
  exclusions: string[];
  pickupIncluded: boolean;
  pickupPoints: TourPickupPoint[];
  operatingDays: OperatingDay[];
  startTimes: string[];
  advanceBookingHrs: number;
  blackoutDates: Date[];
  images: Image[];
  videoUrl?: string;
  description?: string;
  highlights: string[];
  tags: string[];
  languages: string[];
  createdAt: Date;
  updatedAt: Date;
}

const itinerarySchema = new Schema<TourItineraryStop>(
  {
    time: { type: String, trim: true },
    title: { type: String, trim: true },
    description: { type: String, trim: true },
    location: { type: String, trim: true },
  },
  { _id: false },
);

const pricingTierSchema = new Schema<TourPricingTier>(
  {
    label: { type: String, required: [true, "pricing tier label is required"], trim: true },
    price: { type: Number, required: [true, "pricing tier price is required"], min: [0, "price cannot be negative"] },
    currency: { type: String, enum: CURRENCY_CODES, default: "INR" },
    minAge: { type: Number, min: [0, "minAge cannot be negative"] },
    maxAge: { type: Number, min: [0, "maxAge cannot be negative"] },
  },
  { _id: false },
);

const pickupPointSchema = new Schema<TourPickupPoint>(
  {
    name: { type: String, trim: true },
    time: { type: String, trim: true },
    coordinates: { type: CoordinateSchema, default: undefined },
  },
  { _id: false },
);

const tourListingSchema = new Schema<ITourListing>(
  {
    partner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
      default: null,
    },
    status: { type: String, enum: RESOURCE_STATUS, default: "draft", index: true },
    title: { type: String, required: [true, "title is required"], trim: true },
    slug: { type: String, unique: true, lowercase: true, trim: true },
    category: { type: String, enum: TOUR_CATEGORIES, required: [true, "category is required"] },
    basedIn: { type: String, required: [true, "basedIn is required"], trim: true },
    coversCities: { type: [String], default: [] },
    coordinates: { type: CoordinateSchema, default: undefined },
    durationHours: { type: Number, min: [0, "durationHours cannot be negative"] },
    durationDays: { type: Number, min: [0, "durationDays cannot be negative"] },
    durationNights: { type: Number, min: [0, "durationNights cannot be negative"] },
    itinerary: { type: [itinerarySchema], default: [] },
    pricing: {
      type: [pricingTierSchema],
      default: [],
      validate: {
        validator: (v: TourPricingTier[]) => v.length > 0,
        message: "at least one pricing tier is required",
      },
    },
    minGroupSize: { type: Number, default: 1, min: [1, "minGroupSize must be at least 1"] },
    maxGroupSize: { type: Number, min: [1, "maxGroupSize must be at least 1"] },
    privateAvailable: { type: Boolean, default: false },
    privatePrice: { type: Number, min: [0, "privatePrice cannot be negative"] },
    inclusions: { type: [String], default: [] },
    exclusions: { type: [String], default: [] },
    pickupIncluded: { type: Boolean, default: false },
    pickupPoints: { type: [pickupPointSchema], default: [] },
    operatingDays: { type: [{ type: String, enum: OPERATING_DAYS }], default: [] },
    startTimes: { type: [String], default: [] },
    advanceBookingHrs: { type: Number, default: 12, min: [0, "advanceBookingHrs cannot be negative"] },
    blackoutDates: { type: [Date], default: [] },
    images: { type: [ImageSchema], default: [] },
    videoUrl: { type: String, trim: true },
    description: { type: String, maxlength: [2000, "description cannot exceed 2000 chars"], trim: true },
    highlights: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    languages: { type: [String], default: [] },
  },
  { timestamps: true, strict: true },
);

// ── Indexes (CLAUDE.md Step 9) ───────────────────────────────────────────────
tourListingSchema.index({ basedIn: 1, category: 1, status: 1 });
tourListingSchema.index({ coordinates: "2dsphere" });
tourListingSchema.index({ partner: 1, status: 1 });
tourListingSchema.index({ createdAt: -1 });

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

tourListingSchema.pre("validate", function (next) {
  if (!this.slug && this.title) {
    const base = slugify(this.title) || "tour";
    this.slug = `${base}-${randomBytes(3).toString("hex")}`;
  }
  next();
});

tourListingSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type TourListingDoc = HydratedDocument<ITourListing>;
export const TourListingModel = model<ITourListing>("TourListing", tourListingSchema);
