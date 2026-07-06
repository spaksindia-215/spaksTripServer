import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import { roleMiddleware } from "../middleware/role";
import { bookingRateLimiter } from "../middleware/rateLimit";
import {
  listEvents,
  searchEvents,
  listCategories,
  listCities,
  upcomingEvents,
  featuredEvents,
  getEventBySlug,
  initiateBooking,
  verifyBookingPayment,
} from "../controllers/events.controller";

// Public events surface + the customer booking entrypoints. Mounted at /api/events.
// Static paths are declared BEFORE the catch-all `/:slug` so they aren't shadowed.
const router = Router();

// ── Public (no auth) ─────────────────────────────────────────────────────────
router.get("/", listEvents);
router.get("/search", searchEvents);
router.get("/categories", listCategories);
router.get("/cities", listCities);
router.get("/upcoming", upcomingEvents);
router.get("/featured", featuredEvents);

// ── Booking (auth + role customer) ───────────────────────────────────────────
// Declared before `/:slug` so "booking" is never treated as a slug.
router.post("/booking/verify", authMiddleware, roleMiddleware("customer"), bookingRateLimiter, verifyBookingPayment);
router.post("/:slug/book", authMiddleware, roleMiddleware("customer"), bookingRateLimiter, initiateBooking);

// ── Public single event (must stay last — it matches any /:slug) ─────────────
router.get("/:slug", getEventBySlug);

export default router;
