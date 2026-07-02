import { Router, type Request, type Response, type NextFunction } from "express";
import { authMiddleware } from "../middleware/auth";
import { roleMiddleware } from "../middleware/role";
import {
  listResources,
  createResource,
  updateResource,
  deleteResource,
  listBookings,
  createHotelListing,
  listHotelListings,
  getHotelListing,
  updateHotelListing,
  submitHotelListing,
  deleteHotelListing,
  createTaxiListing,
  listTaxiListings,
  updateTaxiListing,
  deleteTaxiListing,
  createTaxiPackage,
  listTaxiPackages,
  updateTaxiPackage,
  deleteTaxiPackage,
  createTourListing,
  listTourListings,
  updateTourListing,
  deleteTourListing,
  createTourPackage,
  listTourPackages,
  updateTourPackage,
  deleteTourPackage,
  createCruiseListing,
  listCruiseListings,
  updateCruiseListing,
  deleteCruiseListing,
} from "../controllers/partner.controller";
import { partnerSubmitListing } from "../controllers/moderation.controller";
import { mediaUpload } from "../middleware/upload";
import { HttpError } from "../middleware/error";

const router = Router();

router.use(authMiddleware, roleMiddleware("partner"));

router.get("/resources", listResources);
router.get("/bookings", listBookings);
router.post("/resources", createResource);
router.put("/resources/:id", updateResource);
router.delete("/resources/:id", deleteResource);

// Multipart parsing with dynamic field names (hotel `roomImages-<id>`, taxi
// `vehiclePhotos`/doc fields), converting multer/upload errors into a clean 400.
function uploadAny(req: Request, res: Response, next: NextFunction): void {
  mediaUpload.any()(req, res, (err: unknown) => {
    if (err) {
      next(new HttpError(400, err instanceof Error ? err.message : "Upload failed"));
      return;
    }
    next();
  });
}

router.get("/hotels", listHotelListings);
router.post("/hotels", uploadAny, createHotelListing);
router.get("/hotels/:id", getHotelListing);
router.put("/hotels/:id", updateHotelListing);
router.post("/hotels/:id/submit", submitHotelListing);
router.delete("/hotels/:id", deleteHotelListing);

// Generic "submit for review" for every partner-resource vertical (draft → pending).
router.post("/listings/:type/:id/submit", partnerSubmitListing);

// Taxi listings (DB-backed; images/docs to Cloudinary).
router.get("/taxis", listTaxiListings);
router.post("/taxis", uploadAny, createTaxiListing);
router.patch("/taxis/:id", updateTaxiListing);
router.delete("/taxis/:id", deleteTaxiListing);

// Taxi packages (typed model; thumbnail/images to Cloudinary).
router.get("/taxi-packages", listTaxiPackages);
router.post("/taxi-packages", uploadAny, createTaxiPackage);
router.patch("/taxi-packages/:id", uploadAny, updateTaxiPackage);
router.delete("/taxi-packages/:id", deleteTaxiPackage);

// Tours (typed model; images to Cloudinary).
router.get("/tours", listTourListings);
router.post("/tours", uploadAny, createTourListing);
router.patch("/tours/:id", uploadAny, updateTourListing);
router.delete("/tours/:id", deleteTourListing);

// Tour packages (typed model; cross-model refs; thumbnail/images to Cloudinary).
router.get("/tour-packages", listTourPackages);
router.post("/tour-packages", uploadAny, createTourPackage);
router.patch("/tour-packages/:id", uploadAny, updateTourPackage);
router.delete("/tour-packages/:id", deleteTourPackage);

// Cruises (typed model; vessel images to Cloudinary).
router.get("/cruises", listCruiseListings);
router.post("/cruises", uploadAny, createCruiseListing);
router.patch("/cruises/:id", uploadAny, updateCruiseListing);
router.delete("/cruises/:id", deleteCruiseListing);

export default router;
