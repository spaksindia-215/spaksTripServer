import { Request, Response, NextFunction } from "express";
import mongoose, { Types } from "mongoose";
import { SightseeingListingModel, type SightseeingListingDoc } from "../models/partner/SightseeingListing";
import { ServiceEnquiryModel, type ServiceEnquiryDoc } from "../models/partner/ServiceEnquiry";
import { validateSightseeingListing } from "../validators/sightseeingListing.validators";
import { uploadManyToCloudinary } from "../lib/cloudinary";
import { resolveOptionalUser } from "../middleware/auth";
import { HttpError } from "../middleware/error";
import {
  RESOURCE_STATUS,
  ENQUIRY_STATUS,
  SIGHTSEEING_CATEGORIES,
  OPERATING_DAYS,
  type ResourceStatus,
  type EnquiryStatus,
} from "../models/partner/_shared/enums";

// SightSeeing endpoints across two permission tiers (admin moderation is handled by
// the shared moderation registry, so there is no admin tier here):
//   • PARTNER  (/api/partner/sightseeing) — own listings + leads routed to them
//   • PUBLIC   (/api/sightseeing)         — browse, detail, submit enquiry
// Follows packages.controller conventions: try/catch → next(e), HttpError for client
// errors, toJSON for output.

const VERTICAL = "sightseeing" as const;
const PARTNER_FIELDS = "name companyName email phone slug";

// ── Shared helpers ─────────────────────────────────────────────────────────────
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

// Create/update arrive as multipart: the whole body is a JSON string in a `data`
// field, with image files under `images`. Falls back to the parsed body for JSON.
function listingBody(req: Request): Record<string, unknown> {
  const raw = (req.body as Record<string, unknown>)?.data;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      throw new HttpError(400, "data must be valid JSON");
    }
  }
  return (req.body as Record<string, unknown>) ?? {};
}

async function uploadImages(req: Request): Promise<string[]> {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const toUpload = files.filter((f) => f.fieldname === "images");
  if (toUpload.length === 0) return [];
  return uploadManyToCloudinary(toUpload, "spakstrip/sightseeing");
}

function paginate(q: Record<string, unknown>): { page: number; limit: number; skip: number } {
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(q.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

// ════════════════════════════════════════════════════════════════════════════
// PARTNER  (/api/partner/sightseeing — auth + role "partner")
// ════════════════════════════════════════════════════════════════════════════

export async function partnerCreate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const partnerId = userIdFrom(req);
    const imageUrls = await uploadImages(req);
    const input = validateSightseeingListing(listingBody(req));
    const doc = await SightseeingListingModel.create({
      ...input,
      partner: partnerId,
      status: "draft", // partners submit for review; admin approval flips to active
      images: imageUrls.map((url, i) => ({ url, isPrimary: i === 0 })),
    });
    res.status(201).json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

export async function partnerListMine(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const partnerId = userIdFrom(req);
    const items = await SightseeingListingModel.find({ partner: partnerId }).sort({ createdAt: -1 });
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

async function ownedListing(req: Request): Promise<SightseeingListingDoc> {
  const partnerId = userIdFrom(req);
  const id = paramStr(req.params.id);
  ensureValidId(id);
  const doc = await SightseeingListingModel.findById(id);
  if (!doc) throw new HttpError(404, "Activity not found");
  if (String(doc.partner) !== partnerId) throw new HttpError(403, "Forbidden");
  return doc;
}

export async function partnerGet(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ item: (await ownedListing(req)).toJSON() });
  } catch (e) {
    next(e);
  }
}

export async function partnerUpdate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await ownedListing(req);
    const newImages = await uploadImages(req);
    const input = validateSightseeingListing(listingBody(req));
    const prevStatus = doc.status; // a field edit never changes approval state (§2.3)
    Object.assign(doc, input);
    doc.status = prevStatus; // publishing goes through submit → admin approval, not this edit
    if (newImages.length > 0) {
      doc.images = newImages.map((url, i) => ({ url, isPrimary: i === 0 }));
    }
    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

export async function partnerSetStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await ownedListing(req);
    const target = (req.body as Record<string, unknown>)?.status;
    // Partners may pause/unpause/archive their own listings, but never self-approve
    // to "active" (that is reserved for admin via the moderation queue) or "pending"
    // (use the dedicated submit-for-review action).
    const allowed: ResourceStatus[] = ["draft", "paused", "suspended"];
    if (typeof target !== "string" || !(allowed as readonly string[]).includes(target)) {
      throw new HttpError(400, `status must be one of: ${allowed.join(", ")}`);
    }
    if (doc.status === "active" && target !== "paused" && target !== "suspended") {
      throw new HttpError(409, "An active listing can only be paused or suspended");
    }
    doc.status = target as ResourceStatus;
    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

export async function partnerDelete(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await ownedListing(req);
    doc.status = "suspended"; // soft-delete: hide from public, keep leads intact
    await doc.save();
    res.status(204).end();
  } catch (e) {
    next(e);
  }
}

// ── Enquiries (leads routed to this partner) ─────────────────────────────────────
export async function partnerListEnquiries(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const partnerId = userIdFrom(req);
    const filter: Record<string, unknown> = { partner: partnerId, vertical: VERTICAL };
    const { status } = req.query;
    if (typeof status === "string" && (ENQUIRY_STATUS as readonly string[]).includes(status)) filter.status = status;
    const items = await ServiceEnquiryModel.find(filter)
      .sort({ createdAt: -1 })
      .populate("listing", "title slug");
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
    const doc = await ServiceEnquiryModel.findById(id);
    if (!doc || doc.vertical !== VERTICAL) throw new HttpError(404, "Enquiry not found");
    if (String(doc.partner) !== partnerId) throw new HttpError(403, "Forbidden");
    applyEnquiryUpdate(doc, req.body);
    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

function applyEnquiryUpdate(doc: ServiceEnquiryDoc, raw: unknown): void {
  const body = (raw ?? {}) as Record<string, unknown>;
  if (typeof body.status === "string") {
    if (!(ENQUIRY_STATUS as readonly string[]).includes(body.status)) {
      throw new HttpError(400, `status must be one of: ${ENQUIRY_STATUS.join(", ")}`);
    }
    doc.status = body.status as EnquiryStatus;
  }
  if (typeof body.note === "string" && body.note.trim()) {
    doc.internalNotes.push({ at: new Date(), text: body.note.trim() });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC  (/api/sightseeing — no auth; enquiry allows guest or customer)
// ════════════════════════════════════════════════════════════════════════════

export async function publicBrowse(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = req.query as Record<string, unknown>;
    const filter: Record<string, unknown> = { status: "active" };
    if (typeof q.island === "string" && q.island.trim()) {
      filter["location.island"] = new RegExp(q.island.trim(), "i");
    }
    if (typeof q.category === "string" && (SIGHTSEEING_CATEGORIES as readonly string[]).includes(q.category)) {
      filter.category = q.category;
    }
    if (typeof q.day === "string" && (OPERATING_DAYS as readonly string[]).includes(q.day)) {
      filter.availableDays = q.day;
    }
    if (typeof q.q === "string" && q.q.trim()) filter.$text = { $search: q.q.trim() };

    // Price filter (against the adult fare, the headline price for per-person tours).
    const minPrice = Number(q.minPrice);
    const maxPrice = Number(q.maxPrice);
    const priceFilter: Record<string, number> = {};
    if (Number.isFinite(minPrice)) priceFilter.$gte = minPrice;
    if (Number.isFinite(maxPrice)) priceFilter.$lte = maxPrice;
    if (Object.keys(priceFilter).length > 0) filter["pricing.adult"] = priceFilter;

    const sortMap: Record<string, Record<string, 1 | -1>> = {
      price_asc: { "pricing.adult": 1 },
      price_desc: { "pricing.adult": -1 },
      newest: { createdAt: -1 },
    };
    const sort = sortMap[String(q.sort)] ?? { createdAt: -1 };

    const { page, limit, skip } = paginate(q);
    const [docs, total] = await Promise.all([
      SightseeingListingModel.find(filter).sort(sort).skip(skip).limit(limit),
      SightseeingListingModel.countDocuments(filter),
    ]);
    res.json({
      items: docs.map((d) => d.toJSON()),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (e) {
    next(e);
  }
}

// GET /api/sightseeing/categories — active-listing counts per category (for nav/filter).
export async function publicCategories(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await SightseeingListingModel.aggregate<{ _id: string; count: number }>([
      { $match: { status: "active" } },
      { $group: { _id: "$category", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    res.json({ items: rows.map((r) => ({ category: r._id, count: r.count })) });
  } catch (e) {
    next(e);
  }
}

export async function publicGetDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await SightseeingListingModel.findOne({ slug: paramStr(req.params.slug), status: "active" })
      .populate("partner", PARTNER_FIELDS);
    if (!doc) throw new HttpError(404, "Activity not found");
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// POST /api/sightseeing/:slug/enquire — create a lead against an active listing.
export async function publicSubmitEnquiry(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const listing = await SightseeingListingModel.findOne({ slug: paramStr(req.params.slug), status: "active" });
    if (!listing) throw new HttpError(404, "Activity not found");

    const body = (req.body ?? {}) as Record<string, unknown>;
    const contactRaw = isObject(body.contact) ? (body.contact as Record<string, unknown>) : body;
    const name = typeof contactRaw.name === "string" ? contactRaw.name.trim() : "";
    const phone = typeof contactRaw.phone === "string" ? contactRaw.phone.trim() : "";
    if (!name) throw new HttpError(400, "contact name is required");
    if (!phone) throw new HttpError(400, "contact phone is required");

    const paxRaw = isObject(body.pax) ? (body.pax as Record<string, unknown>) : {};
    const num = (v: unknown, fallback: number): number => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    let travelDate: Date | undefined;
    if (typeof body.travelDate === "string" && body.travelDate.trim()) {
      const d = new Date(body.travelDate);
      if (!Number.isNaN(d.getTime())) travelDate = d;
    }

    const user = resolveOptionalUser(req); // guests allowed; attribute if logged in
    const doc = await ServiceEnquiryModel.create({
      vertical: VERTICAL,
      listing: listing._id,
      partner: listing.partner,
      ...(user ? { customer: new Types.ObjectId(user.sub) } : {}),
      contact: {
        name,
        phone,
        email: typeof contactRaw.email === "string" ? contactRaw.email.trim() : undefined,
      },
      travelDate,
      pax: {
        adults: num(paxRaw.adults, 1),
        children: num(paxRaw.children, 0),
        infants: num(paxRaw.infants, 0),
      },
      message: typeof body.message === "string" ? body.message.trim() : undefined,
      details: isObject(body.details) ? body.details : {},
    });
    res.status(201).json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
