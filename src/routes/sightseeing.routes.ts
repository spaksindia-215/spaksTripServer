import { Router } from "express";
import { bookingRateLimiter } from "../middleware/rateLimit";
import {
  publicBrowse,
  publicCategories,
  publicGetDetail,
  publicSubmitEnquiry,
} from "../controllers/sightseeing.controller";

// Public SightSeeing surface + the customer/guest enquiry entrypoint. Mounted at
// /api/sightseeing. Static paths are declared BEFORE the catch-all `/:slug`.
const router = Router();

router.get("/", publicBrowse);
router.get("/categories", publicCategories);

// Enquiry — guest or logged-in (the controller attributes via the optional cookie).
// Declared before `/:slug` so "enquire" is never treated as a slug.
router.post("/:slug/enquire", bookingRateLimiter, publicSubmitEnquiry);

router.get("/:slug", publicGetDetail);

export default router;
