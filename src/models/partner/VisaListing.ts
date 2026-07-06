import { Schema, model, Types, HydratedDocument } from "mongoose";
import { randomBytes } from "crypto";
import {
  RESOURCE_STATUS,
  CURRENCY_CODES,
  VISA_CATEGORIES,
  VISA_CONSULTATION_MODES,
  VISA_PAYMENT_STRUCTURES,
  type ResourceStatus,
  type CurrencyCode,
  type VisaCategory,
  type VisaConsultationMode,
  type VisaPaymentStructure,
} from "./_shared/enums";
import { ImageSchema, type Image } from "./_shared/subdocs";

// VisaListing — a licensed visa consultancy's profile + the visa services it offers
// per country/category. Consultancy/service model (enquiry-first by nature).

export interface VisaService {
  country?: string;
  visaCategory: VisaCategory;
  serviceDescription?: string;
  eligibilityCriteria?: string;
  documentsRequired: string[];
  processSteps: string[];
  estimatedProcessingTime?: string;
  successRate?: number;
  consultancyFee?: number;
  paymentStructure?: VisaPaymentStructure;
  governmentFeesIndicative?: number;
  refundPolicy?: string;
  additionalServices: string[];
}

export interface IVisaListing {
  partner: Types.ObjectId;
  status: ResourceStatus;
  title: string; // consultancy name
  slug: string;
  licenceNumber?: string;
  countriesCovered: string[];
  visaTypesOffered: VisaCategory[];
  services: VisaService[];
  consultationModes: VisaConsultationMode[];
  languages: string[];
  officeLocations: { address?: string; hours?: string }[];
  teamProfiles: { name?: string; role?: string; qualifications?: string; specialization?: string }[];
  isFreeInitialConsultation: boolean;
  consultationFee?: number;
  currency: CurrencyCode;
  description?: string;
  termsAndConditions?: string;
  images: Image[];
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

const serviceSchema = new Schema<VisaService>(
  {
    country: { type: String, trim: true },
    visaCategory: { type: String, enum: VISA_CATEGORIES, required: true },
    serviceDescription: { type: String, trim: true },
    eligibilityCriteria: { type: String, trim: true },
    documentsRequired: { type: [String], default: [] },
    processSteps: { type: [String], default: [] },
    estimatedProcessingTime: { type: String, trim: true },
    successRate: { type: Number, min: 0, max: 100 },
    consultancyFee: { type: Number, min: 0 },
    paymentStructure: { type: String, enum: VISA_PAYMENT_STRUCTURES },
    governmentFeesIndicative: { type: Number, min: 0 },
    refundPolicy: { type: String, trim: true },
    additionalServices: { type: [String], default: [] },
  },
  { _id: false },
);

const visaListingSchema = new Schema<IVisaListing>(
  {
    partner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: RESOURCE_STATUS, default: "draft", index: true },
    title: { type: String, required: [true, "title is required"], trim: true },
    slug: { type: String, unique: true, lowercase: true, trim: true },
    licenceNumber: { type: String, trim: true },
    countriesCovered: { type: [String], default: [] },
    visaTypesOffered: { type: [{ type: String, enum: VISA_CATEGORIES }], default: [] },
    services: { type: [serviceSchema], default: [] },
    consultationModes: { type: [{ type: String, enum: VISA_CONSULTATION_MODES }], default: [] },
    languages: { type: [String], default: [] },
    officeLocations: {
      type: [new Schema<{ address?: string; hours?: string }>({ address: { type: String, trim: true }, hours: { type: String, trim: true } }, { _id: false })],
      default: [],
    },
    teamProfiles: {
      type: [
        new Schema<{ name?: string; role?: string; qualifications?: string; specialization?: string }>(
          {
            name: { type: String, trim: true },
            role: { type: String, trim: true },
            qualifications: { type: String, trim: true },
            specialization: { type: String, trim: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    isFreeInitialConsultation: { type: Boolean, default: false },
    consultationFee: { type: Number, min: 0 },
    currency: { type: String, enum: CURRENCY_CODES, default: "INR" },
    description: { type: String, maxlength: 4000, trim: true },
    termsAndConditions: { type: String, maxlength: 4000, trim: true },
    images: { type: [ImageSchema], default: [] },
    tags: { type: [String], default: [] },
  },
  { timestamps: true, strict: true },
);

// NOTE: countriesCovered and visaTypesOffered are both arrays; MongoDB cannot
// index two array fields in one compound index ("parallel arrays", code 171),
// so they must live in separate indexes.
visaListingSchema.index({ countriesCovered: 1, status: 1 });
visaListingSchema.index({ visaTypesOffered: 1, status: 1 });
visaListingSchema.index({ partner: 1, status: 1 });
visaListingSchema.index({ createdAt: -1 });
visaListingSchema.index({ title: "text", description: "text", tags: "text" });

function slugify(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
visaListingSchema.pre("validate", function (next) {
  if (!this.slug && this.title) this.slug = `${slugify(this.title) || "consultancy"}-${randomBytes(3).toString("hex")}`;
  next();
});
visaListingSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type VisaListingDoc = HydratedDocument<IVisaListing>;
export const VisaListingModel = model<IVisaListing>("VisaListing", visaListingSchema);
