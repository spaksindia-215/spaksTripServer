import { Schema, model, Types, HydratedDocument } from "mongoose";
import { randomBytes } from "crypto";
import {
  RESOURCE_STATUS,
  CURRENCY_CODES,
  CRUISE_TYPES,
  CABIN_TYPES,
  CRUISE_DEPARTURE_STATUS,
  type ResourceStatus,
  type CurrencyCode,
  type CruiseType,
  type CabinType,
  type CruiseDepartureStatus,
} from "./_shared/enums";
import { ImageSchema, type Image } from "./_shared/subdocs";

// CLAUDE.md Model 6 — CruiseListing. Ship + cabin catalogue with route, stops,
// cabin types, departures, and policies. Stored in its own `cruiselistings`
// collection, replacing the legacy mixed-metadata `cruise` PartnerResource.

export interface CruiseStop {
  port?: string;
  arrivalTime?: string;
  departureTime?: string;
}

export interface CruiseCabin {
  type: CabinType;
  label?: string;
  maxOccupancy?: number;
  pricePerPerson: number;
  currency: CurrencyCode;
  totalCabins?: number;
  amenities: string[];
  images: string[];
  isRefundable: boolean;
}

export interface CruiseDepartureAvailability {
  cabinType: string;
  seatsLeft?: number;
}

export interface CruiseDeparture {
  date: Date;
  cabinAvailability: CruiseDepartureAvailability[];
  status: CruiseDepartureStatus;
}

export interface ICruiseListing {
  partner: Types.ObjectId;
  status: ResourceStatus;
  cruiseName: string;
  slug: string;
  cruiseType: CruiseType;
  vessel: {
    name?: string;
    operator?: string;
    totalDecks?: number;
    builtYear?: number;
    images: Image[];
  };
  route: {
    departurePort: string;
    arrivalPort?: string;
    stops: CruiseStop[];
    durationDays: number;
    durationNights?: number;
  };
  cabins: CruiseCabin[];
  shipAmenities: string[];
  diningOptions: string[];
  mealsIncluded: { breakfast: boolean; lunch: boolean; dinner: boolean };
  departures: CruiseDeparture[];
  cancellationPolicy: { freeCancelDays?: number; chargePercent?: number };
  boardingAge: { minAge?: number; maxAge?: number };
  description?: string;
  highlights: string[];
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

const stopSchema = new Schema<CruiseStop>(
  {
    port: { type: String, trim: true },
    arrivalTime: { type: String, trim: true },
    departureTime: { type: String, trim: true },
  },
  { _id: false },
);

const cabinSchema = new Schema<CruiseCabin>(
  {
    type: { type: String, enum: CABIN_TYPES, required: [true, "cabin.type is required"] },
    label: { type: String, trim: true },
    maxOccupancy: { type: Number, min: [1, "maxOccupancy must be at least 1"] },
    pricePerPerson: { type: Number, required: [true, "cabin.pricePerPerson is required"], min: [0, "pricePerPerson cannot be negative"] },
    currency: { type: String, enum: CURRENCY_CODES, default: "INR" },
    totalCabins: { type: Number, min: [0, "totalCabins cannot be negative"] },
    amenities: { type: [String], default: [] },
    images: { type: [String], default: [] },
    isRefundable: { type: Boolean, default: true },
  },
  { _id: false },
);

const departureAvailabilitySchema = new Schema<CruiseDepartureAvailability>(
  {
    cabinType: { type: String, trim: true },
    seatsLeft: { type: Number, min: [0, "seatsLeft cannot be negative"] },
  },
  { _id: false },
);

const departureSchema = new Schema<CruiseDeparture>(
  {
    date: { type: Date, required: [true, "departure date is required"] },
    cabinAvailability: { type: [departureAvailabilitySchema], default: [] },
    status: { type: String, enum: CRUISE_DEPARTURE_STATUS, default: "open" },
  },
  { _id: false },
);

const cruiseListingSchema = new Schema<ICruiseListing>(
  {
    partner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "partner is required"],
      index: true,
    },
    status: { type: String, enum: RESOURCE_STATUS, default: "draft", index: true },
    cruiseName: { type: String, required: [true, "cruiseName is required"], trim: true },
    slug: { type: String, unique: true, lowercase: true, trim: true },
    cruiseType: { type: String, enum: CRUISE_TYPES, required: [true, "cruiseType is required"] },
    vessel: {
      name: { type: String, trim: true },
      operator: { type: String, trim: true },
      totalDecks: { type: Number, min: [1, "totalDecks must be at least 1"] },
      builtYear: { type: Number, min: [1900, "builtYear too old"] },
      images: { type: [ImageSchema], default: [] },
    },
    route: {
      departurePort: { type: String, required: [true, "route.departurePort is required"], trim: true },
      arrivalPort: { type: String, trim: true },
      stops: { type: [stopSchema], default: [] },
      durationDays: { type: Number, required: [true, "route.durationDays is required"], min: [1, "durationDays must be at least 1"] },
      durationNights: { type: Number, min: [0, "durationNights cannot be negative"] },
    },
    cabins: {
      type: [cabinSchema],
      default: [],
      validate: {
        validator: (v: CruiseCabin[]) => v.length > 0,
        message: "at least one cabin type is required",
      },
    },
    shipAmenities: { type: [String], default: [] },
    diningOptions: { type: [String], default: [] },
    mealsIncluded: {
      breakfast: { type: Boolean, default: false },
      lunch: { type: Boolean, default: false },
      dinner: { type: Boolean, default: false },
    },
    departures: { type: [departureSchema], default: [] },
    cancellationPolicy: {
      freeCancelDays: { type: Number, min: [0, "freeCancelDays cannot be negative"] },
      chargePercent: { type: Number, min: [0, "chargePercent cannot be negative"], max: [100, "chargePercent cannot exceed 100"] },
    },
    boardingAge: {
      minAge: { type: Number, min: [0, "minAge cannot be negative"] },
      maxAge: { type: Number, min: [0, "maxAge cannot be negative"] },
    },
    description: { type: String, maxlength: [2000, "description cannot exceed 2000 chars"], trim: true },
    highlights: { type: [String], default: [] },
    tags: { type: [String], default: [] },
  },
  { timestamps: true, strict: true },
);

// ── Indexes (CLAUDE.md Step 9) ───────────────────────────────────────────────
cruiseListingSchema.index({ "route.departurePort": 1, "route.durationDays": 1, status: 1 });
cruiseListingSchema.index({ partner: 1, status: 1 });
cruiseListingSchema.index({ createdAt: -1 });

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

cruiseListingSchema.pre("validate", function (next) {
  if (!this.slug && this.cruiseName) {
    const base = slugify(this.cruiseName) || "cruise";
    this.slug = `${base}-${randomBytes(3).toString("hex")}`;
  }
  next();
});

cruiseListingSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type CruiseListingDoc = HydratedDocument<ICruiseListing>;
export const CruiseListingModel = model<ICruiseListing>("CruiseListing", cruiseListingSchema);
