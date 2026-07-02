import { Router } from "express";
import {
  listBookings,
  createBooking,
  confirmHold,
  cancelBooking,
  lookupPnr,
  getProfile,
  getMarkup,
  updateMarkup,
  getBranding,
  updateBranding,
} from "../controllers/agent.controller";
import { authMiddleware } from "../middleware/auth";
import { roleMiddleware } from "../middleware/role";
import { mediaUpload } from "../middleware/upload";

const router = Router();

// Shared by Agent and B2B Agent — both use the same booking backend.
router.use(authMiddleware, roleMiddleware("agent", "b2b_agent"));

router.get("/bookings", listBookings);
router.post("/bookings", createBooking);
router.post("/bookings/:id/confirm", confirmHold);
router.post("/bookings/:id/cancel", cancelBooking);
router.get("/bookings/pnr/:pnr", lookupPnr);
router.get("/profile", getProfile);
router.get("/markup", getMarkup);
router.patch("/markup", updateMarkup);
router.get("/branding", getBranding);
router.patch("/branding", mediaUpload.single("logo"), updateBranding);

export default router;
