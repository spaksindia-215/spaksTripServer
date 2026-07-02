import { Request, Response, NextFunction } from "express";
import type { Role } from "../models/User";

export function roleMiddleware(...allowed: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.user?.role;
    if (!role || !allowed.includes(role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}
