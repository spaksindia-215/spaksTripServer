import { Schema, model, HydratedDocument } from "mongoose";
import { markupRuleSchema, type MarkupRule } from "./User";

export interface IPlatformConfig {
  markup: {
    flights: MarkupRule;
    hotels: MarkupRule;
    taxi: MarkupRule;
  };
  updatedBy: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const platformConfigSchema = new Schema<IPlatformConfig>(
  {
    markup: {
      flights: { type: markupRuleSchema, required: true },
      hotels: { type: markupRuleSchema, required: true },
      taxi:    { type: markupRuleSchema, required: true },
    },
    updatedBy: { type: String, trim: true, default: "" },
    version:   { type: Number, default: 1 },
  },
  { timestamps: true },
);

platformConfigSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    return out;
  },
});

export type PlatformConfigDoc = HydratedDocument<IPlatformConfig>;
export const PlatformConfigModel = model<IPlatformConfig>("PlatformConfig", platformConfigSchema);

const DEFAULT_RULE: MarkupRule = { type: "percent", value: 0 };

/** Idempotent — inserts the singleton document only if the collection is empty. */
export async function seedPlatformConfig(): Promise<void> {
  await PlatformConfigModel.findOneAndUpdate(
    {},
    {
      $setOnInsert: {
        markup: {
          flights: DEFAULT_RULE,
          hotels:  DEFAULT_RULE,
          taxi:    DEFAULT_RULE,
        },
        updatedBy: "system",
        version: 1,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}
