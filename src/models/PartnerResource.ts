import { Schema, model, Types, HydratedDocument } from "mongoose";
import { RESOURCE_TYPES, type ResourceType, type AnyResourceDetails } from "./partnerInventory";

export { RESOURCE_TYPES, type ResourceType } from "./partnerInventory";

export interface IPartnerResource {
  partnerId: Types.ObjectId;
  type: ResourceType;
  title: string;
  description: string;
  price: number;
  // Structured, per-type inventory detail (shape determined by `type`).
  metadata: AnyResourceDetails;
  createdAt: Date;
  updatedAt: Date;
}

const partnerResourceSchema = new Schema<IPartnerResource>(
  {
    partnerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: RESOURCE_TYPES, required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    price: { type: Number, required: true, min: 0 },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

partnerResourceSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type PartnerResourceDoc = HydratedDocument<IPartnerResource>;
export const PartnerResourceModel = model<IPartnerResource>("PartnerResource", partnerResourceSchema);
