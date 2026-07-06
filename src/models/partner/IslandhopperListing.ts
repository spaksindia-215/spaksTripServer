import { Schema, model, Types, HydratedDocument } from "mongoose";
import { randomBytes } from "crypto";
import {
  RESOURCE_STATUS,
  CURRENCY_CODES,
  OPERATING_DAYS,
  ISLANDHOPPER_SERVICE_TYPES,
  SERVICE_CANCELLATION_POLICIES,
  type ResourceStatus,
  type CurrencyCode,
  type OperatingDay,
  type IslandhopperServiceType,
  type ServiceCancellationPolicy,
} from "./_shared/enums";
import { ImageSchema, type Image } from "./_shared/subdocs";

// IslandhopperListing — inter-island travel (domestic flight / seaplane / speedboat
// / ferry / yacht) listed by an operator. Enquiry-first.

export interface IslandhopperRoute {
  origin?: string;
  destination?: string;
  distance?: number; // km
  estimatedDuration?: number; // minutes
  isNonStop: boolean;
  oneWayFare?: number;
  roundTripFare?: number;
}

export interface IslandhopperSchedule {
  route?: string; // "Origin → Destination" label
  daysOfWeek: OperatingDay[];
  departureTimes: string[];
  frequency?: string;
}

export interface IIslandhopperListing {
  partner: Types.ObjectId;
  status: ResourceStatus;
  title: string;
  slug: string;
  serviceType: IslandhopperServiceType;
  routes: IslandhopperRoute[];
  schedule: IslandhopperSchedule[];
  vessel: { type?: string; capacity?: number; amenities: string[] };
  baggagePolicy: { includedKg?: number; excessPerKg?: number; prohibitedItems: string[] };
  checkinPolicy?: string;
  departurePoint?: string;
  canConnect: boolean;
  weatherRestrictions?: string;
  currency: CurrencyCode;
  cancellationPolicy: ServiceCancellationPolicy;
  description?: string;
  termsAndConditions?: string;
  images: Image[];
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

const routeSchema = new Schema<IslandhopperRoute>(
  {
    origin: { type: String, trim: true },
    destination: { type: String, trim: true },
    distance: { type: Number, min: 0 },
    estimatedDuration: { type: Number, min: 0 },
    isNonStop: { type: Boolean, default: true },
    oneWayFare: { type: Number, min: 0 },
    roundTripFare: { type: Number, min: 0 },
  },
  { _id: false },
);

const scheduleSchema = new Schema<IslandhopperSchedule>(
  {
    route: { type: String, trim: true },
    daysOfWeek: { type: [{ type: String, enum: OPERATING_DAYS }], default: [] },
    departureTimes: { type: [String], default: [] },
    frequency: { type: String, trim: true },
  },
  { _id: false },
);

const islandhopperListingSchema = new Schema<IIslandhopperListing>(
  {
    partner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: RESOURCE_STATUS, default: "draft", index: true },
    title: { type: String, required: [true, "title is required"], trim: true },
    slug: { type: String, unique: true, lowercase: true, trim: true },
    serviceType: { type: String, enum: ISLANDHOPPER_SERVICE_TYPES, required: [true, "serviceType is required"] },
    routes: { type: [routeSchema], default: [] },
    schedule: { type: [scheduleSchema], default: [] },
    vessel: {
      type: { type: String, trim: true },
      capacity: { type: Number, min: 0 },
      amenities: { type: [String], default: [] },
    },
    baggagePolicy: {
      includedKg: { type: Number, min: 0 },
      excessPerKg: { type: Number, min: 0 },
      prohibitedItems: { type: [String], default: [] },
    },
    checkinPolicy: { type: String, trim: true },
    departurePoint: { type: String, trim: true },
    canConnect: { type: Boolean, default: false },
    weatherRestrictions: { type: String, trim: true },
    currency: { type: String, enum: CURRENCY_CODES, default: "INR" },
    cancellationPolicy: { type: String, enum: SERVICE_CANCELLATION_POLICIES, default: "free_24h" },
    description: { type: String, maxlength: 4000, trim: true },
    termsAndConditions: { type: String, maxlength: 4000, trim: true },
    images: { type: [ImageSchema], default: [] },
    tags: { type: [String], default: [] },
  },
  { timestamps: true, strict: true },
);

islandhopperListingSchema.index({ serviceType: 1, status: 1 });
islandhopperListingSchema.index({ "routes.origin": 1, "routes.destination": 1 });
islandhopperListingSchema.index({ partner: 1, status: 1 });
islandhopperListingSchema.index({ createdAt: -1 });
islandhopperListingSchema.index({ title: "text", description: "text", tags: "text" });

function slugify(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
islandhopperListingSchema.pre("validate", function (next) {
  if (!this.slug && this.title) this.slug = `${slugify(this.title) || "route"}-${randomBytes(3).toString("hex")}`;
  next();
});
islandhopperListingSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type IslandhopperListingDoc = HydratedDocument<IIslandhopperListing>;
export const IslandhopperListingModel = model<IIslandhopperListing>("IslandhopperListing", islandhopperListingSchema);
