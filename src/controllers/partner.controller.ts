import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { PartnerResourceModel, RESOURCE_TYPES, type ResourceType } from "../models/PartnerResource";
import { BookingModel } from "../models/Booking";
import { HotelListingModel } from "../models/partner/HotelListing";
import { TaxiListingModel } from "../models/partner/TaxiListing";
import { TaxiPackageModel } from "../models/partner/TaxiPackage";
import { TourListingModel } from "../models/partner/TourListing";
import { TourPackageModel } from "../models/partner/TourPackage";
import { CruiseListingModel } from "../models/partner/CruiseListing";
import {
  validateResourceCreate,
  validateResourceUpdate,
} from "../validators/partner.validators";
import { validateHotelListing } from "../validators/hotelListing.validators";
import {
  validateTaxiListing,
  validateTaxiListingUpdate,
  parseSlotStrings,
  type TaxiMedia,
} from "../validators/taxiListing.validators";
import { validateTaxiPackage } from "../validators/taxiPackage.validators";
import { validateTourListing } from "../validators/tourListing.validators";
import { validateTourPackage } from "../validators/tourPackage.validators";
import { validateCruiseListing } from "../validators/cruiseListing.validators";
import { uploadToCloudinary, uploadManyToCloudinary } from "../lib/cloudinary";
import { HttpError } from "../middleware/error";

function partnerIdFrom(req: Request): string {
  if (!req.user) throw new HttpError(401, "Unauthorized");
  return req.user.sub;
}

function ensureValidId(id: string): void {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(400, "Invalid id");
}

function paramStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function listResources(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const filter: Record<string, unknown> = { partnerId };
    const { type } = req.query;
    if (typeof type === "string") {
      if (!(RESOURCE_TYPES as readonly string[]).includes(type)) {
        throw new HttpError(400, `type must be one of: ${RESOURCE_TYPES.join(", ")}`);
      }
      filter.type = type as ResourceType;
    }
    const items = await PartnerResourceModel.find(filter).sort({ createdAt: -1 });
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

export async function createResource(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const input = validateResourceCreate(req.body);
    const doc = await PartnerResourceModel.create({ ...input, partnerId });
    res.status(201).json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// Parse a multipart text field that carries a JSON string. Missing → fallback.
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

// POST /api/partner/hotels — multipart/form-data from the partner hotel form.
// Sections arrive as JSON strings; images as files (hotelImages + roomImages-<id>).
export async function createHotelListing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);

    const hotel = parseJsonField(req, "hotel", {});
    const rooms = parseJsonField(req, "rooms", []);
    const rates = parseJsonField(req, "rates", []);
    const inventory = parseJsonField(req, "inventory", []);
    const pricing = parseJsonField(req, "pricing", {});
    const promotions = parseJsonField(req, "promotions", []);

    // Upload to Cloudinary: `hotelImages` → property images; `roomImages-<id>`
    // → that room's images (keyed by the client-generated room id). Property
    // images keep submission order so the first becomes the primary image.
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const hotelImageUrls = await uploadManyToCloudinary(
      files.filter((f) => f.fieldname === "hotelImages"),
      "spakstrip/hotels",
    );
    const roomImageUrls: Record<string, string[]> = {};
    for (const f of files.filter((f) => f.fieldname.startsWith("roomImages-"))) {
      const url = await uploadToCloudinary(f, "spakstrip/hotels/rooms");
      const roomKey = f.fieldname.slice("roomImages-".length);
      (roomImageUrls[roomKey] ??= []).push(url);
    }

    const input = validateHotelListing({
      hotel,
      rooms,
      rates,
      inventory,
      pricing,
      promotions,
      hotelImageUrls,
      roomImageUrls,
    });

    // Always enters the admin review queue — a partner can never self-publish.
    const doc = await HotelListingModel.create({
      ...input,
      partner: partnerId,
      status: "pending",
    });
    res.status(201).json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// GET /api/partner/hotels — this partner's hotel listings, newest first.
export async function listHotelListings(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const items = await HotelListingModel.find({ partner: partnerId }).sort({ createdAt: -1 });
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

// GET /api/partner/hotels/:id — owner-scoped single listing (for the edit form).
export async function getHotelListing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const id = paramStr(req.params.id);
    ensureValidId(id);
    const doc = await HotelListingModel.findOne({ _id: id, partner: partnerId });
    if (!doc) throw new HttpError(404, "Hotel listing not found");
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// PUT /api/partner/hotels/:id — owner-scoped edit of the core listing fields.
// Images, rooms, rates, inventory and promotions are preserved as-is (managed in
// the create wizard); status is untouched here — use the submit endpoint to send
// a listing for admin review.
export async function updateHotelListing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const id = paramStr(req.params.id);
    ensureValidId(id);
    const doc = await HotelListingModel.findOne({ _id: id, partner: partnerId });
    if (!doc) throw new HttpError(404, "Hotel listing not found");

    const body = (req.body ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | undefined =>
      typeof v === "string" ? v.trim() : undefined;

    if (str(body.name) !== undefined) doc.name = str(body.name)!;
    if (str(body.description) !== undefined) doc.description = str(body.description);
    if (str(body.type) !== undefined) doc.type = str(body.type) as typeof doc.type;
    if (body.starRating !== undefined && body.starRating !== null && body.starRating !== "") {
      doc.starRating = Number(body.starRating) as typeof doc.starRating;
    }
    if (Array.isArray(body.amenities)) {
      doc.amenities = body.amenities.filter((a): a is string => typeof a === "string");
    }

    const address = (body.address ?? {}) as Record<string, unknown>;
    if (isObject(body.address)) {
      doc.address.street = str(address.street);
      if (str(address.city) !== undefined) doc.address.city = str(address.city)!;
      doc.address.state = str(address.state);
      doc.address.country = str(address.country);
      doc.address.postalCode = str(address.postalCode);
    }

    const contact = (body.contact ?? {}) as Record<string, unknown>;
    if (isObject(body.contact)) {
      doc.contact.phone = str(contact.phone);
      doc.contact.email = str(contact.email);
    }

    const policies = (body.policies ?? {}) as Record<string, unknown>;
    if (isObject(body.policies)) {
      doc.policies.checkIn = str(policies.checkIn);
      doc.policies.checkOut = str(policies.checkOut);
      doc.policies.cancellation = str(policies.cancellation);
    }

    const pricing = (body.pricing ?? {}) as Record<string, unknown>;
    if (isObject(body.pricing)) {
      if (pricing.basePricePerNight !== undefined)
        doc.pricing.basePricePerNight = Number(pricing.basePricePerNight);
      if (pricing.taxPercentage !== undefined)
        doc.pricing.taxPercentage = Number(pricing.taxPercentage);
      if (str(pricing.currency) !== undefined)
        doc.pricing.currency = str(pricing.currency) as typeof doc.pricing.currency;
    }

    await doc.save(); // schema validators run on save
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// POST /api/partner/hotels/:id/submit — owner sends a listing for admin review
// (draft/paused/suspended → pending). The admin queue then surfaces it.
export async function submitHotelListing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const id = paramStr(req.params.id);
    ensureValidId(id);
    const doc = await HotelListingModel.findOne({ _id: id, partner: partnerId });
    if (!doc) throw new HttpError(404, "Hotel listing not found");
    if (doc.status === "pending") throw new HttpError(409, "Listing is already pending review");
    if (doc.status === "active") throw new HttpError(409, "Listing is already live");
    doc.status = "pending";
    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// DELETE /api/partner/hotels/:id — owner-scoped delete of a listing.
export async function deleteHotelListing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const id = paramStr(req.params.id);
    ensureValidId(id);
    const doc = await HotelListingModel.findOneAndDelete({ _id: id, partner: partnerId });
    if (!doc) throw new HttpError(404, "Hotel listing not found");
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
}

// POST /api/partner/taxis — multipart: `payload` is the flat list-your-taxi
// listing (JSON string); files are vehiclePhotos[] + doc fields (rcBook,
// insurance, pollutionCertificate, drivingLicense). Uploaded to Cloudinary and
// adapted into the MTI TaxiListing model.
export async function createTaxiListing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const payload = parseJsonField(req, "payload", req.body);

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const byField = (name: string) => files.find((f) => f.fieldname === name);

    const vehicleImageUrls = await uploadManyToCloudinary(
      files.filter((f) => f.fieldname === "vehiclePhotos"),
      "spakstrip/taxis",
    );
    const uploadDoc = async (name: string): Promise<string | undefined> => {
      const f = byField(name);
      return f ? uploadToCloudinary(f, "spakstrip/taxis/docs") : undefined;
    };
    const media: TaxiMedia = {
      vehicleImageUrls,
      docs: {
        vehicleRC: await uploadDoc("rcBook"),
        insurance: await uploadDoc("insurance"),
        pollutionCertificate: await uploadDoc("pollutionCertificate"),
        drivingLicense: await uploadDoc("drivingLicense"),
      },
    };

    const input = validateTaxiListing(payload, media);
    // Enters the admin review queue — never auto-published (schema default is
    // "active", so we set "pending" explicitly here).
    const doc = await TaxiListingModel.create({ ...input, partner: partnerId, status: "pending" });
    res.status(201).json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// GET /api/partner/taxis — this partner's taxi listings, newest first.
export async function listTaxiListings(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const items = await TaxiListingModel.find({ partner: partnerId }).sort({ createdAt: -1 });
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

// PATCH /api/partner/taxis/:id — apply the dashboard editor's flat fields onto
// the MTI document (single service at index 0) and the availability status.
export async function updateTaxiListing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const id = paramId(req);
    const patch = validateTaxiListingUpdate(req.body);

    const doc = await TaxiListingModel.findOne({ _id: id, partner: partnerId });
    if (!doc) throw new HttpError(404, "Taxi listing not found");

    const service = doc.services[0];
    if (patch.operatingCity !== undefined && service) service.coverage.baseCity = patch.operatingCity;
    if (patch.minimumFare !== undefined && service) service.pricing.baseFare = patch.minimumFare;
    if (patch.pricePerKm !== undefined && service) service.pricing.pricePerKm = patch.pricePerKm;
    if (patch.serviceAreas !== undefined && service) service.coverage.servicedCities = patch.serviceAreas;
    if (patch.availableRoutes !== undefined) doc.routes = patch.availableRoutes;
    if (patch.description !== undefined) doc.description = patch.description;
    if (patch.availableDays !== undefined) doc.operatingDays = patch.availableDays;
    if (patch.availableTimeSlots !== undefined) {
      const slots = parseSlotStrings(patch.availableTimeSlots);
      doc.operationalHours.slots = slots;
      doc.operationalHours.available24x7 = slots.length === 0;
    }
    if (patch.amenities !== undefined) doc.vehicle.amenities = patch.amenities;
    if (patch.availabilityEnabled !== undefined) {
      doc.status = patch.availabilityEnabled ? "active" : "paused";
    }

    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// DELETE /api/partner/taxis/:id
export async function deleteTaxiListing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const id = paramId(req);
    const result = await TaxiListingModel.findOneAndDelete({ _id: id, partner: partnerId });
    if (!result) throw new HttpError(404, "Taxi listing not found");
    res.status(204).end();
  } catch (e) {
    next(e);
  }
}

// ── Taxi Packages ────────────────────────────────────────────────────────────

// Resolve an optional vehicle ref to one of this partner's TaxiListings and
// build the denormalized snapshot. Returns {} when no vehicle is linked.
async function resolveTaxiPackageVehicle(
  partnerId: string,
  vehicleId: string | undefined,
): Promise<{ vehicle?: mongoose.Types.ObjectId; vehicleSnapshot?: Record<string, unknown> }> {
  if (!vehicleId) return {};
  if (!mongoose.isValidObjectId(vehicleId)) throw new HttpError(400, "Invalid vehicle id");
  const taxi = await TaxiListingModel.findOne({ _id: vehicleId, partner: partnerId });
  if (!taxi) throw new HttpError(400, "vehicle must be one of your taxi listings");
  return {
    vehicle: taxi._id,
    vehicleSnapshot: {
      make: taxi.vehicle.make,
      model: taxi.vehicle.model,
      type: taxi.vehicle.type,
      seatingCap: taxi.vehicle.seatingCap,
      images: taxi.vehicle.images.map((i) => i.url),
    },
  };
}

// Upload taxi-package media: a single `thumbnail` + many `images`.
async function uploadTaxiPackageMedia(
  files: Express.Multer.File[],
): Promise<{ thumbnail?: string; imageUrls: string[] }> {
  const thumbFile = files.find((f) => f.fieldname === "thumbnail");
  const thumbnail = thumbFile
    ? await uploadToCloudinary(thumbFile, "spakstrip/taxi-packages")
    : undefined;
  const imageUrls = await uploadManyToCloudinary(
    files.filter((f) => f.fieldname === "images"),
    "spakstrip/taxi-packages",
  );
  return { thumbnail, imageUrls };
}

// POST /api/partner/taxi-packages — multipart: `payload` JSON + thumbnail + images.
export async function createTaxiPackage(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const payload = parseJsonField(req, "payload", req.body);
    const { fields, vehicleId } = validateTaxiPackage(payload);

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const { thumbnail, imageUrls } = await uploadTaxiPackageMedia(files);
    const { vehicle, vehicleSnapshot } = await resolveTaxiPackageVehicle(partnerId, vehicleId);

    const doc = await TaxiPackageModel.create({
      ...fields,
      partner: partnerId,
      status: "pending",
      thumbnail,
      images: imageUrls.map((url, i) => ({ url, isPrimary: i === 0 })),
      vehicle,
      vehicleSnapshot,
    });
    res.status(201).json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// GET /api/partner/taxi-packages
export async function listTaxiPackages(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const items = await TaxiPackageModel.find({ partner: partnerId }).sort({ createdAt: -1 });
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

// PATCH /api/partner/taxi-packages/:id — multipart; the edit form resends the
// full structured payload. New thumbnail/images replace existing ones only when
// files are provided (otherwise the current media is kept).
export async function updateTaxiPackage(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const id = paramId(req);
    const payload = parseJsonField(req, "payload", req.body);
    const { fields, vehicleId } = validateTaxiPackage(payload);

    const doc = await TaxiPackageModel.findOne({ _id: id, partner: partnerId });
    if (!doc) throw new HttpError(404, "Taxi package not found");

    const prevStatus = doc.status; // a field edit never changes approval state (§2.3)
    doc.set(fields);
    doc.status = prevStatus; // publishing goes through submit → admin approval, not this edit

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const { thumbnail, imageUrls } = await uploadTaxiPackageMedia(files);
    if (thumbnail) doc.thumbnail = thumbnail;
    if (imageUrls.length > 0) doc.images = imageUrls.map((url, i) => ({ url, isPrimary: i === 0 }));

    if (vehicleId !== undefined) {
      const { vehicle, vehicleSnapshot } = await resolveTaxiPackageVehicle(partnerId, vehicleId);
      doc.vehicle = vehicle;
      doc.vehicleSnapshot = vehicleSnapshot as typeof doc.vehicleSnapshot;
    }

    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// DELETE /api/partner/taxi-packages/:id
export async function deleteTaxiPackage(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const id = paramId(req);
    const result = await TaxiPackageModel.findOneAndDelete({ _id: id, partner: partnerId });
    if (!result) throw new HttpError(404, "Taxi package not found");
    res.status(204).end();
  } catch (e) {
    next(e);
  }
}

// ── Tours ────────────────────────────────────────────────────────────────────

// POST /api/partner/tours — multipart: `payload` JSON + `images`.
export async function createTourListing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const payload = parseJsonField(req, "payload", req.body);
    const fields = validateTourListing(payload);

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const imageUrls = await uploadManyToCloudinary(
      files.filter((f) => f.fieldname === "images"),
      "spakstrip/tours",
    );

    const doc = await TourListingModel.create({
      ...fields,
      partner: partnerId,
      status: "pending",
      images: imageUrls.map((url, i) => ({ url, isPrimary: i === 0 })),
    });
    res.status(201).json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// GET /api/partner/tours
export async function listTourListings(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const items = await TourListingModel.find({ partner: partnerId }).sort({ createdAt: -1 });
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

// PATCH /api/partner/tours/:id — multipart; the edit form resends the full
// payload. New `images` replace existing ones only when files are provided.
export async function updateTourListing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const id = paramId(req);
    const payload = parseJsonField(req, "payload", req.body);
    const fields = validateTourListing(payload);

    const doc = await TourListingModel.findOne({ _id: id, partner: partnerId });
    if (!doc) throw new HttpError(404, "Tour not found");

    const prevStatus = doc.status; // a field edit never changes approval state (§2.3)
    doc.set(fields);
    doc.status = prevStatus; // publishing goes through submit → admin approval, not this edit

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const imageUrls = await uploadManyToCloudinary(
      files.filter((f) => f.fieldname === "images"),
      "spakstrip/tours",
    );
    if (imageUrls.length > 0) doc.images = imageUrls.map((url, i) => ({ url, isPrimary: i === 0 }));

    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// DELETE /api/partner/tours/:id
export async function deleteTourListing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const id = paramId(req);
    const result = await TourListingModel.findOneAndDelete({ _id: id, partner: partnerId });
    if (!result) throw new HttpError(404, "Tour not found");
    res.status(204).end();
  } catch (e) {
    next(e);
  }
}

// ── Tour Packages ────────────────────────────────────────────────────────────

// Verify a set of ids all belong to the partner in the given collection.
async function ownedIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Mdl: { find: (...args: any[]) => any },
  partnerId: string,
  ids: string[],
  label: string,
): Promise<mongoose.Types.ObjectId[]> {
  if (ids.length === 0) return [];
  if (ids.some((id) => !mongoose.isValidObjectId(id))) throw new HttpError(400, `Invalid ${label} id`);
  const docs = await Mdl.find({ _id: { $in: ids }, partner: partnerId }).select("_id");
  if (docs.length !== new Set(ids).size) {
    throw new HttpError(400, `${label} must all be your own listings`);
  }
  return docs.map((d: { _id: mongoose.Types.ObjectId }) => d._id);
}

// Resolve the cross-model `includes` refs, validating partner ownership.
async function resolveTourPackageIncludes(
  partnerId: string,
  includeIds: { taxi?: string; hotels: string[]; tours: string[] },
): Promise<{ taxi?: mongoose.Types.ObjectId; hotels: mongoose.Types.ObjectId[]; tours: mongoose.Types.ObjectId[] }> {
  let taxi: mongoose.Types.ObjectId | undefined;
  if (includeIds.taxi) {
    if (!mongoose.isValidObjectId(includeIds.taxi)) throw new HttpError(400, "Invalid taxi id");
    const t = await TaxiListingModel.findOne({ _id: includeIds.taxi, partner: partnerId }).select("_id");
    if (!t) throw new HttpError(400, "includes.taxi must be one of your taxi listings");
    taxi = t._id;
  }
  const hotels = await ownedIds(HotelListingModel, partnerId, includeIds.hotels, "includes.hotels");
  const tours = await ownedIds(TourListingModel, partnerId, includeIds.tours, "includes.tours");
  return { taxi, hotels, tours };
}

async function uploadTourPackageMedia(
  files: Express.Multer.File[],
): Promise<{ thumbnail?: string; imageUrls: string[] }> {
  const thumbFile = files.find((f) => f.fieldname === "thumbnail");
  const thumbnail = thumbFile ? await uploadToCloudinary(thumbFile, "spakstrip/tour-packages") : undefined;
  const imageUrls = await uploadManyToCloudinary(
    files.filter((f) => f.fieldname === "images"),
    "spakstrip/tour-packages",
  );
  return { thumbnail, imageUrls };
}

// POST /api/partner/tour-packages — multipart: `payload` JSON + thumbnail + images.
export async function createTourPackage(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const payload = parseJsonField(req, "payload", req.body);
    const { fields, includeIds } = validateTourPackage(payload);

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const { thumbnail, imageUrls } = await uploadTourPackageMedia(files);
    const includes = await resolveTourPackageIncludes(partnerId, includeIds);

    const doc = await TourPackageModel.create({
      ...fields,
      partner: partnerId,
      status: "pending",
      includes,
      thumbnail,
      images: imageUrls.map((url, i) => ({ url, isPrimary: i === 0 })),
    });
    res.status(201).json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// GET /api/partner/tour-packages
export async function listTourPackages(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const items = await TourPackageModel.find({ partner: partnerId }).sort({ createdAt: -1 });
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

// PATCH /api/partner/tour-packages/:id — multipart; the edit form resends the
// full payload. New thumbnail/images replace existing ones only when provided.
export async function updateTourPackage(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const id = paramId(req);
    const payload = parseJsonField(req, "payload", req.body);
    const { fields, includeIds } = validateTourPackage(payload);

    const doc = await TourPackageModel.findOne({ _id: id, partner: partnerId });
    if (!doc) throw new HttpError(404, "Tour package not found");

    const prevStatus = doc.status; // a field edit never changes approval state (§2.3)
    doc.set(fields);
    doc.status = prevStatus; // publishing goes through submit → admin approval, not this edit
    doc.includes = await resolveTourPackageIncludes(partnerId, includeIds);

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const { thumbnail, imageUrls } = await uploadTourPackageMedia(files);
    if (thumbnail) doc.thumbnail = thumbnail;
    if (imageUrls.length > 0) doc.images = imageUrls.map((url, i) => ({ url, isPrimary: i === 0 }));

    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// DELETE /api/partner/tour-packages/:id
export async function deleteTourPackage(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const id = paramId(req);
    const result = await TourPackageModel.findOneAndDelete({ _id: id, partner: partnerId });
    if (!result) throw new HttpError(404, "Tour package not found");
    res.status(204).end();
  } catch (e) {
    next(e);
  }
}

// ── Cruises ──────────────────────────────────────────────────────────────────

// POST /api/partner/cruises — multipart: `payload` JSON + `vesselImages`.
export async function createCruiseListing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const payload = parseJsonField(req, "payload", req.body);
    const fields = validateCruiseListing(payload);

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const vesselImageUrls = await uploadManyToCloudinary(
      files.filter((f) => f.fieldname === "vesselImages"),
      "spakstrip/cruises",
    );
    fields.vessel.images = vesselImageUrls.map((url, i) => ({ url, isPrimary: i === 0 }));

    const doc = await CruiseListingModel.create({ ...fields, partner: partnerId, status: "pending" });
    res.status(201).json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// GET /api/partner/cruises
export async function listCruiseListings(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const items = await CruiseListingModel.find({ partner: partnerId }).sort({ createdAt: -1 });
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

// PATCH /api/partner/cruises/:id — multipart; the edit form resends the full
// payload. New `vesselImages` replace existing ones only when files are provided.
export async function updateCruiseListing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const id = paramId(req);
    const payload = parseJsonField(req, "payload", req.body);
    const fields = validateCruiseListing(payload);

    const doc = await CruiseListingModel.findOne({ _id: id, partner: partnerId });
    if (!doc) throw new HttpError(404, "Cruise not found");

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const vesselImageUrls = await uploadManyToCloudinary(
      files.filter((f) => f.fieldname === "vesselImages"),
      "spakstrip/cruises",
    );
    // Keep existing vessel images unless new ones were uploaded.
    fields.vessel.images = vesselImageUrls.length > 0
      ? vesselImageUrls.map((url, i) => ({ url, isPrimary: i === 0 }))
      : doc.vessel.images;

    const prevStatus = doc.status; // a field edit never changes approval state (§2.3)
    doc.set(fields);
    doc.status = prevStatus; // publishing goes through submit → admin approval, not this edit
    await doc.save();
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// DELETE /api/partner/cruises/:id
export async function deleteCruiseListing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const id = paramId(req);
    const result = await CruiseListingModel.findOneAndDelete({ _id: id, partner: partnerId });
    if (!result) throw new HttpError(404, "Cruise not found");
    res.status(204).end();
  } catch (e) {
    next(e);
  }
}

function paramId(req: Request): string {
  const raw = req.params.id;
  const id = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "";
  ensureValidId(id);
  return id;
}

export async function updateResource(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const id = paramId(req);
    const updates = validateResourceUpdate(req.body);
    const doc = await PartnerResourceModel.findOneAndUpdate(
      { _id: id, partnerId },
      { $set: updates },
      { new: true },
    );
    if (!doc) throw new HttpError(404, "Resource not found");
    res.json({ item: doc.toJSON() });
  } catch (e) {
    next(e);
  }
}

// Bookings placed against this partner's inventory (scoped by partnerId).
export async function listBookings(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const items = await BookingModel.find({ partnerId }).sort({ createdAt: -1 });
    res.json({ items: items.map((i) => i.toJSON()) });
  } catch (e) {
    next(e);
  }
}

export async function deleteResource(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partnerId = partnerIdFrom(req);
    const id = paramId(req);
    const result = await PartnerResourceModel.findOneAndDelete({ _id: id, partnerId });
    if (!result) throw new HttpError(404, "Resource not found");
    res.status(204).end();
  } catch (e) {
    next(e);
  }
}
