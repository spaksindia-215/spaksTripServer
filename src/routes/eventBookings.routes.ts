import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import { roleMiddleware } from "../middleware/role";
import { listMyBookings, getMyBooking, cancelBooking } from "../controllers/events.controller";

// The customer's own event bookings. Mounted at /api/bookings/events. Every route
// is authenticated and scoped to the "customer" role (matches customer.routes.ts).
const router = Router();

router.use(authMiddleware, roleMiddleware("customer"));

router.get("/", listMyBookings);
router.get("/:bookingRef", getMyBooking);
router.post("/:bookingRef/cancel", cancelBooking);

export default router;
