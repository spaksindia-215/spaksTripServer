import 'dotenv/config'
function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  clientOrigin: process.env.CLIENT_ORIGIN ?? "http://localhost:3000",
  mongoUri: process.env.MONGO_URI ?? process.env.MONGODB_URI ?? required("MONGO_URI"),
  accessSecret: required("ACCESS_TOKEN_SECRET"),
  refreshSecret: required("REFRESH_TOKEN_SECRET"),
  accessTtl: process.env.ACCESS_TOKEN_TTL ?? "15m",
  refreshTtl: process.env.REFRESH_TOKEN_TTL ?? "7d",
  // Recipient for "new pending registration" notifications (used by the mailer).
  superadminEmail: process.env.SUPERADMIN_EMAIL ?? "admin@spakstrip.local",
  // Superadmin panel: env password gate (no DB role) + secret for signing the
  // admin-session cookie. If the password is empty, admin login is disabled.
  superadminPassword: process.env.SUPERADMIN_PASSWORD ?? "",
  adminSessionSecret: process.env.ADMIN_SESSION_SECRET ?? process.env.ACCESS_TOKEN_SECRET ?? "",
  // Cloudinary (image/document uploads for partner listings). Accepts either a
  // single CLOUDINARY_URL or the three discrete vars. Uploads fail with a clear
  // error if unset; the rest of the API still boots.
  cloudinaryUrl: process.env.CLOUDINARY_URL ?? "",
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME ?? "",
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY ?? "",
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET ?? "",
  // PostgreSQL — additive second database for financial transactions only.
  // Deliberately NOT required(): if unset the Express server must still boot and
  // all existing MongoDB-backed features must keep working (graceful degradation).
  databaseUrl: process.env.DATABASE_URL ?? "",
  // Razorpay payment gateway. Optional for the same graceful-degradation reason.
  razorpayKeyId: process.env.RAZORPAY_KEY_ID ?? "",
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET ?? "",
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? "",
  // Signed price-token secret. Optional (graceful degradation): when set, the
  // FareQuote→create-order amount binding is enforced. MUST be identical on the
  // Next app and this server for tokens to verify across both layers.
  priceTokenSecret: process.env.PRICE_TOKEN_SECRET ?? "",
  // SMTP for transactional email (verification, password reset, notifications).
  // When EMAIL_HOST is unset the mailer falls back to console logging (dev/CI).
  emailHost: process.env.EMAIL_HOST ?? "",
  emailPort: Number(process.env.EMAIL_PORT ?? 587),
  emailUser: process.env.EMAIL_USER ?? "",
  emailPass: process.env.EMAIL_PASS ?? "",
  emailFrom: process.env.EMAIL_FROM ?? "SpaksTrip <no-reply@spakstrip.com>",
  // Background worker intervals (ms). Defaults: heal 5m, reconcile 60m, DLQ 10m.
  healWorkerIntervalMs: Number(process.env.HEAL_WORKER_INTERVAL_MS ?? 300000),
  reconciliationWorkerIntervalMs: Number(process.env.RECONCILIATION_WORKER_INTERVAL_MS ?? 3600000),
  dlqWorkerIntervalMs: Number(process.env.DLQ_WORKER_INTERVAL_MS ?? 600000),
  // Events module. Soft-hold duration for reserved tickets, platform service fee
  // and GST (on the fee). All optional with sane defaults so the server boots
  // unchanged when unset.
  eventBookingHoldMinutes: Number(process.env.EVENT_BOOKING_HOLD_MINUTES ?? 10),
  eventPlatformFeePercent: Number(process.env.EVENT_PLATFORM_FEE_PERCENT ?? 5),
  eventGstPercent: Number(process.env.EVENT_GST_PERCENT ?? 18),
  // Event reminder worker (Phase 4). Opt-in so non-prod envs don't email; emits a
  // reminder ~EVENT_REMINDER_LEAD_HOURS before start, scanning on an interval.
  eventRemindersEnabled: process.env.EVENT_REMINDERS_ENABLED === "true",
  eventReminderIntervalMs: Number(process.env.EVENT_REMINDER_INTERVAL_MS ?? 3_600_000),
  eventReminderLeadHours: Number(process.env.EVENT_REMINDER_LEAD_HOURS ?? 24),
  // ── External event discovery (Phase 2) — all OFF by default. The aggregation
  // worker and merge are pure no-ops until explicitly enabled, so zero impact on
  // existing behaviour. ──────────────────────────────────────────────────────
  ticketmasterApiKey: process.env.TICKETMASTER_API_KEY ?? "",
  ticketmasterEnabled: process.env.TICKETMASTER_ENABLED === "true",
  insiderApiEnabled: process.env.INSIDER_API_ENABLED === "true",
  insiderApiKey: process.env.INSIDER_API_KEY ?? "",
  // BookMyShow affiliate deep-links (Phase 3).
  bookmyshowAffiliateId: process.env.BOOKMYSHOW_AFFILIATE_ID ?? "",
  bookmyshowAffiliateEnabled: process.env.BOOKMYSHOW_AFFILIATE_ENABLED === "true",
  // Master switch + cadence for the external-events sync worker. Interval (ms),
  // following the existing setInterval worker pattern (default 6h). Cache TTL in
  // hours drives the ExternalEvent TTL index expiry.
  externalEventsSyncEnabled: process.env.EXTERNAL_EVENTS_SYNC_ENABLED === "true",
  externalEventsSyncIntervalMs: Number(process.env.EXTERNAL_EVENTS_SYNC_INTERVAL_MS ?? 21_600_000),
  externalEventsCacheTtlHours: Number(process.env.EXTERNAL_EVENTS_CACHE_TTL_HOURS ?? 24),
  // Metros to sync, comma-separated. Defaults to the top-10 list from instruct.md.
  externalEventsSyncCities: (
    process.env.EXTERNAL_EVENTS_SYNC_CITIES ??
    "delhi,mumbai,bangalore,hyderabad,chennai,kolkata,pune,ahmedabad,jaipur,goa"
  )
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean),
};

export const isProd = env.nodeEnv === "production";
