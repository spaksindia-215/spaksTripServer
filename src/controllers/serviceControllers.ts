import { makeServiceModule } from "./serviceModule";
import { TransferListingModel } from "../models/partner/TransferListing";
import { SelfDriveListingModel } from "../models/partner/SelfDriveListing";
import { IslandhopperListingModel } from "../models/partner/IslandhopperListing";
import { VisaListingModel } from "../models/partner/VisaListing";
import {
  validateTransfer,
  validateSelfDrive,
  validateIslandhopper,
  validateVisa,
} from "../validators/serviceListings.validators";
import {
  TRANSFER_TYPES,
  SELF_DRIVE_CATEGORIES,
  ISLANDHOPPER_SERVICE_TYPES,
  VISA_CATEGORIES,
} from "../models/partner/_shared/enums";

function str(q: Record<string, unknown>, k: string): string | undefined {
  return typeof q[k] === "string" && (q[k] as string).trim() ? (q[k] as string).trim() : undefined;
}
function text(q: Record<string, unknown>): Record<string, unknown> | undefined {
  const s = str(q, "q");
  return s ? { $text: { $search: s } } : undefined;
}

export const transferController = makeServiceModule({
  vertical: "transfer",
  model: TransferListingModel,
  imageFolder: "spakstrip/transfer",
  validate: validateTransfer,
  notFoundLabel: "Transfer service",
  buildBrowseFilter: (q) => {
    const f: Record<string, unknown> = { ...text(q) };
    const type = str(q, "transferType");
    if (type && (TRANSFER_TYPES as readonly string[]).includes(type)) f.transferType = type;
    const from = str(q, "from");
    const to = str(q, "to");
    if (from) f["routes.from"] = new RegExp(from, "i");
    if (to) f["routes.to"] = new RegExp(to, "i");
    return f;
  },
});

export const selfDriveController = makeServiceModule({
  vertical: "self_drive",
  model: SelfDriveListingModel,
  imageFolder: "spakstrip/self-drive",
  validate: validateSelfDrive,
  notFoundLabel: "Vehicle rental",
  buildBrowseFilter: (q) => {
    const f: Record<string, unknown> = { ...text(q) };
    const category = str(q, "category");
    if (category && (SELF_DRIVE_CATEGORIES as readonly string[]).includes(category)) f["vehicles.category"] = category;
    return f;
  },
});

export const islandhopperController = makeServiceModule({
  vertical: "islandhopper",
  model: IslandhopperListingModel,
  imageFolder: "spakstrip/islandhopper",
  validate: validateIslandhopper,
  notFoundLabel: "Route",
  buildBrowseFilter: (q) => {
    const f: Record<string, unknown> = { ...text(q) };
    const serviceType = str(q, "serviceType");
    if (serviceType && (ISLANDHOPPER_SERVICE_TYPES as readonly string[]).includes(serviceType)) f.serviceType = serviceType;
    const origin = str(q, "origin");
    const destination = str(q, "destination");
    if (origin) f["routes.origin"] = new RegExp(origin, "i");
    if (destination) f["routes.destination"] = new RegExp(destination, "i");
    if (str(q, "nonStop") === "true") f["routes.isNonStop"] = true;
    return f;
  },
});

export const visaController = makeServiceModule({
  vertical: "visa",
  model: VisaListingModel,
  imageFolder: "spakstrip/visa",
  validate: validateVisa,
  notFoundLabel: "Consultancy",
  buildBrowseFilter: (q) => {
    const f: Record<string, unknown> = { ...text(q) };
    const country = str(q, "country");
    const visaType = str(q, "visaType");
    if (country) f.countriesCovered = new RegExp(country, "i");
    if (visaType && (VISA_CATEGORIES as readonly string[]).includes(visaType)) f.visaTypesOffered = visaType;
    return f;
  },
});
