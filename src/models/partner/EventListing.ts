import { Schema, model, Types, HydratedDocument } from "mongoose";
import { randomBytes } from "crypto";
import {
  EVENT_STATUS,
  EVENT_CATEGORIES,
  EVENT_TYPES,
  RECURRING_FREQUENCIES,
  VIRTUAL_PLATFORMS,
  EVENT_VENUE_TYPES,
  EVENT_CANCELLATION_POLICIES,
  CURRENCY_CODES,
  type EventStatus,
  type EventCategory,
  type EventType,
  type RecurringFrequency,
  type VirtualPlatform,
  type EventVenueType,
  type EventCancellationPolicy,
  type CurrencyCode,
} from "./_shared/enums";
import { ImageSchema, CoordinateSchema, type Image, type GeoPoint } from "./_shared/subdocs";

// Typed partner resource for organizer-listed events (weddings, concerts,
// workshops, …). Mirrors the HotelListing / TourPackage pattern exactly: own
// `eventlistings` collection, `partner` ref, auto-slug via a pre("validate")
// hook, `{ timestamps: true, strict: true }`, and a toJSON that maps _id → id.
// The legacy mixed-metadata PartnerResource flow is left untouched.

// ── Embedded shapes ──────────────────────────────────────────────────────────
export interface EventTicket {
  _id?: Types.ObjectId; // present at runtime (subdoc _id); used by the booking flow
  name: string;
  description?: string;
  price: number; // 0 = free
  currency: CurrencyCode;
  totalQuantity: number;
  soldQuantity: number; // confirmed (paid) tickets
  availableQuantity: number; // remaining sellable (decremented on hold + sale)
  maxPerOrder: number;
  saleStartDate?: Date;
  saleEndDate?: Date;
  isActive: boolean;
}

export interface EventRecurringPattern {
  frequency: RecurringFrequency;
  endDate?: Date;
  daysOfWeek: number[]; // 0-6, Sunday = 0
}

export interface IEventListing {
  partner: Types.ObjectId;
  status: EventStatus;
  // identity
  title: string;
  slug: string;
  description: string;
  shortDescription?: string;
  // classification
  category: EventCategory;
  tags: string[];
  eventType: EventType;
  // date & time
  startDate: Date;
  endDate: Date;
  startTime?: string;
  endTime?: string;
  isRecurring: boolean;
  recurringPattern?: EventRecurringPattern;
  // location
  venue?: {
    name?: string;
    address?: string;
    city: string;
    state?: string;
    pincode?: string;
    country: string;
    coordinates?: GeoPoint;
    landmark?: string;
    venueType?: EventVenueType;
  };
  virtualDetails?: {
    platform?: VirtualPlatform;
    link?: string;
    instructions?: string;
  };
  // media
  images: Image[];
  // ticketing & pricing
  tickets: EventTicket[];
  isFree: boolean;
  priceRange: { min: number; max: number };
  // capacity
  totalCapacity: number;
  currentBookings: number;
  isSoldOut: boolean;
  // organizer
  organizer: {
    name: string;
    phone?: string;
    email?: string;
    website?: string;
    logo?: string;
  };
  // policies
  cancellationPolicy: EventCancellationPolicy;
  cancellationDetails?: string;
  termsAndConditions?: string;
  ageRestriction: { hasRestriction: boolean; minimumAge?: number };
  // SEO
  metaTitle?: string;
  metaDescription?: string;
  isFeatured: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ── Sub-schemas ──────────────────────────────────────────────────────────────
const ticketSchema = new Schema<EventTicket>(
  {
    name: { type: String, required: [true, "ticket.name is required"], trim: true },
    description: { type: String, trim: true },
    price: { type: Number, required: [true, "ticket.price is required"], min: [0, "price cannot be negative"] },
    currency: { type: String, enum: CURRENCY_CODES, default: "INR" },
    totalQuantity: { type: Number, required: [true, "ticket.totalQuantity is required"], min: [1, "totalQuantity must be at least 1"] },
    soldQuantity: { type: Number, default: 0, min: [0, "soldQuantity cannot be negative"] },
    // No default: left undefined so the pre("validate") hook can seed it from
    // totalQuantity. A `default: 0` would pre-fill it and defeat that seeding,
    // leaving every ticket with 0 availability on model-direct creation.
    availableQuantity: { type: Number, min: [0, "availableQuantity cannot be negative"] },
    maxPerOrder: { type: Number, default: 10, min: [1, "maxPerOrder must be at least 1"] },
    saleStartDate: { type: Date },
    saleEndDate: { type: Date },
    isActive: { type: Boolean, default: true },
  },
  { _id: true },
);

const recurringSchema = new Schema<EventRecurringPattern>(
  {
    frequency: { type: String, enum: RECURRING_FREQUENCIES, required: true },
    endDate: { type: Date },
    daysOfWeek: {
      type: [Number],
      default: [],
      validate: {
        validator: (v: number[]) => v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
        message: "daysOfWeek must be integers 0-6 (Sunday = 0)",
      },
    },
  },
  { _id: false },
);

// ── Root schema ──────────────────────────────────────────────────────────────
const eventListingSchema = new Schema<IEventListing>(
  {
    partner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "partner is required"],
      index: true,
    },
    status: { type: String, enum: EVENT_STATUS, default: "draft", index: true },
    title: {
      type: String,
      required: [true, "title is required"],
      trim: true,
      minlength: [5, "title must be at least 5 chars"],
      maxlength: [200, "title cannot exceed 200 chars"],
    },
    slug: { type: String, unique: true, lowercase: true, trim: true },
    description: {
      type: String,
      required: [true, "description is required"],
      trim: true,
      minlength: [50, "description must be at least 50 chars"],
      maxlength: [5000, "description cannot exceed 5000 chars"],
    },
    shortDescription: { type: String, trim: true, maxlength: [300, "shortDescription cannot exceed 300 chars"] },
    category: { type: String, enum: EVENT_CATEGORIES, required: [true, "category is required"], index: true },
    tags: {
      type: [String],
      default: [],
      validate: { validator: (v: string[]) => v.length <= 10, message: "at most 10 tags allowed" },
    },
    eventType: { type: String, enum: EVENT_TYPES, default: "in_person" },
    startDate: { type: Date, required: [true, "startDate is required"] },
    endDate: { type: Date, required: [true, "endDate is required"] },
    startTime: { type: String, trim: true },
    endTime: { type: String, trim: true },
    isRecurring: { type: Boolean, default: false },
    recurringPattern: { type: recurringSchema, default: undefined },
    venue: {
      name: { type: String, trim: true },
      address: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      pincode: { type: String, trim: true },
      country: { type: String, trim: true, default: "India" },
      coordinates: { type: CoordinateSchema, default: undefined },
      landmark: { type: String, trim: true },
      venueType: { type: String, enum: EVENT_VENUE_TYPES },
    },
    virtualDetails: {
      platform: { type: String, enum: VIRTUAL_PLATFORMS },
      link: { type: String, trim: true },
      instructions: { type: String, trim: true },
    },
    images: {
      type: [ImageSchema],
      default: [],
      validate: { validator: (v: Image[]) => v.length <= 10, message: "at most 10 images allowed" },
    },
    tickets: { type: [ticketSchema], default: [] },
    isFree: { type: Boolean, default: false },
    priceRange: {
      min: { type: Number, default: 0 },
      max: { type: Number, default: 0 },
    },
    totalCapacity: { type: Number, required: [true, "totalCapacity is required"], min: [1, "totalCapacity must be at least 1"] },
    currentBookings: { type: Number, default: 0, min: [0, "currentBookings cannot be negative"] },
    isSoldOut: { type: Boolean, default: false },
    organizer: {
      name: { type: String, required: [true, "organizer.name is required"], trim: true },
      phone: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      website: { type: String, trim: true },
      logo: { type: String, trim: true },
    },
    cancellationPolicy: { type: String, enum: EVENT_CANCELLATION_POLICIES, default: "no_refund" },
    cancellationDetails: { type: String, trim: true },
    termsAndConditions: { type: String, trim: true },
    ageRestriction: {
      hasRestriction: { type: Boolean, default: false },
      minimumAge: { type: Number, min: [0, "minimumAge cannot be negative"] },
    },
    metaTitle: { type: String, trim: true, maxlength: [70, "metaTitle cannot exceed 70 chars"] },
    metaDescription: { type: String, trim: true, maxlength: [160, "metaDescription cannot exceed 160 chars"] },
    isFeatured: { type: Boolean, default: false },
  },
  { timestamps: true, strict: true },
);

// ── Indexes (instruct.md Step 1.2) ───────────────────────────────────────────
eventListingSchema.index({ partner: 1, status: 1 });
eventListingSchema.index({ status: 1, startDate: 1 });
eventListingSchema.index({ category: 1, status: 1 });
eventListingSchema.index({ "venue.city": 1, startDate: 1 });
eventListingSchema.index({ startDate: 1, endDate: 1 });
eventListingSchema.index({ "venue.coordinates": "2dsphere" });
eventListingSchema.index(
  { title: "text", description: "text", tags: "text", "venue.city": "text" },
  { name: "event_text_search", weights: { title: 5, "venue.city": 3, tags: 2, description: 1 } },
);

// ── Slug auto-generation: slugify(title) + short random suffix ────────────────
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── Derived fields + cross-field validation (instruct.md Step 1.2) ───────────
eventListingSchema.pre("validate", function (next) {
  if (!this.slug && this.title) {
    const base = slugify(this.title) || "event";
    this.slug = `${base}-${randomBytes(3).toString("hex")}`;
  }

  if (this.endDate && this.startDate && this.endDate < this.startDate) {
    next(new Error("endDate must be on or after startDate"));
    return;
  }

  if (!Array.isArray(this.tickets) || this.tickets.length === 0) {
    next(new Error("at least one ticket type is required"));
    return;
  }

  for (const t of this.tickets) {
    if (t.soldQuantity > t.totalQuantity) {
      next(new Error(`ticket "${t.name}": soldQuantity cannot exceed totalQuantity`));
      return;
    }
    // Seed availableQuantity for new tickets (remaining = total − sold).
    if (t.availableQuantity === undefined || t.availableQuantity === null) {
      t.availableQuantity = t.totalQuantity - t.soldQuantity;
    }
  }

  // Derived: priceRange, isFree, isSoldOut.
  const prices = this.tickets.map((t) => t.price);
  this.priceRange = { min: Math.min(...prices), max: Math.max(...prices) };
  this.isFree = prices.every((p) => p === 0);
  this.isSoldOut = this.currentBookings >= this.totalCapacity;

  next();
});

eventListingSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type EventListingDoc = HydratedDocument<IEventListing>;
export const EventListingModel = model<IEventListing>("EventListing", eventListingSchema);
