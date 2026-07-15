import { Schema, model, Types, HydratedDocument } from "mongoose";
import { randomBytes } from "crypto";
import {
  RESOURCE_STATUS,
  CURRENCY_CODES,
  PACKAGE_TYPES,
  DEPARTURE_STATUS,
  HOLIDAY_ROOM_TYPES,
  HOLIDAY_MEAL_PLANS,
  INDIAN_STATES,
  type ResourceStatus,
  type CurrencyCode,
  type PackageType,
  type DepartureStatus,
  type HolidayRoomType,
  type HolidayMealPlan,
  type IndianState,
} from "./_shared/enums";
import { ImageSchema, type Image } from "./_shared/subdocs";

// HolidayPackage — a first-class, itinerary-driven multi-day holiday package,
// priced by room category the way real OTAs (MakeMyTrip, Yatra, Cleartrip) do:
// one listing carries several room-tier price rows (Standard/Deluxe/Luxury ×
// meal plan) rather than one flat price. Mirrors TourPackage.ts in every other
// respect (itinerary, includes, discounts, departures) — the room-tier pricing
// block is the only structural difference. Stored in its own `holidaypackages`
// collection. Distinct from the marketplace "holiday" tie-up (Package.ts,
// hotel + taxi-package auto-bundle) — that stays as the quick auto-priced path;
// this is for a partner manually authoring a full package.

export interface HolidayPackageItineraryLocation {
  lat: number;
  lng: number;
  address?: string;
}

export interface HolidayPackageItineraryDay {
  day: number;
  title?: string;
  description?: string;
  meals: { breakfast: boolean; lunch: boolean; dinner: boolean };
  accommodation?: string;
  activities: string[];
  location?: HolidayPackageItineraryLocation;
}

// One room-category price row — the core "refer to famous websites" addition.
export interface HolidayRoomTier {
  roomType: HolidayRoomType;
  mealPlan: HolidayMealPlan;
  price: number;
  maxOccupancy: number;
  childPrice?: number;
  extraBedPrice?: number;
}

export interface HolidayPackageDiscount {
  label: string;
  percent: number;
  validUntil?: Date;
}

export interface HolidayPackageDeparture {
  date: Date;
  seatsTotal?: number;
  seatsBooked: number;
  status: DepartureStatus;
}

export interface IHolidayPackage {
  partner: Types.ObjectId;
  status: ResourceStatus;
  title: string;
  slug: string;
  packageType: PackageType;
  thumbnail?: string;
  state?: IndianState;
  route: {
    origin?: string;
    // Pin-dropped start/end of the route — optional so the customer route map can
    // run origin → itinerary stops → destination; older packages only have names.
    originLocation?: HolidayPackageItineraryLocation;
    destinations: string[];
    destinationLocation?: HolidayPackageItineraryLocation;
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
  itinerary: HolidayPackageItineraryDay[];
  roomTiers: HolidayRoomTier[];
  currency: CurrencyCode;
  singleSupplement?: number;
  discounts: HolidayPackageDiscount[];
  departures: HolidayPackageDeparture[];
  images: Image[];
  videoUrl?: string;
  description?: string;
  highlights: string[];
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

const itineraryLocationSchema = new Schema<HolidayPackageItineraryLocation>(
  {
    lat: { type: Number, required: [true, "location.lat is required"], min: -90, max: 90 },
    lng: { type: Number, required: [true, "location.lng is required"], min: -180, max: 180 },
    address: { type: String, trim: true },
  },
  { _id: false },
);

const itinerarySchema = new Schema<HolidayPackageItineraryDay>(
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
    location: { type: itineraryLocationSchema, default: undefined },
  },
  { _id: false },
);

const roomTierSchema = new Schema<HolidayRoomTier>(
  {
    roomType: { type: String, enum: HOLIDAY_ROOM_TYPES, required: [true, "roomTier.roomType is required"] },
    mealPlan: { type: String, enum: HOLIDAY_MEAL_PLANS, default: "breakfast" },
    price: { type: Number, required: [true, "roomTier.price is required"], min: [0, "price cannot be negative"] },
    maxOccupancy: { type: Number, default: 2, min: [1, "maxOccupancy must be at least 1"] },
    childPrice: { type: Number, min: [0, "childPrice cannot be negative"] },
    extraBedPrice: { type: Number, min: [0, "extraBedPrice cannot be negative"] },
  },
  { _id: false },
);

const discountSchema = new Schema<HolidayPackageDiscount>(
  {
    label: { type: String, required: [true, "discount label is required"], trim: true },
    percent: { type: Number, required: [true, "discount percent is required"], min: [0, "percent cannot be negative"], max: [100, "percent cannot exceed 100"] },
    validUntil: { type: Date },
  },
  { _id: false },
);

const departureSchema = new Schema<HolidayPackageDeparture>(
  {
    date: { type: Date, required: [true, "departure date is required"] },
    seatsTotal: { type: Number, min: [0, "seatsTotal cannot be negative"] },
    seatsBooked: { type: Number, default: 0, min: [0, "seatsBooked cannot be negative"] },
    status: { type: String, enum: DEPARTURE_STATUS, default: "open" },
  },
  { _id: false },
);

const holidayPackageSchema = new Schema<IHolidayPackage>(
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
    state: { type: String, enum: INDIAN_STATES, index: true },
    route: {
      origin: { type: String, trim: true },
      originLocation: { type: itineraryLocationSchema, default: undefined },
      destinationLocation: { type: itineraryLocationSchema, default: undefined },
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
    roomTiers: {
      type: [roomTierSchema],
      default: [],
      validate: {
        validator: (v: HolidayRoomTier[]) => v.length > 0,
        message: "at least one room tier is required",
      },
    },
    currency: { type: String, enum: CURRENCY_CODES, default: "INR" },
    singleSupplement: { type: Number, min: [0, "singleSupplement cannot be negative"] },
    discounts: { type: [discountSchema], default: [] },
    departures: { type: [departureSchema], default: [] },
    images: { type: [ImageSchema], default: [] },
    videoUrl: { type: String, trim: true },
    description: { type: String, maxlength: [3000, "description cannot exceed 3000 chars"], trim: true },
    highlights: { type: [String], default: [] },
    tags: { type: [String], default: [] },
  },
  { timestamps: true, strict: true },
);

// ── Indexes ──────────────────────────────────────────────────────────────────
holidayPackageSchema.index({ "route.destinations": 1, packageType: 1, status: 1 });
holidayPackageSchema.index({ partner: 1, status: 1 });
holidayPackageSchema.index({ createdAt: -1 });

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

holidayPackageSchema.pre("validate", function (next) {
  if (!this.slug && this.title) {
    const base = slugify(this.title) || "holiday-package";
    this.slug = `${base}-${randomBytes(3).toString("hex")}`;
  }
  next();
});

holidayPackageSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type HolidayPackageDoc = HydratedDocument<IHolidayPackage>;
export const HolidayPackageModel = model<IHolidayPackage>("HolidayPackage", holidayPackageSchema);
