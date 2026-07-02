import dns from "node:dns";
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { env, isProd } from "./config/env";
import { connectDb } from "./config/db";
import { seedPlatformConfig } from "./models/PlatformConfig";
import authRoutes from "./routes/auth.routes";
import partnerRoutes from "./routes/partner.routes";
import adminRoutes from "./routes/admin.routes";
import customerRoutes from "./routes/customer.routes";
import agentRoutes from "./routes/agent.routes";
import internalRoutes from "./routes/internal.routes";
import flightsRoutes from "./routes/flights.routes";
import eventsRoutes from "./routes/events.routes";
import partnerEventsRoutes from "./routes/partnerEvents.routes";
import adminEventsRoutes from "./routes/adminEvents.routes";
import eventBookingsRoutes from "./routes/eventBookings.routes";
import packagesRoutes from "./routes/packages.routes";
import partnerHotelsRoutes from "./routes/partnerHotels.routes";
import partnerPackagesRoutes from "./routes/partnerPackages.routes";
import adminPackagesRoutes from "./routes/adminPackages.routes";
import accommodationRoutes from "./routes/accommodation.routes";
import partnerAccommodationRoutes from "./routes/partnerAccommodation.routes";
import partnerSightseeingRoutes from "./routes/partnerSightseeing.routes";
import sightseeingRoutes from "./routes/sightseeing.routes";
import tourListingsRoutes from "./routes/tourListings.routes";
import { makePartnerServiceRouter, makePublicServiceRouter } from "./routes/serviceRoutes";
import {
  transferController,
  selfDriveController,
  islandhopperController,
  visaController,
} from "./controllers/serviceControllers";
import { errorHandler } from "./middleware/error";
import { securityHeaders } from "./middleware/securityHeaders";
import { apiRateLimiter } from "./middleware/rateLimit";
// ADDED: PostgreSQL transaction layer (additive — never replaces MongoDB)
import { testConnection } from "./config/postgres";
import webhookRoutes from "./routes/webhooks";
import { startHealWorker } from "./workers/healWorker";
import { startReconciliationWorker } from "./workers/reconciliationWorker";
import { startDLQWorker } from "./workers/dlqWorker";
import { startExternalEventsSyncWorker } from "./workers/syncExternalEventsWorker";
import { startEventReminderWorker } from "./workers/eventReminderWorker";

async function main(): Promise<void> {
  // Prefer IPv4 for all outbound connections. Some hosts (e.g. Railway) have no
  // IPv6 egress, so connecting to an AAAA record fails with ENETUNREACH and then
  // times out — which was breaking Gmail SMTP. Node otherwise follows the
  // resolver order, which can return IPv6 first.
  dns.setDefaultResultOrder("ipv4first");

  await connectDb();
  await seedPlatformConfig();

  // ADDED: probe PostgreSQL without blocking startup. If it is down or unset,
  // testConnection() logs a warning and resolves — the server boots regardless
  // and all existing MongoDB features keep working.
  void testConnection();

  const app = express();

  // Trust Railway's reverse proxy so req.ip and secure flag are accurate
  if (isProd) app.set("trust proxy", 1);

  // Security headers on every response (HSTS in prod, nosniff, frame-deny, etc.)
  app.use(securityHeaders);

  app.use(
    cors({
      origin: env.clientOrigin,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      // ADDED: X-Razorpay-Idempotency-Key for future order-creation requests
      allowedHeaders: ["Content-Type", "Authorization", "X-Razorpay-Idempotency-Key"],
    }),
  );

  // ADDED: webhook route is mounted BEFORE express.json() so its own middleware
  // can apply express.raw() and verify the HMAC signature against the raw body.
  // All other routes below keep the global express.json() parser unchanged.
  app.use("/api/webhooks", webhookRoutes);

  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Outer rate-limit bound for the whole API surface (skips /api/internal).
  // Per-route stricter tiers (auth / booking / search) are layered on top inside
  // each router. Mounted AFTER /api/webhooks so Razorpay retries are never throttled.
  app.use("/api", apiRateLimiter);

  app.use("/api/auth", authRoutes);
  // Events module — specific sub-paths MUST be mounted before the generic
  // /api/partner and /api/admin routers so they are matched first.
  app.use("/api/partner/events", partnerEventsRoutes);
  app.use("/api/admin/events", adminEventsRoutes);
  app.use("/api/bookings/events", eventBookingsRoutes);
  // Marketplace packages — specific sub-paths mounted before the generic
  // /api/partner and /api/admin routers so they win.
  app.use("/api/partner/packages", partnerPackagesRoutes);
  app.use("/api/admin/packages", adminPackagesRoutes);
  // Partner-service modules (SightSeeing first) — specific sub-paths before the
  // generic /api/partner router. Admin moderation reuses /api/admin/listings.
  app.use("/api/partner/sightseeing", partnerSightseeingRoutes);
  app.use("/api/partner/transfer", makePartnerServiceRouter(transferController));
  app.use("/api/partner/self-drive", makePartnerServiceRouter(selfDriveController));
  app.use("/api/partner/islandhopper", makePartnerServiceRouter(islandhopperController));
  app.use("/api/partner/visa", makePartnerServiceRouter(visaController));
  // Partner accommodation lead inbox (listing CRUD stays on /api/partner/hotels).
  app.use("/api/partner/accommodation", partnerAccommodationRoutes);
  app.use("/api/partner", partnerRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/customer", customerRoutes);
  app.use("/api/agent", agentRoutes);
  app.use("/api/internal", internalRoutes);
  // TBO flight endpoints (migrated from Next.js so outbound TBO calls use Railway's
  // static IP). Public, like the original Next routes.
  app.use("/api/flights", flightsRoutes);
  // Public events discovery + customer booking entrypoints.
  app.use("/api/events", eventsRoutes);
  // Public marketplace packages + customer/guest enquiry entrypoint.
  app.use("/api/packages", packagesRoutes);
  // Public partner-accommodation discovery + customer/guest enquiry entrypoint
  // (separate from TBO /hotel search, which is unchanged).
  app.use("/api/accommodation", accommodationRoutes);
  // Public SightSeeing discovery + customer/guest enquiry entrypoint.
  app.use("/api/sightseeing", sightseeingRoutes);
  // Public discovery + enquiry for the remaining enquiry-first service modules.
  app.use("/api/transfer", makePublicServiceRouter(transferController));
  app.use("/api/self-drive", makePublicServiceRouter(selfDriveController));
  app.use("/api/islandhopper", makePublicServiceRouter(islandhopperController));
  app.use("/api/visa", makePublicServiceRouter(visaController));
  app.use("/api/partner-hotels", partnerHotelsRoutes);
  // Public tour-listing browse (destination grid → operator cards → detail).
  app.use("/api/tour-listings", tourListingsRoutes);

  app.use(errorHandler);

  app.listen(env.port, () => {
    console.log(`[server] listening on http://localhost:${env.port}`);
    // ADDED: start background workers after the server is listening. Each guards
    // internally against PostgreSQL being unconfigured/unavailable.
    startHealWorker();
    startReconciliationWorker();
    startDLQWorker();
    // No-op unless EXTERNAL_EVENTS_SYNC_ENABLED=true.
    startExternalEventsSyncWorker();
    // No-op unless EVENT_REMINDERS_ENABLED=true.
    startEventReminderWorker();
  });
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
