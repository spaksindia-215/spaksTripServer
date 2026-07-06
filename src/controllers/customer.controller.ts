import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { BookingModel } from "../models/Booking";
import { UserModel } from "../models/User";
import { ServiceEnquiryModel } from "../models/partner/ServiceEnquiry";
import { SERVICE_VERTICALS } from "../models/partner/_shared/enums";
import { HttpError } from "../middleware/error";

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

export async function requestCancel(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerId = ownerIdFrom(req);
    const id = paramId(req);
    // Only active/held bookings can be cancel-requested, and only the owner's own.
    const booking = await BookingModel.findOneAndUpdate(
      { _id: id, ownerId, status: { $in: ["active", "held"] } },
      { $set: { cancelRequestedAt: new Date() } },
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
