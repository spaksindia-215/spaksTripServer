import { Schema, model, Types, HydratedDocument } from "mongoose";
import { randomBytes } from "crypto";
import {
  RESOURCE_STATUS,
  TAXI_VEHICLE_TYPES,
  TAXI_FUEL_TYPES,
  TAXI_TRANSMISSION_TYPES,
  TAXI_LUGGAGE_SIZES,
  TAXI_SERVICE_TYPES,
  type ResourceStatus,
  type TaxiVehicleType,
  type TaxiFuelType,
  type TaxiTransmissionType,
  type TaxiLuggageSize,
  type TaxiServiceType,
} from "./_shared/enums";
import { ImageSchema, type Image } from "./_shared/subdocs";

// MTI-style (mytaxiindia.com) typed taxi listing — CLAUDE.md Model 2. A vehicle
// catalogue entry that can offer multiple service types (one_way, round_trip,
// airport_transfer, local_hourly, outstation), each with its own pricing and
// coverage. A few platform-specific fields (registrationNumber, transmission,
// operatingDays, owner `contact`, raw `luggageCapacity`, `routes`, extra docs)
// are added beyond the bare spec so the existing list-your-taxi form's data is
// captured without loss. Stored in its own `taxilistings` collection.

// ── Embedded shapes ──────────────────────────────────────────────────────────
export interface TaxiVehicle {
  make: string;
  model: string;
  type: TaxiVehicleType;
  fuelType?: TaxiFuelType;
  transmission?: TaxiTransmissionType;
  registrationNumber?: string;
  yearOfManufacture?: number;
  seatingCap: number;
  acAvailable: boolean;
  luggageSpace?: TaxiLuggageSize;
  luggageCapacity?: number;
  images: Image[];
  amenities: string[];
}

export interface TaxiServicePricing {
  baseFare: number;
  pricePerKm?: number;
  pricePerHour?: number;
  nightCharge?: number;
  driverAllowance?: number;
  tollsIncluded: boolean;
  taxPercent: number;
}

export interface TaxiServiceCoverage {
  baseCity: string;
  servicedCities: string[];
  airportCode?: string;
  maxKmPerDay?: number;
}

export interface TaxiService {
  type: TaxiServiceType;
  isActive: boolean;
  pricing: TaxiServicePricing;
  coverage: TaxiServiceCoverage;
}

export interface TaxiDriver {
  name?: string;
  phone?: string;
  licenseNo?: string;
  languages: string[];
  rating?: number;
}

export interface TaxiTimeSlot {
  from: string;
  to: string;
}

export interface TaxiDocRef {
  url?: string;
  expiryDate?: Date;
}

export interface ITaxiListing {
  partner: Types.ObjectId;
  status: ResourceStatus;
  slug: string;
  vehicle: TaxiVehicle;
  services: TaxiService[];
  driver?: TaxiDriver;
  operationalHours: { available24x7: boolean; slots: TaxiTimeSlot[] };
  operatingDays: string[];
  routes: string[];
  advanceBookingHrs: number;
  docs: {
    insurance?: TaxiDocRef;
    permit?: TaxiDocRef;
    vehicleRC?: TaxiDocRef;
    pollutionCertificate?: TaxiDocRef;
    drivingLicense?: TaxiDocRef;
  };
  cancellationPolicy: { freeCancelHrs: number; chargePercent: number };
  contact: { name?: string; phone?: string; email?: string; businessName?: string };
  description?: string;
  driverIncluded: boolean;
  selfDriveAvailable: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ── Sub-schemas ──────────────────────────────────────────────────────────────
const vehicleSchema = new Schema<TaxiVehicle>(
  {
    make: { type: String, required: [true, "vehicle.make is required"], trim: true },
    model: { type: String, required: [true, "vehicle.model is required"], trim: true },
    type: { type: String, enum: TAXI_VEHICLE_TYPES, required: [true, "vehicle.type is required"] },
    fuelType: { type: String, enum: TAXI_FUEL_TYPES },
    transmission: { type: String, enum: TAXI_TRANSMISSION_TYPES },
    registrationNumber: { type: String, trim: true, uppercase: true },
    yearOfManufacture: { type: Number, min: [1990, "yearOfManufacture too old"] },
    seatingCap: {
      type: Number,
      required: [true, "vehicle.seatingCap is required"],
      min: [1, "seatingCap must be at least 1"],
    },
    acAvailable: { type: Boolean, default: true },
    luggageSpace: { type: String, enum: TAXI_LUGGAGE_SIZES },
    luggageCapacity: { type: Number, min: [0, "luggageCapacity cannot be negative"] },
    images: { type: [ImageSchema], default: [] },
    amenities: { type: [String], default: [] },
  },
  { _id: false },
);

const servicePricingSchema = new Schema<TaxiServicePricing>(
  {
    baseFare: {
      type: Number,
      required: [true, "service.pricing.baseFare is required"],
      min: [0, "baseFare cannot be negative"],
    },
    pricePerKm: { type: Number, min: [0, "pricePerKm cannot be negative"] },
    pricePerHour: { type: Number, min: [0, "pricePerHour cannot be negative"] },
    nightCharge: { type: Number, min: [0, "nightCharge cannot be negative"] },
    driverAllowance: { type: Number, min: [0, "driverAllowance cannot be negative"] },
    tollsIncluded: { type: Boolean, default: false },
    taxPercent: { type: Number, default: 5, min: [0, "taxPercent cannot be negative"], max: [100, "taxPercent cannot exceed 100"] },
  },
  { _id: false },
);

const serviceCoverageSchema = new Schema<TaxiServiceCoverage>(
  {
    baseCity: { type: String, required: [true, "service.coverage.baseCity is required"], trim: true },
    servicedCities: { type: [String], default: [] },
    airportCode: { type: String, trim: true, uppercase: true },
    maxKmPerDay: { type: Number, min: [0, "maxKmPerDay cannot be negative"] },
  },
  { _id: false },
);

const serviceSchema = new Schema<TaxiService>(
  {
    type: { type: String, enum: TAXI_SERVICE_TYPES, required: [true, "service.type is required"] },
    isActive: { type: Boolean, default: true },
    pricing: { type: servicePricingSchema, required: true },
    coverage: { type: serviceCoverageSchema, required: true },
  },
  { _id: false },
);

const driverSchema = new Schema<TaxiDriver>(
  {
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    licenseNo: { type: String, trim: true },
    languages: { type: [String], default: [] },
    rating: { type: Number, min: [0, "rating cannot be negative"], max: [5, "rating cannot exceed 5"] },
  },
  { _id: false },
);

const timeSlotSchema = new Schema<TaxiTimeSlot>(
  { from: { type: String, trim: true }, to: { type: String, trim: true } },
  { _id: false },
);

const docRefSchema = new Schema<TaxiDocRef>(
  { url: { type: String, trim: true }, expiryDate: { type: Date } },
  { _id: false },
);

// ── Root schema ──────────────────────────────────────────────────────────────
const taxiListingSchema = new Schema<ITaxiListing>(
  {
    partner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "partner is required"],
      index: true,
    },
    status: { type: String, enum: RESOURCE_STATUS, default: "active", index: true },
    slug: { type: String, unique: true, lowercase: true, trim: true },
    vehicle: { type: vehicleSchema, required: true },
    services: {
      type: [serviceSchema],
      default: [],
      validate: {
        validator: (v: TaxiService[]) => v.length > 0,
        message: "at least one service is required",
      },
    },
    driver: { type: driverSchema, default: undefined },
    operationalHours: {
      available24x7: { type: Boolean, default: true },
      slots: { type: [timeSlotSchema], default: [] },
    },
    operatingDays: { type: [String], default: [] },
    routes: { type: [String], default: [] },
    advanceBookingHrs: { type: Number, default: 4, min: [0, "advanceBookingHrs cannot be negative"] },
    docs: {
      insurance: { type: docRefSchema, default: undefined },
      permit: { type: docRefSchema, default: undefined },
      vehicleRC: { type: docRefSchema, default: undefined },
      pollutionCertificate: { type: docRefSchema, default: undefined },
      drivingLicense: { type: docRefSchema, default: undefined },
    },
    cancellationPolicy: {
      freeCancelHrs: { type: Number, default: 24, min: [0, "freeCancelHrs cannot be negative"] },
      chargePercent: { type: Number, default: 10, min: [0, "chargePercent cannot be negative"], max: [100, "chargePercent cannot exceed 100"] },
    },
    contact: {
      name: { type: String, trim: true },
      phone: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      businessName: { type: String, trim: true },
    },
    description: { type: String, maxlength: [2000, "description cannot exceed 2000 chars"], trim: true },
    driverIncluded: { type: Boolean, default: true },
    selfDriveAvailable: { type: Boolean, default: false },
  },
  { timestamps: true, strict: true },
);

// ── Indexes (CLAUDE.md Step 9) ───────────────────────────────────────────────
taxiListingSchema.index({ "services.coverage.baseCity": 1, "services.type": 1, status: 1 });
taxiListingSchema.index({ partner: 1, status: 1 });
taxiListingSchema.index({ createdAt: -1 });

// ── Slug auto-generation: make-model-reg + short random suffix ───────────────
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

taxiListingSchema.pre("validate", function (next) {
  if (!this.slug) {
    const base =
      slugify(`${this.vehicle?.make ?? ""}-${this.vehicle?.model ?? ""}-${this.vehicle?.registrationNumber ?? ""}`) ||
      "taxi";
    this.slug = `${base}-${randomBytes(3).toString("hex")}`;
  }
  next();
});

taxiListingSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type TaxiListingDoc = HydratedDocument<ITaxiListing>;
export const TaxiListingModel = model<ITaxiListing>("TaxiListing", taxiListingSchema);
