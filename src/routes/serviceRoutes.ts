import { Router, type Request, type Response, type NextFunction } from "express";
import { authMiddleware } from "../middleware/auth";
import { roleMiddleware } from "../middleware/role";
import { mediaUpload } from "../middleware/upload";
import { bookingRateLimiter } from "../middleware/rateLimit";
import { HttpError } from "../middleware/error";
import type { ServiceModuleHandlers } from "../controllers/serviceModule";

// Router factories shared by the enquiry-first service modules (Transfer, Self-Drive,
// Islandhopper, Visa). Partner routers carry auth + multipart; public routers expose
// browse/detail/enquire. Mirrors partnerSightseeing.routes / sightseeing.routes.

function uploadAny(req: Request, res: Response, next: NextFunction): void {
  mediaUpload.any()(req, res, (err: unknown) => {
    if (err) {
      next(new HttpError(400, err instanceof Error ? err.message : "Upload failed"));
      return;
    }
    next();
  });
}

export function makePartnerServiceRouter(h: ServiceModuleHandlers): Router {
  const router = Router();
  router.use(authMiddleware, roleMiddleware("partner"));
  // Enquiries (JSON; no files) before `/:id`.
  router.get("/enquiries", h.partnerListEnquiries);
  router.patch("/enquiries/:id", h.partnerUpdateEnquiry);
  router.get("/", h.partnerListMine);
  router.post("/", uploadAny, h.partnerCreate);
  router.get("/:id", h.partnerGet);
  router.put("/:id", uploadAny, h.partnerUpdate);
  router.patch("/:id/status", h.partnerSetStatus);
  router.delete("/:id", h.partnerDelete);
  return router;
}

export function makePublicServiceRouter(h: ServiceModuleHandlers): Router {
  const router = Router();
  router.get("/", h.publicBrowse);
  // Enquiry before `/:slug` so "enquire" is never treated as a slug.
  router.post("/:slug/enquire", bookingRateLimiter, h.publicSubmitEnquiry);
  router.get("/:slug", h.publicGetDetail);
  return router;
}
