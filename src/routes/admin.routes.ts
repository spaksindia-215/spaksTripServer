import { Router } from "express";
import {
  adminLogin,
  adminLogout,
  adminMe,
  listPending,
  approve,
  reject,
  listUsers,
  setCreditLimit,
  getNavbarSettings,
  updateNavbarSettings,
  getPlatformMarkup,
  updatePlatformMarkup,
  listHotelListings,
  approveHotelListing,
  rejectHotelListing,
} from "../controllers/admin.controller";
import {
  adminListListings,
  adminApproveListing,
  adminRejectListing,
  adminSetListingStatus,
  adminDeleteListing,
} from "../controllers/moderation.controller";
import { adminSessionMiddleware } from "../middleware/adminSession";
import { authRateLimiter } from "../middleware/rateLimit";

const router = Router();

// Password gate (rate-limited). Everything else requires the signed admin cookie.
router.post("/login", authRateLimiter, adminLogin);
router.post("/logout", adminLogout);
router.get("/me", adminSessionMiddleware, adminMe);
router.get("/pending", adminSessionMiddleware, listPending);
router.post("/approve/:id", adminSessionMiddleware, approve);
router.post("/reject/:id", adminSessionMiddleware, reject);
router.get("/users", adminSessionMiddleware, listUsers);
router.patch("/users/:id/credit-limit", adminSessionMiddleware, setCreditLimit);

// Partner hotel-listing review queue. Submitted listings land as "pending" and
// only become "active" (publicly visible) once an admin approves here.
router.get("/hotel-listings", adminSessionMiddleware, listHotelListings);
router.post("/hotel-listings/:id/approve", adminSessionMiddleware, approveHotelListing);
router.post("/hotel-listings/:id/reject", adminSessionMiddleware, rejectHotelListing);

// Unified review queue across every partner-resource vertical (hotel, taxi,
// taxi_package, tour, tour_package, cruise). Approve → active, reject → draft.
router.get("/listings", adminSessionMiddleware, adminListListings);
router.post("/listings/:type/:id/approve", adminSessionMiddleware, adminApproveListing);
router.post("/listings/:type/:id/reject", adminSessionMiddleware, adminRejectListing);
// Full lifecycle management (Pause / Activate / Suspend) + delete, any vertical.
router.patch("/listings/:type/:id/status", adminSessionMiddleware, adminSetListingStatus);
router.delete("/listings/:type/:id", adminSessionMiddleware, adminDeleteListing);

// Navbar visibility — GET is public (read by all visitors), PUT requires admin session.
router.get("/navbar-settings", getNavbarSettings);
router.put("/navbar-settings", adminSessionMiddleware, updateNavbarSettings);

// Platform-wide L1 markup (applied on top of TBO fare before agents see their net rate).
router.get("/platform-markup", adminSessionMiddleware, getPlatformMarkup);
router.put("/platform-markup", adminSessionMiddleware, updatePlatformMarkup);

export default router;
