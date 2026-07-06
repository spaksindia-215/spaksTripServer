import { Router, type Request, type Response, type NextFunction } from "express";
import { adminSessionMiddleware } from "../middleware/adminSession";
import { mediaUpload } from "../middleware/upload";
import { HttpError } from "../middleware/error";
import {
  adminCreateTemplate,
  adminListPackages,
  adminGetPackage,
  adminComparePackage,
  adminUpdatePackage,
  adminSetPackageStatus,
  adminDeletePackage,
  adminListOffers,
  adminListEnquiries,
  adminUpdateEnquiry,
} from "../controllers/packages.controller";

// Admin marketplace management. Mounted at /api/admin/packages BEFORE the generic
// /api/admin router. Admin is the env-gated signed-cookie session (no JWT role),
// matching adminEvents.routes.ts.
const router = Router();

router.use(adminSessionMiddleware);

function uploadAny(req: Request, res: Response, next: NextFunction): void {
  mediaUpload.any()(req, res, (err: unknown) => {
    if (err) {
      next(new HttpError(400, err instanceof Error ? err.message : "Upload failed"));
      return;
    }
    next();
  });
}

// Offers + enquiries (declared before `/:id`).
router.get("/offers", adminListOffers);
router.get("/enquiries", adminListEnquiries);
router.patch("/enquiries/:id", adminUpdateEnquiry);

// Fixed templates + moderation of any package.
router.get("/", adminListPackages);
router.post("/", uploadAny, adminCreateTemplate);
router.get("/:id", adminGetPackage);
// §5.3 — compare a partner submission against the closest platform template.
router.get("/:id/compare", adminComparePackage);
router.put("/:id", uploadAny, adminUpdatePackage);
router.patch("/:id/status", adminSetPackageStatus);
router.delete("/:id", adminDeletePackage);

export default router;
