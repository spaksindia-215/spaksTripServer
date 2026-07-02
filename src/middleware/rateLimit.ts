import rateLimit, { type Options } from "express-rate-limit";

// Centralised rate limiters. All are keyed by IP; `trust proxy` is set in prod
// (see index.ts) so the real client IP is used behind Railway's reverse proxy.
//
// Tiers (strict profile):
//   auth     — 20 / 15 min  (login/register/admin password — brute-force guard)
//   booking  — 10 / min     (create-order, verify-payment, book, ticket — anti-abuse)
//   search   — 60 / min     (search, fare-quote, fare-rule, ssr, calendar — anti-scrape)
//   api      — 300 / min    (catch-all outer bound for the rest of the API)
//
// NOTE: the webhook route and the server-to-server /api/internal route are NOT
// rate-limited here — Razorpay retries webhooks, and /api/internal carries the
// subdomain agent-config + booking-attribution traffic that must not be dropped.

const shared: Pick<Options, "standardHeaders" | "legacyHeaders"> = {
  standardHeaders: true,
  legacyHeaders: false,
};

export const authRateLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many attempts. Please try again later." },
});

export const bookingRateLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many booking/payment requests. Please slow down and try again shortly." },
});

export const searchRateLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many search requests. Please try again in a moment." },
});

// Outer bound applied to the whole API surface (skips /api/internal — see below).
export const apiRateLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  max: 300,
  message: { error: "Too many requests. Please try again later." },
  // Skip server-to-server internal traffic (agent-config lookups on every page
  // load, booking attribution). Path is relative to the /api mount point.
  skip: (req) => req.path.startsWith("/internal"),
});
