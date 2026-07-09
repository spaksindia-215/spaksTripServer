import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { UserModel, ROLES, MARKUP_TYPES, type Role, type MarkupType, type MarkupRule } from "../models/User";
import { HotelListingModel } from "../models/partner/HotelListing";
import { RESOURCE_STATUS } from "../models/partner/_shared/enums";
import { NavbarSettingsModel } from "../models/NavbarSettings";
import { PlatformConfigModel } from "../models/PlatformConfig";
import { invalidatePlatformConfigCache } from "../lib/platformConfig";
import { HttpError } from "../middleware/error";
import { sendMail } from "../lib/mailer";
import { getOrCreateWallet, recordManualMovement, listLedger } from "../services/walletService";
import { invalidateAgentCache } from "../lib/agentCache";
import { logger } from "../lib/logger";
import {
  verifyAdminPassword,
  createAdminSessionToken,
} from "../lib/adminSession";
import { setAdminCookie, clearAdminCookie } from "../lib/cookies";

// Credit limit bounds for agent-type accounts (₹8,000–₹1,00,000).
const CREDIT_MIN = 8000;
const CREDIT_MAX = 100000;

// Roles that go through the approval queue.
const APPROVAL_ROLES: readonly Role[] = ["b2b_agent", "partner"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function paramId(req: Request): string {
  const raw = req.params.id;
  const id = typeof raw === "string" ? raw : "";
  if (!mongoose.isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  return id;
}

export async function adminLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const password = isObject(req.body) ? req.body.password : undefined;
    if (!verifyAdminPassword(password)) {
      throw new HttpError(401, "Invalid admin password");
    }
    setAdminCookie(res, createAdminSessionToken());
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
}

export async function adminLogout(_req: Request, res: Response): Promise<void> {
  clearAdminCookie(res);
  res.json({ ok: true });
}

export async function adminMe(_req: Request, res: Response): Promise<void> {
  // Reaching here means the admin-session middleware already passed.
  res.json({ ok: true });
}

export async function listPending(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const items = await UserModel.find({
      role: { $in: APPROVAL_ROLES },
      status: "pending",
    }).sort({ createdAt: -1 });
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

export async function approve(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = paramId(req);
    const user = await UserModel.findById(id);
    if (!user) throw new HttpError(404, "User not found");
    if (!(APPROVAL_ROLES as readonly string[]).includes(user.role)) {
      throw new HttpError(400, "This account does not require approval");
    }
    if (user.status !== "pending") {
      throw new HttpError(409, `Account is already ${user.status}`);
    }

    // Only b2b_agent carries a credit limit (partner does not).
    if (user.role === "b2b_agent") {
      const raw = isObject(req.body) ? req.body.creditLimit : undefined;
      const creditLimit = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(creditLimit) || creditLimit < CREDIT_MIN || creditLimit > CREDIT_MAX) {
        throw new HttpError(
          400,
          `creditLimit must be between ${CREDIT_MIN} and ${CREDIT_MAX}`,
        );
      }
      user.creditLimit = creditLimit;
    }

    user.status = "active";
    user.rejectionReason = undefined;
    await user.save();

    await sendMail({
      to: user.email,
      subject: "Your SpaksTrip account has been approved",
      template: "applicantApproved",
      data: { name: user.name, role: user.role, creditLimit: user.creditLimit },
    });

    res.json({ user: user.toJSON() });
  } catch (e) {
    next(e);
  }
}

export async function reject(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = paramId(req);
    const reasonRaw = isObject(req.body) ? req.body.reason : undefined;
    const reason = typeof reasonRaw === "string" ? reasonRaw.trim() : "";

    const user = await UserModel.findById(id);
    if (!user) throw new HttpError(404, "User not found");
    if (!(APPROVAL_ROLES as readonly string[]).includes(user.role)) {
      throw new HttpError(400, "This account does not require approval");
    }
    if (user.status !== "pending") {
      throw new HttpError(409, `Account is already ${user.status}`);
    }

    user.status = "rejected";
    user.rejectionReason = reason || undefined;
    await user.save();

    await sendMail({
      to: user.email,
      subject: "Update on your SpaksTrip application",
      template: "applicantRejected",
      data: { name: user.name, role: user.role, reason },
    });

    res.json({ user: user.toJSON() });
  } catch (e) {
    next(e);
  }
}

// POST /api/admin/users/:id/suspend — take a live agent's storefront offline.
// Distinct from `reject` (which only applies to a still-pending application):
// suspend targets an agent who was already ACTIVE and needs to be pulled down
// (policy violation, non-payment, etc.) without discarding their account,
// bookings, or wallet — reversible via unsuspend.
export async function suspendAgent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = paramId(req);
    const user = await UserModel.findById(id);
    if (!user) throw new HttpError(404, "User not found");
    if (user.role !== "agent" && user.role !== "b2b_agent") {
      throw new HttpError(400, "Only agents and B2B agents can be suspended");
    }
    if (user.status !== "active") {
      throw new HttpError(409, `Account is ${user.status}, not active`);
    }

    user.status = "suspended";
    await user.save();
    if (user.slug) await invalidateAgentCache(user.slug);

    logger.info(
      { event: "agent_suspended", agentId: String(user._id), slug: user.slug ?? null },
      "Agent suspended",
    );

    res.json({ user: user.toJSON() });
  } catch (e) {
    next(e);
  }
}

// POST /api/admin/users/:id/unsuspend — restore a suspended agent's storefront.
export async function unsuspendAgent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = paramId(req);
    const user = await UserModel.findById(id);
    if (!user) throw new HttpError(404, "User not found");
    if (user.status !== "suspended") {
      throw new HttpError(409, `Account is ${user.status}, not suspended`);
    }

    user.status = "active";
    await user.save();
    if (user.slug) await invalidateAgentCache(user.slug);

    logger.info(
      { event: "agent_unsuspended", agentId: String(user._id), slug: user.slug ?? null },
      "Agent reinstated",
    );

    res.json({ user: user.toJSON() });
  } catch (e) {
    next(e);
  }
}

// GET /api/admin/hotel-listings?status=pending — partner hotel listings for
// the review queue. Defaults to "pending"; pass ?status=all to see every one.
export async function listHotelListings(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const statusRaw = typeof req.query.status === "string" ? req.query.status : "pending";
    const filter: Record<string, unknown> = {};
    if (statusRaw !== "all") {
      if (!(RESOURCE_STATUS as readonly string[]).includes(statusRaw)) {
        throw new HttpError(400, `status must be one of: ${RESOURCE_STATUS.join(", ")}, all`);
      }
      filter.status = statusRaw;
    }
    const items = await HotelListingModel.find(filter)
      .sort({ createdAt: -1 })
      .populate("partner", "name email");
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

// POST /api/admin/hotel-listings/:id/approve — publish a pending listing.
export async function approveHotelListing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = paramId(req);
    const listing = await HotelListingModel.findById(id);
    if (!listing) throw new HttpError(404, "Hotel listing not found");
    if (listing.status !== "pending") {
      throw new HttpError(409, `Listing is already ${listing.status}`);
    }
    listing.status = "active";
    await listing.save();
    res.json({ item: listing.toJSON() });
  } catch (e) {
    next(e);
  }
}

// POST /api/admin/hotel-listings/:id/reject — send a pending listing back to
// the partner as a draft so they can fix and resubmit.
export async function rejectHotelListing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = paramId(req);
    const listing = await HotelListingModel.findById(id);
    if (!listing) throw new HttpError(404, "Hotel listing not found");
    if (listing.status !== "pending") {
      throw new HttpError(409, `Listing is already ${listing.status}`);
    }
    listing.status = "draft";
    await listing.save();
    res.json({ item: listing.toJSON() });
  } catch (e) {
    next(e);
  }
}

// Manually set/adjust the credit limit for an agent or b2b_agent (₹8k–₹1L).
export async function setCreditLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = paramId(req);
    const raw = isObject(req.body) ? req.body.creditLimit : undefined;
    const creditLimit = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(creditLimit) || creditLimit < CREDIT_MIN || creditLimit > CREDIT_MAX) {
      throw new HttpError(400, `creditLimit must be between ${CREDIT_MIN} and ${CREDIT_MAX}`);
    }
    const user = await UserModel.findById(id);
    if (!user) throw new HttpError(404, "User not found");
    if (user.role !== "agent" && user.role !== "b2b_agent") {
      throw new HttpError(400, "Only agents and B2B agents have a credit limit");
    }
    user.creditLimit = creditLimit;
    await user.save();
    res.json({ user: user.toJSON() });
  } catch (e) {
    next(e);
  }
}

// GET /api/admin/users/:id/wallet — agent wallet balance + recent ledger.
export async function getAgentWallet(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = paramId(req);
    const user = await UserModel.findById(id).select("role name email");
    if (!user) throw new HttpError(404, "User not found");
    if (user.role !== "agent" && user.role !== "b2b_agent") {
      throw new HttpError(400, "Only agents and B2B agents have a wallet");
    }
    const wallet = await getOrCreateWallet(id);
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 20);
    const ledger = await listLedger(id, page, pageSize);
    res.json({
      wallet: { balance: wallet.balance, currency: wallet.currency },
      ledger: {
        items: ledger.items.map((e) => e.toJSON()),
        total: ledger.total,
        page: ledger.page,
        pageSize: ledger.pageSize,
      },
    });
  } catch (e) {
    next(e);
  }
}

// POST /api/admin/users/:id/wallet — manual TOPUP or ADJUSTMENT.
// An audit note is mandatory: manual money movements must be explainable later.
export async function recordAgentWalletMovement(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = paramId(req);
    const body = isObject(req.body) ? req.body : {};
    const type = body.type;
    const amount = typeof body.amount === "number" ? body.amount : Number(body.amount);
    const note = typeof body.note === "string" ? body.note.trim() : "";

    if (type !== "TOPUP" && type !== "ADJUSTMENT") {
      throw new HttpError(400, "type must be TOPUP or ADJUSTMENT");
    }
    if (!note) throw new HttpError(400, "An audit note is required for manual wallet movements");
    if (!Number.isFinite(amount) || amount === 0) {
      throw new HttpError(400, "amount must be a non-zero number (₹)");
    }

    const user = await UserModel.findById(id).select("role");
    if (!user) throw new HttpError(404, "User not found");
    if (user.role !== "agent" && user.role !== "b2b_agent") {
      throw new HttpError(400, "Only agents and B2B agents have a wallet");
    }

    const entry = await recordManualMovement({
      agentId: id,
      type,
      amount,
      meta: { note, actor: "superadmin" },
    });

    logger.info(
      { event: "wallet_manual_movement", agentId: id, type, amount, note },
      "Superadmin recorded a manual wallet movement",
    );

    res.status(201).json({ entry: entry.toJSON() });
  } catch (e) {
    next(e);
  }
}

export async function listUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const filter: Record<string, unknown> = {};
    const { role } = req.query;
    if (typeof role === "string" && role.length > 0) {
      if (!(ROLES as readonly string[]).includes(role)) {
        throw new HttpError(400, `role must be one of: ${ROLES.join(", ")}`);
      }
      filter.role = role;
    }
    const items = await UserModel.find(filter).sort({ createdAt: -1 });
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

// Public — no admin session required. Returns the current navbar visibility map.
// Missing keys are treated as visible (true) by convention on the client.
export async function getNavbarSettings(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await NavbarSettingsModel.findOne();
    res.json({ visibility: doc?.visibility ?? {} });
  } catch (e) {
    next(e);
  }
}

export async function getPlatformMarkup(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Bypass cache — admin always sees current DB state.
    const config = await PlatformConfigModel.findOne().lean();
    if (!config) throw new HttpError(404, "Platform config not seeded");
    res.json({
      markup:    config.markup,
      version:   config.version,
      updatedAt: config.updatedAt,
      updatedBy: config.updatedBy,
    });
  } catch (e) {
    next(e);
  }
}

export async function updatePlatformMarkup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = isObject(req.body) ? req.body : {};
    const products = ["flights", "hotels", "taxi"] as const;
    const setFields: Record<string, MarkupRule> = {};

    for (const key of products) {
      const raw = body[key];
      if (raw === undefined) continue;
      if (!isObject(raw)) throw new HttpError(400, `${key} must be an object`);

      const type = raw.type as string;
      if (!(MARKUP_TYPES as readonly string[]).includes(type)) {
        throw new HttpError(400, `${key}.type must be "percent" or "flat"`);
      }
      const value = Number(raw.value);
      if (!Number.isFinite(value) || value < 0) {
        throw new HttpError(400, `${key}.value must be a non-negative number`);
      }
      if (type === "percent" && value > 30) {
        throw new HttpError(400, `${key} percent markup cannot exceed 30%`);
      }
      if (type === "flat" && value > 5000) {
        throw new HttpError(400, `${key} flat markup cannot exceed ₹5000`);
      }
      const cap = raw.cap !== undefined && raw.cap !== null ? Number(raw.cap) : undefined;
      if (cap !== undefined && (!Number.isFinite(cap) || cap < 0)) {
        throw new HttpError(400, `${key}.cap must be a non-negative number`);
      }

      setFields[`markup.${key}`] = { type: type as MarkupType, value, ...(cap != null ? { cap } : {}) };
    }

    if (Object.keys(setFields).length === 0) {
      throw new HttpError(400, "Provide at least one of: flights, hotels, taxi");
    }

    const config = await PlatformConfigModel.findOneAndUpdate(
      {},
      { $set: setFields, $inc: { version: 1 } },
      { new: true, runValidators: true },
    ).lean();

    if (!config) throw new HttpError(404, "Platform config not seeded");

    invalidatePlatformConfigCache();

    res.json({
      markup:    config.markup,
      version:   config.version,
      updatedAt: config.updatedAt,
      updatedBy: config.updatedBy,
    });
  } catch (e) {
    next(e);
  }
}

// Admin-only — replaces the full visibility map.
export async function updateNavbarSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const raw = isObject(req.body) ? req.body.visibility : undefined;
    if (!isObject(raw)) throw new HttpError(400, "visibility must be an object");

    // Ensure all values are booleans
    const visibility: Record<string, boolean> = {};
    for (const [key, val] of Object.entries(raw)) {
      if (typeof val !== "boolean") throw new HttpError(400, `visibility["${key}"] must be boolean`);
      visibility[key] = val;
    }

    const doc = await NavbarSettingsModel.findOneAndUpdate(
      {},
      { $set: { visibility } },
      { upsert: true, new: true },
    );

    res.json({ visibility: doc.visibility });
  } catch (e) {
    next(e);
  }
}
