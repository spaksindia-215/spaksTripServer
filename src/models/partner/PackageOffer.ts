import { Schema, model, Types, HydratedDocument } from "mongoose";
import {
  RESOURCE_STATUS,
  CURRENCY_CODES,
  type ResourceStatus,
  type CurrencyCode,
} from "./_shared/enums";

// PackageOffer — a single operator's (partner's) operating price for a Package.
// Many offers can point at one package (the template OR another partner's custom
// package), which is what surfaces to the customer as "operators willing to run
// this package, with their prices". A partner may expose an optional direct
// contact; when withheld, the enquiry stays platform-mediated.

export interface OfferContact {
  name?: string;
  businessName?: string;
  phone?: string;
  email?: string;
  whatsapp?: string;
}

export interface IPackageOffer {
  package: Types.ObjectId;
  partner: Types.ObjectId;
  price: number;
  currency: CurrencyCode;
  perPerson: boolean;
  pricingNote?: string;
  notes?: string;
  inclusionsOverride: string[];
  directContact?: OfferContact;
  showDirectContact: boolean;
  status: ResourceStatus;
  createdAt: Date;
  updatedAt: Date;
}

const contactSchema = new Schema<OfferContact>(
  {
    name: { type: String, trim: true },
    businessName: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    whatsapp: { type: String, trim: true },
  },
  { _id: false },
);

const packageOfferSchema = new Schema<IPackageOffer>(
  {
    package: { type: Schema.Types.ObjectId, ref: "Package", required: [true, "package is required"], index: true },
    partner: { type: Schema.Types.ObjectId, ref: "User", required: [true, "partner is required"], index: true },
    price: { type: Number, required: [true, "price is required"], min: [0, "price cannot be negative"] },
    currency: { type: String, enum: CURRENCY_CODES, default: "INR" },
    perPerson: { type: Boolean, default: true },
    pricingNote: { type: String, trim: true },
    notes: { type: String, maxlength: [2000, "notes cannot exceed 2000 chars"], trim: true },
    inclusionsOverride: { type: [String], default: [] },
    directContact: { type: contactSchema },
    showDirectContact: { type: Boolean, default: false },
    status: { type: String, enum: RESOURCE_STATUS, default: "active", index: true },
  },
  { timestamps: true, strict: true },
);

// One offer per partner per package — a partner re-pricing edits their existing offer.
packageOfferSchema.index({ package: 1, partner: 1 }, { unique: true });
packageOfferSchema.index({ package: 1, status: 1 });
packageOfferSchema.index({ partner: 1, status: 1 });

packageOfferSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type PackageOfferDoc = HydratedDocument<IPackageOffer>;
export const PackageOfferModel = model<IPackageOffer>("PackageOffer", packageOfferSchema);
