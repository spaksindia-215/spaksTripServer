import { Request, Response, NextFunction } from "express";
import mongoose, { Types, Model } from "mongoose";
import { ServiceEnquiryModel, type ServiceEnquiryDoc } from "../models/partner/ServiceEnquiry";
import { uploadManyToCloudinary } from "../lib/cloudinary";
import { resolveOptionalUser } from "../middleware/auth";
import { HttpError } from "../middleware/error";
import {
  ENQUIRY_STATUS,
  type ResourceStatus,
  type EnquiryStatus,
  type ServiceVertical,
} from "../models/partner/_shared/enums";

// Shared partner + public controller factory for the enquiry-first service
// modules (Transfer, Self-Drive, Islandhopper, Visa). Each module supplies its
// typed model, vertical, image folder, validator, and a browse-filter/sort builder;
// the common CRUD + lead-routing + public browse/detail/enquire behaviour lives
// here so the four modules don't each re-implement it. Admin moderation is handled
// by the shared moderation registry, so there is no admin tier here.
//
// SightSeeing predates this factory and keeps its own controller as the reference
// implementation; the behaviour is intentionally identical.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = Model<any>;

export interface ServiceModuleConfig {
  vertical: ServiceVertical;
  model: AnyModel;
  imageFolder: string; // e.g. "spakstrip/transfer"
  // Validates the parsed JSON body → the persisted fields (minus partner/slug/status).
  validate: (body: unknown) => Record<string, unknown>;
  // Builds the Mongo filter for public browse from the query (status:"active" is added).
  buildBrowseFilter: (q: Record<string, unknown>) => Record<string, unknown>;
  // Builds the sort spec from the query (defaults to { createdAt: -1 }).
  buildSort?: (q: Record<string, unknown>) => Record<string, 1 | -1>;
  // Populated partner fields on the public detail response.
  partnerFields?: string;
  notFoundLabel?: string; // e.g. "Transfer service"
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
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
function listingBody(req: Request): Record<string, unknown> {
  const raw = (req.body as Record<string, unknown>)?.data;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return isObject(parsed) ? parsed : {};
    } catch {
      throw new HttpError(400, "data must be valid JSON");
    }
  }
  return (req.body as Record<string, unknown>) ?? {};
}
function paginate(q: Record<string, unknown>): { page: number; limit: number; skip: number } {
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(q.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

export interface ServiceModuleHandlers {
  partnerCreate: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  partnerListMine: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  partnerGet: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  partnerUpdate: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  partnerSetStatus: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  partnerDelete: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  partnerListEnquiries: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  partnerUpdateEnquiry: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  publicBrowse: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  publicGetDetail: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  publicSubmitEnquiry: (req: Request, res: Response, next: NextFunction) => Promise<void>;
}

export function makeServiceModule(cfg: ServiceModuleConfig): ServiceModuleHandlers {
  const NOT_FOUND = cfg.notFoundLabel ?? "Listing";
  const PARTNER_FIELDS = cfg.partnerFields ?? "name companyName email phone slug";

  async function uploadImages(req: Request): Promise<string[]> {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const toUpload = files.filter((f) => f.fieldname === "images");
    if (toUpload.length === 0) return [];
    return uploadManyToCloudinary(toUpload, cfg.imageFolder);
  }

  async function ownedListing(req: Request) {
    const partnerId = userIdFrom(req);
    const id = paramStr(req.params.id);
    ensureValidId(id);
    const doc = await cfg.model.findById(id);
    if (!doc) throw new HttpError(404, `${NOT_FOUND} not found`);
    if (String(doc.partner) !== partnerId) throw new HttpError(403, "Forbidden");
    return doc;
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

  return {
    async partnerCreate(req, res, next) {
      try {
        const partnerId = userIdFrom(req);
        const imageUrls = await uploadImages(req);
        const input = cfg.validate(listingBody(req));
        const doc = await cfg.model.create({
          ...input,
          partner: partnerId,
          status: "draft",
          images: imageUrls.map((url, i) => ({ url, isPrimary: i === 0 })),
        });
        res.status(201).json({ item: doc.toJSON() });
      } catch (e) {
        next(e);
      }
    },

    async partnerListMine(req, res, next) {
      try {
        const partnerId = userIdFrom(req);
        const items = await cfg.model.find({ partner: partnerId }).sort({ createdAt: -1 });
        res.json({ items: items.map((i: { toJSON: () => unknown }) => i.toJSON()) });
      } catch (e) {
        next(e);
      }
    },

    async partnerGet(req, res, next) {
      try {
        res.json({ item: (await ownedListing(req)).toJSON() });
      } catch (e) {
        next(e);
      }
    },

    async partnerUpdate(req, res, next) {
      try {
        const doc = await ownedListing(req);
        const newImages = await uploadImages(req);
        const input = cfg.validate(listingBody(req));
        const prevStatus = doc.status; // a field edit never changes approval state (§2.3)
        Object.assign(doc, input);
        doc.status = prevStatus; // publishing goes through submit → admin approval, not this edit
        if (newImages.length > 0) doc.images = newImages.map((url, i) => ({ url, isPrimary: i === 0 }));
        await doc.save();
        res.json({ item: doc.toJSON() });
      } catch (e) {
        next(e);
      }
    },

    async partnerSetStatus(req, res, next) {
      try {
        const doc = await ownedListing(req);
        const target = (req.body as Record<string, unknown>)?.status;
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
    },

    async partnerDelete(req, res, next) {
      try {
        const doc = await ownedListing(req);
        doc.status = "suspended"; // soft-delete
        await doc.save();
        res.status(204).end();
      } catch (e) {
        next(e);
      }
    },

    async partnerListEnquiries(req, res, next) {
      try {
        const partnerId = userIdFrom(req);
        const filter: Record<string, unknown> = { partner: partnerId, vertical: cfg.vertical };
        const { status } = req.query;
        if (typeof status === "string" && (ENQUIRY_STATUS as readonly string[]).includes(status)) {
          filter.status = status;
        }
        const items = await ServiceEnquiryModel.find(filter)
          .sort({ createdAt: -1 })
          .populate("listing", "title slug");
        res.json({ items: items.map((i) => i.toJSON()) });
      } catch (e) {
        next(e);
      }
    },

    async partnerUpdateEnquiry(req, res, next) {
      try {
        const partnerId = userIdFrom(req);
        const id = paramStr(req.params.id);
        ensureValidId(id);
        const doc = await ServiceEnquiryModel.findById(id);
        if (!doc || doc.vertical !== cfg.vertical) throw new HttpError(404, "Enquiry not found");
        if (String(doc.partner) !== partnerId) throw new HttpError(403, "Forbidden");
        applyEnquiryUpdate(doc, req.body);
        await doc.save();
        res.json({ item: doc.toJSON() });
      } catch (e) {
        next(e);
      }
    },

    async publicBrowse(req, res, next) {
      try {
        const q = req.query as Record<string, unknown>;
        const filter: Record<string, unknown> = { status: "active", ...cfg.buildBrowseFilter(q) };
        const sort = cfg.buildSort?.(q) ?? { createdAt: -1 };
        const { page, limit, skip } = paginate(q);
        const [docs, total] = await Promise.all([
          cfg.model.find(filter).sort(sort).skip(skip).limit(limit),
          cfg.model.countDocuments(filter),
        ]);
        res.json({
          items: docs.map((d: { toJSON: () => unknown }) => d.toJSON()),
          pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        });
      } catch (e) {
        next(e);
      }
    },

    async publicGetDetail(req, res, next) {
      try {
        const doc = await cfg.model
          .findOne({ slug: paramStr(req.params.slug), status: "active" })
          .populate("partner", PARTNER_FIELDS);
        if (!doc) throw new HttpError(404, `${NOT_FOUND} not found`);
        res.json({ item: doc.toJSON() });
      } catch (e) {
        next(e);
      }
    },

    async publicSubmitEnquiry(req, res, next) {
      try {
        const listing = await cfg.model.findOne({ slug: paramStr(req.params.slug), status: "active" });
        if (!listing) throw new HttpError(404, `${NOT_FOUND} not found`);

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

        const user = resolveOptionalUser(req);
        const doc = await ServiceEnquiryModel.create({
          vertical: cfg.vertical,
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
    },
  };
}
