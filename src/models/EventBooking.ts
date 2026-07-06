import { Schema, model, Types, HydratedDocument } from "mongoose";
import { randomBytes } from "crypto";
import {
  EVENT_BOOKING_STATUS,
  EVENT_PAYMENT_STATUS,
  EVENT_REFUND_STATUS,
  EVENT_BOOKING_SOURCE,
  CURRENCY_CODES,
  type EventBookingStatus,
  type EventPaymentStatus,
  type EventRefundStatus,
  type EventBookingSource,
  type CurrencyCode,
} from "./partner/_shared/enums";

// Per-customer event booking. Mongo holds the fast-read booking record; the
// authoritative financial record is written to PostgreSQL via transactionService
// (resource_type: 'event_booking'), exactly like the flight/hotel flows. Pricing
// is ALWAYS server-computed from EventListing.tickets — the client only sends
// { ticketTypeId, quantity }.

export interface EventBookingTicket {
  ticketTypeId: Types.ObjectId; // → EventListing.tickets._id
  ticketName: string; // snapshot at booking time
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

export interface EventBookingAttendee {
  name: string;
  email?: string;
  phone?: string;
  age?: number;
}

export interface IEventBooking {
  user: Types.ObjectId;
  event: Types.ObjectId;
  bookingReference: string;
  tickets: EventBookingTicket[];
  attendees: EventBookingAttendee[];
  // pricing (server-computed)
  subtotal: number;
  platformFee: number;
  gst: number;
  totalAmount: number;
  currency: CurrencyCode;
  // agent context
  agent?: Types.ObjectId;
  agentMarkup: number;
  customerPaid?: number;
  // payment
  paymentStatus: EventPaymentStatus;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  paidAt?: Date;
  // soft-hold lifecycle: inventory reserved until this instant unless paid
  holdExpiresAt?: Date;
  // booking status
  status: EventBookingStatus;
  cancelledAt?: Date;
  cancellationReason?: string;
  refundAmount?: number;
  refundStatus: EventRefundStatus;
  // QR / check-in
  qrCode?: string;
  checkedInAt?: Date;
  // 24h-before reminder de-dupe (set by the reminder worker)
  reminderSentAt?: Date;
  // metadata
  bookedAt: Date;
  source: EventBookingSource;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
  updatedAt: Date;
}

const bookingTicketSchema = new Schema<EventBookingTicket>(
  {
    ticketTypeId: { type: Schema.Types.ObjectId, required: true },
    ticketName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: [1, "quantity must be at least 1"] },
    unitPrice: { type: Number, required: true, min: [0, "unitPrice cannot be negative"] },
    subtotal: { type: Number, required: true, min: [0, "subtotal cannot be negative"] },
  },
  { _id: false },
);

const attendeeSchema = new Schema<EventBookingAttendee>(
  {
    name: { type: String, required: [true, "attendee name is required"], trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    age: { type: Number, min: [0, "age cannot be negative"] },
  },
  { _id: false },
);

const eventBookingSchema = new Schema<IEventBooking>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: [true, "user is required"], index: true },
    event: { type: Schema.Types.ObjectId, ref: "EventListing", required: [true, "event is required"], index: true },
    bookingReference: { type: String, unique: true, trim: true },
    tickets: { type: [bookingTicketSchema], default: [] },
    attendees: { type: [attendeeSchema], default: [] },
    subtotal: { type: Number, required: true, min: 0 },
    platformFee: { type: Number, default: 0, min: 0 },
    gst: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: CURRENCY_CODES, default: "INR" },
    agent: { type: Schema.Types.ObjectId, ref: "User", default: undefined },
    agentMarkup: { type: Number, default: 0, min: 0 },
    customerPaid: { type: Number, min: 0 },
    paymentStatus: { type: String, enum: EVENT_PAYMENT_STATUS, default: "pending", index: true },
    razorpayOrderId: { type: String, trim: true, index: true },
    razorpayPaymentId: { type: String, trim: true },
    paidAt: { type: Date },
    holdExpiresAt: { type: Date },
    status: { type: String, enum: EVENT_BOOKING_STATUS, default: "pending", index: true },
    cancelledAt: { type: Date },
    cancellationReason: { type: String, trim: true },
    refundAmount: { type: Number, min: 0 },
    refundStatus: { type: String, enum: EVENT_REFUND_STATUS, default: "not_applicable" },
    qrCode: { type: String, trim: true },
    checkedInAt: { type: Date },
    reminderSentAt: { type: Date },
    bookedAt: { type: Date, default: Date.now },
    source: { type: String, enum: EVENT_BOOKING_SOURCE, default: "web" },
    ipAddress: { type: String, trim: true },
    userAgent: { type: String, trim: true },
  },
  { timestamps: true, strict: true },
);

// ── Indexes (instruct.md Step 1.3) ───────────────────────────────────────────
eventBookingSchema.index({ user: 1, status: 1 });
eventBookingSchema.index({ event: 1, status: 1 });
eventBookingSchema.index({ agent: 1, status: 1 });

// Auto-generate a human booking reference: EVT-XXXXXX (uppercase hex).
eventBookingSchema.pre("validate", function (next) {
  if (!this.bookingReference) {
    this.bookingReference = `EVT-${randomBytes(4).toString("hex").toUpperCase()}`;
  }
  next();
});

eventBookingSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type EventBookingDoc = HydratedDocument<IEventBooking>;
export const EventBookingModel = model<IEventBooking>("EventBooking", eventBookingSchema);
