import { Router } from "express";
import {
  publicListDestinations,
  publicListTourListings,
  publicGetTourListing,
} from "../controllers/tourListings.controller";

// Public tour-listings browse surface. Mounted at /api/tour-listings.
// No auth required — entirely public (read-only).
const router = Router();

// Static paths before the /:slug catch-all.
router.get("/destinations", publicListDestinations);
router.get("/", publicListTourListings);
router.get("/:slug", publicGetTourListing);

export default router;
