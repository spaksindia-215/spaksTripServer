import { Router } from "express";
import { browse, listTypes, detail } from "../controllers/accommodation.controller";

// Public customer-facing surface for partner accommodation listings (the navbar
// "Accommodation" menu). Browse by type + detail by slug. Enquiries reuse the
// existing POST /api/partner-hotels/:id/enquire endpoint (one HotelEnquiry
// pipeline). Static paths before the catch-all `/:slug`.
const router = Router();

router.get("/", browse);
router.get("/types", listTypes);
router.get("/:slug", detail);

export default router;
