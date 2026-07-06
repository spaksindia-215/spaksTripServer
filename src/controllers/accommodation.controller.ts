import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { HotelListingModel } from "../models/partner/HotelListing";
import { HotelEnquiryModel } from "../models/partner/HotelEnquiry";
import { HttpError } from "../middleware/error";
import { HOTEL_TYPES, ENQUIRY_STATUS, type EnquiryStatus } from "../models/partner/_shared/enums";

// Customer-facing surface for PARTNER accommodation listings (the HotelListing
// collection across every accommodation type — hotel/airbnb/villa/houseboat/…).
// Normal /hotel search stays TBO-driven; this is the enquiry-first partner stays
// surface backing the navbar "Accommodation" menu. Enquiries reuse the existing
// HotelEnquiry pipeline (POST /api/partner-hotels/:id/enquire, which also emails
// the partner), so there is a single lead model + inbox.

function userIdFrom(req: Request): string {
  if (!req.user) throw new HttpError(401, "Unauthorized");
  return req.user.sub;
}
function ensureValidId(id: string): void {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(400, "Invalid id");
}
function paramStr(raw: string | string[] | undefined): string {
  return typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] ?? "" : "";
}
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function paginate(q: Record<string, unknown>): { page: number; limit: number; skip: number } {
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(q.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC  (/api/accommodation)
// ════════════════════════════════════════════════════════════════════════════

// GET /api/accommodation?type=&city=&q=&page= — active partner stays.
export async function browse(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = req.query as Record<string, unknown>;
    const filter: Record<string, unknown> = { status: "active" };
    if (typeof q.type === "string" && (HOTEL_TYPES as readonly string[]).includes(q.type)) filter.type = q.type;
    if (typeof q.city === "string" && q.city.trim()) {
      filter["address.city"] = new RegExp(`^${escapeRegex(q.city.trim())}$`, "i");
    }
    if (typeof q.q === "string" && q.q.trim()) {
      const rx = new RegExp(escapeRegex(q.q.trim()), "i");
      filter.$or = [{ name: rx }, { "address.city": rx }, { tags: rx }];
    }

    const { page, limit, skip } = paginate(q);
    const [docs, total] = await Promise.all([
      HotelListingModel.find(filter)
        .select("name slug type starRating address pricing images amenities description")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      HotelListingModel.countDocuments(filter),
    ]);
    res.json({
      items: docs.map((d) => d.toJSON()),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (e) {
    next(e);
  }
}

// GET /api/accommodation/types — active-listing counts per accommodation type.
export async function listTypes(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await HotelListingModel.aggregate<{ _id: string; count: number }>([
      { $match: { status: "active" } },
      { $group: { _id: "$type", count: { $sum: 1 } } },
    ]);
    res.json({ items: rows.map((r) => ({ type: r._id, count: r.count })) });
  } catch (e) {
    next(e);
  }
}

// GET /api/accommodation/:slug — single active listing (full detail).
export async function detail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await HotelListingModel.findOne({ slug: paramStr(req.params.slug), status: "active" });
    if (!doc) throw new HttpError(404, "Accommodation not found");
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PARTNER  (/api/partner/accommodation/enquiries — auth + role "partner")
// Surfaces the HotelEnquiry leads (created via /api/partner-hotels/:id/enquire)
// in the partner dashboard. Previously these were only emailed.
// ════════════════════════════════════════════════════════════════════════════

export async function partnerListEnquiries(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const partnerId = userIdFrom(req);
    const filter: Record<string, unknown> = { partner: partnerId };
    const { status } = req.query;
    if (typeof status === "string" && (ENQUIRY_STATUS as readonly string[]).includes(status)) filter.status = status;
    const items = await HotelEnquiryModel.find(filter)
      .sort({ createdAt: -1 })
      .populate("hotel", "name slug type");
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

export async function partnerUpdateEnquiry(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const partnerId = userIdFrom(req);
    const id = paramStr(req.params.id);
    ensureValidId(id);
    const doc = await HotelEnquiryModel.findById(id);
    if (!doc) throw new HttpError(404, "Enquiry not found");
    if (String(doc.partner) !== partnerId) throw new HttpError(403, "Forbidden");

    const body = isObject(req.body) ? req.body : {};
    if (typeof body.status === "string") {
      if (!(ENQUIRY_STATUS as readonly string[]).includes(body.status)) {
        throw new HttpError(400, `status must be one of: ${ENQUIRY_STATUS.join(", ")}`);
      }
      doc.status = body.status as EnquiryStatus;
    }
    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}
