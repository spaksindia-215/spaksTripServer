import { Router } from "express";
import { bookingRateLimiter } from "../middleware/rateLimit";
import {
  publicListPackages,
  publicListKinds,
  publicGetPackage,
  publicCreateEnquiry,
} from "../controllers/packages.controller";

// Public marketplace surface + the customer/guest enquiry entrypoint. Mounted at
// /api/packages. Static paths are declared BEFORE the catch-all `/:slug`.
const router = Router();

router.get("/", publicListPackages);
router.get("/kinds", publicListKinds);

// Enquiry — guest or logged-in (the controller attributes via the optional cookie).
// Declared before `/:slug` so "enquire" is never treated as a slug.
router.post("/:slug/enquire", bookingRateLimiter, publicCreateEnquiry);

router.get("/:slug", publicGetPackage);

export default router;
