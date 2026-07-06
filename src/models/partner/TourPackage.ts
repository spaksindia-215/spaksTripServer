import { Schema, model, Types, HydratedDocument } from "mongoose";
import { randomBytes } from "crypto";
import {
  RESOURCE_STATUS,
  CURRENCY_CODES,
  PACKAGE_TYPES,
  DEPARTURE_STATUS,
  DIFFICULTY_LEVELS,
  type ResourceStatus,
  type CurrencyCode,
  type PackageType,
  type DepartureStatus,
  type DifficultyLevel,
} from "./_shared/enums";
import { ImageSchema, type Image } from "./_shared/subdocs";

// CLAUDE.md Model 5 — TourPackage. Bundled multi-day holiday packages (FIT or
// group) that optionally reference the partner's own taxi/hotel/tour listings.
// Stored in its own `tourpackages` collection, replacing the legacy
// mixed-metadata `tour_package` PartnerResource.

export interface TourPackageItineraryDay {
  day: number;
  title?: string;
  description?: string;
  meals: { breakfast: boolean; lunch: boolean; dinner: boolean };
  accommodation?: string;
  activities: string[];
}

export interface TourPackageDiscount {
  label: string;
  percent: number;
  validUntil?: Date;
}

export interface TourPackageDeparture {
  date: Date;
  seatsTotal?: number;
  seatsBooked: number;
  status: DepartureStatus;
}

export interface ITourPackage {
  partner: Types.ObjectId;
  status: ResourceStatus;
  title: string;
  slug: string;
  packageType: PackageType;
  thumbnail?: string;
  route: {
    origin?: string;
    destinations: string[];
    durationDays: number;
    durationNights: number;
  };
  includes: {
    taxi?: Types.ObjectId;
    hotels: Types.ObjectId[];
    tours: Types.ObjectId[];
  };
  customInclusions: string[];
  exclusions: string[];
  itinerary: TourPackageItineraryDay[];
  pricing: {
    basePrice: number;
    currency: CurrencyCode;
    perPerson: boolean;
    maxPersons?: number;
    childPrice?: number;
    infantPrice: number;
    extraPersonCharge?: number;
    singleSupplement?: number;
    discounts: TourPackageDiscount[];
  };
  departures: TourPackageDeparture[];
  images: Image[];
  videoUrl?: string;
  description?: string;
  highlights: string[];
  tags: string[];
  difficultyLevel?: DifficultyLevel;
  createdAt: Date;
  updatedAt: Date;
}

const itinerarySchema = new Schema<TourPackageItineraryDay>(
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

const discountSchema = new Schema<TourPackageDiscount>(
  {
    label: { type: String, required: [true, "discount label is required"], trim: true },
    percent: { type: Number, required: [true, "discount percent is required"], min: [0, "percent cannot be negative"], max: [100, "percent cannot exceed 100"] },
    validUntil: { type: Date },
  },
  { _id: false },
);

const departureSchema = new Schema<TourPackageDeparture>(
  {
    date: { type: Date, required: [true, "departure date is required"] },
    seatsTotal: { type: Number, min: [0, "seatsTotal cannot be negative"] },
    seatsBooked: { type: Number, default: 0, min: [0, "seatsBooked cannot be negative"] },
    status: { type: String, enum: DEPARTURE_STATUS, default: "open" },
  },
  { _id: false },
);

const tourPackageSchema = new Schema<ITourPackage>(
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
    packageType: { type: String, enum: PACKAGE_TYPES, required: [true, "packageType is required"] },
    thumbnail: { type: String, trim: true },
    route: {
      origin: { type: String, trim: true },
      destinations: {
        type: [String],
        default: [],
        validate: {
          validator: (v: string[]) => v.length > 0,
          message: "at least one destination is required",
        },
      },
      durationDays: { type: Number, required: [true, "route.durationDays is required"], min: [1, "durationDays must be at least 1"] },
      durationNights: { type: Number, required: [true, "route.durationNights is required"], min: [0, "durationNights cannot be negative"] },
    },
    includes: {
      taxi: { type: Schema.Types.ObjectId, ref: "TaxiListing" },
      hotels: { type: [{ type: Schema.Types.ObjectId, ref: "HotelListing" }], default: [] },
      tours: { type: [{ type: Schema.Types.ObjectId, ref: "TourListing" }], default: [] },
    },
    customInclusions: { type: [String], default: [] },
    exclusions: { type: [String], default: [] },
    itinerary: { type: [itinerarySchema], default: [] },
    pricing: {
      basePrice: { type: Number, required: [true, "pricing.basePrice is required"], min: [0, "basePrice cannot be negative"] },
      currency: { type: String, enum: CURRENCY_CODES, default: "INR" },
      perPerson: { type: Boolean, default: true },
      maxPersons: { type: Number, min: [1, "maxPersons must be at least 1"] },
      childPrice: { type: Number, min: [0, "childPrice cannot be negative"] },
      infantPrice: { type: Number, default: 0, min: [0, "infantPrice cannot be negative"] },
      extraPersonCharge: { type: Number, min: [0, "extraPersonCharge cannot be negative"] },
      singleSupplement: { type: Number, min: [0, "singleSupplement cannot be negative"] },
      discounts: { type: [discountSchema], default: [] },
    },
    departures: { type: [departureSchema], default: [] },
    images: { type: [ImageSchema], default: [] },
    videoUrl: { type: String, trim: true },
    description: { type: String, maxlength: [3000, "description cannot exceed 3000 chars"], trim: true },
    highlights: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    difficultyLevel: { type: String, enum: DIFFICULTY_LEVELS },
  },
  { timestamps: true, strict: true },
);

// ── Indexes (CLAUDE.md Step 9) ───────────────────────────────────────────────
tourPackageSchema.index({ "route.destinations": 1, packageType: 1, status: 1 });
tourPackageSchema.index({ partner: 1, status: 1 });
tourPackageSchema.index({ createdAt: -1 });

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

tourPackageSchema.pre("validate", function (next) {
  if (!this.slug && this.title) {
    const base = slugify(this.title) || "tour-package";
    this.slug = `${base}-${randomBytes(3).toString("hex")}`;
  }
  next();
});

tourPackageSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type TourPackageDoc = HydratedDocument<ITourPackage>;
export const TourPackageModel = model<ITourPackage>("TourPackage", tourPackageSchema);
