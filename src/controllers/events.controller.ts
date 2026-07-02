import { Request, Response, NextFunction } from "express";
import mongoose, { Types } from "mongoose";
import crypto from "crypto";
import QRCode from "qrcode";
import { EventListingModel, type EventListingDoc } from "../models/partner/EventListing";
import { EventBookingModel } from "../models/EventBooking";
import { ExternalEventModel, type ExternalEventDoc } from "../models/ExternalEvent";
import { validateEventListing } from "../validators/eventListing.validators";
import { validateBookingInput } from "../validators/eventBooking.validators";
import { uploadManyToCloudinary } from "../lib/cloudinary";
import {
  createOrder,
  verifySignature,
  fetchPayment,
  initiateRefund,
} from "../integrations/tbo/payments/razorpay";
import {
  createTransaction,
  updateTransactionStatus,
} from "../services/transactionService";
import { env } from "../config/env";
import { HttpError } from "../middleware/error";
import { EVENT_STATUS, type EventStatus } from "../models/partner/_shared/enums";
import {
  notifyBookingConfirmed,
  notifyBookingCancelled,
  notifyEventUpdated,
} from "../services/eventNotifications";

// All Events-module HTTP handlers: partner CRUD, public discovery, the customer
// booking flow (Razorpay + PostgreSQL transaction, mirroring the flight flow) and
// admin review. Follows the partner.controller.ts conventions: try/catch → next(e),
// HttpError for client errors, server-computed pricing (never trust the client).

// ── Helpers ──────────────────────────────────────────────────────────────────
function userIdFrom(req: Request): string {
  if (!req.user) throw new HttpError(401, "Unauthorized");
  return req.user.sub;
}

function ensureValidId(id: string): void {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(400, "Invalid id");
}

// Express 5 types route params as `string | string[]`; normalize to a single string.
function paramStr(raw: string | string[] | undefined): string {
  return typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] ?? "" : "";
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

// Server-side fee/GST/total. subtotal is summed from authoritative DB ticket
// prices; platform fee is a % of subtotal, GST a % of the fee (per env config).
function computePricing(subtotal: number): { platformFee: number; gst: number; totalAmount: number } {
  const platformFee = Math.round((subtotal * env.eventPlatformFeePercent) / 100);
  const gst = Math.round((platformFee * env.eventGstPercent) / 100);
  return { platformFee, gst, totalAmount: subtotal + platformFee + gst };
}

interface ReservedLine {
  ticketId: Types.ObjectId;
  ticketName: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

// Release a set of previously reserved ticket holds (inventory roll-back).
async function releaseHolds(eventId: Types.ObjectId, lines: ReservedLine[]): Promise<void> {
  for (const l of lines) {
    await EventListingModel.updateOne(
      { _id: eventId },
      { $inc: { "tickets.$[t].availableQuantity": l.quantity } },
      { arrayFilters: [{ "t._id": l.ticketId }] },
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PARTNER CRUD  (mounted at /api/partner/events — auth + role "partner")
// ════════════════════════════════════════════════════════════════════════════

// POST /api/partner/events — multipart/form-data. Sections arrive as JSON strings
// (event/venue/virtualDetails/tickets/recurringPattern); files as `eventImages`.
export async function createEvent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const partnerId = userIdFrom(req);

    const event = parseJsonField(req, "event", {});
    const venue = parseJsonField(req, "venue", {});
    const virtualDetails = parseJsonField(req, "virtualDetails", {});
    const tickets = parseJsonField(req, "tickets", []);
    const recurringPattern = parseJsonField(req, "recurringPattern", {});

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const imageUrls = await uploadManyToCloudinary(
      files.filter((f) => f.fieldname === "eventImages"),
      "spakstrip/events",
    );

    const input = validateEventListing({ event, venue, virtualDetails, tickets, recurringPattern, imageUrls });
    const doc = await EventListingModel.create({ ...input, partner: partnerId, status: "draft" });
    res.status(201).json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// GET /api/partner/events — this partner's events, newest first.
export async function listMyEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const partnerId = userIdFrom(req);
    const filter: Record<string, unknown> = { partner: partnerId };
    const { status } = req.query;
    if (typeof status === "string") {
      if (!(EVENT_STATUS as readonly string[]).includes(status)) {
        throw new HttpError(400, `status must be one of: ${EVENT_STATUS.join(", ")}`);
      }
      filter.status = status;
    }
    const items = await EventListingModel.find(filter).sort({ createdAt: -1 });
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

// Load an event the caller owns, or throw 404/403.
async function ownedEvent(req: Request): Promise<EventListingDoc> {
  const partnerId = userIdFrom(req);
  const id = paramStr(req.params.id);
  ensureValidId(id);
  const doc = await EventListingModel.findById(id);
  if (!doc) throw new HttpError(404, "Event not found");
  if (String(doc.partner) !== partnerId) throw new HttpError(403, "Forbidden");
  return doc;
}

export async function getMyEvent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await ownedEvent(req);
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// PUT /api/partner/events/:id — re-validate and replace mutable fields. Tickets
// are preserved (incoming ticket edits ignored) once the event has bookings, so
// live inventory/sales counters are never clobbered.
export async function updateEvent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await ownedEvent(req);

    const event = parseJsonField(req, "event", {});
    const venue = parseJsonField(req, "venue", {});
    const virtualDetails = parseJsonField(req, "virtualDetails", {});
    const tickets = parseJsonField(req, "tickets", []);
    const recurringPattern = parseJsonField(req, "recurringPattern", {});

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const newImageUrls = await uploadManyToCloudinary(
      files.filter((f) => f.fieldname === "eventImages"),
      "spakstrip/events",
    );
    // Keep existing images if no new ones are uploaded (validator requires ≥1).
    const imageUrls = newImageUrls.length > 0 ? newImageUrls : doc.images.map((i) => i.url);

    const input = validateEventListing({ event, venue, virtualDetails, tickets, recurringPattern, imageUrls });

    const hasBookings = doc.currentBookings > 0;
    // Snapshot the customer-facing details so we can notify on a material change.
    const prev = {
      startDate: doc.startDate?.getTime(),
      startTime: doc.startTime,
      city: doc.venue?.city,
    };

    const { tickets: validatedTickets, ...rest } = input;
    Object.assign(doc, rest);
    if (!hasBookings) {
      doc.set("tickets", validatedTickets);
    }
    await doc.save();

    // If a booked event's date/time/city changed, alert every confirmed attendee.
    if (hasBookings) {
      const changes: string[] = [];
      if (doc.startDate?.getTime() !== prev.startDate) changes.push("date");
      if (doc.startTime !== prev.startTime) changes.push("time");
      if (doc.venue?.city !== prev.city) changes.push("venue");
      if (changes.length > 0) {
        const summary = `Changed: ${changes.join(", ")}.`;
        const bookings = await EventBookingModel.find({ event: doc._id, status: "confirmed" });
        for (const b of bookings) void notifyEventUpdated(b, doc, summary); // fire-and-forget
      }
    }

    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// DELETE /api/partner/events/:id — soft delete (archive).
export async function deleteEvent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await ownedEvent(req);
    doc.status = "archived";
    await doc.save();
    res.status(204).end();
  } catch (e) {
    next(e);
  }
}

// PATCH /api/partner/events/:id/status — partner-driven lifecycle moves.
// Allowed by the owner: draft → pending_review/published, published ↔ archived,
// any → cancelled. Admin uses the /api/admin/events/:id/review route for approvals.
const PARTNER_STATUS_TRANSITIONS: Record<EventStatus, EventStatus[]> = {
  draft: ["pending_review", "published", "archived"],
  pending_review: ["draft", "published", "archived"],
  published: ["archived", "cancelled"],
  rejected: ["draft", "pending_review"],
  archived: ["draft", "published"],
  cancelled: [],
};

export async function setEventStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await ownedEvent(req);
    const target = (req.body as Record<string, unknown>)?.status;
    if (typeof target !== "string" || !(EVENT_STATUS as readonly string[]).includes(target)) {
      throw new HttpError(400, `status must be one of: ${EVENT_STATUS.join(", ")}`);
    }
    const allowed = PARTNER_STATUS_TRANSITIONS[doc.status];
    if (!allowed.includes(target as EventStatus)) {
      throw new HttpError(409, `cannot move event from "${doc.status}" to "${target}"`);
    }
    doc.status = target as EventStatus;
    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// POST /api/partner/events/:id/images — append images (cap 10).
export async function uploadEventImages(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await ownedEvent(req);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const toUpload = files.filter((f) => f.fieldname === "eventImages");
    if (toUpload.length === 0) throw new HttpError(400, "no images provided (field: eventImages)");
    if (doc.images.length + toUpload.length > 10) throw new HttpError(400, "an event can have at most 10 images");
    const urls = await uploadManyToCloudinary(toUpload, "spakstrip/events");
    const hadImages = doc.images.length > 0;
    doc.images.push(...urls.map((url, i) => ({ url, isPrimary: !hadImages && i === 0 })));
    await doc.save();
    res.status(201).json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// DELETE /api/partner/events/:id/images/:imgId — remove an image by its url
// (URL-encoded) — embedded images have no _id, so we match on url.
export async function removeEventImage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await ownedEvent(req);
    const url = decodeURIComponent(paramStr(req.params.imgId));
    const before = doc.images.length;
    doc.set(
      "images",
      doc.images.filter((img) => img.url !== url),
    );
    if (doc.images.length === before) throw new HttpError(404, "image not found");
    if (doc.images.length === 0) throw new HttpError(400, "an event must keep at least one image");
    if (!doc.images.some((i) => i.isPrimary)) doc.images[0].isPrimary = true;
    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// GET /api/partner/events/:id/bookings — bookings for one of the partner's events.
export async function listEventBookings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await ownedEvent(req);
    const items = await EventBookingModel.find({ event: doc._id }).sort({ createdAt: -1 });
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

// GET /api/partner/events/:id/analytics — bookings count, revenue, capacity use.
export async function eventAnalytics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await ownedEvent(req);
    const agg = await EventBookingModel.aggregate<{
      _id: null;
      confirmed: number;
      grossRevenue: number;
      ticketsSold: number;
    }>([
      { $match: { event: doc._id, status: "confirmed" } },
      {
        $group: {
          _id: null,
          confirmed: { $sum: 1 },
          grossRevenue: { $sum: "$totalAmount" },
          ticketsSold: { $sum: { $sum: "$tickets.quantity" } },
        },
      },
    ]);
    const stats = agg[0] ?? { confirmed: 0, grossRevenue: 0, ticketsSold: 0 };
    res.json({
      eventId: String(doc._id),
      title: doc.title,
      confirmedBookings: stats.confirmed,
      grossRevenue: stats.grossRevenue,
      ticketsSold: stats.ticketsSold,
      totalCapacity: doc.totalCapacity,
      currentBookings: doc.currentBookings,
      capacityUtilization: doc.totalCapacity > 0 ? Math.round((doc.currentBookings / doc.totalCapacity) * 100) : 0,
      isSoldOut: doc.isSoldOut,
    });
  } catch (e) {
    next(e);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC DISCOVERY  (mounted at /api/events — no auth)
// ════════════════════════════════════════════════════════════════════════════

// Build the published-events Mongo filter from the public query params.
function publicFilter(q: Record<string, unknown>): Record<string, unknown> {
  const filter: Record<string, unknown> = { status: "published" };
  if (typeof q.city === "string" && q.city.trim()) {
    filter["venue.city"] = new RegExp(`^${q.city.trim()}$`, "i");
  }
  if (typeof q.category === "string" && q.category.trim()) filter.category = q.category.trim();
  if (typeof q.eventType === "string" && q.eventType.trim()) filter.eventType = q.eventType.trim();
  if (q.isFree === "true") filter.isFree = true;
  if (q.isFree === "false") filter.isFree = false;

  const dateFilter: Record<string, Date> = {};
  if (typeof q.startDate === "string") {
    const d = new Date(q.startDate);
    if (!Number.isNaN(d.getTime())) dateFilter.$gte = d;
  }
  if (typeof q.endDate === "string") {
    const d = new Date(q.endDate);
    if (!Number.isNaN(d.getTime())) dateFilter.$lte = d;
  }
  if (Object.keys(dateFilter).length) filter.startDate = dateFilter;

  const priceFilter: Record<string, number> = {};
  if (q.minPrice !== undefined && Number.isFinite(Number(q.minPrice))) priceFilter.$gte = Number(q.minPrice);
  if (q.maxPrice !== undefined && Number.isFinite(Number(q.maxPrice))) priceFilter.$lte = Number(q.maxPrice);
  if (Object.keys(priceFilter).length) filter["priceRange.min"] = priceFilter;

  return filter;
}

function paginate(q: Record<string, unknown>): { page: number; limit: number; skip: number } {
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(q.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

// Build the active-external-events filter from the same public query params (a
// subset — external rows have no eventType, and price lives on priceRange.min).
function externalFilter(q: Record<string, unknown>): Record<string, unknown> {
  const filter: Record<string, unknown> = { isActive: true };
  if (typeof q.city === "string" && q.city.trim()) filter["venue.city"] = new RegExp(`^${q.city.trim()}$`, "i");
  if (typeof q.category === "string" && q.category.trim()) filter.category = q.category.trim();

  const dateFilter: Record<string, Date> = {};
  if (typeof q.startDate === "string") {
    const d = new Date(q.startDate);
    if (!Number.isNaN(d.getTime())) dateFilter.$gte = d;
  }
  if (typeof q.endDate === "string") {
    const d = new Date(q.endDate);
    if (!Number.isNaN(d.getTime())) dateFilter.$lte = d;
  }
  if (Object.keys(dateFilter).length) filter.startDate = dateFilter;
  return filter;
}

// Unified event-card shape returned by the merged listing (instruct.md Step 2.6).
interface EventCard {
  id: string;
  title: string;
  slug?: string;
  category: string;
  startDate?: Date;
  endDate?: Date;
  venue: { name?: string; city?: string };
  images: string[];
  priceRange?: { min?: number; max?: number; currency?: string };
  isFree: boolean;
  isExternal: boolean;
  bookingType: "direct" | "affiliate";
  affiliateUrl?: string;
  source: "internal" | "ticketmaster" | "insider" | "bookmyshow";
}

function internalCard(d: EventListingDoc): EventCard {
  return {
    id: String(d._id),
    title: d.title,
    slug: d.slug,
    category: d.category,
    startDate: d.startDate,
    endDate: d.endDate,
    venue: { name: d.venue?.name, city: d.venue?.city },
    images: d.images.map((i) => i.url),
    priceRange: { min: d.priceRange.min, max: d.priceRange.max, currency: "INR" },
    isFree: d.isFree,
    isExternal: false,
    bookingType: "direct",
    source: "internal",
  };
}

function externalCard(d: ExternalEventDoc): EventCard {
  return {
    id: String(d._id),
    title: d.title,
    category: d.category,
    startDate: d.startDate,
    endDate: d.endDate,
    venue: { name: d.venue?.name, city: d.venue?.city },
    images: d.images,
    priceRange: d.priceRange,
    isFree: d.priceRange?.min === 0,
    isExternal: true,
    bookingType: "affiliate",
    affiliateUrl: d.affiliateUrl ?? d.sourceUrl,
    source: d.source,
  };
}

// GET /api/events — paginated, filterable list merging published internal events
// with cached external events (instruct.md Step 2.6). External rows are display +
// affiliate only. Pass includeExternal=false to restrict to internal events.
export async function listEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = req.query as Record<string, unknown>;
    const { page, limit } = paginate(q);
    const includeExternal = q.includeExternal !== "false";
    // External price/eventType filters don't map onto cached rows; when the client
    // narrows by those, keep the result internal-only to avoid misleading hits.
    const externalApplicable =
      includeExternal && q.eventType === undefined && q.minPrice === undefined && q.maxPrice === undefined && q.isFree === undefined;

    // Cap each source; the merged set is sorted + paginated in-memory. The external
    // cache is bounded (top metros) so this stays small.
    const CAP = 500;
    const [internal, external] = await Promise.all([
      EventListingModel.find(publicFilter(q)).sort({ startDate: 1 }).limit(CAP),
      externalApplicable
        ? ExternalEventModel.find(externalFilter(q)).sort({ startDate: 1 }).limit(CAP)
        : Promise.resolve([] as ExternalEventDoc[]),
    ]);

    const cards = [...internal.map(internalCard), ...external.map(externalCard)].sort((a, b) => {
      const ta = a.startDate ? a.startDate.getTime() : Number.MAX_SAFE_INTEGER; // undated last
      const tb = b.startDate ? b.startDate.getTime() : Number.MAX_SAFE_INTEGER;
      return ta - tb;
    });

    const total = cards.length;
    const start = (page - 1) * limit;
    res.json({
      items: cards.slice(start, start + limit),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (e) {
    next(e);
  }
}

// GET /api/events/search?q=... — full-text search over published events.
export async function searchEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = req.query as Record<string, unknown>;
    const term = typeof q.q === "string" ? q.q.trim() : "";
    if (!term) throw new HttpError(400, "search query 'q' is required");
    const { page, limit, skip } = paginate(q);
    const filter = { status: "published", $text: { $search: term } };
    const [items, total] = await Promise.all([
      EventListingModel.find(filter, { score: { $meta: "textScore" } })
        .sort({ score: { $meta: "textScore" } })
        .skip(skip)
        .limit(limit),
      EventListingModel.countDocuments(filter),
    ]);
    res.json({
      items: items.map((i) => i.toJSON()),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (e) {
    next(e);
  }
}

// GET /api/events/categories — published-event counts per category.
export async function listCategories(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await EventListingModel.aggregate<{ _id: string; count: number }>([
      { $match: { status: "published" } },
      { $group: { _id: "$category", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    res.json({ items: rows.map((r) => ({ category: r._id, count: r.count })) });
  } catch (e) {
    next(e);
  }
}

// GET /api/events/cities — published-event counts per city.
export async function listCities(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await EventListingModel.aggregate<{ _id: string; count: number }>([
      { $match: { status: "published", "venue.city": { $ne: null } } },
      { $group: { _id: "$venue.city", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    res.json({ items: rows.filter((r) => r._id).map((r) => ({ city: r._id, count: r.count })) });
  } catch (e) {
    next(e);
  }
}

// GET /api/events/upcoming — next published events by start date.
export async function upcomingEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(50, Math.max(1, Number((req.query as Record<string, unknown>).limit) || 12));
    const items = await EventListingModel.find({ status: "published", startDate: { $gte: new Date() } })
      .sort({ startDate: 1 })
      .limit(limit);
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

// GET /api/events/featured — promoted published events.
export async function featuredEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(50, Math.max(1, Number((req.query as Record<string, unknown>).limit) || 12));
    const items = await EventListingModel.find({ status: "published", isFeatured: true })
      .sort({ startDate: 1 })
      .limit(limit);
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

// GET /api/events/:slug — single published event by slug.
export async function getEventBySlug(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await EventListingModel.findOne({ slug: paramStr(req.params.slug), status: "published" });
    if (!doc) throw new HttpError(404, "Event not found");
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BOOKING FLOW  (mounted under /api/events + /api/bookings/events — role customer)
// ════════════════════════════════════════════════════════════════════════════

// POST /api/events/:slug/book — validate selection, price it from the DB, place a
// soft inventory hold and create a Razorpay order (or confirm immediately if free).
export async function initiateBooking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = userIdFrom(req);
    const input = validateBookingInput(req.body);

    const event = await EventListingModel.findOne({ slug: paramStr(req.params.slug), status: "published" });
    if (!event) throw new HttpError(404, "Event not found");

    const now = new Date();
    let subtotal = 0;
    const lines: ReservedLine[] = [];

    // Price every line from the authoritative ticket subdocs — never the client.
    for (const sel of input.tickets) {
      if (!mongoose.isValidObjectId(sel.ticketTypeId)) throw new HttpError(400, `invalid ticketTypeId "${sel.ticketTypeId}"`);
      const ticket = event.tickets.find((t) => String(t._id) === sel.ticketTypeId);
      if (!ticket || !ticket.isActive) throw new HttpError(400, `ticket "${sel.ticketTypeId}" is not available`);
      if (sel.quantity > ticket.maxPerOrder) {
        throw new HttpError(400, `"${ticket.name}" allows at most ${ticket.maxPerOrder} per order`);
      }
      if (ticket.saleStartDate && now < ticket.saleStartDate) throw new HttpError(409, `sales for "${ticket.name}" have not started`);
      if (ticket.saleEndDate && now > ticket.saleEndDate) throw new HttpError(409, `sales for "${ticket.name}" have ended`);
      const lineSubtotal = ticket.price * sel.quantity;
      subtotal += lineSubtotal;
      lines.push({
        ticketId: ticket._id as Types.ObjectId,
        ticketName: ticket.name,
        quantity: sel.quantity,
        unitPrice: ticket.price,
        subtotal: lineSubtotal,
      });
    }

    const totalTickets = lines.reduce((n, l) => n + l.quantity, 0);
    if (input.attendees.length > 0 && input.attendees.length !== totalTickets) {
      throw new HttpError(400, `attendees (${input.attendees.length}) must match total ticket quantity (${totalTickets})`);
    }
    if (event.ageRestriction?.hasRestriction && event.ageRestriction.minimumAge && input.attendees.length > 0) {
      const tooYoung = input.attendees.some((a) => a.age !== undefined && a.age < event.ageRestriction.minimumAge!);
      if (tooYoung) throw new HttpError(400, `all attendees must be at least ${event.ageRestriction.minimumAge}`);
    }

    // ── Atomic soft-hold per ticket type (prevents overselling). Roll back all
    //    reserved lines if any one fails. ───────────────────────────────────────
    const reserved: ReservedLine[] = [];
    for (const l of lines) {
      // The availability guard lives in the QUERY (via $elemMatch) so matchedCount
      // reflects whether a ticket with enough stock existed: 0 ⇒ sold out. We can't
      // rely on modifiedCount here — timestamps:true bumps it on every write even
      // when the arrayFilter matches no element. The $[t] arrayFilter then targets
      // the same ticket by _id to apply the atomic decrement.
      const r = await EventListingModel.updateOne(
        {
          _id: event._id,
          tickets: { $elemMatch: { _id: l.ticketId, isActive: true, availableQuantity: { $gte: l.quantity } } },
        },
        { $inc: { "tickets.$[t].availableQuantity": -l.quantity } },
        { arrayFilters: [{ "t._id": l.ticketId }] },
      );
      if (r.matchedCount !== 1) {
        await releaseHolds(event._id as Types.ObjectId, reserved);
        throw new HttpError(409, `Not enough tickets available for "${l.ticketName}"`);
      }
      reserved.push(l);
    }

    const { platformFee, gst, totalAmount } = computePricing(subtotal);
    const agentId = req.get("x-agent-id");
    // NOTE: the frozen markup engine/User model carry no event markup rule yet, so
    // agentMarkup is recorded as 0. Wiring event markup is a later step once the
    // platform markup config is extended (do NOT modify the frozen files here).
    const booking = await EventBookingModel.create({
      user: userId,
      event: event._id,
      tickets: lines.map((l) => ({
        ticketTypeId: l.ticketId,
        ticketName: l.ticketName,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        subtotal: l.subtotal,
      })),
      attendees: input.attendees,
      subtotal,
      platformFee,
      gst,
      totalAmount,
      currency: "INR",
      ...(agentId && mongoose.isValidObjectId(agentId) ? { agent: new Types.ObjectId(agentId) } : {}),
      agentMarkup: 0,
      customerPaid: totalAmount,
      paymentStatus: totalAmount === 0 ? "paid" : "initiated",
      status: totalAmount === 0 ? "confirmed" : "pending",
      holdExpiresAt: new Date(now.getTime() + env.eventBookingHoldMinutes * 60_000),
      source: agentId ? "agent_portal" : "web",
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? undefined,
    });

    // ── Free event → confirm now, no Razorpay round-trip ─────────────────────────
    if (totalAmount === 0) {
      await confirmBookingInventory(event._id as Types.ObjectId, lines, totalTickets);
      booking.qrCode = await makeQrCode(booking.bookingReference);
      booking.paidAt = now;
      await booking.save();
      void notifyBookingConfirmed(booking, event); // fire-and-forget
      res.status(201).json({ free: true, booking: booking.toJSON() });
      return;
    }

    // ── Paid event → create Razorpay order + PG transaction row ───────────────────
    let order;
    try {
      order = await createOrder({
        amountPaise: Math.round(totalAmount * 100),
        receipt: booking.bookingReference,
        notes: { product: "event", bookingReference: booking.bookingReference, eventSlug: event.slug },
      });
    } catch (err) {
      await releaseHolds(event._id as Types.ObjectId, reserved);
      booking.paymentStatus = "failed";
      booking.status = "cancelled";
      await booking.save();
      throw new HttpError(502, "Failed to create payment order. Please try again.");
    }

    booking.razorpayOrderId = order.id;
    await booking.save();

    // Financial record of truth in PostgreSQL (resource_type: event_booking).
    await createTransaction({
      userId,
      amount: totalAmount,
      currency: "INR",
      status: "created",
      providerOrderId: order.id,
      bookingRef: booking.bookingReference,
      resourceType: "event_booking",
      resourceId: String(event._id),
      metadata: { type: "event_booking", eventSlug: event.slug, tickets: totalTickets },
    }).catch(() => undefined); // PG is graceful-degradation — never block the booking

    res.status(201).json({
      booking: booking.toJSON(),
      payment: { orderId: order.id, amount: order.amount, currency: order.currency },
    });
  } catch (e) {
    next(e);
  }
}

// Confirm inventory on payment success: realize the held tickets as sold and bump
// the event's booking counter, then flip isSoldOut if capacity is reached.
async function confirmBookingInventory(eventId: Types.ObjectId, lines: ReservedLine[], totalTickets: number): Promise<void> {
  for (const l of lines) {
    await EventListingModel.updateOne(
      { _id: eventId },
      { $inc: { "tickets.$[t].soldQuantity": l.quantity } },
      { arrayFilters: [{ "t._id": l.ticketId }] },
    );
  }
  await EventListingModel.updateOne({ _id: eventId }, { $inc: { currentBookings: totalTickets } });
  await EventListingModel.updateOne(
    { _id: eventId, $expr: { $gte: ["$currentBookings", "$totalCapacity"] } },
    { $set: { isSoldOut: true } },
  );
}

// Generate a scannable QR as a base64 PNG data URL. The encoded payload is the
// booking reference plus a random nonce so each pass is unique (spec: store as
// base64 or Cloudinary URL).
async function makeQrCode(bookingReference: string): Promise<string> {
  const payload = `${bookingReference}.${crypto.randomBytes(8).toString("hex")}`;
  return QRCode.toDataURL(payload, { errorCorrectionLevel: "M", margin: 1, width: 256 });
}

// POST /api/events/booking/verify — verify the Razorpay signature, confirm the
// booking, realize inventory and settle the PG transaction. Idempotent.
export async function verifyBookingPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = userIdFrom(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const bookingReference = typeof body.bookingReference === "string" ? body.bookingReference : "";
    const razorpayOrderId = typeof body.razorpayOrderId === "string" ? body.razorpayOrderId : "";
    const razorpayPaymentId = typeof body.razorpayPaymentId === "string" ? body.razorpayPaymentId : "";
    const razorpaySignature = typeof body.razorpaySignature === "string" ? body.razorpaySignature : "";
    if (!bookingReference) throw new HttpError(400, "bookingReference is required");
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      throw new HttpError(400, "razorpayOrderId, razorpayPaymentId and razorpaySignature are required");
    }

    const booking = await EventBookingModel.findOne({ bookingReference });
    if (!booking) throw new HttpError(404, "Booking not found");
    if (String(booking.user) !== userId) throw new HttpError(403, "Forbidden");

    // Idempotent: a repeat verify after success just returns the booking.
    if (booking.paymentStatus === "paid") {
      res.json({ booking: booking.toJSON() });
      return;
    }
    if (booking.razorpayOrderId && booking.razorpayOrderId !== razorpayOrderId) {
      throw new HttpError(400, "orderId does not match this booking");
    }

    const signatureValid = verifySignature(razorpayOrderId, razorpayPaymentId, razorpaySignature);
    if (!signatureValid) {
      await releaseHolds(booking.event as Types.ObjectId, booking.tickets.map((t) => ({
        ticketId: t.ticketTypeId as Types.ObjectId,
        ticketName: t.ticketName,
        quantity: t.quantity,
        unitPrice: t.unitPrice,
        subtotal: t.subtotal,
      })));
      booking.paymentStatus = "failed";
      booking.status = "cancelled";
      await booking.save();
      await updateTransactionStatus(razorpayOrderId, razorpayPaymentId, razorpaySignature, "failed").catch(() => undefined);
      throw new HttpError(400, "Payment signature verification failed");
    }

    // Anti-tamper: captured amount must cover the booking total (source of truth
    // is Razorpay, never the client). Best-effort — if the fetch fails we proceed
    // on the verified signature, as the flight flow does.
    try {
      const payment = await fetchPayment(razorpayPaymentId);
      if (payment.orderId && payment.orderId !== razorpayOrderId) {
        throw new HttpError(400, "Payment does not match this order");
      }
      if (payment.amountPaise + 100 < Math.round(booking.totalAmount * 100)) {
        throw new HttpError(400, "Captured amount is less than the booking total");
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // fetch failed (e.g. Razorpay unconfigured) — continue on the valid signature.
    }

    const totalTickets = booking.tickets.reduce((n, t) => n + t.quantity, 0);
    await confirmBookingInventory(
      booking.event as Types.ObjectId,
      booking.tickets.map((t) => ({
        ticketId: t.ticketTypeId as Types.ObjectId,
        ticketName: t.ticketName,
        quantity: t.quantity,
        unitPrice: t.unitPrice,
        subtotal: t.subtotal,
      })),
      totalTickets,
    );

    booking.razorpayOrderId = razorpayOrderId;
    booking.razorpayPaymentId = razorpayPaymentId;
    booking.paymentStatus = "paid";
    booking.status = "confirmed";
    booking.paidAt = new Date();
    booking.qrCode = await makeQrCode(booking.bookingReference);
    await booking.save();

    await updateTransactionStatus(razorpayOrderId, razorpayPaymentId, razorpaySignature, "success").catch(() => undefined);

    const eventDoc = await EventListingModel.findById(booking.event);
    if (eventDoc) void notifyBookingConfirmed(booking, eventDoc); // fire-and-forget

    res.json({ booking: booking.toJSON() });
  } catch (e) {
    next(e);
  }
}

// GET /api/bookings/events — the customer's own event bookings.
export async function listMyBookings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = userIdFrom(req);
    const items = await EventBookingModel.find({ user: userId })
      .sort({ createdAt: -1 })
      .populate("event", "title slug startDate venue images");
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

// GET /api/bookings/events/:bookingRef — a single booking the customer owns.
export async function getMyBooking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = userIdFrom(req);
    const booking = await EventBookingModel.findOne({ bookingReference: paramStr(req.params.bookingRef) })
      .populate("event", "title slug startDate endDate venue images organizer");
    if (!booking) throw new HttpError(404, "Booking not found");
    if (String(booking.user) !== userId) throw new HttpError(403, "Forbidden");
    res.json({ item: booking.toJSON() });
  } catch (e) {
    next(e);
  }
}

// POST /api/bookings/events/:bookingRef/cancel — cancel, release inventory and
// compute the refund per the event's cancellation policy.
export async function cancelBooking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = userIdFrom(req);
    const booking = await EventBookingModel.findOne({ bookingReference: paramStr(req.params.bookingRef) });
    if (!booking) throw new HttpError(404, "Booking not found");
    if (String(booking.user) !== userId) throw new HttpError(403, "Forbidden");
    if (booking.status === "cancelled") throw new HttpError(409, "Booking is already cancelled");
    if (booking.status === "checked_in") throw new HttpError(409, "A checked-in booking cannot be cancelled");

    const event = await EventListingModel.findById(booking.event);
    const wasConfirmed = booking.status === "confirmed" && booking.paymentStatus === "paid";
    const totalTickets = booking.tickets.reduce((n, t) => n + t.quantity, 0);
    const lines: ReservedLine[] = booking.tickets.map((t) => ({
      ticketId: t.ticketTypeId as Types.ObjectId,
      ticketName: t.ticketName,
      quantity: t.quantity,
      unitPrice: t.unitPrice,
      subtotal: t.subtotal,
    }));

    // Return inventory: held (pending) bookings only released availability; paid
    // bookings also drop soldQuantity + currentBookings.
    await releaseHolds(booking.event as Types.ObjectId, lines);
    if (wasConfirmed && event) {
      for (const l of lines) {
        await EventListingModel.updateOne(
          { _id: event._id },
          { $inc: { "tickets.$[t].soldQuantity": -l.quantity } },
          { arrayFilters: [{ "t._id": l.ticketId }] },
        );
      }
      await EventListingModel.updateOne({ _id: event._id }, { $inc: { currentBookings: -totalTickets } });
      await EventListingModel.updateOne(
        { _id: event._id, $expr: { $lt: ["$currentBookings", "$totalCapacity"] } },
        { $set: { isSoldOut: false } },
      );
    }

    // Refund per policy (subtotal is the ticket value; platform fee/GST are not
    // refunded). Best-effort Razorpay refund on full_refund of a paid booking.
    const policy = event?.cancellationPolicy ?? "no_refund";
    let refundAmount = 0;
    if (wasConfirmed) {
      if (policy === "full_refund") refundAmount = booking.totalAmount;
      else if (policy === "partial_refund") refundAmount = Math.round(booking.subtotal * 0.5);
    }

    booking.status = "cancelled";
    booking.cancelledAt = new Date();
    booking.cancellationReason =
      typeof (req.body as Record<string, unknown>)?.reason === "string"
        ? ((req.body as Record<string, unknown>).reason as string).trim()
        : undefined;
    booking.refundAmount = refundAmount;

    if (refundAmount > 0 && booking.razorpayPaymentId) {
      try {
        await initiateRefund({
          paymentId: booking.razorpayPaymentId,
          amountPaise: Math.round(refundAmount * 100),
          notes: { bookingReference: booking.bookingReference },
        });
        booking.refundStatus = "processed";
        booking.paymentStatus = "refunded";
      } catch {
        booking.refundStatus = "pending"; // ops will reconcile
      }
    } else {
      booking.refundStatus = "not_applicable";
    }
    await booking.save();
    if (event) void notifyBookingCancelled(booking, event); // fire-and-forget
    res.json({ item: booking.toJSON() });
  } catch (e) {
    next(e);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ADMIN  (mounted at /api/admin/events — env-gated admin session)
// ════════════════════════════════════════════════════════════════════════════

// GET /api/admin/events — all events, any status, optional status filter.
export async function adminListEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = req.query as Record<string, unknown>;
    const filter: Record<string, unknown> = {};
    if (typeof q.status === "string" && (EVENT_STATUS as readonly string[]).includes(q.status)) {
      filter.status = q.status;
    }
    const { page, limit, skip } = paginate(q);
    const [items, total] = await Promise.all([
      EventListingModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      EventListingModel.countDocuments(filter),
    ]);
    res.json({
      items: items.map((i) => i.toJSON()),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (e) {
    next(e);
  }
}

// PATCH /api/admin/events/:id/review — approve (→ published) or reject (→ rejected).
export async function adminReviewEvent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = paramStr(req.params.id);
    ensureValidId(id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const decision = body.decision;
    if (decision !== "approve" && decision !== "reject") {
      throw new HttpError(400, "decision must be 'approve' or 'reject'");
    }
    const doc = await EventListingModel.findById(id);
    if (!doc) throw new HttpError(404, "Event not found");
    doc.status = decision === "approve" ? "published" : "rejected";
    if (decision === "reject" && typeof body.reason === "string") {
      doc.cancellationDetails = body.reason.trim(); // reuse free-text field for the rejection note
    }
    if (typeof body.isFeatured === "boolean") doc.isFeatured = body.isFeatured;
    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// GET /api/admin/events/analytics — platform-wide event + booking stats.
export async function adminEventAnalytics(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const [byStatus, bookingAgg] = await Promise.all([
      EventListingModel.aggregate<{ _id: string; count: number }>([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      EventBookingModel.aggregate<{ _id: string; count: number; revenue: number }>([
        { $group: { _id: "$status", count: { $sum: 1 }, revenue: { $sum: "$totalAmount" } } },
      ]),
    ]);
    res.json({
      eventsByStatus: byStatus.map((r) => ({ status: r._id, count: r.count })),
      bookingsByStatus: bookingAgg.map((r) => ({ status: r._id, count: r.count, revenue: r.revenue })),
    });
  } catch (e) {
    next(e);
  }
}
