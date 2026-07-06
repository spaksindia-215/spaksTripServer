import { Request, Response, NextFunction } from "express";
import { verifyAccessToken, AccessTokenPayload } from "../lib/tokens";

declare module "express-serve-static-core" {
  interface Request {
    user?: AccessTokenPayload;
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.accessToken;
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Resolves the authenticated user from the accessToken cookie WITHOUT rejecting the
// request when it is missing or invalid. For endpoints that are publicly reachable
// (e.g. the booking flow, authenticated via forwarded agent headers rather than a
// session) but want to opportunistically attribute the action to a logged-in user.
export function resolveOptionalUser(req: Request): AccessTokenPayload | null {
  const token = req.cookies?.accessToken;
  if (!token) return null;
  try {
    return verifyAccessToken(token);
  } catch {
    return null;
  }
}
