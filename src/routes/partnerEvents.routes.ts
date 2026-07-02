import { Router, type Request, type Response, type NextFunction } from "express";
import { authMiddleware } from "../middleware/auth";
import { roleMiddleware } from "../middleware/role";
import { mediaUpload } from "../middleware/upload";
import { HttpError } from "../middleware/error";
import {
  createEvent,
  listMyEvents,
  getMyEvent,
  updateEvent,
  deleteEvent,
  setEventStatus,
  uploadEventImages,
  removeEventImage,
  listEventBookings,
  eventAnalytics,
} from "../controllers/events.controller";

// Partner-facing event CRUD. Mounted at /api/partner/events BEFORE the generic
// /api/partner router so these specific paths win. Same auth + multipart pattern
// as partner.routes.ts.
const router = Router();

router.use(authMiddleware, roleMiddleware("partner"));

// Multipart parsing with dynamic field names (event sections as JSON strings,
// `eventImages` files), turning upload errors into a clean 400.
function uploadAny(req: Request, res: Response, next: NextFunction): void {
  mediaUpload.any()(req, res, (err: unknown) => {
    if (err) {
      next(new HttpError(400, err instanceof Error ? err.message : "Upload failed"));
      return;
    }
    next();
  });
}

router.get("/", listMyEvents);
router.post("/", uploadAny, createEvent);
router.get("/:id", getMyEvent);
router.put("/:id", uploadAny, updateEvent);
router.delete("/:id", deleteEvent);
router.patch("/:id/status", setEventStatus);
router.post("/:id/images", uploadAny, uploadEventImages);
router.delete("/:id/images/:imgId", removeEventImage);
router.get("/:id/bookings", listEventBookings);
router.get("/:id/analytics", eventAnalytics);

export default router;
