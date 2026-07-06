import { Router, type Request, type Response, type NextFunction } from "express";
import { authMiddleware } from "../middleware/auth";
import { roleMiddleware } from "../middleware/role";
import { mediaUpload } from "../middleware/upload";
import { HttpError } from "../middleware/error";
import {
  partnerCreatePackage,
  partnerListMyPackages,
  partnerGetMyPackage,
  partnerUpdatePackage,
  partnerDeletePackage,
  partnerSetPackageStatus,
  partnerBrowseCatalog,
  partnerListMyServices,
  partnerUpsertOffer,
  partnerListOffers,
  partnerUpdateOffer,
  partnerDeleteOffer,
  partnerListEnquiries,
  partnerUpdateEnquiry,
} from "../controllers/packages.controller";

// Partner-facing marketplace packages. Mounted at /api/partner/packages BEFORE the
// generic /api/partner router so these specific paths win. Same auth + multipart
// pattern as partnerEvents.routes.ts.
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

// Catalog the partner can attach offers to (templates + others' active packages).
router.get("/catalog", partnerBrowseCatalog);

// The partner's own listings across every vertical — component source for bundles.
router.get("/my-services", partnerListMyServices);

// Offers (JSON; no files). Declared before the `/:id` package routes.
router.get("/offers", partnerListOffers);
router.post("/offers", partnerUpsertOffer);
router.patch("/offers/:id", partnerUpdateOffer);
router.delete("/offers/:id", partnerDeleteOffer);

// Enquiries routed to this partner.
router.get("/enquiries", partnerListEnquiries);
router.patch("/enquiries/:id", partnerUpdateEnquiry);

// The partner's own custom packages.
router.get("/", partnerListMyPackages);
router.post("/", uploadAny, partnerCreatePackage);
router.get("/:id", partnerGetMyPackage);
router.put("/:id", uploadAny, partnerUpdatePackage);
router.patch("/:id/status", partnerSetPackageStatus);
router.delete("/:id", partnerDeletePackage);

export default router;
