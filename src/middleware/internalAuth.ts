import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import { HttpError } from "./error";

// Gates the entire /api/internal router. Those routes (agent-config,
// record-booking, record-customer-booking, platform-config, egress-ip,
// pg-health) carry no other auth — by convention they're only ever meant to
// be called server-to-server by the Next.js app, never from a browser. That
// convention alone doesn't stop a direct request: agent-config in particular
// is a slug → exists/status oracle (enumeration surface) if left wide open.
//
// Optional, same graceful-degradation shape as PRICE_TOKEN_SECRET: unset,
// this is a no-op so an environment that hasn't set the var yet keeps
// working exactly as before an upgrade. Set INTERNAL_API_SECRET to the same
// value in both this server's env and the Next.js app's env to close the gap.
//
// A missing/wrong secret gets the same 404 an unmatched route would give —
// no separate "wrong secret" signal for a prober to distinguish from "this
// path doesn't exist".
export function internalAuth(req: Request, _res: Response, next: NextFunction): void {
  const secret = env.internalApiSecret;
  if (!secret) {
    next();
    return;
  }

  const provided = req.headers["x-internal-secret"];
  const ok =
    typeof provided === "string" &&
    provided.length === secret.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));

  if (!ok) {
    next(new HttpError(404, "Not found"));
    return;
  }

  next();
}
