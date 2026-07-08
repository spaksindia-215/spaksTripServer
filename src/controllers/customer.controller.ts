import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { BookingModel } from "../models/Booking";
import { UserModel } from "../models/User";
import { ServiceEnquiryModel } from "../models/partner/ServiceEnquiry";
import { SERVICE_VERTICALS } from "../models/partner/_shared/enums";
import { HttpError } from "../middleware/error";
import { env } from "../config/env";

function ownerIdFrom(req: Request): string {
  if (!req.user) throw new HttpError(401, "Unauthorized");
  return req.user.sub;
}

function paramId(req: Request): string {
  const id = typeof req.params.id === "string" ? req.params.id : "";
  if (!mongoose.isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  return id;
}

// Reveal only the last 4 digits of the Aadhaar; the raw value never leaves here.
function maskAadhar(aadhar: string): string {
  const digits = aadhar.replace(/\D/g, "");
  if (digits.length < 4) return "••••";
  return `•••• •••• ${digits.slice(-4)}`;
}

export async function listBookings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerId = ownerIdFrom(req);
    const items = await BookingModel.find({ ownerId }).sort({ createdAt: -1 });
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

// GET /api/customer/enquiries?vertical=sightseeing — the customer's "My Enquiries"
// list across the new partner-service modules (enquiry-first leads). Optional
// ?vertical narrows to one module.
export async function listEnquiries(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerId = ownerIdFrom(req);
    const filter: Record<string, unknown> = { customer: ownerId };
    const vertical = typeof req.query.vertical === "string" ? req.query.vertical : "";
    if (vertical && (SERVICE_VERTICALS as readonly string[]).includes(vertical)) filter.vertical = vertical;
    const items = await ServiceEnquiryModel.find(filter)
      .sort({ createdAt: -1 })
      .populate("listing", "title slug images");
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

// Hotel bookings are actually confirmed/vouchered by TBO at booking time (see
// the Next.js /api/hotels/razorpay/verify-payment flow), so a cancellation
// must reach TBO's SendChangeRequest API — merely flagging cancelRequestedAt
// here never did that (TBO certification: "not receiving the request"). The
// TBO BookingId isn't stored on this document; `pnr` holds TBO's BookingRefNo
// (set from the same tboResult.bookingRefNo as hotel_payment_records.tboBookingRefNo),
// so we resolve it back to a BookingId on the Next.js side, which owns the TBO
// hotel adapter and the hotel_payment_records collection.
async function cancelHotelBookingWithTbo(bookingRefNo: string, remarks?: string): Promise<void> {
  const res = await fetch(new URL("/api/internal/hotels/cancel-by-ref", env.clientOrigin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookingRefNo, remarks }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new HttpError(502, body?.error || `TBO cancel failed (HTTP ${res.status})`);
  }
}

export async function requestCancel(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerId = ownerIdFrom(req);
    const id = paramId(req);
    // Only active/held bookings can be cancel-requested, and only the owner's own.
    const existing = await BookingModel.findOne({
      _id: id,
      ownerId,
      status: { $in: ["active", "held"] },
    });
    if (!existing) throw new HttpError(404, "Booking not found or not cancellable");

    // Hotel bookings must be confirmed with TBO before we record the cancellation —
    // never mark it cancelled just because our own DB update succeeded.
    if (existing.productType === "hotel" && existing.pnr) {
      await cancelHotelBookingWithTbo(existing.pnr, req.body?.remarks);
    }

    const booking = await BookingModel.findOneAndUpdate(
      { _id: id, ownerId },
      {
        $set: {
          cancelRequestedAt: new Date(),
          ...(existing.productType === "hotel" && existing.pnr ? { status: "cancelled" } : {}),
        },
      },
      { new: true },
    );
    if (!booking) throw new HttpError(404, "Booking not found or not cancellable");
    res.json({ booking: booking.toJSON() });
  } catch (e) {
    next(e);
  }
}

export async function getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerId = ownerIdFrom(req);
    const user = await UserModel.findById(ownerId);
    if (!user) throw new HttpError(404, "User not found");
    res.json({
      profile: {
        id: String(user._id),
        name: user.name,
        phone: user.phone,
        email: user.email,
        role: user.role,
        status: user.status,
        aadharMasked: maskAadhar(user.aadhar),
        createdAt: user.createdAt,
      },
    });
  } catch (e) {
    next(e);
  }
}
