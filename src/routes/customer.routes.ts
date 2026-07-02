import { Router } from "express";
import { listBookings, listEnquiries, requestCancel, getProfile } from "../controllers/customer.controller";
import { authMiddleware } from "../middleware/auth";
import { roleMiddleware } from "../middleware/role";

const router = Router();

// Every customer route is authenticated and scoped to the "customer" role.
router.use(authMiddleware, roleMiddleware("customer"));

router.get("/bookings", listBookings);
router.get("/enquiries", listEnquiries);
router.post("/bookings/:id/cancel-request", requestCancel);
router.get("/profile", getProfile);

export default router;
