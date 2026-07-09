import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { BookingModel, BOOKING_STATUSES, type BookingStatus } from "../models/Booking";
import { UserModel, type Role, MARKUP_TYPES, type MarkupRule, BRAND_FONTS } from "../models/User";
import { validateBookingCreate } from "../validators/agent.validators";
import { HttpError } from "../middleware/error";
import { invalidateAgentCache } from "../lib/agentCache";
import { uploadToCloudinary, type UploadedFile } from "../lib/cloudinary";
import {
  getOrCreateWallet,
  debitForBooking,
  refundForBooking,
  listLedger,
  earningsSummary,
  InsufficientWalletBalanceError,
} from "../services/walletService";
import { logger } from "../lib/logger";

// Strip fields the agent must never see (platform-tier pricing internals).
// Called on every booking returned by agent-facing endpoints.
// Exported for the response-shape test (agent.controller.test.ts) — this
// function is the ONE enforcement point for the "agents never see tboFare/
// platformMarkup" hard invariant, so it must be directly testable without a
// live DB.
export function toAgentBooking(doc: { toJSON(): Record<string, unknown> }): Record<string, unknown> {
  const obj = doc.toJSON();
  delete obj.tboFare;
  delete obj.platformMarkup;
  return obj;
}

function ownerIdFrom(req: Request): string {
  if (!req.user) throw new HttpError(401, "Unauthorized");
  return req.user.sub;
}

// Insufficient balance is an expected 402, not a server error — but it's a
// meaningful business signal worth being able to grep by agentId (e.g. "is
// this agent's booking creation failing because they're out of funds?").
// Reads req.user directly (rather than taking an ownerId param) so it works
// from a catch block even when the ownerId-extracting line itself threw.
function logIfInsufficientBalance(req: Request, e: unknown): void {
  if (e instanceof InsufficientWalletBalanceError) {
    logger.info(
      { event: "wallet_debit_blocked", agentId: req.user?.sub ?? null, message: e.message },
      "Booking blocked — insufficient wallet balance",
    );
  }
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

    // tenant-scope-ok: filter is seeded with { ownerId } just above.
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

    const bookingFields = {
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
    };

    // Pre-funded wallet: a booking created directly as ACTIVE debits the
    // agent's net cost immediately, atomically with the booking write —
    // insufficient balance blocks the booking (fail closed, named error).
    // Holds don't debit; they consume credit (above) and debit on confirm.
    if (input.status === "active") {
      const _id = new mongoose.Types.ObjectId();
      await debitForBooking(
        ownerId,
        _id,
        input.amount,
        async (session) => {
          await BookingModel.create([{ _id, ...bookingFields }], { session });
        },
        { source: "agent_portal_create", pnr: input.pnr ?? null },
      );
      // tenant-scope-ok: _id was freshly generated above and the create() that
      // wrote it was itself ownerId-scoped (bookingFields.ownerId) — no other
      // tenant can possibly hold this exact ObjectId.
      const booking = await BookingModel.findById(_id);
      if (!booking) throw new HttpError(500, "Booking write did not persist");
      res.status(201).json({ booking: toAgentBooking(booking) });
      return;
    }

    const booking = await BookingModel.create(bookingFields);
    res.status(201).json({ booking: toAgentBooking(booking) });
  } catch (e) {
    logIfInsufficientBalance(req, e);
    next(e);
  }
}

// Transition a held booking to confirmed ("active").
// Pre-funded wallet: confirmation is when the agent's net cost is debited —
// atomically with the status flip; insufficient balance blocks confirmation
// (fail closed) and the hold stays held.
export async function confirmHold(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerId = ownerIdFrom(req);
    const id = paramId(req);

    const held = await BookingModel.findOne({
      _id: id, ownerId, status: "held", holdExpiresAt: { $gt: new Date() },
    });
    if (!held) throw new HttpError(404, "Active hold not found (it may have expired)");

    await debitForBooking(
      ownerId,
      held._id,
      held.amount,
      async (session) => {
        // Re-checked inside the transaction: a concurrent confirm/cancel/expiry
        // makes this match nothing → the whole transaction (incl. the debit)
        // rolls back. The unique {bookingId, BOOKING_DEBIT} ledger index is the
        // second line of defence against a double debit.
        const updated = await BookingModel.findOneAndUpdate(
          { _id: id, ownerId, status: "held", holdExpiresAt: { $gt: new Date() } },
          { $set: { status: "active" }, $unset: { holdExpiresAt: "" } },
          { new: true, session },
        );
        if (!updated) throw new HttpError(404, "Active hold not found (it may have expired)");
      },
      { source: "agent_portal_confirm", pnr: held.pnr ?? null },
    );

    // tenant-scope-ok: the findOneAndUpdate above already proved `id` belongs
    // to this ownerId (inside the transaction) — this is just a fresh re-read.
    const booking = await BookingModel.findById(id);
    if (!booking) throw new HttpError(500, "Booking not found after confirmation");
    res.json({ booking: toAgentBooking(booking) });
  } catch (e) {
    logIfInsufficientBalance(req, e);
    next(e);
  }
}

// Cancel an active booking or release a held one.
// Pre-funded wallet: cancelling a debited (active) booking credits the debit
// back as a NEW REFUND ledger entry (never a mutation), atomically with the
// status flip. Releasing a hold refunds nothing — holds were never debited.
export async function cancelBooking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerId = ownerIdFrom(req);
    const id = paramId(req);

    const cancellable = await BookingModel.findOne({
      _id: id, ownerId, status: { $in: ["active", "held"] },
    });
    if (!cancellable) throw new HttpError(404, "Booking not found or not cancellable");

    await refundForBooking(
      ownerId,
      cancellable._id,
      async (session) => {
        const updated = await BookingModel.findOneAndUpdate(
          { _id: id, ownerId, status: { $in: ["active", "held"] } },
          { $set: { status: "cancelled" } },
          { new: true, session },
        );
        if (!updated) throw new HttpError(404, "Booking not found or not cancellable");
      },
      { source: "agent_portal_cancel", pnr: cancellable.pnr ?? null },
    );

    // tenant-scope-ok: the findOneAndUpdate above already proved `id` belongs
    // to this ownerId (inside the transaction) — this is just a fresh re-read.
    const booking = await BookingModel.findById(id);
    if (!booking) throw new HttpError(500, "Booking not found after cancellation");
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

    // Taxi is an enquiry-only vertical (leads go to admin/partner; no priced
    // checkout), so markup can never apply to it. A settable knob that does
    // nothing is a settlement-trust bug — reject writes outright.
    if (body.taxi !== undefined) {
      throw new HttpError(400, "Markup does not apply to taxi — it is an enquiry-based vertical with no priced checkout");
    }

    const updates: Partial<Record<"flights" | "hotels", MarkupRule>> = {};

    for (const key of ["flights", "hotels"] as const) {
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
      throw new HttpError(400, "Provide at least one of: flights, hotels");
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
    if (user.slug) await invalidateAgentCache(user.slug);

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
      // tenant-scope-ok: user._id came from UserModel.findById(ownerId) above —
      // this is the caller's own record.
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

    if (body.fontKey !== undefined) {
      if (!(BRAND_FONTS as readonly string[]).includes(body.fontKey)) {
        throw new HttpError(400, `fontKey must be one of: ${BRAND_FONTS.join(", ")}`);
      }
      setOps["branding.fontKey"] = body.fontKey;
    }

    // Uploads: multer exposes named fields on req.files (logo, logoDark, favicon).
    const files = (req.files ?? {}) as Record<string, UploadedFile[] | undefined>;
    const uploadField = async (field: "logo" | "logoDark" | "favicon", folder: string) => {
      const file = files[field]?.[0] ?? (field === "logo" ? (req.file as UploadedFile | undefined) : undefined);
      if (!file) return;
      const url = await uploadToCloudinary(file, folder);
      setOps[`branding.${field}`] = url;
    };
    await uploadField("logo", "agent-logos");
    await uploadField("logoDark", "agent-logos");
    await uploadField("favicon", "agent-favicons");

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

    if (user.slug) await invalidateAgentCache(user.slug);

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
    // Wallet doc is the settlement source of truth (User.walletBalance is a
    // legacy field, always 0 — the wallet starts fresh at 0 lazily).
    const wallet = await getOrCreateWallet(ownerId);
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
        walletBalance: wallet.balance,
      },
    });
  } catch (e) {
    next(e);
  }
}

// GET /api/agent/wallet — balance + per-month earnings summary.
// Ledger entries and earnings expose only the agent's own numbers; the hard
// invariant (no tboFare/platformMarkup to agents) holds: neither field is read.
export async function getWallet(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerId = ownerIdFrom(req);
    const [wallet, earnings] = await Promise.all([
      getOrCreateWallet(ownerId),
      earningsSummary(ownerId, 12),
    ]);
    res.json({
      wallet: { balance: wallet.balance, currency: wallet.currency },
      earnings,
    });
  } catch (e) {
    next(e);
  }
}

// GET /api/agent/wallet/ledger?page=&pageSize= — paginated, tenant-scoped.
export async function getWalletLedger(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerId = ownerIdFrom(req);
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 20);
    const result = await listLedger(ownerId, page, pageSize);
    res.json({
      items: result.items.map((e) => ({
        id: String(e._id),
        type: e.type,
        amount: e.amount,
        balanceAfter: e.balanceAfter,
        bookingId: e.bookingId ? String(e.bookingId) : null,
        note: typeof e.meta?.note === "string" ? e.meta.note : null,
        createdAt: e.createdAt,
      })),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  } catch (e) {
    next(e);
  }
}
