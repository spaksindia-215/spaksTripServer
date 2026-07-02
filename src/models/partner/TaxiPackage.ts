import { Schema, model, Types, HydratedDocument } from "mongoose";
import { randomBytes } from "crypto";
import {
  RESOURCE_STATUS,
  CURRENCY_CODES,
  type ResourceStatus,
  type CurrencyCode,
} from "./_shared/enums";
import { ImageSchema, type Image } from "./_shared/subdocs";

// CLAUDE.md Model 3 — TaxiPackage. Fixed-route multi-day cab bundles
// (e.g. "Delhi–Shimla–Manali 6D/5N in Innova Crysta"). Optionally links to one
// of the partner's TaxiListings (ref) and denormalizes a vehicleSnapshot so the
// package renders even if the underlying listing changes. Stored in its own
// `taxipackages` collection.

export interface TaxiPackageVehicleSnapshot {
  make?: string;
  model?: string;
  type?: string;
  seatingCap?: number;
  images: string[];
}

export interface TaxiPackageItineraryDay {
  day: number;
  title?: string;
  description?: string;
  activities: string[];
  distance?: number;
  overnight?: string;
}

export interface ITaxiPackage {
  partner: Types.ObjectId;
  status: ResourceStatus;
  title: string;
  slug: string;
  thumbnail?: string;
  route: {
    origin: string;
    destinations: string[];
    totalKm?: number;
    durationDays: number;
    durationNights: number;
  };
  vehicle?: Types.ObjectId;
  vehicleSnapshot?: TaxiPackageVehicleSnapshot;
  itinerary: TaxiPackageItineraryDay[];
  pricing: {
    basePrice: number;
    currency: CurrencyCode;
    maxPersons?: number;
    extraPersonCharge?: number;
    tollsIncluded: boolean;
    driverAllowance: boolean;
    fuelIncluded: boolean;
  };
  inclusions: string[];
  exclusions: string[];
  startDates: Date[];
  blackoutDates: Date[];
  advanceBookingDays: number;
  images: Image[];
  description?: string;
  highlights: string[];
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

const vehicleSnapshotSchema = new Schema<TaxiPackageVehicleSnapshot>(
  {
    make: { type: String, trim: true },
    model: { type: String, trim: true },
    type: { type: String, trim: true },
    seatingCap: { type: Number, min: [1, "seatingCap must be at least 1"] },
    images: { type: [String], default: [] },
  },
  { _id: false },
);

const itinerarySchema = new Schema<TaxiPackageItineraryDay>(
  {
    day: { type: Number, required: [true, "itinerary day is required"], min: [1, "day must be at least 1"] },
    title: { type: String, trim: true },
    description: { type: String, trim: true },
    activities: { type: [String], default: [] },
    distance: { type: Number, min: [0, "distance cannot be negative"] },
    overnight: { type: String, trim: true },
  },
  { _id: false },
);

const taxiPackageSchema = new Schema<ITaxiPackage>(
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
    thumbnail: { type: String, trim: true },
    route: {
      origin: { type: String, required: [true, "route.origin is required"], trim: true },
      destinations: {
        type: [String],
        default: [],
        validate: {
          validator: (v: string[]) => v.length > 0,
          message: "at least one destination is required",
        },
      },
      totalKm: { type: Number, min: [0, "totalKm cannot be negative"] },
      durationDays: { type: Number, required: [true, "route.durationDays is required"], min: [1, "durationDays must be at least 1"] },
      durationNights: { type: Number, required: [true, "route.durationNights is required"], min: [0, "durationNights cannot be negative"] },
    },
    vehicle: { type: Schema.Types.ObjectId, ref: "TaxiListing" },
    vehicleSnapshot: { type: vehicleSnapshotSchema, default: undefined },
    itinerary: { type: [itinerarySchema], default: [] },
    pricing: {
      basePrice: {
        type: Number,
        required: [true, "pricing.basePrice is required"],
        min: [0, "basePrice cannot be negative"],
      },
      currency: { type: String, enum: CURRENCY_CODES, default: "INR" },
      maxPersons: { type: Number, min: [1, "maxPersons must be at least 1"] },
      extraPersonCharge: { type: Number, min: [0, "extraPersonCharge cannot be negative"] },
      tollsIncluded: { type: Boolean, default: false },
      driverAllowance: { type: Boolean, default: true },
      fuelIncluded: { type: Boolean, default: true },
    },
    inclusions: { type: [String], default: [] },
    exclusions: { type: [String], default: [] },
    startDates: { type: [Date], default: [] },
    blackoutDates: { type: [Date], default: [] },
    advanceBookingDays: { type: Number, default: 3, min: [0, "advanceBookingDays cannot be negative"] },
    images: { type: [ImageSchema], default: [] },
    description: { type: String, maxlength: [2000, "description cannot exceed 2000 chars"], trim: true },
    highlights: { type: [String], default: [] },
    tags: { type: [String], default: [] },
  },
  { timestamps: true, strict: true },
);

// ── Indexes (CLAUDE.md Step 9) ───────────────────────────────────────────────
taxiPackageSchema.index({ "route.origin": 1, "route.destinations": 1, status: 1 });
taxiPackageSchema.index({ partner: 1, status: 1 });
taxiPackageSchema.index({ createdAt: -1 });

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

taxiPackageSchema.pre("validate", function (next) {
  if (!this.slug && this.title) {
    const base = slugify(this.title) || "taxi-package";
    this.slug = `${base}-${randomBytes(3).toString("hex")}`;
  }
  next();
});

taxiPackageSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type TaxiPackageDoc = HydratedDocument<ITaxiPackage>;
export const TaxiPackageModel = model<ITaxiPackage>("TaxiPackage", taxiPackageSchema);
