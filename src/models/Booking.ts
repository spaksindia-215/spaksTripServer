import { Schema, model, Types, HydratedDocument } from "mongoose";
import { ROLES, type Role } from "./User";
import type { AnyBookingDetails } from "./bookingDetails";

export const PRODUCT_TYPES = ["flight", "hotel", "taxi", "tour", "cruise", "package"] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const BOOKING_STATUSES = ["active", "held", "cancelled", "completed"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export interface IBooking {
  // Absent on guest bookings until claimed — see claimEmail below.
  ownerId?: Types.ObjectId;
  ownerRole: Role;
  // Set on GUEST bookings (no account yet): the contact email the trip was booked
  // with, lowercased. When someone later registers/logs in with a verified email
  // matching this, the booking is claimed (ownerId set, claimEmail cleared).
  claimEmail?: string;
  // Inventory owner (the partner whose listing was booked), when applicable.
  partnerId?: Types.ObjectId;
  productType: ProductType;
  status: BookingStatus;
  pnr?: string;
  amount: number;
  currency: string;
  holdExpiresAt?: Date;
  cancelRequestedAt?: Date;
  details: AnyBookingDetails;
  // Agent attribution — only present when an agent/b2b_agent creates the booking.
  agentId?: Types.ObjectId;
  tboFare?: number;        // TBO raw fare — stored for settlement audit, never sent to browser
  platformMarkup?: number; // platform cut (₹) — stored for settlement audit
  netFare?: number;        // agentNetRate: tboFare + platformMarkup
  agentMarkup?: number;    // agent's cut (₹)
  customerPaid?: number;
  createdAt: Date;
  updatedAt: Date;
}

const bookingSchema = new Schema<IBooking>(
  {
    // Owner scoping — every query filters by ownerId for data isolation.
    // Optional: a guest booking has no owner until it's claimed by email.
    ownerId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    ownerRole: { type: String, enum: ROLES, required: true },
    claimEmail: { type: String, trim: true, lowercase: true },
    partnerId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    productType: { type: String, enum: PRODUCT_TYPES, required: true },
    status: { type: String, enum: BOOKING_STATUSES, required: true, default: "active" },
    pnr: { type: String, trim: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "INR", trim: true },
    holdExpiresAt: { type: Date },
    cancelRequestedAt: { type: Date },
    details: { type: Schema.Types.Mixed, default: {} },
    agentId:        { type: Schema.Types.ObjectId, ref: "User" },
    tboFare:        { type: Number, min: 0 },
    platformMarkup: { type: Number, min: 0 },
    netFare:        { type: Number, min: 0 },
    agentMarkup:    { type: Number, min: 0 },
    customerPaid:   { type: Number, min: 0 },
  },
  { timestamps: true },
);

bookingSchema.index({ ownerId: 1, status: 1 });
bookingSchema.index({ agentId: 1, createdAt: -1 });
// Sparse — only guest bookings carry claimEmail; powers the claim-on-login lookup.
bookingSchema.index({ claimEmail: 1 }, { sparse: true });

bookingSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type BookingDoc = HydratedDocument<IBooking>;
export const BookingModel = model<IBooking>("Booking", bookingSchema);
