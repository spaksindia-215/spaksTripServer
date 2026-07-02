import { Request, Response, NextFunction } from "express";
import mongoose, { Types, type Model } from "mongoose";
import { PackageModel, type PackageDoc } from "../models/partner/Package";
import { PackageOfferModel, type PackageOfferDoc } from "../models/partner/PackageOffer";
import { PackageEnquiryModel } from "../models/partner/PackageEnquiry";
import { TaxiListingModel } from "../models/partner/TaxiListing";
import { TourListingModel } from "../models/partner/TourListing";
import { HotelListingModel } from "../models/partner/HotelListing";
import { SightseeingListingModel } from "../models/partner/SightseeingListing";
import { TransferListingModel } from "../models/partner/TransferListing";
import { SelfDriveListingModel } from "../models/partner/SelfDriveListing";
import { IslandhopperListingModel } from "../models/partner/IslandhopperListing";
import { VisaListingModel } from "../models/partner/VisaListing";
import { CruiseListingModel } from "../models/partner/CruiseListing";
import { EventListingModel } from "../models/partner/EventListing";
import { validatePackage, validateOffer, validateEnquiry } from "../validators/package.validators";
import { uploadManyToCloudinary } from "../lib/cloudinary";
import { resolveOptionalUser } from "../middleware/auth";
import { HttpError } from "../middleware/error";
import {
  RESOURCE_STATUS,
  PACKAGE_KINDS,
  PACKAGE_SCOPES,
  ENQUIRY_STATUS,
  type ResourceStatus,
  type EnquiryStatus,
  type ListingRefModel,
} from "../models/partner/_shared/enums";

// Marketplace package endpoints across three permission tiers:
//   • PARTNER  (/api/partner/packages)  — own custom packages + own offers + leads
//   • PUBLIC   (/api/packages)          — browse, detail-with-offers, submit enquiry
//   • ADMIN    (/api/admin/packages)    — fixed templates, moderation, all leads
// Follows packages/events controller conventions: try/catch → next(e), HttpError
// for client errors, toJSON for output.

const OPERATOR_FIELDS = "name companyName email phone slug";

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

// Package create/update arrive as multipart: the whole body is a JSON string in a
// `data` field, with image files under `images`. Falls back to the parsed body for
// JSON requests.
function packageBody(req: Request): Record<string, unknown> {
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

async function uploadPackageImages(req: Request): Promise<string[]> {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const toUpload = files.filter((f) => f.fieldname === "images");
  if (toUpload.length === 0) return [];
  return uploadManyToCloudinary(toUpload, "spakstrip/packages");
}

function paginate(q: Record<string, unknown>): { page: number; limit: number; skip: number } {
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(q.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

// Public package-card augmented with operator count + lowest active offer price.
async function withOfferStats(packages: PackageDoc[]): Promise<Record<string, unknown>[]> {
  if (packages.length === 0) return [];
  const ids = packages.map((p) => p._id);
  const stats = await PackageOfferModel.aggregate<{ _id: Types.ObjectId; operatorCount: number; fromPrice: number }>([
    { $match: { package: { $in: ids }, status: "active" } },
    { $group: { _id: "$package", operatorCount: { $sum: 1 }, fromPrice: { $min: "$price" } } },
  ]);
  const byId = new Map(stats.map((s) => [String(s._id), s]));
  return packages.map((p) => {
    const s = byId.get(String(p._id));
    return { ...p.toJSON(), operatorCount: s?.operatorCount ?? 0, fromPrice: s?.fromPrice ?? null };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// PARTNER  (/api/partner/packages — auth + role "partner")
// ════════════════════════════════════════════════════════════════════════════

export async function partnerCreatePackage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const partnerId = userIdFrom(req);
    const imageUrls = await uploadPackageImages(req);
    const input = validatePackage({ body: packageBody(req), imageUrls });
    const doc = await PackageModel.create({
      ...input,
      origin: "partner",
      author: partnerId,
      // §2.3 — every partner-created package must be approved before it goes live.
      // Starts pending; the superadmin queue surfaces it, and admin approval flips
      // it to "active". Partners can never self-publish (see partnerSetPackageStatus).
      status: "pending",
    });
    res.status(201).json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

export async function partnerListMyPackages(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const partnerId = userIdFrom(req);
    const items = await PackageModel.find({ author: partnerId, origin: "partner" }).sort({ createdAt: -1 });
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

async function ownedPackage(req: Request): Promise<PackageDoc> {
  const partnerId = userIdFrom(req);
  const id = paramStr(req.params.id);
  ensureValidId(id);
  const doc = await PackageModel.findById(id);
  if (!doc) throw new HttpError(404, "Package not found");
  if (String(doc.author ?? "") !== partnerId) throw new HttpError(403, "Forbidden");
  return doc;
}

export async function partnerGetMyPackage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ item: (await ownedPackage(req)).toJSON() });
  } catch (e) {
    next(e);
  }
}

export async function partnerUpdatePackage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await ownedPackage(req);
    const newImages = await uploadPackageImages(req);
    const body = packageBody(req);
    const imageUrls = newImages.length > 0 ? newImages : doc.images.map((i) => i.url);
    const input = validatePackage({ body, imageUrls });
    Object.assign(doc, input);
    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

export async function partnerDeletePackage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await ownedPackage(req);
    doc.status = "suspended"; // soft-delete: hide from public, keep referencing offers intact
    await doc.save();
    res.status(204).end();
  } catch (e) {
    next(e);
  }
}

export async function partnerSetPackageStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await ownedPackage(req);
    const target = (req.body as Record<string, unknown>)?.status;
    // Partners may pause/unpublish/archive their own package, but never self-approve
    // to "active" (reserved for admin) or "pending" (use the submit action).
    const allowed: ResourceStatus[] = ["draft", "paused", "suspended"];
    if (typeof target !== "string" || !(allowed as readonly string[]).includes(target)) {
      throw new HttpError(400, `status must be one of: ${allowed.join(", ")}`);
    }
    if (doc.status === "active" && target !== "paused" && target !== "suspended") {
      throw new HttpError(409, "An active package can only be paused or suspended");
    }
    doc.status = target as ResourceStatus;
    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// GET /api/partner/packages/catalog — active packages a partner can attach an offer
// to (platform templates + every active package, including other partners').
export async function partnerBrowseCatalog(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = req.query as Record<string, unknown>;
    const filter: Record<string, unknown> = { status: "active" };
    if (typeof q.kind === "string" && (PACKAGE_KINDS as readonly string[]).includes(q.kind)) filter.kind = q.kind;
    if (typeof q.scope === "string" && (PACKAGE_SCOPES as readonly string[]).includes(q.scope)) filter.scope = q.scope;
    if (typeof q.origin === "string") filter.origin = q.origin;
    if (typeof q.q === "string" && q.q.trim()) filter.$text = { $search: q.q.trim() };
    const items = await PackageModel.find(filter).sort({ createdAt: -1 }).limit(200);
    res.json({ items: await withOfferStats(items) });
  } catch (e) {
    next(e);
  }
}

// ── Bundle building — the partner's own service inventory ───────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyListingModel = Model<any>;

// Every vertical a bundle component can link to, with the field that holds its
// display name (a few models use `name`/`cruiseName`/`vehicle.model` instead of
// `title`). Drives GET /my-services below.
const SERVICE_LISTING_REGISTRY: {
  refModel: ListingRefModel;
  model: AnyListingModel;
  category: string;
  titleField: string;
}[] = [
  { refModel: "TaxiListing", model: TaxiListingModel, category: "Taxi", titleField: "vehicle.model" },
  { refModel: "TourListing", model: TourListingModel, category: "Tour", titleField: "title" },
  { refModel: "HotelListing", model: HotelListingModel, category: "Stay", titleField: "name" },
  { refModel: "SightseeingListing", model: SightseeingListingModel, category: "Sightseeing", titleField: "title" },
  { refModel: "TransferListing", model: TransferListingModel, category: "Transfer", titleField: "title" },
  { refModel: "SelfDriveListing", model: SelfDriveListingModel, category: "Self-Drive", titleField: "title" },
  { refModel: "IslandhopperListing", model: IslandhopperListingModel, category: "Island Hopping", titleField: "title" },
  { refModel: "VisaListing", model: VisaListingModel, category: "Visa", titleField: "title" },
  { refModel: "CruiseListing", model: CruiseListingModel, category: "Cruise", titleField: "cruiseName" },
  { refModel: "EventListing", model: EventListingModel, category: "Event", titleField: "title" },
];

function readPath(obj: Record<string, unknown>, path: string): string {
  const v = path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), obj);
  return typeof v === "string" ? v : "";
}

// GET /api/partner/packages/my-services — the partner's own listings across every
// vertical, grouped, so the bundle builder can pick real components. Excludes
// soft-deleted (suspended) listings.
export async function partnerListMyServices(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const partnerId = userIdFrom(req);
    const groups = await Promise.all(
      SERVICE_LISTING_REGISTRY.map(async (r) => {
        const docs = (await r.model
          .find({ partner: partnerId, status: { $ne: "suspended" } })
          .select(`${r.titleField} slug images status`)
          .sort({ createdAt: -1 })
          .lean()) as Record<string, unknown>[];
        const items = docs.map((d) => {
          const images = d.images as { url?: string }[] | undefined;
          return {
            refModel: r.refModel,
            id: String(d._id),
            title: readPath(d, r.titleField) || "(untitled)",
            slug: typeof d.slug === "string" ? d.slug : undefined,
            status: d.status,
            category: r.category,
            thumbnail: images?.[0]?.url,
          };
        });
        return { refModel: r.refModel, category: r.category, items };
      }),
    );
    res.json({ groups: groups.filter((g) => g.items.length > 0) });
  } catch (e) {
    next(e);
  }
}

// ── Offers ─────────────────────────────────────────────────────────────────────

// POST /api/partner/packages/offers — create or update this partner's offer on a
// package (upsert keyed by the unique {package, partner} index).
export async function partnerUpsertOffer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const partnerId = userIdFrom(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const packageId = typeof body.packageId === "string" ? body.packageId : "";
    ensureValidId(packageId);
    const pkg = await PackageModel.findById(packageId);
    if (!pkg) throw new HttpError(404, "Package not found");
    if (pkg.status !== "active") throw new HttpError(409, "Cannot offer on an inactive package");

    const input = validateOffer(body);
    const doc = await PackageOfferModel.findOneAndUpdate(
      { package: pkg._id, partner: partnerId },
      { ...input, package: pkg._id, partner: partnerId },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true },
    );
    res.status(201).json({ item: doc!.toJSON() });
  } catch (e) {
    next(e);
  }
}

export async function partnerListOffers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const partnerId = userIdFrom(req);
    const items = await PackageOfferModel.find({ partner: partnerId })
      .sort({ createdAt: -1 })
      .populate("package", "title slug kind scope thumbnail status");
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

async function ownedOffer(req: Request): Promise<PackageOfferDoc> {
  const partnerId = userIdFrom(req);
  const id = paramStr(req.params.id);
  ensureValidId(id);
  const doc = await PackageOfferModel.findById(id);
  if (!doc) throw new HttpError(404, "Offer not found");
  if (String(doc.partner) !== partnerId) throw new HttpError(403, "Forbidden");
  return doc;
}

export async function partnerUpdateOffer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await ownedOffer(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = validateOffer(body);
    Object.assign(doc, input);
    if (typeof body.status === "string" && (RESOURCE_STATUS as readonly string[]).includes(body.status)) {
      doc.status = body.status as ResourceStatus;
    }
    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

export async function partnerDeleteOffer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await ownedOffer(req);
    await doc.deleteOne();
    res.status(204).end();
  } catch (e) {
    next(e);
  }
}

// ── Enquiries (leads routed to this partner) ─────────────────────────────────────
export async function partnerListEnquiries(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const partnerId = userIdFrom(req);
    const filter: Record<string, unknown> = { partner: partnerId };
    const { status } = req.query;
    if (typeof status === "string" && (ENQUIRY_STATUS as readonly string[]).includes(status)) filter.status = status;
    const items = await PackageEnquiryModel.find(filter)
      .sort({ createdAt: -1 })
      .populate("package", "title slug kind scope")
      .populate("offer", "price currency");
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
    const doc = await PackageEnquiryModel.findById(id);
    if (!doc) throw new HttpError(404, "Enquiry not found");
    if (String(doc.partner) !== partnerId) throw new HttpError(403, "Forbidden");
    applyEnquiryUpdate(doc, req.body);
    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// Shared status/note mutation used by both partner and admin enquiry updates.
function applyEnquiryUpdate(doc: { status: EnquiryStatus; internalNotes: { at: Date; text: string }[] }, raw: unknown): void {
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
// PUBLIC  (/api/packages — no auth; enquiry allows guest or customer)
// ════════════════════════════════════════════════════════════════════════════

export async function publicListPackages(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = req.query as Record<string, unknown>;
    const filter: Record<string, unknown> = { status: "active" };
    if (typeof q.kind === "string" && (PACKAGE_KINDS as readonly string[]).includes(q.kind)) filter.kind = q.kind;
    if (typeof q.scope === "string" && (PACKAGE_SCOPES as readonly string[]).includes(q.scope)) filter.scope = q.scope;
    if (typeof q.destination === "string" && q.destination.trim()) {
      filter["route.destinations"] = new RegExp(q.destination.trim(), "i");
    }
    if (typeof q.q === "string" && q.q.trim()) filter.$text = { $search: q.q.trim() };

    const { page, limit, skip } = paginate(q);
    const [docs, total] = await Promise.all([
      PackageModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      PackageModel.countDocuments(filter),
    ]);
    res.json({
      items: await withOfferStats(docs),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (e) {
    next(e);
  }
}

// GET /api/packages/kinds — active-package counts per kind+scope (for nav badges).
export async function publicListKinds(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await PackageModel.aggregate<{ _id: { kind: string; scope: string }; count: number }>([
      { $match: { status: "active" } },
      { $group: { _id: { kind: "$kind", scope: "$scope" }, count: { $sum: 1 } } },
    ]);
    res.json({ items: rows.map((r) => ({ kind: r._id.kind, scope: r._id.scope, count: r.count })) });
  } catch (e) {
    next(e);
  }
}

// GET /api/packages/:slug — package detail with its active operator offers. Each
// offer exposes price + operator identity; the direct contact is included ONLY when
// the operator opted to share it (showDirectContact), otherwise it's platform-mediated.
export async function publicGetPackage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const pkg = await PackageModel.findOne({ slug: paramStr(req.params.slug), status: "active" });
    if (!pkg) throw new HttpError(404, "Package not found");
    const offers = await PackageOfferModel.find({ package: pkg._id, status: "active" })
      .sort({ price: 1 })
      .populate("partner", OPERATOR_FIELDS);

    const offerCards = offers.map((o) => {
      const json = o.toJSON() as Record<string, unknown>;
      if (!o.showDirectContact) delete json.directContact;
      return json;
    });
    res.json({ item: pkg.toJSON(), offers: offerCards });
  } catch (e) {
    next(e);
  }
}

// POST /api/packages/:slug/enquire — create a lead against a chosen operator offer.
export async function publicCreateEnquiry(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const pkg = await PackageModel.findOne({ slug: paramStr(req.params.slug), status: "active" });
    if (!pkg) throw new HttpError(404, "Package not found");

    const body = (req.body ?? {}) as Record<string, unknown>;
    const offerId = typeof body.offerId === "string" ? body.offerId : "";
    if (!offerId) throw new HttpError(400, "offerId is required");
    ensureValidId(offerId);
    const offer = await PackageOfferModel.findOne({ _id: offerId, package: pkg._id, status: "active" });
    if (!offer) throw new HttpError(404, "Selected operator offer is not available");

    const input = validateEnquiry(body);
    const user = resolveOptionalUser(req); // guests allowed; attribute if logged in

    const doc = await PackageEnquiryModel.create({
      package: pkg._id,
      offer: offer._id,
      partner: offer.partner,
      ...(user ? { customer: new Types.ObjectId(user.sub) } : {}),
      contact: input.contact,
      travelDate: input.travelDate,
      pax: input.pax,
      message: input.message,
    });
    res.status(201).json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ADMIN  (/api/admin/packages — env-gated admin session)
// ════════════════════════════════════════════════════════════════════════════

export async function adminCreateTemplate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const imageUrls = await uploadPackageImages(req);
    const input = validatePackage({ body: packageBody(req), imageUrls });
    const doc = await PackageModel.create({ ...input, origin: "platform", status: "active" });
    res.status(201).json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

export async function adminListPackages(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = req.query as Record<string, unknown>;
    const filter: Record<string, unknown> = {};
    if (typeof q.kind === "string" && (PACKAGE_KINDS as readonly string[]).includes(q.kind)) filter.kind = q.kind;
    if (typeof q.scope === "string" && (PACKAGE_SCOPES as readonly string[]).includes(q.scope)) filter.scope = q.scope;
    if (typeof q.origin === "string") filter.origin = q.origin;
    if (typeof q.status === "string" && (RESOURCE_STATUS as readonly string[]).includes(q.status)) filter.status = q.status;
    const { page, limit, skip } = paginate(q);
    const [items, total] = await Promise.all([
      PackageModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate("author", OPERATOR_FIELDS),
      PackageModel.countDocuments(filter),
    ]);
    res.json({
      items: items.map((i) => i.toJSON()),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (e) {
    next(e);
  }
}

async function adminPackage(req: Request): Promise<PackageDoc> {
  const id = paramStr(req.params.id);
  ensureValidId(id);
  const doc = await PackageModel.findById(id);
  if (!doc) throw new HttpError(404, "Package not found");
  return doc;
}

export async function adminGetPackage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ item: (await adminPackage(req)).toJSON() });
  } catch (e) {
    next(e);
  }
}

export async function adminUpdatePackage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await adminPackage(req);
    const newImages = await uploadPackageImages(req);
    const imageUrls = newImages.length > 0 ? newImages : doc.images.map((i) => i.url);
    const input = validatePackage({ body: packageBody(req), imageUrls });
    Object.assign(doc, input);
    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

export async function adminSetPackageStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await adminPackage(req);
    const target = (req.body as Record<string, unknown>)?.status;
    if (typeof target !== "string" || !(RESOURCE_STATUS as readonly string[]).includes(target)) {
      throw new HttpError(400, `status must be one of: ${RESOURCE_STATUS.join(", ")}`);
    }
    doc.status = target as ResourceStatus;
    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// ── §5.3 Duplicate-detection ────────────────────────────────────────────────
// Superadmin must reject a partner submission that merely copies a platform
// template without real modification. This auto-matches the closest same-kind
// template (by normalized field similarity) and returns a field-by-field diff so
// the reviewer can eyeball the differences and see a duplicate-likelihood score.
const COMPARE_FIELDS = [
  "title",
  "description",
  "highlights",
  "inclusions",
  "exclusions",
  "destinations",
  "duration",
  "itinerary",
  "referencePrice",
] as const;

function normText(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => normText(x)).join(" | ");
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function packageFieldValues(p: PackageDoc): Record<string, string> {
  return {
    title: normText(p.title),
    description: normText(p.description),
    highlights: normText(p.highlights),
    inclusions: normText(p.inclusions),
    exclusions: normText(p.exclusions),
    destinations: normText(p.route?.destinations),
    duration: normText(`${p.route?.durationDays ?? ""}d/${p.route?.durationNights ?? ""}n`),
    itinerary: normText((p.itinerary ?? []).map((d) => ({ t: d.title, d: d.description }))),
    referencePrice: normText(p.referencePrice),
  };
}

// GET /api/admin/packages/:id/compare — closest template match + diff for review.
export async function adminComparePackage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const pkg = await adminPackage(req);
    const candidates = await PackageModel.find({
      origin: "platform",
      kind: pkg.kind,
      _id: { $ne: pkg._id },
    });
    const pv = packageFieldValues(pkg);
    let best: { doc: PackageDoc; tv: Record<string, string>; score: number } | null = null;
    for (const c of candidates) {
      const tv = packageFieldValues(c);
      let matches = 0;
      let considered = 0;
      for (const f of COMPARE_FIELDS) {
        const a = pv[f];
        const b = tv[f];
        if (!a && !b) continue; // both empty — not a meaningful signal
        considered += 1;
        if (a === b) matches += 1;
      }
      const score = considered > 0 ? matches / considered : 0;
      if (!best || score > best.score) best = { doc: c, tv, score };
    }
    const fields = COMPARE_FIELDS.map((f) => ({
      field: f,
      partnerValue: pv[f],
      templateValue: best ? best.tv[f] : "",
      identical: best ? pv[f] === best.tv[f] && (pv[f] !== "" || best.tv[f] !== "") : false,
    }));
    res.json({
      package: pkg.toJSON(),
      template: best ? best.doc.toJSON() : null,
      similarity: best ? Number(best.score.toFixed(2)) : 0,
      likelyDuplicate: best ? best.score >= 0.9 : false,
      fields,
    });
  } catch (e) {
    next(e);
  }
}

export async function adminDeletePackage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await adminPackage(req);
    await doc.deleteOne();
    await PackageOfferModel.deleteMany({ package: doc._id });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
}

export async function adminListOffers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = req.query as Record<string, unknown>;
    const filter: Record<string, unknown> = {};
    if (typeof q.packageId === "string" && mongoose.isValidObjectId(q.packageId)) filter.package = q.packageId;
    const items = await PackageOfferModel.find(filter)
      .sort({ createdAt: -1 })
      .populate("partner", OPERATOR_FIELDS)
      .populate("package", "title slug kind scope");
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

export async function adminListEnquiries(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = req.query as Record<string, unknown>;
    const filter: Record<string, unknown> = {};
    if (typeof q.status === "string" && (ENQUIRY_STATUS as readonly string[]).includes(q.status)) filter.status = q.status;
    const { page, limit, skip } = paginate(q);
    const [items, total] = await Promise.all([
      PackageEnquiryModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("package", "title slug kind scope")
        .populate("partner", OPERATOR_FIELDS)
        .populate("offer", "price currency"),
      PackageEnquiryModel.countDocuments(filter),
    ]);
    res.json({
      items: items.map((i) => i.toJSON()),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (e) {
    next(e);
  }
}

export async function adminUpdateEnquiry(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = paramStr(req.params.id);
    ensureValidId(id);
    const doc = await PackageEnquiryModel.findById(id);
    if (!doc) throw new HttpError(404, "Enquiry not found");
    applyEnquiryUpdate(doc, req.body);
    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}
