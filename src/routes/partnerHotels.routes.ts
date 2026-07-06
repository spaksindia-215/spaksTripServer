import { Router } from "express";
import { bookingRateLimiter } from "../middleware/rateLimit";
import {
  publicSearchPartnerHotels,
  publicCreateHotelEnquiry,
} from "../controllers/publicHotels.controller";

// Public surface for partner-owned hotel listings (shown alongside TBO results
// on the hotel search page) + the guest/customer enquiry entrypoint. Mounted at
// /api/partner-hotels. Kept separate from /api/hotels, which the Next.js app
// owns for the TBO booking flow.
const router = Router();

router.get("/", publicSearchPartnerHotels);
router.post("/:id/enquire", bookingRateLimiter, publicCreateHotelEnquiry);

export default router;
