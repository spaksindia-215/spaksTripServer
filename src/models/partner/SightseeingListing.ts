import { Schema, model, Types, HydratedDocument } from "mongoose";
import { randomBytes } from "crypto";
import {
  RESOURCE_STATUS,
  CURRENCY_CODES,
  OPERATING_DAYS,
  SIGHTSEEING_CATEGORIES,
  SIGHTSEEING_DIFFICULTY,
  SIGHTSEEING_PRICING_MODELS,
  SIGHTSEEING_DURATION_UNITS,
  SERVICE_CANCELLATION_POLICIES,
  type ResourceStatus,
  type CurrencyCode,
  type OperatingDay,
  type SightseeingCategory,
  type SightseeingDifficulty,
  type SightseeingPricingModel,
  type SightseeingDurationUnit,
  type ServiceCancellationPolicy,
} from "./_shared/enums";
import { ImageSchema, CoordinateSchema, type Image, type GeoPoint } from "./_shared/subdocs";

// SightseeingListing — a partner-listed tour / activity / attraction / experience
// (e.g. "Sunset Dolphin Cruise"). Closely mirrors TourListing; lives in its own
// `sightseeinglistings` collection and plugs into the shared moderation registry
// (draft → pending → active). Bookings are enquiry-first today (ServiceEnquiry),
// so there is no inventory/price-charge logic here yet.

export interface SightseeingLocation {
  address?: string;
  island?: string;
  coordinates?: GeoPoint;
}

export interface SightseeingMeetingPoint {
  instructions?: string;
  coordinates?: GeoPoint;
}

export interface SightseeingDuration {
  value?: number;
  unit: SightseeingDurationUnit;
}

export interface SightseeingPricing {
  adult?: number;
  child?: number;
  infant?: number;
  groupPrice?: number;
}

export interface SightseeingSeasonalPrice {
  startDate?: Date;
  endDate?: Date;
  adult?: number;
  child?: number;
  infant?: number;
  groupPrice?: number;
}

export interface ISightseeingListing {
  partner: Types.ObjectId;
  status: ResourceStatus;
  title: string;
  slug: string;
  category: SightseeingCategory;
  location: SightseeingLocation;
  meetingPoint: SightseeingMeetingPoint;
  description?: string;
  highlights: string[];
  duration: SightseeingDuration;
  difficulty?: SightseeingDifficulty;
  ageRestriction: { min?: number; max?: number };
  groupSize: { min: number; max?: number };
  inclusions: string[];
  exclusions: string[];
  whatToBring: string[];
  pricingModel: SightseeingPricingModel;
  currency: CurrencyCode;
  pricing: SightseeingPricing;
  seasonalPricing: SightseeingSeasonalPrice[];
  availableDays: OperatingDay[];
  timeSlots: string[];
  blackoutDates: Date[];
  cancellationPolicy: ServiceCancellationPolicy;
  bookingCutoffHours: number;
  languages: string[];
  accessibility: string[];
  termsAndConditions?: string;
  images: Image[];
  videoUrl?: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

const seasonalPriceSchema = new Schema<SightseeingSeasonalPrice>(
  {
    startDate: { type: Date },
    endDate: { type: Date },
    adult: { type: Number, min: [0, "price cannot be negative"] },
    child: { type: Number, min: [0, "price cannot be negative"] },
    infant: { type: Number, min: [0, "price cannot be negative"] },
    groupPrice: { type: Number, min: [0, "price cannot be negative"] },
  },
  { _id: false },
);

const sightseeingListingSchema = new Schema<ISightseeingListing>(
  {
    partner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "partner is required"],
      index: true,
    },
    status: { type: String, enum: RESOURCE_STATUS, default: "draft", index: true },
    title: { type: String, required: [true, "title is required"], trim: true },
    slug: { type: String, unique: true, lowercase: true, trim: true },
    category: { type: String, enum: SIGHTSEEING_CATEGORIES, required: [true, "category is required"] },
    location: {
      address: { type: String, trim: true },
      island: { type: String, trim: true },
      coordinates: { type: CoordinateSchema, default: undefined },
    },
    meetingPoint: {
      instructions: { type: String, trim: true },
      coordinates: { type: CoordinateSchema, default: undefined },
    },
    description: { type: String, maxlength: [4000, "description cannot exceed 4000 chars"], trim: true },
    highlights: { type: [String], default: [] },
    duration: {
      value: { type: Number, min: [0, "duration value cannot be negative"] },
      unit: { type: String, enum: SIGHTSEEING_DURATION_UNITS, default: "hours" },
    },
    difficulty: { type: String, enum: SIGHTSEEING_DIFFICULTY },
    ageRestriction: {
      min: { type: Number, min: [0, "minAge cannot be negative"] },
      max: { type: Number, min: [0, "maxAge cannot be negative"] },
    },
    groupSize: {
      min: { type: Number, default: 1, min: [1, "groupSize.min must be at least 1"] },
      max: { type: Number, min: [1, "groupSize.max must be at least 1"] },
    },
    inclusions: { type: [String], default: [] },
    exclusions: { type: [String], default: [] },
    whatToBring: { type: [String], default: [] },
    pricingModel: { type: String, enum: SIGHTSEEING_PRICING_MODELS, default: "per_person" },
    currency: { type: String, enum: CURRENCY_CODES, default: "INR" },
    pricing: {
      adult: { type: Number, min: [0, "price cannot be negative"] },
      child: { type: Number, min: [0, "price cannot be negative"] },
      infant: { type: Number, min: [0, "price cannot be negative"] },
      groupPrice: { type: Number, min: [0, "price cannot be negative"] },
    },
    seasonalPricing: { type: [seasonalPriceSchema], default: [] },
    availableDays: { type: [{ type: String, enum: OPERATING_DAYS }], default: [] },
    timeSlots: { type: [String], default: [] },
    blackoutDates: { type: [Date], default: [] },
    cancellationPolicy: { type: String, enum: SERVICE_CANCELLATION_POLICIES, default: "free_24h" },
    bookingCutoffHours: { type: Number, default: 6, min: [0, "bookingCutoffHours cannot be negative"] },
    languages: { type: [String], default: [] },
    accessibility: { type: [String], default: [] },
    termsAndConditions: { type: String, maxlength: [4000, "terms cannot exceed 4000 chars"], trim: true },
    images: { type: [ImageSchema], default: [] },
    videoUrl: { type: String, trim: true },
    tags: { type: [String], default: [] },
  },
  { timestamps: true, strict: true },
);

// ── Indexes ──────────────────────────────────────────────────────────────────
sightseeingListingSchema.index({ "location.island": 1, category: 1, status: 1 });
sightseeingListingSchema.index({ "location.coordinates": "2dsphere" });
sightseeingListingSchema.index({ partner: 1, status: 1 });
sightseeingListingSchema.index({ createdAt: -1 });
sightseeingListingSchema.index({ title: "text", description: "text", tags: "text" });

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

sightseeingListingSchema.pre("validate", function (next) {
  if (!this.slug && this.title) {
    const base = slugify(this.title) || "activity";
    this.slug = `${base}-${randomBytes(3).toString("hex")}`;
  }
  next();
});

sightseeingListingSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type SightseeingListingDoc = HydratedDocument<ISightseeingListing>;
export const SightseeingListingModel = model<ISightseeingListing>(
  "SightseeingListing",
  sightseeingListingSchema,
);
