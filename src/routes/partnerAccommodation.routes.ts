import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import { roleMiddleware } from "../middleware/role";
import { partnerListEnquiries, partnerUpdateEnquiry } from "../controllers/accommodation.controller";

// Partner accommodation lead inbox. Mounted at /api/partner/accommodation BEFORE
// the generic /api/partner router. Listing CRUD stays on the existing
// /api/partner/hotels endpoints (HotelListing) — this only adds the enquiry inbox.
const router = Router();

router.use(authMiddleware, roleMiddleware("partner"));

router.get("/enquiries", partnerListEnquiries);
router.patch("/enquiries/:id", partnerUpdateEnquiry);

export default router;
