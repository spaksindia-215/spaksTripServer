import { Request, Response, NextFunction } from "express";
import { ADMIN_COOKIE_NAME, verifyAdminSessionToken } from "../lib/adminSession";

// Guards /api/admin/* — requires a valid signed admin-session cookie. This is
// entirely separate from the user JWT auth (no DB role, no access token).
export function adminSessionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[ADMIN_COOKIE_NAME];
  if (!verifyAdminSessionToken(token)) {
    res.status(401).json({ error: "Admin session required" });
    return;
  }
  next();
}
