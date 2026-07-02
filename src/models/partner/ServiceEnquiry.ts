import { Schema, model, Types, HydratedDocument } from "mongoose";
import {
  ENQUIRY_STATUS,
  ENQUIRY_PAYMENT_STATUS,
  CURRENCY_CODES,
  SERVICE_VERTICALS,
  type EnquiryStatus,
  type EnquiryPaymentStatus,
  type CurrencyCode,
  type ServiceVertical,
} from "./_shared/enums";

// ServiceEnquiry — a generic customer lead against a single listing in one of the
// new partner-service verticals (sightseeing | transfer | self_drive | islandhopper
// | visa). Modelled on PackageEnquiry, but keyed by `vertical` + `listing` instead
// of the catalog/offer pair, so all five modules share one collection rather than
// five near-identical ones. Guests are allowed (no `customer`); contact is always
// captured. Payment fields are placeholders for a future online-payment flow.

export interface ServiceEnquiryContact {
  name: string;
  phone: string;
  email?: string;
}

export interface ServiceEnquiryPax {
  adults: number;
  children: number;
  infants: number;
}

export interface ServiceEnquiryNote {
  at: Date;
  text: string;
}

export interface IServiceEnquiry {
  vertical: ServiceVertical;
  listing: Types.ObjectId;
  partner: Types.ObjectId;
  customer?: Types.ObjectId;
  contact: ServiceEnquiryContact;
  travelDate?: Date;
  pax: ServiceEnquiryPax;
  message?: string;
  // Free-form, vertical-specific extras captured on the enquiry form (e.g. flight
  // number for transfers, licence type for self-drive, visa type/nationality).
  details: Record<string, unknown>;
  status: EnquiryStatus;
  internalNotes: ServiceEnquiryNote[];
  paymentStatus: EnquiryPaymentStatus;
  amount?: number;
  currency: CurrencyCode;
  createdAt: Date;
  updatedAt: Date;
}

const contactSchema = new Schema<ServiceEnquiryContact>(
  {
    name: { type: String, required: [true, "contact name is required"], trim: true },
    phone: { type: String, required: [true, "contact phone is required"], trim: true },
    email: { type: String, trim: true, lowercase: true },
  },
  { _id: false },
);

const noteSchema = new Schema<ServiceEnquiryNote>(
  {
    at: { type: Date, default: Date.now },
    text: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const serviceEnquirySchema = new Schema<IServiceEnquiry>(
  {
    vertical: { type: String, enum: SERVICE_VERTICALS, required: [true, "vertical is required"], index: true },
    listing: { type: Schema.Types.ObjectId, required: [true, "listing is required"], index: true },
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
    details: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ENQUIRY_STATUS, default: "new", index: true },
    internalNotes: { type: [noteSchema], default: [] },
    paymentStatus: { type: String, enum: ENQUIRY_PAYMENT_STATUS, default: "not_applicable" },
    amount: { type: Number, min: [0, "amount cannot be negative"] },
    currency: { type: String, enum: CURRENCY_CODES, default: "INR" },
  },
  { timestamps: true, strict: true },
);

serviceEnquirySchema.index({ partner: 1, vertical: 1, status: 1 });
serviceEnquirySchema.index({ customer: 1, vertical: 1 });
serviceEnquirySchema.index({ listing: 1 });
serviceEnquirySchema.index({ createdAt: -1 });

serviceEnquirySchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type ServiceEnquiryDoc = HydratedDocument<IServiceEnquiry>;
export const ServiceEnquiryModel = model<IServiceEnquiry>("ServiceEnquiry", serviceEnquirySchema);
