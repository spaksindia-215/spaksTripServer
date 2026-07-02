import { Router } from "express";
import { adminSessionMiddleware } from "../middleware/adminSession";
import { adminListEvents, adminReviewEvent, adminEventAnalytics } from "../controllers/events.controller";

// Admin event moderation. Mounted at /api/admin/events BEFORE the generic
// /api/admin router. Admin is the env-gated signed-cookie session (no JWT role),
// matching admin.routes.ts — NOT roleMiddleware (ROLES has no "admin").
const router = Router();

router.use(adminSessionMiddleware);

router.get("/", adminListEvents);
router.get("/analytics", adminEventAnalytics);
router.patch("/:id/review", adminReviewEvent);

export default router;
