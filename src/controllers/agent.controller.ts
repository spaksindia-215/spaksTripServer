import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { BookingModel, BOOKING_STATUSES, type BookingStatus } from "../models/Booking";
import { UserModel, type Role, MARKUP_TYPES, type MarkupRule } from "../models/User";
import { validateBookingCreate } from "../validators/agent.validators";
import { HttpError } from "../middleware/error";
import { invalidateAgentCache } from "../lib/agentCache";
import { uploadToCloudinary, type UploadedFile } from "../lib/cloudinary";

// Strip fields the agent must never see (platform-tier pricing internals).
// Called on every booking returned by agent-facing endpoints.
function toAgentBooking(doc: { toJSON(): Record<string, unknown> }): Record<string, unknown> {
  const obj = doc.toJSON();
  delete obj.tboFare;
  delete obj.platformMarkup;
  return obj;
}

function ownerIdFrom(req: Request): string {
  if (!req.user) throw new HttpError(401, "Unauthorized");
  return req.user.sub;
}

function ownerRoleFrom(req: Request): Role {
  if (!req.user) throw new HttpError(401, "Unauthorized");
  return req.user.role;
}

function paramId(req: Request): string {
  const id = typeof req.params.id === "string" ? req.params.id : "";
  if (!mongoose.isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  return id;
}

// Lazily expire held bookings whose window has passed (on-read enforcement).
// This also frees the credit those holds were consuming.
async function sweepExpiredHolds(ownerId: string): Promise<void> {
  await BookingModel.updateMany(
    { ownerId, status: "held", holdExpiresAt: { $lte: new Date() } },
    { $set: { status: "cancelled" } },
  );
}

// Outstanding credit consumed by live holds.
async function creditUsed(ownerId: string): Promise<number> {
  const rows = await BookingModel.aggregate<{ total: number }>([
    { $match: { ownerId: new mongoose.Types.ObjectId(ownerId), status: "held" } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  return rows[0]?.total ?? 0;
}

export async function listBookings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerId = ownerIdFrom(req);
    await sweepExpiredHolds(ownerId);

    const filter: Record<string, unknown> = { ownerId };
    const { status } = req.query;
    if (typeof status === "string" && status.length > 0) {
      if (!(BOOKING_STATUSES as readonly string[]).includes(status)) {
        throw new HttpError(400, `status must be one of: ${BOOKING_STATUSES.join(", ")}`);
      }
      filter.status = status as BookingStatus;
    }

    const items = await BookingModel.find(filter).sort({ createdAt: -1 });
    res.json({ items: items.map(toAgentBooking) });
  } catch (e) {
    next(e);
  }
}

export async function createBooking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerId = ownerIdFrom(req);
    const ownerRole = ownerRoleFrom(req);
    const input = validateBookingCreate(req.body);

    // Holds consume credit — enforce the per-agent limit.
    if (input.status === "held") {
      await sweepExpiredHolds(ownerId);
      const user = await UserModel.findById(ownerId);
      if (!user) throw new HttpError(401, "User not found");
      if (user.creditLimit == null) {
        throw new HttpError(403, "Your credit limit hasn't been set yet. Please contact admin.");
      }
      const used = await creditUsed(ownerId);
      if (used + input.amount > user.creditLimit) {
        const available = Math.max(0, user.creditLimit - used);
        throw new HttpError(403, `Hold exceeds available credit (₹${available} remaining)`);
      }
    }

    const isAgentRole = ownerRole === "agent" || ownerRole === "b2b_agent";

    const booking = await BookingModel.create({
      ownerId,
      ownerRole,
      productType: input.productType,
      status: input.status,
      pnr: input.pnr,
      amount: input.amount,
      currency: input.currency ?? "INR",
      holdExpiresAt:
        input.status === "held" ? new Date(Date.now() + input.holdMinutes * 60_000) : undefined,
      details: input.details,
      // Attribution — stamped for agent portal bookings.
      // tboFare/platformMarkup are unavailable in the manual booking flow;
      // agentMarkup=0 because agents apply their customer markup offline.
      ...(isAgentRole ? {
        agentId:      new mongoose.Types.ObjectId(ownerId),
        netFare:      input.amount,
        agentMarkup:  0,
        customerPaid: input.amount,
      } : {}),
    });

    res.status(201).json({ booking: toAgentBooking(booking) });
  } catch (e) {
    next(e);
  }
}

// Transition a held booking to confirmed ("active").
export async function confirmHold(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerId = ownerIdFrom(req);
    const id = paramId(req);
    const booking = await BookingModel.findOneAndUpdate(
      { _id: id, ownerId, status: "held", holdExpiresAt: { $gt: new Date() } },
      { $set: { status: "active" }, $unset: { holdExpiresAt: "" } },
      { new: true },
    );
    if (!booking) throw new HttpError(404, "Active hold not found (it may have expired)");
    res.json({ booking: toAgentBooking(booking) });
  } catch (e) {
    next(e);
  }
}

// Cancel an active booking or release a held one.
export async function cancelBooking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerId = ownerIdFrom(req);
    const id = paramId(req);
    const booking = await BookingModel.findOneAndUpdate(
      { _id: id, ownerId, status: { $in: ["active", "held"] } },
      { $set: { status: "cancelled" } },
      { new: true },
    );
    if (!booking) throw new HttpError(404, "Booking not found or not cancellable");
    res.json({ booking: toAgentBooking(booking) });
  } catch (e) {
    next(e);
  }
}

export async function lookupPnr(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerId = ownerIdFrom(req);
    const pnr = typeof req.params.pnr === "string" ? req.params.pnr.trim() : "";
    if (!pnr) throw new HttpError(400, "PNR is required");
    const booking = await BookingModel.findOne({ ownerId, pnr });
    if (!booking) throw new HttpError(404, "No booking found for that PNR");
    res.json({ booking: toAgentBooking(booking) });
  } catch (e) {
    next(e);
  }
}

export async function getMarkup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerId = ownerIdFrom(req);
    const user = await UserModel.findById(ownerId).select("markup");
    if (!user) throw new HttpError(404, "User not found");
    res.json({ markup: user.markup ?? null });
  } catch (e) {
    next(e);
  }
}

function isMarkupRuleBody(v: unknown): v is { type: string; value: number; cap?: number } {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.type === "string" &&
    (MARKUP_TYPES as readonly string[]).includes(o.type) &&
    typeof o.value === "number" &&
    o.value >= 0 &&
    (o.cap === undefined || (typeof o.cap === "number" && o.cap >= 0))
  );
}

export async function updateMarkup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerId = ownerIdFrom(req);
    const body = req.body as Record<string, unknown>;

    const updates: Partial<Record<"flights" | "hotels" | "taxi", MarkupRule>> = {};

    for (const key of ["flights", "hotels", "taxi"] as const) {
      if (body[key] !== undefined) {
        if (!isMarkupRuleBody(body[key])) {
          throw new HttpError(400, `Invalid markup rule for ${key}`);
        }
        const rule = body[key] as { type: string; value: number; cap?: number };
        const markupType = rule.type as MarkupRule["type"];

        if (markupType === "percent" && rule.value > 30) {
          throw new HttpError(400, `Percent markup for ${key} cannot exceed 30%`);
        }
        if (markupType === "flat" && rule.value > 5000) {
          throw new HttpError(400, `Flat markup for ${key} cannot exceed ₹5000`);
        }

        updates[key] = {
          type: markupType,
          value: rule.value,
          ...(rule.cap != null ? { cap: rule.cap } : {}),
        };
      }
    }

    if (Object.keys(updates).length === 0) {
      throw new HttpError(400, "Provide at least one of: flights, hotels, taxi");
    }

    const setFields = Object.fromEntries(
      Object.entries(updates).map(([k, v]) => [`markup.${k}`, v]),
    );

    const user = await UserModel.findByIdAndUpdate(
      ownerId,
      { $set: setFields },
      { new: true, runValidators: true },
    ).select("markup slug");

    if (!user) throw new HttpError(404, "User not found");

    // Invalidate agent config cache so the next subdomain request re-fetches markup.
    if (user.slug) invalidateAgentCache(user.slug);

    res.json({ markup: user.markup ?? null });
  } catch (e) {
    next(e);
  }
}

export async function getBranding(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerId = ownerIdFrom(req);
    const user = await UserModel.findById(ownerId).select("slug branding name role");
    if (!user) throw new HttpError(404, "User not found");

    let slug = user.slug ?? null;

    // Lazy slug generation — covers agents created via findOneAndUpdate (seed/admin)
    // where the pre-save hook never fired.
    if (!slug && (user.role === "agent" || user.role === "b2b_agent")) {
      const base = slugifyForController(user.name);
      const hex  = crypto.randomBytes(3).toString("hex");
      slug = `${base}-${hex}`;
      await UserModel.updateOne({ _id: user._id, slug: { $exists: false } }, { $set: { slug } });
    }

    res.json({ slug, branding: user.branding ?? null });
  } catch (e) {
    next(e);
  }
}

function slugifyForController(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

export async function updateBranding(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerId = ownerIdFrom(req);
    const body = req.body as Record<string, string>;

    const setOps: Record<string, unknown> = {};
    const unsetOps: Record<string, ""> = {};

    const textField = (key: string, maxLen: number, dotPath: string) => {
      if (body[key] === undefined) return;
      const val = body[key].trim();
      if (val.length > maxLen) throw new HttpError(400, `${key} max ${maxLen} characters`);
      if (val) setOps[dotPath] = val;
      else unsetOps[dotPath] = "";
    };

    textField("companyName",  100, "branding.companyName");
    textField("tagline",      120, "branding.tagline");
    textField("contactEmail",  80, "branding.contactEmail");
    textField("contactPhone",  30, "branding.contactPhone");

    if (body.primaryColor !== undefined) {
      if (!/^#[0-9A-Fa-f]{6}$/.test(body.primaryColor)) {
        throw new HttpError(400, "primaryColor must be a 6-digit hex e.g. #185FA5");
      }
      setOps["branding.primaryColor"] = body.primaryColor;
    }

    if (req.file) {
      const logoUrl = await uploadToCloudinary(req.file as unknown as UploadedFile, "agent-logos");
      setOps["branding.logo"] = logoUrl;
    }

    if (Object.keys(setOps).length === 0 && Object.keys(unsetOps).length === 0) {
      throw new HttpError(400, "Provide at least one branding field to update");
    }

    const update: Record<string, unknown> = {};
    if (Object.keys(setOps).length > 0) update.$set = setOps;
    if (Object.keys(unsetOps).length > 0) update.$unset = unsetOps;

    const user = await UserModel.findByIdAndUpdate(ownerId, update, {
      new: true,
      runValidators: true,
    }).select("slug branding");

    if (!user) throw new HttpError(404, "User not found");

    if (user.slug) invalidateAgentCache(user.slug);

    res.json({ branding: user.branding ?? null });
  } catch (e) {
    next(e);
  }
}

export async function getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerId = ownerIdFrom(req);
    await sweepExpiredHolds(ownerId);
    const user = await UserModel.findById(ownerId);
    if (!user) throw new HttpError(404, "User not found");

    const used = await creditUsed(ownerId);
    const limit = user.creditLimit;
    res.json({
      profile: {
        id: String(user._id),
        name: user.name,
        phone: user.phone,
        email: user.email,
        role: user.role,
        status: user.status,
        kyc: {
          aadharProvided: Boolean(user.aadhar),
          gst: user.gst ?? null,
          pan: user.pan ?? null,
        },
        slug: user.slug ?? null,
        creditLimit: limit,
        creditUsed: used,
        creditAvailable: limit != null ? Math.max(0, limit - used) : null,
        walletBalance: user.walletBalance,
      },
    });
  } catch (e) {
    next(e);
  }
}
