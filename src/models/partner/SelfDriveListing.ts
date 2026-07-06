import { Schema, model, Types, HydratedDocument } from "mongoose";
import { randomBytes } from "crypto";
import {
  RESOURCE_STATUS,
  CURRENCY_CODES,
  SELF_DRIVE_CATEGORIES,
  TRANSMISSION_TYPES,
  FUEL_TYPES,
  MILEAGE_POLICIES,
  FUEL_POLICIES,
  INSURANCE_TIERS,
  SERVICE_CANCELLATION_POLICIES,
  type ResourceStatus,
  type CurrencyCode,
  type SelfDriveCategory,
  type TransmissionType,
  type FuelType,
  type MileagePolicy,
  type FuelPolicyType,
  type InsuranceTier,
  type ServiceCancellationPolicy,
} from "./_shared/enums";
import { ImageSchema, type Image } from "./_shared/subdocs";

// SelfDriveListing — a vehicle rental company's fleet for self-drive. Enquiry-first.

export interface SelfDriveVehicle {
  category: SelfDriveCategory;
  makeModel?: string;
  year?: number;
  transmission?: TransmissionType;
  fuelType?: FuelType;
  seats?: number;
  luggageCapacity?: number;
  features: string[];
  photos: string[];
  dailyRate?: number;
  weeklyRate?: number;
  monthlyRate?: number;
  mileagePolicy?: MileagePolicy;
  kmPerDay?: number;
  excessChargePerKm?: number;
  fuelPolicy?: FuelPolicyType;
  inventoryCount?: number;
}

export interface SelfDriveInsurance {
  tier: InsuranceTier;
  coverageDetails?: string;
  deductibleAmount?: number;
  dailySurcharge?: number;
}

export interface SelfDriveExtra {
  name: string;
  dailyPrice?: number;
}

export interface ISelfDriveListing {
  partner: Types.ObjectId;
  status: ResourceStatus;
  title: string; // company / listing name
  slug: string;
  pickupLocations: { name?: string; address?: string }[];
  dropoffLocations: { name?: string; address?: string }[];
  sameLocationReturnOnly: boolean;
  vehicles: SelfDriveVehicle[];
  insuranceOptions: SelfDriveInsurance[];
  extras: SelfDriveExtra[];
  minRentalDays: number;
  maxRentalDays?: number;
  driverRequirements: { minimumAge?: number; acceptedLicenceTypes: string[]; minimumExperienceYears?: number };
  securityDeposit: { amount?: number; method?: string };
  lateReturnPolicy?: string;
  deliveryCollection: { available: boolean; charge?: number };
  currency: CurrencyCode;
  cancellationPolicy: ServiceCancellationPolicy;
  description?: string;
  termsAndConditions?: string;
  images: Image[];
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

const vehicleSchema = new Schema<SelfDriveVehicle>(
  {
    category: { type: String, enum: SELF_DRIVE_CATEGORIES, required: true },
    makeModel: { type: String, trim: true },
    year: { type: Number },
    transmission: { type: String, enum: TRANSMISSION_TYPES },
    fuelType: { type: String, enum: FUEL_TYPES },
    seats: { type: Number, min: 0 },
    luggageCapacity: { type: Number, min: 0 },
    features: { type: [String], default: [] },
    photos: { type: [String], default: [] },
    dailyRate: { type: Number, min: 0 },
    weeklyRate: { type: Number, min: 0 },
    monthlyRate: { type: Number, min: 0 },
    mileagePolicy: { type: String, enum: MILEAGE_POLICIES },
    kmPerDay: { type: Number, min: 0 },
    excessChargePerKm: { type: Number, min: 0 },
    fuelPolicy: { type: String, enum: FUEL_POLICIES },
    inventoryCount: { type: Number, min: 0 },
  },
  { _id: false },
);

const insuranceSchema = new Schema<SelfDriveInsurance>(
  {
    tier: { type: String, enum: INSURANCE_TIERS, required: true },
    coverageDetails: { type: String, trim: true },
    deductibleAmount: { type: Number, min: 0 },
    dailySurcharge: { type: Number, min: 0 },
  },
  { _id: false },
);

const locationSchema = new Schema<{ name?: string; address?: string }>(
  { name: { type: String, trim: true }, address: { type: String, trim: true } },
  { _id: false },
);

const selfDriveListingSchema = new Schema<ISelfDriveListing>(
  {
    partner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: RESOURCE_STATUS, default: "draft", index: true },
    title: { type: String, required: [true, "title is required"], trim: true },
    slug: { type: String, unique: true, lowercase: true, trim: true },
    pickupLocations: { type: [locationSchema], default: [] },
    dropoffLocations: { type: [locationSchema], default: [] },
    sameLocationReturnOnly: { type: Boolean, default: false },
    vehicles: { type: [vehicleSchema], default: [] },
    insuranceOptions: { type: [insuranceSchema], default: [] },
    extras: {
      type: [new Schema<SelfDriveExtra>({ name: { type: String, required: true, trim: true }, dailyPrice: { type: Number, min: 0 } }, { _id: false })],
      default: [],
    },
    minRentalDays: { type: Number, default: 1, min: 1 },
    maxRentalDays: { type: Number, min: 1 },
    driverRequirements: {
      minimumAge: { type: Number, min: 0 },
      acceptedLicenceTypes: { type: [String], default: [] },
      minimumExperienceYears: { type: Number, min: 0 },
    },
    securityDeposit: { amount: { type: Number, min: 0 }, method: { type: String, trim: true } },
    lateReturnPolicy: { type: String, trim: true },
    deliveryCollection: { available: { type: Boolean, default: false }, charge: { type: Number, min: 0 } },
    currency: { type: String, enum: CURRENCY_CODES, default: "INR" },
    cancellationPolicy: { type: String, enum: SERVICE_CANCELLATION_POLICIES, default: "free_24h" },
    description: { type: String, maxlength: 4000, trim: true },
    termsAndConditions: { type: String, maxlength: 4000, trim: true },
    images: { type: [ImageSchema], default: [] },
    tags: { type: [String], default: [] },
  },
  { timestamps: true, strict: true },
);

selfDriveListingSchema.index({ "vehicles.category": 1, status: 1 });
selfDriveListingSchema.index({ partner: 1, status: 1 });
selfDriveListingSchema.index({ createdAt: -1 });
selfDriveListingSchema.index({ title: "text", description: "text", tags: "text" });

function slugify(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
selfDriveListingSchema.pre("validate", function (next) {
  if (!this.slug && this.title) this.slug = `${slugify(this.title) || "rental"}-${randomBytes(3).toString("hex")}`;
  next();
});
selfDriveListingSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type SelfDriveListingDoc = HydratedDocument<ISelfDriveListing>;
export const SelfDriveListingModel = model<ISelfDriveListing>("SelfDriveListing", selfDriveListingSchema);
