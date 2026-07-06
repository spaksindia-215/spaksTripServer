import { Request, Response, NextFunction } from "express";
import mongoose, { Types } from "mongoose";
import { HotelListingModel } from "../models/partner/HotelListing";
import { HotelEnquiryModel } from "../models/partner/HotelEnquiry";
import { UserModel } from "../models/User";
import { resolveOptionalUser } from "../middleware/auth";
import { sendMail } from "../lib/mailer";
import { HttpError } from "../middleware/error";

// Escape user input before using it inside a RegExp (city match is by name).
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function paramStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// GET /api/partner-hotels?city=<name> — active partner hotel listings for the
// given city, newest first. City is matched on the free-text address.city by
// name (the public search passes the resolved city name, not a TBO code).
export async function publicSearchPartnerHotels(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const city = paramStr(req.query.city).trim();
    const filter: Record<string, unknown> = { status: "active" };
    if (city) {
      filter["address.city"] = new RegExp(`^${escapeRegex(city)}$`, "i");
    }

    const items = await HotelListingModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(50)
      .select(
        "name slug type starRating description address coordinates amenities images rooms pricing contact policies",
      );

    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

// POST /api/partner-hotels/:id/enquire — guest or logged-in customer enquiry.
// Stores a lead and emails the partner so it is actionable without a dashboard.
export async function publicCreateHotelEnquiry(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = paramStr(req.params.id);
    if (!mongoose.isValidObjectId(id)) throw new HttpError(400, "Invalid hotel id");

    const hotel = await HotelListingModel.findOne({ _id: id, status: "active" });
    if (!hotel) throw new HttpError(404, "Hotel not found");

    const body = (req.body ?? {}) as Record<string, unknown>;
    const contact = (body.contact ?? {}) as Record<string, unknown>;
    const name = typeof contact.name === "string" ? contact.name.trim() : "";
    const phone = typeof contact.phone === "string" ? contact.phone.trim() : "";
    const email = typeof contact.email === "string" ? contact.email.trim() : "";
    if (!name) throw new HttpError(400, "contact.name is required");
    if (!phone) throw new HttpError(400, "contact.phone is required");

    const paxIn = (body.pax ?? {}) as Record<string, unknown>;
    const toCount = (v: unknown, fallback: number): number => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
    };
    const pax = {
      adults: toCount(paxIn.adults, 1),
      children: toCount(paxIn.children, 0),
      infants: toCount(paxIn.infants, 0),
    };

    const parseDate = (v: unknown): Date | undefined => {
      if (typeof v !== "string" || !v) return undefined;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? undefined : d;
    };
    const checkIn = parseDate(body.checkIn);
    const checkOut = parseDate(body.checkOut);
    const message = typeof body.message === "string" ? body.message.trim().slice(0, 2000) : undefined;

    const user = resolveOptionalUser(req); // guests allowed; attribute if logged in

    const doc = await HotelEnquiryModel.create({
      hotel: hotel._id,
      partner: hotel.partner,
      ...(user ? { customer: new Types.ObjectId(user.sub) } : {}),
      contact: { name, phone, email: email || undefined },
      checkIn,
      checkOut,
      pax,
      message,
    });

    // Best-effort partner notification — never let an email failure fail the lead.
    try {
      const partner = await UserModel.findById(hotel.partner).select("name email");
      const partnerEmail = partner?.email || hotel.contact?.email;
      if (partnerEmail) {
        const dates =
          checkIn && checkOut
            ? `${checkIn.toLocaleDateString("en-IN")} → ${checkOut.toLocaleDateString("en-IN")}`
            : "";
        await sendMail({
          to: partnerEmail,
          subject: `New enquiry for ${hotel.name}`,
          template: "hotelEnquiryReceived",
          data: {
            partnerName: partner?.name ?? "",
            hotelName: hotel.name,
            contactName: name,
            contactPhone: phone,
            contactEmail: email,
            dates,
            pax: `${pax.adults} adult(s), ${pax.children} child(ren), ${pax.infants} infant(s)`,
            message: message ?? "",
          },
        });
      }
    } catch {
      // swallow — the lead is already saved
    }

    res.status(201).json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}
