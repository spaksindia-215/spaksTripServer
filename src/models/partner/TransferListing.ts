import { Schema, model, Types, HydratedDocument } from "mongoose";
import { randomBytes } from "crypto";
import {
  RESOURCE_STATUS,
  CURRENCY_CODES,
  TRANSFER_TYPES,
  TRANSFER_VEHICLE_TYPES,
  SERVICE_CANCELLATION_POLICIES,
  type ResourceStatus,
  type CurrencyCode,
  type TransferType,
  type TransferVehicleType,
  type ServiceCancellationPolicy,
} from "./_shared/enums";
import { ImageSchema, type Image } from "./_shared/subdocs";

// TransferListing — point-to-point airport / inter-city transfer service listed by
// a partner (taxi company, private car service). Plugs into the shared moderation
// registry and the enquiry-first ServiceEnquiry flow.

export interface TransferRoute {
  from?: string;
  to?: string;
  estimatedDuration?: number; // minutes
  estimatedDistance?: number; // km
  price?: number;
}

export interface TransferVehicle {
  type: TransferVehicleType;
  makeModel?: string;
  maxPassengers?: number;
  maxLuggage?: number;
  photo?: string;
  features: string[];
  basePrice?: number;
}

export interface ITransferListing {
  partner: Types.ObjectId;
  status: ResourceStatus;
  title: string;
  slug: string;
  transferType: TransferType;
  coverageAreas: string[];
  routes: TransferRoute[];
  vehicles: TransferVehicle[];
  meetAndGreet: boolean;
  flightTracking: boolean;
  childSeat: { available: boolean; surcharge?: number };
  waitingTimePolicy?: string;
  operatingHours: { start?: string; end?: string; is24x7: boolean };
  advanceBookingHours: number;
  currency: CurrencyCode;
  cancellationPolicy: ServiceCancellationPolicy;
  description?: string;
  termsAndConditions?: string;
  images: Image[];
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

const routeSchema = new Schema<TransferRoute>(
  {
    from: { type: String, trim: true },
    to: { type: String, trim: true },
    estimatedDuration: { type: Number, min: 0 },
    estimatedDistance: { type: Number, min: 0 },
    price: { type: Number, min: 0 },
  },
  { _id: false },
);

const vehicleSchema = new Schema<TransferVehicle>(
  {
    type: { type: String, enum: TRANSFER_VEHICLE_TYPES, required: true },
    makeModel: { type: String, trim: true },
    maxPassengers: { type: Number, min: 0 },
    maxLuggage: { type: Number, min: 0 },
    photo: { type: String, trim: true },
    features: { type: [String], default: [] },
    basePrice: { type: Number, min: 0 },
  },
  { _id: false },
);

const transferListingSchema = new Schema<ITransferListing>(
  {
    partner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: RESOURCE_STATUS, default: "draft", index: true },
    title: { type: String, required: [true, "title is required"], trim: true },
    slug: { type: String, unique: true, lowercase: true, trim: true },
    transferType: { type: String, enum: TRANSFER_TYPES, required: [true, "transferType is required"] },
    coverageAreas: { type: [String], default: [] },
    routes: { type: [routeSchema], default: [] },
    vehicles: { type: [vehicleSchema], default: [] },
    meetAndGreet: { type: Boolean, default: false },
    flightTracking: { type: Boolean, default: false },
    childSeat: {
      available: { type: Boolean, default: false },
      surcharge: { type: Number, min: 0 },
    },
    waitingTimePolicy: { type: String, trim: true },
    operatingHours: {
      start: { type: String, trim: true },
      end: { type: String, trim: true },
      is24x7: { type: Boolean, default: false },
    },
    advanceBookingHours: { type: Number, default: 24, min: 0 },
    currency: { type: String, enum: CURRENCY_CODES, default: "INR" },
    cancellationPolicy: { type: String, enum: SERVICE_CANCELLATION_POLICIES, default: "free_24h" },
    description: { type: String, maxlength: 4000, trim: true },
    termsAndConditions: { type: String, maxlength: 4000, trim: true },
    images: { type: [ImageSchema], default: [] },
    tags: { type: [String], default: [] },
  },
  { timestamps: true, strict: true },
);

transferListingSchema.index({ transferType: 1, status: 1 });
transferListingSchema.index({ "routes.from": 1, "routes.to": 1 });
transferListingSchema.index({ partner: 1, status: 1 });
transferListingSchema.index({ createdAt: -1 });
transferListingSchema.index({ title: "text", description: "text", tags: "text" });

function slugify(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
transferListingSchema.pre("validate", function (next) {
  if (!this.slug && this.title) this.slug = `${slugify(this.title) || "transfer"}-${randomBytes(3).toString("hex")}`;
  next();
});
transferListingSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type TransferListingDoc = HydratedDocument<ITransferListing>;
export const TransferListingModel = model<ITransferListing>("TransferListing", transferListingSchema);
