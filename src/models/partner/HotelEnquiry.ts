import { Schema, model, Types, HydratedDocument } from "mongoose";
import { ENQUIRY_STATUS, type EnquiryStatus } from "./_shared/enums";

// Lead generated when a customer/guest enquires about a partner hotel listing
// from the search results. Mirrors PackageEnquiry — lead-only today (no online
// payment), the partner follows up out-of-band. The enquiry also emails the
// partner so it is actionable even without a dashboard view.

export interface HotelEnquiryContact {
  name: string;
  phone: string;
  email?: string;
}

export interface HotelEnquiryPax {
  adults: number;
  children: number;
  infants: number;
}

export interface IHotelEnquiry {
  hotel: Types.ObjectId;
  partner: Types.ObjectId;
  customer?: Types.ObjectId;
  contact: HotelEnquiryContact;
  checkIn?: Date;
  checkOut?: Date;
  pax: HotelEnquiryPax;
  message?: string;
  status: EnquiryStatus;
  createdAt: Date;
  updatedAt: Date;
}

const contactSchema = new Schema<HotelEnquiryContact>(
  {
    name: { type: String, required: [true, "contact name is required"], trim: true },
    phone: { type: String, required: [true, "contact phone is required"], trim: true },
    email: { type: String, trim: true, lowercase: true },
  },
  { _id: false },
);

const hotelEnquirySchema = new Schema<IHotelEnquiry>(
  {
    hotel: { type: Schema.Types.ObjectId, ref: "HotelListing", required: [true, "hotel is required"], index: true },
    partner: { type: Schema.Types.ObjectId, ref: "User", required: [true, "partner is required"], index: true },
    customer: { type: Schema.Types.ObjectId, ref: "User", index: true },
    contact: { type: contactSchema, required: true },
    checkIn: { type: Date },
    checkOut: { type: Date },
    pax: {
      adults: { type: Number, default: 1, min: [0, "adults cannot be negative"] },
      children: { type: Number, default: 0, min: [0, "children cannot be negative"] },
      infants: { type: Number, default: 0, min: [0, "infants cannot be negative"] },
    },
    message: { type: String, maxlength: [2000, "message cannot exceed 2000 chars"], trim: true },
    status: { type: String, enum: ENQUIRY_STATUS, default: "new", index: true },
  },
  { timestamps: true, strict: true },
);

hotelEnquirySchema.index({ partner: 1, status: 1 });
hotelEnquirySchema.index({ createdAt: -1 });

hotelEnquirySchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type HotelEnquiryDoc = HydratedDocument<IHotelEnquiry>;
export const HotelEnquiryModel = model<IHotelEnquiry>("HotelEnquiry", hotelEnquirySchema);
