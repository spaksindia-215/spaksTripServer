import mongoose, { Schema, type Document } from "mongoose";

export interface INavbarSettings extends Document {
  visibility: Record<string, boolean>;
}

const NavbarSettingsSchema = new Schema<INavbarSettings>(
  {
    // visibility is a plain map of labelKey → boolean (true = shown, false = hidden)
    // Missing keys are treated as true (visible by default).
    visibility: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: false },
);

export const NavbarSettingsModel = mongoose.model<INavbarSettings>(
  "NavbarSettings",
  NavbarSettingsSchema,
);
