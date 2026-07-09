import 'dotenv/config'
import { z } from "zod";

// Startup env validation (zod). The schema below is the single description of
// every env var this app reads — see server/.env.example for documentation.
// On a missing/malformed var the process refuses to boot with an error that
// names each offending variable.

const numeric = (def: number) =>
  z.coerce.number().finite().default(def);

const boolFlag = z
  .string()
  .optional()
  .transform((v) => v === "true");

const rawSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: numeric(4000),
  CLIENT_ORIGIN: z.string().default("http://localhost:3000"),

  // Mongo: MONGO_URI preferred, MONGODB_URI legacy alias — at least one required
  // (cross-field check below so the error can name both).
  MONGO_URI: z.string().optional(),
  MONGODB_URI: z.string().optional(),

  ACCESS_TOKEN_SECRET: z.string().min(1, "ACCESS_TOKEN_SECRET is required"),
  REFRESH_TOKEN_SECRET: z.string().min(1, "REFRESH_TOKEN_SECRET is required"),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL: z.string().default("7d"),

  SUPERADMIN_EMAIL: z.string().default("admin@spakstrip.local"),
  SUPERADMIN_PASSWORD: z.string().default(""),
  ADMIN_SESSION_SECRET: z.string().optional(),

  // Shared secret gating /api/internal/* (agent-config, record-booking, …) —
  // those routes carry no other auth and are only meant to be called
  // server-to-server by the Next.js app. Optional (graceful degradation, like
  // PRICE_TOKEN_SECRET below): unset, the gate is a no-op so an environment
  // that hasn't set it yet keeps working exactly as before. MUST be set to
  // the same value in both this server's env and the Next.js app's env to
  // close the internal-route enumeration/abuse gap.
  INTERNAL_API_SECRET: z.string().default(""),

  CLOUDINARY_URL: z.string().default(""),
  CLOUDINARY_CLOUD_NAME: z.string().default(""),
  CLOUDINARY_API_KEY: z.string().default(""),
  CLOUDINARY_API_SECRET: z.string().default(""),

  // Optional by design (graceful degradation) — see comments in .env.example.
  DATABASE_URL: z.string().default(""),
  RAZORPAY_KEY_ID: z.string().default(""),
  RAZORPAY_KEY_SECRET: z.string().default(""),
  RAZORPAY_WEBHOOK_SECRET: z.string().default(""),
  PRICE_TOKEN_SECRET: z.string().default(""),

  EMAIL_HOST: z.string().default(""),
  EMAIL_PORT: numeric(587),
  EMAIL_USER: z.string().default(""),
  EMAIL_PASS: z.string().default(""),
  EMAIL_FROM: z.string().default("SpaksTrip <no-reply@spakstrip.com>"),

  // Agent-config cache (server/src/lib/agentCache.ts). SOFT_TTL: how long an
  // instance trusts its in-memory copy with zero DB hits. Between SOFT and
  // HARD it does a cheap single-field version check instead of a full
  // refetch. HARD_TTL: absolute ceiling, always refetches. MAX_ENTRIES bounds
  // memory growth (oldest-inserted eviction) — no Redis dependency.
  AGENT_CACHE_SOFT_TTL_MS: numeric(20_000),
  AGENT_CACHE_HARD_TTL_MS: numeric(300_000),
  AGENT_CACHE_MAX_ENTRIES: numeric(5000),

  HEAL_WORKER_INTERVAL_MS: numeric(300000),
  RECONCILIATION_WORKER_INTERVAL_MS: numeric(3600000),
  DLQ_WORKER_INTERVAL_MS: numeric(600000),

  EVENT_BOOKING_HOLD_MINUTES: numeric(10),
  EVENT_PLATFORM_FEE_PERCENT: numeric(5),
  EVENT_GST_PERCENT: numeric(18),
  EVENT_REMINDERS_ENABLED: boolFlag,
  EVENT_REMINDER_INTERVAL_MS: numeric(3_600_000),
  EVENT_REMINDER_LEAD_HOURS: numeric(24),

  TICKETMASTER_API_KEY: z.string().default(""),
  TICKETMASTER_ENABLED: boolFlag,
  INSIDER_API_ENABLED: boolFlag,
  INSIDER_API_KEY: z.string().default(""),
  BOOKMYSHOW_AFFILIATE_ID: z.string().default(""),
  BOOKMYSHOW_AFFILIATE_ENABLED: boolFlag,
  EXTERNAL_EVENTS_SYNC_ENABLED: boolFlag,
  EXTERNAL_EVENTS_SYNC_INTERVAL_MS: numeric(21_600_000),
  EXTERNAL_EVENTS_CACHE_TTL_HOURS: numeric(24),
  EXTERNAL_EVENTS_SYNC_CITIES: z
    .string()
    .default(
      "delhi,mumbai,bangalore,hyderabad,chennai,kolkata,pune,ahmedabad,jaipur,goa",
    ),
});

const parsed = rawSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(env)"}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${details}`);
}

const raw = parsed.data;

const mongoUri = raw.MONGO_URI ?? raw.MONGODB_URI;
if (!mongoUri || mongoUri.length === 0) {
  throw new Error(
    "Invalid environment configuration:\n  - MONGO_URI: required (or legacy alias MONGODB_URI)",
  );
}

export const env = {
  nodeEnv: raw.NODE_ENV,
  port: raw.PORT,
  clientOrigin: raw.CLIENT_ORIGIN,
  mongoUri,
  accessSecret: raw.ACCESS_TOKEN_SECRET,
  refreshSecret: raw.REFRESH_TOKEN_SECRET,
  accessTtl: raw.ACCESS_TOKEN_TTL,
  refreshTtl: raw.REFRESH_TOKEN_TTL,
  // Recipient for "new pending registration" notifications (used by the mailer).
  superadminEmail: raw.SUPERADMIN_EMAIL,
  // Superadmin panel: env password gate (no DB role) + secret for signing the
  // admin-session cookie. If the password is empty, admin login is disabled.
  superadminPassword: raw.SUPERADMIN_PASSWORD,
  adminSessionSecret: raw.ADMIN_SESSION_SECRET ?? raw.ACCESS_TOKEN_SECRET,
  // Agent-config cache tuning — see server/src/lib/agentCache.ts.
  agentCacheSoftTtlMs: raw.AGENT_CACHE_SOFT_TTL_MS,
  agentCacheHardTtlMs: raw.AGENT_CACHE_HARD_TTL_MS,
  agentCacheMaxEntries: raw.AGENT_CACHE_MAX_ENTRIES,
  // Shared secret for /api/internal/* — see comment on the schema field above.
  internalApiSecret: raw.INTERNAL_API_SECRET,
  // Cloudinary (image/document uploads for partner listings). Accepts either a
  // single CLOUDINARY_URL or the three discrete vars. Uploads fail with a clear
  // error if unset; the rest of the API still boots.
  cloudinaryUrl: raw.CLOUDINARY_URL,
  cloudinaryCloudName: raw.CLOUDINARY_CLOUD_NAME,
  cloudinaryApiKey: raw.CLOUDINARY_API_KEY,
  cloudinaryApiSecret: raw.CLOUDINARY_API_SECRET,
  // PostgreSQL — additive second database for financial transactions only.
  // Deliberately optional: if unset the Express server must still boot and all
  // existing MongoDB-backed features must keep working (graceful degradation).
  databaseUrl: raw.DATABASE_URL,
  // Razorpay payment gateway. Optional for the same graceful-degradation reason.
  razorpayKeyId: raw.RAZORPAY_KEY_ID,
  razorpayKeySecret: raw.RAZORPAY_KEY_SECRET,
  razorpayWebhookSecret: raw.RAZORPAY_WEBHOOK_SECRET,
  // Signed price-token secret. Optional (graceful degradation): when set, the
  // FareQuote→create-order amount binding is enforced. MUST be identical on the
  // Next app and this server for tokens to verify across both layers.
  priceTokenSecret: raw.PRICE_TOKEN_SECRET,
  // SMTP for transactional email (verification, password reset, notifications).
  // When EMAIL_HOST is unset the mailer falls back to console logging (dev/CI).
  emailHost: raw.EMAIL_HOST,
  emailPort: raw.EMAIL_PORT,
  emailUser: raw.EMAIL_USER,
  emailPass: raw.EMAIL_PASS,
  emailFrom: raw.EMAIL_FROM,
  // Background worker intervals (ms). Defaults: heal 5m, reconcile 60m, DLQ 10m.
  healWorkerIntervalMs: raw.HEAL_WORKER_INTERVAL_MS,
  reconciliationWorkerIntervalMs: raw.RECONCILIATION_WORKER_INTERVAL_MS,
  dlqWorkerIntervalMs: raw.DLQ_WORKER_INTERVAL_MS,
  // Events module. Soft-hold duration for reserved tickets, platform service fee
  // and GST (on the fee). All optional with sane defaults so the server boots
  // unchanged when unset.
  eventBookingHoldMinutes: raw.EVENT_BOOKING_HOLD_MINUTES,
  eventPlatformFeePercent: raw.EVENT_PLATFORM_FEE_PERCENT,
  eventGstPercent: raw.EVENT_GST_PERCENT,
  // Event reminder worker (Phase 4). Opt-in so non-prod envs don't email; emits a
  // reminder ~EVENT_REMINDER_LEAD_HOURS before start, scanning on an interval.
  eventRemindersEnabled: raw.EVENT_REMINDERS_ENABLED,
  eventReminderIntervalMs: raw.EVENT_REMINDER_INTERVAL_MS,
  eventReminderLeadHours: raw.EVENT_REMINDER_LEAD_HOURS,
  // ── External event discovery (Phase 2) — all OFF by default. The aggregation
  // worker and merge are pure no-ops until explicitly enabled, so zero impact on
  // existing behaviour. ──────────────────────────────────────────────────────
  ticketmasterApiKey: raw.TICKETMASTER_API_KEY,
  ticketmasterEnabled: raw.TICKETMASTER_ENABLED,
  insiderApiEnabled: raw.INSIDER_API_ENABLED,
  insiderApiKey: raw.INSIDER_API_KEY,
  // BookMyShow affiliate deep-links (Phase 3).
  bookmyshowAffiliateId: raw.BOOKMYSHOW_AFFILIATE_ID,
  bookmyshowAffiliateEnabled: raw.BOOKMYSHOW_AFFILIATE_ENABLED,
  // Master switch + cadence for the external-events sync worker. Interval (ms),
  // following the existing setInterval worker pattern (default 6h). Cache TTL in
  // hours drives the ExternalEvent TTL index expiry.
  externalEventsSyncEnabled: raw.EXTERNAL_EVENTS_SYNC_ENABLED,
  externalEventsSyncIntervalMs: raw.EXTERNAL_EVENTS_SYNC_INTERVAL_MS,
  externalEventsCacheTtlHours: raw.EXTERNAL_EVENTS_CACHE_TTL_HOURS,
  // Metros to sync, comma-separated. Defaults to the top-10 list from instruct.md.
  externalEventsSyncCities: raw.EXTERNAL_EVENTS_SYNC_CITIES
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean),
};

export const isProd = env.nodeEnv === "production";
