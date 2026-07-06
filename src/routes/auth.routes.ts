import { Router } from "express";
import {
  register,
  login,
  refresh,
  logout,
  me,
  verifyEmail,
  resendVerification,
  forgotPassword,
  resetPassword,
  emailStatus,
} from "../controllers/auth.controller";
import { authMiddleware } from "../middleware/auth";
import { authRateLimiter } from "../middleware/rateLimit";

const router = Router();

router.post("/register", authRateLimiter, register);
router.post("/login", authRateLimiter, login);
router.post("/refresh", refresh);
router.post("/logout", logout);
router.get("/me", authMiddleware, me);
router.post("/email-status", authRateLimiter, emailStatus);

// Email verification + password reset. The email-sending endpoints are rate
// limited (authRateLimiter) to blunt enumeration / mail-bombing.
router.post("/verify-email", verifyEmail);
router.post("/resend-verification", authRateLimiter, resendVerification);
router.post("/forgot-password", authRateLimiter, forgotPassword);
router.post("/reset-password", authRateLimiter, resetPassword);

export default router;
