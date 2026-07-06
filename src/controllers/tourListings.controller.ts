import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { TourListingModel } from "../models/partner/TourListing";
import { validateTourListing } from "../validators/tourListing.validators";
import { uploadManyToCloudinary } from "../lib/cloudinary";
import { HttpError } from "../middleware/error";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseJsonField(req: Request, field: string, fallback: unknown): unknown {
  const raw = (req.body as Record<string, unknown>)?.[field];
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, `${field} must be valid JSON`);
  }
}

async function uploadTourImages(files: Express.Multer.File[]): Promise<string[]> {
  return uploadManyToCloudinary(
    files.filter((f) => f.fieldname === "images"),
    "spakstrip/tour-listings",
  );
}

// ── Public ────────────────────────────────────────────────────────────────────

// GET /api/tour-listings/destinations
// Returns unique `basedIn` values from active listings with count + cover image.
export async function publicListDestinations(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const agg = await TourListingModel.aggregate([
      { $match: { status: "active" } },
      {
        $group: {
          _id: "$basedIn",
          count: { $sum: 1 },
          image: { $first: { $arrayElemAt: ["$images.url", 0] } },
          categories: { $addToSet: "$category" },
          minPrice: {
            $min: { $min: { $map: { input: "$pricing", as: "p", in: "$$p.price" } } },
          },
        },
      },
      { $sort: { count: -1, _id: 1 } },
    ]);
    res.json({
      destinations: agg.map((d) => ({
        name: d._id as string,
        count: d.count as number,
        image: d.image as string | null,
        categories: (d.categories as string[]).sort(),
        fromPrice: d.minPrice as number | null,
      })),
    });
  } catch (e) {
    next(e);
  }
}

// GET /api/tour-listings — list active listings, filterable
export async function publicListTourListings(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { destination, category, q, page = "1", limit = "20" } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = { status: "active" };

    if (destination) {
      filter.basedIn = { $regex: new RegExp(`^${escapeRegex(destination)}$`, "i") };
    }
    if (category) filter.category = category;
    if (q) filter.$text = { $search: q };

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const [items, total] = await Promise.all([
      TourListingModel.find(filter)
        .populate("partner", "name companyName")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      TourListingModel.countDocuments(filter),
    ]);

    res.json({
      items: items.map((i) => i.toJSON()),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (e) {
    next(e);
  }
}

// GET /api/tour-listings/:slug — single listing by slug (public)
export async function publicGetTourListing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { slug } = req.params;
    const doc = await TourListingModel.findOne({ slug, status: "active" }).populate(
      "partner",
      "name companyName phone email",
    );
    if (!doc) throw new HttpError(404, "Tour listing not found");
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// ── Admin ─────────────────────────────────────────────────────────────────────

// GET /api/admin/tour-listings — all listings (any status)
export async function adminListTourListings(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { status, destination } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (destination) {
      filter.basedIn = { $regex: new RegExp(`^${escapeRegex(destination)}$`, "i") };
    }
    const items = await TourListingModel.find(filter)
      .populate("partner", "name companyName email")
      .sort({ createdAt: -1 })
      .limit(200);
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

// POST /api/admin/tour-listings — admin creates a platform listing (partner = null)
export async function adminCreateTourListing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payload = parseJsonField(req, "payload", req.body);
    const fields = validateTourListing(payload);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const imageUrls = await uploadTourImages(files);

    const doc = await TourListingModel.create({
      ...fields,
      partner: null,
      images: imageUrls.map((url, i) => ({ url, isPrimary: i === 0 })),
    });
    res.status(201).json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// GET /api/admin/tour-listings/:id
export async function adminGetTourListing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw new HttpError(400, "Invalid id");
    const doc = await TourListingModel.findById(id).populate("partner", "name companyName email");
    if (!doc) throw new HttpError(404, "Tour listing not found");
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// PUT /api/admin/tour-listings/:id — admin updates any listing
export async function adminUpdateTourListing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw new HttpError(400, "Invalid id");
    const doc = await TourListingModel.findById(id);
    if (!doc) throw new HttpError(404, "Tour listing not found");

    const payload = parseJsonField(req, "payload", req.body);
    const fields = validateTourListing(payload);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const imageUrls = await uploadTourImages(files);

    Object.assign(doc, fields);
    if (imageUrls.length > 0) {
      doc.images = imageUrls.map((url, i) => ({ url, isPrimary: i === 0 }));
    }
    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// PATCH /api/admin/tour-listings/:id/status — approve / suspend / pause
export async function adminSetTourListingStatus(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw new HttpError(400, "Invalid id");
    const { status } = req.body as { status?: string };
    const ALLOWED = ["draft", "pending", "active", "paused", "suspended"] as const;
    if (!status || !ALLOWED.includes(status as (typeof ALLOWED)[number])) {
      throw new HttpError(400, `status must be one of: ${ALLOWED.join(", ")}`);
    }
    const doc = await TourListingModel.findByIdAndUpdate(
      id,
      { status },
      { new: true },
    ).populate("partner", "name companyName");
    if (!doc) throw new HttpError(404, "Tour listing not found");
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// DELETE /api/admin/tour-listings/:id
export async function adminDeleteTourListing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw new HttpError(400, "Invalid id");
    const result = await TourListingModel.findByIdAndDelete(id);
    if (!result) throw new HttpError(404, "Tour listing not found");
    res.status(204).end();
  } catch (e) {
    next(e);
  }
}
