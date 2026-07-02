import { Schema, model, HydratedDocument } from "mongoose";
import { EVENT_CATEGORIES, type EventCategory } from "./partner/_shared/enums";

// Cache of third-party events (Ticketmaster, Paytm Insider) so the public events
// API and frontend never hit those APIs on the request path. Populated by the
// syncExternalEvents worker; rows self-expire via a TTL index on `expiresAt`.
// These are display-only + affiliate deep-link — SpaksTrip never sells them.

export const EXTERNAL_EVENT_SOURCES = ["ticketmaster", "insider", "bookmyshow"] as const;
export type ExternalEventSource = (typeof EXTERNAL_EVENT_SOURCES)[number];

export interface IExternalEvent {
  source: ExternalEventSource;
  sourceId: string;
  sourceUrl: string;
  affiliateUrl?: string;
  title: string;
  description?: string;
  category: EventCategory;
  startDate?: Date;
  endDate?: Date;
  venue: {
    name?: string;
    city?: string;
    state?: string;
    country?: string;
    coordinates?: { lat?: number; lng?: number };
  };
  images: string[];
  priceRange?: { min?: number; max?: number; currency?: string };
  fetchedAt: Date;
  expiresAt: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const externalEventSchema = new Schema<IExternalEvent>(
  {
    source: { type: String, enum: EXTERNAL_EVENT_SOURCES, required: true },
    sourceId: { type: String, required: true, trim: true },
    sourceUrl: { type: String, required: true, trim: true },
    affiliateUrl: { type: String, trim: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    category: { type: String, enum: EVENT_CATEGORIES, default: "other" },
    startDate: { type: Date },
    endDate: { type: Date },
    venue: {
      name: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      country: { type: String, trim: true },
      coordinates: {
        lat: { type: Number },
        lng: { type: Number },
      },
    },
    images: { type: [String], default: [] },
    priceRange: {
      min: { type: Number },
      max: { type: Number },
      currency: { type: String, default: "INR" },
    },
    fetchedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, strict: true },
);

// Prevent duplicates across sync runs; the worker upserts on { source, sourceId }.
externalEventSchema.index({ source: 1, sourceId: 1 }, { unique: true });
// Public-listing access paths.
externalEventSchema.index({ isActive: 1, startDate: 1 });
externalEventSchema.index({ "venue.city": 1, startDate: 1 });
externalEventSchema.index({ category: 1, isActive: 1 });
// TTL: MongoDB auto-deletes a row once `expiresAt` passes.
externalEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

externalEventSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type ExternalEventDoc = HydratedDocument<IExternalEvent>;
export const ExternalEventModel = model<IExternalEvent>("ExternalEvent", externalEventSchema);
