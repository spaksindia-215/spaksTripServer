import { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import { UserModel } from "../models/User";
import { signAccessToken, verifyRefreshToken } from "../lib/tokens";
import { setAuthCookies, clearAuthCookies } from "../lib/cookies";
import {
  issueRefreshToken,
  findActiveRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserRefreshTokens,
} from "../lib/refreshTokens";
import { validateLogin, validateRegister, assertPasswordStrength } from "../validators/auth.validators";
import { HttpError } from "../middleware/error";
import { sendMail } from "../lib/mailer";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { createAuthToken, consumeAuthToken, TTL } from "../lib/authTokens";
import { claimGuestBookings } from "../services/customerBooking";

// Build a client-facing link on the given Next app origin.
function clientUrl(origin: string, path: string): string {
  return `${origin.replace(/\/$/, "")}${path}`;
}

/**
 * Pick the origin to use in emailed links. Prefers the origin the user is
 * actually on (forwarded by the Next proxy as x-forwarded-origin) so links work
 * on the apex domain AND on agent `*.<apex>` subdomains. SECURITY: the forwarded
 * value is only trusted if it's the apex host or a subdomain of it — otherwise a
 * forged header could send victims a reset link pointing at an attacker's site
 * (host-header injection). Anything else falls back to CLIENT_ORIGIN.
 */
function resolveClientOrigin(req: Request): string {
  const fallback = env.clientOrigin;
  const raw = req.get("x-forwarded-origin");
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    const apexHost = new URL(fallback).hostname;
    if (u.hostname === apexHost || u.hostname.endsWith(`.${apexHost}`)) {
      return `${u.protocol}//${u.host}`;
    }
  } catch {
    /* malformed header — ignore and fall back */
  }
  return fallback;
}

// Fire a verification email for a user (best-effort — never throws to caller).
async function sendVerificationEmail(
  user: { _id: unknown; name: string; email: string },
  origin: string,
): Promise<void> {
  try {
    const raw = await createAuthToken(String(user._id), "verify_email");
    await sendMail({
      to: user.email,
      subject: "Verify your SpaksTrip email",
      template: "verifyEmail",
      data: {
        name: user.name,
        verifyUrl: clientUrl(origin, `/verify-email?token=${raw}`),
        expiresInHours: Math.round(TTL.verify_email / 3_600_000),
      },
    });
  } catch (e) {
    logger.error({ event: "verify_email_send_failed", error: e instanceof Error ? e.message : String(e) }, "Failed to send verification email");
  }
}

const BCRYPT_ROUNDS = 12;

// Idle (inactivity) session timeout. The access token lives 15m; this caps how
// long a session can sit idle before a refresh is refused and the user must log
// in again. Must be > the access TTL so an active user is never logged out.
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_SESSION_TIMEOUT_MIN ?? 30) * 60 * 1000;

// Mask an email for logs — keep the first char + domain (PII minimisation).
function maskEmail(email: unknown): string {
  const s = typeof email === "string" ? email : "";
  const at = s.indexOf("@");
  if (at <= 0) return "***";
  return `${s[0]}***${s.slice(at)}`;
}

// b2b_agent + partner require superadmin approval; everyone else is active on register.
const PENDING_ROLES = ["b2b_agent", "partner"] as const;

// Brute-force lockout policy: after MAX_BEFORE_LOCK consecutive failed logins
// the account is locked for an exponentially-growing window (capped). This sits
// on top of the IP rate limiter and stops slow, distributed credential stuffing
// against a single account.
const MAX_BEFORE_LOCK = 5;
const BASE_LOCK_MINUTES = 15;
const MAX_LOCK_MINUTES = 60;

// Version stamped alongside the consent timestamp so we can prove WHICH terms a
// user accepted if the policy text changes later.
const CONSENT_VERSION = process.env.CONSENT_VERSION ?? "2026-06";

function lockMinutesFor(attempts: number): number {
  const over = Math.max(0, attempts - MAX_BEFORE_LOCK);
  return Math.min(MAX_LOCK_MINUTES, BASE_LOCK_MINUTES * 2 ** over);
}

export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = validateRegister(req.body);

    const existing = await UserModel.findOne({
      $or: [{ phone: input.phone }, { email: input.email }],
    });
    if (existing) {
      const field = existing.phone === input.phone ? "Phone" : "Email";
      throw new HttpError(409, `${field} already in use`);
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const isPending = (PENDING_ROLES as readonly string[]).includes(input.role);

    const user = await UserModel.create({
      name: input.name,
      phone: input.phone,
      email: input.email,
      passwordHash,
      role: input.role,
      status: isPending ? "pending" : "active",
      aadhar: input.aadhar,
      gst: input.gst,
      pan: input.pan,
      // Timestamped consent record (DPDP/GDPR). Registration implies acceptance
      // of the displayed Terms & Privacy Policy. TODO: surface an explicit,
      // un-pre-ticked checkbox on the client and forward its value here.
      consentAt: new Date(),
      consentVersion: CONSENT_VERSION,
    });

    // Fire emails in the background — SMTP can take several seconds and must
    // never hold the HTTP response (or block it behind a slow mail server).
    // Both helpers swallow their own errors, so we just log if a promise rejects.
    const origin = resolveClientOrigin(req);
    void sendVerificationEmail(user, origin).catch(() => {});

    // Pending roles: superadmin is also notified for approval review.
    if (isPending) {
      void sendMail({
        to: env.superadminEmail,
        subject: `New ${user.role} registration awaiting approval`,
        template: "superadminNewPending",
        data: { role: user.role, name: user.name, phone: user.phone, email: user.email },
      }).catch((e) =>
        logger.error(
          { event: "superadmin_notify_failed", error: e instanceof Error ? e.message : String(e) },
          "Failed to send superadmin pending-registration notification",
        ),
      );
      res.status(201).json({ status: "pending", user: user.toJSON() });
      return;
    }

    // Active roles: NO session yet — the user must verify their email first
    // (double opt-in). They land here, then complete via the emailed link.
    res.status(201).json({ status: "verify_email", user: user.toJSON() });
  } catch (e) {
    next(e);
  }
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email, password } = validateLogin(req.body);
    const ip = req.ip;
    const userAgent = req.get("user-agent") ?? undefined;

    const user = await UserModel.findOne({ email });
    if (!user) {
      logger.warn(
        { event: "login_failed", reason: "unknown_user", ip, email: maskEmail(email), userAgent },
        "Login failed — no such user",
      );
      throw new HttpError(401, "Invalid credentials");
    }

    // Account temporarily locked after repeated failures — reject before even
    // checking the password so a locked account can't be probed.
    if (user.lockUntil && user.lockUntil.getTime() > Date.now()) {
      const mins = Math.ceil((user.lockUntil.getTime() - Date.now()) / 60000);
      logger.warn(
        { event: "login_blocked", reason: "locked", ip, userId: String(user._id), email: maskEmail(email), lockMinutes: mins },
        "Login blocked — account locked",
      );
      throw new HttpError(429, `Too many failed attempts. Please try again in ${mins} minute(s).`);
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      // Count the failure; lock (with backoff) once the threshold is crossed.
      user.failedLoginAttempts = (user.failedLoginAttempts ?? 0) + 1;
      const locked = user.failedLoginAttempts >= MAX_BEFORE_LOCK;
      if (locked) {
        user.lockUntil = new Date(Date.now() + lockMinutesFor(user.failedLoginAttempts) * 60000);
      }
      await user.save();
      logger.warn(
        {
          event: locked ? "login_locked" : "login_failed",
          reason: "bad_password",
          ip,
          userId: String(user._id),
          email: maskEmail(email),
          userAgent,
          attempts: user.failedLoginAttempts,
        },
        locked ? "Login failed — account now locked" : "Login failed — bad password",
      );
      throw new HttpError(401, "Invalid credentials");
    }

    // Successful auth — clear any accumulated failure state.
    if ((user.failedLoginAttempts ?? 0) > 0 || user.lockUntil) {
      user.failedLoginAttempts = 0;
      user.lockUntil = null;
      await user.save();
    }

    // Approval-status gate (only the real owner, post-password, sees this).
    if (user.status === "pending") {
      throw new HttpError(403, "Your account is awaiting approval. We'll email you once it's reviewed.");
    }
    if (user.status === "rejected") {
      throw new HttpError(
        403,
        user.rejectionReason
          ? `Your account was not approved: ${user.rejectionReason}`
          : "Your account was not approved.",
      );
    }

    // Email-only auth: the account must have a verified email to sign in. Strict
    // === false so legacy users (field absent) are grandfathered in. A fresh
    // verification link is sent so the user can complete it immediately.
    if (user.emailVerified === false) {
      await sendVerificationEmail(user, resolveClientOrigin(req));
      throw new HttpError(
        403,
        "Please verify your email to continue. We've sent a fresh verification link to your inbox.",
      );
    }

    const userId = String(user._id);
    const accessToken = signAccessToken({ sub: userId, role: user.role, email: user.email });
    const refreshToken = await issueRefreshToken(userId);
    setAuthCookies(res, accessToken, refreshToken);

    // Email is verified (gated above) → safe to attach any guest bookings made with it.
    void claimGuestBookings(userId, user.email, user.role);

    logger.info(
      { event: "login_success", ip, userId, role: user.role, email: maskEmail(email), userAgent },
      "Login success",
    );
    res.json({ user: user.toJSON() });
  } catch (e) {
    next(e);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies?.refreshToken;
    if (!token) throw new HttpError(401, "Missing refresh token");

    let payload;
    try {
      payload = verifyRefreshToken(token);
    } catch {
      throw new HttpError(401, "Invalid or expired refresh token");
    }

    // The JWT may be valid but already rotated/revoked — the DB row is source of truth.
    const active = await findActiveRefreshToken(token);
    if (!active) throw new HttpError(401, "Refresh token is no longer valid");

    // Inactivity timeout: the current refresh-token row is (re)issued on every
    // refresh, so its createdAt marks the last time the session was used. If the
    // gap exceeds the idle window the session has gone stale — revoke and force a
    // fresh login. (Active users refresh every ~15m, well under the window.)
    const idleMs = Date.now() - active.createdAt.getTime();
    if (idleMs > IDLE_TIMEOUT_MS) {
      await revokeRefreshToken(token);
      clearAuthCookies(res);
      logger.info(
        { event: "session_idle_timeout", userId: String(active.userId), idleMs },
        "Session expired due to inactivity",
      );
      throw new HttpError(401, "Session expired due to inactivity. Please log in again.");
    }

    const user = await UserModel.findById(payload.sub);
    if (!user) throw new HttpError(401, "User no longer exists");

    const userId = String(user._id);
    const newRefreshToken = await rotateRefreshToken(token, userId);
    const accessToken = signAccessToken({ sub: userId, role: user.role, email: user.email });

    setAuthCookies(res, accessToken, newRefreshToken);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
}

export async function logout(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.refreshToken;
  if (token) await revokeRefreshToken(token);
  clearAuthCookies(res);
  res.json({ ok: true });
}

export async function me(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new HttpError(401, "Unauthorized");
    const user = await UserModel.findById(req.user.sub);
    if (!user) throw new HttpError(401, "User not found");
    res.json({ user: user.toJSON() });
  } catch (e) {
    next(e);
  }
}

// Look up a user by either email or phone (used by resend/forgot, which accept
// whichever identifier the form collected).
async function findByIdentifier(body: unknown) {
  const b = (body ?? {}) as { email?: unknown; phone?: unknown };
  const email = typeof b.email === "string" ? b.email.toLowerCase().trim() : "";
  const phone = typeof b.phone === "string" ? b.phone.trim() : "";
  if (!email && !phone) return null;
  return UserModel.findOne(email ? { email } : { phone });
}

// POST /api/auth/verify-email  { token }
// Confirms the email, then auto-logs the user in (issues a session) so they land
// straight in their dashboard. Pending roles are verified but NOT logged in.
export async function verifyEmail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const userId = await consumeAuthToken(token, "verify_email");
    if (!userId) throw new HttpError(400, "This verification link is invalid or has expired. Please request a new one.");

    const user = await UserModel.findById(userId);
    if (!user) throw new HttpError(400, "Account no longer exists.");

    if (!user.emailVerified) {
      user.emailVerified = true;
      await user.save();
    }
    logger.info({ event: "email_verified", userId }, "Email verified");

    // Pending approval roles must still wait — verify only, no session.
    if (user.status !== "active") {
      res.json({ verified: true, status: user.status, user: user.toJSON() });
      return;
    }

    const accessToken = signAccessToken({ sub: userId, role: user.role, email: user.email });
    const refreshToken = await issueRefreshToken(userId);
    setAuthCookies(res, accessToken, refreshToken);

    // Email just verified → attach any guest bookings made with it (brand-new user
    // who booked, then registered with the same email — the core claim-by-email case).
    void claimGuestBookings(userId, user.email, user.role);

    res.json({ verified: true, status: "active", user: user.toJSON() });
  } catch (e) {
    next(e);
  }
}

// POST /api/auth/resend-verification  { email | phone }
// Always responds 200 with a generic message (no account enumeration).
export async function resendVerification(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await findByIdentifier(req.body);
    if (user && user.emailVerified === false) {
      await sendVerificationEmail(user, resolveClientOrigin(req));
    }
    res.json({ ok: true, message: "If an unverified account matches, a verification link has been sent." });
  } catch (e) {
    next(e);
  }
}

// POST /api/auth/forgot-password  { email | phone }
// Always responds 200 generically — never reveals whether an account exists.
export async function forgotPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await findByIdentifier(req.body);
    if (user) {
      try {
        const raw = await createAuthToken(String(user._id), "password_reset");
        await sendMail({
          to: user.email,
          subject: "Reset your SpaksTrip password",
          template: "passwordReset",
          data: {
            name: user.name,
            resetUrl: clientUrl(resolveClientOrigin(req), `/reset-password?token=${raw}`),
            expiresInMinutes: Math.round(TTL.password_reset / 60_000),
          },
        });
        logger.info({ event: "password_reset_requested", userId: String(user._id) }, "Password reset email sent");
      } catch (e) {
        logger.error({ event: "password_reset_send_failed", error: e instanceof Error ? e.message : String(e) }, "Failed to send reset email");
      }
    }
    res.json({ ok: true, message: "If an account matches, a password reset link has been sent." });
  } catch (e) {
    next(e);
  }
}

// POST /api/auth/reset-password  { token, password }
// Consumes the single-use token, enforces password strength, updates the hash,
// and revokes all existing sessions so a leaked old session can't persist.
export async function resetPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    assertPasswordStrength(password);

    const userId = await consumeAuthToken(token, "password_reset");
    if (!userId) throw new HttpError(400, "This reset link is invalid or has expired. Please request a new one.");

    const user = await UserModel.findById(userId);
    if (!user) throw new HttpError(400, "Account no longer exists.");

    user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    // A successful reset also proves control of the inbox → mark email verified.
    user.emailVerified = true;
    user.failedLoginAttempts = 0;
    user.lockUntil = null;
    await user.save();

    await revokeAllUserRefreshTokens(userId);
    logger.info({ event: "password_reset_done", userId }, "Password reset complete");

    res.json({ ok: true, message: "Your password has been reset. Please log in." });
  } catch (e) {
    next(e);
  }
}

// POST /api/auth/email-status  { email }  → { exists: boolean }
// Used at guest checkout to route the user: an existing account must log in (so the
// booking is attributed via session), a brand-new email may continue as a guest and
// claim the booking later. Rate-limited; the enumeration exposure is an accepted
// trade-off for this booking-attribution UX.
export async function emailStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const raw = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!raw || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw)) {
      throw new HttpError(400, "A valid email is required.");
    }
    const user = await UserModel.findOne({ email: raw }).select("_id").lean();
    res.json({ exists: Boolean(user) });
  } catch (e) {
    next(e);
  }
}
