import { Schema, model, Types, HydratedDocument } from "mongoose";
import {
  ENQUIRY_STATUS,
  ENQUIRY_PAYMENT_STATUS,
  CURRENCY_CODES,
  type EnquiryStatus,
  type EnquiryPaymentStatus,
  type CurrencyCode,
} from "./_shared/enums";

// PackageEnquiry — a customer lead against a chosen operator offer. Routed to the
// operator (`partner`, denormalized from the offer) and visible to the platform,
// which follows up / contacts the operator. Guests are allowed (no `customer`);
// contact details are always captured. Payment fields are placeholders so an
// online-payment flow can attach later (decision: enquiry now, payment later).

export interface EnquiryContact {
  name: string;
  phone: string;
  email?: string;
}

export interface EnquiryPax {
  adults: number;
  children: number;
  infants: number;
}

export interface EnquiryNote {
  at: Date;
  text: string;
}

export interface IPackageEnquiry {
  package: Types.ObjectId;
  offer?: Types.ObjectId;
  partner: Types.ObjectId;
  customer?: Types.ObjectId;
  contact: EnquiryContact;
  travelDate?: Date;
  pax: EnquiryPax;
  message?: string;
  status: EnquiryStatus;
  internalNotes: EnquiryNote[];
  paymentStatus: EnquiryPaymentStatus;
  amount?: number;
  currency: CurrencyCode;
  createdAt: Date;
  updatedAt: Date;
}

const contactSchema = new Schema<EnquiryContact>(
  {
    name: { type: String, required: [true, "contact name is required"], trim: true },
    phone: { type: String, required: [true, "contact phone is required"], trim: true },
    email: { type: String, trim: true, lowercase: true },
  },
  { _id: false },
);

const noteSchema = new Schema<EnquiryNote>(
  {
    at: { type: Date, default: Date.now },
    text: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const packageEnquirySchema = new Schema<IPackageEnquiry>(
  {
    package: { type: Schema.Types.ObjectId, ref: "Package", required: [true, "package is required"], index: true },
    offer: { type: Schema.Types.ObjectId, ref: "PackageOffer" },
    partner: { type: Schema.Types.ObjectId, ref: "User", required: [true, "partner is required"], index: true },
    customer: { type: Schema.Types.ObjectId, ref: "User", index: true },
    contact: { type: contactSchema, required: true },
    travelDate: { type: Date },
    pax: {
      adults: { type: Number, default: 1, min: [0, "adults cannot be negative"] },
      children: { type: Number, default: 0, min: [0, "children cannot be negative"] },
      infants: { type: Number, default: 0, min: [0, "infants cannot be negative"] },
    },
    message: { type: String, maxlength: [2000, "message cannot exceed 2000 chars"], trim: true },
    status: { type: String, enum: ENQUIRY_STATUS, default: "new", index: true },
    internalNotes: { type: [noteSchema], default: [] },
    paymentStatus: { type: String, enum: ENQUIRY_PAYMENT_STATUS, default: "not_applicable" },
    amount: { type: Number, min: [0, "amount cannot be negative"] },
    currency: { type: String, enum: CURRENCY_CODES, default: "INR" },
  },
  { timestamps: true, strict: true },
);

packageEnquirySchema.index({ partner: 1, status: 1 });
packageEnquirySchema.index({ package: 1 });
packageEnquirySchema.index({ createdAt: -1 });

packageEnquirySchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type PackageEnquiryDoc = HydratedDocument<IPackageEnquiry>;
export const PackageEnquiryModel = model<IPackageEnquiry>("PackageEnquiry", packageEnquirySchema);
