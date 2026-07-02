import { Router, type Request, type Response, type NextFunction } from "express";
import { authMiddleware } from "../middleware/auth";
import { roleMiddleware } from "../middleware/role";
import { mediaUpload } from "../middleware/upload";
import { HttpError } from "../middleware/error";
import {
  partnerCreate,
  partnerListMine,
  partnerGet,
  partnerUpdate,
  partnerSetStatus,
  partnerDelete,
  partnerListEnquiries,
  partnerUpdateEnquiry,
} from "../controllers/sightseeing.controller";

// Partner-facing SightSeeing listings. Mounted at /api/partner/sightseeing BEFORE the
// generic /api/partner router so these specific paths win. Same auth + multipart
// pattern as partnerPackages.routes.ts.
const router = Router();

router.use(authMiddleware, roleMiddleware("partner"));

function uploadAny(req: Request, res: Response, next: NextFunction): void {
  mediaUpload.any()(req, res, (err: unknown) => {
    if (err) {
      next(new HttpError(400, err instanceof Error ? err.message : "Upload failed"));
      return;
    }
    next();
  });
}

// Enquiries routed to this partner (JSON; no files). Declared before `/:id`.
router.get("/enquiries", partnerListEnquiries);
router.patch("/enquiries/:id", partnerUpdateEnquiry);

// The partner's own activity listings.
router.get("/", partnerListMine);
router.post("/", uploadAny, partnerCreate);
router.get("/:id", partnerGet);
router.put("/:id", uploadAny, partnerUpdate);
router.patch("/:id/status", partnerSetStatus);
router.delete("/:id", partnerDelete);

export default router;
