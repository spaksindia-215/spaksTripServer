import { Request, Response, NextFunction } from "express";
import mongoose, { Model } from "mongoose";
import { HotelListingModel } from "../models/partner/HotelListing";
import { TaxiListingModel } from "../models/partner/TaxiListing";
import { TaxiPackageModel } from "../models/partner/TaxiPackage";
import { TourListingModel } from "../models/partner/TourListing";
import { TourPackageModel } from "../models/partner/TourPackage";
import { CruiseListingModel } from "../models/partner/CruiseListing";
import { SightseeingListingModel } from "../models/partner/SightseeingListing";
import { TransferListingModel } from "../models/partner/TransferListing";
import { SelfDriveListingModel } from "../models/partner/SelfDriveListing";
import { IslandhopperListingModel } from "../models/partner/IslandhopperListing";
import { VisaListingModel } from "../models/partner/VisaListing";
import { RESOURCE_STATUS } from "../models/partner/_shared/enums";
import { HttpError } from "../middleware/error";

// Generic moderation layer shared by every partner-resource vertical. Each type
// keeps its own collection/model; this registry adapts them to one normalized
// shape so the admin review queue and the partner "submit for review" action
// work the same way across hotels, taxis, packages, tours and cruises.

export type ListingType =
  | "hotel"
  | "taxi"
  | "taxi_package"
  | "tour"
  | "tour_package"
  | "cruise"
  | "sightseeing"
  | "transfer"
  | "self_drive"
  | "islandhopper"
  | "visa";

type AnyDoc = Record<string, unknown>;

type RegistryEntry = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: Model<any>;
  label: string;
  // Pull a display title + thumbnail + location subtitle out of the raw doc.
  view: (d: AnyDoc) => { title: string; thumbnail?: string; subtitle?: string };
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}
function paramStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function firstImageUrl(images: unknown): string | undefined {
  if (Array.isArray(images) && images.length > 0) {
    const first = images[0] as Record<string, unknown> | string;
    if (typeof first === "string") return first;
    if (first && typeof first === "object") return str((first as Record<string, unknown>).url);
  }
  return undefined;
}
function get(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k];
    else return undefined;
  }
  return cur;
}

const REGISTRY: Record<ListingType, RegistryEntry> = {
  hotel: {
    model: HotelListingModel,
    label: "Hotel",
    view: (d) => ({
      title: str(d.name) ?? "Untitled hotel",
      thumbnail: firstImageUrl(d.images),
      subtitle: str(get(d, "address", "city")),
    }),
  },
  taxi: {
    model: TaxiListingModel,
    label: "Taxi",
    view: (d) => ({
      title:
        [str(get(d, "vehicle", "make")), str(get(d, "vehicle", "model"))].filter(Boolean).join(" ") ||
        "Taxi listing",
      thumbnail: firstImageUrl(get(d, "vehicle", "images")),
      subtitle: str(get(d, "services", "0", "coverage", "baseCity")),
    }),
  },
  taxi_package: {
    model: TaxiPackageModel,
    label: "Taxi Package",
    view: (d) => ({
      title: str(d.title) ?? "Taxi package",
      thumbnail: str(d.thumbnail) ?? firstImageUrl(d.images),
      subtitle: str(get(d, "route", "origin")),
    }),
  },
  tour: {
    model: TourListingModel,
    label: "Tour",
    view: (d) => ({
      title: str(d.title) ?? "Tour",
      thumbnail: firstImageUrl(d.images),
      subtitle: str(d.basedIn),
    }),
  },
  tour_package: {
    model: TourPackageModel,
    label: "Tour Package",
    view: (d) => ({
      title: str(d.title) ?? "Tour package",
      thumbnail: str(d.thumbnail) ?? firstImageUrl(d.images),
      subtitle: str(get(d, "route", "origin")),
    }),
  },
  cruise: {
    model: CruiseListingModel,
    label: "Cruise",
    view: (d) => ({
      title: str(d.cruiseName) ?? "Cruise",
      thumbnail: firstImageUrl(get(d, "vessel", "images")),
      subtitle: str(get(d, "route", "departurePort")),
    }),
  },
  sightseeing: {
    model: SightseeingListingModel,
    label: "SightSeeing",
    view: (d) => ({
      title: str(d.title) ?? "Activity",
      thumbnail: firstImageUrl(d.images),
      subtitle: str(get(d, "location", "island")),
    }),
  },
  transfer: {
    model: TransferListingModel,
    label: "Transfer",
    view: (d) => ({
      title: str(d.title) ?? "Transfer service",
      thumbnail: firstImageUrl(d.images),
      subtitle: str(get(d, "routes", "0", "from")),
    }),
  },
  self_drive: {
    model: SelfDriveListingModel,
    label: "Self-Drive",
    view: (d) => ({
      title: str(d.title) ?? "Vehicle rental",
      thumbnail: firstImageUrl(d.images),
      subtitle: str(get(d, "pickupLocations", "0", "name")),
    }),
  },
  islandhopper: {
    model: IslandhopperListingModel,
    label: "Islandhopper",
    view: (d) => ({
      title: str(d.title) ?? "Route",
      thumbnail: firstImageUrl(d.images),
      subtitle: str(get(d, "routes", "0", "origin")),
    }),
  },
  visa: {
    model: VisaListingModel,
    label: "Visa Consultancy",
    view: (d) => ({
      title: str(d.title) ?? "Consultancy",
      thumbnail: firstImageUrl(d.images),
      subtitle: str(get(d, "countriesCovered", "0")),
    }),
  },
};

function entryFor(type: string): RegistryEntry {
  const e = (REGISTRY as Record<string, RegistryEntry | undefined>)[type];
  if (!e) throw new HttpError(400, `Unknown listing type: ${type}`);
  return e;
}

function normalize(type: ListingType, doc: AnyDoc) {
  const view = REGISTRY[type].view(doc);
  const partner = doc.partner as Record<string, unknown> | undefined;
  return {
    id: String(doc._id ?? doc.id),
    type,
    typeLabel: REGISTRY[type].label,
    title: view.title,
    thumbnail: view.thumbnail,
    subtitle: view.subtitle,
    status: doc.status as string,
    partner:
      partner && typeof partner === "object"
        ? { id: String(partner._id ?? partner.id), name: str(partner.name), email: str(partner.email) }
        : undefined,
    createdAt: doc.createdAt as string,
  };
}

// GET /api/admin/listings?status=pending&type=<type> — normalized review queue
// across every partner-resource collection. Defaults to "pending"; ?status=all
// returns every status. Optional ?type narrows to one vertical.
export async function adminListListings(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const statusRaw = typeof req.query.status === "string" ? req.query.status : "pending";
    if (statusRaw !== "all" && !(RESOURCE_STATUS as readonly string[]).includes(statusRaw)) {
      throw new HttpError(400, `status must be one of: ${RESOURCE_STATUS.join(", ")}, all`);
    }
    const typeRaw = typeof req.query.type === "string" ? req.query.type : "";
    const types = typeRaw
      ? [typeRaw as ListingType].filter((t) => t in REGISTRY)
      : (Object.keys(REGISTRY) as ListingType[]);

    const filter: Record<string, unknown> = {};
    if (statusRaw !== "all") filter.status = statusRaw;

    const groups = await Promise.all(
      types.map(async (type) => {
        const docs = await REGISTRY[type].model
          .find(filter)
          .sort({ createdAt: -1 })
          .limit(200)
          .populate("partner", "name email")
          .lean();
        return (docs as AnyDoc[]).map((d) => normalize(type, d));
      }),
    );

    const items = groups.flat().sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    res.json({ items });
  } catch (e) {
    next(e);
  }
}

async function setListingStatus(
  type: string,
  id: string,
  next: "active" | "draft",
): Promise<AnyDoc> {
  const entry = entryFor(type);
  if (!mongoose.isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const doc = await entry.model.findById(id);
  if (!doc) throw new HttpError(404, `${entry.label} not found`);
  if (doc.status !== "pending") throw new HttpError(409, `Listing is already ${doc.status}`);
  doc.status = next;
  await doc.save();
  return doc.toJSON();
}

// POST /api/admin/listings/:type/:id/approve — publish a pending listing.
export async function adminApproveListing(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const item = await setListingStatus(paramStr(req.params.type), paramStr(req.params.id), "active");
    res.json({ item });
  } catch (e) {
    next(e);
  }
}

// POST /api/admin/listings/:type/:id/reject — send a pending listing back to draft.
export async function adminRejectListing(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const item = await setListingStatus(paramStr(req.params.type), paramStr(req.params.id), "draft");
    res.json({ item });
  } catch (e) {
    next(e);
  }
}

// POST /api/admin/listings/:type/:id/status — admin sets any lifecycle status
// (active / paused / suspended / draft / pending). Powers the unified management
// dashboard's Pause / Activate / Suspend actions across every vertical.
export async function adminSetListingStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const entry = entryFor(paramStr(req.params.type));
    const id = paramStr(req.params.id);
    if (!mongoose.isValidObjectId(id)) throw new HttpError(400, "Invalid id");
    const target = (req.body as Record<string, unknown>)?.status;
    if (typeof target !== "string" || !(RESOURCE_STATUS as readonly string[]).includes(target)) {
      throw new HttpError(400, `status must be one of: ${RESOURCE_STATUS.join(", ")}`);
    }
    const doc = await entry.model.findById(id);
    if (!doc) throw new HttpError(404, `${entry.label} not found`);
    doc.status = target;
    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// DELETE /api/admin/listings/:type/:id — hard-delete a listing of any vertical.
export async function adminDeleteListing(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const entry = entryFor(paramStr(req.params.type));
    const id = paramStr(req.params.id);
    if (!mongoose.isValidObjectId(id)) throw new HttpError(400, "Invalid id");
    const doc = await entry.model.findByIdAndDelete(id);
    if (!doc) throw new HttpError(404, `${entry.label} not found`);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
}

// POST /api/partner/listings/:type/:id/submit — owner sends a listing for review
// (draft/paused/suspended → pending). Scoped to the authenticated partner.
export async function partnerSubmitListing(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new HttpError(401, "Unauthorized");
    const entry = entryFor(paramStr(req.params.type));
    const id = paramStr(req.params.id);
    if (!mongoose.isValidObjectId(id)) throw new HttpError(400, "Invalid id");
    const doc = await entry.model.findOne({ _id: id, partner: req.user.sub });
    if (!doc) throw new HttpError(404, `${entry.label} not found`);
    if (doc.status === "pending") throw new HttpError(409, "Listing is already pending review");
    if (doc.status === "active") throw new HttpError(409, "Listing is already live");
    doc.status = "pending";
    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}
