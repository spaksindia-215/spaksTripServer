import crypto from "crypto";
import { AuthTokenModel, type AuthTokenType } from "../models/AuthToken";

// Helpers for single-use email verification / password reset tokens.
// The raw token (sent in the email link) is random and never stored; we keep
// only its SHA-256 hash and look up by hash on redemption.

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RESET_TTL_MS = 30 * 60 * 1000; // 30m

export const TTL = { verify_email: VERIFY_TTL_MS, password_reset: RESET_TTL_MS } as const;

function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Issue a token of the given type for a user. Any prior unused tokens of the
 * same type are invalidated first so only the latest link works. Returns the
 * RAW token to embed in the email link.
 */
export async function createAuthToken(userId: string, type: AuthTokenType): Promise<string> {
  await AuthTokenModel.updateMany(
    { userId, type, usedAt: { $exists: false } },
    { $set: { usedAt: new Date() } },
  );
  const raw = crypto.randomBytes(32).toString("hex");
  await AuthTokenModel.create({
    userId,
    type,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + TTL[type]),
  });
  return raw;
}

/**
 * Atomically redeem a token: matches by hash + type, must be unused and not
 * expired, and flips usedAt in the same operation so it can't be replayed.
 * Returns the userId (string) on success, or null if invalid/expired/used.
 */
export async function consumeAuthToken(raw: string, type: AuthTokenType): Promise<string | null> {
  if (!raw) return null;
  const doc = await AuthTokenModel.findOneAndUpdate(
    {
      tokenHash: hashToken(raw),
      type,
      usedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    },
    { $set: { usedAt: new Date() } },
    { returnDocument: "before" },
  );
  return doc ? String(doc.userId) : null;
}
