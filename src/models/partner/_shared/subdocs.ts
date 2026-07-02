// Reusable embedded subdocument schemas shared across the typed partner models.
// Kept DRY here so each model references the same image/coordinate shape.

import { Schema } from "mongoose";

export interface Image {
  url: string;
  caption?: string;
  isPrimary?: boolean;
}

export const ImageSchema = new Schema<Image>(
  {
    url: { type: String, required: true, trim: true },
    caption: { type: String, trim: true },
    isPrimary: { type: Boolean, default: false },
  },
  { _id: false },
);

// GeoJSON Point, ready for a 2dsphere index. Coordinates are [longitude, latitude].
export interface GeoPoint {
  type: "Point";
  coordinates: [number, number];
}

export const CoordinateSchema = new Schema<GeoPoint>(
  {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: {
      type: [Number],
      validate: {
        validator: (v: number[]) => v.length === 2,
        message: "coordinates must be [longitude, latitude]",
      },
    },
  },
  { _id: false },
);
