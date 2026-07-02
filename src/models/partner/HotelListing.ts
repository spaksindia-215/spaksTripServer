import { Schema, model, Types, HydratedDocument } from "mongoose";
import { randomBytes } from "crypto";
import {
  RESOURCE_STATUS,
  CURRENCY_CODES,
  HOTEL_TYPES,
  HOTEL_MEAL_TYPES,
  HOTEL_DISCOUNT_TYPES,
  HOTEL_STAR_RATINGS,
  type ResourceStatus,
  type CurrencyCode,
  type HotelType,
  type HotelMealType,
  type HotelDiscountType,
  type HotelStarRating,
} from "./_shared/enums";
import { ImageSchema, CoordinateSchema, type Image, type GeoPoint } from "./_shared/subdocs";

// Typed, validated replacement for the hotel slice of the legacy mixed-metadata
// `PartnerResource` collection. The shape mirrors the partner hotel form
// (client/src/components/partner/HotelPartnerRegistration.tsx) one-to-one:
// separate rooms / rates / inventory / pricing / promotions sections, with the
// client-generated room id preserved as `key` so rates and inventory keep their
// links. Stored in its own `hotellistings` collection; the legacy flow is
// untouched.

// ── Embedded shapes ──────────────────────────────────────────────────────────
export interface HotelRoom {
  key: string; // client-generated room id; referenced by rates/inventory
  name: string;
  description?: string;
  maxAdults: number;
  maxChildren: number;
  bedType?: string;
  roomSize?: string;
  amenities: string[];
  images: string[];
}

export interface HotelRate {
  key: string;
  roomKey: string; // → HotelRoom.key
  name: string;
  mealType: HotelMealType;
  refundable: boolean;
  inclusions: string[];
}

export interface HotelInventory {
  roomKey: string; // → HotelRoom.key
  totalRooms: number;
  availableRooms: number;
}

export interface HotelPricing {
  basePricePerNight: number;
  taxPercentage: number;
  extraAdultCharge?: number;
  extraChildCharge?: number;
  currency: CurrencyCode;
}

export interface HotelPromotion {
  key: string;
  name: string;
  discountType: HotelDiscountType;
  discountValue: number;
  startDate?: Date;
  endDate?: Date;
}

export interface IHotelListing {
  partner: Types.ObjectId;
  name: string;
  slug: string;
  type: HotelType;
  status: ResourceStatus;
  description?: string;
  starRating?: HotelStarRating;
  address: {
    street?: string;
    city: string;
    state?: string;
    country?: string;
    postalCode?: string;
  };
  coordinates?: GeoPoint;
  contact: { phone?: string; email?: string };
  policies: {
    checkIn?: string;
    checkOut?: string;
    cancellation?: string;
    child?: string;
    pet?: string;
    smoking?: string;
  };
  amenities: string[];
  images: Image[];
  rooms: HotelRoom[];
  rates: HotelRate[];
  inventory: HotelInventory[];
  pricing: HotelPricing;
  promotions: HotelPromotion[];
  tags: string[];
  seoTitle?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ── Sub-schemas ──────────────────────────────────────────────────────────────
const roomSchema = new Schema<HotelRoom>(
  {
    key: { type: String, required: true, trim: true },
    name: { type: String, required: [true, "room name is required"], trim: true },
    description: { type: String, trim: true },
    maxAdults: { type: Number, default: 1, min: [1, "maxAdults must be at least 1"] },
    maxChildren: { type: Number, default: 0, min: [0, "maxChildren cannot be negative"] },
    bedType: { type: String, trim: true },
    roomSize: { type: String, trim: true },
    amenities: { type: [String], default: [] },
    images: { type: [String], default: [] },
  },
  { _id: false },
);

const rateSchema = new Schema<HotelRate>(
  {
    key: { type: String, required: true, trim: true },
    roomKey: { type: String, required: [true, "rate.roomKey is required"], trim: true },
    name: { type: String, trim: true },
    mealType: { type: String, enum: HOTEL_MEAL_TYPES, default: "Room Only" },
    refundable: { type: Boolean, default: true },
    inclusions: { type: [String], default: [] },
  },
  { _id: false },
);

const inventorySchema = new Schema<HotelInventory>(
  {
    roomKey: { type: String, required: [true, "inventory.roomKey is required"], trim: true },
    totalRooms: { type: Number, default: 0, min: [0, "totalRooms cannot be negative"] },
    availableRooms: { type: Number, default: 0, min: [0, "availableRooms cannot be negative"] },
  },
  { _id: false },
);

const pricingSchema = new Schema<HotelPricing>(
  {
    basePricePerNight: {
      type: Number,
      required: [true, "pricing.basePricePerNight is required"],
      min: [0, "basePricePerNight cannot be negative"],
    },
    taxPercentage: {
      type: Number,
      default: 0,
      min: [0, "taxPercentage cannot be negative"],
      max: [100, "taxPercentage cannot exceed 100"],
    },
    extraAdultCharge: { type: Number, min: [0, "extraAdultCharge cannot be negative"] },
    extraChildCharge: { type: Number, min: [0, "extraChildCharge cannot be negative"] },
    currency: { type: String, enum: CURRENCY_CODES, default: "INR" },
  },
  { _id: false },
);

const promotionSchema = new Schema<HotelPromotion>(
  {
    key: { type: String, required: true, trim: true },
    name: { type: String, trim: true },
    discountType: { type: String, enum: HOTEL_DISCOUNT_TYPES, default: "Percentage" },
    discountValue: { type: Number, default: 0, min: [0, "discountValue cannot be negative"] },
    startDate: { type: Date },
    endDate: { type: Date },
  },
  { _id: false },
);

// ── Root schema ──────────────────────────────────────────────────────────────
const hotelListingSchema = new Schema<IHotelListing>(
  {
    partner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "partner is required"],
      index: true,
    },
    name: { type: String, required: [true, "name is required"], trim: true },
    slug: { type: String, unique: true, lowercase: true, trim: true },
    type: { type: String, enum: HOTEL_TYPES, required: [true, "type is required"] },
    status: { type: String, enum: RESOURCE_STATUS, default: "draft", index: true },
    description: { type: String, maxlength: [2000, "description cannot exceed 2000 chars"], trim: true },
    starRating: {
      type: Number,
      validate: {
        validator: (v: number) => (HOTEL_STAR_RATINGS as readonly number[]).includes(v),
        message: `starRating must be one of: ${HOTEL_STAR_RATINGS.join(", ")}`,
      },
    },
    address: {
      street: { type: String, trim: true },
      city: { type: String, required: [true, "address.city is required"], trim: true },
      state: { type: String, trim: true },
      country: { type: String, trim: true },
      postalCode: { type: String, trim: true },
    },
    coordinates: { type: CoordinateSchema, default: undefined },
    contact: {
      phone: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
    },
    policies: {
      checkIn: { type: String, trim: true },
      checkOut: { type: String, trim: true },
      cancellation: { type: String, trim: true },
      child: { type: String, trim: true },
      pet: { type: String, trim: true },
      smoking: { type: String, trim: true },
    },
    amenities: { type: [String], default: [] },
    images: { type: [ImageSchema], default: [] },
    rooms: { type: [roomSchema], default: [] },
    rates: { type: [rateSchema], default: [] },
    inventory: { type: [inventorySchema], default: [] },
    pricing: { type: pricingSchema, required: true },
    promotions: { type: [promotionSchema], default: [] },
    tags: { type: [String], default: [] },
    seoTitle: { type: String, trim: true },
  },
  { timestamps: true, strict: true },
);

// ── Indexes (search + dashboard performance) ─────────────────────────────────
hotelListingSchema.index({ coordinates: "2dsphere" });
hotelListingSchema.index({ "address.city": 1, status: 1 });
hotelListingSchema.index({ partner: 1, status: 1 });
hotelListingSchema.index({ createdAt: -1 });

// ── Slug auto-generation: slugify(name) + short random suffix for uniqueness ──
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

hotelListingSchema.pre("validate", function (next) {
  if (!this.slug && this.name) {
    const base = slugify(this.name) || "hotel";
    this.slug = `${base}-${randomBytes(3).toString("hex")}`;
  }
  next();
});

hotelListingSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type HotelListingDoc = HydratedDocument<IHotelListing>;
export const HotelListingModel = model<IHotelListing>("HotelListing", hotelListingSchema);
