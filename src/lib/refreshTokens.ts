import crypto from "crypto";
import jwt from "jsonwebtoken";
import { signRefreshToken } from "./tokens";
import { RefreshTokenModel, RefreshTokenDoc } from "../models/RefreshToken";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Store only a hash of the raw token — the raw value never lands in the DB.
function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// Derive the row's expiry from the JWT's own exp claim (falls back to 7d).
function expiryFromToken(raw: string): Date {
  const decoded = jwt.decode(raw) as { exp?: number } | null;
  return new Date(decoded?.exp ? decoded.exp * 1000 : Date.now() + SEVEN_DAYS_MS);
}

// Issue a fresh refresh token and persist its hash. Returns the raw token.
export async function issueRefreshToken(userId: string): Promise<string> {
  const raw = signRefreshToken({ sub: userId, tokenType: "refresh" });
  await RefreshTokenModel.create({
    userId,
    tokenHash: hashToken(raw),
    expiresAt: expiryFromToken(raw),
  });
  return raw;
}

// Return the matching row only if it exists, is not revoked, and not expired.
export async function findActiveRefreshToken(raw: string): Promise<RefreshTokenDoc | null> {
  const doc = await RefreshTokenModel.findOne({ tokenHash: hashToken(raw) });
  if (!doc || doc.revokedAt || doc.expiresAt.getTime() <= Date.now()) return null;
  return doc;
}

// Rotate: issue a new token, then revoke the old row and link it to the successor.
export async function rotateRefreshToken(oldRaw: string, userId: string): Promise<string> {
  const newRaw = signRefreshToken({ sub: userId, tokenType: "refresh" });
  const newHash = hashToken(newRaw);
  await RefreshTokenModel.create({
    userId,
    tokenHash: newHash,
    expiresAt: expiryFromToken(newRaw),
  });
  await RefreshTokenModel.updateOne(
    { tokenHash: hashToken(oldRaw) },
    { $set: { revokedAt: new Date(), replacedBy: newHash } },
  );
  return newRaw;
}

// Revoke a single refresh token (logout). No-op if it's already revoked/absent.
export async function revokeRefreshToken(raw: string): Promise<void> {
  await RefreshTokenModel.updateOne(
    { tokenHash: hashToken(raw), revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
}

// Revoke ALL active refresh tokens for a user — used after a password reset so
// every existing session is invalidated.
export async function revokeAllUserRefreshTokens(userId: string): Promise<void> {
  await RefreshTokenModel.updateMany(
    { userId, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
}
