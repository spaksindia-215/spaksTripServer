import { Router } from "express";
import * as flights from "../controllers/flights.controller";
import { searchRateLimiter, bookingRateLimiter } from "../middleware/rateLimit";

// TBO flight endpoints. Paths mirror the Next.js /api/flights/* routes 1:1 so the
// Vercel thin-proxy (proxyToRailway) maps straight through. These are PUBLIC (no
// auth middleware) exactly like the original Next handlers — agent context arrives
// via the forwarded x-agent-id / x-agent-slug headers, not a session.
//
// Because they're public, rate limiting is the primary abuse control:
//   search/fare/ssr endpoints      → searchRateLimiter  (60/min, anti-scrape)
//   create-order/verify/book/ticket → bookingRateLimiter (10/min, anti-abuse)
const router = Router();

// Specific paths first, then the /:id/* patterns.
router.post("/search", searchRateLimiter, flights.searchFlights);
router.post("/calendar-fare", searchRateLimiter, flights.calendarFare);
router.post("/calendar-fare/update", searchRateLimiter, flights.calendarFareUpdate);
router.post("/razorpay/create-order", bookingRateLimiter, flights.createPaymentOrder);
router.post("/razorpay/verify-payment", bookingRateLimiter, flights.verifyPayment);
router.post("/book", bookingRateLimiter, flights.book);
router.post("/ticket", bookingRateLimiter, flights.ticket);
router.get("/booking/:id", flights.bookingDetail);

router.get("/:id/fare-quote", searchRateLimiter, flights.fareQuote);
router.get("/:id/fare-rule", searchRateLimiter, flights.fareRule);
router.get("/:id/ssr", searchRateLimiter, flights.ssr);

export default router;
