import { Schema, model, Types, HydratedDocument } from "mongoose";

export interface IRefreshToken {
  userId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  revokedAt?: Date;
  replacedBy?: string;
  createdAt: Date;
}

const refreshTokenSchema = new Schema<IRefreshToken>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    // TTL index: Mongo auto-removes the doc once expiresAt passes.
    expiresAt: { type: Date, required: true, expires: 0 },
    revokedAt: { type: Date },
    replacedBy: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

refreshTokenSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>;
    out.id = String(out._id);
    delete out._id;
    delete out.__v;
    // tokenHash is a secret derivative — never expose it.
    delete out.tokenHash;
    return out;
  },
});

export type RefreshTokenDoc = HydratedDocument<IRefreshToken>;
export const RefreshTokenModel = model<IRefreshToken>("RefreshToken", refreshTokenSchema);
