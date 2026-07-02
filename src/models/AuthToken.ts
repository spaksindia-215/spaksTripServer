import { Schema, model, Types, HydratedDocument } from "mongoose";

// Single-use, time-limited tokens for email verification and password reset.
// Only a hash of the raw token is stored — the raw value lives only in the
// emailed link. Mongo's TTL index auto-removes rows once expiresAt passes.

export const AUTH_TOKEN_TYPES = ["verify_email", "password_reset"] as const;
export type AuthTokenType = (typeof AUTH_TOKEN_TYPES)[number];

export interface IAuthToken {
  userId: Types.ObjectId;
  type: AuthTokenType;
  tokenHash: string;
  expiresAt: Date;
  usedAt?: Date;
  createdAt: Date;
}

const authTokenSchema = new Schema<IAuthToken>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: AUTH_TOKEN_TYPES, required: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    expiresAt: { type: Date, required: true, expires: 0 },
    usedAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export type AuthTokenDoc = HydratedDocument<IAuthToken>;
export const AuthTokenModel = model<IAuthToken>("AuthToken", authTokenSchema);
