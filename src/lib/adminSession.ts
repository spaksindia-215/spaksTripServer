import crypto from "crypto";
import { env } from "../config/env";

// The superadmin panel is gated by an env password and a signed (non-JWT)
// httpOnly cookie. No DB role is involved. The cookie is `base64url(payload).hmac`
// where payload carries only an expiry.

export const ADMIN_COOKIE_NAME = "adminSession";
const ADMIN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function sign(data: string): string {
  return crypto.createHmac("sha256", env.adminSessionSecret).update(data).digest("hex");
}

// Constant-time string compare that tolerates length differences.
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// True only when a non-empty SUPERADMIN_PASSWORD is configured and matches.
export function verifyAdminPassword(candidate: unknown): boolean {
  if (typeof candidate !== "string" || env.superadminPassword.length === 0) return false;
  return safeEqual(candidate, env.superadminPassword);
}

export function createAdminSessionToken(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + ADMIN_TTL_MS })).toString(
    "base64url",
  );
  return `${payload}.${sign(payload)}`;
}

export function verifyAdminSessionToken(token: string | undefined): boolean {
  if (!token || env.adminSessionSecret.length === 0) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  if (!safeEqual(signature, sign(payload))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { exp?: number };
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}

export const ADMIN_COOKIE_MAX_AGE_MS = ADMIN_TTL_MS;
